import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

import { SiteProfile } from './site-profiles';

/** Where in the page the price was found. Stored on the competitor row. */
export type ExtractionStrategy =
  'selector' | 'site-profile' | 'json-ld' | 'microdata' | 'meta' | 'heuristic';

/** Everything worth knowing about a listing beyond its price. */
export interface ListingDetails {
  /** Dealer or shop name, when the page names one. */
  sellerName: string | null;
  /** Absolute URL of the main image. */
  imageUrl: string | null;
  /** Where the item is. */
  location: string | null;
  /** Extra facts, label -> value, in page order. */
  attributes: Record<string, string>;
}

export interface ParsedPrice {
  price: number;
  /** ISO-4217 code when the page stated one. */
  currency: string | null;
  /** Null when the page said nothing about availability. */
  inStock: boolean | null;
  strategy: ExtractionStrategy;
}

export interface ParseOptions {
  /** CSS selector configured on the competitor, tried before everything else. */
  selector?: string | null;
  /** Read the price from this attribute instead of the element text. */
  attribute?: string | null;
  /** Retailer profile for this host, when one is registered. */
  profile?: SiteProfile | null;
}

/** Symbol -> ISO-4217, for pages that print a symbol and no code. */
const CURRENCY_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ['€', 'EUR'],
  ['$', 'USD'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₽', 'RUB'],
  ['₴', 'UAH'],
  ['₺', 'TRY'],
  ['лв', 'BGN'],
  ['zł', 'PLN'],
  ['kč', 'CZK'],
  ['ron', 'RON'],
  ['lei', 'RON'],
  ['chf', 'CHF'],
  ['sek', 'SEK'],
  ['nok', 'NOK'],
  ['dkk', 'DKK'],
];

/** Selectors seen on the majority of storefronts, tried last. */
const HEURISTIC_SELECTORS = [
  '[itemprop="price"]',
  '[data-price-amount]',
  '[data-product-price]',
  '[data-price]',
  '.price-item--sale',
  '.product__price',
  '.product-price',
  '.price__current',
  '.current-price',
  // Underscore variants are common in older PHP storefronts (vario.bg, and
  // most osCommerce/OpenCart descendants).
  '.current_price',
  '.total-price',
  '.price-now',
  '.sale-price',
  '.a-price .a-offscreen',
  '#priceblock_ourprice',
  '.price',
];

interface JsonLdOffer {
  price?: unknown;
  lowPrice?: unknown;
  priceCurrency?: unknown;
  availability?: unknown;
}

/**
 * Extracts a price from an HTML document.
 *
 * Deliberately free of any I/O so it can be unit-tested against saved pages —
 * which matters, because this is the component that silently breaks whenever a
 * retailer redesigns.
 *
 * Strategies run cheapest-and-most-reliable first:
 *
 * 1. **selector** — explicit CSS selector configured for the competitor.
 * 2. **json-ld** — `schema.org/Product` in a `<script type="application/ld+json">`.
 *    Present on most modern storefronts and the most stable of all.
 * 3. **microdata** — `itemprop="price"` attributes.
 * 4. **meta** — OpenGraph / `product:price:amount` tags.
 * 5. **heuristic** — a list of selectors common across storefronts.
 */
@Injectable()
export class PriceParserService {
  private readonly logger = new Logger(PriceParserService.name);

  parse(html: string, options: ParseOptions = {}): ParsedPrice | null {
    const $ = cheerio.load(html);

    const availability = this.extractAvailability($, html);

    const attempts: Array<() => ParsedPrice | null> = [
      () => this.fromSelector($, options),
      () => this.fromProfile($, options.profile ?? null),
      () => this.fromJsonLd($),
      () => this.fromMicrodata($),
      () => this.fromMeta($),
      () => this.fromHeuristics($),
    ];

    for (const attempt of attempts) {
      const result = attempt();
      if (result) {
        return { ...result, inStock: result.inStock ?? availability };
      }
    }

    return null;
  }

  /**
   * Converts a human-formatted price into a number.
   *
   * Handles the separator ambiguity that makes naive `parseFloat` wrong across
   * locales: `1.299,00` (EU) and `1,299.00` (US) are the same amount, and
   * `1.299` alone is ambiguous. Rules:
   * - both separators present -> the rightmost one is the decimal separator;
   * - one separator followed by exactly three digits -> thousands separator;
   * - otherwise -> decimal separator.
   *
   * Exposed as a public method so it can be tested directly.
   */
  parseAmount(raw: string): number | null {
    if (!raw) return null;

    // Keep digits and separators; drop currency symbols, letters, nbsp.
    const cleaned = raw
      .replace(/[\u00a0\u202f\u2009\u2007]/g, ' ')
      .replace(/[^\d.,\s-]/g, '')
      .trim();

    // Trailing punctuation from the currency word must go before the separator
    // logic runs: "1 299,00 лв." cleans to "1299,00." and the trailing dot would
    // otherwise be read as the decimal separator, yielding 129900.
    const digitsOnly = cleaned.replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '');
    if (!digitsOnly || !/\d/.test(digitsOnly)) return null;

    const lastDot = digitsOnly.lastIndexOf('.');
    const lastComma = digitsOnly.lastIndexOf(',');
    let normalized: string;

    if (lastDot >= 0 && lastComma >= 0) {
      const decimalSeparator = lastDot > lastComma ? '.' : ',';
      const thousandsSeparator = decimalSeparator === '.' ? ',' : '.';
      normalized = digitsOnly.split(thousandsSeparator).join('').replace(decimalSeparator, '.');
    } else if (lastDot >= 0 || lastComma >= 0) {
      const separator = lastDot >= 0 ? '.' : ',';
      const index = lastDot >= 0 ? lastDot : lastComma;
      const decimals = digitsOnly.length - index - 1;
      const occurrences = digitsOnly.split(separator).length - 1;

      normalized =
        decimals === 3 && (occurrences > 1 || index > 0)
          ? // e.g. "1.299" or "1.234.567" -> thousands
            digitsOnly.split(separator).join('')
          : digitsOnly.replace(separator, '.');
    } else {
      normalized = digitsOnly;
    }

    const value = Number.parseFloat(normalized);
    if (!Number.isFinite(value) || value <= 0) return null;

    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  /**
   * Extracts the context around the price: who sells it, where it is, what it
   * looks like.
   *
   * A price on its own is half an answer — "24 999 €" is far less useful than
   * "24 999 € from MAXI in Sofia, 2016, 180 000 km". Everything here is
   * best-effort: a missing field is null, never a failed scrape.
   */
  parseDetails(html: string, profile: SiteProfile | null, pageUrl?: string): ListingDetails {
    const $ = cheerio.load(html);
    const text = $('body').text().replace(/\s+/g, ' ');

    return {
      sellerName: this.extractSeller($, profile),
      imageUrl: this.absoluteUrl($('meta[property="og:image"]').first().attr('content'), pageUrl),
      location: this.extractLocation($, profile),
      attributes: this.extractAttributes(
        text,
        profile,
        `${$('title').first().text()} ${$('h1').first().text()}`,
      ),
    };
  }

  private extractSeller($: cheerio.CheerioAPI, profile: SiteProfile | null): string | null {
    for (const selector of profile?.sellerSelectors ?? []) {
      let raw: string;
      try {
        raw = $(selector).first().text();
      } catch {
        continue;
      }
      if (!raw) continue;

      let cleaned = raw.replace(/\s+/g, ' ').trim();
      for (const label of profile?.sellerStrip ?? []) {
        cleaned = cleaned.split(label).join(' ');
      }

      // Phone numbers sit next to the name in most contact blocks.
      cleaned = cleaned
        .replace(/[+\d][\d\s()-]{6,}/g, '|')
        .replace(/https?:\/\/\S+/g, '|')
        .replace(/[|,;]+/g, '|');

      // The block also carries the address, the city and "в mobile.bg от 2003 г."
      // The firm name is the first segment; everything after it is context that
      // belongs in other fields, not in the name.
      const name = cleaned
        .split('|')
        .map((part) => part.replace(/\s+/g, ' ').trim())
        .find((part) => part.length >= 2 && !/^(гр\.|с\.|бул\.|ул\.)/i.test(part));

      // A trailing city ("MAXI гр. София") belongs in `location`, not the name.
      const withoutCity = name?.split(/\s+(?:гр\.|с\.)\s*/)[0].trim();
      if (withoutCity && withoutCity.length >= 2 && withoutCity.length <= 120) return withoutCity;
    }

    // Shops that name themselves in structured data.
    const siteName = $('meta[property="og:site_name"]').first().attr('content');
    return siteName?.trim() || null;
  }

  private extractLocation($: cheerio.CheerioAPI, profile: SiteProfile | null): string | null {
    for (const selector of profile?.locationSelectors ?? []) {
      let raw: string;
      try {
        raw = $(selector).first().text();
      } catch {
        continue;
      }

      const match = /(?:Местоположение|Намира се в|Адрес)\s*:?\s*([^|]{3,80})/.exec(
        raw.replace(/\s+/g, ' '),
      );
      if (match) return match[1].trim();
    }

    return null;
  }

  private extractAttributes(
    text: string,
    profile: SiteProfile | null,
    title = '',
  ): Record<string, string> {
    const attributes: Record<string, string> = {};

    for (const { label, pattern, scope } of profile?.attributePatterns ?? []) {
      // Scope matters more than it looks: searching the whole page for a year
      // finds "в mobile.bg от 2003 г." — the dealer's join date — long before
      // the car's own model year in the heading.
      const haystack = scope === 'title' ? title : text;
      const match = pattern.exec(haystack);
      if (match) {
        const value = (match[1] ?? match[0]).replace(/\s+/g, ' ').trim();
        if (value) attributes[label] = value.slice(0, 60);
      }
    }

    return attributes;
  }

  private absoluteUrl(value: string | undefined, base?: string): string | null {
    if (!value) return null;
    try {
      return new URL(value, base ?? 'https://example.com').toString();
    } catch {
      return null;
    }
  }

  /** Detects an ISO-4217 code, from an explicit code or a currency symbol. */
  detectCurrency(raw: string): string | null {
    const isoMatch = /\b(EUR|USD|GBP|BGN|RON|PLN|CZK|CHF|SEK|NOK|DKK|HUF|TRY|JPY)\b/i.exec(raw);
    if (isoMatch) return isoMatch[1].toUpperCase();

    const lowered = raw.toLowerCase();
    for (const [symbol, code] of CURRENCY_SYMBOLS) {
      if (lowered.includes(symbol.toLowerCase())) return code;
    }

    return null;
  }

  /**
   * Reads the price text of an element, reconstructing decimals that live in a
   * superscript without a separator character.
   *
   * Storefronts very often render `432,00` as
   * `<strong>432</strong> <sup>00</sup>`, where the comma is drawn by CSS and
   * exists nowhere in the DOM. Concatenating the text nodes yields "432 00",
   * which the amount parser reads as forty-three thousand two hundred — a
   * hundredfold error that looks entirely plausible in a table.
   *
   * When a `sup`/`small` child holds one or two bare digits and the remaining
   * text carries no decimal separator of its own, the two are rejoined
   * explicitly.
   */
  private priceTextOf($: cheerio.CheerioAPI, element: cheerio.Cheerio<AnyNode>): string {
    const clone = element.clone();
    // Assigned inside the `.each` callback, which TypeScript cannot see into —
    // without the explicit annotation it narrows the variable to `never`.
    let fraction: string | null = null;

    clone.find('sup, small, .decimal, .cents, .mf-decimal, .price-decimals').each((_, node) => {
      if (fraction !== null) return;

      const text = $(node).text().replace(/\s+/g, '');
      // A bare 1–2 digit run is a decimal part; "00" with a leading separator
      // already parses correctly and is left alone.
      if (/^\d{1,2}$/.test(text)) {
        fraction = text.padEnd(2, '0');
        $(node).remove();
      }
    });

    const main = clone.text().replace(/\s+/g, ' ').trim();

    if (fraction === null) return main;
    // The integer part already ends in decimals — nothing to rejoin.
    if (/[.,]\s*\d{1,2}$/.test(main)) return main;

    return main.replace(/[.,\s]+$/, '') + '.' + String(fraction);
  }

  private fromSelector($: cheerio.CheerioAPI, options: ParseOptions): ParsedPrice | null {
    if (!options.selector) return null;

    let element;
    try {
      element = $(options.selector).first();
    } catch {
      // An invalid selector is a configuration error, not a page error.
      this.logger.warn(`Invalid price selector configured: ${options.selector}`);
      return null;
    }

    if (element.length === 0) return null;

    const raw = options.attribute
      ? (element.attr(options.attribute) ?? '')
      : this.priceTextOf($, element);

    const price = this.parseAmount(raw);
    return price === null
      ? null
      : { price, currency: this.detectCurrency(raw), inStock: null, strategy: 'selector' };
  }

  /**
   * Tries each selector from the retailer profile in turn.
   *
   * Runs before the structured-data strategies on purpose: a profile exists
   * precisely because those strategies produce the wrong answer on this site.
   */
  private fromProfile($: cheerio.CheerioAPI, profile: SiteProfile | null): ParsedPrice | null {
    if (!profile) return null;

    for (const selector of profile.priceSelectors) {
      let element;
      try {
        element = $(selector).first();
      } catch {
        this.logger.warn(`Invalid selector "${selector}" in the ${profile.host} profile.`);
        continue;
      }

      if (element.length === 0) continue;

      const raw = profile.priceAttribute
        ? (element.attr(profile.priceAttribute) ?? '')
        : this.priceTextOf($, element);

      const price = this.parseAmount(raw);
      if (price === null) continue;

      return {
        price,
        currency: profile.currency,
        inStock: this.availabilityFromProfile($, profile),
        strategy: 'site-profile',
      };
    }

    return null;
  }

  private availabilityFromProfile($: cheerio.CheerioAPI, profile: SiteProfile): boolean | null {
    for (const selector of profile.outOfStockSelectors ?? []) {
      try {
        if ($(selector).length > 0) return false;
      } catch {
        // An unusable selector should not decide availability either way.
      }
    }

    if (profile.outOfStockText?.length) {
      const bodyText = $('body').text();
      if (profile.outOfStockText.some((needle) => bodyText.includes(needle))) return false;
    }

    return null;
  }

  private fromJsonLd($: cheerio.CheerioAPI): ParsedPrice | null {
    const scripts = $('script[type="application/ld+json"]').toArray();

    for (const script of scripts) {
      const content = $(script).text().trim();
      if (!content) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Malformed JSON-LD is common; move on rather than failing the scrape.
        continue;
      }

      const offer = this.findOffer(parsed);
      if (!offer) continue;

      const rawPrice = offer.price ?? offer.lowPrice;
      if (rawPrice === undefined || rawPrice === null) continue;

      const price =
        typeof rawPrice === 'number'
          ? Math.round((rawPrice + Number.EPSILON) * 100) / 100
          : typeof rawPrice === 'string'
            ? this.parseAmount(rawPrice)
            : null;

      if (price === null || price <= 0) continue;

      const currency =
        typeof offer.priceCurrency === 'string' ? offer.priceCurrency.toUpperCase() : null;
      const availability =
        typeof offer.availability === 'string'
          ? !/OutOfStock|SoldOut|Discontinued/i.test(offer.availability)
          : null;

      return { price, currency, inStock: availability, strategy: 'json-ld' };
    }

    return null;
  }

  /** Walks arbitrary JSON-LD (objects, arrays, @graph) looking for an offer. */
  private findOffer(node: unknown, depth = 0): JsonLdOffer | null {
    if (depth > 6 || node === null || typeof node !== 'object') return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = this.findOffer(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    const record = node as Record<string, unknown>;

    // An object carrying a price and a currency is an offer, whatever its @type.
    if ('price' in record || 'lowPrice' in record) {
      return record;
    }

    for (const key of ['offers', '@graph', 'mainEntity', 'itemListElement', 'hasVariant']) {
      if (key in record) {
        const found = this.findOffer(record[key], depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  private fromMicrodata($: cheerio.CheerioAPI): ParsedPrice | null {
    const nodes = $('[itemprop="price"]');
    if (nodes.length === 0) return null;

    // A category or home page carries one of these per tile. Picking the first
    // returns an arbitrary product's price with total confidence, which is far
    // worse than returning nothing: the number looks real and nobody checks it.
    if (this.isAmbiguous($, nodes)) {
      this.logger.warn(
        `Found ${nodes.length} distinct microdata prices — this looks like a listing page, not a product page.`,
      );
      return null;
    }

    const element = nodes.first();

    const raw = element.attr('content') ?? this.priceTextOf($, element);
    const price = this.parseAmount(raw);
    if (price === null) return null;

    const currencyRaw =
      $('[itemprop="priceCurrency"]').first().attr('content') ??
      $('[itemprop="priceCurrency"]').first().text() ??
      raw;

    return {
      price,
      currency: this.detectCurrency(currencyRaw),
      inStock: null,
      strategy: 'microdata',
    };
  }

  private fromMeta($: cheerio.CheerioAPI): ParsedPrice | null {
    const priceMeta = [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]',
      'meta[name="twitter:data1"]',
      'meta[itemprop="price"]',
    ];

    for (const selector of priceMeta) {
      const raw = $(selector).first().attr('content');
      if (!raw) continue;

      const price = this.parseAmount(raw);
      if (price === null) continue;

      const currency =
        $('meta[property="product:price:currency"]').first().attr('content') ??
        $('meta[property="og:price:currency"]').first().attr('content') ??
        null;

      return {
        price,
        currency: currency ? currency.toUpperCase() : this.detectCurrency(raw),
        inStock: null,
        strategy: 'meta',
      };
    }

    return null;
  }

  private fromHeuristics($: cheerio.CheerioAPI): ParsedPrice | null {
    for (const selector of HEURISTIC_SELECTORS) {
      const nodes = $(selector);
      if (nodes.length === 0) continue;
      if (this.isAmbiguous($, nodes)) continue;

      const element = nodes.first();

      const raw =
        element.attr('content') ??
        element.attr('data-price-amount') ??
        this.priceTextOf($, element);
      const price = this.parseAmount(raw);
      if (price === null) continue;

      return {
        price,
        currency: this.detectCurrency(raw),
        inStock: null,
        strategy: 'heuristic',
      };
    }

    return null;
  }

  /**
   * True when the matched nodes hold more than one *different* price.
   *
   * Repeated identical values are fine — a page commonly prints the same price
   * in the buy box and in a summary. Genuinely different values mean several
   * products are on the page and no single one of them is "the" price.
   */
  private isAmbiguous($: cheerio.CheerioAPI, nodes: cheerio.Cheerio<AnyNode>): boolean {
    const values = new Set<number>();

    nodes.slice(0, 12).each((_, node) => {
      const element = $(node);
      const raw = element.attr('content') ?? this.priceTextOf($, element);
      const price = this.parseAmount(raw);
      if (price !== null) values.add(price);
    });

    return values.size > 1;
  }

  private extractAvailability($: cheerio.CheerioAPI, html: string): boolean | null {
    const microdata = $('[itemprop="availability"]').first();
    const stated = microdata.attr('href') ?? microdata.attr('content') ?? '';

    if (stated) return !/OutOfStock|SoldOut|Discontinued/i.test(stated);
    if (/schema.org\/OutOfStock/i.test(html)) return false;
    if (/schema.org\/InStock/i.test(html)) return true;

    return null;
  }
}
