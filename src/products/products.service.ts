import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, Repository } from 'typeorm';

import { User } from '../billing/entities/user.entity';
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

/** One value of a groupable column, with how many products carry it. */
export interface FacetBucket {
  value: string;
  count: number;
}

/** Distinct brands / manufacturers / categories, for the dashboard filters. */
export interface ProductFacets {
  brands: FacetBucket[];
  manufacturers: FacetBucket[];
  categories: FacetBucket[];
}

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
  [ProductSortField.Brand]: 'product.brand',
  [ProductSortField.Category]: 'product.category',
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
  /**
   * How many more products this account may track.
   *
   * The plan limit was stored and displayed but never checked, so every plan
   * allowed the same thing and the price list meant nothing. Enforced on the
   * way in, where the message can name the plan and the number.
   */
  async assertWithinLimit(owner: User, adding = 1): Promise<void> {
    // Only what is actually being watched counts. The bill is the scheduled
    // re-check, so a switched-off article costs nothing — and the message below
    // tells people to stop one, which was a lie while this counted every row.
    // It is also what makes the end of a trial survivable: the articles parked
    // when the plan shrinks sit there costing nothing and hold no slots.
    const used = await this.productsRepository.count({
      where: { ownerId: owner.id, isActive: true },
    });

    if (used + adding > owner.productLimit) {
      throw new ForbiddenException(
        `Планът ви позволява ${owner.productLimit} следени продукта, а вече следите ${used}. ` +
          (adding > 1 ? `Този импорт добавя още ${adding}. ` : '') +
          'Спрете някой продукт или преминете на по-голям план.',
      );
    }
  }

  async create(ownerId: string, createProductDto: CreateProductDto): Promise<Product> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const products = manager.getRepository(Product);

      const product = await products.save(
        products.create({
          ...createProductDto,
          ownerId,
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
  async bulkImport(ownerId: string, dto: BulkImportDto): Promise<BulkImportResultDto> {
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
        const result = await this.importOne(ownerId, entry, { updateExisting, dryRun });
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
    ownerId: string,
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

    // Scoped: two customers may legitimately use the same SKU, and matching
    // across accounts would quietly update somebody else's row.
    const existing = entry.sku
      ? await this.productsRepository.findOne({ where: { sku: entry.sku, ownerId } })
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
        // A re-import fills in gaps and refreshes what the file states, but an
        // omitted column in the export must not blank out a curated value.
        productsRepo.merge(product, {
          name: entry.name,
          brand: entry.brand ?? product.brand,
          manufacturer: entry.manufacturer ?? product.manufacturer,
          model: entry.model ?? product.model,
          category: entry.category ?? product.category,
          gtin: entry.gtin ?? product.gtin,
          imageUrl: entry.imageUrl ?? product.imageUrl,
          ourPrice: entry.ourPrice ?? product.ourPrice,
          targetPrice: entry.targetPrice ?? product.targetPrice,
        });
        product = await productsRepo.save(product);
      } else {
        product = await productsRepo.save(
          productsRepo.create({
            ownerId,
            name: entry.name,
            sku: entry.sku ?? null,
            brand: entry.brand ?? null,
            manufacturer: entry.manufacturer ?? null,
            model: entry.model ?? null,
            category: entry.category ?? null,
            gtin: entry.gtin ?? null,
            imageUrl: entry.imageUrl ?? null,
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

  async findAll(ownerId: string, query: QueryProductsDto): Promise<PaginatedResponseDto<Product>> {
    const qb = this.productsRepository
      .createQueryBuilder('product')
      .where('product.owner_id = :ownerId', { ownerId });

    if (query.search) {
      // Whoever is looking for "samsung" means the brand as readily as the
      // name, and a warehouse clerk pastes a barcode. All of it is one box.
      const search = `%${query.search}%`;
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('product.name ILIKE :search', { search })
            .orWhere('product.sku ILIKE :search', { search })
            .orWhere('product.brand ILIKE :search', { search })
            .orWhere('product.manufacturer ILIKE :search', { search })
            .orWhere('product.model ILIKE :search', { search })
            .orWhere('product.category ILIKE :search', { search })
            .orWhere('product.gtin ILIKE :search', { search })
            .orWhere('product.competitor_url ILIKE :search', { search });
        }),
      );
    }

    if (query.brand) {
      qb.andWhere('product.brand = :brand', { brand: query.brand });
    }

    if (query.manufacturer) {
      qb.andWhere('product.manufacturer = :manufacturer', { manufacturer: query.manufacturer });
    }

    if (query.category) {
      qb.andWhere('product.category = :category', { category: query.category });
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

  async findOne(ownerId: string, id: string, withCompetitors = false): Promise<Product> {
    const product = await this.productsRepository.findOne({
      where: { id, ownerId },
      relations: withCompetitors ? { competitors: true } : undefined,
    });

    // Somebody else's product is reported as missing, not as forbidden. The
    // difference between the two answers is itself a way to discover what
    // another customer tracks.
    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found.`);
    }

    return product;
  }

  async update(ownerId: string, id: string, updateProductDto: UpdateProductDto): Promise<Product> {
    const product = await this.findOne(ownerId, id);
    const urlChanged =
      updateProductDto.competitorUrl !== undefined &&
      updateProductDto.competitorUrl !== product.competitorUrl;

    Object.assign(product, updateProductDto);
    // Never taken from the payload: accepting it would let a caller move a row
    // into — or out of — somebody else's account.
    product.ownerId = ownerId;
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

  /**
   * Deletes a product, its listings and every price ever recorded for it.
   *
   * The cascade is the whole point of the caution: those observations cannot
   * be collected again, because the pages that carried them have since
   * changed. A product that has never moved is deleted without argument; one
   * with history is refused until the caller asks for it explicitly.
   */
  async remove(ownerId: string, id: string, purge = false): Promise<void> {
    const product = await this.productsRepository.findOne({
      where: { id, ownerId },
      select: { id: true, name: true },
    });

    if (!product) {
      throw new NotFoundException(`Product with id "${id}" not found.`);
    }

    const [history, listings] = await Promise.all([
      this.priceHistoryRepository.count({ where: { productId: id } }),
      this.competitorsRepository.count({ where: { productId: id } }),
    ]);

    if (history > 0 && !purge) {
      throw new ConflictException(
        `„${product.name}" има ${history} записани промени в цената при ${listings} доставчика. ` +
          'Изтриването ги маха завинаги — те не могат да бъдат прочетени отново. ' +
          'Повторете заявката с ?purge=true, ако наистина искате това.',
      );
    }

    await this.productsRepository.delete({ id, ownerId });

    // Logged with the account and the damage: "deleted product <uuid>" is not
    // enough to answer a customer asking where their history went.
    this.logger.warn(
      `Account ${ownerId} deleted product ${id} ("${product.name}") with ${history} price records and ${listings} listings.`,
    );
  }

  async findPriceHistory(
    ownerId: string,
    id: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<PriceHistory>> {
    // Ensures a 404 (rather than an empty page) for an unknown product — and,
    // just as importantly, for one belonging to somebody else.
    await this.findOne(ownerId, id);

    const [items, total] = await this.priceHistoryRepository.findAndCount({
      where: { productId: id },
      order: { recordedAt: 'DESC', id: 'ASC' },
      skip: pagination.offset,
      take: pagination.limit,
    });

    return new PaginatedResponseDto(items, total, pagination.limit, pagination.offset);
  }

  /** The listing `Product.competitorUrl` points at. */
  async findPrimaryCompetitor(ownerId: string, productId: string): Promise<Competitor> {
    // Ownership is proved on the product, which is where it is recorded;
    // listings inherit it through the row they hang off.
    await this.findOne(ownerId, productId);

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
  async getStats(ownerId: string): Promise<ProductStats> {
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
      .where('product.owner_id = :ownerId', { ownerId })
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

  /**
   * The values the brand / manufacturer / category filters offer.
   *
   * Derived from the catalogue rather than kept in a lookup table: there is no
   * curation step where someone would maintain the second list, so it would
   * only ever drift out of date with the first.
   */
  async getFacets(ownerId: string): Promise<ProductFacets> {
    const [brands, manufacturers, categories] = await Promise.all([
      this.facet(ownerId, 'brand'),
      this.facet(ownerId, 'manufacturer'),
      this.facet(ownerId, 'category'),
    ]);

    return { brands, manufacturers, categories };
  }

  /** `column` is a literal from {@link getFacets}, never user input. */
  private async facet(
    ownerId: string,
    column: 'brand' | 'manufacturer' | 'category',
  ): Promise<FacetBucket[]> {
    const rows = await this.productsRepository
      .createQueryBuilder('product')
      .select(`product.${column}`, 'value')
      .addSelect('COUNT(*)::int', 'count')
      .where('product.owner_id = :ownerId', { ownerId })
      .andWhere(`product.${column} IS NOT NULL`)
      .andWhere(`product.${column} <> ''`)
      .groupBy(`product.${column}`)
      .orderBy('"count"', 'DESC')
      .addOrderBy('"value"', 'ASC')
      .getRawMany<{ value: string; count: number }>();

    return rows;
  }

  private round(value: number, decimals = 2): number {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }
}
