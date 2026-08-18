import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { Repository } from 'typeorm';

import { CatalogueConfig, Configuration } from '../config/configuration';
import { CatalogueService } from './catalogue.service';
import { Shop } from './entities/shop.entity';

const CATALOGUE_CRON_JOB = 'catalogue-crawl';

/**
 * Works through the catalogue backlog in the background.
 *
 * A supplier's catalogue is thousands of pages, and requests to one host are
 * serialised on purpose — so a full index is hours of work. Doing that through
 * a button means pressing it a hundred and eighty times; doing it in one HTTP
 * request means a request that outlives every timeout between here and the
 * client. Neither is a design, so it runs on a schedule instead: a batch every
 * few minutes, for as long as there is anything left to read.
 *
 * Shops are taken in turn rather than one being finished first, so adding a
 * second supplier does not sit behind the first one's remaining six thousand
 * pages.
 */
@Injectable()
export class CatalogueCrawlerService implements OnModuleInit {
  private readonly logger = new Logger(CatalogueCrawlerService.name);
  private readonly config: CatalogueConfig;
  private running = false;
  /** Round-robin cursor, so every shop gets a turn. */
  private cursor = 0;

  constructor(
    private readonly catalogue: CatalogueService,
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
    private readonly schedulerRegistry: SchedulerRegistry,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('catalogue', { infer: true });
  }

  onModuleInit(): void {
    if (!this.config.crawlEnabled) {
      this.logger.warn('Background catalogue crawl is disabled (CATALOGUE_CRAWL_ENABLED=false).');
      return;
    }

    const job = new CronJob(this.config.crawlCron, () => {
      void this.tick();
    });

    this.schedulerRegistry.addCronJob(CATALOGUE_CRON_JOB, job);
    job.start();

    this.logger.log(
      `Background catalogue crawl registered with cron "${this.config.crawlCron}", ` +
        `${this.config.crawlBatch} pages per run.`,
    );
  }

  /**
   * One batch for one shop.
   *
   * Guarded against overlap: a run can easily outlast the interval between
   * runs, and two crawls of the same shop would fight over the same queue and
   * double the load on the supplier.
   */
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Previous catalogue batch still running; skipping this tick.');
      return;
    }

    const candidates = await this.shops.find({ where: { isActive: true } });
    const withSitemap = candidates.filter((shop) => shop.sitemapUrl);

    if (withSitemap.length === 0) return;

    const shop = withSitemap[this.cursor % withSitemap.length];
    this.cursor += 1;

    this.running = true;

    try {
      const run = await this.catalogue.crawl(shop.id, this.config.crawlBatch);

      if (run.attempted > 0) {
        this.logger.log(
          `${run.host}: +${run.indexed} indexed, ${run.skipped} without a price, ` +
            `${run.failed} failed, ${run.remaining} pages left.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Catalogue crawl of ${shop.host} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
