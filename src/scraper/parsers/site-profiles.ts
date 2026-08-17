/**
 * Per-retailer scraping profiles.
 *
 * The generic parser (JSON-LD -> microdata -> meta -> heuristics) handles most
 * storefronts unaided. A profile exists for the cases where it cannot: pages
 * with no structured data, or — like vario.bg — pages that publish *two*
 * prices, so the generic strategies would silently pick the wrong currency.
 *
 * Adding a retailer is a matter of appending one entry here. A profile is
 * always overridable per listing: a `priceSelector` stored on the competitor
 * row wins over anything configured below.
 */
export interface SiteProfile {
  /** Hostname the profile applies to, matched with and without `www.`. */
  host: string;
  /** Human readable retailer name, used when auto-naming listings. */
  name: string;
  /**
   * Selectors tried in order. The first one that yields a parsable number wins,
   * which makes a profile survive a partial redesign.
   */
  priceSelectors: string[];
  /** Read this attribute instead of the element text, when set. */
  priceAttribute?: string;
  /** Currency the selected element is denominated in. */
  currency: string;
  /** Selectors whose presence means "out of stock". */
  outOfStockSelectors?: string[];
  /** Text that marks the item as unavailable when found on the page. */
  outOfStockText?: string[];
}

export const SITE_PROFILES: SiteProfile[] = [
  {
    host: 'vario.bg',
    name: 'Vario',
    // Verified against a live product page (2026-08):
    //   <em class="current_price" id="subtotal_price_bgn">
    //     <span content="428">428</span><sup>.00</sup><small>лв.</small>
    //   </em>
    // The element's text concatenates to "428.00лв.", which the amount parser
    // normalises to 428.00.
    //
    // The page also carries `itemprop="price" content="218.83"` — the EUR
    // price. Without this profile the generic microdata strategy would pick
    // that up and store euros in a BGN column, so the BGN node is pinned here.
    priceSelectors: ['#subtotal_price_bgn', 'em.current_price', '.current_price'],
    currency: 'BGN',
    outOfStockText: ['Изчерпан', 'Изчерпана наличност', 'Не е наличен'],
  },
  {
    host: 'emag.bg',
    name: 'eMAG',
    // Verified 2026-08: the page carries a complete schema.org Product with
    // `offers.price = 359` and `priceCurrency = EUR`, so the generic JSON-LD
    // strategy already succeeds. The selector is kept as a fallback for the
    // day the structured data disappears — `.product-new-price` renders as
    // "359,00 €" once its <sup> decimals are concatenated.
    priceSelectors: ['.product-new-price'],
    currency: 'EUR',
    outOfStockText: ['Не е наличен', 'Изчерпан'],
  },
  {
    host: 'technomarket.bg',
    name: 'Technomarket',
    // Verified 2026-08. The page prints both currencies and the JSON-LD block
    // carries the BGN figure (467.44), but `.price-wrapper .price` resolves to
    // the EUR node (239.00 — the same amount at the fixed 1.95583 rate).
    //
    // The selector is pinned to the EUR node deliberately: every other price in
    // this system is stored in EUR, and mixing currencies inside one comparison
    // is how you end up recommending the most expensive warehouse.
    priceSelectors: ['.price-wrapper .price', '.price-block .price', '.price'],
    currency: 'EUR',
    outOfStockText: ['Изчерпан', 'Не е наличен', 'Очаквайте скоро'],
  },
  {
    // NOTE: technopolis.bg publishes `User-agent: * / Disallow: /` and allows
    // only a named allowlist of search-engine crawlers. With
    // SCRAPER_RESPECT_ROBOTS=true — the default, and the right default — every
    // fetch here is refused before a request is made. The profile is kept for
    // the case where you obtain written permission from them.
    host: 'technopolis.bg',
    name: 'Technopolis',
    // Verified 2026-08. An Angular storefront, but server-side rendered, so a
    // plain fetch does see the price. It prints both currencies:
    //   <span class="price-value">99.99</span>€ / <span class="price-value">195.56</span>лв.
    // The EUR node comes first in the product block, and the parser takes the
    // first match — which is what this system stores.
    priceSelectors: ['.product-pdp__prices .price-value', '.price-value'],
    currency: 'EUR',
    outOfStockText: ['Изчерпан', 'Не е наличен', 'Изчерпана наличност'],
  },
  {
    host: 'mobile.bg',
    name: 'Mobile.bg',
    // Verified 2026-08. Two things make this site a good test of the pipeline:
    // the price class is capitalised (`.Price`, and CSS class matching is
    // case-sensitive), and the page is served as windows-1251 — decoded as
    // UTF-8 it turns to mojibake and appears to have no price at all.
    priceSelectors: ['.Price', '#details .price', '.price'],
    currency: 'EUR',
    outOfStockText: ['Обявата е изтекла', 'Обявата не е активна'],
  },
  {
    host: 'cars.bg',
    name: 'Cars.bg',
    priceSelectors: ['.offer-price', '.price', '.OfferPrice'],
    currency: 'EUR',
    outOfStockText: ['Обявата е изтекла'],
  },
  {
    host: 'ozone.bg',
    name: 'Ozone',
    priceSelectors: ['.product-price .price', '.price'],
    currency: 'BGN',
  },
  {
    host: 'ardes.bg',
    name: 'Ardes',
    priceSelectors: ['.product-price', '.price'],
    currency: 'BGN',
  },
];

/** Normalises a hostname for comparison: lowercase, no `www.`, no port. */
export function normaliseHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^www\./, '')
    .split(':')[0];
}

/**
 * @returns the profile for `host`, or null when the generic parser should be
 * used. Matches subdomains too, so `shop.vario.bg` resolves to the vario.bg
 * profile.
 */
export function profileForHost(host: string): SiteProfile | null {
  const normalised = normaliseHost(host);

  return (
    SITE_PROFILES.find(
      (profile) =>
        normalised === profile.host || normalised.endsWith(`.${normaliseHost(profile.host)}`),
    ) ?? null
  );
}

/** @returns the retailer name for `host`, falling back to the hostname itself. */
export function retailerNameForHost(host: string): string {
  return profileForHost(host)?.name ?? normaliseHost(host);
}
