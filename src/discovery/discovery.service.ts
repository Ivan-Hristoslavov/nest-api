import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';

import { Configuration, ScraperConfig } from '../config/configuration';
import { HostRateLimiterService } from '../scraper/http/host-rate-limiter.service';
import { decodeHtml } from '../scraper/http/html-decoder';
import { RobotsService } from '../scraper/http/robots.service';
import { PRICE_SOURCE, PriceSource } from '../scraper/fetchers/price-source.interface';
import { PriceParserService } from '../scraper/parsers/price-parser.service';
import { DiscoveredProductDto, ShopSearchResultDto } from './dto/discovery.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Shop } from '../shops/entities/shop.entity';
import { rank, RankableOffer, RankedHit } from './ranking';
import { ManualPricesService } from '../shops/manual-prices.service';
import { nameFromUrl, SitemapLookupService } from './sitemap-lookup.service';
import {
  SEARCH_PROVIDERS,
  SearchProvider,
  searchProviderFor,
  UNSEARCHABLE_SHOPS,
} from './search-providers';

/** Results beyond this per shop are noise for a price-comparison workflow. */
const MAX_RESULTS_PER_SHOP = 8;

/**
 * Pages read per question when answering from a sitemap.
 *
 * The hard limit that keeps this from becoming the catalogue crawl again. A
 * shop with 7553 pages and one with 80 both cost at most this many requests
 * per search, so the bill follows the questions asked rather than the size of
 * anybody's catalogue.
 */
const SITEMAP_PAGE_BUDGET = 8;

/**
 * Addresses that are never a product, however product-shaped they look.
 *
 * A results page is also a footer, and a shop configured with a generic link
 * selector reads both. homefinishing.bg came back offering "Политика за
 * бисквитки" at 1.99 € — the cookie policy, priced from whatever promo box sat
 * nearest the link in the DOM. The pattern is caught here rather than only in
 * the detector, because the detector's guess is not the only way a shop gets
 * configured: an operator can paste a selector by hand.
 */
const NON_PRODUCT_PATH =
  /\/(login|logout|register|account|profile|cart|checkout|wishlist|compare|contact|about|terms|privacy|policy|cookie|gdpr|delivery|shipping|payment|returns|warranty|faq|help|blog|news|career|jobs|sitemap|search|customer|order|newsletter|loyal|promo(tion)?s?)(\/|$|[-_.])|\/(politika|povaritelnost|poveritelnost|biskvitki|obshti-usloviya|dostavka|plashtane|za-nas|kontakt)/i;

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);
  private readonly config: ScraperConfig;
  private readonly client: AxiosInstance;

  constructor(
    @InjectRepository(Shop)
    private readonly shops: Repository<Shop>,
    private readonly parser: PriceParserService,
    private readonly robots: RobotsService,
    private readonly rateLimiter: HostRateLimiterService,
    private readonly sitemap: SitemapLookupService,
    private readonly manualPrices: ManualPricesService,
    @Inject(PRICE_SOURCE) private readonly priceSource: PriceSource,
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
   * The shops this search covers: **your supplier list, and nothing else.**
   *
   * The compiled-in retailers used to join every search on their own. That was
   * wrong in the way that matters — a buyer comparing their three negotiated
   * suppliers got eMAG's retail prices mixed into the ranking, from a shop
   * they have no account with and cannot buy from at those terms. An answer
   * that includes a shop you cannot order from is not an answer.
   *
   * {@link SEARCH_PROVIDERS} stays, in a different role: a shelf of verified
   * configurations. Add a shop whose host is on that shelf and it searches
   * correctly from the first second, with selectors already checked against
   * the live site — no detection step, no deploy. It just does not participate
   * until you have added it.
   *
   * Deactivating a shop (`isActive = false`) takes it out of the search while
   * keeping its discount and selectors, for the supplier you are between
   * contracts with.
   */
  private async allProviders(ownerId: string): Promise<SearchProvider[]> {
    const shops = await this.shops.find({
      where: { isActive: true, ownerId },
      order: { name: 'ASC' },
    });

    return shops
      .map((shop) => this.providerFor(shop))
      .filter((provider): provider is SearchProvider => provider !== null);
  }

  /**
   * How to search one shop: the operator's own configuration first, then a
   * verified shipped one for the same host, then nothing.
   *
   * A shop returning null here is not searchable, and {@link listProviders}
   * says so with a reason rather than leaving it silently absent.
   */
  private providerFor(shop: Shop): SearchProvider | null {
    const host = shop.host.replace(/^www\./, '');

    if (shop.searchUrlTemplate) {
      return {
        host,
        name: shop.name,
        searchUrl: (query: string) => shop.searchUrlTemplate!.replace('{q}', query),
        // Unset, the generic pattern accepts any same-host link with a path —
        // enough for most storefronts and refinable per shop afterwards.
        resultLinkSelector: shop.searchResultSelector ?? 'a[href]',
        productUrlPattern: new RegExp(
          `^https?://([a-z0-9-]+\\.)*${host.replace(/\./g, '\\.')}/[^?#]{6,}$`,
          'i',
        ),
        // The detector's own tile selector when there is one. Falling back
        // to the broad list is a last resort, and a poor one: `closest()`
        // stops at the *nearest* match, so a generic `[class*="item"]` can
        // settle on an inner wrapper that holds the link but not the price,
        // and the offer comes back priceless from a shop that displays its
        // prices perfectly well.
        tileSelector:
          shop.searchTileSelector ??
          'li, article, .product, .product-item, [class*="product"], [class*="card"], [class*="item"]',
        titleSelector: shop.searchTitleSelector ?? undefined,
        priceSelector: shop.searchPriceSelector ?? '.price, [itemprop="price"]',
      };
    }

    // A shipped configuration for this host, verified against the live site.
    // The shop's own name wins over the shipped label: the operator called it
    // what they call it.
    const shipped = searchProviderFor(host);
    return shipped ? { ...shipped, name: shop.name } : null;
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
  async listProviders(
    ownerId: string,
  ): Promise<Array<{ host: string; name: string; searchable: boolean; reason: string | null }>> {
    // Your shops, and only yours. Deactivated ones are listed as well, so
    // "why is this one not in my results" is answerable from the same screen
    // that turned it off.
    const shops = await this.shops.find({ where: { ownerId }, order: { name: 'ASC' } });

    // The same shop appears under different hostnames — the operator adds
    // `bg.elmarkstore.eu` while the shipped list knows `elmarkstore.eu` — so
    // the reason for a refusal is matched by suffix, not by string equality.
    const sameShop = (a: string, b: string): boolean =>
      a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

    const listed = await Promise.all(
      shops.map(async (shop) => {
        const host = shop.host.replace(/^www\./, '');
        const base = { host, name: shop.name };

        if (!shop.isActive) {
          return { ...base, searchable: false, reason: 'изключен от търсенето' };
        }

        const provider = this.providerFor(shop);

        if (!provider) {
          const known = UNSEARCHABLE_SHOPS.find((entry) => sameShop(entry.host, host));

          return {
            ...base,
            searchable: false,
            reason:
              shop.searchBlockedReason ??
              known?.reason ??
              'живото търсене не е настроено — добавете го от примерно търсене',
          };
        }

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

    return listed.sort(
      (a, b) => Number(b.searchable) - Number(a.searchable) || a.name.localeCompare(b.name),
    );
  }

  /**
   * Shops we ship a verified configuration for, that are not yet on your list.
   *
   * Offered as something to *add*, never searched on their own — a buyer
   * comparing three negotiated suppliers does not want a retailer they have no
   * account with quietly setting the benchmark.
   */
  async listAvailable(
    ownerId: string,
  ): Promise<Array<{ host: string; name: string; reason: string | null }>> {
    const shops = await this.shops.find({ where: { ownerId } });
    const mine = (host: string): boolean =>
      shops.some((shop) => {
        const own = shop.host.replace(/^www\./, '');
        return own === host || own.endsWith(`.${host}`) || host.endsWith(`.${own}`);
      });

    return SEARCH_PROVIDERS.filter((provider) => !mine(provider.host)).map((provider) => ({
      host: provider.host,
      name: provider.name,
      reason: null,
    }));
  }

  /**
   * Searches every configured shop in parallel and returns what each found.
   *
   * One shop failing never fails the search: a 403 from one retailer must not
   * hide the four that answered. Each shop reports its own outcome so the UI
   * can say which ones were searched and which refused.
   */
  async search(ownerId: string, query: string, hosts?: string[]): Promise<ShopSearchResultDto[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const shops = await this.shops.find({
      where: { isActive: true, ownerId },
      order: { name: 'ASC' },
    });
    const wanted = hosts?.length
      ? shops.filter((shop) => hosts.includes(shop.host.replace(/^www\./, '')))
      : shops;

    return Promise.all(wanted.map((shop) => this.searchShop(shop, trimmed)));
  }

  /**
   * One shop, by whichever route it permits.
   *
   * Its own search first — it is faster, it is what the shop built for this,
   * and it knows about synonyms no URL ever will. Where that is refused, the
   * sitemap answers instead: tmt-elkom.com publishes `Disallow: /search?` but
   * advertises a sitemap naming all 7553 of its pages, and "СВТ" appears in
   * 135 of those addresses. Reading eight of them beats telling the customer
   * their supplier stocks nothing.
   */
  private async searchShop(shop: Shop, query: string): Promise<ShopSearchResultDto> {
    // A supplier with no website is not searched at all — there is nothing to
    // fetch. What is known about them is what the buyer entered, and it counts
    // in the ranking just the same. Leaving them out would compare the subset
    // of suppliers that happen to be online and call the winner of that the
    // cheapest, which for a buyer whose best source is the warehouse down the
    // road is simply the wrong answer.
    if (!shop.hasWebsite || shop.searchMethod === 'manual') {
      return this.searchManual(shop, query);
    }

    const provider = this.providerFor(shop);

    if (provider) {
      const viaSearch = await this.searchOne(provider, query);

      // Only when the shop's own search was refused outright. A search that
      // ran and found nothing is an answer — falling back then would spend
      // eight requests to contradict the shop about its own stock.
      if (viaSearch.ok || !/robots/i.test(viaSearch.error ?? '')) return viaSearch;
    }

    return this.searchViaSitemap(shop, query);
  }

  /**
   * The whole product, in one call: ask every shop now, rank what comes back
   * by what this customer actually pays.
   *
   * This is the request the system exists to serve, and it is deliberately the
   * only expensive thing it does. One HTTP request per shop per question —
   * never per *article*. A supplier with eight thousand items costs the same
   * to answer for as one with eighty, which is what makes the economics work.
   *
   * Per-shop outcomes ride along with the ranking: "found at 4 of 6, eMAG
   * refused" is a different answer from "not stocked anywhere", and a table of
   * results alone cannot tell them apart.
   */
  async compare(
    ownerId: string,
    query: string,
    options: { hosts?: string[]; currency?: string; inStockOnly?: boolean; limit?: number } = {},
  ): Promise<{
    query: string;
    durationMs: number;
    shops: Array<{
      host: string;
      name: string;
      ok: boolean;
      error: string | null;
      durationMs: number;
      count: number;
      searchUrl: string;
    }>;
    hits: RankedHit[];
  }> {
    const startedAt = Date.now();
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      return { query: trimmed, durationMs: 0, shops: [], hits: [] };
    }

    const results = await this.search(ownerId, trimmed, options.hosts);

    // The discount lives on the shop row, and the search providers are keyed
    // by host — so the two are joined here rather than threaded through every
    // provider.
    const shops = await this.shops.find({ where: { ownerId } });
    const discountFor = (host: string): { id: string | null; percent: number } => {
      const match = shops.find((shop) => {
        const left = shop.host.replace(/^www\./, '').toLowerCase();
        const right = host.replace(/^www\./, '').toLowerCase();
        return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
      });

      return { id: match?.id ?? null, percent: match ? Number(match.discountPercent) : 0 };
    };

    const offers: RankableOffer[] = [];

    for (const result of results) {
      if (!result.ok) continue;
      const shop = discountFor(result.host);

      for (const product of result.products) {
        if (options.inStockOnly && product.price === null) continue;

        offers.push({
          title: product.title,
          url: product.url,
          price: product.price,
          currency: product.currency,
          host: product.host,
          shopName: product.shopName,
          shopId: shop.id,
          discountPercent: shop.percent,
          recordedAt: product.recordedAt ?? null,
        });
      }
    }

    const hits = rank(
      offers,
      (options.currency ?? 'EUR').toUpperCase(),
      options.limit ?? 60,
      trimmed,
    );

    // Remember how each shop behaved, so a storefront that quietly stopped
    // answering shows up in the supplier list instead of only in the logs.
    await Promise.all(
      results
        .filter((result) => discountFor(result.host).id !== null)
        .map((result) =>
          this.shops.update(
            { id: discountFor(result.host).id! },
            { lastSearchedAt: new Date(), lastError: result.ok ? null : result.error },
          ),
        ),
    ).catch(() => undefined);

    return {
      query: trimmed,
      durationMs: Date.now() - startedAt,
      shops: results.map((result) => ({
        host: result.host,
        name: result.name,
        ok: result.ok,
        error: result.error,
        durationMs: result.durationMs,
        count: result.products.length,
        searchUrl: result.searchUrl,
      })),
      hits,
    };
  }

  /**
   * Finds products by their address, then reads only those pages.
   *
   * Bounded on purpose and bounded hard. The sitemap read is one request an
   * hour; the page reads are capped at {@link SITEMAP_PAGE_BUDGET} per
   * question, whatever the shop's size. Asking this shop three different
   * things costs twenty-five requests, not seven thousand — the cost follows
   * the question, which is the whole reason the old catalogue crawl had to go.
   */
  private async searchViaSitemap(shop: Shop, query: string): Promise<ShopSearchResultDto> {
    const host = shop.host.replace(/^www\./, '');
    const startedAt = Date.now();

    try {
      const urls = await this.sitemap.find(host, query, SITEMAP_PAGE_BUDGET);

      if (urls.length === 0) {
        return {
          host,
          name: shop.name,
          searchUrl: '',
          ok: true,
          error: null,
          durationMs: Date.now() - startedAt,
          products: [],
        };
      }

      // Sequential, not parallel: these all go to one host, and the rate
      // limiter would serialise them anyway. Failures are per page — one dead
      // link must not lose the seven that answered.
      const products: DiscoveredProductDto[] = [];

      for (const url of urls) {
        try {
          const observation = await this.priceSource.fetch({
            url,
            host,
            selector: null,
            attribute: null,
            lastPrice: null,
            currency: shop.currency,
          });

          products.push({
            title: this.clean(observation.title ?? nameFromUrl(url)),
            url,
            price: observation.price,
            currency: observation.currency ?? shop.currency,
            host,
            shopName: shop.name,
          });
        } catch {
          // A page with no price is not a product page. Nothing to report per
          // page; the count that reaches the user is what was found.
        }
      }

      this.logger.log(
        `${host}: "${query}" via sitemap — ${products.length} of ${urls.length} pages priced ` +
          `in ${Date.now() - startedAt}ms`,
      );

      return {
        host,
        name: shop.name,
        searchUrl: '',
        ok: true,
        error: null,
        durationMs: Date.now() - startedAt,
        products,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'непозната грешка';

      return {
        host,
        name: shop.name,
        searchUrl: '',
        ok: false,
        error: reason,
        durationMs: Date.now() - startedAt,
        products: [],
      };
    }
  }

  /** What the buyer recorded for a supplier that publishes nothing. */
  private async searchManual(shop: Shop, query: string): Promise<ShopSearchResultDto> {
    const host = shop.host.replace(/^www\./, '');
    const startedAt = Date.now();

    const rows = await this.manualPrices.search(shop.id, query, MAX_RESULTS_PER_SHOP);

    return {
      host,
      name: shop.name,
      searchUrl: '',
      ok: true,
      error: null,
      durationMs: Date.now() - startedAt,
      products: rows.map((row) => ({
        title: row.unit ? `${row.name} (${row.unit})` : row.name,
        // No page to open. The buyer knows where this supplier is; that is
        // rather the point of them.
        url: '',
        price: row.price,
        currency: row.currency,
        host,
        shopName: shop.name,
        // Carried through so the ranking can say how old the figure is.
        recordedAt: row.updatedAt.toISOString(),
      })),
    };
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
      if (NON_PRODUCT_PATH.test(absolute)) return;
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
