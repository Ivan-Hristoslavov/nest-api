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
    priceSelectors: ['.product-new-price', '[data-price]'],
    currency: 'BGN',
    outOfStockText: ['Не е налично', 'Изчерпан'],
  },
  {
    host: 'technopolis.bg',
    name: 'Technopolis',
    priceSelectors: ['.product-price__price', '.price-value'],
    currency: 'BGN',
  },
  {
    host: 'ozone.bg',
    name: 'Ozone',
    priceSelectors: ['.product-price .price', '.price'],
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
