import {
  AttributeComparison,
  ProductAttributes,
  compareAttributes,
  extractAttributes,
} from './attributes';
import { containsAllTokens, sameIdentifier, similarity } from './normalisation';

/** How a verdict was reached, strongest evidence first. */
export type MatchMethod =
  'gtin' | 'sku' | 'model' | 'attributes' | 'text' | 'ai' | 'conflict' | 'none';

/** One line of the explanation shown to a buyer. */
export interface MatchReason {
  label: string;
  left: string;
  right: string;
  agrees: boolean;
}

export interface MatchVerdict {
  /** 0–1. Never a guess dressed as certainty: see {@link MatchMethod}. */
  confidence: number;
  method: MatchMethod;
  reasons: MatchReason[];
  /**
   * True when the two sides state the same identifying attribute differently.
   *
   * A blocked pair is not a match at any confidence and is never sent to a
   * model — 128 GB against 256 GB needs no second opinion, and asking for one
   * spends money to be told what arithmetic already knew.
   */
  blocked: boolean;
  /**
   * True when the deterministic evidence is real but incomplete, so a model
   * could decide something arithmetic cannot — that Philips's "840" means
   * 4000 K, or that "неутрална светлина" is the same as "neutral white".
   */
  needsAi: boolean;
}

export interface MatchThresholds {
  /** At or above this, treat as the same article without asking a model. */
  certain: number;
  /** Below this, do not present as a match at all. */
  floor: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = { certain: 0.9, floor: 0.7 };

/**
 * The cheap half of the matcher.
 *
 * Runs a ladder from strongest evidence to weakest and stops at the first rung
 * that answers. Most pairs never reach the bottom, which is the point: a model
 * call per candidate per search would cost more than the subscription and add
 * a second of latency to answer a question a barcode already answered.
 */
export function matchDeterministically(
  query: ProductAttributes,
  candidate: ProductAttributes,
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchVerdict {
  const comparisons = compareAttributes(query, candidate);
  const conflicts = comparisons.filter((entry) => entry.identifying && !entry.agrees);
  const agreements = comparisons.filter((entry) => entry.agrees);

  // --- Rung 1: barcode ----------------------------------------------------
  //
  // Ahead of the conflict check, and only just: a barcode is issued per
  // variant, so the 128 GB and the 256 GB phone carry different ones and a
  // shared barcode cannot mean two variants. Everything the conflict check
  // reads is inferred from words, and inference loses to an identifier —
  // "Philips" against "CorePro" looks like two brands and is one product line.
  const sharedGtin = query.gtins.find((gtin) => candidate.gtins.includes(gtin));
  if (sharedGtin) {
    return {
      confidence: 1,
      method: 'gtin',
      reasons: [
        { label: 'Баркод', left: sharedGtin, right: sharedGtin, agrees: true },
        ...toReasons(agreements),
      ],
      blocked: false,
      needsAi: false,
    };
  }

  // --- Rung 2: the supplier's own article number --------------------------
  if (sameIdentifier(query.specs.sku, candidate.specs.sku)) {
    return {
      confidence: 0.99,
      method: 'sku',
      reasons: [
        {
          label: 'Артикулен номер',
          left: query.specs.sku,
          right: candidate.specs.sku,
          agrees: true,
        },
        ...toReasons(agreements),
      ],
      blocked: false,
      needsAi: false,
    };
  }

  // --- Rung 3: a stated difference in something identifying ---------------
  //
  // Below the identifiers and above everything else. A model code is shared
  // across a family — the 128 GB and 256 GB phone often carry the same one —
  // so where the names state different capacities, the names win.
  if (conflicts.length > 0) {
    return {
      confidence: 0,
      method: 'conflict',
      reasons: toReasons(comparisons),
      blocked: true,
      needsAi: false,
    };
  }

  // --- Rung 4: a shared model code ----------------------------------------
  const sharedModel = query.modelCodes.find((code) => candidate.modelCodes.includes(code));
  if (sharedModel) {
    return {
      confidence: 0.95,
      method: 'model',
      reasons: [
        { label: 'Модел', left: sharedModel, right: sharedModel, agrees: true },
        ...toReasons(agreements),
      ],
      blocked: false,
      needsAi: false,
    };
  }

  // --- Rung 5: every identifying attribute both sides state agrees ---------
  //
  // Two agreeing specifications plus a matching brand is how a wholesale
  // catalogue identifies an article in practice — a 12 W E27 Philips is a
  // 12 W E27 Philips whatever marketing name each supplier prints.
  const identifyingAgreements = agreements.filter(
    (entry) => entry.identifying && entry.key !== 'brand' && entry.key !== 'category',
  );
  const brandAgrees = agreements.some((entry) => entry.key === 'brand');
  const categoryAgrees = agreements.some((entry) => entry.key === 'category');
  const text = similarity(query.raw, candidate.raw);

  // A matching brand is the strongest supporting evidence, but demanding it
  // rejects the ordinary case: buyers type "LED крушка 12W E27 4000K" without
  // naming a manufacturer, and plenty of shops do not print one either. Where
  // the brand is simply absent — as opposed to different, which is a conflict
  // and was rejected above — an agreeing category carries the same weight.
  if (identifyingAgreements.length >= 2 && (brandAgrees || categoryAgrees)) {
    return {
      // A named brand on both sides is worth more than a shared category:
      // two 12W E27 bulbs from different makers are interchangeable, but two
      // from the *same* maker are the same article.
      confidence: Math.min(0.94, (brandAgrees ? 0.86 : 0.84) + 0.02 * identifyingAgreements.length),
      method: 'attributes',
      reasons: toReasons(comparisons),
      blocked: false,
      // Already above the certainty line: another opinion cannot change the
      // decision, so buying one is waste.
      needsAi: false,
    };
  }

  // --- Rung 6: a question with nothing to match on ------------------------
  //
  // "лампа" states no brand, no measurement, no code. There is nothing to
  // compare specifications against, and demanding them would answer "nothing
  // matches" to a question with thousands of answers. So the answer is as
  // precise as the question: does the listing carry the words, or not.
  const queryIsBare =
    query.measurements.length === 0 &&
    Object.keys(query.specs).length === 0 &&
    query.modelCodes.length === 0 &&
    !query.brand;

  if (queryIsBare) {
    const contains = containsAllTokens(candidate.raw, query.raw);

    return {
      confidence: contains ? 0.75 : Math.min(0.4, text),
      method: 'text',
      reasons: toReasons(comparisons),
      blocked: false,
      // A model cannot make a vague question precise, and paying it to confirm
      // that a lamp is a lamp is the definition of waste.
      needsAi: false,
    };
  }

  // --- Rung 7: partial evidence -------------------------------------------
  //
  // Text similarity alone badly understates two common cases, and both are the
  // ones this product exists for. A German listing — "LED Lampe 12W E27
  // neutralweiss" — shares almost no words with a Bulgarian query and every
  // specification. A listing that names the brand and nothing else — "Philips
  // CorePro 840 неутрална" — shares one word and may well be the same bulb.
  //
  // So agreement on things that identify counts for more than overlapping
  // vocabulary, and either kind of evidence is enough to be worth a second
  // opinion.
  const evidence = identifyingAgreements.length + (brandAgrees ? 1 : 0);
  const fromEvidence = evidence > 0 ? 0.4 + 0.12 * evidence : 0;
  const provisional = Math.min(0.84, Math.max(text, fromEvidence));

  return {
    confidence: provisional,
    method: 'text',
    reasons: toReasons(comparisons),
    blocked: false,
    // Worth a model only where something real is unresolved. With no agreeing
    // attribute and no shared vocabulary there is nothing to resolve, and the
    // shop's search engine was simply being generous.
    needsAi: provisional >= 0.35 && provisional < thresholds.certain,
  };
}

function toReasons(comparisons: AttributeComparison[]): MatchReason[] {
  return comparisons.map((entry) => ({
    label: entry.label,
    left: entry.left,
    right: entry.right,
    agrees: entry.agrees,
  }));
}

/** Convenience for callers holding raw strings rather than extractions. */
export function matchNames(
  query: string,
  candidate: string,
  thresholds?: MatchThresholds,
): MatchVerdict {
  return matchDeterministically(extractAttributes(query), extractAttributes(candidate), thresholds);
}

/** The band a confidence falls in, as the interface labels it. */
export function confidenceBand(confidence: number): 'certain' | 'high' | 'possible' | 'weak' {
  if (confidence >= 0.95) return 'certain';
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.7) return 'possible';
  return 'weak';
}
