import { convert, isConvertible } from '../products/currency';

/**
 * The one authoritative answer to "what does this customer actually pay for
 * this article from this supplier?"
 *
 * Before this file the answer lived in `ranking.ts` as `price × (1 − discount)`
 * and nowhere else, which is wrong in three ways that all point the same
 * direction — they make a supplier look cheaper than they are:
 *
 *  - **VAT.** Wholesale sites quote net at one shop and gross at the next.
 *    Comparing the two is a 20% error, larger than almost any negotiated
 *    discount — the exact mistake this product exists to prevent.
 *  - **Delivery.** Splitting an order across four suppliers saves on goods and
 *    adds four deliveries.
 *  - **Minimum order.** A supplier who will not accept the order is not the
 *    cheapest one; they are not an option at all.
 *
 * Everything here is pure: no repository, no HTTP, no clock. That is
 * deliberate. This is the code that produces the number a customer checks
 * against their own invoice, so it has to be exhaustively testable, and a
 * disagreement about a price has to be reproducible from its inputs alone.
 */

// --- VAT ---------------------------------------------------------------------

/**
 * What a supplier's quoted price includes.
 *
 * Three states, not two, and the third is the important one. A price scraped
 * from a page carries no statement about VAT, and assuming one is how a
 * comparison becomes confidently wrong. `Unknown` is the honest default for
 * every supplier nobody has told us about, and it is what existing rows get.
 */
export enum VatState {
  /** Quoted with VAT already in the number. */
  Inclusive = 'inclusive',
  /** Quoted net; VAT is added on the invoice. */
  Exclusive = 'exclusive',
  /** Nobody has said. Never guessed at. */
  Unknown = 'unknown',
}

/**
 * How much a figure can be trusted against figures from other suppliers.
 *
 * Carried on every cost so the interface can say which numbers are directly
 * comparable and which are being shown with a caveat, rather than presenting
 * both with the same authority.
 */
export enum VatCertainty {
  /** The supplier's VAT treatment is known; the net figure is derived, not assumed. */
  Known = 'known',
  /**
   * The VAT treatment is unknown and the quoted figure is being used as-is.
   *
   * Safe to compare against other `Assumed` figures — they share whatever
   * basis they share. Not safe to compare against a `Known` one without
   * saying so, which is what {@link assessComparability} is for.
   */
  Assumed = 'assumed',
  /**
   * Unknown, and sitting in a comparison that also contains known figures.
   *
   * This is the case that must never be presented as a straight price
   * comparison: one side may be gross and the other net, and nothing in the
   * data says which.
   */
  Uncertain = 'uncertain',
}

// --- Inputs ------------------------------------------------------------------

/**
 * A supplier's commercial terms, as this customer negotiated them.
 *
 * An interface rather than the `Shop` entity: this module must stay pure, and
 * a future rule — a discount per product group, a delivery cost by zone or
 * weight — becomes another field here without any call site changing shape.
 */
export interface SupplierTerms {
  shopId: string | null;
  name: string;
  /** The currency this supplier quotes in. */
  currency: string;
  /** Negotiated discount off the listed price, in percent. */
  discountPercent: number;
  vatState: VatState;
  /** Percent. Only consulted when `vatState` is `Inclusive`. */
  vatRate: number;
  /** Flat delivery charge per order. */
  shippingCost: number;
  /** Goods total at or above which delivery is free. Null means never. */
  freeShippingOver: number | null;
  /** Per-order charge that is not delivery — packing, documents, a card fee. */
  handlingFee: number;
  /** Below this goods total the supplier will not accept an order. */
  minOrderValue: number;
}

/** Neutral terms, for a supplier nobody has configured. Changes no number. */
export const NEUTRAL_TERMS: Omit<SupplierTerms, 'shopId' | 'name' | 'currency'> = {
  discountPercent: 0,
  vatState: VatState.Unknown,
  vatRate: 20,
  shippingCost: 0,
  freeShippingOver: null,
  handlingFee: 0,
  minOrderValue: 0,
};

export interface LinePriceInput {
  /** As the supplier lists it, before anything is applied. Null when unreadable. */
  listPrice: number | null;
  /** The currency of `listPrice`. Falls back to the supplier's own. */
  currency?: string | null;
  /** How many are being bought. */
  quantity: number;
}

// --- Warnings ----------------------------------------------------------------

export type CostWarningKind =
  | 'vat_unknown'
  | 'vat_not_comparable'
  | 'currency_not_convertible'
  | 'price_unreadable'
  | 'below_minimum_order';

export interface CostWarning {
  kind: CostWarningKind;
  /** Written for the buyer, not for the log. */
  message: string;
}

// --- Outputs -----------------------------------------------------------------

export interface LineCost {
  /** As quoted, untouched. */
  listPrice: number | null;
  listCurrency: string;
  discountPercent: number;
  /** After the discount, still in the supplier's currency and VAT basis. */
  discountedUnitPrice: number | null;
  vatState: VatState;
  vatRate: number;
  vatCertainty: VatCertainty;
  /** Net of VAT, in the supplier's currency. */
  netUnitPrice: number | null;
  /** Net of VAT, converted to the target currency. Null when no rate exists. */
  effectiveUnitPrice: number | null;
  effectiveCurrency: string;
  quantity: number;
  /** `effectiveUnitPrice × quantity`. The figure an order total is built from. */
  netLineTotal: number | null;
  warnings: CostWarning[];
}

export interface SupplierOrderCost {
  shopId: string | null;
  name: string;
  currency: string;
  /** Sum of the priced lines, net of VAT. */
  goodsTotal: number;
  /** Lines this supplier could price. */
  linesPriced: number;
  linesTotal: number;
  shippingCost: number;
  /** True when the goods total cleared `freeShippingOver`. */
  shippingWaived: boolean;
  handlingFee: number;
  /** goods + shipping + handling. What leaving the order here really costs. */
  effectiveTotal: number;
  minOrderValue: number;
  meetsMinimumOrder: boolean;
  /** How far short of the minimum, or 0. */
  minimumShortfall: number;
  warnings: CostWarning[];
}

// --- The calculation ---------------------------------------------------------

/** Money, to the cent. Applied at every boundary so nothing leaks binary dust. */
export function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Strips VAT from a quoted figure, when the supplier's treatment is known.
 *
 * Everything in this module compares **net of VAT**, and that choice is the
 * defensible one for the customer this serves: a VAT-registered buyer reclaims
 * the tax, so their real cost is the net figure. Comparing gross figures would
 * compare cash flow, not cost — and would make a supplier who happens to quote
 * gross look 20% more expensive than one who does not.
 */
function netOf(amount: number, state: VatState, rate: number): number {
  if (state !== VatState.Inclusive) return amount;
  if (!Number.isFinite(rate) || rate <= 0) return amount;

  return round(amount / (1 + rate / 100));
}

/**
 * What this customer pays for one line at one supplier.
 *
 * The order of operations matters and is fixed here rather than left to each
 * call site:
 *
 *   1. discount off the listed price — the customer's negotiated rate
 *   2. VAT stripped, when the supplier's treatment is known
 *   3. converted to the target currency, or refused if no rate exists
 *   4. multiplied by the quantity
 *
 * Step 3 refuses rather than guesses. A comparison between a dollar price and
 * a euro price is either done at a rate somebody chose and can defend, or not
 * done at all — inventing one produces a ranking that looks authoritative and
 * is wrong by however far the guess was off.
 */
export function effectiveLineCost(
  input: LinePriceInput,
  terms: SupplierTerms,
  targetCurrency: string,
): LineCost {
  const listCurrency = (input.currency ?? terms.currency ?? 'EUR').toUpperCase();
  const target = (targetCurrency || 'EUR').toUpperCase();
  const warnings: CostWarning[] = [];

  const vatCertainty =
    terms.vatState === VatState.Unknown ? VatCertainty.Assumed : VatCertainty.Known;

  if (terms.vatState === VatState.Unknown) {
    warnings.push({
      kind: 'vat_unknown',
      message: `Не е указано дали цените на ${terms.name} са с или без ДДС. Сравнението приема, че са на същата основа като останалите непосочени.`,
    });
  }

  const base: LineCost = {
    listPrice: input.listPrice,
    listCurrency,
    discountPercent: terms.discountPercent,
    discountedUnitPrice: null,
    vatState: terms.vatState,
    vatRate: terms.vatRate,
    vatCertainty,
    netUnitPrice: null,
    effectiveUnitPrice: null,
    effectiveCurrency: listCurrency,
    quantity: input.quantity,
    netLineTotal: null,
    warnings,
  };

  if (input.listPrice === null || !Number.isFinite(input.listPrice)) {
    warnings.push({
      kind: 'price_unreadable',
      message: `Цената при ${terms.name} не можа да бъде прочетена.`,
    });
    return base;
  }

  const discounted = round(input.listPrice * (1 - terms.discountPercent / 100));
  const net = netOf(discounted, terms.vatState, terms.vatRate);

  if (!isConvertible(listCurrency, target)) {
    warnings.push({
      kind: 'currency_not_convertible',
      message: `Не мога да сравня ${listCurrency} с ${target} без валутен курс. Задайте курс или сравнявайте в ${listCurrency}.`,
    });

    return {
      ...base,
      discountedUnitPrice: discounted,
      netUnitPrice: net,
      // Left in its own currency rather than converted at a guess, and with no
      // line total at all — a total is a number that gets added up, and adding
      // a lev to a euro is the failure this refuses to commit.
      effectiveUnitPrice: null,
      effectiveCurrency: listCurrency,
    };
  }

  const effectiveUnit = round(convert(net, listCurrency, target));

  return {
    ...base,
    discountedUnitPrice: discounted,
    netUnitPrice: net,
    effectiveUnitPrice: effectiveUnit,
    effectiveCurrency: target,
    netLineTotal: round(effectiveUnit * input.quantity),
  };
}

/**
 * Marks which figures in one comparison can honestly be set against each other.
 *
 * Called with every cost being shown side by side. A set that is entirely
 * `Assumed` is internally consistent — whatever basis those suppliers quote on,
 * they are being treated alike — and stays `Assumed`. The moment a known
 * figure joins them, the unknown ones become `Uncertain`: one may be gross and
 * the other net, nothing in the data says which, and presenting the pair as a
 * price comparison would be inventing the missing fact.
 *
 * Mutates nothing; returns new costs.
 */
export function assessComparability(costs: LineCost[]): LineCost[] {
  const hasKnown = costs.some((cost) => cost.vatCertainty === VatCertainty.Known);
  const hasAssumed = costs.some((cost) => cost.vatCertainty === VatCertainty.Assumed);

  if (!hasKnown || !hasAssumed) return costs;

  return costs.map((cost) => {
    if (cost.vatCertainty !== VatCertainty.Assumed) return cost;

    return {
      ...cost,
      vatCertainty: VatCertainty.Uncertain,
      warnings: [
        ...cost.warnings.filter((warning) => warning.kind !== 'vat_unknown'),
        {
          kind: 'vat_not_comparable' as const,
          message:
            'Тази оферта не може да се сравни пряко: не знаем дали цената е с ДДС, а другите оферти знаем. Посочете ДДС статуса на доставчика.',
        },
      ],
    };
  });
}

/**
 * What leaving this whole order with this supplier really costs.
 *
 * Delivery and handling are charged once per order, not per line, which is why
 * they cannot live in {@link effectiveLineCost} — and why an order split
 * across four suppliers is not simply the sum of four cheapest lines.
 *
 * A supplier below their minimum order is reported, not hidden: "cheapest, but
 * they will not accept it" is a real answer, and silently dropping them would
 * leave the buyer wondering where a supplier went.
 */
export function supplierOrderCost(
  lines: LineCost[],
  terms: SupplierTerms,
  targetCurrency: string,
): SupplierOrderCost {
  const target = (targetCurrency || 'EUR').toUpperCase();

  const priced = lines.filter(
    (line): line is LineCost & { netLineTotal: number } => line.netLineTotal !== null,
  );

  const goodsTotal = round(priced.reduce((sum, line) => sum + line.netLineTotal, 0));

  // The threshold is read against the goods total, before delivery is added —
  // otherwise the delivery charge could push an order over the line that
  // waives the delivery charge.
  const shippingWaived = terms.freeShippingOver !== null && goodsTotal >= terms.freeShippingOver;
  const shippingCost = shippingWaived ? 0 : round(terms.shippingCost);
  const handlingFee = round(terms.handlingFee);

  const meetsMinimumOrder = goodsTotal >= terms.minOrderValue;
  const minimumShortfall = meetsMinimumOrder ? 0 : round(terms.minOrderValue - goodsTotal);

  const warnings: CostWarning[] = [];

  if (!meetsMinimumOrder && priced.length > 0) {
    warnings.push({
      kind: 'below_minimum_order',
      message: `${terms.name} не приема поръчки под ${terms.minOrderValue} ${target}. Не достигат ${minimumShortfall} ${target}.`,
    });
  }

  return {
    shopId: terms.shopId,
    name: terms.name,
    currency: target,
    goodsTotal,
    linesPriced: priced.length,
    linesTotal: lines.length,
    shippingCost,
    shippingWaived,
    handlingFee,
    effectiveTotal: round(goodsTotal + shippingCost + handlingFee),
    minOrderValue: terms.minOrderValue,
    meetsMinimumOrder,
    minimumShortfall,
    warnings,
  };
}

/**
 * True when this supplier is a real option for this order.
 *
 * Used wherever a "cheapest" is chosen. A supplier below their minimum is not
 * cheap; they are unavailable, and ranking them first recommends an order that
 * will be refused.
 */
export function isViableOrder(cost: SupplierOrderCost): boolean {
  return cost.linesPriced > 0 && cost.meetsMinimumOrder;
}
