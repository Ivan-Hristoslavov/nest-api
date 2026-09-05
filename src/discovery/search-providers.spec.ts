import { SEARCH_PROVIDERS, UNSEARCHABLE_SHOPS, searchProviderFor } from './search-providers';

/**
 * The shelf of verified search configurations.
 *
 * Every entry here was checked against the live site, and the checking is the
 * expensive part — nobody repeats it, so what these guard is that an edit
 * cannot quietly invalidate it: a URL that stops carrying the query, a pattern
 * that stops matching the product pages it was written for, or a host that
 * ends up on both the shelf and the list of shops that cannot be searched.
 */
describe('the shelf of search configurations', () => {
  it('puts the query into every search URL', () => {
    for (const provider of SEARCH_PROVIDERS) {
      const url = provider.searchUrl(encodeURIComponent('кабел 3x1.5'));

      expect(url).toContain(encodeURIComponent('кабел 3x1.5'));
      expect(url.startsWith('https://')).toBe(true);
    }
  });

  it('never lists a shop as both searchable and unsearchable', () => {
    // The two lists answer the same question and would contradict each other
    // in the one place a reader checks: `listProviders` says why a shop is
    // absent, and a host on both is a shop that is present *and* explained
    // away.
    const shelf = new Set(SEARCH_PROVIDERS.map((provider) => provider.host));

    for (const shop of UNSEARCHABLE_SHOPS) {
      expect(shelf.has(shop.host)).toBe(false);
    }
  });

  it('gives every unsearchable shop a reason a person can act on', () => {
    for (const shop of UNSEARCHABLE_SHOPS) {
      expect(shop.reason.length).toBeGreaterThan(15);
      expect(shop.name.length).toBeGreaterThan(0);
    }
  });

  it('matches a host with or without www., and its subdomains', () => {
    expect(searchProviderFor('cablecommerce.bg')?.name).toBe('Кабелкомерс');
    expect(searchProviderFor('www.cablecommerce.bg')?.name).toBe('Кабелкомерс');
    expect(searchProviderFor('shop.cablecommerce.bg')?.name).toBe('Кабелкомерс');
    expect(searchProviderFor('cablecommerce.bg.evil.test')).toBeNull();
  });

  describe('Кабелкомерс', () => {
    const provider = searchProviderFor('cablecommerce.bg')!;

    it('asks for products, not for pages and categories', () => {
      // Without `post_type=product` the results carry the shop's categories,
      // whose tiles have no price — which is how a working search came back
      // looking broken.
      expect(provider.searchUrl('x')).toContain('post_type=product');
    });

    it('accepts the product addresses the search returns, and nothing else', () => {
      // Taken from a live result page, 2026-09.
      expect(
        provider.productUrlPattern.test(
          'https://www.cablecommerce.bg/produkt/2002-191-kapachka-za-zakljuchvane-na-kabel/',
        ),
      ).toBe(true);

      // A category is not a product, and it is the thing most likely to be
      // mistaken for one here.
      expect(
        provider.productUrlPattern.test(
          'https://www.cablecommerce.bg/produkt-kategoriya/kabeli-i-provodnici/',
        ),
      ).toBe(false);

      // Nor is another shop that merely ends with the same letters.
      expect(provider.productUrlPattern.test('https://notcablecommerce.bg/produkt/kabel/')).toBe(
        false,
      );
    });
  });
});
