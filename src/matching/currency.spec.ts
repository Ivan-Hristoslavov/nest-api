import {
  CurrencyMismatchError,
  convert,
  isConvertible,
  parseRates,
  setRatesPerEur,
} from '../products/currency';

/**
 * Ranking three suppliers who quote in three currencies is the whole job. Do
 * it with a made-up rate and the answer is confidently wrong; refuse to do it
 * and the cheapest supplier hides. So: convert where a rate was supplied, and
 * say so plainly where none was.
 */
describe('currency normalisation for ranking', () => {
  afterEach(() => setRatesPerEur({}));

  it('converts the pegged pair without any configuration', () => {
    expect(isConvertible('BGN', 'EUR')).toBe(true);
    expect(convert(195.583, 'BGN', 'EUR')).toBe(100);
  });

  it('refuses a pair nobody supplied a rate for', () => {
    expect(isConvertible('USD', 'EUR')).toBe(false);
    expect(() => convert(10, 'USD', 'EUR')).toThrow(CurrencyMismatchError);
  });

  it('compares dollars, pounds and euro once rates exist', () => {
    setRatesPerEur({ USD: 1.1, GBP: 0.85 });

    // €10, $11 and £8 — the pound is the cheapest of the three, and only a
    // conversion shows it: on the raw numbers it looks like the middle one.
    expect(convert(11, 'USD', 'EUR')).toBe(10);
    expect(convert(8, 'GBP', 'EUR')).toBe(9.41);
    expect(convert(8, 'GBP', 'USD')).toBe(10.35);
  });

  it('reads the rate table an operator writes', () => {
    expect(parseRates('USD:1.08, GBP:0.85')).toEqual({ USD: 1.08, GBP: 0.85 });
    // Junk is dropped rather than becoming a rate of NaN.
    expect(parseRates('USD:abc,GBP:0,:1.2,EUR')).toEqual({});
    expect(parseRates(undefined)).toEqual({});
  });
});
