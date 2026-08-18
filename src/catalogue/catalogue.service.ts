import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { convert, isConvertible } from '../products/currency';
import {
  PRICE_SOURCE,
  PriceFetchError,
  PriceSource,
} from '../scraper/fetchers/price-source.interface';
import {
  CrawlResultDto,
  OfferHitDto,
  SearchOffersDto,
  ShopCheckDto,
  SuggestionDto,
} from './dto/catalogue.dto';
import { Offer } from './entities/offer.entity';
import { Shop } from './entities/shop.entity';
import { SitemapService } from './sitemap.service';

/** Re-read a shop's sitemap at most this often; it is a megabyte of XML. */
const SITEMAP_CACHE_MS = 60 * 60 * 1000;

/** An offer older than this is re-fetched before an unseen URL is tried. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The Cyrillic letters that have Latin lookalikes, and their twins.
 *
 * Literals rather than parameters because they also appear in the index
 * expression in `OfferSearchHomoglyphs1787060000000`; the two must be
 * character-for-character identical or Postgres quietly stops using the index.
 * Both are fixed strings in this file — no user input reaches them.
 */
const HOMOGLYPH_FROM = 'аеорсухкмтвн';
const HOMOGLYPH_TO = 'aeopcyxkmtbh';

interface CachedSitemap {
  urls: string[];
  fetchedAt: number;
}

@Injectable()
export class CatalogueService {
  private readonly logger = new Logger(CatalogueService.name);
  private readonly sitemapCache = new Map<string, CachedSitemap>();

  constructor(
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
    @InjectRepository(Offer) private readonly offers: Repository<Offer>,
    private readonly sitemap: SitemapService,
    @Inject(PRICE_SOURCE) private readonly priceSource: PriceSource,
  ) {}

  findShops(): Promise<Shop[]> {
    return this.shops.find({ order: { name: 'ASC' } });
  }

  async findShop(id: string): Promise<Shop> {
    const shop = await this.shops.findOne({ where: { id } });
    if (!shop) throw new NotFoundException(`Няма магазин с id "${id}".`);
    return shop;
  }

  /**
   * Registers a shop, working out its sitemap when one was not supplied.
   *
   * The host is normalised without `www.` so the same shop cannot be added
   * twice under two spellings and then compared against itself.
   */
  async addShop(input: {
    host: string;
    name?: string;
    sitemapUrl?: string;
    discountPercent?: number;
    currency?: string;
  }): Promise<Shop> {
    const host = input.host
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./i, '')
      .toLowerCase();

    const existing = await this.shops.findOne({ where: { host } });
    const sitemapUrl =
      input.sitemapUrl ??
      (await this.sitemap.discover(`www.${host}`)) ??
      (await this.sitemap.discover(host));

    const shop = existing ?? this.shops.create({ host });

    shop.name = input.name ?? existing?.name ?? host;
    shop.sitemapUrl = sitemapUrl;
    shop.discountPercent = input.discountPercent ?? existing?.discountPercent ?? 0;
    shop.currency = input.currency ?? existing?.currency ?? 'EUR';
    shop.isActive = true;

    const saved = await this.shops.save(shop);
    this.logger.log(`Shop ${saved.host} ready (sitemap: ${saved.sitemapUrl ?? 'none'})`);
    return saved;
  }

  /**
   * Answers "can we actually read this shop?" before anyone waits on a crawl.
   *
   * Three questions, in the order they can disqualify a shop: does robots.txt
   * allow us, is there a sitemap listing its pages, and does a real product
   * page give up a price. The third is the one that matters — plenty of shops
   * pass the first two and then render everything with JavaScript, and finding
   * that out after an hour of crawling is finding it out too late.
   *
   * Costs one or two requests and a few seconds.
   */
  async verify(host: string): Promise<ShopCheckDto> {
    const clean = host
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/^www\./i, '')
      .toLowerCase();

    const sitemapUrl =
      (await this.sitemap.discover(`www.${clean}`)) ?? (await this.sitemap.discover(clean));

    if (!sitemapUrl) {
      return {
        host: clean,
        usable: false,
        sitemapUrl: null,
        pages: 0,
        sampleUrl: null,
        samplePrice: null,
        sampleName: null,
        reason:
          'Магазинът не публикува sitemap. Без него не знаем кои са продуктовите му страници — може да се следят отделни артикули по линк, но каталогът не може да се обходи.',
      };
    }

    let urls: string[];
    try {
      urls = this.sitemap.filterProductLikely(await this.sitemap.collect(sitemapUrl), clean);
    } catch (error) {
      return {
        host: clean,
        usable: false,
        sitemapUrl,
        pages: 0,
        sampleUrl: null,
        samplePrice: null,
        sampleName: null,
        reason:
          error instanceof Error && /robots/i.test(error.message)
            ? 'robots.txt на магазина не позволява да четем sitemap-а.'
            : `Sitemap-ът не се прочете: ${error instanceof Error ? error.message : 'непозната грешка'}`,
      };
    }

    if (urls.length === 0) {
      return {
        host: clean,
        usable: false,
        sitemapUrl,
        pages: 0,
        sampleUrl: null,
        samplePrice: null,
        sampleName: null,
        reason:
          'Sitemap-ът не съдържа продуктови страници. Обикновено значи, че магазинът е приложение, което зарежда всичко с JavaScript.',
      };
    }

    // Spread across the catalogue, not the first few. The top of the ranking
    // is not a safe sample: TMT names its category pages exactly like its
    // products, so the three best-looking URLs were all categories and the
    // shop was declared unreadable while it was busy being indexed.
    const ranked = this.productFirst(urls);
    const step = Math.max(1, Math.floor(ranked.length / 8));
    const candidates = ranked.filter((_url, index) => index % step === 0).slice(0, 8);

    for (const url of candidates) {
      try {
        const observation = await this.priceSource.fetch({
          url,
          host: clean,
          selector: null,
          attribute: null,
          lastPrice: null,
          currency: 'EUR',
        });

        return {
          host: clean,
          usable: true,
          sitemapUrl,
          pages: urls.length,
          sampleUrl: url,
          samplePrice: observation.price,
          sampleName: observation.title ?? null,
          reason: null,
        };
      } catch {
        // Try the next candidate: one page without a price is a category, three
        // without one is a shop we cannot read.
      }
    }

    return {
      host: clean,
      usable: false,
      sitemapUrl,
      pages: urls.length,
      sampleUrl: candidates[0] ?? null,
      samplePrice: null,
      sampleName: null,
      reason:
        'Намерих ' +
        urls.length +
        ' страници, но на нито една от ' +
        candidates.length +
        ' пробни нямаше цена. Най-вероятно магазинът зарежда цените с JavaScript — такъв каталог не може да се индексира.',
    };
  }

  async updateShop(id: string, changes: Partial<Shop>): Promise<Shop> {
    const shop = await this.findShop(id);
    Object.assign(shop, changes);
    return this.shops.save(shop);
  }

  async removeShop(id: string): Promise<void> {
    const result = await this.shops.delete({ id });
    if (!result.affected) throw new NotFoundException(`Няма магазин с id "${id}".`);
  }

  /**
   * Crawls a bounded slice of a shop's catalogue.
   *
   * Bounded on purpose. A full catalogue is thousands of pages and the polite
   * delay between requests makes that hours — far past any HTTP timeout, and
   * not something to hold a connection open for. Each call does a batch and
   * returns; calling it again continues where it left off, so a cron, a button
   * and a manual curl all drive the same loop.
   *
   * Unseen URLs come first, then the stalest known ones: a catalogue should
   * become complete before it becomes fresh.
   */
  async crawl(shopId: string, limit = 50, match?: string): Promise<CrawlResultDto> {
    const shop = await this.findShop(shopId);
    const startedAt = Date.now();

    if (!shop.sitemapUrl) {
      throw new NotFoundException(
        `Магазин "${shop.host}" няма sitemap. Задайте го ръчно, за да може каталогът да се обходи.`,
      );
    }

    const all = await this.sitemapUrls(shop);

    // Narrowing to one corner of the catalogue turns "come back tomorrow" into
    // "watch this": TMT's whole sitemap is 7548 pages and a night of polite
    // crawling, but its 114 lamp URLs are five minutes.
    const needle = match?.trim().toLowerCase();
    const urls = needle ? all.filter((url) => url.toLowerCase().includes(needle)) : all;
    const known = await this.offers.find({
      where: { shopId: shop.id },
      select: { url: true, lastSeenAt: true },
    });

    const seenAt = new Map(known.map((offer) => [offer.url, offer.lastSeenAt?.getTime() ?? 0]));
    const threshold = Date.now() - STALE_AFTER_MS;

    // A sitemap index whose children overlap lists the same URL more than once.
    // Without this the crawler fetches it twice in the same run — visible in the
    // log as every price appearing in identical pairs — and doubles the load we
    // put on the shop for nothing.
    const queue = [
      ...new Set([
        // Product-looking URLs first. A sitemap starts with the home page and
        // the category tree, so crawling it in order spends the first batch on
        // pages that were never going to carry a price.
        ...this.productFirst(urls.filter((url) => !seenAt.has(url))),
        ...urls.filter((url) => {
          const at = seenAt.get(url);
          return at !== undefined && at < threshold;
        }),
      ]),
    ].slice(0, limit);

    let indexed = 0;
    let failed = 0;
    let skipped = 0;
    const problems: string[] = [];
    const failures: Array<{ url: string; message: string }> = [];

    for (const url of queue) {
      try {
        const observation = await this.priceSource.fetch({
          url,
          host: shop.host,
          selector: null,
          attribute: null,
          lastPrice: null,
          currency: shop.currency,
        });

        await this.upsert(shop, url, observation);
        indexed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // A sitemap lists the home page, the category tree and the terms of
        // service beside its products, and none of those has a price. That is
        // not a failure — it is the sitemap being a sitemap. Distinguished by
        // the error being final rather than by matching its wording, which
        // changes.
        const noPrice = error instanceof PriceFetchError && !error.retryable;

        if (noPrice) skipped += 1;
        else {
          failed += 1;
          failures.push({ url, message });
        }

        // Recorded either way, so the next crawl does not spend its budget
        // re-reading the same terms-of-service page for ever.
        await this.recordNonOffer(shop, url, message);

        if (problems.length < 5) problems.push(`${url}: ${message.slice(0, 120)}`);
      }
    }

    shop.lastCrawledAt = new Date();
    // Only priced rows are offers; the rest are bookkeeping so the crawl can
    // converge instead of retrying the same dead ends.
    shop.offerCount = await this.offers.count({
      where: { shopId: shop.id, price: Not(IsNull()) },
    });
    shop.lastError = this.describeFailures(failures);
    // Progress, not just achievement: pages read out of pages known. Without
    // the denominator "115 indexed" is unreadable.
    shop.cataloguePages = needle ? shop.cataloguePages : urls.length;
    shop.pagesSeen = await this.offers.count({ where: { shopId: shop.id } });
    await this.shops.save(shop);

    if (problems.length) {
      this.logger.warn(`${shop.host}: ${problems.length} problem pages, e.g. ${problems[0]}`);
    }

    const remaining = Math.max(0, urls.length - seenAt.size - queue.length);

    return {
      shopId: shop.id,
      host: shop.host,
      sitemapUrls: urls.length,
      attempted: queue.length,
      indexed,
      skipped,
      failed,
      remaining,
      offerCount: shop.offerCount,
      durationMs: Date.now() - startedAt,
      problems,
    };
  }

  /**
   * Turns a batch of failures into one sentence worth reading.
   *
   * "1 страници с грешка" was both ungrammatical and useless: it said that
   * something went wrong without saying what, so the only way to find out was
   * to read the server log. The reason and an example address are what make it
   * actionable — a 403 is a shop refusing us, a timeout is a slow server, and
   * they call for different responses.
   */
  private describeFailures(failures: Array<{ url: string; message: string }>): string | null {
    if (failures.length === 0) return null;

    // The dominant reason, not the last one: twelve timeouts and one 404 is a
    // timeout problem.
    const tally = new Map<string, number>();
    failures.forEach((failure) => {
      const reason = this.shortReason(failure.message);
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    });

    const [reason] = Array.from(tally.entries()).sort((a, b) => b[1] - a[1])[0];
    const noun = failures.length === 1 ? 'страница' : 'страници';
    const verb = failures.length === 1 ? 'не се прочете' : 'не се прочетоха';
    const path = this.pathOf(failures[0].url);

    return `${failures.length} ${noun} ${verb} — ${reason}${path ? ` (напр. ${path})` : ''}`;
  }

  /** The gist of a fetch error, in words a shop owner can act on. */
  private shortReason(message: string): string {
    const status = /HTTP (\d{3})/.exec(message);

    if (status) {
      const code = status[1];
      if (code === '403') return 'магазинът отказа достъп (HTTP 403)';
      if (code === '404') return 'страницата вече я няма (HTTP 404)';
      if (code === '429') return 'магазинът ни ограничава (HTTP 429)';
      if (code.startsWith('5')) return `проблем при магазина (HTTP ${code})`;
      return `HTTP ${code}`;
    }

    // "Timed out after 5000ms" and "timeout of 5000ms exceeded" are the same
    // thing said two ways; matching only one of them is how a clear message
    // degrades into the raw error again.
    if (/tim(e|ed)\s*out|ETIMEDOUT|aborted|ECONNRESET/i.test(message)) {
      const ms = /(\d+)\s*ms/.exec(message);
      return ms
        ? `магазинът не отговори за ${(Number(ms[1]) / 1000).toFixed(0)} сек`
        : 'магазинът не отговори навреме';
    }
    if (/robots/i.test(message)) return 'robots.txt не позволява';
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(message)) return 'адресът не се намери';
    if (/content-type/i.test(message)) return 'страницата не е HTML';
    if (/too large/i.test(message)) return 'страницата е прекалено голяма';

    return message.split('.')[0].slice(0, 80);
  }

  private pathOf(url: string): string {
    try {
      return decodeURIComponent(new URL(url).pathname).slice(0, 60);
    } catch {
      return '';
    }
  }

  /**
   * Orders URLs so the ones most likely to be products go first.
   *
   * A product slug carries a model number: digits, several hyphens, some
   * length. `lampa-led-5we144000k400lmtmtlb-c37-5w` scores well;
   * `осветителна-техника` does not. Only an ordering — a page that defies the
   * guess still gets crawled, just later.
   */
  private productFirst(urls: string[]): string[] {
    const score = (url: string): number => {
      const slug = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).pop() ?? '';
      const hyphens = (slug.match(/-/g) ?? []).length;
      const digits = (slug.match(/\d/g) ?? []).length;

      return (digits > 0 ? 2 : 0) + (hyphens >= 3 ? 2 : 0) + (slug.length > 25 ? 1 : 0);
    };

    return urls
      .map((url) => ({ url, score: score(url) }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.url);
  }

  /**
   * Full-text search across every indexed shop, cheapest first.
   *
   * The ordering is done here rather than in SQL because "cheapest" is not the
   * `price` column: it is the price after this customer's discount, converted
   * to one currency. Sorting by the raw column would put a shop with a 30 %
   * discount below one without.
   */
  async search(query: SearchOffersDto): Promise<OfferHitDto[]> {
    const term = query.q.trim();
    if (term.length < 2) return [];

    const builder = this.offers
      .createQueryBuilder('offer')
      .innerJoinAndSelect('offer.shop', 'shop')
      // Both sides go through the same homoglyph folding, and the expression
      // matches `idx_offers_search` exactly so the GIN index is actually used.
      // Shops write "Е27" in Cyrillic; buyers type "E27" in Latin.
      .where(
        `to_tsvector('simple', translate(lower(coalesce(offer.name, '') || ' ' || coalesce(offer.shop_code, '')), '${HOMOGLYPH_FROM}', '${HOMOGLYPH_TO}'))
         @@ plainto_tsquery('simple', translate(lower(:term), '${HOMOGLYPH_FROM}', '${HOMOGLYPH_TO}'))`,
        { term },
      )
      .andWhere('offer.price IS NOT NULL')
      .andWhere('shop.is_active = true');

    if (query.shopId) builder.andWhere('offer.shop_id = :shopId', { shopId: query.shopId });
    if (query.inStockOnly) builder.andWhere('offer.in_stock IS NOT FALSE');

    // Enough rows to sort meaningfully once discounts are applied, without
    // pulling a whole catalogue into memory.
    const rows = await builder.take(300).getMany();
    const target = (query.currency ?? 'EUR').toUpperCase();

    const hits = rows.map((offer) => this.toHit(offer, target));

    // Offers we cannot express in the target currency keep their place at the
    // end rather than being dropped: the price is real, the comparison is not.
    const byPrice = (a: OfferHitDto, b: OfferHitDto): number => {
      if (a.effectivePrice === null) return 1;
      if (b.effectivePrice === null) return -1;
      return a.effectivePrice - b.effectivePrice;
    };

    hits.sort(byPrice);

    // Keep each kind of article together, cheapest group first, so the UI can
    // show a price range per group. A single range across "cable" and "cable
    // reel" is not a comparison — it is a misreading waiting to happen.
    const groups = new Map<string, OfferHitDto[]>();
    for (const hit of hits) {
      const bucket = groups.get(hit.groupKey);
      if (bucket) bucket.push(hit);
      else groups.set(hit.groupKey, [hit]);
    }

    return [...groups.values()]
      .sort((a, b) => byPrice(a[0], b[0]))
      .flat()
      .slice(0, query.limit ?? 40);
  }

  /**
   * Finds pages the index does not have yet, by reading the sitemap.
   *
   * The catalogue does not have to be fully crawled to be fully *searchable*.
   * A shop's sitemap already names every product — `luna-fiksxrom37152argus`
   * is in the URL — so matching the query against the slugs finds anything in
   * the catalogue instantly, without fetching a page. Only the price is
   * missing, and that is one request away when the user asks for it.
   *
   * This is what makes "search every product" true on day one instead of after
   * a night of crawling.
   */
  async suggest(query: string, limit = 12): Promise<SuggestionDto[]> {
    // Transliteration only — *not* homoglyph folding, which runs first for the
    // full-text search. Folding turns Cyrillic "у" into Latin "y" and "н" into
    // "h", and transliteration can no longer tell they were Cyrillic: "луна"
    // came out as "lyha" and matched nothing. Transliteration handles every
    // Cyrillic letter properly on its own, homoglyphs included.
    const words = this.transliterate(query)
      .split(/[\s,./-]+/)
      .filter((word) => word.length > 2);

    if (words.length === 0) return [];

    const active = await this.shops.find({ where: { isActive: true } });
    const suggestions: SuggestionDto[] = [];

    for (const shop of active) {
      if (!shop.sitemapUrl) continue;

      let urls: string[];
      try {
        urls = await this.sitemapUrls(shop);
      } catch {
        continue;
      }

      const known = new Set(
        (await this.offers.find({ where: { shopId: shop.id }, select: { url: true } })).map(
          (offer) => offer.url,
        ),
      );

      const matches = urls
        .filter((url) => !known.has(url))
        .map((url) => ({
          url,
          // Punctuation removed on both sides: "ФИКС.МАТ.ХРОМ" is "fiksmatxrom"
          // in the slug, with the dots gone.
          slug: this.transliterate(this.nameFromUrl(url)).replace(/[\s,./-]+/g, ''),
        }))
        .filter((entry) => words.every((word) => entry.slug.includes(word)))
        .slice(0, limit);

      matches.forEach((match) => {
        suggestions.push({
          shopId: shop.id,
          shopName: shop.name,
          url: match.url,
          guessedName: this.nameFromUrl(match.url),
        });
      });

      if (suggestions.length >= limit) break;
    }

    return suggestions.slice(0, limit);
  }

  /**
   * Fetches and indexes specific pages, now.
   *
   * The companion to {@link suggest}: the user has seen candidates found in
   * the sitemap and asked what they cost. Bounded hard — this runs while
   * somebody waits.
   */
  async indexNow(urls: string[]): Promise<OfferHitDto[]> {
    const active = await this.shops.find({ where: { isActive: true } });
    const byHost = new Map(active.map((shop) => [shop.host, shop]));

    for (const url of urls.slice(0, 10)) {
      let shop: Shop | undefined;
      try {
        shop = byHost.get(new URL(url).host.replace(/^www\./, ''));
      } catch {
        continue;
      }
      if (!shop) continue;

      try {
        const observation = await this.priceSource.fetch({
          url,
          host: shop.host,
          selector: null,
          attribute: null,
          lastPrice: null,
          currency: shop.currency,
        });

        await this.upsert(shop, url, observation);
      } catch (error) {
        await this.recordNonOffer(
          shop,
          url,
          error instanceof Error ? error.message : String(error),
        );
      }

      shop.offerCount = await this.offers.count({
        where: { shopId: shop.id, price: Not(IsNull()) },
      });
      await this.shops.save(shop);
    }

    const rows = await this.offers.find({
      where: urls.slice(0, 10).map((url) => ({ url })),
      relations: { shop: true },
    });

    return rows.filter((offer) => offer.price !== null).map((offer) => this.toHit(offer, 'EUR'));
  }

  /**
   * One offer as the dashboard sees it.
   *
   * The discount is applied here, in the only place it is applied, so a hit
   * from a search and a hit from an on-demand fetch can never disagree about
   * what the customer pays.
   */
  /**
   * Works out which *kind* of article an offer is, so that only comparable
   * things end up in one price range.
   *
   * Searching "кабел" returns bare cable at 0.14 €/m, a cable reel at 19 € and
   * a connector with a 3 m lead. Presenting "from 0.14 to 19.10" across those
   * implies they are competing offers for one product. They are not, and a
   * buyer reading that range draws exactly the wrong conclusion.
   *
   * The grouping signals, strongest first:
   *  - a model code (H05V-K, ПВ-А2, ST9453B) — the closest thing to an identity
   *    these catalogues carry;
   *  - the leading noun of the name, which is what separates КАБЕЛ from МАКАРА
   *    from СЪЕД(инител).
   */
  private groupOf(name: string): { key: string; label: string } {
    const cleaned = (name || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return { key: 'other', label: 'Други' };

    // "СЪЕД.5+КЛЮЧ" and "КАБЕЛ" both end at the first separator.
    const head = cleaned.split(/[\s./,+]/)[0].toUpperCase();

    // A model code mixes letters and digits and is at least four characters —
    // H05V-K, ST9453B, PV-A2. Plain words and pure numbers are not codes.
    const code = cleaned
      .toUpperCase()
      .split(/[\s,/]+/)
      .find(
        (token) =>
          token.length >= 4 &&
          /[A-ZА-Я]/.test(token) &&
          /\d/.test(token) &&
          !/^\d+(MM2|ММ2|M|М|CM|СМ)$/.test(token) &&
          // "СЪЕД.5+КЛЮЧ" would otherwise be read as the code of "СЪЕД",
          // producing the label "СЪЕД СЪЕД.5+КЛЮЧ".
          !token.startsWith(head),
      );

    const label = code ? `${head} ${code}` : head;
    return { key: label.toLowerCase(), label };
  }

  private toHit(offer: Offer, target: string): OfferHitDto {
    const shop = offer.shop!;
    const listed = offer.price ?? 0;
    const discounted = listed * (1 - Number(shop.discountPercent) / 100);

    const convertible = isConvertible(offer.currency, target);
    const effective = convertible ? convert(discounted, offer.currency, target) : null;

    const group = this.groupOf(offer.name ?? '');

    return {
      groupKey: group.key,
      groupLabel: group.label,
      offerId: offer.id,
      shopId: shop.id,
      shopName: shop.name,
      host: shop.host,
      name: offer.name,
      url: offer.url,
      shopCode: offer.shopCode,
      imageUrl: offer.imageUrl,
      listedPrice: listed,
      listedCurrency: offer.currency,
      discountPercent: Number(shop.discountPercent),
      effectivePrice: effective,
      effectiveCurrency: convertible ? target : offer.currency,
      inStock: offer.inStock,
      lastSeenAt: offer.lastSeenAt ? offer.lastSeenAt.toISOString() : null,
    };
  }

  /** Cyrillic letters that look Latin, folded onto their twins. */
  private foldHomoglyphs(text: string): string {
    let out = '';
    for (const letter of text) {
      const index = HOMOGLYPH_FROM.indexOf(letter);
      out += index === -1 ? letter : HOMOGLYPH_TO[index];
    }
    return out;
  }

  /**
   * Bulgarian written in Latin letters, the way URL slugs are.
   *
   * A shop's page is titled "ЛУНА ФИКС.МАТ.ХРОМ" and its address is
   * `/luna-fiksmatxrom…`, so matching a Cyrillic query against a slug needs
   * the query transliterated first — otherwise the whole catalogue is
   * invisible to anyone typing in their own alphabet.
   *
   * `x` and `h` are folded together at the end because both are used for `х`,
   * and which one a shop chose is not knowable in advance: TMT writes "xrom",
   * the official standard says "hrom".
   */
  private transliterate(text: string): string {
    const map: Record<string, string> = {
      а: 'a',
      б: 'b',
      в: 'v',
      г: 'g',
      д: 'd',
      е: 'e',
      ж: 'zh',
      з: 'z',
      и: 'i',
      й: 'y',
      к: 'k',
      л: 'l',
      м: 'm',
      н: 'n',
      о: 'o',
      п: 'p',
      р: 'r',
      с: 's',
      т: 't',
      у: 'u',
      ф: 'f',
      х: 'h',
      ц: 'ts',
      ч: 'ch',
      ш: 'sh',
      щ: 'sht',
      ъ: 'a',
      ь: 'y',
      ю: 'yu',
      я: 'ya',
    };

    let out = '';
    for (const letter of text.toLowerCase()) {
      out += map[letter] ?? letter;
    }

    return out.replace(/x/g, 'h');
  }

  private async sitemapUrls(shop: Shop): Promise<string[]> {
    const cached = this.sitemapCache.get(shop.id);
    if (cached && Date.now() - cached.fetchedAt < SITEMAP_CACHE_MS) return cached.urls;

    const all = await this.sitemap.collect(shop.sitemapUrl!);
    const urls = this.sitemap.filterProductLikely(all, shop.host);

    this.sitemapCache.set(shop.id, { urls, fetchedAt: Date.now() });
    this.logger.log(`${shop.host}: ${all.length} URLs in sitemap, ${urls.length} worth trying`);

    return urls;
  }

  private async upsert(
    shop: Shop,
    url: string,
    observation: {
      price: number;
      currency: string | null;
      inStock: boolean | null;
      imageUrl?: string | null;
      title?: string | null;
    },
  ): Promise<void> {
    const existing = await this.offers.findOne({ where: { shopId: shop.id, url } });

    // A real upsert, not find-then-save. Two workers reaching the same URL both
    // see "not found" and both insert, and the second violates
    // uq_offers_shop_url — which is exactly what the crawl log was full of.
    // `ON CONFLICT` makes the race a no-op instead of an error.
    await this.offers
      .createQueryBuilder()
      .insert()
      .into(Offer)
      .values({
        shopId: shop.id,
        url,
        // The page title is the product name; a sitemap URL slug is a fallback
        // that at least stays searchable when the page did not say.
        name: (observation.title ?? existing?.name ?? this.nameFromUrl(url)).slice(0, 500),
        price: observation.price,
        currency: observation.currency ?? shop.currency,
        inStock: observation.inStock,
        imageUrl: observation.imageUrl ?? existing?.imageUrl ?? null,
        lastSeenAt: new Date(),
        lastError: null,
      })
      .orUpdate(
        ['name', 'price', 'currency', 'in_stock', 'image_url', 'last_seen_at', 'last_error'],
        ['shop_id', 'url'],
      )
      .execute();
  }

  /**
   * Remembers a page that did not turn out to be an offer.
   *
   * Stored with a null price, which keeps it out of every search, and with
   * `lastSeenAt` set, which keeps it out of the next batch. Without this row
   * the crawl never converges: the same category page is unseen again
   * tomorrow, and again the day after.
   */
  private async recordNonOffer(shop: Shop, url: string, message: string): Promise<void> {
    const existing = await this.offers.findOne({ where: { shopId: shop.id, url } });
    const offer = existing ?? this.offers.create({ shopId: shop.id, url });

    offer.name = existing?.name ?? this.nameFromUrl(url);
    offer.price = null;
    offer.lastSeenAt = new Date();
    offer.lastError = message.slice(0, 500);

    await this.offers.save(offer);
  }

  /** "lampa-led-5w-e14" -> "lampa led 5w e14". Poor, but searchable. */
  private nameFromUrl(url: string): string {
    const slug = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).pop() ?? '';
    return slug.replace(/[-_]+/g, ' ').trim() || url;
  }
}
