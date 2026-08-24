import { guardedAgents } from '../scraper/http/address-guard';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

import { Configuration, ScraperConfig } from '../config/configuration';
import { HostRateLimiterService } from '../scraper/http/host-rate-limiter.service';
import { RobotsService } from '../scraper/http/robots.service';

/** Nested sitemap indexes deeper than this are a loop, not a catalogue. */
const MAX_DEPTH = 3;

/** A catalogue larger than this is truncated rather than read forever. */
const MAX_URLS = 50_000;

/** A sitemap is a megabyte of XML; re-read it at most this often. */
const CACHE_MS = 60 * 60 * 1000;

interface CachedSitemap {
  urls: string[];
  fetchedAt: number;
}

/**
 * Finding products at a shop whose search we are not allowed to use.
 *
 * tmt-elkom.com publishes `Disallow: /search?` — their search is off limits,
 * and that is their decision. Their sitemap, however, is *advertised* in the
 * same robots.txt, and their product pages are not disallowed at all. The
 * sitemap names every article in the URL itself:
 *
 *     /kabel-svt-do-1-mm2-vkl
 *     /kabel-svt-nad-35-mm2
 *
 * So "СВТ" is answerable without touching their search: match the query
 * against the slugs, then fetch only the pages that matched.
 *
 * **This is not the crawl that was removed.** That one read all 7553 pages
 * whatever anyone asked, took four hours and produced nothing. This reads the
 * sitemap once an hour — one request — and then fetches a *bounded handful* of
 * pages per question. Three different searches against this shop cost 25
 * requests, not 7553, and the cost is set by what you asked rather than by how
 * large their catalogue happens to be.
 *
 * The limitation is honest: it matches on the address, not the description. A
 * product whose name is absent from its own URL will not be found this way.
 * Checking otherwise would mean fetching pages to see what is on them, which
 * is the crawl again.
 */
@Injectable()
export class SitemapLookupService {
  private readonly logger = new Logger(SitemapLookupService.name);
  private readonly config: ScraperConfig;
  private readonly client: AxiosInstance;
  private readonly cache = new Map<string, CachedSitemap>();
  /** In-flight reads, so ten searches at once cause one fetch, not ten. */
  private readonly inFlight = new Map<string, Promise<string[]>>();

  constructor(
    private readonly robots: RobotsService,
    private readonly rateLimiter: HostRateLimiterService,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('scraper', { infer: true });

    this.client = axios.create({
      timeout: Math.max(this.config.timeoutMs, 20000),
      maxRedirects: 5,
      // Every address here was typed by a customer. The agents refuse to
      // open a connection to this server's own network, and they do it per
      // connection — so each hop of a redirect is checked too.
      ...guardedAgents(),

      validateStatus: () => true,
      decompress: true,
      responseType: 'text',
      maxContentLength: 50 * 1024 * 1024,
      headers: {
        'User-Agent': this.config.userAgent,
        Accept: 'application/xml,text/xml,*/*;q=0.8',
      },
    });
  }

  /**
   * Product pages at `host` whose address mentions the query, best first.
   *
   * Returns at most `limit` — the caller fetches every one of them, and a
   * person is waiting.
   */
  async find(host: string, query: string, limit = 8): Promise<string[]> {
    const words = queryWords(query);
    if (words.length === 0) return [];

    const urls = await this.urlsFor(host);
    if (urls.length === 0) return [];

    const scored: Array<{ url: string; score: number; length: number }> = [];

    for (const url of urls) {
      const slug = slugOf(url);
      if (!slug) continue;

      // Every word must appear. "кабел свт" should not return every cable in
      // the catalogue because one of the two words matched.
      let score = 0;
      for (const word of words) {
        if (!slug.includes(word)) {
          score = -1;
          break;
        }
        score += 1;
      }

      if (score > 0) scored.push({ url, score, length: slug.length });
    }

    // More words matched first; then the shorter slug, which is the more
    // specific product rather than a variant with a longer name.
    scored.sort((a, b) => b.score - a.score || a.length - b.length);

    this.logger.log(
      `${host}: "${query}" matches ${scored.length} sitemap addresses, reading ${Math.min(scored.length, limit)}`,
    );

    return scored.slice(0, limit).map((entry) => entry.url);
  }

  /** Addresses already read for this host, without triggering a read. */
  cachedUrls(host: string): string[] {
    return this.cache.get(host)?.urls ?? [];
  }

  /** Ensures the sitemap for this host is read and cached. */
  async warm(host: string): Promise<string[]> {
    return this.urlsFor(host);
  }

  /** How many addresses mention the query, without fetching any of them. */
  async count(host: string, query: string): Promise<number> {
    const words = queryWords(query);
    if (words.length === 0) return 0;

    const urls = await this.urlsFor(host);
    return urls.filter((url) => {
      const slug = slugOf(url);
      return slug && words.every((word) => slug.includes(word));
    }).length;
  }

  private async urlsFor(host: string): Promise<string[]> {
    const cached = this.cache.get(host);
    if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.urls;

    const pending = this.inFlight.get(host);
    if (pending) return pending;

    const read = this.read(host).finally(() => this.inFlight.delete(host));
    this.inFlight.set(host, read);
    return read;
  }

  private async read(host: string): Promise<string[]> {
    try {
      const sitemapUrl = await this.discover(host);
      if (!sitemapUrl) {
        this.cache.set(host, { urls: [], fetchedAt: Date.now() });
        return [];
      }

      const urls = await this.collect(sitemapUrl);
      const products = urls.filter((url) => sameHost(url, host) && looksLikeProduct(url));

      this.cache.set(host, { urls: products, fetchedAt: Date.now() });
      this.logger.log(`${host}: sitemap holds ${urls.length} addresses, ${products.length} usable`);

      return products;
    } catch (error) {
      // A shop with no readable sitemap simply has no results this way. Cached
      // as empty so a broken sitemap is not re-fetched on every keystroke.
      this.logger.warn(`${host}: sitemap unavailable — ${(error as Error).message}`);
      this.cache.set(host, { urls: [], fetchedAt: Date.now() });
      return [];
    }
  }

  /**
   * The sitemap a shop advertises in its own robots.txt.
   *
   * A `Sitemap:` line is the closest thing the web has to a written
   * invitation: the site is saying where its pages are listed.
   */
  private async discover(host: string): Promise<string | null> {
    for (const candidate of [`https://${host}/robots.txt`, `https://www.${host}/robots.txt`]) {
      try {
        const response = await this.client.get<string>(candidate);
        if (response.status < 400 && typeof response.data === 'string') {
          const match = /^\s*sitemap:\s*(\S+)/im.exec(response.data);
          if (match) return match[1];
        }
      } catch {
        /* try the next spelling */
      }
    }

    for (const guess of [`https://${host}/sitemap.xml`, `https://www.${host}/sitemap.xml`]) {
      try {
        const response = await this.client.head(guess);
        if (response.status < 400) return guess;
      } catch {
        /* nothing there */
      }
    }

    return null;
  }

  /** Every URL a sitemap lists, following sitemap indexes. */
  private async collect(sitemapUrl: string, depth = 0): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];

    const host = new URL(sitemapUrl).host;

    if (this.config.respectRobots) {
      const allowed = await this.robots.isAllowed(sitemapUrl, this.config.userAgent);
      if (!allowed) throw new Error(`robots.txt забранява четенето на ${sitemapUrl}`);
    }

    const xml = await this.rateLimiter.schedule(host, this.config.minDelayMs, async () => {
      const response = await this.client.get<string>(sitemapUrl);
      if (response.status >= 400) throw new Error(`HTTP ${response.status} за ${sitemapUrl}`);
      return String(response.data);
    });

    const locations = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]);

    // What the target *is* matters more than how it was labelled.
    // homefinishing.bg publishes a `<urlset>` whose entries are themselves
    // sitemaps; bg.elmarkstore.eu names a child `bg-elmarkstore-eu-bg.xml`,
    // with no "sitemap" in the filename. Product pages are not .xml, so the
    // extension is the reliable signal.
    const isSitemap = (url: string): boolean =>
      /\.xml(\.gz)?(\?.*)?$/i.test(url) || /\/sitemap[^/]*$/i.test(url);

    const children = locations.filter(isSitemap);
    const pages = locations.filter((url) => !isSitemap(url));

    if (children.length === 0) return pages.slice(0, MAX_URLS);

    const collected = [...pages];

    for (const child of children.slice(0, 50)) {
      try {
        collected.push(...(await this.collect(child, depth + 1)));
      } catch (error) {
        this.logger.warn(`Nested sitemap ${child} failed: ${(error as Error).message}`);
      }
      if (collected.length >= MAX_URLS) break;
    }

    return collected.slice(0, MAX_URLS);
  }
}

/** Bulgarian written in Latin letters, the way URL slugs are. */
const CYRILLIC_TO_LATIN: Record<string, string> = {
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

/**
 * A query in the alphabet the slugs are written in.
 *
 * The shop titles a page "КАБЕЛ СВТ" and addresses it `/kabel-svt-…`, so a
 * Cyrillic query has to be transliterated before it can match anything. `x` is
 * folded to `h` at the end because both are used for `х` and which one a shop
 * chose is not knowable in advance: TMT writes "xrom", the official standard
 * says "hrom".
 */
export function transliterate(text: string): string {
  let out = '';
  for (const letter of text.toLowerCase()) {
    out += CYRILLIC_TO_LATIN[letter] ?? letter;
  }
  return out.replace(/x/g, 'h');
}

/** The words worth matching on. Shorter ones match half the catalogue. */
export function queryWords(query: string): string[] {
  return Array.from(
    new Set(
      transliterate(query)
        .split(/[\s,./_-]+/)
        .map((word) => word.replace(/[^a-z0-9]/g, ''))
        .filter((word) => word.length >= 3),
    ),
  );
}

/** The address, transliterated and stripped, ready to match a query against. */
export function slugOf(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    return transliterate(path).replace(/[^a-z0-9]+/g, '');
  } catch {
    return '';
  }
}

function sameHost(url: string, host: string): boolean {
  try {
    return new URL(url).host.replace(/^www\./, '') === host.replace(/^www\./, '');
  } catch {
    return false;
  }
}

/**
 * Removes what is certainly not a product.
 *
 * Only the certain cases: a sitemap lists the home page, the category tree and
 * the terms of service beside its products, and there is no marker separating
 * them — TMT's product URLs look like `/kabel-svt-…` and its categories like
 * `/osvetitelna-tehnika`. Whether the rest is a product is decided by whether
 * the page yields a price.
 */
function looksLikeProduct(url: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
  } catch {
    return false;
  }

  if (path.length < 2) return false;

  return !/(login|register|account|cart|checkout|wishlist|compare|contact|about|terms|privacy|policy|cookie|blog|news|search|customer|order|sitemap|delivery|payment)/i.test(
    path,
  );
}

/** "kabel-svt-do-1-mm2" -> "kabel svt do 1 mm2". Poor, but readable. */
export function nameFromUrl(url: string): string {
  try {
    const slug = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean).pop() ?? '';
    return slug.replace(/[-_]+/g, ' ').trim() || url;
  } catch {
    return url;
  }
}
