import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, LessThan, Repository } from 'typeorm';

import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { Configuration } from '../config/configuration';
import { CreateProductDto } from './dto/create-product.dto';
import { PriceCheckResultDto } from './dto/price-check-result.dto';
import { ProductSortField, QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { ScrapeStatus } from './enums/scrape-status.enum';

/** Aggregate counters for the dashboard / monitoring endpoint. */
export interface ProductStats {
  total: number;
  active: number;
  inactive: number;
  neverScraped: number;
  failing: number;
  undercut: number;
  averagePrice: number | null;
  lastScrapeAt: string | null;
}

/** Maps sortable DTO fields to entity properties (guards against SQL injection). */
const SORT_COLUMN: Record<ProductSortField, string> = {
  [ProductSortField.Name]: 'product.name',
  [ProductSortField.CurrentPrice]: 'product.currentPrice',
  [ProductSortField.LastUpdated]: 'product.lastUpdated',
  [ProductSortField.LastCheckedAt]: 'product.lastCheckedAt',
  [ProductSortField.CreatedAt]: 'product.createdAt',
};

/** Consecutive failures after which a product is deactivated automatically. */
const MAX_CONSECUTIVE_FAILURES = 10;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  private readonly alertThresholdPercent: number;

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(PriceHistory)
    private readonly priceHistoryRepository: Repository<PriceHistory>,
    private readonly dataSource: DataSource,
    configService: ConfigService<Configuration, true>,
  ) {
    this.alertThresholdPercent = configService.get('scraper', {
      infer: true,
    }).alertThresholdPercent;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create({
      ...createProductDto,
      currency: createProductDto.currency ?? 'EUR',
      currentPrice: createProductDto.currentPrice ?? null,
      targetPrice: createProductDto.targetPrice ?? null,
      lowestPrice: createProductDto.currentPrice ?? null,
      highestPrice: createProductDto.currentPrice ?? null,
      lastUpdated: createProductDto.currentPrice !== undefined ? new Date() : null,
      scrapeStatus: ScrapeStatus.Pending,
    });

    const saved = await this.productsRepository.save(product);

    // Seed the history so charts have a starting point when a price was given.
    if (saved.currentPrice !== null) {
      await this.priceHistoryRepository.insert({
        productId: saved.id,
        price: saved.currentPrice,
        previousPrice: null,
        changePercent: null,
        currency: saved.currency,
        source: 'initial',
      });
    }

    this.logger.log(`Created product ${saved.id} (${saved.name})`);
    return saved;
  }

  async findAll(query: QueryProductsDto): Promise<PaginatedResponseDto<Product>> {
    const qb = this.productsRepository.createQueryBuilder('product');

    if (query.search) {
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('product.name ILIKE :search', { search: `%${query.search}%` })
            .orWhere('product.sku ILIKE :search', { search: `%${query.search}%` })
            .orWhere('product.competitor_url ILIKE :search', { search: `%${query.search}%` });
        }),
      );
    }

    if (query.isActive !== undefined) {
      qb.andWhere('product.isActive = :isActive', { isActive: query.isActive });
    }

    if (query.scrapeStatus) {
      qb.andWhere('product.scrapeStatus = :scrapeStatus', { scrapeStatus: query.scrapeStatus });
    }

    if (query.minPrice !== undefined) {
      qb.andWhere('product.currentPrice >= :minPrice', { minPrice: query.minPrice });
    }

    if (query.maxPrice !== undefined) {
      qb.andWhere('product.currentPrice <= :maxPrice', { maxPrice: query.maxPrice });
    }

    if (query.undercutOnly) {
      qb.andWhere('product.targetPrice IS NOT NULL').andWhere(
        'product.currentPrice < product.targetPrice',
      );
    }

    // NULLS LAST keeps never-scraped products out of the way when sorting by price/date.
    qb.orderBy(SORT_COLUMN[query.sortBy], query.sortOrder, 'NULLS LAST')
      // Deterministic tiebreaker so pagination never repeats or skips rows.
      .addOrderBy('product.id', 'ASC')
      .skip(query.offset)
      .take(query.limit);

    const [items, total] = await qb.getManyAndCount();
    return new PaginatedResponseDto(items, total, query.limit, query.offset);
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.productsRepository.findOne({ where: { id } });

    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found.`);
    }

    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto): Promise<Product> {
    const product = await this.findOne(id);
    const priceChanged =
      updateProductDto.currentPrice !== undefined &&
      updateProductDto.currentPrice !== product.currentPrice;

    Object.assign(product, updateProductDto);

    if (priceChanged) {
      product.lastUpdated = new Date();
    }

    const saved = await this.productsRepository.save(product);
    this.logger.log(`Updated product ${saved.id}`);
    return saved;
  }

  async remove(id: string): Promise<void> {
    // Delete by id and check the affected count: one round trip instead of
    // SELECT-then-DELETE, and no race between the two statements.
    const result = await this.productsRepository.delete({ id });

    if (!result.affected) {
      throw new NotFoundException(`Product with id "${id}" not found.`);
    }

    this.logger.log(`Deleted product ${id}`);
  }

  async findPriceHistory(
    id: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<PriceHistory>> {
    // Ensures a 404 (rather than an empty page) for an unknown product.
    await this.findOne(id);

    const [items, total] = await this.priceHistoryRepository.findAndCount({
      where: { productId: id },
      order: { recordedAt: 'DESC', id: 'ASC' },
      skip: pagination.offset,
      take: pagination.limit,
    });

    return new PaginatedResponseDto(items, total, pagination.limit, pagination.offset);
  }

  /**
   * Products the scheduler should visit now: active, and either never checked
   * or checked longer ago than their own `checkIntervalMinutes`.
   * Oldest checks first so no product starves.
   */
  findDueForScrape(limit: number): Promise<Product[]> {
    return this.productsRepository
      .createQueryBuilder('product')
      .where('product.isActive = true')
      .andWhere(
        new Brackets((where) => {
          where
            .where('product.lastCheckedAt IS NULL')
            .orWhere(
              "product.lastCheckedAt < NOW() - (product.check_interval_minutes * INTERVAL '1 minute')",
            );
        }),
      )
      .orderBy('product.lastCheckedAt', 'ASC', 'NULLS FIRST')
      .take(limit)
      .getMany();
  }

  /**
   * Applies one observed price to a product and appends it to the history.
   *
   * Both writes happen in a single transaction so the product row and its
   * history can never disagree. Returns a summary the scraper and the API use
   * to report what changed.
   */
  async applyPriceObservation(
    productId: string,
    observedPrice: number,
    source: string,
  ): Promise<PriceCheckResultDto> {
    return this.dataSource.transaction(async (manager) => {
      const products = manager.getRepository(Product);
      const history = manager.getRepository(PriceHistory);

      // Row-level lock: two concurrent checks of the same product would
      // otherwise both read the old price and write inconsistent history.
      const product = await products.findOne({
        where: { id: productId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!product) {
        throw new NotFoundException(`Product with id "${productId}" not found.`);
      }

      const price = this.round(observedPrice);
      const previousPrice = product.currentPrice;
      const priceChanged = previousPrice === null || previousPrice !== price;
      const changePercent =
        previousPrice !== null && previousPrice !== 0
          ? this.round(((price - previousPrice) / previousPrice) * 100, 4)
          : null;
      const now = new Date();

      product.previousPrice = previousPrice;
      product.currentPrice = price;
      product.lastCheckedAt = now;
      product.scrapeStatus = ScrapeStatus.Success;
      product.lastError = null;
      product.failureCount = 0;

      if (priceChanged) {
        product.lastUpdated = now;
      }

      product.lowestPrice =
        product.lowestPrice === null ? price : Math.min(product.lowestPrice, price);
      product.highestPrice =
        product.highestPrice === null ? price : Math.max(product.highestPrice, price);

      await products.save(product);

      // Only append to the history when something actually moved — otherwise an
      // hourly sweep would write millions of identical rows per year.
      if (priceChanged) {
        await history.insert({
          productId: product.id,
          price,
          previousPrice,
          changePercent,
          currency: product.currency,
          source,
        });
      }

      const significantChange =
        changePercent !== null && Math.abs(changePercent) >= this.alertThresholdPercent;
      const undercutsTargetPrice = product.targetPrice !== null && price < product.targetPrice;

      if (significantChange) {
        this.logger.warn(
          `Significant price move on "${product.name}" (${product.id}): ` +
            `${previousPrice} -> ${price} ${product.currency} (${changePercent?.toFixed(2)}%)`,
        );
      }

      if (undercutsTargetPrice) {
        this.logger.warn(
          `Competitor undercuts target price on "${product.name}" (${product.id}): ` +
            `${price} < ${product.targetPrice} ${product.currency}`,
        );
      }

      return {
        productId: product.id,
        productName: product.name,
        status: ScrapeStatus.Success,
        previousPrice,
        currentPrice: price,
        changePercent,
        priceChanged,
        significantChange,
        undercutsTargetPrice,
        error: null,
        checkedAt: now.toISOString(),
      };
    });
  }

  /**
   * Records a failed scrape attempt. After {@link MAX_CONSECUTIVE_FAILURES}
   * the product is deactivated so a permanently broken URL stops burning
   * requests every cycle.
   */
  async markScrapeFailure(productId: string, reason: string): Promise<PriceCheckResultDto> {
    const product = await this.findOne(productId);
    const now = new Date();

    product.failureCount += 1;
    product.lastCheckedAt = now;
    product.scrapeStatus = ScrapeStatus.Failed;
    product.lastError = reason.slice(0, 1000);

    if (product.failureCount >= MAX_CONSECUTIVE_FAILURES) {
      product.isActive = false;
      this.logger.error(
        `Deactivated product ${product.id} after ${product.failureCount} consecutive failures.`,
      );
    }

    await this.productsRepository.save(product);

    return {
      productId: product.id,
      productName: product.name,
      status: ScrapeStatus.Failed,
      previousPrice: product.previousPrice,
      currentPrice: product.currentPrice,
      changePercent: null,
      priceChanged: false,
      significantChange: false,
      undercutsTargetPrice: false,
      error: reason,
      checkedAt: now.toISOString(),
    };
  }

  /**
   * All counters in a single round trip.
   *
   * The obvious implementation — one `count()` per metric — costs six queries
   * and six pool connections; against a database in another region that is six
   * network round trips for numbers Postgres can produce in one pass. Aggregate
   * `FILTER` clauses collapse it to one scan of the table.
   */
  async getStats(): Promise<ProductStats> {
    const raw = await this.productsRepository
      .createQueryBuilder('product')
      .select('COUNT(*)::int', 'total')
      .addSelect('COUNT(*) FILTER (WHERE product.is_active)::int', 'active')
      .addSelect('COUNT(*) FILTER (WHERE product.scrape_status = :pending)::int', 'neverScraped')
      .addSelect('COUNT(*) FILTER (WHERE product.scrape_status = :failed)::int', 'failing')
      .addSelect(
        'COUNT(*) FILTER (WHERE product.target_price IS NOT NULL AND product.current_price < product.target_price)::int',
        'undercut',
      )
      .addSelect('AVG(product.current_price)', 'averagePrice')
      .addSelect('MAX(product.last_checked_at)', 'lastScrapeAt')
      .setParameters({ pending: ScrapeStatus.Pending, failed: ScrapeStatus.Failed })
      .getRawOne<{
        total: number;
        active: number;
        neverScraped: number;
        failing: number;
        undercut: number;
        averagePrice: string | null;
        lastScrapeAt: Date | null;
      }>();

    const total = raw?.total ?? 0;
    const active = raw?.active ?? 0;

    return {
      total,
      active,
      inactive: total - active,
      neverScraped: raw?.neverScraped ?? 0,
      failing: raw?.failing ?? 0,
      undercut: raw?.undercut ?? 0,
      averagePrice: raw?.averagePrice ? this.round(Number.parseFloat(raw.averagePrice)) : null,
      lastScrapeAt: raw?.lastScrapeAt ? new Date(raw.lastScrapeAt).toISOString() : null,
    };
  }

  /** Counts products with unexpired staleness — used by the scraper dry-run. */
  countStale(olderThan: Date): Promise<number> {
    return this.productsRepository.count({
      where: { isActive: true, lastCheckedAt: LessThan(olderThan) },
    });
  }

  private round(value: number, decimals = 2): number {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }
}
