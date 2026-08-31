import { NEUTRAL_TERMS, SupplierTerms, VatCertainty } from './effective-cost';
import { OptimiserLine, OptimiserOffer, OptimiserOptions, optimiseOrder } from './order-optimizer';

/**
 * The plan a buyer places an order against.
 *
 * Every case here is one a real basket produces, and several are ones the old
 * greedy split got wrong in the same direction: it made the plan look cheaper
 * than it was, and sometimes recommended an order that would have been refused.
 *
 * The worked example in `chooses a different supplier set than greedy would`
 * is the one to read first — it is the whole argument for this module in
 * numbers.
 */

function supplier(id: string, overrides: Partial<SupplierTerms> = {}): SupplierTerms {
  return {
    ...NEUTRAL_TERMS,
    shopId: id,
    name: id.toUpperCase(),
    currency: 'EUR',
    ...overrides,
  };
}

function offer(shopId: string, unitPrice: number | null, overrides: Partial<OptimiserOffer> = {}) {
  return {
    shopId,
    unitPrice,
    confidence: 0.95,
    available: null,
    priceSource: 'live' as const,
    recordedAt: null,
    vatCertainty: VatCertainty.Known,
    ...overrides,
  };
}

function line(query: string, quantity: number, offers: OptimiserOffer[]): OptimiserLine {
  return { query, quantity, offers };
}

function run(
  lines: OptimiserLine[],
  suppliers: SupplierTerms[],
  options: Partial<OptimiserOptions> = {},
) {
  return optimiseOrder(lines, new Map(suppliers.map((s) => [s.shopId!, s])), {
    currency: 'EUR',
    ...options,
  });
}

describe('order optimiser', () => {
  // ===========================================================================
  describe('the basic shapes', () => {
    it('puts everything at the only supplier there is', () => {
      const result = run(
        [line('a', 10, [offer('s1', 2)]), line('b', 5, [offer('s1', 4)])],
        [supplier('s1')],
      );

      expect(result.best?.suppliersUsed).toBe(1);
      expect(result.best?.total).toBe(40); // 10×2 + 5×4
      expect(result.best?.suppliers[0].shopId).toBe('s1');
    });

    it('stays with one supplier when splitting saves nothing', () => {
      const result = run(
        [
          line('a', 10, [offer('s1', 2), offer('s2', 3)]),
          line('b', 10, [offer('s1', 2), offer('s2', 3)]),
        ],
        [supplier('s1'), supplier('s2')],
      );

      expect(result.best?.suppliersUsed).toBe(1);
      expect(result.best?.total).toBe(40);
      // Nothing to save against itself.
      expect(result.savings).toBe(0);
    });

    it('splits across two when it is genuinely cheaper', () => {
      const result = run(
        [
          line('a', 10, [offer('s1', 2), offer('s2', 5)]),
          line('b', 10, [offer('s1', 5), offer('s2', 2)]),
        ],
        [supplier('s1'), supplier('s2')],
      );

      expect(result.best?.suppliersUsed).toBe(2);
      expect(result.best?.total).toBe(40); // 20 + 20
      expect(result.baseline?.total).toBe(70); // 20 + 50 at s1
      expect(result.savings).toBe(30);
    });

    it('splits across three when each wins a line outright', () => {
      const result = run(
        [
          line('a', 10, [offer('s1', 1), offer('s2', 9), offer('s3', 9)]),
          line('b', 10, [offer('s1', 9), offer('s2', 1), offer('s3', 9)]),
          line('c', 10, [offer('s1', 9), offer('s2', 9), offer('s3', 1)]),
        ],
        [supplier('s1'), supplier('s2'), supplier('s3')],
      );

      expect(result.best?.suppliersUsed).toBe(3);
      expect(result.best?.total).toBe(30);
      expect(result.baseline?.total).toBe(190);
      expect(result.savings).toBe(160);
    });
  });

  // ===========================================================================
  describe('coverage', () => {
    it('leaves out a supplier who is missing a line, unless nobody else has it', () => {
      const result = run(
        [
          line('a', 10, [offer('s1', 2), offer('s2', 1)]),
          line('b', 10, [offer('s1', 2)]), // only s1
        ],
        [supplier('s1'), supplier('s2')],
      );

      // s1 alone is 40; s1+s2 is 10 + 20 = 30. The split wins.
      expect(result.best?.total).toBe(30);
      expect(result.baseline?.total).toBe(40);
      // s2 cannot be a baseline: they do not carry line b.
      expect(result.baseline?.suppliers[0].shopId).toBe('s1');
    });

    it('reports a line nobody carries rather than quietly dropping it', () => {
      const result = run(
        [line('a', 10, [offer('s1', 2)]), line('unobtainable', 5, [])],
        [supplier('s1')],
      );

      expect(result.best?.total).toBe(20);
      expect(result.unassigned).toHaveLength(1);
      expect(result.unassigned[0].query).toBe('unobtainable');
      expect(result.unassigned[0].reason).toBe('no_offers');
      expect(result.explanation.tradeOffs.join(' ')).toContain('не беше намерен');
    });

    it('agrees in number when several lines are unobtainable', () => {
      const result = run(
        [line('a', 1, [offer('s1', 2)]), line('x', 1, []), line('y', 1, [])],
        [supplier('s1')],
      );

      expect(result.unassigned).toHaveLength(2);
      expect(result.explanation.tradeOffs.join(' ')).toContain('2 артикула не бяха намерени');
      expect(result.explanation.tradeOffs.join(' ')).toContain('не участват');
    });

    it('has no baseline when no single supplier can fill the order', () => {
      const result = run(
        [line('a', 10, [offer('s1', 2)]), line('b', 10, [offer('s2', 2)])],
        [supplier('s1'), supplier('s2')],
      );

      expect(result.best?.suppliersUsed).toBe(2);
      expect(result.baseline).toBeNull();
      // Never invent a saving against a partial order — it would be comparing
      // two different purchases.
      expect(result.savings).toBeNull();
      expect(result.savingsPercent).toBeNull();
    });
  });

  // ===========================================================================
  describe('minimum order', () => {
    it('refuses a plan that leaves a supplier below their minimum', () => {
      const result = run(
        [
          line('a', 10, [offer('s1', 2), offer('s2', 9)]), // 20 at s1
          line('b', 1, [offer('s1', 50), offer('s2', 10)]), // 10 at s2 — under 200
        ],
        [supplier('s1'), supplier('s2', { minOrderValue: 200 })],
      );

      // Greedy would say 20 + 10 = 30 and be refused by s2.
      expect(result.best?.suppliersUsed).toBe(1);
      expect(result.best?.suppliers[0].shopId).toBe('s1');
      expect(result.best?.total).toBe(70); // 20 + 50
    });

    it('tops a supplier up to their minimum when that is cheaper than dropping them', () => {
      const result = run(
        [
          line('big', 1, [offer('s1', 300), offer('s2', 190)]), // s2 much cheaper
          line('small', 1, [offer('s1', 10), offer('s2', 12)]), // s1 marginally cheaper
        ],
        [supplier('s1'), supplier('s2', { minOrderValue: 200 })],
      );

      // Greedy: s2 gets 190 (under 200) and s1 gets 10. Infeasible.
      // Dropping s2 costs 310. Topping up by moving `small` to s2 costs 202.
      expect(result.best?.total).toBe(202);
      expect(result.best?.suppliersUsed).toBe(1);
      expect(result.best?.suppliers[0].shopId).toBe('s2');
    });

    it('says how far short a supplier fell when nothing is feasible', () => {
      const result = run(
        [line('a', 1, [offer('s1', 120)])],
        [supplier('s1', { minOrderValue: 200 })],
      );

      expect(result.best).toBeNull();
      expect(result.rejectedSuppliers).toHaveLength(1);
      expect(result.rejectedSuppliers[0].reason).toBe('below_minimum_order');
      expect(result.rejectedSuppliers[0].goodsTotal).toBe(120);
      expect(result.rejectedSuppliers[0].minOrderValue).toBe(200);
      expect(result.rejectedSuppliers[0].message).toContain('200');
    });

    it('accepts an order exactly at the minimum', () => {
      const result = run(
        [line('a', 1, [offer('s1', 200)])],
        [supplier('s1', { minOrderValue: 200 })],
      );

      expect(result.best?.total).toBe(200);
    });
  });

  // ===========================================================================
  describe('shipping', () => {
    it('adds delivery once per supplier, not per line', () => {
      const result = run(
        [line('a', 1, [offer('s1', 10)]), line('b', 1, [offer('s1', 10)])],
        [supplier('s1', { shippingCost: 12 })],
      );

      expect(result.best?.productSubtotal).toBe(20);
      expect(result.best?.shipping).toBe(12);
      expect(result.best?.total).toBe(32);
    });

    it('lets delivery make a split not worth it', () => {
      const result = run(
        [
          line('a', 1, [offer('s1', 100), offer('s2', 100)]),
          line('b', 1, [offer('s1', 100), offer('s2', 95)]), // s2 saves 5
        ],
        [supplier('s1'), supplier('s2', { shippingCost: 20 })], // but costs 20 to use
      );

      // Greedy on goods: 100 + 95 = 195, plus s2's 20 delivery = 215.
      // One supplier: 200. The split is worse.
      expect(result.best?.suppliersUsed).toBe(1);
      expect(result.best?.total).toBe(200);
    });

    it('waives delivery at the free threshold', () => {
      const result = run(
        [line('a', 1, [offer('s1', 300)])],
        [supplier('s1', { shippingCost: 12, freeShippingOver: 300 })],
      );

      expect(result.best?.suppliers[0].shippingWaived).toBe(true);
      expect(result.best?.total).toBe(300);
    });

    it('charges delivery one cent below the threshold', () => {
      const result = run(
        [line('a', 1, [offer('s1', 299.99)])],
        [supplier('s1', { shippingCost: 12, freeShippingOver: 300 })],
      );

      expect(result.best?.suppliers[0].shippingWaived).toBe(false);
      expect(result.best?.total).toBe(311.99);
    });

    it('moves a line to cross a free-delivery threshold when that is cheaper', () => {
      const result = run(
        [
          line('big', 1, [offer('s1', 290), offer('s2', 400)]),
          line('small', 1, [offer('s1', 15), offer('s2', 12)]), // s2 cheaper by 3
        ],
        [supplier('s1', { shippingCost: 20, freeShippingOver: 300 }), supplier('s2')],
      );

      // Greedy: s1 290 (+20 delivery) + s2 12 = 322.
      // Moving `small` to s1: 305, delivery waived → 305. Cheaper.
      expect(result.best?.total).toBe(305);
      expect(result.best?.suppliersUsed).toBe(1);
      expect(result.best?.suppliers[0].shippingWaived).toBe(true);
    });

    it('does not move lines to cross a threshold when it does not pay', () => {
      const result = run(
        [
          line('big', 1, [offer('s1', 290), offer('s2', 400)]),
          line('small', 1, [offer('s1', 100), offer('s2', 5)]), // 95 penalty to move
        ],
        [supplier('s1', { shippingCost: 20, freeShippingOver: 300 }), supplier('s2')],
      );

      // Crossing would cost 95 to save 20. Keep the split.
      expect(result.best?.total).toBe(315); // 290 + 20 delivery + 5
      expect(result.best?.suppliersUsed).toBe(2);
    });

    it('handles zero shipping without special-casing', () => {
      const result = run(
        [line('a', 1, [offer('s1', 50)])],
        [supplier('s1', { shippingCost: 0, freeShippingOver: null })],
      );

      expect(result.best?.shipping).toBe(0);
      expect(result.best?.total).toBe(50);
    });
  });

  // ===========================================================================
  describe('handling fee', () => {
    it('adds it once per supplier and never waives it', () => {
      const result = run(
        [line('a', 1, [offer('s1', 500)])],
        [supplier('s1', { handlingFee: 5, shippingCost: 10, freeShippingOver: 100 })],
      );

      // Delivery is waived at 500; handling is not.
      expect(result.best?.shipping).toBe(0);
      expect(result.best?.handlingFee).toBe(5);
      expect(result.best?.total).toBe(505);
    });

    it('counts handling for every supplier in a split', () => {
      const result = run(
        [
          line('a', 1, [offer('s1', 10), offer('s2', 100)]),
          line('b', 1, [offer('s1', 100), offer('s2', 10)]),
        ],
        [supplier('s1', { handlingFee: 3 }), supplier('s2', { handlingFee: 3 })],
      );

      expect(result.best?.suppliersUsed).toBe(2);
      expect(result.best?.handlingFee).toBe(6);
      expect(result.best?.total).toBe(26);
    });

    it('handles zero handling without special-casing', () => {
      const result = run([line('a', 1, [offer('s1', 50)])], [supplier('s1', { handlingFee: 0 })]);

      expect(result.best?.handlingFee).toBe(0);
    });
  });

  // ===========================================================================
  describe('offers the optimiser refuses to use', () => {
    it('drops a match below the confidence floor and says which', () => {
      const result = run(
        [line('a', 1, [offer('s1', 5, { confidence: 0.4 }), offer('s2', 10)])],
        [supplier('s1'), supplier('s2')],
        { minConfidence: 0.7 },
      );

      expect(result.best?.suppliers[0].shopId).toBe('s2');
      expect(result.best?.total).toBe(10);
    });

    it('reports a line whose every offer was too uncertain', () => {
      const result = run([line('a', 1, [offer('s1', 5, { confidence: 0.4 })])], [supplier('s1')], {
        minConfidence: 0.7,
      });

      expect(result.best).toBeNull();
      expect(result.unassigned[0].reason).toBe('all_rejected');
      expect(result.unassigned[0].rejections[0].reason).toBe('low_confidence');
    });

    it('keeps an offer whose availability is unknown', () => {
      // Null means the listing did not say, which is most of the time.
      // Dropping those would empty most comparisons.
      const result = run([line('a', 1, [offer('s1', 5, { available: null })])], [supplier('s1')], {
        requireAvailable: true,
      });

      expect(result.best?.total).toBe(5);
    });

    it('drops an explicitly out-of-stock offer when asked to', () => {
      const result = run(
        [line('a', 1, [offer('s1', 5, { available: false }), offer('s2', 9)])],
        [supplier('s1'), supplier('s2')],
        { requireAvailable: true },
      );

      expect(result.best?.suppliers[0].shopId).toBe('s2');
    });

    it('keeps an out-of-stock offer when not asked to', () => {
      const result = run([line('a', 1, [offer('s1', 5, { available: false })])], [supplier('s1')]);

      expect(result.best?.total).toBe(5);
    });

    it('drops an offer with no readable price', () => {
      const result = run(
        [line('a', 1, [offer('s1', null), offer('s2', 9)])],
        [supplier('s1'), supplier('s2')],
      );

      expect(result.best?.suppliers[0].shopId).toBe('s2');
      // An unpriceable offer is a gap, never a free item.
      expect(result.best?.total).toBe(9);
    });

    it('drops an offer from a supplier the buyer excluded', () => {
      const result = run(
        [line('a', 1, [offer('s1', 5), offer('s2', 9)])],
        [supplier('s1'), supplier('s2')],
        { excludeShopIds: ['s1'] },
      );

      expect(result.best?.suppliers[0].shopId).toBe('s2');
      expect(result.rejectedSuppliers.map((r) => r.reason)).toContain('excluded_by_customer');
    });

    it('drops an offer from a supplier whose terms are unknown', () => {
      // Without terms there is no discount, delivery or minimum, and a total
      // built from a guess is worse than an admitted gap.
      const result = run([line('a', 1, [offer('ghost', 1), offer('s1', 9)])], [supplier('s1')]);

      expect(result.best?.suppliers[0].shopId).toBe('s1');
      expect(result.best?.total).toBe(9);
    });
  });

  // ===========================================================================
  describe('maxSuppliers', () => {
    const threeWay: OptimiserLine[] = [
      line('a', 10, [offer('s1', 1), offer('s2', 9), offer('s3', 9)]),
      line('b', 10, [offer('s1', 9), offer('s2', 1), offer('s3', 9)]),
      line('c', 10, [offer('s1', 9), offer('s2', 9), offer('s3', 1)]),
    ];
    const three = [supplier('s1'), supplier('s2'), supplier('s3')];

    it('uses all three when unconstrained', () => {
      expect(run(threeWay, three).best?.suppliersUsed).toBe(3);
    });

    it('respects a cap of two', () => {
      const result = run(threeWay, three, { maxSuppliers: 2 });

      expect(result.best?.suppliersUsed).toBe(2);
      expect(result.best?.total).toBe(110); // 10 + 10 + 90
    });

    it('respects a cap of one', () => {
      const result = run(threeWay, three, { maxSuppliers: 1 });

      expect(result.best?.suppliersUsed).toBe(1);
      expect(result.best?.total).toBe(190);
    });

    it('ignores a cap larger than the supplier count', () => {
      const result = run(threeWay, three, { maxSuppliers: 99 });

      expect(result.best?.suppliersUsed).toBe(3);
      expect(result.best?.total).toBe(30);
    });
  });

  // ===========================================================================
  describe('the worked example', () => {
    /*
     * Five lines, three suppliers. This is the case that justifies the whole
     * module: greedy produces an answer that is both cheaper-looking and
     * impossible to place, and the real optimum uses a *different set of
     * suppliers* than greedy picked.
     *
     *            A (ship 12, free>300, min 100)   B (ship 8, free>500, min 200)   C (no ship, no min)
     *  L1 ×100        1.02 → 102.00                    1.125 → 112.50                 1.08 → 108.00
     *  L2 × 20       11.90 → 238.00                    9.75  → 195.00                     —
     *  L3 × 50        1.36 →  68.00                    1.425 →  71.25                 1.30 →  65.00
     *  L4 × 30        1.87 →  56.10                    1.95  →  58.50                     —
     *  L5 × 40        0.765→  30.60                        —                          0.72 →  28.80
     */
    const lines: OptimiserLine[] = [
      line('L1', 100, [offer('a', 1.02), offer('b', 1.125), offer('c', 1.08)]),
      line('L2', 20, [offer('a', 11.9), offer('b', 9.75)]),
      line('L3', 50, [offer('a', 1.36), offer('b', 1.425), offer('c', 1.3)]),
      line('L4', 30, [offer('a', 1.87), offer('b', 1.95)]),
      line('L5', 40, [offer('a', 0.765), offer('c', 0.72)]),
    ];

    const suppliers = [
      supplier('a', {
        name: 'Елмарк',
        shippingCost: 12,
        freeShippingOver: 300,
        minOrderValue: 100,
      }),
      supplier('b', {
        name: 'ТМТ ЕЛКОМ',
        shippingCost: 8,
        freeShippingOver: 500,
        minOrderValue: 200,
      }),
      supplier('c', { name: 'Склад Изток' }),
    ];

    it('picks B + C for 463.30', () => {
      const result = run(lines, suppliers);

      expect(result.best?.total).toBe(463.3);
      expect(result.best?.suppliers.map((s) => s.shopId)).toEqual(['b', 'c']);
    });

    it('sets the baseline at A alone for 494.70', () => {
      const result = run(lines, suppliers);

      // Only A carries all five lines, and 494.70 clears their free-shipping
      // threshold, so delivery is waived.
      expect(result.baseline?.suppliersUsed).toBe(1);
      expect(result.baseline?.suppliers[0].shopId).toBe('a');
      expect(result.baseline?.total).toBe(494.7);
    });

    it('reports a saving of 31.40, not the 47.80 greedy would claim', () => {
      const result = run(lines, suppliers);

      // Greedy goods: 102 + 195 + 65 + 56.10 + 28.80 = 446.90, and 494.70 −
      // 446.90 = 47.80. That plan leaves B at 195, five euros under their
      // minimum, so it would have been refused outright.
      expect(result.savings).toBe(31.4);
      expect(result.savingsPercent).toBe(6.3);
    });

    it('splits the lines the way the arithmetic says', () => {
      const result = run(lines, suppliers);

      const b = result.best!.suppliers.find((s) => s.shopId === 'b')!;
      const c = result.best!.suppliers.find((s) => s.shopId === 'c')!;

      expect(b.lines.map((l) => l.query).sort()).toEqual(['L2', 'L4']);
      expect(b.productSubtotal).toBe(253.5);
      expect(b.shipping).toBe(8);
      expect(b.meetsMinimumOrder).toBe(true);

      expect(c.lines.map((l) => l.query).sort()).toEqual(['L1', 'L3', 'L5']);
      expect(c.productSubtotal).toBe(201.8);
      expect(c.shipping).toBe(0);
    });

    it('explains why A is left out despite winning two lines on price', () => {
      const result = run(lines, suppliers);

      expect(result.explanation.whyChosen[0]).toContain('ТМТ ЕЛКОМ');
      expect(result.explanation.whyChosen[0]).toContain('31.4');
      // Each supplier's share is stated in money, not adjectives.
      expect(result.explanation.whyChosen.join(' ')).toContain('минимумът им от 200');
    });

    it('offers the single-supplier order as an alternative', () => {
      const result = run(lines, suppliers);

      const single = result.alternatives.find((plan) => plan.suppliersUsed === 1);
      expect(single?.total).toBe(494.7);
      expect(single?.kind).toBe('single_supplier');
    });

    it('honours a two-supplier cap by picking the same plan', () => {
      const result = run(lines, suppliers, { maxSuppliers: 2 });
      expect(result.best?.total).toBe(463.3);
    });

    it('falls back to A alone under a one-supplier cap', () => {
      const result = run(lines, suppliers, { maxSuppliers: 1 });
      expect(result.best?.total).toBe(494.7);
      expect(result.savings).toBe(0);
    });

    it('re-plans without a supplier the buyer rules out', () => {
      const result = run(lines, suppliers, { excludeShopIds: ['c'] });

      // Without C the answer must change, and B alone cannot carry L5.
      expect(result.best?.suppliers.map((s) => s.shopId)).not.toContain('c');
      expect(result.best!.total).toBeGreaterThan(463.3);
    });
  });

  // ===========================================================================
  describe('determinism', () => {
    const lines: OptimiserLine[] = [
      line('a', 3, [offer('s1', 5), offer('s2', 5), offer('s3', 5)]),
      line('b', 3, [offer('s1', 5), offer('s2', 5), offer('s3', 5)]),
    ];
    const suppliers = [supplier('s1'), supplier('s2'), supplier('s3')];

    it('returns an identical plan for an identical input', () => {
      const first = run(lines, suppliers);
      const second = run(lines, suppliers);

      expect(second.best?.total).toBe(first.best?.total);
      expect(second.best?.suppliers.map((s) => s.shopId)).toEqual(
        first.best?.suppliers.map((s) => s.shopId),
      );
    });

    it('breaks an exact price tie the same way every time', () => {
      // Three suppliers, identical prices. Something has to decide, and it
      // must decide the same way — otherwise one order produces two plans.
      const plans = Array.from({ length: 20 }, () => run(lines, suppliers));
      const ids = plans.map((plan) => plan.best!.suppliers.map((s) => s.shopId).join(','));

      expect(new Set(ids).size).toBe(1);
    });

    it('does not depend on the order the offers arrive in', () => {
      const forward = run(
        [line('a', 1, [offer('s1', 3), offer('s2', 2)])],
        [supplier('s1'), supplier('s2')],
      );
      const reversed = run(
        [line('a', 1, [offer('s2', 2), offer('s1', 3)])],
        [supplier('s1'), supplier('s2')],
      );

      expect(reversed.best?.suppliers[0].shopId).toBe(forward.best?.suppliers[0].shopId);
      expect(reversed.best?.total).toBe(forward.best?.total);
    });
  });

  // ===========================================================================
  describe('edge cases', () => {
    it('handles an empty order', () => {
      const result = run([], [supplier('s1')]);

      expect(result.best).toBeNull();
      expect(result.savings).toBeNull();
      expect(result.diagnostics.lineCount).toBe(0);
    });

    it('rejects a line for zero', () => {
      const result = run([line('a', 0, [offer('s1', 5)])], [supplier('s1')]);

      expect(result.best).toBeNull();
      expect(result.unassigned).toHaveLength(1);
    });

    it('rejects a negative quantity', () => {
      const result = run([line('a', -5, [offer('s1', 5)])], [supplier('s1')]);

      expect(result.best).toBeNull();
      expect(result.unassigned).toHaveLength(1);
    });

    it('rejects a negative price rather than treating it as a discount', () => {
      const result = run(
        [line('a', 1, [offer('s1', -10), offer('s2', 5)])],
        [supplier('s1'), supplier('s2')],
      );

      expect(result.best?.suppliers[0].shopId).toBe('s2');
    });

    it('accepts a zero price', () => {
      const result = run([line('a', 1, [offer('s1', 0)])], [supplier('s1')]);

      expect(result.best?.total).toBe(0);
    });

    it('keeps two identical queries as two separate lines', () => {
      // A buyer who lists the same article twice means two deliveries of it,
      // not one. Silently merging would under-order.
      const result = run(
        [line('a', 5, [offer('s1', 2)]), line('a', 5, [offer('s1', 2)])],
        [supplier('s1')],
      );

      expect(result.best?.total).toBe(20);
      expect(result.best?.suppliers[0].lines).toHaveLength(2);
    });

    it('takes the cheapest when one supplier offers the same line twice', () => {
      const result = run([line('a', 1, [offer('s1', 9), offer('s1', 4)])], [supplier('s1')]);

      expect(result.best?.total).toBe(4);
    });

    it('reports nothing when every supplier is excluded', () => {
      const result = run(
        [line('a', 1, [offer('s1', 5), offer('s2', 5)])],
        [supplier('s1'), supplier('s2')],
        { excludeShopIds: ['s1', 's2'] },
      );

      expect(result.best).toBeNull();
      expect(result.unassigned).toHaveLength(1);
    });

    it('reports nothing when no supplier is viable', () => {
      const result = run(
        [line('a', 1, [offer('s1', 50), offer('s2', 50)])],
        [supplier('s1', { minOrderValue: 500 }), supplier('s2', { minOrderValue: 500 })],
      );

      expect(result.best).toBeNull();
      expect(result.rejectedSuppliers).toHaveLength(2);
      expect(result.explanation.tradeOffs.join(' ')).toContain('Нито една комбинация');
    });
  });

  // ===========================================================================
  describe('transparency about uncertain data', () => {
    it('carries the price source and age of every allocated line', () => {
      const result = run(
        [
          line('a', 1, [
            offer('s1', 5, {
              priceSource: 'manual',
              recordedAt: '2026-07-01T00:00:00.000Z',
              vatCertainty: VatCertainty.Assumed,
            }),
          ]),
        ],
        [supplier('s1')],
      );

      const allocated = result.best!.suppliers[0].lines[0];
      expect(allocated.priceSource).toBe('manual');
      expect(allocated.recordedAt).toBe('2026-07-01T00:00:00.000Z');
      expect(allocated.vatCertainty).toBe(VatCertainty.Assumed);
      expect(allocated.confidence).toBe(0.95);
    });

    it('never silently prefers a stale price over saying it is stale', () => {
      // The optimiser ranks on price alone — a cheaper stale figure still wins,
      // because dropping it would misreport coverage. What it must not do is
      // hide that the winner is stale.
      const result = run(
        [
          line('a', 1, [
            offer('s1', 4, { priceSource: 'manual', recordedAt: '2026-01-01T00:00:00.000Z' }),
            offer('s2', 5),
          ]),
        ],
        [supplier('s1'), supplier('s2')],
      );

      expect(result.best?.suppliers[0].shopId).toBe('s1');
      expect(result.best?.suppliers[0].lines[0].recordedAt).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  // ===========================================================================
  describe('performance and bounds', () => {
    it('solves a realistic basket quickly', () => {
      // 40 lines, 8 suppliers — the shape the product is built for.
      const suppliers = Array.from({ length: 8 }, (_, i) => supplier(`s${i}`));
      const lines = Array.from({ length: 40 }, (_, l) =>
        line(
          `line-${l}`,
          (l % 7) + 1,
          suppliers.map((s, i) => offer(s.shopId!, 5 + ((l * 3 + i * 7) % 11))),
        ),
      );

      const started = Date.now();
      const result = run(lines, suppliers);
      const elapsed = Date.now() - started;

      expect(result.best).not.toBeNull();
      // 2^8 − 1 = 255 combinations.
      expect(result.diagnostics.combinationsEvaluated).toBe(255);
      expect(elapsed).toBeLessThan(2000);
      expect(result.diagnostics.boundedSearch).toBe(false);
    });

    it('bounds the search rather than hanging on many suppliers', () => {
      const suppliers = Array.from({ length: 24 }, (_, i) =>
        supplier(`s${String(i).padStart(2, '0')}`),
      );
      const lines = Array.from({ length: 10 }, (_, l) =>
        line(
          `line-${l}`,
          1,
          suppliers.map((s, i) => offer(s.shopId!, 5 + ((l + i) % 9))),
        ),
      );

      const started = Date.now();
      const result = run(lines, suppliers);
      const elapsed = Date.now() - started;

      expect(result.best).not.toBeNull();
      // Reported, not hidden: this answer is the best of what was tried.
      expect(result.diagnostics.boundedSearch).toBe(true);
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
