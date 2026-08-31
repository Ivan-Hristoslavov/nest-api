import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';

import { Configuration, ScraperConfig, WebDiscoveryConfig } from '../config/configuration';
import { GenericProduct } from '../matching/product-model';
import { guardedAgents } from '../scraper/http/address-guard';
import { decodeHtml } from '../scraper/http/html-decoder';
import { HostRateLimiterService } from '../scraper/http/host-rate-limiter.service';
import { RobotsService } from '../scraper/http/robots.service';
import { InstalmentPlan, readInstalments } from '../scraper/parsers/instalments';
import { PriceParserService } from '../scraper/parsers/price-parser.service';
import { profileForHost } from '../scraper/parsers/site-profiles';
import { DiscoveredProductDto, ShopSearchResultDto } from './dto/discovery.dto';

/**
 * Finding the shops nobody told us about.
 *
 * "Everywhere" used to mean the four storefronts someone had configured, minus
 * the ones the buyer already had. That is a longer list, not the internet, and
 * it produced the search's most embarrassing answer: a polishing machine sold
 * openly at 114.99 € reported as unobtainable, because no configured shop
 * happened to stock it.
 *
 * This is the other retrieval strategy. It does not know any shops. It asks
 * the web where a part number is sold, and then — and this is the whole
 * discipline of the thing — it treats every address it gets back as a
 * **candidate and nothing more**. A search-engine result is not an offer. It
 * is a URL that has to be fetched, read, and put through exactly the same
 * matcher a configured supplier's rows go through.
 *
 * The model's prose is never read. Only the search tool's own result blocks
 * are harvested, so the model cannot assert that a page is the product — it
 * can only suggest where to look. Everything after that is arithmetic:
 * robots.txt, the rate limiter, the address guard, the price parser, the
 * deterministic ladder. The AI proposes; the pipeline disposes.
 */

/** One address the web suggested, before anybody has looked at it. */
export interface DiscoveredUrl {
  url: string;
  domain: string;
  /** The search engine's title, kept for the trace. Never used for matching. */
  title: string | null;
}

/** A page that was fetched and read. Still a candidate, not yet a match. */
export interface DiscoveredPage {
  url: string;
  domain: string;
  title: string;
  price: number | null;
  currency: string | null;
  inStock: boolean | null;
  /** What the shop will let you pay monthly, as it states it. */
  instalments: InstalmentPlan[];
}

/**
 * How many addresses one domain may contribute.
 *
 * A marketplace can fill an entire result page with its own variants of one
 * article. Three is enough to price it and leaves room for the shops that
 * would otherwise be crowded out — which are, for a part number, usually the
 * interesting ones.
 */
const MAX_PER_DOMAIN = 3;

/** Addresses that are a page about products rather than a product. */
const NOT_A_PRODUCT =
  /\/(search|catalogsearch|category|categories|collections?|blog|news|articles?|tag|tags|brand|brands|cart|checkout|account|login|contact|about)(\/|$|\?)/i;

@Injectable()
export class WebDiscoveryService {
  private readonly logger = new Logger(WebDiscoveryService.name);
  private readonly config: WebDiscoveryConfig;
  private readonly scraper: ScraperConfig;
  private readonly client: AxiosInstance;
  private readonly anthropic: Anthropic | null;

  constructor(
    private readonly robots: RobotsService,
    private readonly rateLimiter: HostRateLimiterService,
    private readonly parser: PriceParserService,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('webDiscovery', { infer: true });
    this.scraper = configService.get('scraper', { infer: true });

    this.anthropic = this.config.apiKey
      ? new Anthropic({ apiKey: this.config.apiKey, timeout: this.config.timeoutMs })
      : null;

    this.client = axios.create({
      timeout: Math.max(this.scraper.timeoutMs, 12000),
      maxRedirects: 5,
      // Every address here came from a search engine rather than from anyone
      // who works here, which makes the guard more important, not less: the
      // agents refuse to open a connection to this server's own network, and
      // they do it per connection, so each hop of a redirect is checked too.
      ...guardedAgents(),
      validateStatus: () => true,
      decompress: true,
      responseType: 'arraybuffer',
      maxContentLength: 8 * 1024 * 1024,
      headers: {
        'User-Agent': this.scraper.userAgent,
        Accept: 'text/html,application/xhtml+xml',
      },
    });
  }

  get enabled(): boolean {
    return this.config.enabled && this.anthropic !== null;
  }

  /**
   * Where the web says this is sold, read and priced.
   *
   * Returns one result row per domain, shaped exactly like a configured shop's
   * answer — so everything downstream, from ranking through matching to the
   * offer partition, runs unchanged and unaware that these shops were never
   * configured. That is the point: one pipeline, two retrieval strategies.
   */
  async discover(
    query: string,
    product: GenericProduct,
    /** Called with each page the moment it is read, not after all of them. */
    onFound?: (row: ShopSearchResultDto) => void,
  ): Promise<ShopSearchResultDto[]> {
    if (!this.enabled) return [];

    const startedAt = Date.now();

    let found: DiscoveredUrl[];
    try {
      found = await this.search(query, product);
    } catch (error) {
      // A failed discovery is a search that found less, never a search that
      // failed. The buyer's own suppliers have already answered by now.
      this.logger.warn(
        `Web discovery for "${query}" failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }

    const shortlist = this.shortlist(found);

    this.logger.log(
      `Web discovery "${query}": ${found.length} addresses, ` +
        `${shortlist.length} worth reading, ${Date.now() - startedAt}ms searching`,
    );

    /*
     * One row per page, handed over the moment that page is read.
     *
     * The pages are fetched concurrently and they do not finish together — a
     * fast shop answers in 200 ms and a slow one in three seconds. Collecting
     * them into a batch made every one of them as late as the slowest, for no
     * reason but the shape of `Promise.all`.
     */
    const rows = await Promise.all(
      shortlist.map(async (entry) => {
        const page = await this.read(entry);
        if (!page) return null;

        const row: ShopSearchResultDto = {
          host: page.domain,
          name: page.domain,
          searchUrl: '',
          ok: true,
          error: null,
          durationMs: Date.now() - startedAt,
          // Never one of the buyer's own. No negotiated discount applies, and
          // the price shown is the shelf price — which is the honest thing to
          // show for a shop nobody has an account with.
          isMine: false,
          products: [
            {
              title: page.title,
              url: page.url,
              price: page.price,
              currency: page.currency,
              host: page.domain,
              shopName: page.domain,
              priceSource: 'live',
              // Read off the page a moment ago and, until now, dropped here.
              inStock: page.inStock,
              instalments: page.instalments,
            },
          ],
        };

        onFound?.(row);
        return row;
      }),
    );

    return rows.filter((row): row is ShopSearchResultDto => row !== null);
  }

  /**
   * Asks the web where this part number is sold.
   *
   * The spellings are the ones the identifier itself justifies — the code as
   * typed, and the same code written the two other ways catalogues write it.
   * Nothing invented: a wrong variant is a wasted search and, worse, a wrong
   * product page fetched with confidence.
   */
  private async search(query: string, product: GenericProduct): Promise<DiscoveredUrl[]> {
    const codes = product.identifiers.modelCodes.slice(0, 1);
    const spellings = codes.flatMap((code) => identifierSpellings(code));

    const asked = [query, ...spellings].slice(0, this.config.maxSearches);

    const response = await this.anthropic!.messages.create({
      model: this.config.model,
      max_tokens: 2048,
      // Measured at sixteen seconds of a nineteen-second search, for a task
      // whose entire content is "run these three searches and stop". There is
      // nothing here to reason about — the reasoning happens afterwards, in
      // code, against the pages themselves — so the depth was pure latency.
      output_config: { effort: 'low' },
      // The model is a search operator, not a judge. It is told so plainly,
      // because a model asked "find this product" will happily report that it
      // found one.
      system:
        'You locate retail product pages. Run the web searches you are given and stop. ' +
        'Do not evaluate whether any result is the right product — something else does that. ' +
        'Do not summarise. Reply with the single word DONE.',
      messages: [
        {
          role: 'user',
          content:
            `Search for retail pages selling this product. Run one search per line:\n` +
            asked.map((spelling) => `${spelling} цена`).join('\n'),
        },
      ],
      tools: [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: this.config.maxSearches,
        },
      ],
    });

    const urls: DiscoveredUrl[] = [];

    // Harvested from the tool's own result blocks, never from what the model
    // wrote. The model cannot claim a page is the product; it can only cause a
    // search to happen, and the results of that search are data.
    for (const block of response.content) {
      if (block.type !== 'web_search_tool_result') continue;

      // A failed search returns an error object here rather than a list, and
      // indexing it would throw inside a feature that must degrade quietly.
      if (!Array.isArray(block.content)) {
        this.logger.warn(`Web search returned ${JSON.stringify(block.content).slice(0, 120)}`);
        continue;
      }

      for (const result of block.content) {
        if (result.type !== 'web_search_result') continue;

        const domain = domainOf(result.url);
        if (!domain) continue;

        urls.push({ url: result.url, domain, title: result.title ?? null });
      }
    }

    return urls;
  }

  /** The addresses worth spending a request on, best first. */
  private shortlist(found: DiscoveredUrl[]): DiscoveredUrl[] {
    const seen = new Set<string>();
    const perDomain = new Map<string, number>();
    const kept: DiscoveredUrl[] = [];

    for (const entry of found) {
      if (kept.length >= this.config.maxPages) break;
      if (seen.has(entry.url)) continue;
      // A category listing has no single price and no single article. Reading
      // one costs a request to learn nothing.
      if (NOT_A_PRODUCT.test(entry.url)) continue;

      const already = perDomain.get(entry.domain) ?? 0;
      if (already >= MAX_PER_DOMAIN) continue;

      seen.add(entry.url);
      perDomain.set(entry.domain, already + 1);
      kept.push(entry);
    }

    return kept;
  }

  /**
   * Fetches one address and reads the product off it.
   *
   * The page is the source of truth, not the search snippet. A snippet says
   * "Status XPA12-75"; the page says "Полирмашина вибрационна Status HD
   * XPA12-75, 750W, ф50мм/ф75мм" and states a price — and it is the page that
   * the matcher is entitled to judge.
   */
  private async read(entry: DiscoveredUrl): Promise<DiscoveredPage | null> {
    try {
      if (this.scraper.respectRobots) {
        const allowed = await this.robots.isAllowed(entry.url, this.scraper.userAgent);
        if (!allowed) return null;
      }

      const html = await this.rateLimiter.schedule(
        entry.domain,
        this.scraper.minDelayMs,
        async () => {
          const response = await this.client.get<Buffer>(entry.url);
          if (response.status >= 400) throw new Error(`HTTP ${response.status}`);

          return decodeHtml(
            Buffer.from(response.data),
            String(response.headers['content-type'] ?? ''),
          );
        },
      );

      const profile = profileForHost(entry.domain);
      const details = this.parser.parseDetails(html, profile, entry.url);
      const price = this.parser.parse(html, { profile });

      /*
       * Read from the same fetch, with the logos turned back into words.
       *
       * Shops write the lender as an image: mashini.bg renders "Купи с
       * [logo] на 12 вноски по 8.76 €", and the only thing naming TBI on that
       * line is `cdn.tbibank.support/logo/tbi-bank-white.svg`. Read as text
       * the sentence has a hole exactly where the bank should be — and the
       * bank is half of what makes a financing offer checkable.
       *
       * So each image is replaced, in place, by its alt text and its address.
       * The name lands at the position the logo occupied, which is what lets
       * the reader attribute the plan beside it rather than guessing from a
       * list of partners in the footer.
       *
       * Scripts and styles go first: a finance calculator's default figures
       * are not an offer this shop made about this article.
       */
      const $ = cheerio.load(html);
      $('script, style, noscript').remove();
      $('img').each((_, element) => {
        const image = $(element);
        const named = `${image.attr('alt') ?? ''} ${image.attr('src') ?? ''}`.trim();
        image.replaceWith(named ? ` ${named} ` : ' ');
      });

      const instalments = readInstalments($('body').text());

      // A page with no name is not a listing we can judge. The matcher works
      // on what a page says it is, and a page that says nothing cannot be
      // matched or refused honestly — so it never becomes a candidate.
      const title = details.title?.trim();
      if (!title) return null;

      return {
        url: entry.url,
        domain: entry.domain,
        title,
        price: price?.price ?? null,
        currency: price?.currency ?? null,
        inStock: price?.inStock ?? null,
        instalments,
      };
    } catch (error) {
      this.logger.debug(
        `Could not read ${entry.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

/**
 * The spellings of a part number that catalogues actually use.
 *
 * Three, and only three: the separator written as a hyphen, as a space, and
 * closed up. Every one of them is the same alphanumeric sequence — the
 * comparison {@link canonicalIdentifier} already makes — so none of them can
 * find a different article. Inventing further variants would search for part
 * numbers that do not exist and fetch pages with confidence in them.
 */
export function identifierSpellings(code: string): string[] {
  const trimmed = (code ?? '').trim();
  if (!trimmed) return [];

  const spellings = new Set<string>([trimmed]);

  if (/[-/\s]/.test(trimmed)) {
    spellings.add(trimmed.replace(/[-/\s]+/g, ' '));
    spellings.add(trimmed.replace(/[-/\s]+/g, ''));
  }

  return [...spellings];
}

/** The host of an address, without `www.`, or null when it is not one. */
export function domainOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
