import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { Repository } from 'typeorm';

import { Configuration, ScraperConfig } from '../config/configuration';
import { PriceCheckResultDto } from '../products/dto/price-check-result.dto';
import { Product } from '../products/entities/product.entity';
import { ProductsService } from '../products/products.service';
import { ScrapeRunResultDto, ScraperStatusDto } from './dto/scrape-run-result.dto';
import { PriceFetchError, PriceFetcherService } from './price-fetcher.service';

export const SCRAPER_CRON_JOB = 'competitor-price-sweep';

/**
 * Owns the recurring competitor price sweep.
 *
 * Design notes:
 * - The cron expression comes from configuration, so the schedule is changed
 *   with an env var and a restart — not a code change. The job is therefore
 *   registered dynamically through `SchedulerRegistry` instead of the static
 *   `@Cron()` decorator, which can only take a compile-time constant.
 * - `isRunning` prevents overlapping sweeps: with a slow competitor site a
 *   sweep can outlive its interval, and two concurrent sweeps would double the
 *   request rate against the same hosts.
 * - Work is done in bounded batches with limited concurrency so a large catalog
 *   cannot exhaust the (pooled) Supabase connections or hammer a competitor.
 */
@Injectable()
export class ScraperService implements OnModuleInit {
  private readonly logger = new Logger(ScraperService.name);
  private readonly config: ScraperConfig;
  private isRunning = false;
  private lastRun: ScrapeRunResultDto | null = null;
  private lastRunAt: Date | null = null;

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    private readonly productsService: ProductsService,
    private readonly priceFetcher: PriceFetcherService,
    private readonly schedulerRegistry: SchedulerRegistry,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('scraper', { infer: true });
  }

  onModuleInit(): void {
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
   * Runs one sweep over the products that are due for a check.
   * Safe to call concurrently — overlapping invocations return immediately.
   *
   * @param trigger Where the run came from, for log correlation.
   */
  async runSweep(trigger: 'schedule' | 'manual'): Promise<ScrapeRunResultDto> {
    const startedAt = new Date();
    const runId = `sweep_${startedAt.toISOString()}`;

    if (this.isRunning) {
      this.logger.warn(`Skipping ${trigger} sweep ${runId}: a sweep is already running.`);
      return this.emptyRun(runId, startedAt);
    }

    this.isRunning = true;

    try {
      const due = await this.productsService.findDueForScrape(this.config.batchSize);

      if (due.length === 0) {
        this.logger.log(`Sweep ${runId} (${trigger}): no products due.`);
        return this.finish(this.emptyRun(runId, startedAt));
      }

      this.logger.log(`Sweep ${runId} (${trigger}): checking ${due.length} product(s).`);

      const results = await this.mapWithConcurrency(due, this.config.concurrency, (product) =>
        this.checkProduct(product),
      );

      const summary: ScrapeRunResultDto = {
        runId,
        processed: results.length,
        succeeded: results.filter((result) => result.error === null).length,
        failed: results.filter((result) => result.error !== null).length,
        changed: results.filter((result) => result.priceChanged).length,
        significantChanges: results.filter((result) => result.significantChange).length,
        durationMs: Date.now() - startedAt.getTime(),
        startedAt: startedAt.toISOString(),
        results,
      };

      this.logger.log(
        `Sweep ${runId} done in ${summary.durationMs}ms: ` +
          `${summary.succeeded} ok, ${summary.failed} failed, ${summary.changed} price change(s).`,
      );

      return this.finish(summary);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Checks a single product on demand, ignoring its check interval.
   * Loads the entity through the TypeORM repository directly so the caller only
   * needs an id.
   */
  async scrapeProductById(productId: string): Promise<PriceCheckResultDto> {
    const product = await this.productsService.findOne(productId);
    return this.checkProduct(product);
  }

  getStatus(): Promise<ScraperStatusDto> {
    return this.buildStatus();
  }

  /**
   * Fetches one competitor price and persists the outcome.
   * Never throws: a single broken product must not abort the sweep.
   */
  private async checkProduct(product: Product): Promise<PriceCheckResultDto> {
    try {
      const fetched = await this.priceFetcher.fetch(
        product.competitorUrl,
        product.currentPrice,
        product.currency,
      );

      return await this.productsService.applyPriceObservation(
        product.id,
        fetched.price,
        fetched.source,
      );
    } catch (error) {
      const reason =
        error instanceof PriceFetchError
          ? `${error.message} (${error.url})`
          : error instanceof Error
            ? error.message
            : 'Unknown scrape error';

      this.logger.warn(`Scrape failed for product ${product.id} (${product.name}): ${reason}`);
      return this.productsService.markScrapeFailure(product.id, reason);
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

  private async buildStatus(): Promise<ScraperStatusDto> {
    // Direct repository use: cheap count of products whose interval has elapsed.
    const dueNow = await this.productsRepository
      .createQueryBuilder('product')
      .where('product.isActive = true')
      .andWhere(
        "(product.last_checked_at IS NULL OR product.last_checked_at < NOW() - (product.check_interval_minutes * INTERVAL '1 minute'))",
      )
      .getCount();

    return {
      enabled: this.config.enabled,
      cron: this.config.cron,
      running: this.isRunning,
      batchSize: this.config.batchSize,
      concurrency: this.config.concurrency,
      dueNow,
      lastRunAt: this.lastRunAt?.toISOString() ?? null,
      lastRun: this.lastRun,
    };
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
      durationMs: Date.now() - startedAt.getTime(),
      startedAt: startedAt.toISOString(),
      results: [],
    };
  }
}
