import { Injectable } from '@nestjs/common';

import { Shop } from '../shops/entities/shop.entity';
import {
  LineCost,
  LinePriceInput,
  SupplierOrderCost,
  SupplierTerms,
  VatState,
  assessComparability,
  effectiveLineCost,
  isViableOrder,
  supplierOrderCost,
} from './effective-cost';
import {
  OptimisationResult,
  OptimiserLine,
  OptimiserOptions,
  optimiseOrder,
} from './order-optimizer';

/**
 * The single place that answers "what does this customer pay?".
 *
 * A thin seam over {@link effectiveLineCost} and friends, and deliberately
 * thin: the arithmetic stays pure and testable in `effective-cost.ts`, and
 * this class exists only to turn a `Shop` row into the terms that arithmetic
 * takes, and to be injectable where the ranking and the basket need it.
 *
 * Nothing else in the codebase may compute a customer price. Before this
 * existed the rule lived in `ranking.ts` as `price × (1 − discount)`, and the
 * VAT, delivery and minimum-order facts had nowhere to live at all — which is
 * how a comparison ends up confidently recommending a supplier who will not
 * accept the order.
 */
@Injectable()
export class EffectiveCostService {
  /**
   * Reads a shop row as commercial terms.
   *
   * Every field has a neutral default, so a shop configured before these
   * columns existed produces exactly the number it produced before: discount
   * applied, nothing else. That is what makes this change safe to deploy
   * against live data.
   */
  termsFor(shop: Shop): SupplierTerms {
    return {
      shopId: shop.id,
      name: shop.name,
      currency: (shop.currency ?? 'EUR').toUpperCase(),
      discountPercent: Number(shop.discountPercent ?? 0),
      vatState: shop.vatState ?? VatState.Unknown,
      vatRate: Number(shop.vatRate ?? 20),
      shippingCost: Number(shop.shippingCost ?? 0),
      freeShippingOver:
        shop.freeShippingOver === null || shop.freeShippingOver === undefined
          ? null
          : Number(shop.freeShippingOver),
      handlingFee: Number(shop.handlingFee ?? 0),
      minOrderValue: Number(shop.minOrderValue ?? 0),
    };
  }

  /**
   * Terms for an offer whose shop is not on this customer's list.
   *
   * Happens when a search result's host matches no configured supplier. The
   * offer is still worth showing — the price is real — but nothing is known
   * about the terms, so nothing is assumed about them either.
   */
  unknownTerms(name: string, currency: string | null): SupplierTerms {
    return {
      shopId: null,
      name,
      currency: (currency ?? 'EUR').toUpperCase(),
      discountPercent: 0,
      vatState: VatState.Unknown,
      vatRate: 20,
      shippingCost: 0,
      freeShippingOver: null,
      handlingFee: 0,
      minOrderValue: 0,
    };
  }

  lineCost(input: LinePriceInput, terms: SupplierTerms, targetCurrency: string): LineCost {
    return effectiveLineCost(input, terms, targetCurrency);
  }

  /**
   * Prices one line at every supplier and marks which figures are comparable.
   *
   * The comparability pass has to see the whole set — a price whose VAT
   * treatment is unknown is fine next to other unknowns and not fine next to a
   * known one, and only the set says which case this is.
   */
  compareLine(
    input: LinePriceInput,
    suppliers: SupplierTerms[],
    targetCurrency: string,
  ): LineCost[] {
    return assessComparability(
      suppliers.map((terms) => effectiveLineCost(input, terms, targetCurrency)),
    );
  }

  orderCost(lines: LineCost[], terms: SupplierTerms, targetCurrency: string): SupplierOrderCost {
    return supplierOrderCost(lines, terms, targetCurrency);
  }

  isViable(cost: SupplierOrderCost): boolean {
    return isViableOrder(cost);
  }

  /**
   * Where to place a whole order so it costs the least and can be placed.
   *
   * A thin pass-through, for the same reason as everything else here: the
   * decision is pure arithmetic over data that has already been fetched,
   * matched and priced, and it stays that way so it can be tested exhaustively.
   * This method exists only so callers inject one service rather than importing
   * a free function alongside it.
   */
  optimiseOrder(
    lines: OptimiserLine[],
    terms: Map<string, SupplierTerms>,
    options: OptimiserOptions,
  ): OptimisationResult {
    return optimiseOrder(lines, terms, options);
  }
}
