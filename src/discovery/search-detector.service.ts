import { guardedAgents } from '../scraper/http/address-guard';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import { isTag, isText } from 'domhandler';
import type { AnyNode, Element } from 'domhandler';

import { Configuration, ScraperConfig } from '../config/configuration';
import { HostRateLimiterService } from '../scraper/http/host-rate-limiter.service';
import { decodeHtml } from '../scraper/http/html-decoder';
import { RobotsService } from '../scraper/http/robots.service';
import { PriceParserService } from '../scraper/parsers/price-parser.service';

/** What a detected shop looks like once we have worked it out. */
export interface DetectedShop {
  host: string;
  name: string;
  /** Search URL with the query replaced by `{q}`. */
  urlTemplate: string;
  tileSelector: string;
  linkSelector: string;
  titleSelector: string | null;
  priceSelector: string | null;
  /** Share of tiles that yielded a title, a price and a link. 0–1. */
  confidence: number;
  samples: Array<{ title: string; url: string; price: number | null }>;
}

/** A tile candidate found in the page, before the groups are compared. */
interface Candidate {
  tile: Element;
  anchor: Element;
  signature: string;
}

/**
 * Text that looks like a price in a Bulgarian or European shop: a number with
 * an optional grouping separator, followed or preceded by a currency mark.
 * Deliberately strict about the currency — a search page is full of bare
 * numbers (article counts, wattage, ratings) and matching those would make
 * every list of specifications look like a price list.
 */
const PRICE_TEXT =
  /(?:^|[\s>(])(\d{1,3}(?:[\s.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:лв\.?|BGN|€|EUR|лева)|(?:лв\.?|BGN|€|EUR)\s*(\d{1,3}(?:[\s.,]\d{3})*(?:[.,]\d{1,2})?)/i;

/** How far to climb from a link before giving up on finding its tile. */
const MAX_CLIMB = 6;

/** A tile carrying more text than this is a section, not a product. */
const MAX_TILE_TEXT = 700;

@Injectable()
export class SearchDetectorService {
  private readonly logger = new Logger(SearchDetectorService.name);
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
      timeout: Math.max(this.config.timeoutMs, 10000),
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
   * Works out how to search a shop from one example.
   *
   * The user pastes the address bar after searching for something, and says
   * what they typed. That is the whole of the configuration they provide —
   * asking a shop owner for a CSS selector asks them to learn a skill in order
   * to buy light bulbs.
   *
   * Everything else is inferred from the page and then *shown back* as sample
   * rows, because a guess the user can check beats a guess they cannot.
   */
  async detect(searchUrl: string, sampleQuery: string): Promise<DetectedShop> {
    const parsed = new URL(searchUrl);
    const urlTemplate = this.templateFrom(parsed, sampleQuery);

    if (!urlTemplate.includes('{q}')) {
      throw new Error(
        `Не намерих "${sampleQuery}" в адреса. Проверете дали това е адресът след търсенето и дали думата съвпада с написаното.`,
      );
    }

    if (this.config.respectRobots) {
      const allowed = await this.robots.isAllowed(searchUrl, this.config.userAgent);
      if (!allowed) {
        throw new Error(
          'robots.txt на магазина забранява търсене. Този магазин не може да се добави.',
        );
      }
    }

    const html = await this.fetch(searchUrl, parsed.host);
    const detected = this.analyse(html, parsed, urlTemplate, sampleQuery);

    this.logger.log(
      `Detected ${detected.samples.length} sample rows on ${parsed.host} ` +
        `(confidence ${(detected.confidence * 100).toFixed(0)}%)`,
    );

    return detected;
  }

  private async fetch(url: string, host: string): Promise<string> {
    return this.rateLimiter.schedule(host, this.config.minDelayMs, async () => {
      const response = await this.client.get<Buffer>(url);

      if (response.status >= 400) {
        throw new Error(
          `Магазинът отговори с HTTP ${response.status}. Проверете адреса или опитайте по-късно.`,
        );
      }

      return decodeHtml(Buffer.from(response.data), String(response.headers['content-type'] ?? ''));
    });
  }

  /**
   * Turns a concrete search URL into a template.
   *
   * The query may be in a parameter (`?q=крушка`), in the path
   * (`/search/крушка`), and it may be percent-encoded — so every form is tried
   * rather than assuming the shop uses the common one.
   */
  private templateFrom(parsed: URL, sampleQuery: string): string {
    const query = sampleQuery.trim();
    const variants = [
      query,
      encodeURIComponent(query),
      encodeURIComponent(query).replace(/%20/g, '+'),
      query.replace(/\s+/g, '+'),
      query.replace(/\s+/g, '-'),
    ];

    let url = parsed.toString();

    for (const variant of variants) {
      if (!variant) continue;
      const index = url.toLowerCase().indexOf(variant.toLowerCase());
      if (index === -1) continue;

      url = url.slice(0, index) + '{q}' + url.slice(index + variant.length);
      break;
    }

    return url;
  }

  /** Groups the page's links by the shape of their surrounding tile. */
  private analyse(
    html: string,
    pageUrl: URL,
    urlTemplate: string,
    sampleQuery: string,
  ): DetectedShop {
    const $ = cheerio.load(html);
    const candidates: Candidate[] = [];

    $('a[href]').each((_index, node) => {
      const anchor = node;
      const href = $(anchor).attr('href') ?? '';
      if (!this.isPlausibleProductLink(href, pageUrl)) return;

      const tile = this.tileFor($, anchor);
      if (!tile) return;

      candidates.push({ tile, anchor, signature: this.signatureOf($, tile) });
    });

    const groups = new Map<string, Candidate[]>();
    candidates.forEach((candidate) => {
      const bucket = groups.get(candidate.signature) ?? [];
      bucket.push(candidate);
      groups.set(candidate.signature, bucket);
    });

    // Size alone picks the wrong group: on a shop whose search is rendered by
    // JavaScript the biggest group of price-bearing links is the navigation
    // menu, and it looks perfectly consistent. What separates the real results
    // is that they mention what was searched for.
    const words = sampleQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2);

    const scored = Array.from(groups.values())
      .map((group) => {
        // One anchor per tile: a tile usually links to the same product
        // several times (image, title, button) and each would otherwise
        // become a separate result.
        //
        // The one kept is the anchor with the most text, because that is the
        // title link. Keeping whichever came first in the document picked the
        // image link on homefinishing.bg — an empty <a> wrapping an <img> —
        // and every detected row came back with a price and no name.
        const unique = new Map<Element, Candidate>();
        group.forEach((candidate) => {
          const existing = unique.get(candidate.tile);
          if (!existing) {
            unique.set(candidate.tile, candidate);
            return;
          }

          const length = (node: Element): number => $(node).text().trim().length;
          if (length(candidate.anchor) > length(existing.anchor)) {
            unique.set(candidate.tile, candidate);
          }
        });

        const tiles = Array.from(unique.values());
        const relevant = words.length
          ? tiles.filter((candidate) => {
              const text = $(candidate.tile).text().toLowerCase();
              return words.some((word) => text.includes(word));
            }).length
          : tiles.length;

        return { tiles, relevant };
      })
      .filter((group) => group.tiles.length >= 3)
      // Relevance first, size as the tiebreak.
      .sort((a, b) => b.relevant - a.relevant || b.tiles.length - a.tiles.length);

    const winner = scored[0];

    // At least one result must mention what was searched for — that is what
    // separates a results list from a navigation menu, which is the failure
    // this check exists to prevent.
    //
    // It used to demand *half* the tiles mention it, and that rejected shops
    // whose search plainly works: homefinishing.bg answers "крушка" with 24
    // products of which 2 carry the word in their name — the rest are listed
    // as "ЛАМПА" or by brand. Requiring a real search engine to behave like a
    // substring filter throws away the shops most worth having, and the guess
    // is shown back with sample rows for the user to reject anyway.
    if (!winner || (words.length > 0 && winner.relevant < 1)) {
      throw new Error(
        'Не разпознах списък с продукти на тази страница. Възможно е магазинът да зарежда резултатите с JavaScript — такъв магазин не може да се търси по този начин.',
      );
    }

    const tiles = winner.tiles;
    const tileSelector = this.selectorFor($, tiles[0].tile);
    const priceSelector = this.priceSelectorFor($, tiles);
    const titleSelector = this.titleSelectorFor($, tiles);

    const rows = tiles.map((candidate) => {
      const $tile = $(candidate.tile);
      const href = $(candidate.anchor).attr('href') ?? '';

      // Three sources, weakest last. A named selector is best; the anchor's
      // own text is usually the product name; and where the markup gives
      // neither, the longest run of text in the tile that is not the price
      // beats reporting a nameless row.
      const titleText =
        (titleSelector ? $tile.find(titleSelector).first().text() : '').trim() ||
        $(candidate.anchor).text().trim() ||
        this.longestTextIn($, candidate.tile);

      const priceText = priceSelector
        ? $tile.find(priceSelector).first().text()
        : ($tile.text().match(PRICE_TEXT)?.[0] ?? '');

      return {
        title: titleText.replace(/\s+/g, ' ').trim().slice(0, 160),
        url: new URL(href, pageUrl).toString(),
        price: this.parser.parseAmount(priceText),
      };
    });

    const complete = rows.filter((row) => row.title && row.url && row.price !== null).length;

    return {
      host: pageUrl.host.replace(/^www\./, ''),
      name: this.shopNameFrom($, pageUrl),
      urlTemplate,
      tileSelector,
      titleSelector,
      priceSelector,
      confidence: rows.length ? complete / rows.length : 0,
      samples: rows.slice(0, 5),
      // Scoped to the tile, never a bare `a[href]`. An unscoped selector makes
      // the search read every anchor on the page, and a results page is also a
      // footer: homefinishing.bg came back offering "Политика за бисквитки" at
      // 1.99 €, priced from whatever promo box happened to sit near the link.
      // A confidently wrong row is worse than a missing one.
      linkSelector: `${tileSelector} a`,
    };
  }

  /**
   * The longest own-text run inside a tile that is not a price or a button.
   *
   * The last resort for a product name, for markup that names nothing and
   * hangs the title on a bare element.
   */
  private longestTextIn($: cheerio.CheerioAPI, tile: Element): string {
    let best = '';

    $(tile)
      .find('*')
      .each((_index, node) => {
        if (/^(button|form|input|select|option|script|style)$/i.test(node.tagName)) return;
        if ($(node).closest('button').length > 0) return;

        const text = $(node)
          .contents()
          .filter((_i, child) => isText(child))
          .text()
          .replace(/\s+/g, ' ')
          .trim();

        // A name is made of words. Without this the discount badge wins on
        // any tile whose title link is empty, and the row comes back called
        // "-20%".
        const letters = (text.match(/[A-Za-zА-Яа-я]/g) ?? []).length;

        if (
          letters >= 3 &&
          text.length > best.length &&
          text.length <= 180 &&
          !PRICE_TEXT.test(text)
        ) {
          best = text;
        }
      });

    return best;
  }

  /** Same-site, has a path, and is not an obvious navigation or asset link. */
  private isPlausibleProductLink(href: string, pageUrl: URL): boolean {
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return false;

    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      return false;
    }

    if (resolved.host.replace(/^www\./, '') !== pageUrl.host.replace(/^www\./, '')) return false;

    const path = resolved.pathname.replace(/\/+$/, '');
    if (path.length < 2) return false;
    if (/\.(jpe?g|png|gif|svg|webp|css|js|pdf)$/i.test(path)) return false;

    return !/(login|register|cart|checkout|contact|delivery|terms|privacy|blog|news)/i.test(path);
  }

  /** The nearest ancestor of the link that also contains a price. */
  private tileFor($: cheerio.CheerioAPI, anchor: Element): Element | null {
    let node: AnyNode | null = anchor.parent;

    for (let depth = 0; depth < MAX_CLIMB && node; depth += 1) {
      if (isTag(node)) {
        const text = $(node).text().replace(/\s+/g, ' ');

        if (text.length <= MAX_TILE_TEXT && PRICE_TEXT.test(text)) {
          return node;
        }
      }

      node = node.parent;
    }

    return null;
  }

  /**
   * How this tile is recognisable among its siblings.
   *
   * Class names first, because shops name their product cards; the chain of
   * tag names is the fallback for markup that styles everything with utility
   * classes or none at all.
   */
  private signatureOf($: cheerio.CheerioAPI, tile: Element): string {
    const classes = ($(tile).attr('class') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      // Hashed or state classes differ per tile and would split one group into
      // twenty of size one.
      .filter((name) => !/\d{3,}|active|selected|hover|first|last/i.test(name))
      .sort()
      .slice(0, 3)
      .join('.');

    if (classes) return `${tile.tagName}.${classes}`;

    const chain: string[] = [];
    let node: AnyNode | null = tile;
    for (let depth = 0; depth < 3 && node; depth += 1) {
      if (isTag(node)) chain.push(node.tagName);
      node = node.parent;
    }

    return chain.join('>');
  }

  /** A selector that finds this element again, stable across tiles. */
  private selectorFor($: cheerio.CheerioAPI, element: Element): string {
    const classes = ($(element).attr('class') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .filter((name) => !/\d{3,}|active|selected|hover|first|last/i.test(name))
      .slice(0, 2);

    return classes.length ? `${element.tagName}.${classes.join('.')}` : element.tagName;
  }

  /** The descendant class that holds the price in most tiles. */
  private priceSelectorFor($: cheerio.CheerioAPI, tiles: Candidate[]): string | null {
    return this.mostCommonSelector($, tiles, (text) => PRICE_TEXT.test(text) && text.length < 40);
  }

  /**
   * The descendant that holds the product name in most tiles.
   *
   * Buttons are excluded outright. eMAG's "Добави в количката" carries the
   * word `product` in its class list and otherwise wins this contest on every
   * tile — a title selector that returns the same string for every result is
   * worse than none, because it looks like it worked.
   */
  private titleSelectorFor($: cheerio.CheerioAPI, tiles: Candidate[]): string | null {
    const looksLikeTitle = (text: string, element: Element): boolean => {
      if (text.length < 8 || text.length > 180) return false;
      if (PRICE_TEXT.test(text)) return false;
      if (/^(button|form|input|select|option|label)$/i.test(element.tagName)) return false;
      if ($(element).closest('button, form').length > 0) return false;
      if (
        /(btn|button|cart|kolichka|количка|сравни|добави)/i.test($(element).attr('class') ?? '')
      ) {
        return false;
      }
      return true;
    };

    // A heading or an explicitly named element first; the plain longest text
    // in the tile only if the markup gives no better clue.
    const named = this.mostCommonSelector(
      $,
      tiles,
      (text, element) =>
        looksLikeTitle(text, element) &&
        (/^h[1-6]$/i.test(element.tagName) ||
          /(title|name|product-?link)/i.test($(element).attr('class') ?? '')),
    );

    if (named) return named;

    return this.mostCommonSelector($, tiles, looksLikeTitle);
  }

  /**
   * Finds the selector that matches a wanted element in the most tiles.
   *
   * Chosen by how many tiles it works on rather than by how well it works on
   * the first one: a selector taken from a single tile fails on the tile that
   * happens to be on sale and carries an extra element.
   */
  private mostCommonSelector(
    $: cheerio.CheerioAPI,
    tiles: Candidate[],
    matches: (text: string, element: Element) => boolean,
  ): string | null {
    const counts = new Map<string, number>();

    tiles.forEach((candidate) => {
      const seen = new Set<string>();

      $(candidate.tile)
        .find('*')
        .each((_index, node) => {
          const element = node;
          // Own text only: a wrapper inherits its children's text and would
          // win over the element that actually holds the value.
          const text = $(element)
            .contents()
            .filter((_i, child) => isText(child))
            .text()
            .replace(/\s+/g, ' ')
            .trim();

          if (!text || !matches(text, element)) return;

          const selector = this.selectorFor($, element);
          if (selector === element.tagName) return;
          if (seen.has(selector)) return;

          seen.add(selector);
          counts.set(selector, (counts.get(selector) ?? 0) + 1);
        });
    });

    const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];

    // Anything working on fewer than half the tiles is a coincidence, and a
    // wrong selector is worse than none: the caller falls back to reading the
    // whole tile, which at least degrades predictably.
    return best && best[1] >= Math.max(2, tiles.length / 2) ? best[0] : null;
  }

  private shopNameFrom($: cheerio.CheerioAPI, pageUrl: URL): string {
    const siteName = $('meta[property="og:site_name"]').attr('content')?.trim();
    if (siteName) return siteName.slice(0, 80);

    const host = pageUrl.host.replace(/^www\./, '');
    const label = host.split('.')[0];
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
}
