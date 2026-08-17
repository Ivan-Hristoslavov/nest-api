import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Configuration } from '../../config/configuration';
import {
  FetchTarget,
  PriceFetchError,
  PriceObservation,
  PriceSource,
} from './price-source.interface';

/**
 * Generates plausible price movement without touching the network.
 *
 * Kept alongside the HTTP driver rather than deleted: it makes the demo,
 * the e2e suite and local development independent of real retailers being
 * reachable, in a stable mood, and legally scrapeable. Select it with
 * `SCRAPER_DRIVER=simulation`.
 *
 * The walk is bounded and anchored on the last known price, so generated
 * history looks like a market rather than noise.
 */
@Injectable()
export class SimulatedPriceFetcherService implements PriceSource {
  readonly driver = 'simulation';

  private readonly logger = new Logger(SimulatedPriceFetcherService.name);
  private readonly timeoutMs: number;
  private readonly minDelayMs: number;

  /** Probability that a simulated fetch fails, mirroring real-world flakiness. */
  private static readonly FAILURE_RATE = 0.05;
  /** Maximum simulated move per check, as a fraction of the current price. */
  private static readonly MAX_DRIFT = 0.08;
  /** Price used when a listing has never been scraped and carries no price. */
  private static readonly SEED_PRICE_RANGE = { min: 19.99, max: 499.99 };

  constructor(configService: ConfigService<Configuration, true>) {
    const scraper = configService.get('scraper', { infer: true });
    this.timeoutMs = scraper.timeoutMs;
    this.minDelayMs = scraper.minDelayMs;
  }

  async fetch(target: FetchTarget): Promise<PriceObservation> {
    const startedAt = Date.now();

    const latency = this.minDelayMs + Math.floor(Math.random() * 250);
    await this.sleep(Math.min(latency, this.timeoutMs));

    if (latency > this.timeoutMs) {
      throw new PriceFetchError(`Timed out after ${this.timeoutMs}ms`, target.url);
    }

    if (Math.random() < SimulatedPriceFetcherService.FAILURE_RATE) {
      throw new PriceFetchError('Competitor page returned HTTP 503 (simulated)', target.url);
    }

    const price = this.nextPrice(target.lastPrice);
    const durationMs = Date.now() - startedAt;

    this.logger.debug(`Simulated ${price} ${target.currency} for ${target.url} in ${durationMs}ms`);

    return {
      price,
      currency: target.currency,
      // Occasionally report the item as out of stock so alert paths get exercised.
      inStock: Math.random() > 0.03,
      strategy: 'simulation',
      source: target.host,
      durationMs,
    };
  }

  private nextPrice(lastPrice: number | null): number {
    if (lastPrice === null || lastPrice <= 0) {
      const { min, max } = SimulatedPriceFetcherService.SEED_PRICE_RANGE;
      return this.round(min + Math.random() * (max - min));
    }

    const drift = (Math.random() * 2 - 1) * SimulatedPriceFetcherService.MAX_DRIFT;
    return this.round(Math.max(0.01, lastPrice * (1 + drift)));
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
