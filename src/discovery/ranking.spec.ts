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

      // Cable before drums, and the two gauges apart: a 1x1.5 is not bought
      // instead of a 1x2.5, so a price difference between them is not a
      // finding.
      expect(hits.map((hit) => hit.groupLabel)).toEqual([
        'КАБЕЛ H05V-K 1X1.5',
        'КАБЕЛ H05V-K 1X2.5',
        'МАКАРА',
        'МАКАРА',
      ]);
    });

    it('groups the same article from different suppliers together', () => {
      // The comparison the buyer came for. Splitting by size is only worth
      // doing if it still brings one article's offers together across shops.
      const hits = rank(
        [
          offer({ title: 'КАБЕЛ СВТ 3x2.5', price: 0.9, shopName: 'А' }),
          offer({ title: 'КАБЕЛ СВТ 3x2.5', price: 0.62, shopName: 'Б', shopId: 'shop-2' }),
          offer({ title: 'КАБЕЛ СВТ 5x4', price: 1.85, shopName: 'А' }),
        ],
        'EUR',
      );

      const groups = new Set(
        hits.filter((hit) => hit.name.includes('3x2.5')).map((hit) => hit.groupKey),
      );

      expect(groups.size).toBe(1);
      expect(hits[0].shopName).toBe('Б');
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

  describe('page furniture', () => {
    // homefinishing.bg returned its become-a-partner link at the top of every
    // search, whatever was typed: no price, no relation to the query, and a
    // 0% match sitting in a table whose whole job is comparing prices.
    it('drops a promo tile that has neither a price nor anything to do with the query', () => {
      const hits = rank(
        [
          offer({ title: 'Станете партньор', price: null }),
          offer({ title: 'LED ЛАМПА 5,5W E27 4000K', price: 1.08 }),
        ],
        'EUR',
        60,
        'лед лампа',
      );

      expect(hits.map((hit) => hit.name)).toEqual(['LED ЛАМПА 5,5W E27 4000K']);
    });

    it('keeps a real article whose price would not parse', () => {
      // The shop stocks it and the link works. Dropping it would claim the
      // supplier does not carry something it does.
      const hits = rank([offer({ title: 'LED лампа 12W', price: null })], 'EUR', 60, 'led лампа');

      expect(hits).toHaveLength(1);
      expect(hits[0].effectivePrice).toBeNull();
    });

    it('keeps an unrelated result that at least has a price', () => {
      // That is the shop's search being generous, not furniture — and a price
      // is something the buyer can act on.
      const hits = rank([offer({ title: 'Суши сет PORTATA', price: 29.32 })], 'EUR', 60, 'лед лампа');

      expect(hits).toHaveLength(1);
    });

    it('drops the shop’s unpriced guesses, which are noise in a price table', () => {
      const hits = rank(
        [
          offer({ title: 'Оборудвана ъглова кухня VANIA', price: null }),
          offer({ title: 'LED крушка E27', price: 2.1 }),
        ],
        'EUR',
        60,
        'лед крушка',
      );

      expect(hits.map((hit) => hit.name)).toEqual(['LED крушка E27']);
    });
  });

  describe('fuzzy shop results', () => {
    // homefinishing.bg, verified 2026-08: searching "СВТ" returns
    // "САТ.НИКЕЛ", "Суши сет" and a picture light — none of which contains
    // "СВТ". That is their search engine being generous, not our extraction
    // being wrong, but presenting a guess as a match makes the tool look
    // broken.
    it('marks results whose name does not contain the query', () => {
      const hits = rank(
        [
          offer({ title: 'ЛУНА ЗА ВГРАЖДАНЕ SA-50R САТ. НИКЕЛ', price: 9 }),
          offer({ title: 'Суши сет PORTATA FUTARI, 8 части', price: 20 }),
        ],
        'EUR',
        60,
        'СВТ',
      );

      expect(hits.every((hit) => hit.matched)).toBe(false);
    });

    it('ranks real matches above the shop’s guesses, price notwithstanding', () => {
      const hits = rank(
        [
          offer({ title: 'ЛУНА САТ.НИКЕЛ', price: 1 }),
          offer({ title: 'КРУШКА LED E27 9W', price: 40 }),
        ],
        'EUR',
        60,
        'крушка',
      );

      expect(hits[0].name).toBe('КРУШКА LED E27 9W');
      expect(hits[0].matched).toBe(true);
      expect(hits[1].matched).toBe(false);
    });

    it('counts a Cyrillic/Latin homoglyph spelling as a match', () => {
      // The shop writes Cyrillic "Е27", the buyer types Latin "E27".
      const hits = rank([offer({ title: 'КРУШКА Е27 9W' })], 'EUR', 60, 'E27');

      expect(hits[0].matched).toBe(true);
    });

    it('treats everything as matched when the query is too short to judge', () => {
      const hits = rank([offer({ title: 'КАБЕЛ' })], 'EUR', 60, 'AB');

      expect(hits[0].matched).toBe(true);
    });
  });

  describe('groupOf', () => {
    it('groups by model code and size, which together identify the article', () => {
      expect(groupOf('КАБЕЛ H05V-K 1x1.5 ЧЕРЕН').label).toBe('КАБЕЛ H05V-K 1X1.5');
    });

    it('falls back to the leading noun', () => {
      expect(groupOf('МАКАРА КАБЕЛНА 25м').label).toBe('МАКАРА');
    });

    it('does not mistake a dimension for a model code, but keeps it in the label', () => {
      // Not a code — every shop selling that gauge writes it — yet it is what
      // separates one cable from another, so it belongs in the group.
      const group = groupOf('КАБЕЛ 3x2.5MM2');

      expect(group.label).toBe('КАБЕЛ 3X2.5MM2');
      expect(group.label.startsWith('КАБЕЛ ')).toBe(true);
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
