import { displayLabel } from './lexicon';
import { GenericProduct } from './product-model';
import { InterpretOptions, interpret } from './interpretation';
import {
  AttributeComparison,
  DEFAULT_RELATION_THRESHOLDS,
  MatchMethod,
  RelationThresholds,
  RelationVerdict,
  relate,
} from './relate';

export type { MatchMethod } from './relate';
export type { AttributeComparison } from './relate';

/**
 * The cheap half of the matcher, and the shape the rest of the system reads.
 *
 * The reasoning moved to {@link relate}, which knows about dimensions and
 * concepts and nothing about industries. What stays here is the contract every
 * caller was already written against — a confidence, a method, a list of
 * reasons a buyer can check — plus the two things the new engine adds: what
 * relation the two listings stand in, and which attributes were missing rather
 * than contradicted.
 */

/** One line of the explanation shown to a buyer. */
export interface MatchReason {
  label: string;
  left: string;
  right: string;
  agrees: boolean;
  /**
   * Why it agrees or does not.
   *
   * `agrees` alone cannot tell a buyer whether the supplier disagreed about
   * the capacity or simply never mentioned it, and those are the two halves of
   * every purchasing decision this tool is asked to support.
   */
  status?: 'match' | 'missing' | 'conflict';
}

export interface MatchVerdict {
  /** 0–1. Never a guess dressed as certainty: see {@link MatchMethod}. */
  confidence: number;
  method: MatchMethod;
  /** How the two listings stand to each other, in more than a boolean. */
  relation: RelationVerdict['relation'];
  reasons: MatchReason[];
  /** Attributes both sides state and agree on. */
  matchedAttributes: AttributeComparison[];
  /** Attributes one side states and the other is silent about. */
  missingAttributes: AttributeComparison[];
  /** Attributes both sides state differently. */
  conflicts: AttributeComparison[];
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

export type MatchThresholds = RelationThresholds;

export const DEFAULT_THRESHOLDS: MatchThresholds = DEFAULT_RELATION_THRESHOLDS;

/**
 * Compares two interpretations.
 *
 * A thin adapter now: it runs the generic engine and dresses the answer in the
 * shape the ranking, the basket and the front end already expect.
 */
export function matchDeterministically(
  query: GenericProduct,
  candidate: GenericProduct,
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchVerdict {
  const verdict = relate(query, candidate, thresholds);

  return {
    confidence: verdict.confidence,
    method: verdict.method,
    relation: verdict.relation,
    // Conflicts first, then agreements, then silences. A buyer scanning the
    // explanation needs the disqualifying line at the top, not buried under
    // six things that happened to agree.
    reasons: [
      ...verdict.conflicts.map(toReason),
      ...verdict.matched.map(toReason),
      ...verdict.missing.map(toReason),
    ],
    matchedAttributes: verdict.matched,
    missingAttributes: verdict.missing,
    conflicts: verdict.conflicts,
    blocked: verdict.blocked,
    needsAi: verdict.needsAi,
  };
}

function toReason(comparison: AttributeComparison): MatchReason {
  return {
    label: displayLabel(comparison.key, comparison.label),
    left: comparison.query ?? '—',
    right: comparison.candidate ?? '—',
    agrees: comparison.status === 'match',
    status: comparison.status,
  };
}

/** Convenience for callers holding raw strings rather than interpretations. */
export function matchNames(
  query: string,
  candidate: string,
  thresholds?: MatchThresholds,
  options?: InterpretOptions,
): MatchVerdict {
  return matchDeterministically(interpret(query), interpret(candidate, options), thresholds);
}

/** The band a confidence falls in, as the interface labels it. */
export function confidenceBand(confidence: number): 'certain' | 'high' | 'possible' | 'weak' {
  if (confidence >= 0.95) return 'certain';
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.7) return 'possible';
  return 'weak';
}
