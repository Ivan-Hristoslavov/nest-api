import { matchNames } from '../matching/deterministic-matcher';
import { rank, RankableOffer } from './ranking';

const offer = (over: Partial<RankableOffer>): RankableOffer => ({
  title: 'КАБЕЛ СВТ 3x2.5',
  url: 'https://shop.bg/x',
  price: 1,
  currency: 'EUR',
  host: 'shop.bg',
  shopName: 'Shop',
  shopId: 'shop-1',
  discountPercent: 0,
  ...over,
});

/**
 * The rules a priced order rests on.
 *
 * A basket total is a number somebody places an order against, so the ways it
 * can be quietly wrong matter more here than anywhere else in the system: a
 * line counted at the wrong item, or a supplier credited with stock they do
 * not carry, produces an order that cannot be filled at a price nobody quoted.
 */
describe('basket pricing rules', () => {
  describe('only genuine matches may be totalled', () => {
    it('marks a fuzzy result so it can be kept out of a total', () => {
      // homefinishing.bg, verified: asked for "лампа" it offers a chandelier.
      // Counted as that line's price it put the supplier's order at 2298 €
      // against 220 € elsewhere, and would have written them off for stocking
      // something nobody asked about.
      const hits = rank(
        [
          offer({ title: 'ПОЛИЛЕЙ КРИСТАЛЕН 8xE14', price: 229.84 }),
          offer({ title: 'ЛАМПА LED 9W E27', price: 1.99, shopId: 'shop-2' }),
        ],
        'EUR',
        40,
        'лампа',
      );

      const chandelier = hits.find((hit) => hit.name.startsWith('ПОЛИЛЕЙ'));
      const lamp = hits.find((hit) => hit.name.startsWith('ЛАМПА'));

      expect(chandelier?.matched).toBe(false);
      expect(lamp?.matched).toBe(true);
    });

    it('leaves a supplier with no real match unrepresented on the line', () => {
      const hits = rank([offer({ title: 'ПОЛИЛЕЙ КРИСТАЛЕН' })], 'EUR', 40, 'кабел');

      // Every offer is a guess, so nothing here may be counted as a quote.
      expect(hits.filter((hit) => hit.matched)).toHaveLength(0);
    });
  });

  describe('one line, one price per supplier', () => {
    it('takes a supplier’s cheapest match, not their first', () => {
      const hits = rank(
        [
          offer({ title: 'КАБЕЛ СВТ 3x2.5 бял', price: 0.9 }),
          offer({ title: 'КАБЕЛ СВТ 3x2.5 черен', price: 0.62 }),
          offer({ title: 'КАБЕЛ СВТ 3x2.5 сив', price: 0.71 }),
        ],
        'EUR',
        40,
        'кабел свт',
      );

      // The basket keeps the first per supplier, so cheapest-first ordering is
      // what makes that the cheapest rather than an arbitrary variant.
      const first = hits.find((hit) => hit.shopId === 'shop-1' && hit.matched);
      expect(first?.effectivePrice).toBe(0.62);
    });

    it('ranks by the discounted price, so the total reflects what is paid', () => {
      const hits = rank(
        [
          offer({ shopName: 'Без отстъпка', price: 0.6, discountPercent: 0 }),
          offer({ shopName: 'С отстъпка', price: 0.7, discountPercent: 30, shopId: 'shop-2' }),
        ],
        'EUR',
        40,
        'кабел свт',
      );

      expect(hits[0].shopName).toBe('С отстъпка');
      expect(hits[0].effectivePrice).toBe(0.49);
    });
  });

  describe('what a total must not hide', () => {
    it('keeps an unpriced result out of the way of a priced one', () => {
      const hits = rank(
        [
          offer({ title: 'КАБЕЛ СВТ 3x2.5 A', price: null }),
          offer({ title: 'КАБЕЛ СВТ 3x2.5 B', price: 0.8, shopId: 'shop-2' }),
        ],
        'EUR',
        40,
        'кабел свт',
      );

      // A line whose price could not be read is not a free line.
      expect(hits[0].effectivePrice).toBe(0.8);
      expect(hits[1].effectivePrice).toBeNull();
    });

    it('carries the age of a hand-entered price into the ranking', () => {
      const when = '2026-08-01T10:00:00.000Z';
      const hits = rank(
        [offer({ title: 'КАБЕЛ СВТ 3x2.5', price: 0.5, recordedAt: when })],
        'EUR',
        40,
        'кабел свт',
      );

      // A total mixing a price read seconds ago with one typed a month ago has
      // to be able to say which is which.
      expect(hits[0].recordedAt).toBe(when);
    });

    it('gives a live price no recordedAt, so the two are distinguishable', () => {
      const hits = rank([offer({ price: 0.5 })], 'EUR', 40, 'кабел свт');

      expect(hits[0].recordedAt).toBeNull();
    });
  });
});

/**
 * The gate a line's total rests on.
 *
 * Previously this was "does the shop's name contain the words the buyer
 * typed", which is wrong in both directions: a chandelier answers "лампа",
 * and a German listing whose specification matches perfectly answers nothing
 * at all. Both mistakes end in an order at the wrong price.
 */
describe('what may be counted as a quote for a line', () => {
  const floor = 0.7;

  it('keeps the chandelier out of a lamp line', () => {
    expect(matchNames('лампа', 'ПОЛИЛЕЙ КРИСТАЛЕН 8xE14').confidence).toBeLessThan(floor);
  });

  it('lets a supplier who writes in another language fill the line', () => {
    // The specification is identical and not one word is shared. Under the old
    // gate this supplier was reported as unable to supply an article they
    // stock.
    const verdict = matchNames('LED крушка 12W Е27', 'LED Lampe 12W E27 neutralweiss');
    expect(verdict.blocked).toBe(false);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('never lets a different size fill the line', () => {
    expect(matchNames('КАБЕЛ СВТ 3x1.5', 'КАБЕЛ СВТ 5x4').blocked).toBe(true);
  });
});
