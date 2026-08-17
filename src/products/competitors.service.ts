import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, Repository } from 'typeorm';

import { AlertsService, RaiseAlertInput } from '../alerts/alerts.service';
import { AlertSeverity, AlertType } from '../alerts/enums/alert.enums';
import { Configuration } from '../config/configuration';
import { convert, isConvertible } from './currency';
import { CreateCompetitorDto } from './dto/create-competitor.dto';
import { PriceCheckResultDto } from './dto/price-check-result.dto';
import { UpdateCompetitorDto } from './dto/update-competitor.dto';
import { Competitor } from './entities/competitor.entity';
import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { ScrapeStatus } from './enums/scrape-status.enum';

/** One observed price, as handed over by any {@link PriceSource}. */
export interface PriceObservationInput {
  price: number;
  currency?: string | null;
  inStock?: boolean | null;
  strategy?: string | null;
  source: string;
  sellerName?: string | null;
  location?: string | null;
  imageUrl?: string | null;
  attributes?: Record<string, string> | null;
}

/** Consecutive failures after which a listing is deactivated automatically. */
const MAX_CONSECUTIVE_FAILURES = 10;

@Injectable()
export class CompetitorsService {
  private readonly logger = new Logger(CompetitorsService.name);
  private readonly alertThresholdPercent: number;

  constructor(
    @InjectRepository(Competitor)
    private readonly competitorsRepository: Repository<Competitor>,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    private readonly dataSource: DataSource,
    private readonly alertsService: AlertsService,
    configService: ConfigService<Configuration, true>,
  ) {
    this.alertThresholdPercent = configService.get('scraper', {
      infer: true,
    }).alertThresholdPercent;
  }

  // --- CRUD ----------------------------------------------------------------

  async findAllForProduct(productId: string): Promise<Competitor[]> {
    await this.assertProductExists(productId);

    return this.competitorsRepository.find({
      where: { productId },
      order: { isPrimary: 'DESC', currentPrice: 'ASC', name: 'ASC' },
    });
  }

  async findOne(id: string): Promise<Competitor> {
    const competitor = await this.competitorsRepository.findOne({ where: { id } });

    if (!competitor) {
      throw new NotFoundException(`Competitor with id "${id}" not found.`);
    }

    return competitor;
  }

  async create(productId: string, dto: CreateCompetitorDto): Promise<Competitor> {
    await this.assertProductExists(productId);

    // Checked explicitly so the caller learns *which* URL collided. Left to the
    // unique index, this surfaces as a generic "record already exists", which
    // reads like a bug rather than "you already track this shop".
    const duplicate = await this.competitorsRepository.findOne({
      where: { productId, url: dto.url },
    });

    if (duplicate) {
      throw new ConflictException(
        `Този линк вече се следи за продукта като „${duplicate.name}"${
          duplicate.isActive ? '' : ' (спрян — активирайте го вместо да го добавяте пак)'
        }.`,
      );
    }

    const competitor = await this.competitorsRepository.save(
      this.competitorsRepository.create({
        productId,
        name: dto.name,
        url: dto.url,
        host: this.hostOf(dto.url),
        currency: dto.currency ?? 'EUR',
        priceSelector: dto.priceSelector ?? null,
        priceAttribute: dto.priceAttribute ?? null,
        currentPrice: dto.currentPrice ?? null,
        isActive: dto.isActive ?? true,
        isPrimary: false,
        scrapeStatus: ScrapeStatus.Pending,
      }),
    );

    await this.recomputeProduct(productId);
    this.logger.log(
      `Added competitor ${competitor.id} (${competitor.name}) to product ${productId}`,
    );

    return competitor;
  }

  async update(id: string, dto: UpdateCompetitorDto): Promise<Competitor> {
    const competitor = await this.findOne(id);

    Object.assign(competitor, dto);
    if (dto.url) {
      competitor.host = this.hostOf(dto.url);
    }

    const saved = await this.competitorsRepository.save(competitor);
    await this.recomputeProduct(saved.productId);

    return saved;
  }

  async remove(id: string): Promise<void> {
    const competitor = await this.findOne(id);

    if (competitor.isPrimary) {
      throw new BadRequestException(
        'The primary competitor cannot be deleted. Promote another listing first, or delete the product.',
      );
    }

    await this.competitorsRepository.delete({ id });
    await this.recomputeProduct(competitor.productId);
  }

  /**
   * Makes `id` the primary listing, demoting the current one.
   * `Product.competitorUrl` follows the primary, keeping the denormalised
   * column and the competitors table from drifting apart.
   */
  async promoteToPrimary(id: string): Promise<Competitor> {
    const competitor = await this.findOne(id);

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(Competitor)
        .update({ productId: competitor.productId }, { isPrimary: false });
      await manager.getRepository(Competitor).update({ id }, { isPrimary: true });
      await manager
        .getRepository(Product)
        .update({ id: competitor.productId }, { competitorUrl: competitor.url });
    });

    return this.findOne(id);
  }

  // --- Scraper queue -------------------------------------------------------

  /**
   * Listings due for a check: active, on an active product, and either never
   * checked or checked longer ago than the product's `checkIntervalMinutes`.
   * Oldest first, so nothing starves.
   */
  findDueForScrape(limit: number): Promise<Competitor[]> {
    return (
      this.competitorsRepository
        .createQueryBuilder('competitor')
        .innerJoinAndSelect('competitor.product', 'product')
        .where('competitor.isActive = true')
        .andWhere('product.isActive = true')
        .andWhere(
          new Brackets((where) => {
            where
              .where('competitor.last_checked_at IS NULL')
              .orWhere(
                "competitor.last_checked_at < NOW() - (product.check_interval_minutes * INTERVAL '1 minute')",
              );
          }),
        )
        // Property path, not the column name: combined with `take()` and a join,
        // TypeORM resolves the ORDER BY through entity metadata, and a raw column
        // name is not found there — it throws on `databaseName` of undefined.
        .orderBy('competitor.lastCheckedAt', 'ASC', 'NULLS FIRST')
        .take(limit)
        .getMany()
    );
  }

  countDueForScrape(): Promise<number> {
    return this.competitorsRepository
      .createQueryBuilder('competitor')
      .innerJoin('competitor.product', 'product')
      .where('competitor.isActive = true')
      .andWhere('product.isActive = true')
      .andWhere(
        "(competitor.last_checked_at IS NULL OR competitor.last_checked_at < NOW() - (product.check_interval_minutes * INTERVAL '1 minute'))",
      )
      .getCount();
  }

  // --- The write path ------------------------------------------------------

  /**
   * Applies one observed price to a listing.
   *
   * The database work runs in a single transaction with the listing row locked,
   * so two concurrent checks cannot interleave. Alerts are raised *after* the
   * transaction commits: delivering them means HTTP calls to Slack and
   * webhooks, and holding a Postgres transaction open across a third-party
   * request is how connection pools die.
   */
  async applyPriceObservation(
    competitorId: string,
    observation: PriceObservationInput,
  ): Promise<PriceCheckResultDto> {
    const { result, alerts } = await this.dataSource.transaction(async (manager) => {
      const competitors = manager.getRepository(Competitor);

      const competitor = await competitors.findOne({
        where: { id: competitorId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!competitor) {
        throw new NotFoundException(`Competitor with id "${competitorId}" not found.`);
      }

      const product = await manager.getRepository(Product).findOneOrFail({
        where: { id: competitor.productId },
      });

      return this.applyToCompetitor(manager, competitor, product, observation);
    });

    // Alerting is a side effect of a successful price check, never a condition
    // of one. The price is already committed at this point; letting a failed
    // alert insert bubble up would make the caller mark the listing as failed
    // and discard a reading that is, in fact, safely stored.
    for (const alert of alerts) {
      try {
        await this.alertsService.raise(alert);
      } catch (error) {
        this.logger.error(
          `Цената е записана, но alert-ът (${alert.type}) не бе създаден: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return result;
  }

  /**
   * Records a failed check. After {@link MAX_CONSECUTIVE_FAILURES} the listing
   * is deactivated and an alert is raised — a permanently broken URL should
   * stop burning requests and start being somebody's problem.
   */
  async markScrapeFailure(competitorId: string, reason: string): Promise<PriceCheckResultDto> {
    // The listing can legitimately disappear mid-sweep — deleted from the UI,
    // or its product removed. Recording a failure against a row that no longer
    // exists is not an error worth propagating.
    const competitor = await this.competitorsRepository.findOne({ where: { id: competitorId } });

    if (!competitor) {
      this.logger.warn(`Складът ${competitorId} е изчезнал по време на проверката — пропуснат.`);
      return {
        productId: '',
        productName: '',
        competitorId,
        competitorName: '',
        status: ScrapeStatus.Skipped,
        previousPrice: null,
        currentPrice: null,
        changePercent: null,
        priceChanged: false,
        significantChange: false,
        undercutsTargetPrice: false,
        allTimeLow: false,
        inStock: null,
        strategy: null,
        error: reason,
        checkedAt: new Date().toISOString(),
      };
    }

    const product = await this.productsRepository.findOneOrFail({
      where: { id: competitor.productId },
    });
    const now = new Date();

    competitor.failureCount += 1;
    competitor.lastCheckedAt = now;
    competitor.scrapeStatus = ScrapeStatus.Failed;
    competitor.lastError = reason.slice(0, 1000);

    const deactivated = competitor.failureCount >= MAX_CONSECUTIVE_FAILURES;
    if (deactivated) {
      competitor.isActive = false;
      this.logger.error(
        `Deactivated competitor ${competitor.id} after ${competitor.failureCount} consecutive failures.`,
      );
    }

    await this.competitorsRepository.save(competitor);
    await this.recomputeProduct(competitor.productId);

    if (deactivated) {
      await this.alertsService.raise({
        productId: product.id,
        competitorId: competitor.id,
        type: AlertType.ScrapeFailing,
        severity: AlertSeverity.Warning,
        message: `Listing "${competitor.name}" for ${product.name} was deactivated after ${competitor.failureCount} consecutive failures. Last error: ${reason}`,
        oldPrice: competitor.previousPrice,
        newPrice: competitor.currentPrice,
        changePercent: null,
        currency: competitor.currency,
        context: this.contextFor(product, competitor),
      });
    }

    return {
      productId: product.id,
      productName: product.name,
      competitorId: competitor.id,
      competitorName: competitor.name,
      status: ScrapeStatus.Failed,
      previousPrice: competitor.previousPrice,
      currentPrice: competitor.currentPrice,
      changePercent: null,
      priceChanged: false,
      significantChange: false,
      undercutsTargetPrice: false,
      allTimeLow: false,
      inStock: competitor.inStock,
      strategy: null,
      error: reason,
      checkedAt: now.toISOString(),
    };
  }

  // --- Internals -----------------------------------------------------------

  private async applyToCompetitor(
    manager: EntityManager,
    competitor: Competitor,
    product: Product,
    observation: PriceObservationInput,
  ): Promise<{ result: PriceCheckResultDto; alerts: RaiseAlertInput[] }> {
    const observedCurrency = observation.currency?.toUpperCase() ?? competitor.currency;
    const price = this.round(
      isConvertible(observedCurrency, product.currency)
        ? convert(observation.price, observedCurrency, product.currency)
        : observation.price,
    );
    const previousPrice = competitor.currentPrice;
    const priceChanged = previousPrice === null || previousPrice !== price;
    const changePercent =
      previousPrice !== null && previousPrice !== 0
        ? this.round(((price - previousPrice) / previousPrice) * 100, 4)
        : null;
    const now = new Date();

    // The page is the authority on what it charges, but the product is the
    // authority on the currency everything is compared in. A shop quoting BGN
    // against a EUR product is converted at the fixed peg; anything else is a
    // failure rather than a silent apples-to-oranges comparison.
    const observed = observation.currency?.toUpperCase() ?? competitor.currency;

    if (observed !== product.currency) {
      if (!isConvertible(observed, product.currency)) {
        throw new BadRequestException(
          `${competitor.name} обявява цената в ${observed}, а продуктът се води в ${product.currency}. Няма фиксиран курс между тях.`,
        );
      }

      this.logger.debug(
        `${competitor.name}: ${price} ${observed} → ${convert(price, observed, product.currency)} ${product.currency}`,
      );
    }

    competitor.currency = product.currency;

    competitor.previousPrice = previousPrice;
    competitor.currentPrice = price;
    competitor.lastCheckedAt = now;
    competitor.scrapeStatus = ScrapeStatus.Success;
    competitor.lastError = null;
    competitor.failureCount = 0;
    competitor.lastStrategy = observation.strategy ?? null;
    // Details are only overwritten when the page supplied them, so a redesign
    // that hides the seller does not erase what we already knew.
    if (observation.sellerName) competitor.sellerName = observation.sellerName.slice(0, 160);
    if (observation.location) competitor.location = observation.location.slice(0, 255);
    if (observation.imageUrl) competitor.imageUrl = observation.imageUrl;
    if (observation.attributes) competitor.attributes = observation.attributes;
    competitor.inStock = observation.inStock ?? competitor.inStock;

    if (priceChanged) {
      competitor.lastUpdated = now;
    }

    await manager.getRepository(Competitor).save(competitor);

    // Only append history when something moved: an hourly sweep over a stable
    // catalog would otherwise write millions of identical rows per year.
    if (priceChanged) {
      await manager.getRepository(PriceHistory).insert({
        productId: competitor.productId,
        competitorId: competitor.id,
        price,
        previousPrice,
        changePercent,
        currency: competitor.currency,
        source: observation.source,
      });
    }

    const previousProductLow = product.lowestPrice;
    const updatedProduct = await this.recomputeProduct(competitor.productId, manager);

    const allTimeLow =
      priceChanged &&
      previousProductLow !== null &&
      price < previousProductLow &&
      updatedProduct.currentPrice === price;
    const significantChange =
      changePercent !== null && Math.abs(changePercent) >= this.alertThresholdPercent;
    const undercutsTargetPrice = product.targetPrice !== null && price < product.targetPrice;

    return {
      result: {
        productId: product.id,
        productName: product.name,
        competitorId: competitor.id,
        competitorName: competitor.name,
        status: ScrapeStatus.Success,
        previousPrice,
        currentPrice: price,
        changePercent,
        priceChanged,
        significantChange,
        undercutsTargetPrice,
        allTimeLow,
        inStock: competitor.inStock,
        strategy: observation.strategy ?? null,
        error: null,
        checkedAt: now.toISOString(),
      },
      alerts: this.buildAlerts({
        product,
        competitor,
        price,
        previousPrice,
        changePercent,
        significantChange,
        undercutsTargetPrice,
        allTimeLow,
        inStock: observation.inStock ?? null,
      }),
    };
  }

  private buildAlerts(input: {
    product: Product;
    competitor: Competitor;
    price: number;
    previousPrice: number | null;
    changePercent: number | null;
    significantChange: boolean;
    undercutsTargetPrice: boolean;
    allTimeLow: boolean;
    inStock: boolean | null;
  }): RaiseAlertInput[] {
    const { product, competitor, price, previousPrice, changePercent } = input;
    const context = this.contextFor(product, competitor);
    const currency = competitor.currency;
    const alerts: RaiseAlertInput[] = [];

    const base = {
      productId: product.id,
      competitorId: competitor.id,
      oldPrice: previousPrice,
      newPrice: price,
      changePercent,
      currency,
      context,
    };

    if (input.undercutsTargetPrice) {
      alerts.push({
        ...base,
        type: AlertType.Undercut,
        message: `${competitor.name} sells ${product.name} at ${price} ${currency} — below your target of ${product.targetPrice} ${currency}.`,
      });
    }

    if (input.significantChange && changePercent !== null) {
      alerts.push({
        ...base,
        type: changePercent < 0 ? AlertType.PriceDrop : AlertType.PriceRise,
        message: `${competitor.name} moved ${product.name} from ${previousPrice} to ${price} ${currency} (${changePercent.toFixed(2)}%).`,
      });
    }

    if (input.allTimeLow) {
      alerts.push({
        ...base,
        type: AlertType.AllTimeLow,
        message: `${price} ${currency} at ${competitor.name} is the lowest price ever recorded for ${product.name}.`,
      });
    }

    if (input.inStock === false) {
      alerts.push({
        ...base,
        type: AlertType.OutOfStock,
        message: `${competitor.name} reports ${product.name} as out of stock — an opportunity to hold or raise your price.`,
      });
    }

    return alerts;
  }

  /**
   * Recomputes the product row from its listings: the market price is the
   * cheapest active competitor, and the product's scrape state is the best of
   * its listings — one broken retailer must not mark the whole product failed.
   */
  async recomputeProduct(productId: string, manager?: EntityManager): Promise<Product> {
    const products = manager ? manager.getRepository(Product) : this.productsRepository;
    const competitors = manager ? manager.getRepository(Competitor) : this.competitorsRepository;

    const product = await products.findOneOrFail({ where: { id: productId } });

    const aggregate = await competitors
      .createQueryBuilder('competitor')
      .select('COUNT(*) FILTER (WHERE competitor.is_active)::int', 'activeCount')
      .addSelect('MIN(competitor.current_price) FILTER (WHERE competitor.is_active)', 'cheapest')
      .addSelect('MAX(competitor.last_checked_at)', 'lastCheckedAt')
      .addSelect(
        "COUNT(*) FILTER (WHERE competitor.is_active AND competitor.scrape_status = 'success')::int",
        'successCount',
      )
      .where('competitor.product_id = :productId', { productId })
      .getRawOne<{
        activeCount: number;
        cheapest: string | null;
        lastCheckedAt: Date | null;
        successCount: number;
      }>();

    const cheapest =
      aggregate?.cheapest !== null && aggregate?.cheapest !== undefined
        ? Number.parseFloat(aggregate.cheapest)
        : null;

    const previousPrice = product.currentPrice;
    const priceMoved = cheapest !== null && cheapest !== previousPrice;

    product.competitorCount = aggregate?.activeCount ?? 0;
    product.currentPrice = cheapest;
    product.lastCheckedAt = aggregate?.lastCheckedAt ?? product.lastCheckedAt;

    if (priceMoved) {
      product.previousPrice = previousPrice;
      product.lastUpdated = new Date();
    }

    if (cheapest !== null) {
      product.lowestPrice =
        product.lowestPrice === null ? cheapest : Math.min(product.lowestPrice, cheapest);
      product.highestPrice =
        product.highestPrice === null ? cheapest : Math.max(product.highestPrice, cheapest);

      const cheapestRow = await competitors.findOne({
        where: { productId, isActive: true, currentPrice: cheapest },
      });
      product.cheapestCompetitorId = cheapestRow?.id ?? null;
    } else {
      product.cheapestCompetitorId = null;
    }

    if ((aggregate?.activeCount ?? 0) === 0) {
      product.scrapeStatus = ScrapeStatus.Skipped;
    } else if ((aggregate?.successCount ?? 0) > 0) {
      product.scrapeStatus = ScrapeStatus.Success;
      product.lastError = null;
      product.failureCount = 0;
    } else if (product.lastCheckedAt !== null) {
      product.scrapeStatus = ScrapeStatus.Failed;
    }

    return products.save(product);
  }

  private contextFor(product: Product, competitor: Competitor) {
    return {
      productName: product.name,
      productSku: product.sku,
      competitorName: competitor.name,
      competitorUrl: competitor.url,
      targetPrice: product.targetPrice,
    };
  }

  private async assertProductExists(productId: string): Promise<void> {
    const exists = await this.productsRepository.exists({ where: { id: productId } });

    if (!exists) {
      throw new NotFoundException(`Product with id "${productId}" not found.`);
    }
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      throw new BadRequestException(`"${url}" is not a valid absolute URL.`);
    }
  }

  private round(value: number, decimals = 2): number {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }
}
