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
import { readAvailability } from '../scraper/parsers/availability';
import { PriceParserService } from '../scraper/parsers/price-parser.service';
import { DiscoveredProductDto, ShopSearchResultDto } from './dto/discovery.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Shop } from '../shops/entities/shop.entity';
import { DecisionDraftService } from '../decisions/decision-draft.service';
import {
  DecisionSupplierSnapshot,
  LineProvenance,
  buildSnapshot,
  provenanceKey,
} from '../decisions/purchase-decision.snapshot';
import { PROMPT_VERSION } from '../matching/claude.service';
import { EffectiveCostService } from '../pricing/effective-cost.service';
import { OptimiserStatsService } from '../pricing/optimiser-stats.service';
import { LineCost, SupplierTerms, round as roundMoney } from '../pricing/effective-cost';
import { BasketLineDto, BasketResultDto, BasketSupplierDto } from './dto/basket.dto';
import { DEFAULT_THRESHOLDS } from '../matching/deterministic-matcher';
import { interpret } from '../matching/interpretation';
import { QueryVariant, expandQuery, fallbackFor } from '../matching/query-expansion';
import { relationGroup } from '../matching/product-model';
import { MatchResult, MatchRunSummary, MatchingService } from '../matching/matching.service';
import { SearchMetricsService } from './search-metrics.service';
import { rank, RankableOffer, RankedHit } from './ranking';
import { bestOffer, partitionByVerdict } from './verdict';
import { WebDiscoveryService } from './web-discovery.service';
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
  | {
      type: 'understood';
      understood: MatchRunSummary['understood'];
      shops: number;
      /** The spellings a supplier may be asked, original first. */
      variants: QueryVariant[];
    }
  | {
      type: 'shop';
      host: string;
      name: string;
      ok: boolean;
      count: number;
      durationMs: number;
      /** What this shop was actually asked, when it was not the original. */
      usedQuery?: string;
      /** False for a shop reached only because the scope was global. */
      isMine?: boolean;
    }
  | { type: 'matching'; candidates: number }
  /**
   * What we would answer if the search stopped now.
   *
   * Emitted whenever a supplier's arrival changes the verdict, so the buyer
   * sees the first real offer seconds into a search that takes twenty — and
   * sees it improve when a cheaper one lands, rather than watching a spinner
   * and being handed everything at the end.
   *
   * `status` is never `NO_MATCH` here. "Nobody sells this" is only true once
   * every source has finished or timed out; while work is outstanding the
   * honest word is `SEARCHING`.
   */
  | {
      type: 'partial';
      status: 'SEARCHING' | 'MATCH' | 'ALTERNATIVE';
      matches: number;
      alternatives: number;
      offers: Array<RankedHit & { match?: MatchResult }>;
      bestOffer: (RankedHit & { match?: MatchResult }) | null;
    }
  | { type: 'ai'; model: string | null; comparisons: number }
  | { type: 'done' };

/**
 * Every stage of one search, kept for the operator to read.
 *
 * The support question is never "is search broken" — it is "why did *this*
 * search do *that*", and answering it from logs means reconstructing a
 * pipeline from nine log lines written at different times. This is the same
 * pipeline, recorded as it ran.
 */
export interface SearchTrace {
  query: string;
  understood: MatchRunSummary['understood'];
  variants: QueryVariant[];
  shops: Array<{
    host: string;
    name: string;
    ok: boolean;
    error: string | null;
    /** What this shop was asked — the original, or the widened spelling. */
    usedQuery: string;
    searchUrl: string;
    durationMs: number;
    products: Array<{ title: string; url: string; price: number | null; currency: string | null }>;
  }>;
  candidates: Array<{
    name: string;
    shop: string;
    url: string;
    effectivePrice: number | null;
    currency: string;
    relation: string;
    group: string;
    confidence: number;
    method: string;
    explanation: string;
    matched: unknown[];
    missing: unknown[];
    conflicts: unknown[];
  }>;
  matching: Omit<MatchRunSummary, 'results'>;
  /** Where the milliseconds went, so a slow search is diagnosable. */
  timings: SearchTimings;
  durationMs: number;
}

/**
 * Where one search spent its milliseconds.
 *
 * Reported on every comparison rather than logged, because the question "why
 * was that slow" is asked by the person who just waited, and the answer is
 * different every time: a supplier that took four seconds is a different
 * problem from a model that did.
 */
export interface SearchTimings {
  /** Reading the query into a structured product. Deterministic, sub-millisecond. */
  parse: number;
  /** Asking the suppliers. Almost always the largest number here. */
  retrieval: number;
  ranking: number;
  /** Matching on specifications alone. */
  matching: number;
  /** A model, when one was needed. Zero on a search that did not need one. */
  ai: number;
  /** 1 when the question had to be asked a second time in another spelling. */
  widened: number;
  total: number;
}

/**
 * Where to look.
 *
 * A purchasing question has two forms and they are asked minutes apart: "can I
 * buy this from the suppliers I already have terms with", and — when the
 * answer is no — "then who does sell it". The first is the working question
 * and the default; the second is the one that stops the buyer opening six tabs.
 *
 * They are one search with a different pool, not two search implementations.
 */
export type SearchScope = 'my_suppliers' | 'global';

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
    private readonly costs: EffectiveCostService,
    private readonly optimiserStats: OptimiserStatsService,
    private readonly decisionDrafts: DecisionDraftService,
    private readonly metrics: SearchMetricsService,
    private readonly web: WebDiscoveryService,
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
    scope: SearchScope = 'my_suppliers',
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

    // One widened spelling, held in reserve. A supplier whose own search
    // answers the question needs nothing else; a supplier that answers nothing
    // is the case worth a second request, because "not stocked anywhere" is the
    // most expensive wrong answer this system can give.
    const fallback = fallbackFor(expandQuery(trimmed, interpret(trimmed)));

    const mine = wanted.map(async (shop) => {
      const host = shop.host.replace(/^www\./, '');

      const answer = await this.withinBudget(host, shop.name, async () => {
        const result = await this.searchShopCached(shop, trimmed, useCache);

        const widened =
          fallback && result.ok && result.products.length === 0
            ? await this.searchShopCached(shop, fallback.query, useCache)
            : null;

        return widened && widened.ok && widened.products.length > 0
          ? { ...widened, usedQuery: fallback!.query }
          : result;
      });

      onShop?.(answer);
      return answer;
    });

    /*
     * Shops the buyer holds no account with, asked only when they asked.
     *
     * These are the verified configurations on the shelf — the same ones
     * `listAvailable` offers to add — and they take part in exactly one
     * circumstance: the buyer looked at "not stocked at any of my suppliers"
     * and pressed the button that says look anywhere.
     *
     * Never cached and never discounted. A cache row is keyed to a supplier
     * this account does not have, and a negotiated discount cannot be applied
     * to a shop nobody negotiated with — the price shown is the shelf price,
     * which is the honest thing to show for a shop you would be buying from
     * for the first time.
     */
    const theirs =
      scope === 'global'
        ? this.globalProviders(shops, hosts).map(async (provider) => {
            const result = await this.withinBudget(provider.host, provider.name, () =>
              this.searchOne(provider, trimmed),
            );
            const answer = { ...result, isMine: false };
            onShop?.(answer);
            return answer;
          })
        : [];

    /*
     * The web, asked at the same moment as the shops rather than after them.
     *
     * This was the single largest thing wrong with "everywhere". Discovery ran
     * once every configured supplier had answered, so its seventeen seconds
     * were added to their nineteen instead of overlapping them — and the
     * nineteen were one slow shop the others had been waiting on since the
     * sixth second. Two independent pools of network work, run one after the
     * other for no reason but the order the code was written in.
     *
     * The hosts to skip are known before either pool starts — they are the
     * configured shops and the verified shelf — so nothing has to be awaited
     * to decide what counts as a discovery.
     */
    const known = new Set<string>([
      ...wanted.map((shop) => shop.host.replace(/^www\./, '').toLowerCase()),
      ...(scope === 'global'
        ? this.globalProviders(shops, hosts).map((provider) => provider.host.toLowerCase())
        : []),
    ]);

    const web =
      scope === 'global' && this.web.enabled
        ? this.web
            .discover(trimmed, interpret(trimmed), (row) => {
              // Handed on the moment its page is read, so a discovered offer
              // reaches the buyer without waiting for the other seven.
              if (!known.has(row.host.toLowerCase())) onShop?.(row);
            })
            .then((rows) => rows.filter((row) => !known.has(row.host.toLowerCase())))
        : Promise.resolve<ShopSearchResultDto[]>([]);

    if (scope === 'global' && !this.web.enabled) {
      this.logger.warn('Web discovery is off, so "everywhere" reaches only the verified shelf.');
    }

    const [answers, discovered] = await Promise.all([
      Promise.all([...mine, ...theirs]),
      web,
    ]);

    return [...answers, ...discovered];
  }

  /**
   * The shelf, minus whatever this account already has.
   *
   * A shop the buyer has added is searched as theirs — with their terms and
   * their discount — and must not also appear as a stranger's.
   */
  private globalProviders(mine: Shop[], hosts?: string[]): SearchProvider[] {
    const owned = (host: string): boolean =>
      mine.some((shop) => {
        const own = shop.host.replace(/^www\./, '').toLowerCase();
        const other = host.toLowerCase();
        return own === other || own.endsWith(`.${other}`) || other.endsWith(`.${own}`);
      });

    return SEARCH_PROVIDERS.filter(
      (provider) => !owned(provider.host) && (!hosts?.length || hosts.includes(provider.host)),
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
    options: {
      currency?: string;
      useCache?: boolean;
      /** How many suppliers the buyer will split across. Unset means any number. */
      maxSuppliers?: number;
      /** Suppliers ruled out for this order. */
      excludeShopIds?: string[];
    } = {},
  ): Promise<BasketResultDto> {
    const startedAt = Date.now();
    const target = (options.currency ?? 'EUR').toUpperCase();

    const shops = await this.shops.find({ where: { ownerId, isActive: true } });
    const discountOf = new Map(shops.map((shop) => [shop.id, Number(shop.discountPercent)]));
    const nameOf = new Map(shops.map((shop) => [shop.id, shop.name]));
    const byHost = new Map(shops.map((shop) => [shop.host.replace(/^www\./, ''), shop.id]));
    // Built once for the whole basket: the terms are what turn a listed price
    // into what this customer pays, and re-reading them per line would be the
    // same lookup forty times.
    const termsOf = new Map(shops.map((shop) => [shop.id, this.costs.termsFor(shop)]));

    const pricedLines: BasketLineDto[] = [];

    /*
     * Everything a purchase decision would need to explain itself, collected
     * as it is produced.
     *
     * Gathered here rather than rebuilt later, and that is the whole point: a
     * decision saved from this comparison must be *this* comparison. Asking
     * the suppliers again to fill in a snapshot would produce a second,
     * possibly different answer and store it under the plan the buyer actually
     * looked at. So the provenance is picked up on the way past — it costs
     * nothing, because every value here was just computed to price the line.
     */
    const provenance = new Map<string, LineProvenance>();
    let aiCalls = 0;
    let aiModel: string | null = null;
    let decidedDeterministically = 0;

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
            terms: shopId ? termsOf.get(shopId) : undefined,
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

      aiCalls += run.aiCallsMade;
      aiModel = run.aiModel ?? aiModel;
      decidedDeterministically += run.decidedDeterministically;

      for (const offer of perShop.values()) {
        if (!offer.shopId || !offer.match) continue;

        provenance.set(provenanceKey(line.query, offer.shopId), {
          price: {
            source: offer.priceSource,
            url: offer.url,
            supplierId: offer.shopId,
            supplierName: offer.shopName,
            recordedAt: offer.recordedAt,
          },
          match: {
            method: offer.match.method,
            confidence: offer.match.confidence,
            band: offer.match.band,
            explanation: offer.match.explanation,
            attributes: offer.match.reasons,
            // The method, not the run: a basket where one line needed a model
            // does not mean this line did, and saying it did would credit the
            // model with a decision an article number made.
            aiUsed: offer.match.method === 'ai',
            model: offer.match.method === 'ai' ? run.aiModel : null,
            promptVersion: offer.match.method === 'ai' ? PROMPT_VERSION : null,
            manualOverride: null,
          },
          listPrice: offer.cost.listPrice,
          listCurrency: offer.cost.listCurrency,
          discountPercent: offer.cost.discountPercent,
          vatState: offer.cost.vatState,
        });
      }

      pricedLines.push({
        query: line.query,
        quantity: line.quantity,
        offers: [...perShop.values()],
        cheapest: [...perShop.values()][0] ?? null,
      });
    }

    // --- Where to place the order ---------------------------------------
    //
    // Everything above has already asked the suppliers, matched the articles
    // and priced them. This only decides, and it decides on data alone: no
    // request, no model, no clock. That is what lets a disputed plan be
    // reproduced from its inputs.
    const plan = this.costs.optimiseOrder(
      pricedLines.map((line) => ({
        query: line.query,
        quantity: line.quantity,
        offers: line.offers.map((offer) => ({
          shopId: offer.shopId!,
          unitPrice: offer.effectivePrice,
          confidence: offer.match?.confidence ?? 0,
          available: offer.inStock ?? null,
          priceSource: offer.priceSource,
          recordedAt: offer.recordedAt,
          vatCertainty: offer.vatCertainty,
          matchedName: offer.name,
          url: offer.url,
        })),
      })),
      termsOf,
      {
        currency: target,
        maxSuppliers: options.maxSuppliers,
        // The same floor the ranking already applied, restated here so the
        // optimiser is correct when called with unfiltered offers too.
        minConfidence: MATCH_FLOOR,
        excludeShopIds: options.excludeShopIds,
      },
    );

    this.optimiserStats.record(plan);

    /*
     * The decision this comparison *could* become, signed and handed back.
     *
     * Not written to the database. A buyer pricing an order to see what it
     * would cost has not decided anything, and the front end re-runs this on
     * every change to the supplier cap — auto-saving would fill the table with
     * rows nobody chose and, worse, would drag every abandoned experiment into
     * the average saving the ROI screen reports.
     *
     * So the snapshot travels to the client and comes back only if the buyer
     * presses "use this plan". The signature is what makes that safe: the
     * figures are checked to be this server's own before anything is stored, so
     * the round trip through an untrusted client cannot invent a saving. And
     * because the snapshot is complete, storing it later costs one INSERT — no
     * second optimiser run, no supplier asked twice, no model call.
     */
    const decidedAt = new Date();
    const snapshot = buildSnapshot(plan, {
      decidedAt,
      durationMs: Date.now() - startedAt,
      request: {
        lines: lines.map((line) => ({ query: line.query, quantity: line.quantity })),
        currency: target,
        maxSuppliers: options.maxSuppliers ?? null,
        excludeShopIds: options.excludeShopIds ?? [],
        usedCache: options.useCache ?? true,
      },
      suppliers: shops.map((shop) => supplierSnapshotOf(shop, this.costs.termsFor(shop))),
      provenance,
      matching: {
        aiUsed: aiCalls > 0,
        model: aiCalls > 0 ? aiModel : null,
        promptVersion: aiCalls > 0 ? PROMPT_VERSION : null,
        decidedDeterministically,
      },
    });

    this.logger.log(
      `basket owner=${ownerId} lines=${plan.diagnostics.lineCount} ` +
        `assignable=${plan.diagnostics.assignableLines} suppliers=${plan.diagnostics.supplierCount} ` +
        `offers=${plan.diagnostics.candidateOffers} combos=${plan.diagnostics.combinationsEvaluated} ` +
        `feasible=${plan.diagnostics.feasiblePlans} bounded=${plan.diagnostics.boundedSearch} ` +
        `chosen=${plan.best?.suppliersUsed ?? 0} saving=${plan.savings ?? 'none'} ` +
        `optimiser_ms=${plan.diagnostics.durationMs}`,
    );

    // What the whole order costs from each supplier on their own.
    //
    // Two figures, deliberately kept apart. `goodsTotal` is the product
    // subtotal after discount and net of VAT — what `total` has always meant,
    // and it is kept under that name so existing clients keep working.
    // `effectiveTotal` adds delivery and handling, which are charged once per
    // order, and it is the only one of the two worth comparing between
    // suppliers.
    const perSupplier: BasketSupplierDto[] = shops
      .map((shop) => {
        const terms = this.costs.termsFor(shop);
        const covered: LineCost[] = [];
        const missing: string[] = [];

        for (const line of pricedLines) {
          const offer = line.offers.find((candidate) => candidate.shopId === shop.id);

          if (offer && offer.effectivePrice !== null) {
            covered.push({
              ...offer.cost,
              quantity: line.quantity,
              netLineTotal: roundMoney(offer.effectivePrice * line.quantity),
            });
          } else {
            missing.push(line.query);
          }
        }

        const order = this.costs.orderCost(covered, terms, target);

        return {
          shopId: shop.id,
          name: shop.name,
          host: shop.host,
          linesCovered: covered.length,
          linesTotal: pricedLines.length,
          // Unchanged in meaning: goods only.
          total: covered.length > 0 ? order.goodsTotal : null,
          goodsTotal: covered.length > 0 ? order.goodsTotal : null,
          shippingCost: order.shippingCost,
          shippingWaived: order.shippingWaived,
          handlingFee: order.handlingFee,
          effectiveTotal: covered.length > 0 ? order.effectiveTotal : null,
          meetsMinimumOrder: order.meetsMinimumOrder,
          minOrderValue: order.minOrderValue,
          minimumShortfall: order.minimumShortfall,
          warnings: order.warnings,
          missing,
        };
      })
      // Suppliers who can supply nothing on this order are noise.
      .filter((supplier) => supplier.linesCovered > 0)
      // Complete orders first, then by what the order really costs. A supplier
      // missing half the list is not "cheapest" in any sense the buyer means —
      // and neither is one whose delivery charge undoes their better prices.
      .sort(
        (a, b) =>
          b.linesCovered - a.linesCovered ||
          (a.effectiveTotal ?? Infinity) - (b.effectiveTotal ?? Infinity),
      );

    // What it costs taking every line from whoever is cheapest on it.
    //
    // Cheapest on *goods*, which is what this has always done. The delivery
    // each chosen supplier charges is added afterwards, per supplier rather
    // than per line — that is the whole reason a split is not simply the sum
    // of the cheapest lines.
    let splitGoods = 0;
    let splitLines = 0;
    const splitAcross = new Set<string>();
    const splitGoodsByShop = new Map<string, number>();

    for (const line of pricedLines) {
      if (!line.cheapest || line.cheapest.effectivePrice === null) continue;

      const lineTotal = line.cheapest.effectivePrice * line.quantity;
      splitGoods += lineTotal;
      splitLines += 1;

      if (line.cheapest.shopId) {
        splitAcross.add(line.cheapest.shopId);
        splitGoodsByShop.set(
          line.cheapest.shopId,
          (splitGoodsByShop.get(line.cheapest.shopId) ?? 0) + lineTotal,
        );
      }
    }

    // Delivery and handling for each supplier the split would order from, and
    // whether each of them would actually accept their share. A split that is
    // arithmetically cheaper and leaves one supplier under their minimum is
    // not a cheaper order — it is an order that gets refused.
    let splitOverheads = 0;
    let allSuppliersViable = splitLines > 0;

    for (const [shopId, goods] of splitGoodsByShop) {
      const shop = shops.find((candidate) => candidate.id === shopId);
      if (!shop) continue;

      const terms = this.costs.termsFor(shop);
      const waived = terms.freeShippingOver !== null && goods >= terms.freeShippingOver;

      splitOverheads += (waived ? 0 : terms.shippingCost) + terms.handlingFee;
      if (goods < terms.minOrderValue) allSuppliersViable = false;
    }

    const splitEffective = splitLines > 0 ? roundMoney(splitGoods + splitOverheads) : null;

    // The baseline: the cheapest supplier who could fill the whole order *and*
    // would accept it. One under their minimum is not a baseline, because
    // ordering everything from them is not something the buyer can do.
    const bestSingle = perSupplier.find(
      (supplier) => supplier.linesCovered === pricedLines.length && supplier.meetsMinimumOrder,
    );

    const comparable = bestSingle && splitLines === pricedLines.length;

    return {
      currency: target,
      durationMs: Date.now() - startedAt,
      lines: pricedLines,
      suppliers: perSupplier,
      split: {
        total: splitLines > 0 ? roundMoney(splitGoods) : null,
        goodsTotal: splitLines > 0 ? roundMoney(splitGoods) : null,
        shippingCost: roundMoney(splitOverheads),
        effectiveTotal: splitEffective,
        allSuppliersViable,
        linesPriced: splitLines,
        suppliers: [...splitAcross].map((id) => nameOf.get(id) ?? id),
      },
      // Only meaningful against a supplier who could have filled the whole
      // order; comparing a split against a partial single order is comparing
      // two different purchases.
      saving:
        comparable && bestSingle.goodsTotal !== null
          ? roundMoney(bestSingle.goodsTotal - splitGoods)
          : null,
      // The honest version of the same question: delivery on both sides, and
      // null when the split cannot actually be placed. This is the figure to
      // show a customer — `saving` overstates the benefit by exactly the
      // deliveries the split adds.
      effectiveSaving:
        comparable &&
        bestSingle.effectiveTotal !== null &&
        splitEffective !== null &&
        allSuppliersViable
          ? roundMoney(bestSingle.effectiveTotal - splitEffective)
          : null,
      // The answer, as opposed to the arithmetic. Added beside the older
      // fields rather than replacing them: `split` is a greedy figure that
      // ignores delivery and minimum orders, it is kept so a client written
      // against the earlier contract keeps working, and `plan` is what an
      // interface should show.
      plan,
      // Null when no plan could be placed. A decision to buy nothing is not a
      // purchase decision, and offering to save one would put a row with no
      // saving into every average.
      decision: snapshot ? this.decisionDrafts.seal(snapshot) : null,
    };
  }

  /**
   * One supplier's answer, or a note that it took too long.
   *
   * A search asks every shop at once, and `Promise.all` finishes when the
   * slowest one does — so a single shop that takes nineteen seconds makes
   * every other answer nineteen seconds old before anybody sees it. The
   * request itself is left running rather than aborted: it will populate the
   * cache, so the shop that was slow this time is instant the next.
   *
   * A timeout is reported as that shop's own failure, exactly like a 403 or a
   * robots refusal. It is a true statement about one supplier, and the search
   * carries on with the ones that answered.
   */
  private async withinBudget(
    host: string,
    name: string,
    work: () => Promise<ShopSearchResultDto>,
  ): Promise<ShopSearchResultDto> {
    const startedAt = Date.now();
    const budget = this.config.supplierTimeoutMs;

    let timer: NodeJS.Timeout | undefined;

    const expiry = new Promise<ShopSearchResultDto>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            host,
            name,
            searchUrl: '',
            ok: false,
            error: `магазинът не отговори за ${Math.round(budget / 1000)} сек`,
            durationMs: budget,
            products: [],
          }),
        budget,
      );
    });

    try {
      const answer = await Promise.race([work(), expiry]);
      if (!answer.ok && answer.durationMs === budget) {
        this.logger.warn(`${host} exceeded its ${budget}ms budget; search continued without it`);
      }
      return { ...answer, durationMs: answer.durationMs || Date.now() - startedAt };
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      /**
       * Where to look. `my_suppliers` — the default and the working question —
       * asks only the shops this account holds terms with; `global` adds the
       * verified shelf, for the moment the answer to the first was "nobody".
       */
      scope?: SearchScope;
      /** Called as each stage completes, for a streaming caller. */
      onProgress?: (event: SearchProgress) => void;
      /**
       * Records every stage for the operator's search debugger.
       *
       * Off by default and costs nothing when off: the trace is assembled from
       * values the search computes anyway, but holding every supplier row and
       * every rejected candidate in memory is not something a customer's
       * search should pay for.
       */
      trace?: boolean;
    } = {},
  ): Promise<{
    query: string;
    /**
     * What this search concluded, decided here rather than by each client.
     *
     * `NO_MATCH` is a first-class answer and the honest one far more often
     * than the old payload allowed: a shop returning eight priced rows that
     * are not the article is not eight offers.
     */
    status: 'MATCH' | 'ALTERNATIVE' | 'NO_MATCH';
    durationMs: number;
    shops: Array<{
      host: string;
      name: string;
      ok: boolean;
      error: string | null;
      durationMs: number;
      /** Rows the shop returned — retrieval, not offers. */
      count: number;
      searchUrl: string;
      usedQuery?: string;
      /** False for a shop reached only because the scope was global. */
      isMine?: boolean;
    }>;
    /** The article the buyer asked for, found. */
    matches: Array<RankedHit & { match?: MatchResult }>;
    /** Genuinely related, and not what was asked for. Never counted as a match. */
    alternatives: Array<RankedHit & { match?: MatchResult }>;
    /** What a buyer may be quoted for the article asked for. Matches only. */
    offers: Array<RankedHit & { match?: MatchResult }>;
    /** The cheapest offer, chosen among `offers` and never among candidates. */
    bestOffer: (RankedHit & { match?: MatchResult }) | null;
    /** How many retrieved rows were refused. Bodies live in `trace` only. */
    rejectedCandidates: number;
    /** Validated rows only — the same list as `offers`. */
    hits: Array<RankedHit & { match?: MatchResult }>;
    matching?: Omit<MatchRunSummary, 'results'>;
    /** The spellings the suppliers were, or could have been, asked. */
    variants?: QueryVariant[];
    /** Where this search looked. */
    scope?: SearchScope;
    /** How many results fell in each pile, so a client can lead with the answer. */
    groups?: Record<'strong' | 'possible' | 'similar' | 'excluded', number>;
    /** Where the time went, so a slow search is diagnosable rather than felt. */
    timings?: SearchTimings;
    trace?: SearchTrace;
  }> {
    const startedAt = Date.now();
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      return {
        query: trimmed,
        status: 'NO_MATCH',
        durationMs: 0,
        shops: [],
        matches: [],
        alternatives: [],
        offers: [],
        bestOffer: null,
        rejectedCandidates: 0,
        hits: [],
      };
    }

    /*
     * Where the seconds went.
     *
     * Kept because the first thing anybody asks about a slow search is which
     * part was slow, and the answer used to be a guess. Four numbers and a
     * flag: reading the query, asking the suppliers, ranking and matching what
     * came back, and whatever a model cost when one was needed at all.
     */
    const timings: SearchTimings = {
      parse: 0,
      retrieval: 0,
      ranking: 0,
      matching: 0,
      ai: 0,
      widened: 0,
      total: 0,
    };

    const progress = options.onProgress ?? (() => undefined);

    // First and instantly: what the words were taken to mean. This is pure
    // arithmetic over the query, so it costs nothing and it is the moment the
    // reader learns the machine understood "12W E27" as a specification rather
    // than as two more words to search for.
    const shopsForQuery = await this.shops.count({ where: { ownerId, isActive: true } });

    const parsedAt = Date.now();
    const interpreted = interpret(trimmed);
    const variants = expandQuery(trimmed, interpreted);
    timings.parse = Date.now() - parsedAt;

    progress({
      type: 'understood',
      understood: this.matching.understand(trimmed),
      shops: shopsForQuery,
      variants,
    });

    // The discount lives on the shop row, and the search providers are keyed
    // by host — so the two are joined here rather than threaded through every
    // provider.
    const shops = await this.shops.find({ where: { ownerId } });

    // Resolved once per host rather than per offer. This used to be a linear
    // scan called three times for every shop in the result.
    const termsByHost = new Map<
      string,
      { id: string | null; percent: number; terms?: SupplierTerms }
    >();

    const discountFor = (
      host: string,
    ): { id: string | null; percent: number; terms?: SupplierTerms } => {
      const cached = termsByHost.get(host);
      if (cached) return cached;

      const match = shops.find((shop) => {
        const left = shop.host.replace(/^www\./, '').toLowerCase();
        const right = host.replace(/^www\./, '').toLowerCase();
        return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
      });

      const resolved = {
        id: match?.id ?? null,
        percent: match ? Number(match.discountPercent) : 0,
        terms: match ? this.costs.termsFor(match) : undefined,
      };

      termsByHost.set(host, resolved);
      return resolved;
    };

    const offersFrom = (rows: ShopSearchResultDto[]): RankableOffer[] => {
      const offers: RankableOffer[] = [];

      for (const result of rows) {
        if (!result.ok) continue;
        const shop = discountFor(result.host);

        for (const product of result.products) {
          // Stock, not price. This read `product.price === null`, so the
          // "in stock only" switch hid articles whose price failed to parse
          // and kept every article the shop had plainly marked as sold out —
          // the one thing it exists to remove.
          if (options.inStockOnly && product.inStock === false) continue;

          // A shop nobody has terms with gets no discount and no terms —
          // applying either would quote a price this buyer cannot obtain.
          const mine = result.isMine !== false;

          offers.push({
            title: product.title,
            url: product.url,
            price: product.price,
            currency: product.currency,
            host: product.host,
            shopName: product.shopName,
            shopId: mine ? shop.id : null,
            discountPercent: mine ? shop.percent : 0,
            terms: mine ? shop.terms : undefined,
            isMine: mine,
            recordedAt: product.recordedAt ?? null,
            priceSource: product.priceSource ?? 'live',
            inStock: product.inStock ?? null,
            instalments: product.instalments ?? [],
          });
        }
      }

      return offers;
    };

    const decide = async (
      rows: ShopSearchResultDto[],
      useAi: boolean,
    ): Promise<{ ranked: RankedHit[]; run: MatchRunSummary }> => {
      const rankedAt = Date.now();

      const shortlist = rank(
        offersFrom(rows),
        (options.currency ?? 'EUR').toUpperCase(),
        options.limit ?? 60,
        trimmed,
      );

      timings.ranking += Date.now() - rankedAt;

      // Matching runs on what survived ranking, not on everything every shop
      // returned. Ranking has already thrown away the shop's wilder guesses,
      // and a model asked about those is a model paid to say "no".
      progress({ type: 'matching', candidates: shortlist.length });

      const matchedAt = Date.now();

      const summary = await this.matching.match(
        ownerId,
        trimmed,
        shortlist.map((hit, index) => ({
          id: String(index),
          name: hit.name,
          supplier: hit.shopName,
        })),
        { useAi },
      );

      if (useAi) timings.ai += Date.now() - matchedAt;
      else timings.matching = Math.max(timings.matching, Date.now() - matchedAt);

      return { ranked: shortlist, run: summary };
    };

    const retrievalAt = Date.now();

    const scope: SearchScope = options.scope ?? 'my_suppliers';

    /*
     * Answering while the answer is still arriving.
     *
     * A comparison is a dozen independent network calls and it finishes when
     * the slowest one does. Holding every result back until then means the
     * shop that answered in two seconds is shown at eighteen — and, worse,
     * that a buyer watching a spinner has no idea whether anything was found
     * at all. What is already known is worth saying.
     *
     * So each supplier's answer is judged against everything that has landed
     * so far, and a `partial` goes out whenever that changes the verdict. The
     * work is affordable precisely because matching is not the expensive part:
     * ranking and matching thirteen candidates costs 164 ms against
     * thirty-five seconds of retrieval, so re-judging on arrival is free
     * relative to the waiting it replaces.
     *
     * Two rules keep it honest. Only ever say more than last time — a partial
     * that retracted a match would be a worse experience than silence. And
     * never say NO_MATCH here: "nobody sells this" is only true once every
     * source has finished, and it is the final answer's to give.
     */
    const landed: ShopSearchResultDto[] = [];
    let announced = 0;
    let judging = false;
    let stale = false;

    const announce = async (): Promise<void> => {
      if (judging) {
        stale = true;
        return;
      }

      judging = true;
      try {
        do {
          stale = false;
          const snapshot = [...landed];
          if (snapshot.every((row) => row.products.length === 0)) continue;

          const { ranked, run } = await decide(snapshot, false);
          const byId = new Map(run.results.map((result) => [result.id, result]));
          const scored = ranked.map((hit, index) => ({ ...hit, match: byId.get(String(index)) }));
          const verdict = partitionByVerdict(scored);

          const found = verdict.matches.length + verdict.alternatives.length;
          if (found === 0 || found === announced) continue;
          announced = found;

          progress({
            type: 'partial',
            status: verdict.status === 'NO_MATCH' ? 'SEARCHING' : verdict.status,
            matches: verdict.matches.length,
            alternatives: verdict.alternatives.length,
            offers: verdict.matches,
            bestOffer: bestOffer(verdict.matches) ?? null,
          });
        } while (stale);
      } catch (error) {
        // A partial that fails is a partial nobody sees. The final answer is
        // computed from the same rows moments later and is not at risk.
        this.logger.debug(
          `Interim verdict skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        judging = false;
      }
    };

    const results = await this.search(
      ownerId,
      trimmed,
      options.hosts,
      options.useCache ?? true,
      (result) => {
        progress({
          type: 'shop',
          host: result.host,
          name: result.name,
          ok: result.ok,
          count: result.products.length,
          durationMs: result.durationMs,
          usedQuery: result.usedQuery,
          isMine: result.isMine !== false,
        });

        landed.push(result);
        if (result.products.length > 0) void announce();
      },
      scope,
    );

    timings.retrieval = Date.now() - retrievalAt;


    /*
     * Deterministic first, always, and a model only where arithmetic ran out.
     *
     * This used to ask the model on every search, and the logs said what that
     * cost: "AI matched 5 candidates in 4.6s" on a comparison whose other four
     * stages took under a second between them. The model was being paid to
     * confirm what a barcode and two measurements had already settled.
     *
     * So the ladder is now three rungs and each one is only climbed when the
     * one below it failed:
     *
     *   1. specifications — free, ~1 ms, settles most searches outright;
     *   2. the same question in another spelling — one request per supplier;
     *   3. a model, on the shortlist only, for the pairs still genuinely open.
     *
     * A search that finds the article never reaches rung 3 at all, which is
     * most searches, and the ones that do reach it are the ones worth paying
     * for: a supplier who writes "840" where the buyer wrote "4000K".
     */
    let { ranked, run } = await decide(results, false);

    /*
     * The second chance, and the reason a search stopped answering "nobody
     * stocks it" to a question four suppliers could answer.
     *
     * Widening per shop only fires when a shop returns *nothing*, and that
     * misses the commoner failure: every shop returns something and not one of
     * the rows is the article. A Bulgarian wholesaler writes a cable "3х1,5"
     * with a Cyrillic х and a decimal comma; a buyer types "3x1.5" on a Latin
     * keyboard; the shop's search is a LIKE over the title, so it answers with
     * whatever else contains "кабел" and the right answer is never returned at
     * all.
     *
     * So when nothing survived matching, the whole question is asked again in
     * one other spelling, and the two rounds are merged. Bounded to exactly one
     * retry, and only from a standing start of zero — a search that found the
     * article costs what it always cost.
     */
    const survived = (summary: MatchRunSummary): boolean =>
      summary.results.some(
        (result) => result.confidence >= MATCH_FLOOR && result.relation !== 'conflict',
      );

    const secondChance = variants.find(
      (variant) => variant.kind !== 'original' && variant.kind !== 'broad',
    );

    if (!survived(run) && secondChance) {
      timings.widened = 1;
      /*
       * Only the shops that actually answered are asked again.
       *
       * The retry exists for a supplier that answered with the wrong spelling,
       * which is a supplier that answered. One that refused or ran out of time
       * will do exactly the same thing a second time, and now that a slow shop
       * costs a full timeout rather than however long it felt like taking,
       * asking twice made a fruitless search pay that timeout twice over —
       * eighteen seconds to conclude nothing, against nine to conclude it once.
       */
      const answered = results
        .filter((row) => row.ok)
        .map((row) => row.host.replace(/^www\./, ''));

      const retried = await this.search(
        ownerId,
        secondChance.query,
        options.hosts?.length ? options.hosts.filter((host) => answered.includes(host)) : answered,
        options.useCache ?? true,
        (result) =>
          progress({
            type: 'shop',
            host: result.host,
            name: result.name,
            ok: result.ok,
            count: result.products.length,
            durationMs: result.durationMs,
            usedQuery: secondChance.query,
          }),
      );

      // Merged rather than replacing: the first round's rows are what explain
      // *why* the retry happened, and a supplier that answered both times has
      // told us more, not something else.
      const seen = new Set<string>();
      for (const row of results) for (const product of row.products) seen.add(product.url);

      for (const row of retried) {
        const original = results.find((candidate) => candidate.host === row.host);
        const fresh = row.products.filter((product) => !seen.has(product.url));

        if (!original) results.push({ ...row, usedQuery: secondChance.query });
        else if (fresh.length > 0) {
          original.products = [...original.products, ...fresh];
          original.usedQuery = secondChance.query;
        }
      }

      const second = await decide(results, false);

      // Kept only if it actually answered. A retry that found nothing must not
      // replace the first round's explanation of what went wrong.
      if (survived(second.run)) {
        ranked = second.ranked;
        run = second.run;
      }
    }

    // Rung 3. Nothing the specifications or the spellings could settle, so the
    // shortlist genuinely holds a question only knowledge can answer — that
    // "840" is 4000 K, that "neutralweiss" is neutral white. This is the case
    // the allowance exists for, and now the only one that spends it.
    if (!survived(run) && options.useAi !== false && ranked.length > 0) {
      const assisted = await decide(results, true);
      ranked = assisted.ranked;
      run = assisted.run;
    }

    if (run.aiCallsMade > 0 || run.aiCacheHits > 0) {
      progress({
        type: 'ai',
        model: run.aiModel,
        comparisons: run.candidates - run.decidedDeterministically,
      });
    }

    const byId = new Map(run.results.map((result) => [result.id, result]));

    const scored = ranked
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

    /*
     * A supplier's search result is a candidate. It becomes an offer here or
     * not at all.
     *
     * This is the line the whole feature turned on and it was missing. Every
     * scored row used to be returned, verdict attached, and the interface was
     * left to decide what "unrelated, confidence 0.00" meant — which it did by
     * printing eight car parts under a note saying nothing matched. eMAG
     * answers a query it cannot fulfil with a recommendation shelf, and a
     * recommendation shelf priced in euro is indistinguishable from a quote
     * unless somebody refuses to quote it.
     *
     * So: accepted is the same predicate the retry logic already trusted —
     * above the floor, and nothing stated against it. Everything else is
     * retrieval, kept for the trace and never for the buyer.
     */
    const { status, matches, alternatives, rejected } = partitionByVerdict(scored);

    /*
     * Offers are matches. Not matches and alternatives, and never candidates.
     *
     * The distinction had to be made sharper than "everything we did not
     * refuse". A neighbouring model is a real answer to a real question and it
     * is not a quote for the article asked about, so pricing it alongside the
     * article — and letting it win on price — answers the wrong question with
     * total confidence. `alternatives` travels separately and is priced
     * separately.
     */
    const offers = matches;
    const best = bestOffer(offers);

    // `hits` keeps its name and loses its ambiguity: it is now exactly what a
    // client may show, which is what every caller already assumed it was.
    const hits = [...matches, ...alternatives];

    this.logger.log(
      `[STOCLIFY_SEARCH_V2] query="${trimmed}" scope=${scope} status=${status} ` +
        `raw=${results.reduce((total, row) => total + row.products.length, 0)} ` +
        `ranked=${scored.length} matches=${matches.length} ` +
        `alternatives=${alternatives.length} rejected=${rejected.length} ` +
        `best=${best ? `${best.shopName} ${best.effectivePrice ?? '-'}` : 'none'}`,
    );

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
      facets: run.facets,
      durationMs: run.durationMs,
    };

    // The piles, counted once here rather than by every client that shows them.
    const groups: Record<'strong' | 'possible' | 'similar' | 'excluded', number> = {
      strong: 0,
      possible: 0,
      similar: 0,
      excluded: 0,
    };

    for (const hit of scored) {
      const pile = hit.match ? relationGroup(hit.match.relation, hit.match.confidence) : 'possible';
      groups[pile] += 1;
    }

    this.metrics.record({
      durationMs: Date.now() - startedAt,
      shopsAsked: results.length,
      shopsAnswered: results.filter((result) => result.ok).length,
      widened: results.filter((result) => result.usedQuery).length,
      candidates: run.candidates,
      strong: groups.strong,
      possible: groups.possible,
      conflicts: scored.filter((hit) => hit.match?.relation === 'conflict').length,
      zeroResult: status === 'NO_MATCH',
      aiCalls: run.aiCallsMade,
      decidedDeterministically: run.decidedDeterministically,
      topConfidence: scored.reduce((best, hit) => Math.max(best, hit.match?.confidence ?? 0), 0),
      attributesUnderstood: Object.keys(run.understood.attributes).length,
    });

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
      status,
      durationMs: Date.now() - startedAt,
      shops: mergeByHost(results).map((result) => ({
        host: result.host,
        name: result.name,
        ok: result.ok,
        error: result.error,
        durationMs: result.durationMs,
        // What this shop *returned*, which is not what it offered. Named
        // `count` since the first version and read by existing clients, so the
        // meaning is stated here rather than changed underneath them.
        count: result.products.length,
        searchUrl: result.searchUrl,
        usedQuery: result.usedQuery,
        isMine: result.isMine !== false,
      })),
      matches,
      alternatives,
      // What a buyer may actually be quoted for the article they asked for.
      // Empty whenever nothing was matched, whatever the suppliers returned.
      offers,
      // Chosen among the offers alone, on the server, so no client has to
      // rediscover which rows were comparable.
      bestOffer: best,
      rejectedCandidates: rejected.length,
      hits,
      matching,
      variants,
      scope,
      groups,
      timings: { ...timings, total: Date.now() - startedAt },
      trace: options.trace
        ? {
            query: trimmed,
            understood: run.understood,
            variants,
            shops: results.map((result) => ({
              host: result.host,
              name: result.name,
              ok: result.ok,
              error: result.error,
              usedQuery: result.usedQuery ?? trimmed,
              searchUrl: result.searchUrl,
              durationMs: result.durationMs,
              products: result.products.map((product) => ({
                title: product.title,
                url: product.url,
                price: product.price,
                currency: product.currency,
              })),
            })),
            candidates: scored.map((hit) => ({
              name: hit.name,
              shop: hit.shopName,
              url: hit.url,
              effectivePrice: hit.effectivePrice,
              currency: hit.effectiveCurrency,
              relation: hit.match?.relation ?? 'possible',
              group: hit.match
                ? relationGroup(hit.match.relation, hit.match.confidence)
                : 'possible',
              confidence: hit.match?.confidence ?? 0,
              method: hit.match?.method ?? 'none',
              explanation: hit.match?.explanation ?? '',
              matched: hit.match?.matchedAttributes ?? [],
              missing: hit.match?.missingAttributes ?? [],
              conflicts: hit.match?.conflicts ?? [],
            })),
            matching,
            timings: { ...timings, total: Date.now() - startedAt },
            durationMs: Date.now() - startedAt,
          }
        : undefined,
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
        // Read from the tile, not the page: a results page carries dozens of
        // articles and the sold-out label belongs to the one it sits inside.
        // Most shops that mark stock at all mark it right here, so this is
        // free information we were throwing away.
        inStock: readAvailability(scope.text()),
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

/**
 * A shop row as a decision remembers it.
 *
 * Reads the terms rather than the row, so the frozen copy and the figures the
 * optimiser worked from come from one source. A second reading of `shop.*`
 * here would be a second implementation of "what are this supplier's terms",
 * and the first time the two disagreed the snapshot would explain a total it
 * did not produce.
 */
function supplierSnapshotOf(shop: Shop, terms: SupplierTerms): DecisionSupplierSnapshot {
  return {
    shopId: shop.id,
    name: terms.name,
    host: shop.host ?? null,
    currency: terms.currency,
    discountPercent: terms.discountPercent,
    vatState: terms.vatState,
    vatRate: terms.vatRate,
    shippingCost: terms.shippingCost,
    freeShippingOver: terms.freeShippingOver,
    handlingFee: terms.handlingFee,
    minOrderValue: terms.minOrderValue,
  };
}

/**
 * One row per shop for the reader, however many rows it produced internally.
 *
 * Web discovery streams a row per *page*, because a page is what finishes —
 * and that is the right unit for handing an offer over the moment it is read.
 * It is the wrong unit for a list of shops, where a domain answering with
 * three pages is one shop, not three.
 */
export function mergeByHost(rows: ShopSearchResultDto[]): ShopSearchResultDto[] {
  const merged = new Map<string, ShopSearchResultDto>();

  for (const row of rows) {
    const seen = merged.get(row.host);

    if (!seen) {
      merged.set(row.host, { ...row, products: [...row.products] });
      continue;
    }

    seen.products.push(...row.products);
    // A shop that answered at all answered, and the slowest of its pages is
    // how long it actually took to hear from.
    seen.ok = seen.ok || row.ok;
    if (seen.ok) seen.error = null;
    seen.durationMs = Math.max(seen.durationMs, row.durationMs);
  }

  return [...merged.values()];
}
