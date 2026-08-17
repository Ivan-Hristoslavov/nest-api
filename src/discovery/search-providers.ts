/**
 * Per-retailer search configuration.
 *
 * The point of this file is to stop people pasting URLs by hand. You type
 * "iPhone 17 Pro 256GB" once and the system goes and finds that product's page
 * at every shop it knows how to search.
 *
 * Every entry here was verified against the live site. A retailer whose search
 * is rendered client-side has no server HTML to parse and is therefore absent —
 * listing one that does not work is worse than listing none, because the user
 * blames their query rather than the integration.
 */
export interface SearchProvider {
  host: string;
  name: string;
  /** Builds the search URL for an already URL-encoded query. */
  searchUrl: (encodedQuery: string) => string;
  /** CSS selector matching the anchor of each result tile. */
  resultLinkSelector: string;
  /** Only hrefs matching this are treated as product pages. */
  productUrlPattern: RegExp;
  /** Selector for the tile's title, relative to the tile. Falls back to link text. */
  titleSelector?: string;
  /** Selector for the tile's price, relative to the tile. */
  priceSelector?: string;
  /** Climb this many levels from the anchor to reach the tile container. */
  tileSelector?: string;
}

export const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    host: 'emag.bg',
    name: 'eMAG',
    // Verified 2026-08: /search/<query> returns fully server-rendered results.
    searchUrl: (query) => `https://www.emag.bg/search/${query}`,
    resultLinkSelector: 'a[href*="/pd/"]',
    productUrlPattern: /^https?:\/\/(www\.)?emag\.bg\/[a-z0-9-]+\/pd\/[A-Z0-9]+\/?$/i,
    tileSelector: '.card-item',
    titleSelector: '.card-v2-title',
    priceSelector: '.product-new-price',
  },
  {
    host: 'vario.bg',
    name: 'Vario',
    // Verified 2026-08: the search form is GET search.php with `s`, not
    // `keywords` — the latter returns an empty result set with a 200, which is
    // the kind of thing that looks like "no such product" for months.
    searchUrl: (query) => `https://www.vario.bg/search.php?s=${query}`,
    resultLinkSelector: 'a.product_permalink',
    productUrlPattern: /^https?:\/\/(www\.)?vario\.bg\/[a-z0-9-]{6,}$/i,
    tileSelector: 'article, .product',
    priceSelector: '.price, .new_price',
  },
];

export function searchProviderFor(host: string): SearchProvider | null {
  const normalised = host.toLowerCase().replace(/^www\./, '');

  return (
    SEARCH_PROVIDERS.find(
      (provider) => normalised === provider.host || normalised.endsWith(`.${provider.host}`),
    ) ?? null
  );
}
