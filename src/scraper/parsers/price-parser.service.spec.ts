import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PriceParserService } from './price-parser.service';
import { profileForHost, retailerNameForHost } from './site-profiles';

const varioFixture = readFileSync(
  join(__dirname, '../../../test/fixtures/vario-product.html'),
  'utf8',
);

describe('PriceParserService', () => {
  let parser: PriceParserService;

  beforeEach(() => {
    parser = new PriceParserService();
  });

  describe('parseAmount', () => {
    it.each([
      ['428.00лв.', 428],
      ['1 299,00 лв.', 1299],
      ['1.299,00 €', 1299],
      ['1,299.00 USD', 1299],
      ['€289.99', 289.99],
      ['289,99', 289.99],
      ['1.299', 1299],
      ['1.234.567,89', 1234567.89],
      ['   4 999,50 лв. ', 4999.5],
      ['218.83', 218.83],
      ['99', 99],
    ])('parses %s as %s', (input, expected) => {
      expect(parser.parseAmount(input)).toBe(expected);
    });

    it.each([['', 'няма цена', 'лв.', '0', '-']])('rejects %s', (input) => {
      expect(parser.parseAmount(input)).toBeNull();
    });
  });

  describe('detectCurrency', () => {
    it.each([
      ['428.00 лв.', 'BGN'],
      ['€289.99', 'EUR'],
      ['$1,299.00', 'USD'],
      ['1299 EUR', 'EUR'],
      ['£99', 'GBP'],
    ])('detects %s as %s', (input, expected) => {
      expect(parser.detectCurrency(input)).toBe(expected);
    });

    it('returns null when no currency is present', () => {
      expect(parser.detectCurrency('428.00')).toBeNull();
    });
  });

  describe('vario.bg (real page markup)', () => {
    it('reads the BGN price, not the EUR one, when the profile is applied', () => {
      const profile = profileForHost('www.vario.bg');
      const result = parser.parse(varioFixture, { profile });

      // The page shows 428.00 лв. and 218.83 €. Without the profile the
      // microdata strategy would return the euro figure.
      expect(result).not.toBeNull();
      expect(result?.price).toBe(428);
      expect(result?.currency).toBe('BGN');
      expect(result?.strategy).toBe('site-profile');
    });

    it('falls back to the euro microdata price without a profile', () => {
      const result = parser.parse(varioFixture);

      expect(result?.price).toBe(218.83);
      expect(result?.strategy).toBe('microdata');
    });

    it('honours a per-listing selector over the profile', () => {
      const result = parser.parse(varioFixture, {
        selector: '#subtotal_price_eur',
        profile: profileForHost('vario.bg'),
      });

      expect(result?.price).toBe(218.83);
      expect(result?.strategy).toBe('selector');
    });
  });

  describe('structured data', () => {
    it('reads a JSON-LD offer', () => {
      const html = `<html><head><script type="application/ld+json">
        {"@context":"https://schema.org","@type":"Product","name":"Thing",
         "offers":{"@type":"Offer","price":"289.99","priceCurrency":"EUR",
         "availability":"https://schema.org/InStock"}}
      </script></head><body></body></html>`;

      const result = parser.parse(html);

      expect(result).toEqual({
        price: 289.99,
        currency: 'EUR',
        inStock: true,
        strategy: 'json-ld',
      });
    });

    it('finds an offer nested inside @graph', () => {
      const html = `<html><head><script type="application/ld+json">
        {"@graph":[{"@type":"WebPage"},{"@type":"Product",
         "offers":{"price":42.5,"priceCurrency":"BGN"}}]}
      </script></head><body></body></html>`;

      expect(parser.parse(html)?.price).toBe(42.5);
    });

    it('marks an out-of-stock offer', () => {
      const html = `<html><head><script type="application/ld+json">
        {"@type":"Product","offers":{"price":"10.00","priceCurrency":"EUR",
         "availability":"https://schema.org/OutOfStock"}}
      </script></head><body></body></html>`;

      expect(parser.parse(html)?.inStock).toBe(false);
    });

    it('skips malformed JSON-LD instead of failing the scrape', () => {
      const html = `<html><head>
        <script type="application/ld+json">{ this is not json }</script>
        <meta property="product:price:amount" content="55.40">
        <meta property="product:price:currency" content="EUR">
      </head><body></body></html>`;

      const result = parser.parse(html);

      expect(result?.price).toBe(55.4);
      expect(result?.strategy).toBe('meta');
    });

    it('falls back to common selectors when nothing is structured', () => {
      const html = `<html><body><div class="product-price">129,90 лв.</div></body></html>`;
      const result = parser.parse(html);

      expect(result?.price).toBe(129.9);
      expect(result?.currency).toBe('BGN');
      expect(result?.strategy).toBe('heuristic');
    });

    it('returns null when the page carries no price at all', () => {
      expect(parser.parse('<html><body><p>Нищо тук</p></body></html>')).toBeNull();
    });
  });
});

describe('site profiles', () => {
  it('matches with and without www, and on subdomains', () => {
    expect(profileForHost('vario.bg')?.name).toBe('Vario');
    expect(profileForHost('www.vario.bg')?.name).toBe('Vario');
    expect(profileForHost('shop.vario.bg')?.name).toBe('Vario');
  });

  it('returns null for an unknown retailer', () => {
    expect(profileForHost('some-other-shop.example.com')).toBeNull();
  });

  it('falls back to the hostname when naming an unknown retailer', () => {
    expect(retailerNameForHost('www.unknown-shop.com')).toBe('unknown-shop.com');
  });
});
