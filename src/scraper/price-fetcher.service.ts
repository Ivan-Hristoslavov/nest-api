import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Configuration } from '../config/configuration';

export interface FetchedPrice {
  /** Price parsed from the competitor page. */
  price: number;
  /** ISO-4217 code detected on the page. */
  currency: string;
  /** Host the price came from — stored as the price-history `source`. */
  source: string;
  /** Wall-clock duration of the fetch, in milliseconds. */
  durationMs: number;
}

/** Raised when a competitor page cannot be fetched or parsed. */
export class PriceFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'PriceFetchError';
  }
}

/**
 * Simulated competitor price source.
 *
 * This is the single seam where a real implementation plugs in: swap the body
 * of {@link fetch} for an HTTP request plus a per-retailer parser (or a call to
 * a scraping provider). Everything around it — scheduling, concurrency,
 * persistence, history, alerting — is already production behaviour and needs no
 * change.
 *
 * The simulation is a bounded random walk around the last known price, so the
 * generated history looks like real market movement rather than noise.
 */
@Injectable()
export class PriceFetcherService {
  private readonly logger = new Logger(PriceFetcherService.name);
  private readonly timeoutMs: number;
  private readonly minDelayMs: number;

  /** Probability that a simulated fetch fails, mirroring real-world flakiness. */
  private static readonly FAILURE_RATE = 0.05;
  /** Maximum simulated move per check, as a fraction of the current price. */
  private static readonly MAX_DRIFT = 0.08;
  /** Price used when a product has never been scraped and carries no price. */
  private static readonly SEED_PRICE_RANGE = { min: 19.99, max: 499.99 };

  constructor(configService: ConfigService<Configuration, true>) {
    const scraper = configService.get('scraper', { infer: true });
    this.timeoutMs = scraper.timeoutMs;
    this.minDelayMs = scraper.minDelayMs;
  }

  /**
   * Returns the competitor price for `url`.
   *
   * @param url        Competitor product page.
   * @param lastPrice  Last known price; anchors the simulated walk.
   * @param currency   Currency expected on the page.
   * @throws PriceFetchError when the (simulated) fetch fails or times out.
   */
  async fetch(url: string, lastPrice: number | null, currency: string): Promise<FetchedPrice> {
    const startedAt = Date.now();

    // Simulated network latency, bounded by the configured timeout.
    const latency = this.minDelayMs + Math.floor(Math.random() * 250);
    await this.sleep(Math.min(latency, this.timeoutMs));

    if (latency > this.timeoutMs) {
      throw new PriceFetchError(`Timed out after ${this.timeoutMs}ms`, url);
    }

    if (Math.random() < PriceFetcherService.FAILURE_RATE) {
      throw new PriceFetchError('Competitor page returned HTTP 503 (simulated)', url);
    }

    const price = this.nextPrice(lastPrice);
    const durationMs = Date.now() - startedAt;

    this.logger.debug(`Fetched ${price} ${currency} from ${url} in ${durationMs}ms`);

    return { price, currency, source: this.hostOf(url), durationMs };
  }

  private nextPrice(lastPrice: number | null): number {
    if (lastPrice === null || lastPrice <= 0) {
      const { min, max } = PriceFetcherService.SEED_PRICE_RANGE;
      return this.round(min + Math.random() * (max - min));
    }

    // Symmetric drift in [-MAX_DRIFT, +MAX_DRIFT].
    const drift = (Math.random() * 2 - 1) * PriceFetcherService.MAX_DRIFT;
    // Never return a non-positive price, however unlucky the draw.
    return this.round(Math.max(0.01, lastPrice * (1 + drift)));
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return 'unknown';
    }
  }

  private round(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
