import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Configuration, ScraperConfig } from '../config/configuration';
import { RobotsService } from '../scraper/http/robots.service';
import { DetectedShop, SearchDetectorService } from './search-detector.service';
import { searchProviderFor } from './search-providers';
import { SitemapLookupService, slugOf } from './sitemap-lookup.service';

/** How a shop's products get found. */
export type SearchMethod = 'live' | 'sitemap' | 'none';

export interface ProbeResult {
  host: string;
  method: SearchMethod;
  /** Plain-language account of what was tried and what happened. */
  summary: string;
  /** Why live search is unavailable, when it is not. */
  reason: string | null;
  /** Configuration to save, when live search was worked out. */
  detected: DetectedShop | null;
  /** Product addresses the sitemap offers, when that is the route. */
  sitemapUrls: number;
  durationMs: number;
}

/**
 * The search paths storefronts actually use, in rough order of how common they
 * are in this market. `{q}` is the query.
 *
 * Tried in order and stopped at the first that returns a readable list of
 * products, so a shop on the common Magento path costs two requests to
 * identify rather than seven.
 */
const CANDIDATE_TEMPLATES = [
  'https://{host}/search?q={q}',
  'https://{host}/catalogsearch/result/?q={q}',
  'https://{host}/?s={q}',
  'https://{host}/search/{q}',
  'https://{host}/search?search={q}',
  'https://{host}/search.php?s={q}',
  'https://{host}/index.php?route=product/search&search={q}',
];

/**
 * Works out, once, how a newly added shop can be searched.
 *
 * The order is by what serves the user best, which here is also fastest:
 *
 *  1. **The shop's own search.** One request per question, current stock,
 *     and it understands synonyms no URL ever will.
 *  2. **The sitemap.** For a shop that forbids its search — tmt-elkom.com
 *     publishes `Disallow: /search?` — but lists its pages and leaves the
 *     product pages open. Slower, because matching addresses only tells you
 *     which pages to read, and reading them takes a request each.
 *  3. **Neither**, said plainly. A shop with a JavaScript-rendered search and
 *     no sitemap cannot be searched by any means available here, and saying so
 *     beats leaving an empty row the user keeps re-testing.
 *
 * The probe costs a handful of requests once, at the moment a shop is added,
 * and saves the user working any of this out themselves.
 */
@Injectable()
export class ShopProbeService {
  private readonly logger = new Logger(ShopProbeService.name);

  private readonly config: ScraperConfig;

  constructor(
    private readonly detector: SearchDetectorService,
    private readonly sitemap: SitemapLookupService,
    private readonly robots: RobotsService,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('scraper', { infer: true });
  }

  async probe(host: string): Promise<ProbeResult> {
    const startedAt = Date.now();
    const clean = host.replace(/^www\./, '').toLowerCase();

    // A configuration we already ship and have verified by hand beats anything
    // guessed here — but only if the shop still permits the search. The
    // shipped entry for tmt-elkom.com exists because its *product* pages are
    // readable; its robots.txt has always said `Disallow: /search?`, and
    // taking the shipped entry as proof of a usable search declared that shop
    // live-searchable while every search it ran was refused.
    const shipped = searchProviderFor(clean);

    if (shipped && (await this.searchAllowed(shipped.searchUrl('test')))) {
      return {
        host: clean,
        method: 'live',
        summary: 'Разпознат магазин — търси се директно през търсачката му.',
        reason: null,
        detected: null,
        sitemapUrls: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    // The sitemap is read first even though live search is preferred: it is
    // one request, it supplies a word this shop demonstrably stocks, and
    // probing a search with a word the shop does not sell proves nothing.
    const sample = await this.sampleWord(clean);

    const detected = sample ? await this.tryLiveSearch(clean, sample) : null;

    if (detected) {
      this.logger.log(`${clean}: live search works via ${detected.urlTemplate}`);

      return {
        host: clean,
        method: 'live',
        summary:
          `Търсачката на магазина работи — питаме нея. ` +
          `Проверено с „${sample}": ${detected.samples.length} резултата.`,
        reason: null,
        detected,
        sitemapUrls: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const count = await this.sitemapSize(clean);

    if (count > 0) {
      return {
        host: clean,
        method: 'sitemap',
        summary:
          `Търсачката на магазина не може да се ползва, но има карта на сайта с ${count} ` +
          `${count === 1 ? 'адрес' : 'адреса'}. Търсим по нея — по-бавно, но работи.`,
        reason: 'търсачката не е достъпна — търсим през картата на сайта',
        detected: null,
        sitemapUrls: count,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      host: clean,
      method: 'none',
      summary:
        'Този магазин не може да се търси автоматично: търсачката му не е достъпна и няма ' +
        'карта на сайта. Артикули оттам се следят, като поставите линка на продукта.',
      reason: 'няма достъпна търсачка, няма карта на сайта',
      detected: null,
      sitemapUrls: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Whether robots.txt permits searching at this address. */
  private async searchAllowed(url: string): Promise<boolean> {
    if (!this.config.respectRobots) return true;

    try {
      return await this.robots.isAllowed(url, this.config.userAgent);
    } catch {
      // A robots file we cannot read is not a refusal.
      return true;
    }
  }

  /**
   * A word this shop is known to stock, taken from its own addresses.
   *
   * Probing a search box needs a query, and a wrong guess makes a working
   * search look broken: ask an electrical wholesaler for "телефон" and the
   * empty page is indistinguishable from a search that does not function. The
   * most common word in the shop's own URLs is, by construction, something it
   * sells a lot of.
   */
  private async sampleWord(host: string): Promise<string | null> {
    const urls = await this.sitemapUrls(host);
    if (urls.length === 0) return null;

    const counts = new Map<string, number>();

    for (const url of urls.slice(0, 4000)) {
      const seen = new Set<string>();

      for (const word of slugOf(url).match(/[a-z]{4,12}/g) ?? []) {
        if (seen.has(word)) continue;
        seen.add(word);
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }

    const best = [...counts.entries()]
      // A word in nearly every address is boilerplate ("product", "bg"), not a
      // thing the shop sells.
      .filter(([, n]) => n < urls.length * 0.6)
      .sort((a, b) => b[1] - a[1])[0];

    return best ? best[0] : null;
  }

  /** Tries the common search paths and returns the first that reads. */
  private async tryLiveSearch(host: string, sample: string): Promise<DetectedShop | null> {
    for (const template of CANDIDATE_TEMPLATES) {
      const url = template.replace('{host}', host).replace('{q}', encodeURIComponent(sample));

      try {
        if (!(await this.searchAllowed(url))) continue;

        const detected = await this.detector.detect(url, sample);

        // A guess this weak is worse than the sitemap, which at least matches
        // on something the shop wrote itself.
        if (detected.samples.length >= 3 && detected.confidence >= 0.4) return detected;
      } catch {
        // This path is not the shop's search. Try the next.
      }
    }

    return null;
  }

  private async sitemapUrls(host: string): Promise<string[]> {
    return this.sitemap.warm(host).catch(() => []);
  }

  private async sitemapSize(host: string): Promise<number> {
    return (await this.sitemapUrls(host)).length;
  }
}
