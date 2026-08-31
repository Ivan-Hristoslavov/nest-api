import { matchNames } from '../matching/deterministic-matcher';
import { partitionByVerdict, bestOffer } from './verdict';
import { domainOf, identifierSpellings } from './web-discovery.service';

/**
 * Searching the web, and refusing to believe it.
 *
 * Web discovery is the second retrieval strategy, and the whole risk it adds
 * is credulity: a search engine returns confident, well-titled, plausibly
 * priced pages for a query it could not satisfy, exactly as a shop's own
 * search does. So the rule is the same one the supplier path already obeys —
 * an address is a candidate, a fetched page is a candidate, and only the
 * matcher makes either an offer.
 */

describe('identifier spellings', () => {
  it('offers the three spellings catalogues actually use', () => {
    expect(identifierSpellings('XPA12-75').sort()).toEqual(
      ['XPA12 75', 'XPA12-75', 'XPA1275'].sort(),
    );
  });

  it('invents nothing for a code with no separator', () => {
    // A code with nothing to respell has one spelling. Generating more would
    // search for part numbers that do not exist and then fetch, with
    // confidence, whatever pages came back.
    expect(identifierSpellings('GSH5CE')).toEqual(['GSH5CE']);
  });

  it('treats every spelling as the same part number', () => {
    // The point of the variants: all three must match one another, so the
    // spelling a shop happened to use never decides a purchase.
    for (const spelling of identifierSpellings('XPA12-75')) {
      expect(matchNames('STATUS XPA12-75', `Полирмашина Status ${spelling} 750W`).relation).toBe(
        'same_product',
      );
    }
  });

  it('has nothing to say about an empty code', () => {
    expect(identifierSpellings('')).toEqual([]);
    expect(identifierSpellings('   ')).toEqual([]);
  });
});

describe('domains', () => {
  it('reads the host and drops www', () => {
    expect(domainOf('https://www.tomika.bg/product/x/')).toBe('tomika.bg');
    expect(domainOf('https://bg.status-tools.com/products/y/')).toBe('bg.status-tools.com');
  });

  it('refuses anything that is not a web address', () => {
    // A search result is untrusted input. `file:` and `javascript:` are not
    // pages to fetch, and neither is a string that does not parse.
    expect(domainOf('file:///etc/passwd')).toBeNull();
    expect(domainOf('javascript:alert(1)')).toBeNull();
    expect(domainOf('not a url')).toBeNull();
  });
});

describe('what the web returns is still only a candidate', () => {
  const judge = (query: string, pages: Array<{ name: string; effectivePrice: number | null }>) =>
    partitionByVerdict(pages.map((page) => ({ ...page, match: matchNames(query, page.name) })));

  it('turns real discovered pages into offers', () => {
    // Titles read from the live pages web discovery found on 2026-08-31, for a
    // part number none of the buyer's suppliers stocks and no configured shop
    // had ever been taught.
    const verdict = judge('STATUS XPA12-75', [
      { name: 'Полирмашина STATUS XPA12-75 , 750 W - Томика', effectivePrice: 95 },
      { name: 'Вибрационна полирмашина STATUS XPA12‐75/ 750W - Топ Цена', effectivePrice: 99 },
      { name: 'Вибрационна полирмашина Status XPA12-75 50/75мм - 750W', effectivePrice: 117.1 },
    ]);

    expect(verdict.status).toBe('MATCH');
    expect(verdict.matches).toHaveLength(3);
    expect(bestOffer(verdict.matches)?.effectivePrice).toBe(95);
  });

  it('refuses discovered pages that are not the article', () => {
    // The same discipline as the supplier path. A search engine returns
    // confident, well-titled, priced pages for a query it could not satisfy,
    // and a fetched page is not more trustworthy than a scraped tile.
    const verdict = judge('STATUS XPA12-75', [
      { name: 'Полираща паста за автомобил 500ml', effectivePrice: 12.9 },
      { name: 'Ъглошлайф Bosch GWS 750, 750W', effectivePrice: 89 },
      { name: 'Таблет Blackview Rugged Tab Active 10 Pro, 512GB', effectivePrice: 503.69 },
    ]);

    expect(verdict.status).toBe('NO_MATCH');
    expect(verdict.matches).toHaveLength(0);
    expect(verdict.alternatives).toHaveLength(0);
    expect(bestOffer(verdict.matches)).toBeNull();
  });

  it('does not let a cheap unrelated page win on price', () => {
    // 12.90 € of polishing paste against a 95 € polishing machine. Both are
    // about polishing; only one is the article.
    const verdict = judge('STATUS XPA12-75', [
      { name: 'Полираща паста за автомобил 500ml', effectivePrice: 12.9 },
      { name: 'Полирмашина STATUS XPA12-75 , 750 W - Томика', effectivePrice: 95 },
    ]);

    expect(bestOffer(verdict.matches)?.effectivePrice).toBe(95);
  });

  it('keeps a page whose price could not be read out of the price ranking', () => {
    // The manufacturer's own page lists the machine and quotes nobody. It is a
    // true match and it is not an offer anyone can accept, so it must not be
    // able to win — or to hide — the cheapest real quote.
    const verdict = judge('STATUS XPA12-75', [
      { name: 'XPA12-75 Ексцентър полирмашина - Електроинструменти STATUS', effectivePrice: null },
      { name: 'Полирмашина STATUS XPA12-75 , 750 W - Томика', effectivePrice: 95 },
    ]);

    expect(verdict.matches).toHaveLength(2);
    expect(bestOffer(verdict.matches)?.effectivePrice).toBe(95);
  });
});
