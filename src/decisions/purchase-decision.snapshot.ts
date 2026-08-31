import { CostWarning, VatCertainty, VatState, round } from '../pricing/effective-cost';
import { AllocationSupplier, OptimisationResult, PurchasePlan } from '../pricing/order-optimizer';

/**
 * What a purchase decision remembers, and why it remembers it rather than
 * pointing at the rows it came from.
 *
 * The product's claim is "you saved €214". A claim like that is worth nothing
 * on the day it is made and everything three months later, when the buyer is
 * deciding whether to renew — and three months later every input has moved.
 * The supplier renegotiated the discount. The delivery charge went up. The
 * article was relisted at a different price, or delisted. The matcher was
 * retrained. The optimiser was improved.
 *
 * If the number were recomputed from live rows, every one of those would
 * silently rewrite history, and the figure shown in November would not be the
 * figure the buyer acted on in August. That is not a rounding difference; it
 * is the difference between evidence and a re-enactment.
 *
 * So this is a **document, not a view**. Every value a person could later
 * dispute is copied in at the moment of the decision: the supplier's terms,
 * the price and where it was read, the match and what decided it, the plan and
 * every alternative it beat. Nothing here is a foreign key that resolves to
 * today's answer.
 *
 * Pure types and one pure builder. No repository, no clock beyond what is
 * handed in, no model — the same discipline the optimiser keeps, and for the
 * same reason: a disputed decision has to be reproducible from its inputs
 * alone.
 */

/** Bumped when the shape changes in a way a reader has to know about. */
export const SNAPSHOT_VERSION = 1 as const;

// --- Provenance --------------------------------------------------------------

/**
 * Where one price came from, in enough detail to defend it later.
 *
 * The interface has to be able to say "price checked 28 Aug 2026 at 14:31"
 * rather than showing today's figure under an old decision's heading. That
 * sentence needs the timestamp *and* the source: "cached six hours ago" and
 * "typed in by you six weeks ago" are different claims about the same number,
 * and collapsing them is how a comparison quietly stops being true.
 */
export interface PriceProvenanceSnapshot {
  /** `live` read moments before the decision, `cached` reused, `manual` typed in. */
  source: 'live' | 'cached' | 'manual';
  /** The page the figure was read from, as it was then. */
  url: string | null;
  supplierId: string;
  supplierName: string;
  /**
   * When the figure was last confirmed. Null for a live read, whose
   * confirmation time is the decision's own timestamp.
   */
  recordedAt: string | null;
  /**
   * How old the figure already was when the decision was made, in hours.
   *
   * Stored rather than derived, because deriving it later needs the decision
   * time *and* the recorded time and gets it wrong the moment either is
   * displayed in another timezone. A number computed once, at the only moment
   * it means anything, is the honest version.
   */
  ageHours: number | null;
  /** True when the figure was not read live for this decision. */
  stale: boolean;
}

/**
 * Why the matcher believed this supplier's article was the one asked for.
 *
 * Kept so "why did Stoclify choose this product?" has an answer that does not
 * depend on the matcher still behaving the way it did. `aiUsed`, `model` and
 * `promptVersion` are here for the same reason a lab notes its instrument: a
 * decision made by a model that has since been replaced is still a decision,
 * and the replacement is exactly what a later reader needs to know about.
 */
export interface MatchProvenanceSnapshot {
  method: string;
  confidence: number;
  band: string;
  explanation: string;
  /** Attribute by attribute, so the machine's work can be checked. */
  attributes: Array<{ label: string; left: string; right: string; agrees: boolean }>;
  aiUsed: boolean;
  model: string | null;
  promptVersion: string | null;
  /** Set when a person overrode the machine. Null everywhere else, for now. */
  manualOverride: string | null;
}

// --- The snapshot ------------------------------------------------------------

/** What the buyer asked for, exactly as they asked for it. */
export interface DecisionRequestSnapshot {
  lines: Array<{ query: string; quantity: number }>;
  currency: string;
  maxSuppliers: number | null;
  excludeShopIds: string[];
  /** False when every supplier was asked again rather than reused. */
  usedCache: boolean;
}

/**
 * A supplier's commercial terms, frozen.
 *
 * This is the field that makes the whole feature work. Change a discount
 * tomorrow and every live comparison changes with it — correctly. This copy
 * does not, which is what lets an old decision still explain its own
 * arithmetic.
 */
export interface DecisionSupplierSnapshot {
  shopId: string;
  name: string;
  host: string | null;
  currency: string;
  discountPercent: number;
  vatState: VatState;
  vatRate: number;
  shippingCost: number;
  freeShippingOver: number | null;
  handlingFee: number;
  minOrderValue: number;
}

/** One line of the chosen plan, with everything behind its number. */
export interface DecisionLineSnapshot {
  /** What the buyer wrote. */
  query: string;
  quantity: number;
  shopId: string;
  supplierName: string;
  /** The supplier's own name for the article. */
  matchedName: string | null;
  url: string | null;
  /** Net of VAT, per unit, in the decision's currency, after the discount. */
  unitPrice: number;
  /** The supplier's list price before the discount, in their own currency. */
  listPrice: number | null;
  listCurrency: string | null;
  discountPercent: number;
  vatState: VatState;
  vatCertainty: VatCertainty;
  lineTotal: number;
  price: PriceProvenanceSnapshot;
  match: MatchProvenanceSnapshot;
  warnings: CostWarning[];
}

/** One supplier's share of a plan, as it was costed. */
export interface DecisionPlanSupplierSnapshot {
  shopId: string;
  name: string;
  linesCovered: number;
  productSubtotal: number;
  shipping: number;
  shippingWaived: boolean;
  handlingFee: number;
  total: number;
  minOrderValue: number;
  meetsMinimumOrder: boolean;
  warnings: CostWarning[];
}

/** A whole way of placing the order. */
export interface DecisionPlanSnapshot {
  kind: string;
  label: string;
  suppliersUsed: number;
  productSubtotal: number;
  shipping: number;
  handlingFee: number;
  total: number;
  linesCovered: number;
  suppliers: DecisionPlanSupplierSnapshot[];
}

export interface DecisionOptimisationSnapshot {
  /** The cheapest single supplier who could take the whole order. */
  baseline: DecisionPlanSnapshot | null;
  /** The plan that was chosen. */
  optimised: DecisionPlanSnapshot;
  /** `baseline.total − optimised.total`. Null when there was no baseline. */
  savings: number | null;
  savingsPercent: number | null;
  suppliersUsed: number;
  alternatives: DecisionPlanSnapshot[];
  rejectedSuppliers: OptimisationResult['rejectedSuppliers'];
  unassigned: OptimisationResult['unassigned'];
  explanation: OptimisationResult['explanation'];
  diagnostics: OptimisationResult['diagnostics'];
}

/**
 * A purchase decision, whole.
 *
 * Deliberately self-contained: hand this document to somebody with no access
 * to the database and they can still check every figure in it.
 */
export interface PurchaseDecisionSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** When the comparison that produced this ran. */
  decidedAt: string;
  currency: string;
  request: DecisionRequestSnapshot;
  suppliers: DecisionSupplierSnapshot[];
  lines: DecisionLineSnapshot[];
  optimisation: DecisionOptimisationSnapshot;
  /** How the articles were matched, across the whole basket. */
  matching: {
    aiUsed: boolean;
    model: string | null;
    promptVersion: string | null;
    /** Lines an identifier or a specification settled without a model. */
    decidedDeterministically: number;
  };
  /** How long the comparison took, end to end. */
  durationMs: number;
}

// --- Building it -------------------------------------------------------------

/** Everything the builder needs that the optimiser result does not carry. */
export interface SnapshotContext {
  decidedAt: Date;
  durationMs: number;
  request: DecisionRequestSnapshot;
  suppliers: DecisionSupplierSnapshot[];
  /**
   * Price and match provenance, keyed `query shopId`.
   *
   * Supplied by the caller rather than looked up, because the caller already
   * holds it: the basket matched and priced every one of these moments ago.
   * Rebuilding it here would be the second optimiser run this feature exists
   * to avoid.
   */
  provenance: Map<string, LineProvenance>;
  matching: PurchaseDecisionSnapshot['matching'];
}

export interface LineProvenance {
  price: Omit<PriceProvenanceSnapshot, 'ageHours' | 'stale'>;
  match: MatchProvenanceSnapshot;
  listPrice: number | null;
  listCurrency: string | null;
  discountPercent: number;
  vatState: VatState;
}

/** The key under which one line's provenance is filed. */
export function provenanceKey(query: string, shopId: string): string {
  return `${query} ${shopId}`;
}

/**
 * Turns an optimiser result into the document that outlives it.
 *
 * Pure: everything it needs is already in hand, so this costs no request, no
 * model call and no second optimisation. That is a requirement rather than an
 * optimisation — a snapshot that re-derived its own inputs would be a
 * *different* decision from the one the buyer was shown, which defeats the
 * purpose of writing it down.
 *
 * Returns null when there is no plan. A decision to buy nothing is not a
 * purchase decision, and storing one would put a row with no savings into the
 * average.
 */
export function buildSnapshot(
  result: OptimisationResult,
  context: SnapshotContext,
): PurchaseDecisionSnapshot | null {
  if (!result.best) return null;

  const decidedAtMs = context.decidedAt.getTime();
  const nameOf = new Map(context.suppliers.map((supplier) => [supplier.shopId, supplier.name]));

  const lines: DecisionLineSnapshot[] = [];

  for (const supplier of result.best.suppliers) {
    for (const line of supplier.lines) {
      const provenance = context.provenance.get(provenanceKey(line.query, line.shopId));

      lines.push({
        query: line.query,
        quantity: line.quantity,
        shopId: line.shopId,
        supplierName: supplier.name,
        matchedName: line.matchedName,
        url: line.url,
        unitPrice: line.unitPrice,
        listPrice: provenance?.listPrice ?? null,
        listCurrency: provenance?.listCurrency ?? null,
        discountPercent: provenance?.discountPercent ?? 0,
        vatState: provenance?.vatState ?? VatState.Unknown,
        vatCertainty: line.vatCertainty,
        lineTotal: line.lineTotal,
        price: {
          source: line.priceSource,
          url: line.url,
          supplierId: line.shopId,
          supplierName: supplier.name,
          recordedAt: line.recordedAt,
          ...ageOf(line.recordedAt, line.priceSource, decidedAtMs),
        },
        match: provenance?.match ?? unknownMatch(line.confidence),
        warnings: line.warnings,
      });
    }
  }

  return {
    version: SNAPSHOT_VERSION,
    decidedAt: context.decidedAt.toISOString(),
    currency: result.currency,
    request: context.request,
    // Only suppliers that actually bear on the decision. A customer with forty
    // configured shops does not need thirty-eight sets of terms copied into
    // every snapshot to explain a two-supplier plan.
    suppliers: context.suppliers.filter(
      (supplier) => nameOf.has(supplier.shopId) && bearsOn(result, supplier.shopId),
    ),
    lines,
    optimisation: {
      baseline: result.baseline ? planSnapshot(result.baseline) : null,
      optimised: planSnapshot(result.best),
      savings: result.savings,
      savingsPercent: result.savingsPercent,
      suppliersUsed: result.best.suppliersUsed,
      alternatives: result.alternatives.map(planSnapshot),
      rejectedSuppliers: result.rejectedSuppliers,
      unassigned: result.unassigned,
      explanation: result.explanation,
      diagnostics: result.diagnostics,
    },
    matching: context.matching,
    durationMs: context.durationMs,
  };
}

/**
 * Whether a supplier had any part in this decision — chosen, beaten or refused.
 *
 * A supplier who appears nowhere in the plan, the baseline, an alternative or
 * the rejections had no bearing on the outcome, and their negotiated terms are
 * not evidence about it.
 */
function bearsOn(result: OptimisationResult, shopId: string): boolean {
  const inPlan = (plan: PurchasePlan | null): boolean =>
    Boolean(plan?.suppliers.some((supplier) => supplier.shopId === shopId));

  return (
    inPlan(result.best) ||
    inPlan(result.baseline) ||
    result.alternatives.some(inPlan) ||
    result.rejectedSuppliers.some((rejected) => rejected.shopId === shopId)
  );
}

function planSnapshot(plan: PurchasePlan): DecisionPlanSnapshot {
  return {
    kind: plan.kind,
    label: plan.label,
    suppliersUsed: plan.suppliersUsed,
    productSubtotal: plan.productSubtotal,
    shipping: plan.shipping,
    handlingFee: plan.handlingFee,
    total: plan.total,
    linesCovered: plan.linesCovered,
    suppliers: plan.suppliers.map(supplierSnapshot),
  };
}

function supplierSnapshot(supplier: AllocationSupplier): DecisionPlanSupplierSnapshot {
  return {
    shopId: supplier.shopId,
    name: supplier.name,
    linesCovered: supplier.linesCovered,
    productSubtotal: supplier.productSubtotal,
    shipping: supplier.shipping,
    shippingWaived: supplier.shippingWaived,
    handlingFee: supplier.handlingFee,
    total: supplier.total,
    minOrderValue: supplier.minOrderValue,
    meetsMinimumOrder: supplier.meetsMinimumOrder,
    warnings: supplier.warnings,
  };
}

/**
 * How old a price already was when it was used.
 *
 * A live read is current by definition and carries no age, even though it has
 * no `recordedAt` — reporting "unknown age" for the freshest figure in the set
 * would be exactly backwards.
 */
function ageOf(
  recordedAt: string | null,
  source: 'live' | 'cached' | 'manual',
  decidedAtMs: number,
): { ageHours: number | null; stale: boolean } {
  if (source === 'live') return { ageHours: 0, stale: false };
  if (!recordedAt) return { ageHours: null, stale: true };

  const recorded = Date.parse(recordedAt);
  if (!Number.isFinite(recorded)) return { ageHours: null, stale: true };

  return {
    ageHours: round(Math.max(0, decidedAtMs - recorded) / 3_600_000),
    stale: true,
  };
}

/**
 * Provenance for a line the caller did not file any for.
 *
 * Should not happen from the basket, which files every line it matched. Kept
 * honest rather than defensive: the confidence is real because the optimiser
 * carried it, and everything else says plainly that it is not known, instead
 * of inventing a method the matcher never used.
 */
function unknownMatch(confidence: number): MatchProvenanceSnapshot {
  return {
    method: 'none',
    confidence,
    band: 'weak',
    explanation: '',
    attributes: [],
    aiUsed: false,
    model: null,
    promptVersion: null,
    manualOverride: null,
  };
}
