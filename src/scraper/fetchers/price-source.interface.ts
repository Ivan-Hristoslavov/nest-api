/** Injection token for the active {@link PriceSource} implementation. */
export const PRICE_SOURCE = Symbol('PRICE_SOURCE');

/** Everything a fetcher needs to know about one competitor listing. */
export interface FetchTarget {
  url: string;
  host: string;
  /** CSS selector configured for this listing, if any. */
  selector?: string | null;
  /** Attribute to read instead of element text, if any. */
  attribute?: string | null;
  /** Last known price — used by the simulation driver to anchor its walk. */
  lastPrice: number | null;
  /** Currency expected for this listing. */
  currency: string;
}

export interface PriceObservation {
  price: number;
  /** Currency stated by the page, when it stated one. */
  currency: string | null;
  /** Availability stated by the page, when it stated one. */
  inStock: boolean | null;
  /** Which extraction strategy produced the price. */
  strategy: string;
  /** Host the observation came from. */
  source: string;
  durationMs: number;
  /** Seller, location, image and extra facts, when the page exposes them. */
  sellerName?: string | null;
  location?: string | null;
  imageUrl?: string | null;
  attributes?: Record<string, string> | null;
}

/**
 * A source of competitor prices.
 *
 * Two implementations ship: {@link import('./http-price-fetcher.service').HttpPriceFetcherService}
 * fetches and parses real pages, {@link import('./simulated-price-fetcher.service').SimulatedPriceFetcherService}
 * generates plausible movement for demos and tests. `SCRAPER_DRIVER` selects
 * between them, so the rest of the system never knows which is active.
 */
export interface PriceSource {
  readonly driver: string;
  fetch(target: FetchTarget): Promise<PriceObservation>;
}

/** Raised when a listing cannot be fetched or no price could be extracted. */
export class PriceFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    /** True when retrying later has a realistic chance of succeeding. */
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'PriceFetchError';
  }
}

/** Raised when robots.txt forbids fetching the listing. Never retried. */
export class RobotsDisallowedError extends PriceFetchError {
  constructor(url: string) {
    super(`robots.txt disallows fetching this URL`, url, false);
    this.name = 'RobotsDisallowedError';
  }
}
