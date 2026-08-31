import {
  CostWarning,
  SupplierOrderCost,
  SupplierTerms,
  VatCertainty,
  round,
  supplierOrderCost,
} from './effective-cost';

/**
 * Where to place an order so it costs the least and can actually be placed.
 *
 * The question is not "which supplier is cheapest for this article" — the
 * ranking answers that. It is "given twenty-five lines, six suppliers, their
 * delivery charges and their minimum orders, how do I split this". Those have
 * different answers, and the difference is money.
 *
 * What this replaces is a greedy split: take every line from whoever is
 * cheapest on it, add up the goods. That is wrong three ways, and all three
 * point the same direction — it makes the plan look better than it is:
 *
 *  - **It ignores delivery.** Four suppliers means four deliveries.
 *  - **It ignores minimum orders.** A supplier holding €195 of a €200-minimum
 *    order will refuse the whole thing.
 *  - **So it can recommend an order that cannot be placed** — and report a
 *    saving against it.
 *
 * Pure computation. No repository, no HTTP, no model, no clock. Everything it
 * needs has already been fetched, matched and priced; this only decides. That
 * makes it exhaustively testable, and makes a disputed plan reproducible from
 * its inputs alone.
 */

// --- Input -------------------------------------------------------------------

/** One supplier's best offer for one line, already priced and matched. */
export interface OptimiserOffer {
  shopId: string;
  /** Net of VAT, in the target currency, per unit. Null when unpriceable. */
  unitPrice: number | null;
  /** 0–1 from the matcher. Below the floor the offer is not this article. */
  confidence: number;
  /** Null when the listing did not say — which is most of the time. */
  available: boolean | null;
  priceSource: 'live' | 'cached' | 'manual';
  /** When a hand-entered or cached figure was last confirmed. */
  recordedAt: string | null;
  vatCertainty: VatCertainty;
  /** The supplier's own name for the article, for the order that goes out. */
  matchedName?: string | null;
  url?: string | null;
}

export interface OptimiserLine {
  query: string;
  quantity: number;
  offers: OptimiserOffer[];
}

export interface OptimiserOptions {
  currency: string;
  /**
   * How many suppliers the buyer is willing to split across.
   *
   * A real constraint, not a tuning knob: three deliveries to accept, three
   * invoices to reconcile and three people to chase is worth more than the
   * €5 the third supplier saves. Unset, every combination is considered.
   */
  maxSuppliers?: number;
  /** Below this an offer is not treated as this article. */
  minConfidence?: number;
  /** Suppliers the buyer has ruled out for this order. */
  excludeShopIds?: string[];
  /** True drops offers a listing reported as out of stock. */
  requireAvailable?: boolean;
}

/*
 * There is deliberately no `staleAfterDays` here.
 *
 * A hand-entered price from six weeks ago is still the cheapest offer if it is
 * the cheapest offer, and dropping it would misreport what a supplier carries.
 * What the optimiser owes the buyer is not a filter but a fact: every allocated
 * line carries its `priceSource` and `recordedAt` through to the plan, and the
 * interface says how old the figure is next to the number it produced.
 */

// --- Output ------------------------------------------------------------------

export type OfferRejection = 'low_confidence' | 'unavailable' | 'no_price' | 'supplier_excluded';

export type SupplierRejection = 'below_minimum_order' | 'excluded_by_customer';

export interface RejectedSupplier {
  shopId: string;
  name: string;
  reason: SupplierRejection;
  /** Written for the buyer. */
  message: string;
  /** Present for `below_minimum_order`. */
  goodsTotal?: number;
  minOrderValue?: number;
}

export interface UnassignedLine {
  query: string;
  quantity: number;
  /** Why every offer for this line was dropped, or that there were none. */
  reason: 'no_offers' | 'all_rejected';
  rejections: Array<{ shopId: string; reason: OfferRejection }>;
}

export interface AllocationLine {
  query: string;
  quantity: number;
  shopId: string;
  matchedName: string | null;
  url: string | null;
  unitPrice: number;
  lineTotal: number;
  confidence: number;
  priceSource: 'live' | 'cached' | 'manual';
  recordedAt: string | null;
  vatCertainty: VatCertainty;
  warnings: CostWarning[];
}

export interface AllocationSupplier {
  shopId: string;
  name: string;
  lines: AllocationLine[];
  linesCovered: number;
  /** Goods after discount, net of VAT. */
  productSubtotal: number;
  shipping: number;
  shippingWaived: boolean;
  handlingFee: number;
  /** goods + shipping + handling. */
  total: number;
  meetsMinimumOrder: boolean;
  minOrderValue: number;
  minimumShortfall: number;
  warnings: CostWarning[];
}

export type PlanKind = 'optimal' | 'single_supplier' | 'fewest_suppliers' | 'alternative';

export interface PurchasePlan {
  kind: PlanKind;
  /** One clause for the interface: "2 доставчика". */
  label: string;
  suppliers: AllocationSupplier[];
  suppliersUsed: number;
  productSubtotal: number;
  shipping: number;
  handlingFee: number;
  total: number;
  linesCovered: number;
  /** Difference against the baseline. Null when there is no baseline. */
  savings: number | null;
  warnings: CostWarning[];
}

export interface PlanExplanation {
  /** Why the chosen plan won. Short sentences, ready for the interface. */
  whyChosen: string[];
  /** What was given up, and what it would have cost. */
  tradeOffs: string[];
}

export interface OptimisationDiagnostics {
  lineCount: number;
  assignableLines: number;
  supplierCount: number;
  candidateOffers: number;
  combinationsEvaluated: number;
  feasiblePlans: number;
  /** True when the search space was capped and only small subsets were tried. */
  boundedSearch: boolean;
  durationMs: number;
}

export interface OptimisationResult {
  currency: string;
  best: PurchasePlan | null;
  /** The cheapest single supplier who could take the whole order. */
  baseline: PurchasePlan | null;
  savings: number | null;
  savingsPercent: number | null;
  /** Meaningfully different plans, cheapest first. Never repeats `best`. */
  alternatives: PurchasePlan[];
  unassigned: UnassignedLine[];
  rejectedSuppliers: RejectedSupplier[];
  explanation: PlanExplanation;
  diagnostics: OptimisationDiagnostics;
}

// --- Bounds ------------------------------------------------------------------

/**
 * How many supplier combinations may be evaluated before the search is capped.
 *
 * The expected shape is 3–10 suppliers, which is at most 1 023 combinations —
 * nowhere near this. The cap exists so that an account with thirty suppliers
 * degrades to a bounded search instead of hanging, and it is reported rather
 * than hidden: `diagnostics.boundedSearch` says the answer is the best of what
 * was tried, not the best there is.
 */
const MAX_COMBINATIONS = 20_000;

/** Subset size the bounded search falls back to. */
const BOUNDED_MAX_SUPPLIERS = 4;

// --- The algorithm -----------------------------------------------------------

/**
 * Finds the cheapest combination of suppliers that can actually fill the order.
 *
 * **Why subsets rather than assignments.** The obvious search is over
 * assignments — which supplier gets which line — and it is exponential in the
 * *lines*: six suppliers over twenty-five lines is 6²⁵. The useful observation
 * is that once the *set* of suppliers is fixed, the assignment is almost
 * decided: every line goes to the cheapest supplier in the set that carries it.
 * So the search is over supplier subsets, exponential in the *suppliers* — and
 * there are six of those, not twenty-five. 2⁶ = 64 combinations, each costing
 * one pass over the lines.
 *
 * That reduction is what makes an exact answer affordable, and it is why this
 * needs no solver, no relaxation and no time limit at realistic sizes.
 *
 * **Where it is exact, and where it is not.** Coverage, minimum orders, flat
 * delivery, handling and the supplier cap are handled exactly. Free-delivery
 * thresholds are not: crossing one can be worth paying more for the goods, and
 * finding the cheapest way to cross every threshold at once is a harder
 * problem than the rest of this put together. It is handled by a bounded
 * improvement pass ({@link improveFreeShipping}), so the answer there is the
 * best found rather than the provably best. Said plainly here because a
 * comment is the only place it can be said honestly.
 */
export function optimiseOrder(
  lines: OptimiserLine[],
  terms: Map<string, SupplierTerms>,
  options: OptimiserOptions,
): OptimisationResult {
  const startedAt = Date.now();
  const currency = (options.currency || 'EUR').toUpperCase();
  const minConfidence = options.minConfidence ?? 0;
  const excluded = new Set(options.excludeShopIds ?? []);

  const empty = (diagnostics: Partial<OptimisationDiagnostics> = {}): OptimisationResult => ({
    currency,
    best: null,
    baseline: null,
    savings: null,
    savingsPercent: null,
    alternatives: [],
    unassigned: [],
    rejectedSuppliers: [],
    explanation: { whyChosen: [], tradeOffs: [] },
    diagnostics: {
      lineCount: lines.length,
      assignableLines: 0,
      supplierCount: 0,
      candidateOffers: 0,
      combinationsEvaluated: 0,
      feasiblePlans: 0,
      boundedSearch: false,
      durationMs: Date.now() - startedAt,
      ...diagnostics,
    },
  });

  if (lines.length === 0) return empty();

  // --- 1. Sift the offers ---------------------------------------------------
  //
  // Every rejection is recorded. A line nobody can supply and a line whose
  // only offers were too uncertain are different answers, and a buyer asking
  // "why is this missing" deserves the second one.

  const assignable: AssignableLine[] = [];
  const unassigned: UnassignedLine[] = [];
  let candidateOffers = 0;

  for (const line of lines) {
    // A line for nothing is not an order line. Guarded here rather than at the
    // edge because the optimiser is also called from tests and future callers.
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      unassigned.push({
        query: line.query,
        quantity: line.quantity,
        reason: 'no_offers',
        rejections: [],
      });
      continue;
    }

    const rejections: Array<{ shopId: string; reason: OfferRejection }> = [];
    const kept: AssignableOffer[] = [];

    for (const offer of line.offers) {
      const reason = rejectOffer(offer, { minConfidence, excluded, options });

      if (reason) {
        rejections.push({ shopId: offer.shopId, reason });
        continue;
      }

      // Only a supplier we hold terms for can be costed: without them there is
      // no discount, no delivery and no minimum, and a total built from a
      // guess is worse than an admitted gap.
      if (!terms.has(offer.shopId)) {
        rejections.push({ shopId: offer.shopId, reason: 'supplier_excluded' });
        continue;
      }

      kept.push({ ...offer, unitPrice: offer.unitPrice as number });
      candidateOffers += 1;
    }

    if (kept.length === 0) {
      unassigned.push({
        query: line.query,
        quantity: line.quantity,
        reason: line.offers.length === 0 ? 'no_offers' : 'all_rejected',
        rejections,
      });
      continue;
    }

    // Cheapest first, then by id: two suppliers at the same price must always
    // resolve the same way, or the same order produces two different plans.
    kept.sort((a, b) => a.unitPrice - b.unitPrice || a.shopId.localeCompare(b.shopId));

    assignable.push({ query: line.query, quantity: line.quantity, offers: kept });
  }

  if (assignable.length === 0) {
    return {
      ...empty({ candidateOffers }),
      unassigned,
      explanation: {
        whyChosen: [],
        tradeOffs: ['Никой от вашите доставчици не предлага нито един от артикулите.'],
      },
    };
  }

  // --- 2. Which suppliers are even in the running ---------------------------

  const supplierIds = [
    ...new Set(assignable.flatMap((line) => line.offers.map((offer) => offer.shopId))),
  ].sort();

  const rejectedSuppliers: RejectedSupplier[] = [];

  for (const shopId of excluded) {
    const supplier = terms.get(shopId);
    if (!supplier) continue;
    rejectedSuppliers.push({
      shopId,
      name: supplier.name,
      reason: 'excluded_by_customer',
      message: `${supplier.name} е изключен от тази поръчка по ваше желание.`,
    });
  }

  // --- 3. Enumerate supplier combinations -----------------------------------

  const requestedMax = options.maxSuppliers;
  const hardMax =
    requestedMax && requestedMax > 0
      ? Math.min(requestedMax, supplierIds.length)
      : supplierIds.length;

  const boundedSearch = countCombinations(supplierIds.length, hardMax) > MAX_COMBINATIONS;
  const searchMax = boundedSearch ? Math.min(hardMax, BOUNDED_MAX_SUPPLIERS) : hardMax;

  const plans: EvaluatedPlan[] = [];
  let combinationsEvaluated = 0;

  for (const subset of combinations(supplierIds, searchMax)) {
    combinationsEvaluated += 1;

    const assignment = greedyAssign(assignable, subset);
    // A subset that cannot reach every line is not a cheaper plan, it is a
    // different (smaller) order. Comparing those two would be comparing two
    // different purchases.
    if (!assignment) continue;

    const repaired = repairMinimums(assignment, assignable, subset, terms, currency);
    if (!repaired) continue;

    const improved = improveFreeShipping(repaired, assignable, subset, terms, currency);
    const evaluated = evaluate(improved, assignable, terms, currency);
    if (!evaluated) continue;

    plans.push(evaluated);
  }

  if (plans.length === 0) {
    // Nothing feasible: say which supplier fell short and by how much, so the
    // buyer can top an order up rather than guess.
    for (const shopId of supplierIds) {
      const supplier = terms.get(shopId)!;
      const solo = evaluate(assignAllTo(assignable, shopId), assignable, terms, currency);
      if (solo) continue;

      const goods = soloGoods(assignable, shopId);
      if (goods !== null && goods < supplier.minOrderValue) {
        rejectedSuppliers.push({
          shopId,
          name: supplier.name,
          reason: 'below_minimum_order',
          message: `${supplier.name} не приема поръчки под ${supplier.minOrderValue} ${currency}. Тази поръчка при тях е ${round(goods)} ${currency}.`,
          goodsTotal: round(goods),
          minOrderValue: supplier.minOrderValue,
        });
      }
    }

    return {
      ...empty({
        assignableLines: assignable.length,
        supplierCount: supplierIds.length,
        candidateOffers,
        combinationsEvaluated,
        boundedSearch,
      }),
      unassigned,
      rejectedSuppliers,
      explanation: {
        whyChosen: [],
        tradeOffs: ['Нито една комбинация от вашите доставчици не може да изпълни цялата поръчка.'],
      },
    };
  }

  // Cheapest first. Then fewer suppliers — at the same price, fewer deliveries
  // and fewer invoices is strictly better. Then by supplier ids, so an exact
  // tie always resolves the same way and the same order never produces two
  // different plans.
  plans.sort(
    (a, b) =>
      a.total - b.total ||
      a.shopIds.length - b.shopIds.length ||
      a.shopIds.join(',').localeCompare(b.shopIds.join(',')),
  );

  const bestEvaluated = plans[0];

  // --- 4. The baseline ------------------------------------------------------
  //
  // The cheapest single supplier who could take the whole order *and* would
  // accept it. Not the cheapest single supplier overall: one below their
  // minimum is not a baseline, because ordering everything from them is not
  // something the buyer can do.
  const baselineEvaluated = plans.find((plan) => plan.shopIds.length === 1) ?? null;

  const best = toPlan(bestEvaluated, 'optimal', baselineEvaluated?.total ?? null, terms);
  const baseline = baselineEvaluated
    ? toPlan(baselineEvaluated, 'single_supplier', null, terms)
    : null;

  const savings =
    baseline && baseline.total > best.total
      ? round(baseline.total - best.total)
      : baseline
        ? 0
        : null;
  const savingsPercent =
    savings !== null && baseline && baseline.total > 0
      ? Math.round((savings / baseline.total) * 1000) / 10
      : null;

  const alternatives = pickAlternatives(plans, bestEvaluated, baselineEvaluated, terms);

  return {
    currency,
    best,
    baseline,
    savings,
    savingsPercent,
    alternatives,
    unassigned,
    rejectedSuppliers,
    explanation: explain(bestEvaluated, baselineEvaluated, plans, terms, currency, unassigned),
    diagnostics: {
      lineCount: lines.length,
      assignableLines: assignable.length,
      supplierCount: supplierIds.length,
      candidateOffers,
      combinationsEvaluated,
      feasiblePlans: plans.length,
      boundedSearch,
      durationMs: Date.now() - startedAt,
    },
  };
}

// --- Internals ---------------------------------------------------------------

interface AssignableOffer extends Omit<OptimiserOffer, 'unitPrice'> {
  unitPrice: number;
}

interface AssignableLine {
  query: string;
  quantity: number;
  /** Cheapest first, ties broken by shop id. */
  offers: AssignableOffer[];
}

/** Line index → shop id. The whole assignment, as compactly as it can be held. */
type Assignment = string[];

interface EvaluatedPlan {
  assignment: Assignment;
  shopIds: string[];
  costs: Map<string, SupplierOrderCost>;
  linesOf: Map<string, AllocationLine[]>;
  total: number;
}

function rejectOffer(
  offer: OptimiserOffer,
  context: { minConfidence: number; excluded: Set<string>; options: OptimiserOptions },
): OfferRejection | null {
  if (context.excluded.has(offer.shopId)) return 'supplier_excluded';
  if (offer.unitPrice === null || !Number.isFinite(offer.unitPrice)) return 'no_price';
  if (offer.unitPrice < 0) return 'no_price';
  if (offer.confidence < context.minConfidence) return 'low_confidence';
  // `null` means the listing did not say, which is most of the time. Only an
  // explicit "out of stock" drops the offer, and only when asked.
  if (context.options.requireAvailable && offer.available === false) return 'unavailable';
  return null;
}

/**
 * Every subset of `ids` with between one and `maxSize` members.
 *
 * Yielded smallest first so a bounded search spends its budget on the
 * combinations most likely to win: a buyer splitting across two suppliers is
 * far more common than one splitting across six.
 */
function* combinations(ids: string[], maxSize: number): Generator<string[]> {
  for (let size = 1; size <= maxSize; size += 1) {
    yield* combinationsOfSize(ids, size, 0, []);
  }
}

function* combinationsOfSize(
  ids: string[],
  size: number,
  start: number,
  chosen: string[],
): Generator<string[]> {
  if (chosen.length === size) {
    yield [...chosen];
    return;
  }

  for (let index = start; index < ids.length; index += 1) {
    // Prune: not enough ids left to reach the target size.
    if (ids.length - index < size - chosen.length) break;
    chosen.push(ids[index]);
    yield* combinationsOfSize(ids, size, index + 1, chosen);
    chosen.pop();
  }
}

/** How many subsets of size 1..maxSize exist over `n` items. */
function countCombinations(n: number, maxSize: number): number {
  let total = 0;
  let coefficient = 1;

  for (let k = 1; k <= maxSize; k += 1) {
    coefficient = (coefficient * (n - k + 1)) / k;
    total += coefficient;
    if (total > MAX_COMBINATIONS) return total;
  }

  return total;
}

/**
 * Every line to the cheapest supplier in the subset that carries it.
 *
 * @returns null when the subset cannot reach some line — such a subset is not
 * a cheaper plan, it is a smaller order.
 */
function greedyAssign(lines: AssignableLine[], subset: string[]): Assignment | null {
  const allowed = new Set(subset);
  const assignment: Assignment = [];

  for (const line of lines) {
    // `offers` is sorted cheapest-first with ties on shop id, so the first
    // allowed offer is both the cheapest and the deterministic choice.
    const chosen = line.offers.find((offer) => allowed.has(offer.shopId));
    if (!chosen) return null;
    assignment.push(chosen.shopId);
  }

  return assignment;
}

function assignAllTo(lines: AssignableLine[], shopId: string): Assignment | null {
  const assignment: Assignment = [];

  for (const line of lines) {
    if (!line.offers.some((offer) => offer.shopId === shopId)) return null;
    assignment.push(shopId);
  }

  return assignment;
}

/** Goods total if one supplier took every line. Null when they cannot. */
function soloGoods(lines: AssignableLine[], shopId: string): number | null {
  let total = 0;

  for (const line of lines) {
    const offer = line.offers.find((candidate) => candidate.shopId === shopId);
    if (!offer) return null;
    total += offer.unitPrice * line.quantity;
  }

  return total;
}

function unitPriceAt(line: AssignableLine, shopId: string): number | null {
  return line.offers.find((offer) => offer.shopId === shopId)?.unitPrice ?? null;
}

/** Goods per supplier for one assignment. */
function goodsByShop(lines: AssignableLine[], assignment: Assignment): Map<string, number> {
  const goods = new Map<string, number>();

  assignment.forEach((shopId, index) => {
    const price = unitPriceAt(lines[index], shopId)!;
    goods.set(shopId, (goods.get(shopId) ?? 0) + price * lines[index].quantity);
  });

  return goods;
}

/**
 * Moves lines until no supplier sits below their minimum order.
 *
 * Two ways out of a shortfall, and which is cheaper is not obvious:
 *
 *  - **Drop the supplier** and give their lines to the next cheapest in the
 *    subset. Loses whatever price advantage they had.
 *  - **Top them up** by moving lines to them from elsewhere, cheapest penalty
 *    first, until they clear. Costs a little on the goods, keeps the supplier.
 *
 * Both are computed and the cheaper is taken. The second is the one a greedy
 * split can never find, and in a real basket it is often the winner: five euros
 * short of a minimum is not a reason to lose a supplier who is cheapest on the
 * largest line.
 *
 * @returns null when the shortfall cannot be repaired within the subset.
 */
function repairMinimums(
  assignment: Assignment,
  lines: AssignableLine[],
  subset: string[],
  terms: Map<string, SupplierTerms>,
  currency: string,
): Assignment | null {
  let current = assignment;

  // Bounded: each pass either removes a supplier or clears a shortfall, so it
  // cannot cycle. The `+ 1` covers the final check that finds nothing to do.
  for (let pass = 0; pass <= subset.length + 1; pass += 1) {
    const goods = goodsByShop(lines, current);

    const short = [...goods.entries()]
      .filter(([shopId, total]) => total < terms.get(shopId)!.minOrderValue)
      // Deterministic: largest shortfall first, ties by id.
      .sort(
        (a, b) =>
          terms.get(b[0])!.minOrderValue - b[1] - (terms.get(a[0])!.minOrderValue - a[1]) ||
          a[0].localeCompare(b[0]),
      );

    if (short.length === 0) return current;

    const [shopId] = short[0];

    const dropped = dropSupplier(current, lines, subset, shopId);
    const toppedUp = topUpSupplier(current, lines, shopId, terms);

    const droppedCost = dropped ? (evaluate(dropped, lines, terms, currency)?.total ?? null) : null;
    const toppedCost = toppedUp
      ? (evaluate(toppedUp, lines, terms, currency)?.total ?? null)
      : null;

    if (droppedCost === null && toppedCost === null) return null;

    if (toppedCost !== null && (droppedCost === null || toppedCost <= droppedCost)) {
      // Topping up resolves this supplier outright, so the evaluated
      // assignment is already feasible — return it rather than looping.
      current = toppedUp!;
      continue;
    }

    current = dropped!;
  }

  return null;
}

/** Reassigns one supplier's lines to the next cheapest in the subset. */
function dropSupplier(
  assignment: Assignment,
  lines: AssignableLine[],
  subset: string[],
  shopId: string,
): Assignment | null {
  const remaining = new Set(subset.filter((id) => id !== shopId));
  if (remaining.size === 0) return null;

  const next: Assignment = [];

  for (let index = 0; index < assignment.length; index += 1) {
    if (assignment[index] !== shopId) {
      next.push(assignment[index]);
      continue;
    }

    const replacement = lines[index].offers.find((offer) => remaining.has(offer.shopId));
    if (!replacement) return null;
    next.push(replacement.shopId);
  }

  return next;
}

/**
 * Moves lines to a supplier until they clear their minimum.
 *
 * Cheapest penalty first — the line where switching costs the least. Ties are
 * broken by line index so the same shortfall always produces the same move.
 */
function topUpSupplier(
  assignment: Assignment,
  lines: AssignableLine[],
  shopId: string,
  terms: Map<string, SupplierTerms>,
): Assignment | null {
  const minimum = terms.get(shopId)!.minOrderValue;
  const next = [...assignment];

  const movable = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => next[entry.index] !== shopId)
    .map((entry) => {
      const target = unitPriceAt(entry.line, shopId);
      if (target === null) return null;

      const currentPrice = unitPriceAt(entry.line, next[entry.index])!;

      return {
        index: entry.index,
        penalty: (target - currentPrice) * entry.line.quantity,
        adds: target * entry.line.quantity,
      };
    })
    .filter((entry): entry is { index: number; penalty: number; adds: number } => entry !== null)
    .sort((a, b) => a.penalty - b.penalty || a.index - b.index);

  let goods = goodsByShop(lines, next).get(shopId) ?? 0;

  for (const move of movable) {
    if (goods >= minimum) break;
    next[move.index] = shopId;
    goods += move.adds;
  }

  return goods >= minimum ? next : null;
}

/**
 * Tries to cross a free-delivery threshold where doing so pays.
 *
 * A supplier eleven euros short of free delivery on a twelve-euro charge is
 * worth topping up — the goods cost a little more and the delivery costs
 * nothing. Greedy and bounded: cheapest penalty first, one supplier at a time,
 * and the whole move is kept only if the evaluated total actually drops.
 *
 * This is the one place the answer is "best found" rather than "provably best":
 * thresholds interact, and chasing that exactly is a harder problem than
 * everything else here combined. Evaluating the result rather than predicting
 * it means a move can never make the plan worse.
 */
function improveFreeShipping(
  assignment: Assignment,
  lines: AssignableLine[],
  subset: string[],
  terms: Map<string, SupplierTerms>,
  currency: string,
): Assignment {
  let current = assignment;
  let currentCost = evaluate(current, lines, terms, currency)?.total ?? Infinity;

  for (const shopId of [...subset].sort()) {
    const supplier = terms.get(shopId)!;
    if (supplier.freeShippingOver === null || supplier.shippingCost <= 0) continue;

    const goods = goodsByShop(lines, current).get(shopId) ?? 0;
    if (goods >= supplier.freeShippingOver) continue;

    const candidate = topUpTo(current, lines, shopId, supplier.freeShippingOver);
    if (!candidate) continue;

    const candidateCost = evaluate(candidate, lines, terms, currency)?.total ?? null;

    // Only if it is genuinely cheaper. Equal is not better: it would move lines
    // for nothing and make the plan harder to explain.
    if (candidateCost !== null && candidateCost < currentCost) {
      current = candidate;
      currentCost = candidateCost;
    }
  }

  return current;
}

/** Moves lines to a supplier until their goods reach a target. */
function topUpTo(
  assignment: Assignment,
  lines: AssignableLine[],
  shopId: string,
  target: number,
): Assignment | null {
  const next = [...assignment];

  const movable = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => next[entry.index] !== shopId)
    .map((entry) => {
      const price = unitPriceAt(entry.line, shopId);
      if (price === null) return null;

      const currentPrice = unitPriceAt(entry.line, next[entry.index])!;

      return {
        index: entry.index,
        penalty: (price - currentPrice) * entry.line.quantity,
        adds: price * entry.line.quantity,
      };
    })
    .filter((entry): entry is { index: number; penalty: number; adds: number } => entry !== null)
    .sort((a, b) => a.penalty - b.penalty || a.index - b.index);

  let goods = goodsByShop(lines, next).get(shopId) ?? 0;
  let moved = false;

  for (const move of movable) {
    if (goods >= target) break;
    next[move.index] = shopId;
    goods += move.adds;
    moved = true;
  }

  return moved && goods >= target ? next : null;
}

/**
 * Costs a whole assignment, or reports it impossible.
 *
 * Deliberately computed from scratch rather than updated incrementally: the
 * repair and improvement passes propose assignments and this decides, so a
 * proposal can never leave the plan in a state nobody checked. Recomputing a
 * forty-line plan is microseconds, and the alternative — incremental updates
 * that must stay in step with three mutation paths — is where this kind of
 * code goes wrong.
 *
 * @returns null when any supplier in the assignment would refuse their share.
 */
function evaluate(
  assignment: Assignment | null,
  lines: AssignableLine[],
  terms: Map<string, SupplierTerms>,
  currency: string,
): EvaluatedPlan | null {
  if (!assignment) return null;

  const linesOf = new Map<string, AllocationLine[]>();
  const costsOf = new Map<string, SupplierOrderCost>();

  assignment.forEach((shopId, index) => {
    const line = lines[index];
    const offer = line.offers.find((candidate) => candidate.shopId === shopId)!;
    const lineTotal = round(offer.unitPrice * line.quantity);

    const allocation: AllocationLine = {
      query: line.query,
      quantity: line.quantity,
      shopId,
      matchedName: offer.matchedName ?? null,
      url: offer.url ?? null,
      unitPrice: offer.unitPrice,
      lineTotal,
      confidence: offer.confidence,
      priceSource: offer.priceSource,
      recordedAt: offer.recordedAt,
      vatCertainty: offer.vatCertainty,
      warnings: [],
    };

    const bucket = linesOf.get(shopId);
    if (bucket) bucket.push(allocation);
    else linesOf.set(shopId, [allocation]);
  });

  let total = 0;

  // Sorted so the plan is built in the same order every time.
  for (const shopId of [...linesOf.keys()].sort()) {
    const supplier = terms.get(shopId)!;
    const allocated = linesOf.get(shopId)!;

    const cost = supplierOrderCost(
      allocated.map((line) => ({
        listPrice: line.unitPrice,
        listCurrency: currency,
        discountPercent: supplier.discountPercent,
        discountedUnitPrice: line.unitPrice,
        vatState: supplier.vatState,
        vatRate: supplier.vatRate,
        vatCertainty: line.vatCertainty,
        netUnitPrice: line.unitPrice,
        effectiveUnitPrice: line.unitPrice,
        effectiveCurrency: currency,
        quantity: line.quantity,
        netLineTotal: line.lineTotal,
        warnings: [],
      })),
      supplier,
      currency,
    );

    // The whole point of the optimiser: a supplier who will not accept their
    // share makes the entire plan impossible, not merely more expensive.
    if (!cost.meetsMinimumOrder) return null;

    costsOf.set(shopId, cost);
    total += cost.effectiveTotal;
  }

  return {
    assignment,
    shopIds: [...linesOf.keys()].sort(),
    costs: costsOf,
    linesOf,
    total: round(total),
  };
}

// --- Presentation ------------------------------------------------------------

function toPlan(
  evaluated: EvaluatedPlan,
  kind: PlanKind,
  baselineTotal: number | null,
  terms: Map<string, SupplierTerms>,
): PurchasePlan {
  const suppliers: AllocationSupplier[] = evaluated.shopIds.map((shopId) => {
    const cost = evaluated.costs.get(shopId)!;
    const allocated = evaluated.linesOf.get(shopId)!;

    return {
      shopId,
      name: terms.get(shopId)!.name,
      lines: allocated,
      linesCovered: allocated.length,
      productSubtotal: cost.goodsTotal,
      shipping: cost.shippingCost,
      shippingWaived: cost.shippingWaived,
      handlingFee: cost.handlingFee,
      total: cost.effectiveTotal,
      meetsMinimumOrder: cost.meetsMinimumOrder,
      minOrderValue: cost.minOrderValue,
      minimumShortfall: cost.minimumShortfall,
      warnings: cost.warnings,
    };
  });

  const productSubtotal = round(
    suppliers.reduce((sum, supplier) => sum + supplier.productSubtotal, 0),
  );
  const shipping = round(suppliers.reduce((sum, supplier) => sum + supplier.shipping, 0));
  const handlingFee = round(suppliers.reduce((sum, supplier) => sum + supplier.handlingFee, 0));

  return {
    kind,
    label: labelFor(suppliers.length),
    suppliers,
    suppliersUsed: suppliers.length,
    productSubtotal,
    shipping,
    handlingFee,
    total: evaluated.total,
    linesCovered: suppliers.reduce((sum, supplier) => sum + supplier.linesCovered, 0),
    savings:
      baselineTotal !== null && baselineTotal > evaluated.total
        ? round(baselineTotal - evaluated.total)
        : baselineTotal !== null
          ? 0
          : null,
    warnings: collectWarnings(suppliers),
  };
}

function labelFor(count: number): string {
  if (count === 1) return '1 доставчик';
  return `${count} доставчика`;
}

function collectWarnings(suppliers: AllocationSupplier[]): CostWarning[] {
  const seen = new Set<string>();
  const warnings: CostWarning[] = [];

  for (const supplier of suppliers) {
    for (const warning of supplier.warnings) {
      const key = `${warning.kind}:${warning.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push(warning);
    }
  }

  return warnings;
}

/**
 * The two or three plans worth showing beside the winner.
 *
 * Not the next-cheapest three — those are usually the same plan with one line
 * moved, and a list of near-identical options is a list nobody reads. What a
 * buyer actually chooses between is *shapes*: the cheapest overall, the one
 * with a single delivery, and the cheapest at each smaller supplier count.
 */
function pickAlternatives(
  plans: EvaluatedPlan[],
  best: EvaluatedPlan,
  baseline: EvaluatedPlan | null,
  terms: Map<string, SupplierTerms>,
): PurchasePlan[] {
  const chosen: Array<{ plan: EvaluatedPlan; kind: PlanKind }> = [];
  const taken = new Set<string>([best.shopIds.join(',')]);

  const add = (plan: EvaluatedPlan | undefined, kind: PlanKind): void => {
    if (!plan) return;
    const key = plan.shopIds.join(',');
    if (taken.has(key)) return;
    taken.add(key);
    chosen.push({ plan, kind });
  };

  // The single-supplier order: one delivery, one invoice, one person to chase.
  add(baseline ?? undefined, 'single_supplier');

  // The cheapest plan at each supplier count below the winner's — the buyer
  // trading a little money for a lot less handling.
  for (let count = 1; count < best.shopIds.length; count += 1) {
    add(
      plans.find((plan) => plan.shopIds.length === count),
      'fewest_suppliers',
    );
  }

  // One genuinely different cheaper-shape plan, if the winner is not already
  // the smallest.
  add(
    plans.find(
      (plan) => plan.shopIds.length > best.shopIds.length && !taken.has(plan.shopIds.join(',')),
    ),
    'alternative',
  );

  return chosen
    .slice(0, 3)
    .map(({ plan, kind }) => toPlan(plan, kind, baseline?.total ?? null, terms));
}

function explain(
  best: EvaluatedPlan,
  baseline: EvaluatedPlan | null,
  plans: EvaluatedPlan[],
  terms: Map<string, SupplierTerms>,
  currency: string,
  unassigned: UnassignedLine[],
): PlanExplanation {
  const whyChosen: string[] = [];
  const tradeOffs: string[] = [];

  const names = best.shopIds.map((id) => terms.get(id)!.name);

  if (best.shopIds.length === 1) {
    whyChosen.push(
      `Цялата поръчка при ${names[0]} излиза най-евтино — разделянето ѝ не спестява нищо след доставките.`,
    );
  } else if (baseline) {
    const saved = round(baseline.total - best.total);
    whyChosen.push(
      `Разделихме поръчката между ${names.join(' и ')}, защото така общата сума пада с ${saved} ${currency}.`,
    );
  } else {
    whyChosen.push(
      `Разделихме поръчката между ${names.join(' и ')} — никой доставчик не може да я изпълни сам.`,
    );
  }

  // What each supplier is doing here, in money rather than in adjectives.
  for (const shopId of best.shopIds) {
    const cost = best.costs.get(shopId)!;
    const supplier = terms.get(shopId)!;
    const lineCount = best.linesOf.get(shopId)!.length;

    const parts = [
      `${supplier.name}: ${lineCount} ${lineCount === 1 ? 'ред' : 'реда'}, ${cost.goodsTotal} ${currency}`,
    ];

    if (cost.shippingWaived) {
      parts.push(`доставката отпада над ${supplier.freeShippingOver} ${currency}`);
    } else if (cost.shippingCost > 0) {
      parts.push(`доставка ${cost.shippingCost} ${currency}`);
    }

    if (supplier.minOrderValue > 0) {
      parts.push(`минимумът им от ${supplier.minOrderValue} ${currency} е покрит`);
    }

    whyChosen.push(parts.join(' · '));
  }

  // The trade-off that a buyer will otherwise work out for themselves and
  // distrust us for not having mentioned.
  const cheaperButMore = plans.find(
    (plan) => plan.shopIds.length > best.shopIds.length && plan.total < best.total,
  );

  if (cheaperButMore) {
    tradeOffs.push(
      `Разделяне между ${cheaperButMore.shopIds.length} доставчика спестява още ` +
        `${round(best.total - cheaperButMore.total)} ${currency}, но добавя още една доставка.`,
    );
  }

  const nextSmaller = plans.find((plan) => plan.shopIds.length < best.shopIds.length);
  if (nextSmaller) {
    tradeOffs.push(
      `С ${nextSmaller.shopIds.length} ${nextSmaller.shopIds.length === 1 ? 'доставчик' : 'доставчика'} ` +
        `поръчката би струвала ${nextSmaller.total} ${currency} — с ${round(nextSmaller.total - best.total)} ${currency} повече.`,
    );
  }

  if (unassigned.length > 0) {
    // Singular and plural agree all the way through the sentence, not just on
    // the noun: "1 артикул … не участва" against "3 артикула … не участват".
    tradeOffs.push(
      unassigned.length === 1
        ? '1 артикул не беше намерен при никой доставчик и не участва в сметката.'
        : `${unassigned.length} артикула не бяха намерени при никой доставчик и не участват в сметката.`,
    );
  }

  return { whyChosen, tradeOffs };
}
