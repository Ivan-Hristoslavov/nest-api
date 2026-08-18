import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PriceParserService } from './price-parser.service';
import { profileForHost, retailerNameForHost } from './site-profiles';

const varioFixture = readFileSync(
  join(__dirname, '../../../test/fixtures/vario-product.html'),
  'utf8',
);

const elmarkFixture = readFileSync(
  join(__dirname, '../../../test/fixtures/elmarkstore-product.html'),
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

  describe('elmarkstore.eu (real page markup)', () => {
    // The page's only machine-readable price is inside an HTML comment, the
    // buy box is filled by JavaScript, and `.price` appears once per
    // related-products tile with a different value each. Without the profile
    // this page parses as "no price" — which is exactly how a 121-page crawl
    // once indexed zero offers.
    it('reads the price via the profile, matched through the bg. subdomain', () => {
      const profile = profileForHost('bg.elmarkstore.eu');
      const result = parser.parse(elmarkFixture, { profile });

      expect(profile?.host).toBe('elmarkstore.eu');
      expect(result?.price).toBe(83.52);
      expect(result?.currency).toBe('EUR');
      expect(result?.strategy).toBe('site-profile');
    });

    it('refuses to guess without the profile rather than pick a carousel price', () => {
      expect(parser.parse(elmarkFixture)).toBeNull();
    });
  });

  describe('decimals rendered as a superscript', () => {
    // buybest.bg, 2026-08:
    //   <span itemprop="price"><strong>432</strong> <sup>00</sup></span>
    // The comma is drawn by CSS and exists nowhere in the DOM, so joining the
    // text nodes gives "432 00" — read naively as 43 200.
    it('rejoins <sup> cents that carry no separator', () => {
      const html =
        '<html><body><span itemprop="price"><strong>432</strong> <sup>00</sup></span></body></html>';

      expect(parser.parse(html)?.price).toBe(432);
    });

    it('handles a <sup> that already carries the separator', () => {
      const html =
        '<html><body><em class="current_price"><span>428</span><sup>.00</sup><small>лв.</small></em></body></html>';

      expect(parser.parse(html)?.price).toBe(428);
    });

    it('pads a single-digit superscript', () => {
      const html =
        '<html><body><div class="price"><strong>19</strong><sup>9</sup></div></body></html>';

      expect(parser.parse(html)?.price).toBe(19.9);
    });

    it('leaves a superscript that is not a decimal part alone', () => {
      const html = '<html><body><div class="price">1 299,00 лв.<sup>*</sup></div></body></html>';

      expect(parser.parse(html)?.price).toBe(1299);
    });
  });

  describe('listing pages', () => {
    // A category or home page carries one price per tile. Returning the first
    // one is worse than returning nothing: it looks authoritative and is wrong.
    it('refuses a page holding several different prices', () => {
      const tiles = [432, 899, 1299]
        .map((price) => '<span itemprop="price">' + price + '</span>')
        .join('');

      expect(parser.parse('<html><body>' + tiles + '</body></html>')).toBeNull();
    });

    it('accepts a page repeating the same price', () => {
      const html =
        '<html><body><span itemprop="price">432,00</span><span itemprop="price">432,00</span></body></html>';

      expect(parser.parse(html)?.price).toBe(432);
    });

    it('still honours an explicit selector on a listing page', () => {
      const html =
        '<html><body><div id="main"><span class="p">432,00</span></div>' +
        '<span itemprop="price">899</span><span itemprop="price">1299</span></body></html>';

      expect(parser.parse(html, { selector: '#main .p' })?.price).toBe(432);
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
