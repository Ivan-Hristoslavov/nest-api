import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { User, effectiveAiUsage } from '../billing/entities/user.entity';
import { suggestCorrection } from './attributes';
import { displayLabel } from './lexicon';
import { ClaudeService, PROMPT_VERSION } from './claude.service';
import {
  AttributeComparison,
  DEFAULT_THRESHOLDS,
  MatchMethod,
  MatchReason,
  MatchVerdict,
  confidenceBand,
  matchDeterministically,
} from './deterministic-matcher';
import { MatchCache } from './entities/match-cache.entity';
import { interpret } from './interpretation';
import { GenericProduct, ProductRelation, attributeMap, relationGroup } from './product-model';
import { normaliseProductName } from './normalisation';
import { ScoreBreakdown, explainScore } from './scoring';
import { formatQuantity } from './units';

/** A supplier listing put forward for comparison. */
export interface MatchCandidate {
  id: string;
  name: string;
  supplier: string;
  sku?: string | null;
  /**
   * Anything else the shop published about this listing.
   *
   * A title is what a search page gives up, and it is often the least of what
   * a shop knows. Where a description, a spec table or a product URL is to
   * hand, passing it here is free accuracy: the same extraction runs over it
   * and fills in attributes the title left out.
   */
  context?: string | null;
  structured?: Record<string, string> | null;
}

/** What the caller gets back for one candidate. */
export interface MatchResult {
  id: string;
  confidence: number;
  band: ReturnType<typeof confidenceBand>;
  method: MatchMethod;
  /**
   * How this listing stands to the query, in more than a boolean.
   *
   * A buyer choosing a supplier needs the difference between "the same thing",
   * "the same thing in another size" and "a part made to fit it". Collapsing
   * those into one number was the old model, and it is why the interface could
   * only ever show a percentage.
   */
  relation: ProductRelation;
  /** Which pile this belongs in when results are shown. */
  group: ReturnType<typeof relationGroup>;
  /** Attribute-by-attribute, so a buyer can check the machine's work. */
  reasons: MatchReason[];
  /** Attributes both sides state and agree on. */
  matchedAttributes: AttributeComparison[];
  /** Attributes one side states and the other does not — doubt, not refusal. */
  missingAttributes: AttributeComparison[];
  /** Attributes both sides state differently. */
  conflicts: AttributeComparison[];
  /**
   * What this listing itself states, as the engine read it.
   *
   * Carried so a client can filter on the attributes the results actually
   * have — the dynamic filters of section 21 — without asking the server a
   * second question or guessing from the title. Identity and variant only:
   * a weight nobody chooses on is payload for nothing.
   */
  attributes: Record<string, string>;
  /**
   * The verdict taken apart, so a buyer can check the machine's work.
   *
   * Derived from the same comparisons the verdict was reached on — one
   * decision presented two ways, never a second opinion that could disagree
   * with the first in front of a customer.
   */
  breakdown: ScoreBreakdown;
  /** One clause naming what decided it. */
  explanation: string;
}

export interface MatchRunSummary {
  /** What the query was understood to be, before any model was involved. */
  understood: Understanding;
  results: MatchResult[];
  candidates: number;
  /** Pairs answered by barcode, article number, model code or specification. */
  decidedDeterministically: number;
  aiCallsMade: number;
  aiCacheHits: number;
  aiModel: string | null;
  aiSkippedReason: 'disabled' | 'quota' | 'unreachable' | null;
  /**
   * Where this account's monthly allowance stands, including this search.
   *
   * On the summary rather than behind a separate call, because the honest
   * moment to say "this cost one of your comparisons" is the response that
   * spent it — not a settings page someone reads at the end of the month.
   */
  aiQuota: { used: number; limit: number; renews: boolean } | null;
  /**
   * Filters worth offering, taken from the candidates this search actually
   * found rather than from a list somebody wrote in advance.
   *
   * Search a laptop and you get memory, storage and screen. Search a pipe and
   * you get diameter, length and material. Nobody declared either set: they are
   * whatever the listings on the page turned out to state, which is the only
   * definition of "relevant filter" that survives contact with a new industry.
   */
  facets: SearchFacet[];
  durationMs: number;
}

/** One filter, and the values the current results offer for it. */
export interface SearchFacet {
  key: string;
  label: string;
  role: string;
  values: Array<{ value: string; count: number }>;
}

/**
 * What a query was taken to mean.
 *
 * The first four fields are what this returned before there was a generic
 * engine, kept to the letter so that a client written against the old contract
 * keeps working — `category` now carries the product type, which is what it
 * always meant. Everything after them is what the engine can now say and could
 * not before: the attributes it found, whatever they turned out to be, with no
 * list of categories anywhere in the answer.
 */
export interface Understanding {
  brand: string | null;
  category: string | null;
  specs: Record<string, string>;
  measurements: Array<{ value: number; unit: string }>;
  /** A likely typo in a brand name, or null. The search still runs as typed. */
  didYouMean: string | null;

  /** What kind of thing this is, in the buyer's own words. */
  productType: string | null;
  /** The dynamic attribute map: whatever the query turned out to state. */
  attributes: ReturnType<typeof attributeMap>;
  identifiers: GenericProduct['identifiers'];
  /** How many the buyer wants, which is never part of what the article is. */
  requestedQuantity: number | null;
}

/**
 * The whole pipeline, in the order that spends the least.
 *
 * Understand the query → extract attributes → rule out what cannot match →
 * decide what arithmetic can decide → ask a model only about the remainder →
 * rank. Every step before the model exists to make the model's share smaller:
 * on a catalogue with barcodes, almost nothing reaches it.
 */
@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    private readonly claude: ClaudeService,
    @InjectRepository(MatchCache) private readonly cache: Repository<MatchCache>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /**
   * What the buyer's words mean, worked out without a model.
   *
   * "philips led 12w e27 4000k" is not ambiguous — it is dense. Brand, power,
   * socket and colour temperature are all extractable by rule, and paying a
   * model to read them would be paying for a regular expression.
   */
  understand(query: string): Understanding {
    return understandingOf(interpret(query), suggestCorrection(query));
  }

  async match(
    ownerId: string | null,
    query: string,
    candidates: MatchCandidate[],
    options: { useAi?: boolean; maxAiCandidates?: number } = {},
  ): Promise<MatchRunSummary> {
    const startedAt = Date.now();
    const queryProduct = interpret(query);

    // Read once and kept: the interpretation is what the model is later shown,
    // and extracting a candidate twice would be the same regular expressions
    // run again for an answer already in hand.
    const interpreted = new Map<string, GenericProduct>(
      candidates.map((candidate) => [
        candidate.id,
        interpret(candidate.name, {
          sku: candidate.sku,
          context: candidate.context,
          structured: candidate.structured,
        }),
      ]),
    );

    const verdicts = new Map<string, MatchVerdict>();
    for (const candidate of candidates) {
      verdicts.set(
        candidate.id,
        matchDeterministically(queryProduct, interpreted.get(candidate.id)!),
      );
    }

    const decidedDeterministically = [...verdicts.values()].filter(
      (verdict) => !verdict.needsAi,
    ).length;

    // Only the genuinely undecided reach a model, and only the strongest of
    // those: a shop's search engine answers "СВТ" with forty things, and
    // paying to be told that a picture light is not a cable is waste.
    const ambiguous = candidates
      .filter((candidate) => verdicts.get(candidate.id)?.needsAi)
      .sort((a, b) => (verdicts.get(b.id)?.confidence ?? 0) - (verdicts.get(a.id)?.confidence ?? 0))
      .slice(0, options.maxAiCandidates ?? 12);

    let aiCacheHits = 0;
    let aiCallsMade = 0;
    let skipped: MatchRunSummary['aiSkippedReason'] = null;

    if (options.useAi !== false && ambiguous.length > 0) {
      const outcome = await this.resolveWithAi(
        ownerId,
        query,
        queryProduct,
        ambiguous,
        verdicts,
        interpreted,
      );
      aiCacheHits = outcome.cacheHits;
      aiCallsMade = outcome.callsMade;
      skipped = outcome.skipped;
    } else if (ambiguous.length > 0) {
      skipped = 'disabled';
    }

    // Read after the AI resolution, so the figure already includes whatever
    // this very search just spent — and read *only* when this search had
    // anything to do with the allowance.
    //
    // It used to be read on every match, which put a database round trip on
    // the hot path of a search that had already been settled by arithmetic:
    // a hundred milliseconds to report a number nobody had spent. The meter is
    // shown exactly when it moved, so it is fetched exactly then too.
    const touchedAllowance = aiCallsMade > 0 || aiCacheHits > 0 || skipped === 'quota';

    let aiQuota: MatchRunSummary['aiQuota'] = null;
    if (ownerId && touchedAllowance) {
      const owner = await this.users.findOne({ where: { id: ownerId } });
      if (owner) aiQuota = effectiveAiUsage(owner);
    }

    const summary: MatchRunSummary = {
      understood: understandingOf(queryProduct, suggestCorrection(query)),
      results: candidates.map((candidate) =>
        this.present(candidate, verdicts.get(candidate.id)!, interpreted.get(candidate.id)),
      ),
      candidates: candidates.length,
      decidedDeterministically,
      aiCallsMade,
      aiCacheHits,
      aiModel: this.claude.activeModel,
      aiSkippedReason: skipped,
      aiQuota,
      facets: facetsOf(candidates, interpreted, verdicts),
      durationMs: Date.now() - startedAt,
    };

    // Without the confidence, the line says what a search cost and not what it
    // was worth — and "the matcher got vaguer last week" is exactly the kind of
    // drift that is invisible until a customer reports a wrong order.
    const topConfidence = summary.results.reduce(
      (best, result) => Math.max(best, result.confidence),
      0,
    );
    const confidentCount = summary.results.filter(
      (result) => result.confidence >= DEFAULT_THRESHOLDS.floor,
    ).length;

    // One structured line per search: enough to answer "why was this match
    // made" and "what did this search cost" months later, with no product
    // names from other accounts and no customer identifiers in the message.
    this.logger.log(
      `match query="${normaliseProductName(query)}" candidates=${summary.candidates} ` +
        `deterministic=${summary.decidedDeterministically} ai_calls=${aiCallsMade} ` +
        `ai_cache_hits=${aiCacheHits} model=${summary.aiModel ?? 'none'} ` +
        `skipped=${skipped ?? 'no'} top_confidence=${topConfidence.toFixed(2)} ` +
        `confident=${confidentCount} ms=${summary.durationMs}`,
    );

    return summary;
  }

  /**
   * Fills in the undecided pairs from the cache, then from a model.
   *
   * Mutates `verdicts` in place — the caller holds one map for every candidate
   * and this only ever improves entries in it.
   */
  private async resolveWithAi(
    ownerId: string | null,
    query: string,
    queryProduct: GenericProduct,
    ambiguous: MatchCandidate[],
    verdicts: Map<string, MatchVerdict>,
    interpreted: Map<string, GenericProduct>,
  ): Promise<{
    cacheHits: number;
    callsMade: number;
    skipped: MatchRunSummary['aiSkippedReason'];
  }> {
    if (!this.claude.enabled) return { cacheHits: 0, callsMade: 0, skipped: 'disabled' };

    const model = this.claude.activeModel ?? 'pending';
    const fingerprints = new Map<string, string>();

    for (const candidate of ambiguous) {
      fingerprints.set(candidate.id, fingerprint(queryProduct.normalised, candidate.name, model));
    }

    const cached = await this.cache.find({
      where: { fingerprint: In([...fingerprints.values()]) },
    });
    const byFingerprint = new Map(cached.map((row) => [row.fingerprint.trim(), row]));

    let cacheHits = 0;
    const unanswered: MatchCandidate[] = [];

    for (const candidate of ambiguous) {
      const row = byFingerprint.get(fingerprints.get(candidate.id)!);

      if (row) {
        cacheHits += 1;
        this.applyAiVerdict(
          verdicts,
          candidate.id,
          row.isSame ? 'same_product' : 'possible',
          row.confidence,
          row.reason,
        );
        continue;
      }

      unanswered.push(candidate);
    }

    if (unanswered.length === 0) return { cacheHits, callsMade: 0, skipped: null };

    // The allowance is checked before the call, not after: a customer who has
    // run out keeps searching on deterministic evidence rather than being
    // stopped, and never sees a charge they did not agree to.
    const allowance = await this.claimAllowance(ownerId, unanswered.length);
    if (allowance === 0) return { cacheHits, callsMade: 0, skipped: 'quota' };

    // The model is given the structured reading, not two strings. It is being
    // asked the residual question — does "840" mean 4000 K, is "neutralweiss"
    // the same as neutral white — and it cannot answer that from the text
    // alone when the text is exactly what the deterministic pass could not
    // settle. What agreed, what is missing and what clashed all travel with it.
    const outcome = await this.claude.matchCandidates({
      query,
      queryAttributes: describe(queryProduct),
      candidates: unanswered.slice(0, allowance).map((candidate) => {
        const verdict = verdicts.get(candidate.id);

        return {
          id: candidate.id,
          name: candidate.name,
          supplier: candidate.supplier,
          attributes: describe(interpreted.get(candidate.id)!),
          matched: (verdict?.matchedAttributes ?? []).map(summarise),
          missing: (verdict?.missingAttributes ?? []).map(summarise),
          conflicts: (verdict?.conflicts ?? []).map(summarise),
        };
      }),
    });

    if (!outcome) return { cacheHits, callsMade: 0, skipped: 'unreachable' };

    for (const verdict of outcome.verdicts) {
      if (!verdicts.has(verdict.id)) continue;

      this.applyAiVerdict(
        verdicts,
        verdict.id,
        verdict.relation,
        verdict.confidence,
        verdict.reason,
      );

      // Written under the model that answered, so a later model version asks
      // again rather than inheriting an answer it did not give.
      await this.cache
        .upsert(
          {
            fingerprint: fingerprint(
              queryProduct.normalised,
              unanswered.find((candidate) => candidate.id === verdict.id)?.name ?? '',
              outcome.model,
            ),
            isSame: verdict.relation === 'same_product',
            confidence: verdict.confidence,
            reason: verdict.reason,
            model: outcome.model,
          },
          ['fingerprint'],
        )
        .catch((error: unknown) => {
          this.logger.warn(
            `Could not cache an AI verdict: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    this.logger.debug(
      `AI matched ${outcome.verdicts.length} candidates in ${outcome.latencyMs}ms ` +
        `(${outcome.inputTokens} in / ${outcome.outputTokens} out, ${outcome.model})`,
    );

    return { cacheHits, callsMade: 1, skipped: null };
  }

  /**
   * Folds a model's opinion into a deterministic verdict.
   *
   * A model may raise confidence but never past 0.94: the bands above that are
   * reserved for a barcode, an article number or agreeing specifications —
   * things that can be checked. It may also lower confidence, and a blocked
   * pair stays blocked whatever it says, because a stated 128 GB against a
   * stated 256 GB is not a matter of opinion.
   */
  private applyAiVerdict(
    verdicts: Map<string, MatchVerdict>,
    id: string,
    relation: ProductRelation,
    confidence: number,
    reason: string,
  ): void {
    const current = verdicts.get(id);
    if (!current || current.blocked) return;

    const positive = relation === 'same_product' || relation === 'compatible';

    const reasons = reason
      ? [...current.reasons, { label: 'AI', left: reason, right: '', agrees: positive }]
      : current.reasons;

    verdicts.set(id, {
      ...current,
      method: 'ai',
      // The model may name a relation the arithmetic could not — that two
      // listings are one family, or that a part is made to fit — but it may
      // never overturn a conflict, which is checked above.
      relation: relation === 'possible' ? current.relation : relation,
      reasons,
      confidence: positive
        ? Math.min(0.94, Math.max(current.confidence, confidence))
        : Math.min(current.confidence, relation === 'same_family' ? 0.6 : 0.5),
    });
  }

  /**
   * Takes from this account's monthly AI allowance.
   *
   * @returns how many comparisons may be spent — possibly fewer than asked
   * for, and zero when the allowance is gone. An anonymous or operator caller
   * has no row to meter and is not metered.
   */
  private async claimAllowance(ownerId: string | null, wanted: number): Promise<number> {
    if (!ownerId) return wanted;

    const user = await this.users.findOne({ where: { id: ownerId } });
    if (!user) return wanted;

    const now = new Date();
    const { used, limit, renews } = effectiveAiUsage(user, now);

    // A period that has rolled over is one where the stored counter is higher
    // than what now counts as spent.
    const periodRolledOver = renews && (used < user.aiMatchesUsed || !user.aiPeriodStartedAt);
    const remaining = Math.max(0, limit - used);
    const granted = Math.min(wanted, remaining);

    if (granted === 0) {
      this.logger.log(
        `Account ${ownerId} has spent its ${limit} AI comparisons for this period; searching continues without AI.`,
      );
      return 0;
    }

    await this.users.update(
      { id: user.id },
      {
        aiMatchesUsed: used + granted,
        aiPeriodStartedAt: periodRolledOver ? now : (user.aiPeriodStartedAt ?? now),
      },
    );

    return granted;
  }

  private present(
    candidate: MatchCandidate,
    verdict: MatchVerdict,
    product?: GenericProduct,
  ): MatchResult {
    const confidence = Math.round(verdict.confidence * 100) / 100;

    const attributes: Record<string, string> = {};
    for (const attribute of product?.attributes ?? []) {
      if (attribute.role !== 'identity' && attribute.role !== 'variant') continue;
      if (attributes[attribute.key]) continue;
      attributes[attribute.key] = attribute.quantity
        ? formatQuantity(attribute.quantity)
        : attribute.value;
    }

    return {
      id: candidate.id,
      confidence,
      band: confidenceBand(verdict.confidence),
      method: verdict.method,
      relation: verdict.relation,
      group: relationGroup(verdict.relation, confidence),
      reasons: verdict.reasons,
      matchedAttributes: verdict.matchedAttributes,
      missingAttributes: verdict.missingAttributes,
      conflicts: verdict.conflicts,
      attributes,
      breakdown: explainScore(verdict),
      explanation: explain(verdict),
    };
  }
}

/**
 * The cache key.
 *
 * Built from the *normalised* pair, so "12 watt" and "12W" are one question
 * rather than two, and from the model plus prompt version, so a change to
 * either asks again instead of inheriting an answer it never gave.
 */
export function fingerprint(normalisedQuery: string, candidateName: string, model: string): string {
  return createHash('sha256')
    .update(`${normalisedQuery}|${normaliseProductName(candidateName)}|${model}|${PROMPT_VERSION}`)
    .digest('hex');
}

/** One clause naming what actually decided this, for a buyer to read. */
export function explain(verdict: MatchVerdict): string {
  switch (verdict.method) {
    case 'gtin':
      return 'Един и същ баркод.';
    case 'sku':
      return 'Един и същ артикулен номер.';
    case 'model':
      return 'Един и същ модел.';
    case 'conflict': {
      const clash = verdict.reasons.find((reason) => !reason.agrees);
      return clash
        ? `Различни са: ${clash.label.toLowerCase()} ${clash.left} срещу ${clash.right}.`
        : 'Различни артикули.';
    }
    case 'attributes': {
      const agreed = verdict.reasons
        .filter((reason) => reason.agrees)
        .map((reason) => reason.label);
      return agreed.length > 0
        ? `Съвпадат: ${agreed.join(', ').toLowerCase()}.`
        : 'Съвпадат по спецификация.';
    }
    case 'ai': {
      const note = verdict.reasons.find((reason) => reason.label === 'AI');
      return note?.left || 'Преценено по описанието.';
    }
    default:
      return verdict.confidence >= DEFAULT_THRESHOLDS.floor
        ? 'Съвпада по описание.'
        : 'Слабо съвпадение по описание.';
  }
}

/**
 * What a reading of the query looks like to the outside world.
 *
 * The legacy three — category, specs, measurements — are projections of the
 * generic attributes rather than a second extraction. One reading, presented
 * two ways, so the old contract and the new one can never disagree.
 */
export function understandingOf(product: GenericProduct, didYouMean: string | null): Understanding {
  const specs: Record<string, string> = {};
  const measurements: Array<{ value: number; unit: string }> = [];

  for (const attribute of product.attributes) {
    if (attribute.quantity)
      measurements.push({ value: attribute.quantity.value, unit: attribute.quantity.unit });
    else specs[attribute.key] = attribute.value;
  }

  return {
    brand: product.brand,
    category: product.productType?.canonical ?? null,
    specs,
    measurements,
    didYouMean,
    productType: product.productType?.raw ?? null,
    attributes: attributeMap(product),
    identifiers: product.identifiers,
    requestedQuantity: product.requestedQuantity,
  };
}

/**
 * A product as one line a model can read.
 *
 * Sent instead of — well, alongside — the raw title, because the model's job
 * is the residue the arithmetic could not settle, and it cannot see what the
 * arithmetic saw unless it is told.
 */
export function describe(product: GenericProduct): string {
  const parts: string[] = [];

  if (product.productType) parts.push(`type=${product.productType.canonical}`);
  if (product.brand) parts.push(`brand=${product.brand}`);
  if (product.identifiers.family) parts.push(`range=${product.identifiers.family}`);
  if (product.identifiers.modelCodes.length > 0) {
    parts.push(`model=${product.identifiers.modelCodes.join('/')}`);
  }

  for (const attribute of product.attributes) {
    parts.push(
      `${attribute.key}=${attribute.quantity ? formatQuantity(attribute.quantity) : attribute.value}`,
    );
  }

  return parts.join(' ');
}

/**
 * The filters this particular set of results can offer.
 *
 * Built from the candidates, never from a table. An attribute earns a filter
 * by appearing on more than one listing with more than one value — which is
 * exactly the condition under which a filter is useful, and it holds whether
 * the attribute is a screen size or a nominal bore.
 */
export function facetsOf(
  candidates: MatchCandidate[],
  interpreted: Map<string, GenericProduct>,
  verdicts: Map<string, MatchVerdict>,
): SearchFacet[] {
  const counts = new Map<string, { label: string; role: string; values: Map<string, number> }>();

  for (const candidate of candidates) {
    // Only listings the buyer is actually being shown may offer a filter.
    //
    // This used to skip blocked pairs alone, which is a far narrower set than
    // it sounds: a stated *conflict* is blocked, but a listing with nothing in
    // common at all is merely `unrelated`, and unrelated listings sailed
    // through. Searching a polisher by model number therefore offered filters
    // for RAM and USB-C, harvested from the car parts and charging stations a
    // shop's search had guessed at — filters over a shelf the buyer could not
    // see, leading to results that were never theirs.
    const verdict = verdicts.get(candidate.id);
    if (!verdict || verdict.blocked) continue;
    if (verdict.relation === 'unrelated' || verdict.relation === 'conflict') continue;

    const product = interpreted.get(candidate.id);
    if (!product) continue;

    for (const attribute of product.attributes) {
      if (attribute.role !== 'identity' && attribute.role !== 'variant') continue;

      const bucket = counts.get(attribute.key) ?? {
        label: displayLabel(attribute.key, attribute.label),
        role: attribute.role,
        values: new Map<string, number>(),
      };

      const shown = attribute.quantity ? formatQuantity(attribute.quantity) : attribute.value;
      bucket.values.set(shown, (bucket.values.get(shown) ?? 0) + 1);
      counts.set(attribute.key, bucket);
    }
  }

  return (
    [...counts.entries()]
      // One value is not a choice, and fifteen is a wall. Both are worse than no
      // filter at all.
      .filter(([, bucket]) => bucket.values.size >= 2 && bucket.values.size <= 12)
      .map(([key, bucket]) => ({
        key,
        label: bucket.label,
        role: bucket.role,
        values: [...bucket.values.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      }))
      .sort((a, b) => b.values.length - a.values.length || a.key.localeCompare(b.key))
      .slice(0, 6)
  );
}

/** One comparison, short enough to put twelve of them in a prompt. */
export function summarise(comparison: AttributeComparison): string {
  return `${comparison.key}: ${comparison.query ?? '—'} / ${comparison.candidate ?? '—'}`;
}
