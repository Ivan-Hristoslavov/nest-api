import { setRatesPerEur } from '../products/currency';
import {
  LineCost,
  NEUTRAL_TERMS,
  SupplierTerms,
  VatCertainty,
  VatState,
  assessComparability,
  effectiveLineCost,
  isViableOrder,
  supplierOrderCost,
} from './effective-cost';

/**
 * The arithmetic a customer checks against their own invoice.
 *
 * This is the only place in the system that decides what somebody pays, so it
 * is tested against worked examples with the numbers written out. Every case
 * below is one a supplier can actually present, and several are ones the old
 * `price × (1 − discount)` model got wrong in a way that always pointed the
 * same direction: it made suppliers look cheaper than they are.
 */

function supplier(overrides: Partial<SupplierTerms> = {}): SupplierTerms {
  return {
    ...NEUTRAL_TERMS,
    shopId: 'shop-1',
    name: 'Доставчик',
    currency: 'EUR',
    ...overrides,
  };
}

describe('effective purchase cost', () => {
  describe('Example 1 — list price, discount, VAT excluded', () => {
    // Supplier A: list €100, discount 20%, VAT excluded, shipping €10, min €50.
    const terms = supplier({
      name: 'Доставчик A',
      discountPercent: 20,
      vatState: VatState.Exclusive,
      shippingCost: 10,
      minOrderValue: 50,
    });

    it('takes the discount off the list price', () => {
      const cost = effectiveLineCost({ listPrice: 100, quantity: 1 }, terms, 'EUR');

      // 100 − 20% = 80. Not 90: a 20% discount removes a fifth, not a tenth.
      expect(cost.discountedUnitPrice).toBe(80);
      expect(cost.effectiveUnitPrice).toBe(80);
    });

    it('leaves a VAT-excluded price alone, because it is already net', () => {
      const cost = effectiveLineCost({ listPrice: 100, quantity: 1 }, terms, 'EUR');

      expect(cost.netUnitPrice).toBe(80);
      expect(cost.vatCertainty).toBe(VatCertainty.Known);
      expect(cost.warnings).toHaveLength(0);
    });

    it('separates the goods total from what the order costs', () => {
      const cost = effectiveLineCost({ listPrice: 100, quantity: 1 }, terms, 'EUR');
      const order = supplierOrderCost([cost], terms, 'EUR');

      expect(order.goodsTotal).toBe(80);
      expect(order.shippingCost).toBe(10);
      // The number that matters: goods alone would name the wrong supplier.
      expect(order.effectiveTotal).toBe(90);
    });

    it('accepts the order, because 80 clears the 50 minimum', () => {
      const cost = effectiveLineCost({ listPrice: 100, quantity: 1 }, terms, 'EUR');
      const order = supplierOrderCost([cost], terms, 'EUR');

      expect(order.meetsMinimumOrder).toBe(true);
      expect(order.minimumShortfall).toBe(0);
      expect(isViableOrder(order)).toBe(true);
    });

    it('multiplies by the quantity', () => {
      const cost = effectiveLineCost({ listPrice: 100, quantity: 3 }, terms, 'EUR');

      expect(cost.netLineTotal).toBe(240);
    });
  });

  describe('Example 2 — delivery decides which supplier is cheaper', () => {
    // A: list 100, 20% off, delivery 10  →  goods 80, order 90
    // B: list  90,  0% off, delivery 20  →  goods 90, order 110
    const a = supplier({ name: 'A', discountPercent: 20, shippingCost: 10 });
    const b = supplier({ shopId: 'shop-2', name: 'B', discountPercent: 0, shippingCost: 20 });

    it('compares what the order costs, not what the goods cost', () => {
      const orderA = supplierOrderCost(
        [effectiveLineCost({ listPrice: 100, quantity: 1 }, a, 'EUR')],
        a,
        'EUR',
      );
      const orderB = supplierOrderCost(
        [effectiveLineCost({ listPrice: 90, quantity: 1 }, b, 'EUR')],
        b,
        'EUR',
      );

      expect(orderA.goodsTotal).toBe(80);
      expect(orderB.goodsTotal).toBe(90);

      expect(orderA.effectiveTotal).toBe(90);
      expect(orderB.effectiveTotal).toBe(110);
    });

    it('lets delivery reverse the answer that goods alone would give', () => {
      // Goods say B is cheaper; delivery says A is. Ranking on goods alone
      // recommends the more expensive order — the failure this model exists
      // to remove.
      const cheap = supplier({ name: 'Cheap goods', discountPercent: 0, shippingCost: 40 });
      const dear = supplier({
        shopId: 'shop-3',
        name: 'Dear goods',
        discountPercent: 0,
        shippingCost: 0,
      });

      const cheapOrder = supplierOrderCost(
        [effectiveLineCost({ listPrice: 100, quantity: 1 }, cheap, 'EUR')],
        cheap,
        'EUR',
      );
      const dearOrder = supplierOrderCost(
        [effectiveLineCost({ listPrice: 120, quantity: 1 }, dear, 'EUR')],
        dear,
        'EUR',
      );

      expect(cheapOrder.goodsTotal).toBeLessThan(dearOrder.goodsTotal);
      expect(cheapOrder.effectiveTotal).toBeGreaterThan(dearOrder.effectiveTotal);
    });

    it('waives delivery once the free-shipping threshold is met', () => {
      const terms = supplier({ shippingCost: 12, freeShippingOver: 300 });

      const under = supplierOrderCost(
        [effectiveLineCost({ listPrice: 299, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );
      const over = supplierOrderCost(
        [effectiveLineCost({ listPrice: 300, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );

      expect(under.shippingWaived).toBe(false);
      expect(under.effectiveTotal).toBe(311);

      expect(over.shippingWaived).toBe(true);
      expect(over.effectiveTotal).toBe(300);
    });

    it('reads the threshold against goods, so delivery cannot waive itself', () => {
      // Goods 295 + delivery 12 = 307, which is over 300. If the threshold were
      // read against the total, the delivery charge would pay for its own
      // removal and the figure would be self-contradictory.
      const terms = supplier({ shippingCost: 12, freeShippingOver: 300 });
      const order = supplierOrderCost(
        [effectiveLineCost({ listPrice: 295, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );

      expect(order.shippingWaived).toBe(false);
      expect(order.effectiveTotal).toBe(307);
    });

    it('adds a handling fee on top of delivery', () => {
      const terms = supplier({ shippingCost: 10, handlingFee: 2.5 });
      const order = supplierOrderCost(
        [effectiveLineCost({ listPrice: 100, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );

      expect(order.effectiveTotal).toBe(112.5);
    });
  });

  describe('Example 3 — an order below the supplier minimum', () => {
    const terms = supplier({ name: 'ТМТ ЕЛКОМ', minOrderValue: 200 });

    it('is not a viable option, however cheap it looks', () => {
      const order = supplierOrderCost(
        [effectiveLineCost({ listPrice: 120, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );

      expect(order.goodsTotal).toBe(120);
      expect(order.meetsMinimumOrder).toBe(false);
      // The whole point: cheapest and unavailable are different answers.
      expect(isViableOrder(order)).toBe(false);
    });

    it('says how far short it falls, so the buyer can top it up', () => {
      const order = supplierOrderCost(
        [effectiveLineCost({ listPrice: 157.5, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );

      expect(order.minimumShortfall).toBe(42.5);
      expect(order.warnings.map((warning) => warning.kind)).toContain('below_minimum_order');
      expect(order.warnings[0].message).toContain('42.5');
    });

    it('clears the minimum at exactly the minimum', () => {
      const order = supplierOrderCost(
        [effectiveLineCost({ listPrice: 200, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );

      expect(order.meetsMinimumOrder).toBe(true);
      expect(isViableOrder(order)).toBe(true);
    });

    it('is still reported rather than hidden', () => {
      // "Cheapest, but they will not accept it" is a real answer. Dropping the
      // supplier silently leaves the buyer wondering where they went.
      const order = supplierOrderCost(
        [effectiveLineCost({ listPrice: 120, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );

      expect(order.name).toBe('ТМТ ЕЛКОМ');
      expect(order.minOrderValue).toBe(200);
      expect(order.linesPriced).toBe(1);
    });

    it('does not warn about a minimum when the supplier priced nothing', () => {
      // Zero goods from a supplier who has none of the articles is not a
      // shortfall; it is an absence, and warning about it is noise.
      const order = supplierOrderCost(
        [effectiveLineCost({ listPrice: null, quantity: 1 }, terms, 'EUR')],
        terms,
        'EUR',
      );

      expect(order.warnings.map((warning) => warning.kind)).not.toContain('below_minimum_order');
      expect(isViableOrder(order)).toBe(false);
    });
  });

  describe('Example 4 — VAT included, excluded, and unknown', () => {
    it('strips VAT from a gross price so both sides are net', () => {
      const gross = supplier({ vatState: VatState.Inclusive, vatRate: 20 });
      const cost = effectiveLineCost({ listPrice: 120, quantity: 1 }, gross, 'EUR');

      // 120 gross at 20% is 100 net.
      expect(cost.netUnitPrice).toBe(100);
      expect(cost.effectiveUnitPrice).toBe(100);
    });

    it('puts a gross and a net supplier on the same footing', () => {
      const gross = supplier({ name: 'Gross', vatState: VatState.Inclusive, vatRate: 20 });
      const net = supplier({ shopId: 'shop-2', name: 'Net', vatState: VatState.Exclusive });

      const grossCost = effectiveLineCost({ listPrice: 120, quantity: 1 }, gross, 'EUR');
      const netCost = effectiveLineCost({ listPrice: 100, quantity: 1 }, net, 'EUR');

      // The same article at the same real price. Comparing the quoted numbers
      // would have made the gross supplier look 20% dearer.
      expect(grossCost.effectiveUnitPrice).toBe(netCost.effectiveUnitPrice);
    });

    it('never invents a VAT basis it was not told', () => {
      const unknown = supplier({ vatState: VatState.Unknown });
      const cost = effectiveLineCost({ listPrice: 120, quantity: 1 }, unknown, 'EUR');

      // The quoted number is used as-is. Dividing by a rate nobody stated
      // would be a 20% error dressed as a calculation.
      expect(cost.netUnitPrice).toBe(120);
      expect(cost.vatCertainty).toBe(VatCertainty.Assumed);
      expect(cost.warnings.map((warning) => warning.kind)).toContain('vat_unknown');
    });

    it('leaves an all-unknown comparison alone — they share a basis', () => {
      const costs = assessComparability([
        effectiveLineCost({ listPrice: 100, quantity: 1 }, supplier({ name: 'A' }), 'EUR'),
        effectiveLineCost(
          { listPrice: 110, quantity: 1 },
          supplier({ shopId: 'shop-2', name: 'B' }),
          'EUR',
        ),
      ]);

      expect(costs.every((cost) => cost.vatCertainty === VatCertainty.Assumed)).toBe(true);
    });

    it('marks an unknown price uncertain the moment a known one joins it', () => {
      const costs = assessComparability([
        effectiveLineCost(
          { listPrice: 100, quantity: 1 },
          supplier({ name: 'Known', vatState: VatState.Exclusive }),
          'EUR',
        ),
        effectiveLineCost(
          { listPrice: 110, quantity: 1 },
          supplier({ shopId: 'shop-2', name: 'Unknown' }),
          'EUR',
        ),
      ]);

      expect(costs[0].vatCertainty).toBe(VatCertainty.Known);
      // One may be gross and the other net, and nothing in the data says which.
      expect(costs[1].vatCertainty).toBe(VatCertainty.Uncertain);
      expect(costs[1].warnings.map((warning) => warning.kind)).toContain('vat_not_comparable');
      expect(costs[1].warnings.map((warning) => warning.kind)).not.toContain('vat_unknown');
    });

    it('still prices an uncertain offer rather than dropping it', () => {
      // The price is real and the supplier does stock the article. Refusing to
      // show it would misreport coverage; showing it without the caveat would
      // be a false comparison. Both facts are carried.
      const costs = assessComparability([
        effectiveLineCost(
          { listPrice: 100, quantity: 1 },
          supplier({ vatState: VatState.Exclusive }),
          'EUR',
        ),
        effectiveLineCost({ listPrice: 110, quantity: 1 }, supplier({ shopId: 'shop-2' }), 'EUR'),
      ]);

      expect(costs[1].effectiveUnitPrice).toBe(110);
    });

    it('ignores a nonsensical VAT rate rather than dividing by it', () => {
      const broken = supplier({ vatState: VatState.Inclusive, vatRate: 0 });
      const cost = effectiveLineCost({ listPrice: 120, quantity: 1 }, broken, 'EUR');

      expect(cost.netUnitPrice).toBe(120);
    });
  });

  describe('Example 5 — currencies', () => {
    beforeEach(() => {
      // No operator-supplied rates: only the pegged BGN/EUR pair converts.
      setRatesPerEur({});
    });

    afterAll(() => {
      setRatesPerEur({});
    });

    it('converts the pegged pair exactly', () => {
      const bgn = supplier({ currency: 'BGN' });
      const cost = effectiveLineCost(
        { listPrice: 195.583, currency: 'BGN', quantity: 1 },
        bgn,
        'EUR',
      );

      // 195.583 BGN is 100 EUR at the legal peg of 1.95583.
      expect(cost.effectiveUnitPrice).toBe(100);
      expect(cost.effectiveCurrency).toBe('EUR');
    });

    it('refuses a pair with no rate instead of guessing one', () => {
      const usd = supplier({ currency: 'USD' });
      const cost = effectiveLineCost({ listPrice: 100, currency: 'USD', quantity: 1 }, usd, 'EUR');

      expect(cost.effectiveUnitPrice).toBeNull();
      expect(cost.netLineTotal).toBeNull();
      // Left in its own currency rather than converted at an invented rate.
      expect(cost.effectiveCurrency).toBe('USD');
      expect(cost.warnings.map((warning) => warning.kind)).toContain('currency_not_convertible');
    });

    it('keeps the unconvertible price out of the order total', () => {
      const usd = supplier({ currency: 'USD' });
      const lines = [
        effectiveLineCost({ listPrice: 100, currency: 'USD', quantity: 1 }, usd, 'EUR'),
        effectiveLineCost({ listPrice: 50, currency: 'EUR', quantity: 1 }, usd, 'EUR'),
      ];
      const order = supplierOrderCost(lines, usd, 'EUR');

      // Adding a dollar to a euro is the failure this refuses to commit.
      expect(order.goodsTotal).toBe(50);
      expect(order.linesPriced).toBe(1);
      expect(order.linesTotal).toBe(2);
    });

    it('converts once an operator supplies a rate', () => {
      setRatesPerEur({ USD: 1.1 });
      const usd = supplier({ currency: 'USD' });
      const cost = effectiveLineCost({ listPrice: 110, currency: 'USD', quantity: 1 }, usd, 'EUR');

      expect(cost.effectiveUnitPrice).toBe(100);
    });
  });

  describe('backward compatibility with shops configured before terms existed', () => {
    it('reproduces the old arithmetic exactly', () => {
      // Neutral terms are what every existing row gets from the migration.
      // The number must not move for anybody on deploy day.
      const legacy = supplier({ discountPercent: 30 });
      const cost = effectiveLineCost({ listPrice: 12, quantity: 1 }, legacy, 'EUR');

      // 12.00 less 30% is 8.399999999999999 in binary floating point.
      expect(cost.effectiveUnitPrice).toBe(8.4);
    });

    it('charges nothing extra when no terms are set', () => {
      const legacy = supplier({ discountPercent: 10 });
      const order = supplierOrderCost(
        [effectiveLineCost({ listPrice: 100, quantity: 1 }, legacy, 'EUR')],
        legacy,
        'EUR',
      );

      expect(order.goodsTotal).toBe(90);
      expect(order.shippingCost).toBe(0);
      expect(order.handlingFee).toBe(0);
      expect(order.effectiveTotal).toBe(90);
      expect(order.meetsMinimumOrder).toBe(true);
    });
  });

  describe('unreadable prices', () => {
    it('reports the gap rather than treating it as free', () => {
      const cost = effectiveLineCost({ listPrice: null, quantity: 1 }, supplier(), 'EUR');

      expect(cost.effectiveUnitPrice).toBeNull();
      expect(cost.netLineTotal).toBeNull();
      expect(cost.warnings.map((warning) => warning.kind)).toContain('price_unreadable');
    });

    it('leaves an empty order at zero without claiming it is cheap', () => {
      const terms = supplier();
      const order = supplierOrderCost([] as LineCost[], terms, 'EUR');

      expect(order.goodsTotal).toBe(0);
      expect(order.linesPriced).toBe(0);
      expect(isViableOrder(order)).toBe(false);
    });
  });
});
