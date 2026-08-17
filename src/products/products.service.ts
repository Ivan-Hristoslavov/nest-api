import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';

import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import {
  BulkImportDto,
  BulkImportResultDto,
  BulkProductDto,
  BulkRowResultDto,
} from './dto/bulk-import.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductSortField, QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Competitor } from './entities/competitor.entity';
import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { ScrapeStatus } from './enums/scrape-status.enum';
import { retailerNameForHost } from '../scraper/parsers/site-profiles';

/** Aggregate counters for the dashboard / monitoring endpoint. */
export interface ProductStats {
  total: number;
  active: number;
  inactive: number;
  neverScraped: number;
  failing: number;
  undercut: number;
  competitors: number;
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

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(PriceHistory)
    private readonly priceHistoryRepository: Repository<PriceHistory>,
    @InjectRepository(Competitor)
    private readonly competitorsRepository: Repository<Competitor>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a product together with its primary competitor listing.
   *
   * `competitorUrl` on the product and the primary row in `competitors` are
   * written in one transaction, so the denormalised column can never point at
   * a listing that does not exist.
   */
  async create(createProductDto: CreateProductDto): Promise<Product> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const products = manager.getRepository(Product);

      const product = await products.save(
        products.create({
          ...createProductDto,
          currency: createProductDto.currency ?? 'EUR',
          currentPrice: createProductDto.currentPrice ?? null,
          targetPrice: createProductDto.targetPrice ?? null,
          ourPrice: createProductDto.ourPrice ?? null,
          lowestPrice: createProductDto.currentPrice ?? null,
          highestPrice: createProductDto.currentPrice ?? null,
          lastUpdated: createProductDto.currentPrice !== undefined ? new Date() : null,
          scrapeStatus: ScrapeStatus.Pending,
          competitorCount: 1,
        }),
      );

      const competitor = await manager.getRepository(Competitor).save(
        manager.getRepository(Competitor).create({
          productId: product.id,
          name: createProductDto.competitorName ?? new URL(product.competitorUrl).host,
          url: product.competitorUrl,
          host: new URL(product.competitorUrl).host,
          currency: product.currency,
          currentPrice: product.currentPrice,
          priceSelector: createProductDto.priceSelector ?? null,
          isPrimary: true,
          isActive: true,
          scrapeStatus: ScrapeStatus.Pending,
        }),
      );

      // Seed the history so charts have a starting point when a price was given.
      if (product.currentPrice !== null) {
        await manager.getRepository(PriceHistory).insert({
          productId: product.id,
          competitorId: competitor.id,
          price: product.currentPrice,
          previousPrice: null,
          changePercent: null,
          currency: product.currency,
          source: 'initial',
        });
      }

      product.cheapestCompetitorId = competitor.id;
      return products.save(product);
    });

    this.logger.log(`Created product ${saved.id} (${saved.name})`);
    return saved;
  }

  /**
   * Imports many products at once.
   *
   * Nobody pastes 500 links by hand, so the alternative to this endpoint is not
   * "a slower workflow" — it is the product going unused. Design decisions that
   * matter at this size:
   *
   * - **Row isolation.** Each row runs in its own transaction. One bad URL in a
   *   catalogue export must not roll back the 499 good ones, and the caller is
   *   told exactly which row failed and why.
   * - **Idempotency by SKU.** Re-importing an updated export is the normal case,
   *   not an error. Existing products are updated and their listings merged.
   * - **A dry run.** On a 500-row file you want to see what will happen before
   *   it happens.
   * - **No scraping here.** Prices are fetched by the scheduler afterwards;
   *   doing 1500 HTTP requests inside one API call would time out and hammer
   *   every shop at once.
   */
  async bulkImport(dto: BulkImportDto): Promise<BulkImportResultDto> {
    const startedAt = Date.now();
    const rows: BulkRowResultDto[] = [];
    const updateExisting = dto.updateExisting ?? true;
    const dryRun = dto.dryRun ?? false;

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let listingsAdded = 0;

    for (const [index, entry] of dto.products.entries()) {
      const row = index + 1;

      try {
        const result = await this.importOne(entry, { updateExisting, dryRun });
        rows.push({ row, name: entry.name, ...result });

        if (result.status === 'created') created += 1;
        else if (result.status === 'updated') updated += 1;
        else skipped += 1;

        listingsAdded += result.listingsAdded;
      } catch (error) {
        failed += 1;
        rows.push({
          row,
          name: entry.name,
          status: 'failed',
          productId: null,
          listingsAdded: 0,
          message: error instanceof Error ? error.message : 'Непозната грешка',
        });
      }
    }

    this.logger.log(
      `Bulk import${dryRun ? ' (dry run)' : ''}: ${created} нови, ${updated} обновени, ` +
        `${skipped} пропуснати, ${failed} с грешка, ${listingsAdded} склада.`,
    );

    return {
      received: dto.products.length,
      created,
      updated,
      skipped,
      failed,
      listingsAdded,
      dryRun,
      durationMs: Date.now() - startedAt,
      rows,
    };
  }

  private async importOne(
    entry: BulkProductDto,
    options: { updateExisting: boolean; dryRun: boolean },
  ): Promise<Omit<BulkRowResultDto, 'row' | 'name'>> {
    const urls = entry.urls.map((url) => url.trim()).filter(Boolean);

    if (urls.length === 0) {
      throw new Error('Няма нито един линк към магазин.');
    }

    for (const url of urls) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`"${url.slice(0, 60)}" не е валиден адрес.`);
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error(`"${url.slice(0, 60)}" не е http/https.`);
      }
      // A home page carries a price per tile and would yield an arbitrary one.
      if (parsed.pathname.replace(/\/+$/, '') === '') {
        throw new Error(`"${parsed.host}" сочи към начална страница, не към продукт.`);
      }
    }

    const existing = entry.sku
      ? await this.productsRepository.findOne({ where: { sku: entry.sku } })
      : null;

    if (existing && !options.updateExisting) {
      return {
        status: 'skipped',
        productId: existing.id,
        listingsAdded: 0,
        message: `SKU ${entry.sku ?? ''} вече съществува.`,
      };
    }

    if (options.dryRun) {
      return {
        status: existing ? 'updated' : 'created',
        productId: existing?.id ?? null,
        listingsAdded: urls.length,
        message: 'Пробен режим — нищо не е записано.',
      };
    }

    // One transaction per row: a failure isolates to its own line.
    return this.dataSource.transaction(async (manager) => {
      const productsRepo = manager.getRepository(Product);
      const competitorsRepo = manager.getRepository(Competitor);
      const currency = entry.currency ?? 'EUR';

      let product = existing;

      if (product) {
        productsRepo.merge(product, {
          name: entry.name,
          ourPrice: entry.ourPrice ?? product.ourPrice,
          targetPrice: entry.targetPrice ?? product.targetPrice,
        });
        product = await productsRepo.save(product);
      } else {
        product = await productsRepo.save(
          productsRepo.create({
            name: entry.name,
            sku: entry.sku ?? null,
            targetUrl: urls[0],
            competitorUrl: urls[0],
            currency,
            ourPrice: entry.ourPrice ?? null,
            targetPrice: entry.targetPrice ?? null,
            scrapeStatus: ScrapeStatus.Pending,
            isActive: true,
          }),
        );
      }

      let added = 0;

      for (const [index, url] of urls.entries()) {
        const duplicate = await competitorsRepo.findOne({
          where: { productId: product.id, url },
        });
        if (duplicate) continue;

        const host = new URL(url).host;
        await competitorsRepo.save(
          competitorsRepo.create({
            productId: product.id,
            name: retailerNameForHost(host),
            url,
            host,
            currency,
            isPrimary: index === 0 && !existing,
            isActive: true,
            scrapeStatus: ScrapeStatus.Pending,
          }),
        );
        added += 1;
      }

      product.competitorCount = await competitorsRepo.count({
        where: { productId: product.id, isActive: true },
      });
      await productsRepo.save(product);

      return {
        status: existing ? ('updated' as const) : ('created' as const),
        productId: product.id,
        listingsAdded: added,
        message: null,
      };
    });
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

    if (query.includeCompetitors) {
      qb.leftJoinAndSelect('product.competitors', 'competitor');
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

  async findOne(id: string, withCompetitors = false): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id },
      relations: withCompetitors ? { competitors: true } : undefined,
    });

    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found.`);
    }

    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto): Promise<Product> {
    const product = await this.findOne(id);
    const urlChanged =
      updateProductDto.competitorUrl !== undefined &&
      updateProductDto.competitorUrl !== product.competitorUrl;

    Object.assign(product, updateProductDto);
    const saved = await this.productsRepository.save(product);

    // Keep the primary listing pointing at the same URL as the product.
    if (urlChanged) {
      await this.competitorsRepository.update(
        { productId: id, isPrimary: true },
        { url: saved.competitorUrl, host: new URL(saved.competitorUrl).host },
      );
    }

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

  /** The listing `Product.competitorUrl` points at. */
  async findPrimaryCompetitor(productId: string): Promise<Competitor> {
    const competitor = await this.competitorsRepository.findOne({
      where: { productId, isPrimary: true },
    });

    if (!competitor) {
      throw new NotFoundException(`Product "${productId}" has no primary competitor listing.`);
    }

    return competitor;
  }

  /**
   * All counters in a single round trip.
   *
   * The obvious implementation — one `count()` per metric — costs six queries
   * and six pool connections; against a database in another region that is six
   * network round trips for numbers Postgres can produce in one pass.
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
      .addSelect('COALESCE(SUM(product.competitor_count), 0)::int', 'competitors')
      .addSelect('AVG(product.current_price)', 'averagePrice')
      .addSelect('MAX(product.last_checked_at)', 'lastScrapeAt')
      .setParameters({ pending: ScrapeStatus.Pending, failed: ScrapeStatus.Failed })
      .getRawOne<{
        total: number;
        active: number;
        neverScraped: number;
        failing: number;
        undercut: number;
        competitors: number;
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
      competitors: raw?.competitors ?? 0,
      averagePrice: raw?.averagePrice ? this.round(Number.parseFloat(raw.averagePrice)) : null,
      lastScrapeAt: raw?.lastScrapeAt ? new Date(raw.lastScrapeAt).toISOString() : null,
    };
  }

  private round(value: number, decimals = 2): number {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }
}
