import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Configuration, HistoryConfig } from '../config/configuration';
import { PriceHistory } from './entities/price-history.entity';

/**
 * How many rows one pass may remove.
 *
 * Bounded because this runs against the same database serving customer
 * requests. A single unbounded DELETE over a table with tens of millions of
 * rows takes a lock long enough to be noticed, and the work is not urgent: it
 * only has to keep pace with what the sweep writes, which is a few rows per
 * listing per hour.
 */
const BATCH = 20_000;

/**
 * Keeping the price history from eating the database.
 *
 * `price_history` is append-only by design — it is the record that answers
 * "how did we get to this price", which is most of what the product sells.
 * It is also the one table with no natural ceiling: two thousand watched
 * articles across four suppliers, re-checked hourly, is around seventy million
 * rows a year for one customer.
 *
 * Nothing here deletes a trend. Inside the recent window every observation is
 * kept, because "it moved twice on Tuesday" is a question people actually ask.
 * Past that, one reading per listing per day draws the same line to the same
 * accuracy at a thirtieth of the size. Past the outer window it goes, because
 * a price from two years ago is not evidence about anything anybody is buying.
 */
@Injectable()
export class HistoryRetentionService {
  private readonly logger = new Logger(HistoryRetentionService.name);
  private readonly config: HistoryConfig;

  constructor(
    @InjectRepository(PriceHistory) private readonly history: Repository<PriceHistory>,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('history', { infer: true });
  }

  /**
   * Runs in the small hours, when a lock costs least.
   *
   * Daily rather than hourly: the table grows by hours' worth of rows and this
   * removes days' worth, so it stays comfortably ahead without competing with
   * the price sweep for connections.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweep(): Promise<{ thinned: number; expired: number }> {
    const expired = await this.dropExpired();
    const thinned = await this.thinOldReadings();

    if (expired || thinned) {
      this.logger.log(
        `Price history: thinned ${thinned} intra-day readings, dropped ${expired} beyond ${this.config.keepDays} days.`,
      );
    }

    return { thinned, expired };
  }

  /** Removes everything past the outer window outright. */
  private async dropExpired(): Promise<number> {
    const result: unknown = await this.history.query(
      `DELETE FROM price_history
       WHERE id IN (
         SELECT id FROM price_history
         WHERE recorded_at < now() - ($1 || ' days')::interval
         LIMIT $2
       )`,
      [this.config.keepDays, BATCH],
    );

    return rowsAffected(result);
  }

  /**
   * Keeps one reading per listing per day outside the recent window.
   *
   * The *first* of each day rather than the last, arbitrarily but
   * consistently — what matters is that repeated runs converge on the same
   * surviving row instead of thinning the table differently each night.
   *
   * `product_id` is in the partition alongside `competitor_id` because the
   * latter is null for hand-entered prices, and NULL does not group with NULL
   * the way a supplier id would: without the product, every manual reading
   * across every article would compete for the same daily slot.
   */
  private async thinOldReadings(): Promise<number> {
    const result: unknown = await this.history.query(
      `DELETE FROM price_history
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY product_id, competitor_id, date_trunc('day', recorded_at)
             ORDER BY recorded_at
           ) AS rank_in_day
           FROM price_history
           WHERE recorded_at < now() - ($1 || ' days')::interval
             AND recorded_at >= now() - ($2 || ' days')::interval
         ) ranked
         WHERE rank_in_day > 1
         LIMIT $3
       )`,
      [this.config.fullDays, this.config.keepDays, BATCH],
    );

    return rowsAffected(result);
  }
}

/**
 * How many rows a raw DELETE removed.
 *
 * The pg driver reports this differently depending on the statement, and
 * TypeORM passes it through untouched: sometimes an array whose second element
 * carries the count, sometimes an object. Both shapes are handled rather than
 * guessed at, because guessing produces a log line that says zero for ever.
 */
function rowsAffected(result: unknown): number {
  if (Array.isArray(result) && typeof result[1] === 'number') return result[1];
  if (result && typeof result === 'object' && 'rowCount' in result) {
    const count = (result as { rowCount?: unknown }).rowCount;
    return typeof count === 'number' ? count : 0;
  }
  return 0;
}
