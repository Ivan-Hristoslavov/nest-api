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

/**
 * Shops known NOT to be live-searchable, with the reason.
 *
 * Recorded rather than silently omitted: without this the same shop gets
 * "added to live search" again in six months, and the only way to find out it
 * never worked is a user reporting nonsense results.
 */
export const UNSEARCHABLE_SHOPS: Array<{ host: string; name: string; reason: string }> = [
  {
    host: 'elmarkstore.eu',
    name: 'Elmark Store',
    // Verified 2026-08: /search returns the same 20 tiles for "кабел", "лампа",
    // "ножовка" and "ключ". The query is not honoured over GET at all, so any
    // selector work here would only make wrong results look convincing.
    reason: 'търсачката не приема заявка през GET — връща едни и същи резултати',
  },
  {
    host: 'technopolis.bg',
    name: 'Technopolis',
    reason: 'търсенето се изгражда с JavaScript, няма сървърна страница',
  },
  {
    host: 'technomarket.bg',
    name: 'Технómarket',
    reason: 'търсенето се изгражда с JavaScript, няма сървърна страница',
  },
  {
    host: 'itt-shop.bg',
    name: 'ITT Shop',
    // Verified 2026-09: the search form is `method="post"` to
    // /search/static/12, with an AJAX twin at /search/ajax/12. Every GET path
    // tried returns the shop's 404 page with a 200, which is the shape that
    // looks like "nothing stocked" rather than "wrong address". Its sitemap is
    // published and its product pages are readable, so it searches that way.
    reason: 'търсачката приема само POST — търсим през картата на сайта',
  },
  {
    host: 'kris06.bg',
    name: 'КРИС 06',
    // Verified 2026-09: the header form points at /search.html?phrase=, but
    // that address answers 200 with the shop's own 404 body — the form is
    // driven by JavaScript and the GET is not the real one. Works through the
    // sitemap, where it is one of the few sources for several articles.
    reason: 'търсачката не отговаря на GET — търсим през картата на сайта',
  },
];

export const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    host: 'tmt-elkom.com',
    name: 'ТМТ ЕЛКОМ',
    // Verified 2026-08: /search?q= is server-rendered and returns real matches.
    // The shop's robots.txt disallows /search, so DiscoveryService refuses it at
    // run time; the entry stays because its product pages *are* allowed, which
    // is what the sitemap crawl uses.
    searchUrl: (query) => `https://www.tmt-elkom.com/search?q=${query}`,
    resultLinkSelector: 'a[href*="/"]',
    productUrlPattern: /^https?:\/\/(www\.)?tmt-elkom\.com\/[a-z0-9%-]{8,}$/i,
    tileSelector: '.product, li, article',
    priceSelector: '[itemprop="price"], .price',
  },
  {
    host: 'homefinishing.bg',
    name: 'Home Finishing',
    // Magento: /catalogsearch/result/?q= — 251 matches for "кабел".
    searchUrl: (query) => `https://homefinishing.bg/catalogsearch/result/?q=${query}`,
    resultLinkSelector: 'a.product-item-link, a[href*="homefinishing.bg/"]',
    productUrlPattern: /^https?:\/\/(www\.)?homefinishing\.bg\/[a-z0-9%-]{6,}$/i,
    tileSelector: '.product-item, li.item',
    priceSelector: '.price',
  },
  {
    host: 'cablecommerce.bg',
    name: 'Кабелкомерс',
    // Verified 2026-09 against the live site. WooCommerce on the WoodMart
    // theme, and the `post_type=product` half of the query is the point: plain
    // `?s=` returns categories and pages mixed in with the products, and the
    // category tiles carry no price, so a shop that searches perfectly well
    // came back looking half-broken.
    //
    // Twelve products for "кабел" and twelve for "лампа" with no overlap, so
    // the query is genuinely honoured. This shop was reaching customers
    // through its sitemap instead — the slowest path there is, and the one
    // SEARCH_SUPPLIER_TIMEOUT_MS was raised to forty seconds to accommodate.
    //
    // Prices render as "0.19 € с ДДС": euros, VAT included. The VAT basis is
    // per-shop customer configuration (`Shop.vatState`), not something a
    // shipped search entry can set, so it is noted rather than assumed.
    searchUrl: (query) => `https://www.cablecommerce.bg/?s=${query}&post_type=product`,
    resultLinkSelector: 'a.product-image-link',
    productUrlPattern: /^https?:\/\/(www\.)?cablecommerce\.bg\/produkt\/[^/]+\/?$/i,
    tileSelector: '.wd-product',
    titleSelector: '.wd-entities-title',
    priceSelector: '.price .woocommerce-Price-amount',
  },
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
