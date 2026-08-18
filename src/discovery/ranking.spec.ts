import { groupOf, rank, RankableOffer, toHit } from './ranking';

const offer = (over: Partial<RankableOffer>): RankableOffer => ({
  title: 'КАБЕЛ H05V-K 1x1.5',
  url: 'https://shop.bg/kabel',
  price: 10,
  currency: 'EUR',
  host: 'shop.bg',
  shopName: 'Shop',
  shopId: null,
  discountPercent: 0,
  ...over,
});

describe('ranking', () => {
  describe('toHit', () => {
    it('applies the discount — that is the number the customer pays', () => {
      const hit = toHit(offer({ price: 100, discountPercent: 30 }), 'EUR');

      expect(hit.listedPrice).toBe(100);
      expect(hit.effectivePrice).toBe(70);
      expect(hit.discountPercent).toBe(30);
    });

    it('converts lev to euro at the fixed peg', () => {
      const hit = toHit(offer({ price: 195.583, currency: 'BGN' }), 'EUR');

      expect(hit.effectivePrice).toBe(100);
      expect(hit.effectiveCurrency).toBe('EUR');
      // The shelf price is reported as the shop stated it, not as converted:
      // the customer will see leva at the checkout.
      expect(hit.listedCurrency).toBe('BGN');
    });

    it('refuses to invent a rate for an unpegged currency', () => {
      const hit = toHit(offer({ price: 100, currency: 'USD' }), 'EUR');

      expect(hit.effectivePrice).toBeNull();
      expect(hit.effectiveCurrency).toBe('USD');
    });

    it('keeps a priceless result rather than dropping it', () => {
      const hit = toHit(offer({ price: null }), 'EUR');

      expect(hit.effectivePrice).toBeNull();
      expect(hit.url).toBe('https://shop.bg/kabel');
    });
  });

  describe('rank', () => {
    it('puts the shop that is cheapest AFTER discount first', () => {
      // The whole reason this system beats reading the shops by hand: 12.00 at
      // 30 % off is 8.40, which beats a 9.50 shelf price. Sorting on the
      // listed number gets this exactly backwards.
      const hits = rank(
        [
          offer({ shopName: 'Дешевият етикет', price: 9.5, discountPercent: 0 }),
          offer({ shopName: 'Моят доставчик', price: 12, discountPercent: 30 }),
        ],
        'EUR',
      );

      expect(hits[0].shopName).toBe('Моят доставчик');
      expect(hits[0].effectivePrice).toBe(8.4);
    });

    it('compares across currencies', () => {
      const hits = rank(
        [
          offer({ shopName: 'В евро', price: 100, currency: 'EUR' }),
          offer({ shopName: 'В лева', price: 150, currency: 'BGN' }),
        ],
        'EUR',
      );

      // 150 BGN is ~76.69 EUR — cheaper, though the bigger number.
      expect(hits[0].shopName).toBe('В лева');
    });

    it('keeps kinds of article apart instead of ranking across them', () => {
      // "Кабел" matches bare cable and a cable drum. Interleaving them by
      // price produces a table where the top row is not an alternative to the
      // second one.
      const hits = rank(
        [
          offer({ title: 'МАКАРА КАБЕЛНА 25м', price: 19 }),
          offer({ title: 'КАБЕЛ H05V-K 1x1.5', price: 0.14 }),
          offer({ title: 'МАКАРА КАБЕЛНА 50м', price: 31 }),
          offer({ title: 'КАБЕЛ H05V-K 1x2.5', price: 0.22 }),
        ],
        'EUR',
      );

      expect(hits.map((hit) => hit.groupLabel)).toEqual([
        'КАБЕЛ H05V-K',
        'КАБЕЛ H05V-K',
        'МАКАРА',
        'МАКАРА',
      ]);
    });

    it('leaves unpriced results at the end, not at the top', () => {
      const hits = rank(
        [offer({ title: 'КАБЕЛ A', price: null }), offer({ title: 'КАБЕЛ B', price: 5 })],
        'EUR',
      );

      expect(hits[0].name).toBe('КАБЕЛ B');
      expect(hits[1].effectivePrice).toBeNull();
    });
  });

  describe('groupOf', () => {
    it('groups by model code when the name carries one', () => {
      expect(groupOf('КАБЕЛ H05V-K 1x1.5 ЧЕРЕН').label).toBe('КАБЕЛ H05V-K');
    });

    it('falls back to the leading noun', () => {
      expect(groupOf('МАКАРА КАБЕЛНА 25м').label).toBe('МАКАРА');
    });

    it('does not mistake a dimension for a model code', () => {
      expect(groupOf('КАБЕЛ 3x2.5MM2').label).toBe('КАБЕЛ');
    });

    it('does not mistake a bracketed equivalent wattage for a model code', () => {
      // eMAG, verified 2026-08: every LED bulb states the incandescent
      // equivalent in brackets. Read as a code it produced group labels like
      // "КРУШКА (100W)" and split one shelf of bulbs by wattage.
      expect(groupOf('Крушка LED Osram, E27, 13W (100W), 1521 лумена').label).toBe('КРУШКА');
      expect(groupOf('LED крушка Philips B38, Свещ, E14, 7W (60W), 806 lm').label).toBe('LED');
    });

    it('still finds a real code that happens to sit in brackets', () => {
      expect(groupOf('ЛАМПА (LB-A55-7W) 7W').label).toBe('ЛАМПА LB-A55-7W');
    });

    it('survives an empty name', () => {
      expect(groupOf('')).toEqual({ key: 'other', label: 'Други' });
    });
  });
});
