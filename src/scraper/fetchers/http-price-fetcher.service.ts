import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';

import { Configuration, ScraperConfig } from '../../config/configuration';
import { decodeHtml } from '../http/html-decoder';
import { HostRateLimiterService } from '../http/host-rate-limiter.service';
import { RobotsService } from '../http/robots.service';
import { PriceParserService } from '../parsers/price-parser.service';
import { profileForHost } from '../parsers/site-profiles';
import {
  FetchTarget,
  PriceFetchError,
  PriceObservation,
  PriceSource,
  RobotsDisallowedError,
} from './price-source.interface';

/** Status codes worth retrying: transient server trouble or explicit throttling. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Response bodies larger than this are not a product page. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Browser-like request headers.
 *
 * Many storefronts reject the default client user-agent outright with a 403.
 * Presenting a normal browser fingerprint is what makes the request work at
 * all; `SCRAPER_USER_AGENT` overrides the UA line for operators who prefer to
 * identify the crawler honestly (which is also what robots.txt matching uses).
 */
const BROWSER_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'bg-BG,bg;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Fetches real competitor pages with axios and extracts the price with cheerio.
 *
 * Production behaviour:
 * - `robots.txt` is honoured, and its `Crawl-delay` raises the per-host gap.
 * - Requests to one host are serialised with a minimum gap; different hosts
 *   proceed in parallel.
 * - A hard timeout (`SCRAPER_TIMEOUT_MS`, default 5s) means a slow retailer can
 *   never hang the sweep.
 * - 429 and 5xx are retried with exponential backoff and honour `Retry-After`.
 * - 403/404 and unparsable pages are *not* retried — they need a human, not
 *   more requests.
 * - Nothing here ever throws past the caller: {@link ScraperService} converts
 *   every failure into a stored `failed` state.
 */
@Injectable()
export class HttpPriceFetcherService implements PriceSource {
  readonly driver = 'http';

  private readonly logger = new Logger(HttpPriceFetcherService.name);
  private readonly config: ScraperConfig;
  private readonly client: AxiosInstance;

  constructor(
    private readonly parser: PriceParserService,
    private readonly robots: RobotsService,
    private readonly rateLimiter: HostRateLimiterService,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('scraper', { infer: true });

    this.client = axios.create({
      timeout: this.config.timeoutMs,
      maxRedirects: 5,
      // Never throw on status: the code below decides what is retryable.
      validateStatus: () => true,
      maxContentLength: MAX_BODY_BYTES,
      maxBodyLength: MAX_BODY_BYTES,
      decompress: true,
      // Bytes, not text: axios would decode as UTF-8 and quietly mangle the
      // windows-1251 pages that much of the Bulgarian market still serves.
      responseType: 'arraybuffer',
      headers: { ...BROWSER_HEADERS, 'User-Agent': this.config.userAgent },
    });
  }

  async fetch(target: FetchTarget): Promise<PriceObservation> {
    if (this.config.respectRobots) {
      const allowed = await this.robots.isAllowed(target.url, this.config.userAgent);
      if (!allowed) {
        throw new RobotsDisallowedError(target.url);
      }
    }

    const politeGap = await this.politeGapFor(target.url);

    return this.rateLimiter.schedule(target.host, politeGap, () => this.fetchAndParse(target));
  }

  private async fetchAndParse(target: FetchTarget): Promise<PriceObservation> {
    const startedAt = Date.now();
    const html = await this.fetchWithRetries(target.url);

    const profile = profileForHost(target.host);
    const parsed = this.parser.parse(html, {
      // Per-listing configuration always wins over the retailer profile.
      selector: target.selector,
      attribute: target.attribute,
      profile,
    });

    if (!parsed) {
      // Not retryable: the page loaded, we just could not read it. Retrying
      // burns requests — the listing needs a `priceSelector` instead.
      const looksLikeListing = new URL(target.url).pathname.replace(/\/+$/, '') === '';

      throw new PriceFetchError(
        looksLikeListing
          ? `This is a home or category page, not a product page — several different prices are on it and none of them is "the" price. Use the URL of the individual product.`
          : `Page fetched (${html.length} bytes) but no single price could be extracted. Set priceSelector on this competitor, or add a site profile for ${target.host}.`,
        target.url,
        false,
      );
    }

    const details = this.parser.parseDetails(html, profile, target.url);
    const durationMs = Date.now() - startedAt;

    this.logger.log(
      `${target.host} -> ${parsed.price} ${parsed.currency ?? target.currency} via ${parsed.strategy} in ${durationMs}ms`,
    );

    return {
      price: parsed.price,
      currency: parsed.currency,
      inStock: parsed.inStock,
      strategy: parsed.strategy,
      source: target.host,
      durationMs,
      title: details.title,
      sellerName: details.sellerName,
      location: details.location,
      imageUrl: details.imageUrl,
      attributes: Object.keys(details.attributes).length > 0 ? details.attributes : null,
    };
  }

  private async fetchWithRetries(url: string): Promise<string> {
    let lastError: PriceFetchError | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        // Exponential backoff with jitter, so simultaneous retries against one
        // host do not line up into a second thundering herd.
        const backoff = this.config.retryBaseDelayMs * 2 ** (attempt - 1);
        await this.sleep(backoff + Math.random() * 250);
      }

      try {
        return await this.fetchOnce(url);
      } catch (error) {
        lastError = error instanceof PriceFetchError ? error : this.wrap(error, url);

        if (!lastError.retryable) throw lastError;

        this.logger.debug(
          `Attempt ${attempt + 1}/${this.config.maxRetries + 1} failed for ${url}: ${lastError.message}`,
        );
      }
    }

    throw lastError ?? new PriceFetchError('Unknown fetch failure', url);
  }

  private async fetchOnce(url: string): Promise<string> {
    let response: AxiosResponse<Buffer>;

    try {
      response = await this.client.get<Buffer>(url, {
        headers: { Referer: new URL(url).origin },
      });
    } catch (error) {
      throw this.wrap(error, url);
    }

    if (response.status >= 400) {
      const retryable = RETRYABLE_STATUS.has(response.status);
      const retryAfter = this.retryAfterMs(response);

      if (retryable && retryAfter !== null) {
        this.logger.debug(`${url} asked to retry after ${retryAfter}ms`);
        await this.sleep(Math.min(retryAfter, this.config.timeoutMs));
      }

      throw new PriceFetchError(
        `HTTP ${response.status}${response.status === 403 ? ' (blocked — the site refused the request)' : ''}`,
        url,
        retryable,
      );
    }

    const contentType = String(response.headers['content-type'] ?? '');
    if (contentType && !/html|xml|text/i.test(contentType)) {
      throw new PriceFetchError(`Unexpected content-type "${contentType}"`, url, false);
    }

    const body = Buffer.from(response.data);
    if (body.length === 0) {
      throw new PriceFetchError('Empty response body', url, true);
    }
    if (body.length > MAX_BODY_BYTES) {
      throw new PriceFetchError(`Response too large (${body.length} bytes)`, url, false);
    }

    return decodeHtml(body, String(response.headers['content-type'] ?? ''));
  }

  /** Honour `Retry-After`, which may be seconds or an HTTP date. */
  private retryAfterMs(response: AxiosResponse): number | null {
    const header = response.headers['retry-after'] as string | undefined;
    if (!header) return null;

    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
  }

  private async politeGapFor(url: string): Promise<number> {
    const configured = this.config.minDelayMs;
    if (!this.config.respectRobots) return configured;

    const requested = await this.robots.crawlDelayMs(url, this.config.userAgent);
    // The host's own request wins when it asks for more than our default.
    return requested === null ? configured : Math.max(configured, requested);
  }

  private wrap(error: unknown, url: string): PriceFetchError {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
        return new PriceFetchError(`Timed out after ${this.config.timeoutMs}ms`, url, true);
      }
      if (axiosError.code === 'ENOTFOUND' || axiosError.code === 'EAI_AGAIN') {
        return new PriceFetchError(`DNS lookup failed for ${url}`, url, false);
      }
      if (axiosError.code === 'ECONNREFUSED' || axiosError.code === 'ECONNRESET') {
        return new PriceFetchError(`Connection ${axiosError.code}`, url, true);
      }

      return new PriceFetchError(axiosError.message, url, true);
    }

    if (error instanceof Error) {
      return new PriceFetchError(error.message, url, true);
    }

    return new PriceFetchError('Unknown fetch failure', url, true);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
