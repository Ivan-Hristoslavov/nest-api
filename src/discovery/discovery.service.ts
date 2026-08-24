import { guardedAgents } from '../scraper/http/address-guard';
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
import { BasketLineDto, BasketResultDto, BasketSupplierDto } from './dto/basket.dto';
import { DEFAULT_THRESHOLDS } from '../matching/deterministic-matcher';
import { MatchResult, MatchRunSummary, MatchingService } from '../matching/matching.service';
import { rank, RankableOffer, RankedHit } from './ranking';
import { ManualPricesService } from '../shops/manual-prices.service';
import { SearchCache } from './entities/search-cache.entity';
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
/**
 * What a search reports about itself while it runs.
 *
 * A comparison takes seconds — a shop's own search engine is slow, a sitemap
 * read is slower — and a spinner for all of it looks identical to a hang. The
 * work is genuinely staged, so the stages are worth showing: what the query
 * was understood to mean (instant), which supplier answered and with how many
 * offers (as each returns), and what matching decided (last).
 *
 * Emitted rather than returned, so the interface can render each as it lands.
 */
export type SearchProgress =
  | { type: 'understood'; understood: MatchRunSummary['understood']; shops: number }
  | { type: 'shop'; host: string; name: string; ok: boolean; count: number; durationMs: number }
  | { type: 'matching'; candidates: number }
  | { type: 'ai'; model: string | null; comparisons: number }
  | { type: 'done' };

/** Below this, an offer is not treated as a quote for the line. */
const MATCH_FLOOR = DEFAULT_THRESHOLDS.floor;

const SITEMAP_PAGE_BUDGET = 8;

/**
 * How long a shop's answer is reused before it is asked again.
 *
 * Six hours is a judgement, not a law. Wholesale prices move on price-list
 * revisions and promotions, not minute to minute, so a morning answer is
 * generally still true by lunch — and the alternative, asking every time, makes
 * a forty-line basket take eleven minutes and the feature unusable. Every
 * cached row states when it was fetched and the interface shows it, so the
 * trade is visible rather than hidden.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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
    private readonly matching: MatchingService,
    @InjectRepository(SearchCache)
    private readonly cache: Repository<SearchCache>,
    @Inject(PRICE_SOURCE) private readonly priceSource: PriceSource,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('scraper', { infer: true });

    this.client = axios.create({
      // Search pages are heavier than product pages and a slow one must not
      // hold up the shops that answered quickly.
      timeout: Math.max(this.config.timeoutMs, 8000),
      maxRedirects: 5,
      // Every address here was typed by a customer. The agents refuse to
      // open a connection to this server's own network, and they do it per
      // connection — so each hop of a redirect is checked too.
      ...guardedAgents(),

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
  async search(
    ownerId: string,
    query: string,
    hosts?: string[],
    useCache = true,
    /** Called with each shop's answer as it lands, not after all of them. */
    onShop?: (result: ShopSearchResultDto) => void,
  ): Promise<ShopSearchResultDto[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const shops = await this.shops.find({
      where: { isActive: true, ownerId },
      order: { name: 'ASC' },
    });
    const wanted = hosts?.length
      ? shops.filter((shop) => hosts.includes(shop.host.replace(/^www\./, '')))
      : shops;

    return Promise.all(
      wanted.map(async (shop) => {
        const result = await this.searchShopCached(shop, trimmed, useCache);
        onShop?.(result);
        return result;
      }),
    );
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
  /**
   * One shop's answer, from cache when it is fresh enough.
   *
   * A hand-entered supplier is never cached: reading them is a database query,
   * so caching would add staleness and save nothing.
   */
  /**
   * Prices a whole order, and answers the question a buyer actually has.
   *
   * Not "what does this cable cost" but "where do I place this order". Those
   * have different answers: no single supplier is cheapest on everything, so
   * the useful output is three numbers — what the order costs from each
   * supplier alone, what it costs split across them line by line, and the
   * difference between the two. The last one is the reason to use this at all,
   * and it is not a number a spreadsheet of five price lists gives up easily.
   *
   * A supplier that cannot supply every line is still ranked, with the count of
   * what it covers: "cheapest, but missing three items" is a real answer, and
   * hiding it would recommend an order that cannot be placed.
   */
  async priceBasket(
    ownerId: string,
    lines: Array<{ query: string; quantity: number }>,
    options: { currency?: string; useCache?: boolean } = {},
  ): Promise<BasketResultDto> {
    const startedAt = Date.now();
    const target = (options.currency ?? 'EUR').toUpperCase();

    const shops = await this.shops.find({ where: { ownerId, isActive: true } });
    const discountOf = new Map(shops.map((shop) => [shop.id, Number(shop.discountPercent)]));
    const nameOf = new Map(shops.map((shop) => [shop.id, shop.name]));
    const byHost = new Map(shops.map((shop) => [shop.host.replace(/^www\./, ''), shop.id]));

    const pricedLines: BasketLineDto[] = [];

    // Lines run one after another rather than all at once. They mostly hit the
    // same few hosts, so firing forty in parallel would not be forty times
    // faster — the per-host limiter would queue them anyway — but it would look
    // like a burst to every supplier at once.
    for (const line of lines) {
      const results = await this.search(ownerId, line.query, undefined, options.useCache ?? true);

      const offers: RankableOffer[] = [];

      for (const result of results) {
        if (!result.ok) continue;
        const shopId = byHost.get(result.host) ?? null;

        for (const product of result.products) {
          offers.push({
            title: product.title,
            url: product.url,
            price: product.price,
            currency: product.currency,
            host: product.host,
            shopName: product.shopName,
            shopId,
            discountPercent: shopId ? (discountOf.get(shopId) ?? 0) : 0,
            recordedAt: product.recordedAt ?? null,
          });
        }
      }

      const ranked = rank(offers, target, 40, line.query);

      // One offer per supplier: their cheapest that is genuinely this article.
      //
      // The gate used to be whether the shop's name contained the words the
      // buyer typed. That is too crude in both directions: it counted a
      // chandelier as a quote for "лампа" — inflating one supplier's order to
      // 2298 € against 220 € elsewhere — and it dropped a German listing whose
      // specification matched perfectly but whose words did not, reporting a
      // supplier as unable to fill a line they stock.
      const candidates = ranked
        .map((hit, index) => ({ hit, index }))
        .filter((entry) => entry.hit.effectivePrice !== null && entry.hit.shopId);

      let run = await this.matching.match(
        ownerId,
        line.query,
        candidates.map((entry) => ({
          id: String(entry.index),
          name: entry.hit.name,
          supplier: entry.hit.shopName,
        })),
        // Deterministic only, on the first pass. A forty-line order asking a
        // model per line is forty calls for an answer the specifications
        // usually give away.
        { useAi: false },
      );

      const confident = (results: MatchRunSummary['results']): boolean =>
        results.some((result) => result.confidence >= MATCH_FLOOR);

      // The exception worth paying for: a line nobody appears to stock. Being
      // told "no supplier has this" when one does is the expensive mistake, so
      // that case — and only that case — gets a model.
      if (candidates.length > 0 && !confident(run.results)) {
        run = await this.matching.match(
          ownerId,
          line.query,
          candidates.map((entry) => ({
            id: String(entry.index),
            name: entry.hit.name,
            supplier: entry.hit.shopName,
          })),
          { useAi: true },
        );
      }

      const matchOf = new Map(run.results.map((result) => [result.id, result]));

      const perShop = new Map<string, RankedHit & { match?: MatchResult }>();
      for (const entry of candidates) {
        const match = matchOf.get(String(entry.index));
        if (!match || match.confidence < MATCH_FLOOR) continue;
        if (!perShop.has(entry.hit.shopId!)) {
          perShop.set(entry.hit.shopId!, { ...entry.hit, match });
        }
      }

      pricedLines.push({
        query: line.query,
        quantity: line.quantity,
        offers: [...perShop.values()],
        cheapest: [...perShop.values()][0] ?? null,
      });
    }

    // What the whole order costs from each supplier on their own.
    const perSupplier: BasketSupplierDto[] = shops
      .map((shop) => {
        let total = 0;
        let covered = 0;
        const missing: string[] = [];

        for (const line of pricedLines) {
          const offer = line.offers.find((candidate) => candidate.shopId === shop.id);

          if (offer && offer.effectivePrice !== null) {
            total += offer.effectivePrice * line.quantity;
            covered += 1;
          } else {
            missing.push(line.query);
          }
        }

        return {
          shopId: shop.id,
          name: shop.name,
          host: shop.host,
          linesCovered: covered,
          linesTotal: pricedLines.length,
          total: covered > 0 ? round(total) : null,
          missing,
        };
      })
      // Suppliers who can supply nothing on this order are noise.
      .filter((supplier) => supplier.linesCovered > 0)
      // Complete orders first, then by price. A supplier missing half the list
      // is not "cheapest" in any sense the buyer means.
      .sort(
        (a, b) => b.linesCovered - a.linesCovered || (a.total ?? Infinity) - (b.total ?? Infinity),
      );

    // What it costs taking every line from whoever is cheapest on it.
    let splitTotal = 0;
    let splitLines = 0;
    const splitAcross = new Set<string>();

    for (const line of pricedLines) {
      if (!line.cheapest || line.cheapest.effectivePrice === null) continue;
      splitTotal += line.cheapest.effectivePrice * line.quantity;
      splitLines += 1;
      if (line.cheapest.shopId) splitAcross.add(line.cheapest.shopId);
    }

    const bestSingle = perSupplier.find((supplier) => supplier.linesCovered === pricedLines.length);

    return {
      currency: target,
      durationMs: Date.now() - startedAt,
      lines: pricedLines,
      suppliers: perSupplier,
      split: {
        total: splitLines > 0 ? round(splitTotal) : null,
        linesPriced: splitLines,
        suppliers: [...splitAcross].map((id) => nameOf.get(id) ?? id),
      },
      // Only meaningful against a supplier who could have filled the whole
      // order; comparing a split against a partial single order is comparing
      // two different purchases.
      saving:
        bestSingle && bestSingle.total !== null && splitLines === pricedLines.length
          ? round(bestSingle.total - splitTotal)
          : null,
    };
  }

  private async searchShopCached(
    shop: Shop,
    query: string,
    useCache: boolean,
  ): Promise<ShopSearchResultDto> {
    if (!useCache || !shop.hasWebsite || shop.searchMethod === 'manual') {
      return this.searchShop(shop, query);
    }

    const normalised = normaliseQuery(query);
    const fresh = new Date(Date.now() - CACHE_TTL_MS);

    const cached = await this.cache.findOne({ where: { shopId: shop.id, query: normalised } });

    if (cached && cached.fetchedAt > fresh) {
      return {
        host: shop.host.replace(/^www\./, ''),
        name: shop.name,
        searchUrl: '',
        ok: true,
        error: null,
        durationMs: 0,
        products: cached.products.map((product) => ({
          ...product,
          // Stamped so the ranking can say how old this is — and marked as a
          // reused answer rather than one the buyer supplied, which are not
          // the same claim and were briefly labelled as though they were.
          recordedAt: cached.fetchedAt.toISOString(),
          priceSource: 'cached' as const,
        })),
      };
    }

    const result = await this.searchShop(shop, query);

    // Only successes are kept. Caching a refusal would hold the shop broken
    // for six hours after it recovered.
    if (result.ok) {
      await this.cache
        .upsert(
          {
            shopId: shop.id,
            query: normalised,
            products: result.products,
            durationMs: result.durationMs,
            fetchedAt: new Date(),
          },
          ['shopId', 'query'],
        )
        .catch((error: unknown) => {
          // A cache that cannot be written must not fail the search it was
          // meant to speed up.
          this.logger.warn(
            `Could not cache "${normalised}" for ${shop.host}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }

    return result;
  }

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
    options: {
      hosts?: string[];
      currency?: string;
      inStockOnly?: boolean;
      limit?: number;
      /** False forces a fresh read — for the buyer about to place the order. */
      useCache?: boolean;
      /** False compares on barcodes and specifications only, never a model. */
      useAi?: boolean;
      /** Called as each stage completes, for a streaming caller. */
      onProgress?: (event: SearchProgress) => void;
    } = {},
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
    hits: Array<RankedHit & { match?: MatchResult }>;
    matching?: Omit<MatchRunSummary, 'results'>;
  }> {
    const startedAt = Date.now();
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      return { query: trimmed, durationMs: 0, shops: [], hits: [] };
    }

    const progress = options.onProgress ?? (() => undefined);

    // First and instantly: what the words were taken to mean. This is pure
    // arithmetic over the query, so it costs nothing and it is the moment the
    // reader learns the machine understood "12W E27" as a specification rather
    // than as two more words to search for.
    const shopsForQuery = await this.shops.count({ where: { ownerId, isActive: true } });
    progress({
      type: 'understood',
      understood: this.matching.understand(trimmed),
      shops: shopsForQuery,
    });

    const results = await this.search(
      ownerId,
      trimmed,
      options.hosts,
      options.useCache ?? true,
      (result) =>
        progress({
          type: 'shop',
          host: result.host,
          name: result.name,
          ok: result.ok,
          count: result.products.length,
          durationMs: result.durationMs,
        }),
    );

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
          priceSource: product.priceSource ?? 'live',
        });
      }
    }

    const ranked = rank(
      offers,
      (options.currency ?? 'EUR').toUpperCase(),
      options.limit ?? 60,
      trimmed,
    );

    // Matching runs on what survived ranking, not on everything every shop
    // returned. Ranking has already thrown away the shop's wilder guesses, and
    // a model asked about those is a model paid to say "no".
    progress({ type: 'matching', candidates: ranked.length });

    const run = await this.matching.match(
      ownerId,
      trimmed,
      ranked.map((hit, index) => ({
        id: String(index),
        name: hit.name,
        supplier: hit.shopName,
      })),
      { useAi: options.useAi !== false },
    );

    if (run.aiCallsMade > 0 || run.aiCacheHits > 0) {
      progress({
        type: 'ai',
        model: run.aiModel,
        comparisons: run.candidates - run.decidedDeterministically,
      });
    }

    const byId = new Map(run.results.map((result) => [result.id, result]));

    const hits = ranked
      .map((hit, index) => ({ ...hit, match: byId.get(String(index)) }))
      // Confidence outranks price, and price decides within a confidence band.
      // The cheapest row is the wrong answer when it is a different article,
      // which is the mistake this whole feature exists to stop.
      .sort((left, right) => {
        const gap = (right.match?.confidence ?? 0) - (left.match?.confidence ?? 0);
        if (Math.abs(gap) >= 0.1) return gap;
        if (left.effectivePrice === null) return 1;
        if (right.effectivePrice === null) return -1;
        return left.effectivePrice - right.effectivePrice;
      });

    // The per-candidate results are already attached to their hits above;
    // repeating them at the top level would double the payload for nothing.
    const matching = {
      understood: run.understood,
      candidates: run.candidates,
      decidedDeterministically: run.decidedDeterministically,
      aiCallsMade: run.aiCallsMade,
      aiCacheHits: run.aiCacheHits,
      aiModel: run.aiModel,
      aiSkippedReason: run.aiSkippedReason,
      aiQuota: run.aiQuota,
      durationMs: run.durationMs,
    };

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
      matching,
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
        priceSource: 'manual' as const,
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
      this.logger.warn(`Search at ${provider.host} failed: ${reason}`);
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

/** Trimmed, lowercased, whitespace collapsed — so "СВТ  3x2.5" hits one row. */
function normaliseQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
}

/** Money, to the cent. */
function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
