import { DEFAULT_THRESHOLDS } from '../matching/deterministic-matcher';
import { MatchResult } from '../matching/matching.service';

/**
 * The line between what a supplier returned and what a buyer may be quoted.
 *
 * A supplier's search page is a retrieval mechanism, not a source of truth.
 * eMAG answers a model number it does not stock with a shelf of
 * recommendations — a Nissan stabiliser bar, a Febest fuse, a tablet — all
 * carrying real prices and real product URLs. Nothing about a row's *shape*
 * distinguishes that from a genuine offer, so the distinction has to be made
 * on the verdict, once, on the server.
 *
 * This is that decision, extracted from the search so it can be tested
 * without a database, a supplier or a network.
 */

/** Below this, an offer is not treated as a quote for the line. */
export const ACCEPT_FLOOR = DEFAULT_THRESHOLDS.floor;

/**
 * At or above this, and the same article: the buyer asked for this and this
 * is it. Below it, a listing may still be worth showing — but never as the
 * answer, and never counted among the matches.
 */
export const MATCH_CONFIDENCE = 0.85;

/** What a search concluded, before anything is rendered. */
export type SearchStatus = 'MATCH' | 'ALTERNATIVE' | 'NO_MATCH';

/** The least a row must carry to be judged. */
export interface Judgeable {
  match?: Pick<MatchResult, 'relation' | 'confidence'>;
}

export interface Partition<T> {
  status: SearchStatus;
  /** The article the buyer asked for. */
  matches: T[];
  /** Genuinely related and not what was asked for. */
  alternatives: T[];
  /** Retrieval. Kept for the trace, never shown as an offer. */
  rejected: T[];
}

/**
 * Sorts scored rows into what may be shown and what may not.
 *
 * Two rules and no third:
 *
 *  * A row is **accepted** when the matcher stands behind it — above the
 *    floor, with nothing stated against it. `unrelated` and `conflict` are
 *    both refusals and neither is a low score to be rounded up.
 *  * An accepted row is a **match** only when it is the same article and the
 *    confidence says so. Everything else accepted is an alternative, which is
 *    a different answer to a different question and is labelled as one.
 *
 * A row with no verdict at all is rejected. Absence of judgement is not
 * permission — that was the old behaviour and it is what put eight car parts
 * under a heading saying nothing matched.
 */
export function partitionByVerdict<T extends Judgeable>(scored: T[]): Partition<T> {
  const matches: T[] = [];
  const alternatives: T[] = [];
  const rejected: T[] = [];

  for (const row of scored) {
    const verdict = row.match;

    const accepted =
      verdict !== undefined &&
      verdict.confidence >= ACCEPT_FLOOR &&
      verdict.relation !== 'conflict' &&
      verdict.relation !== 'unrelated';

    if (!accepted) {
      rejected.push(row);
      continue;
    }

    if (verdict.relation === 'same_product' && verdict.confidence >= MATCH_CONFIDENCE) {
      matches.push(row);
      continue;
    }

    // An alternative has to be *related*, not merely unrefuted.
    //
    // `same_family` and `compatible` are reached by evidence — a shared model
    // code, a stated fitment — so a listing carrying either is genuinely the
    // neighbouring article: the XPA12-65 where the 75 was asked for. `possible`
    // and `same_type` are reached by overlapping vocabulary, which is not
    // evidence about an article at all, and letting those through is how a
    // screen protector became a substitute for a polishing machine.
    if (verdict.relation === 'same_family' || verdict.relation === 'compatible') {
      alternatives.push(row);
      continue;
    }

    if (verdict.relation === 'same_product') {
      // The same article, stated less certainly than the match line demands.
      alternatives.push(row);
      continue;
    }

    rejected.push(row);
  }

  const status: SearchStatus =
    matches.length > 0 ? 'MATCH' : alternatives.length > 0 ? 'ALTERNATIVE' : 'NO_MATCH';

  return { status, matches, alternatives, rejected };
}

/** The least a row must carry to be priced. */
export interface Priceable {
  effectivePrice: number | null;
  /** False only where the shop stated it. Null means it said nothing. */
  inStock?: boolean | null;
  match?: Pick<MatchResult, 'relation' | 'confidence'>;
}

/**
 * The cheapest offer for the article the buyer asked for.
 *
 * Chosen from the matches and from nothing else, which is the whole point.
 * Price ranking used to run across every scored row, so the cheapest thing a
 * supplier's search happened to return took the crown — an 8.94 € screen
 * protector beating the 114.99 € machine the buyer was actually looking for.
 * A cheaper price on a different article is not a saving, and the arithmetic
 * has no way to know that: it has to be handed only comparable things.
 *
 * Alternatives are excluded on purpose. A neighbouring model may well be
 * cheaper and it is still not what was asked for, so it is offered as its own
 * answer rather than quietly winning this one.
 */
export function bestOffer<T extends Priceable>(matches: T[]): T | null {
  /*
   * The cheapest one you can actually buy.
   *
   * A sold-out listing keeps its price on the page long after the shelf is
   * empty, and it is frequently the lowest number on the screen — a shop
   * clears stock at a discount and then leaves the row up. Crowning it sends
   * the buyer to a supplier who cannot supply them, which is a worse outcome
   * than showing them the second-cheapest, and it is the kind of wrong answer
   * that costs trust in every other number on the page.
   *
   * So availability is a filter before price is a comparison. Only a stated
   * refusal counts: a shop that says nothing about stock is not treated as
   * empty, because most shops label only what they have run out of. If every
   * match is sold out, the cheapest of those is still returned — "everyone is
   * out of it, here is where it was cheapest" is a real answer, and the row
   * carries its own `inStock: false` for the interface to say so.
   */
  const pick = (rows: T[]): T | null => {
    let best: T | null = null;

    for (const row of rows) {
      if (row.effectivePrice === null) continue;
      if (best === null || row.effectivePrice < best.effectivePrice!) best = row;
    }

    return best;
  };

  return pick(matches.filter((row) => row.inStock !== false)) ?? pick(matches);
}
