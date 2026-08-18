import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';

import { Configuration, ScraperConfig } from '../config/configuration';
import { HostRateLimiterService } from '../scraper/http/host-rate-limiter.service';
import { decodeHtml } from '../scraper/http/html-decoder';
import { RobotsService } from '../scraper/http/robots.service';
import { PriceParserService } from '../scraper/parsers/price-parser.service';
import { DiscoveredProductDto, ShopSearchResultDto } from './dto/discovery.dto';
import { SEARCH_PROVIDERS, SearchProvider } from './search-providers';

/** Results beyond this per shop are noise for a price-comparison workflow. */
const MAX_RESULTS_PER_SHOP = 8;

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);
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
      // Search pages are heavier than product pages and a slow one must not
      // hold up the shops that answered quickly.
      timeout: Math.max(this.config.timeoutMs, 8000),
      maxRedirects: 5,
      validateStatus: () => true,
      decompress: true,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': this.config.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'bg-BG,bg;q=0.9,en;q=0.8',
      },
    });
  }

  /**
   * Shops this instance knows how to search, and whether each one currently
   * permits it.
   *
   * A shop can be perfectly scrapeable and still forbid searching: vario.bg
   * allows `/` but disallows `/search.php`, so its product pages can be tracked
   * while its search is off-limits. Reporting that here — rather than at the
   * end of a search that was never going to work — lets the picker grey the
   * shop out instead of offering it and then refusing.
   *
   * Robots files are cached by {@link RobotsService}, so this stays cheap.
   */
  async listProviders(): Promise<
    Array<{ host: string; name: string; searchable: boolean; reason: string | null }>
  > {
    return Promise.all(
      SEARCH_PROVIDERS.map(async (provider) => {
        const base = { host: provider.host, name: provider.name };

        if (!this.config.respectRobots) {
          return { ...base, searchable: true, reason: null };
        }

        try {
          const allowed = await this.robots.isAllowed(
            provider.searchUrl('test'),
            this.config.userAgent,
          );

          return {
            ...base,
            searchable: allowed,
            reason: allowed ? null : 'robots.txt на магазина забранява търсене',
          };
        } catch {
          // A robots file we cannot read is not a refusal; let the search try
          // and report its own outcome.
          return { ...base, searchable: true, reason: null };
        }
      }),
    );
  }

  /**
   * Searches every configured shop in parallel and returns what each found.
   *
   * One shop failing never fails the search: a 403 from one retailer must not
   * hide the four that answered. Each shop reports its own outcome so the UI
   * can say which ones were searched and which refused.
   */
  async search(query: string, hosts?: string[]): Promise<ShopSearchResultDto[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const providers = hosts?.length
      ? SEARCH_PROVIDERS.filter((provider) => hosts.includes(provider.host))
      : SEARCH_PROVIDERS;

    return Promise.all(providers.map((provider) => this.searchOne(provider, trimmed)));
  }

  private async searchOne(provider: SearchProvider, query: string): Promise<ShopSearchResultDto> {
    const url = provider.searchUrl(encodeURIComponent(query));
    const startedAt = Date.now();

    try {
      if (this.config.respectRobots) {
        const allowed = await this.robots.isAllowed(url, this.config.userAgent);
        if (!allowed) {
          return this.failure(provider, 'robots.txt забранява търсенето в този магазин', startedAt);
        }
      }

      const html = await this.rateLimiter.schedule(
        provider.host,
        this.config.minDelayMs,
        async () => {
          const response = await this.client.get<Buffer>(url);

          if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}`);
          }

          return decodeHtml(
            Buffer.from(response.data),
            String(response.headers['content-type'] ?? ''),
          );
        },
      );

      const products = this.extract(html, provider);

      this.logger.log(
        `"${query}" на ${provider.host}: ${products.length} резултата за ${Date.now() - startedAt}ms`,
      );

      return {
        host: provider.host,
        name: provider.name,
        searchUrl: url,
        ok: true,
        error: null,
        durationMs: Date.now() - startedAt,
        products,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'непозната грешка';
      this.logger.warn(`Търсенето в ${provider.host} се провали: ${reason}`);
      return this.failure(provider, reason, startedAt, url);
    }
  }

  /**
   * Pulls product tiles out of a search results page.
   *
   * Anchors are the anchor point rather than the tile container: every shop
   * marks its links up differently, but a link to a product page always matches
   * that shop's product URL shape. The tile is then found by climbing up from
   * the link, which survives most redesigns.
   */
  private extract(html: string, provider: SearchProvider): DiscoveredProductDto[] {
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const products: DiscoveredProductDto[] = [];

    $(provider.resultLinkSelector).each((_, element) => {
      if (products.length >= MAX_RESULTS_PER_SHOP) return false;

      const anchor = $(element);
      const href = anchor.attr('href');
      if (!href) return;

      const absolute = this.absolute(href, provider.host);
      if (!absolute || !provider.productUrlPattern.test(absolute)) return;
      if (seen.has(absolute)) return;
      seen.add(absolute);

      const tile = provider.tileSelector ? anchor.closest(provider.tileSelector) : anchor.parent();
      const scope = tile.length > 0 ? tile : anchor;

      const title =
        (provider.titleSelector ? scope.find(provider.titleSelector).first().text() : '') ||
        anchor.attr('title') ||
        anchor.text();

      const priceText = provider.priceSelector
        ? scope.find(provider.priceSelector).first().text()
        : '';

      products.push({
        title: this.clean(title) || absolute,
        url: absolute,
        price: priceText ? this.parser.parseAmount(priceText) : null,
        currency: priceText ? this.parser.detectCurrency(priceText) : null,
        host: provider.host,
        shopName: provider.name,
      });

      return;
    });

    return products;
  }

  private absolute(href: string, host: string): string | null {
    try {
      return new URL(href, `https://www.${host}`).toString().replace(/\/+$/, '/');
    } catch {
      return null;
    }
  }

  private clean(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, 255);
  }

  private failure(
    provider: SearchProvider,
    reason: string,
    startedAt: number,
    url?: string,
  ): ShopSearchResultDto {
    return {
      host: provider.host,
      name: provider.name,
      searchUrl: url ?? '',
      ok: false,
      error: reason,
      durationMs: Date.now() - startedAt,
      products: [],
    };
  }
}
