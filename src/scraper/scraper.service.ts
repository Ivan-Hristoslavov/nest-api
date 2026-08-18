import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { Repository } from 'typeorm';

import { Configuration, ScraperConfig } from '../config/configuration';
import { CompetitorsService } from '../products/competitors.service';
import { PriceCheckResultDto } from '../products/dto/price-check-result.dto';
import { ScrapeStatus } from '../products/enums/scrape-status.enum';
import { Competitor } from '../products/entities/competitor.entity';
import { Product } from '../products/entities/product.entity';
import { ScrapeRunResultDto, ScraperStatusDto } from './dto/scrape-run-result.dto';
import { PRICE_SOURCE, PriceFetchError, PriceSource } from './fetchers/price-source.interface';

export const SCRAPER_CRON_JOB = 'competitor-price-sweep';

/**
 * Owns the recurring competitor price sweep.
 *
 * Design notes:
 * - The cron expression comes from configuration, so the schedule is changed
 *   with an env var and a restart — not a code change. The job is therefore
 *   registered dynamically through `SchedulerRegistry` instead of the static
 *   `@Cron()` decorator, which only accepts a compile-time constant.
 * - `isRunning` prevents overlapping sweeps: with a slow retailer a sweep can
 *   outlive its interval, and two concurrent sweeps would double the request
 *   rate against the same hosts.
 * - Work is bounded per sweep and concurrency-limited, so a large catalog
 *   cannot exhaust the Supabase connection pool. Per-host politeness is handled
 *   one level down, in the HTTP fetcher.
 * - The unit of work is a *competitor listing*, not a product: a product with
 *   five rivals is five independent checks, and one broken retailer never hides
 *   the other four.
 */
@Injectable()
export class ScraperService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ScraperService.name);
  private readonly config: ScraperConfig;
  private isRunning = false;
  private shuttingDown = false;
  private currentSweep: Promise<ScrapeRunResultDto> | null = null;
  private lastRun: ScrapeRunResultDto | null = null;
  private lastRunAt: Date | null = null;

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    private readonly competitorsService: CompetitorsService,
    @Inject(PRICE_SOURCE)
    private readonly priceSource: PriceSource,
    private readonly schedulerRegistry: SchedulerRegistry,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('scraper', { infer: true });
  }

  onModuleInit(): void {
    this.logger.log(`Price source driver: ${this.priceSource.driver}`);

    if (!this.config.enabled) {
      this.logger.warn('Scheduled price sweep is disabled (SCRAPER_ENABLED=false).');
      return;
    }

    const job = new CronJob(this.config.cron, () => {
      void this.runSweep('schedule');
    });

    this.schedulerRegistry.addCronJob(SCRAPER_CRON_JOB, job);
    job.start();

    this.logger.log(`Scheduled price sweep registered with cron "${this.config.cron}".`);
  }

  /**
   * Lets an in-flight sweep finish before the process exits, so a listing is
   * never left with a half-applied observation and the connection pool is not
   * torn down mid-transaction.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.shuttingDown = true;

    if (this.currentSweep) {
      this.logger.log(`${signal ?? 'Shutdown'} received — waiting for the in-flight sweep.`);
      await this.currentSweep.catch(() => undefined);
      this.logger.log('In-flight sweep finished.');
    }
  }

  /**
   * Runs one sweep over the listings that are due for a check.
   * Safe to call concurrently — overlapping invocations return immediately.
   */
  async runSweep(trigger: 'schedule' | 'manual'): Promise<ScrapeRunResultDto> {
    const startedAt = new Date();
    const runId = `sweep_${startedAt.toISOString()}`;

    if (this.shuttingDown) {
      this.logger.warn(`Refusing ${trigger} sweep ${runId}: application is shutting down.`);
      return this.emptyRun(runId, startedAt);
    }

    if (this.isRunning) {
      this.logger.warn(`Skipping ${trigger} sweep ${runId}: a sweep is already running.`);
      return this.emptyRun(runId, startedAt);
    }

    this.isRunning = true;
    this.currentSweep = this.executeSweep(runId, trigger, startedAt);

    try {
      return await this.currentSweep;
    } finally {
      this.isRunning = false;
      this.currentSweep = null;
    }
  }

  /**
   * Scrapes every active listing of one product and writes the result.
   *
   * Loads the product through the TypeORM repository, checks each of its
   * competitor listings, and lets `CompetitorsService` update `current_price`
   * and `last_updated` on the product row from the cheapest result.
   *
   * Never throws. A missing product, a 403, a 404, a timeout or a redesigned
   * page are all logged and recorded on the listing — the caller (a cron tick,
   * a manual trigger) must not be able to crash the application.
   */
  async scrapeProductPrice(productId: string): Promise<void> {
    const product = await this.productsRepository.findOne({ where: { id: productId } });

    if (!product) {
      this.logger.warn(`Scrape requested for unknown product ${productId} — nothing to do.`);
      return;
    }

    try {
      const results = await this.scrapeProductById(productId);

      if (results.length === 0) {
        this.logger.warn(`Product ${product.name} (${productId}) has no active listings.`);
        return;
      }

      const succeeded = results.filter((result) => result.error === null);
      const cheapest = succeeded.reduce<number | null>(
        (lowest, result) =>
          result.currentPrice !== null && (lowest === null || result.currentPrice < lowest)
            ? result.currentPrice
            : lowest,
        null,
      );

      this.logger.log(
        `Scraped ${product.name}: ${succeeded.length}/${results.length} listing(s) ok` +
          (cheapest !== null ? `, market price ${cheapest} ${product.currency}` : ''),
      );
    } catch (error) {
      // Defence in depth: checkCompetitor already swallows per-listing errors,
      // so reaching here means something unexpected (a database failure, a bug).
      this.logger.error(
        `Unexpected failure scraping product ${productId}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** Checks a single listing on demand, ignoring its check interval. */
  async scrapeCompetitorById(competitorId: string): Promise<PriceCheckResultDto> {
    const competitor = await this.competitorsService.findOneForSystem(competitorId);
    return this.checkCompetitor(competitor);
  }

  /** Checks every active listing of a product, ignoring check intervals. */
  async scrapeProductById(productId: string): Promise<PriceCheckResultDto[]> {
    const competitors = await this.competitorsService.findAllForProductForSystem(productId);
    const active = competitors.filter((competitor) => competitor.isActive);

    return this.mapWithConcurrency(active, this.config.concurrency, (competitor) =>
      this.checkCompetitor(competitor),
    );
  }

  async getStatus(): Promise<ScraperStatusDto> {
    return {
      enabled: this.config.enabled,
      driver: this.priceSource.driver,
      cron: this.config.cron,
      running: this.isRunning,
      batchSize: this.config.batchSize,
      concurrency: this.config.concurrency,
      respectRobots: this.config.respectRobots,
      dueNow: await this.competitorsService.countDueForScrape(),
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastRun: this.lastRun,
    };
  }

  private async executeSweep(
    runId: string,
    trigger: 'schedule' | 'manual',
    startedAt: Date,
  ): Promise<ScrapeRunResultDto> {
    const due = await this.competitorsService.findDueForScrape(this.config.batchSize);

    if (due.length === 0) {
      this.logger.log(`Sweep ${runId} (${trigger}): no listings due.`);
      return this.finish(this.emptyRun(runId, startedAt));
    }

    this.logger.log(`Sweep ${runId} (${trigger}): checking ${due.length} listing(s).`);

    const results = await this.mapWithConcurrency(due, this.config.concurrency, (competitor) =>
      this.checkCompetitor(competitor),
    );

    const summary: ScrapeRunResultDto = {
      runId,
      processed: results.length,
      succeeded: results.filter((result) => result.error === null).length,
      failed: results.filter((result) => result.error !== null).length,
      changed: results.filter((result) => result.priceChanged).length,
      significantChanges: results.filter((result) => result.significantChange).length,
      undercuts: results.filter((result) => result.undercutsTargetPrice).length,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      results,
    };

    this.logger.log(
      `Sweep ${runId} done in ${summary.durationMs}ms: ` +
        `${summary.succeeded} ok, ${summary.failed} failed, ${summary.changed} price change(s), ` +
        `${summary.undercuts} undercut(s).`,
    );

    return this.finish(summary);
  }

  /**
   * Fetches one competitor price and persists the outcome.
   * Never throws: a single broken listing must not abort the sweep.
   */
  private async checkCompetitor(competitor: Competitor): Promise<PriceCheckResultDto> {
    try {
      const observation = await this.priceSource.fetch({
        url: competitor.url,
        host: competitor.host,
        selector: competitor.priceSelector,
        attribute: competitor.priceAttribute,
        lastPrice: competitor.currentPrice,
        currency: competitor.currency,
      });

      return await this.competitorsService.applyPriceObservation(competitor.id, {
        price: observation.price,
        currency: observation.currency,
        inStock: observation.inStock,
        strategy: observation.strategy,
        source: observation.source,
        sellerName: observation.sellerName,
        location: observation.location,
        imageUrl: observation.imageUrl,
        attributes: observation.attributes,
      });
    } catch (error) {
      const reason =
        error instanceof PriceFetchError
          ? `${error.message} (${error.url})`
          : error instanceof Error
            ? error.message
            : 'Unknown scrape error';

      this.logger.warn(
        `Scrape failed for listing ${competitor.id} (${competitor.name}): ${reason}`,
      );

      try {
        return await this.competitorsService.markScrapeFailure(competitor.id, reason);
      } catch (writeError) {
        // The last unguarded line in the whole sweep, and it took the process
        // down: recording the failure can itself fail — a lost connection, a
        // constraint — and the rejection escaped the worker pool, past
        // Promise.all, into an unhandled rejection that killed the API for
        // every customer because one listing could not be written.
        //
        // A background job may lose a result. It may not lose the server.
        this.logger.error(
          `Could not record the failure for listing ${competitor.id}: ${
            writeError instanceof Error ? writeError.message : String(writeError)
          }`,
        );

        return {
          productId: competitor.productId,
          productName: competitor.name,
          competitorId: competitor.id,
          competitorName: competitor.name,
          status: ScrapeStatus.Failed,
          previousPrice: competitor.currentPrice,
          currentPrice: competitor.currentPrice,
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
    }
  }

  /**
   * Runs `worker` over `items` with at most `limit` in flight, preserving input
   * order in the results. A fixed pool of workers pulling from a shared cursor
   * keeps memory flat regardless of catalog size.
   */
  private async mapWithConcurrency<TItem, TResult>(
    items: TItem[],
    limit: number,
    worker: (item: TItem) => Promise<TResult>,
  ): Promise<TResult[]> {
    const results = new Array<TResult>(items.length);
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]);
      }
    };

    const poolSize = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: poolSize }, () => runWorker()));

    return results;
  }

  private finish(summary: ScrapeRunResultDto): ScrapeRunResultDto {
    this.lastRun = summary;
    this.lastRunAt = new Date();
    return summary;
  }

  private emptyRun(runId: string, startedAt: Date): ScrapeRunResultDto {
    return {
      runId,
      processed: 0,
      succeeded: 0,
      failed: 0,
      changed: 0,
      significantChanges: 0,
      undercuts: 0,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      results: [],
    };
  }
}
