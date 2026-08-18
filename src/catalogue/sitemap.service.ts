import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

import { Configuration, ScraperConfig } from '../config/configuration';
import { HostRateLimiterService } from '../scraper/http/host-rate-limiter.service';
import { RobotsService } from '../scraper/http/robots.service';

/** Nested sitemap indexes deeper than this are a loop, not a catalogue. */
const MAX_DEPTH = 3;

/** A catalogue larger than this is truncated rather than crawled forever. */
const MAX_URLS = 50_000;

@Injectable()
export class SitemapService {
  private readonly logger = new Logger(SitemapService.name);
  private readonly config: ScraperConfig;
  private readonly client: AxiosInstance;

  constructor(
    private readonly robots: RobotsService,
    private readonly rateLimiter: HostRateLimiterService,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('scraper', { infer: true });

    this.client = axios.create({
      timeout: Math.max(this.config.timeoutMs, 20000),
      maxRedirects: 5,
      validateStatus: () => true,
      decompress: true,
      responseType: 'text',
      headers: {
        'User-Agent': this.config.userAgent,
        Accept: 'application/xml,text/xml,*/*;q=0.8',
      },
    });
  }

  /**
   * Finds the sitemap a shop advertises in its own robots.txt.
   *
   * A `Sitemap:` line is the closest thing the web has to a written invitation:
   * the site is telling crawlers where its pages are. Falling back to the
   * conventional path only when no line is present.
   */
  async discover(host: string): Promise<string | null> {
    const robotsUrl = `https://${host}/robots.txt`;

    try {
      const response = await this.client.get<string>(robotsUrl);
      if (response.status < 400 && typeof response.data === 'string') {
        const match = /^\s*sitemap:\s*(\S+)/im.exec(response.data);
        if (match) return match[1];
      }
    } catch (error) {
      this.logger.debug(`No robots.txt for ${host}: ${(error as Error).message}`);
    }

    const guess = `https://${host}/sitemap.xml`;
    try {
      const response = await this.client.head(guess);
      if (response.status < 400) return guess;
    } catch {
      /* nothing there */
    }

    return null;
  }

  /**
   * Every URL a sitemap lists, following sitemap indexes.
   *
   * Robots is checked for the sitemap itself: a shop that disallows the path
   * is not asking to be read from it, invitation elsewhere or not.
   */
  async collect(sitemapUrl: string, depth = 0): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];

    const host = new URL(sitemapUrl).host;

    if (this.config.respectRobots) {
      const allowed = await this.robots.isAllowed(sitemapUrl, this.config.userAgent);
      if (!allowed) {
        throw new Error(`robots.txt забранява четенето на ${sitemapUrl}`);
      }
    }

    const xml = await this.rateLimiter.schedule(host, this.config.minDelayMs, async () => {
      const response = await this.client.get<string>(sitemapUrl);
      if (response.status >= 400) throw new Error(`HTTP ${response.status} за ${sitemapUrl}`);
      return String(response.data);
    });

    const locations = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map(
      (match) => match[1],
    );

    // Follow anything that points at another sitemap, whatever the wrapper
    // element says.
    //
    // The specification distinguishes `<sitemapindex>` from `<urlset>`, and
    // trusting that distinction was wrong: homefinishing.bg publishes a
    // `<urlset>` whose entries are `sitemap-pages.xml`, `sitemap-categories.xml`
    // and six more. Read by the book, that shop has eight pages and no
    // products. What the target *is* matters more than how it was labelled.
    // Any XML target is another sitemap, whatever it is called. Requiring the
    // word "sitemap" in the filename looked safe until bg.elmarkstore.eu, whose
    // index points at `bg-elmarkstore-eu-bg.xml`: that was read as a product
    // page and fetched as 3.7 MB of XML the price parser could make nothing of.
    // Product pages are not .xml, so the extension is the reliable signal.
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

  /**
   * Narrows a sitemap down to the pages worth fetching.
   *
   * Sitemaps list the home page, the category tree, contact and terms as
   * readily as products, and there is no marker distinguishing them — TMT's
   * product URLs look like `/lampa-led-5w…` and its categories like
   * `/осветителна-техника`. So this only removes what is *certainly* not a
   * product; the crawler decides the rest by whether a page yields a price.
   */
  filterProductLikely(urls: string[], host: string): string[] {
    const seen = new Set<string>();

    return urls.filter((url) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }

      if (parsed.host.replace(/^www\./, '') !== host.replace(/^www\./, '')) return false;

      const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, '');
      if (path.length < 2) return false;

      if (
        /(login|register|account|cart|checkout|wishlist|compare|contact|about|terms|privacy|blog|news|search|sitemap|customer|order)/i.test(
          path,
        )
      ) {
        return false;
      }

      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }
}
