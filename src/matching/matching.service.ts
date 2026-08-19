import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { User } from '../billing/entities/user.entity';
import { ProductAttributes, extractAttributes, suggestCorrection } from './attributes';
import { ClaudeService, PROMPT_VERSION } from './claude.service';
import {
  DEFAULT_THRESHOLDS,
  MatchMethod,
  MatchReason,
  MatchVerdict,
  confidenceBand,
  matchDeterministically,
} from './deterministic-matcher';
import { MatchCache } from './entities/match-cache.entity';
import { normaliseProductName } from './normalisation';

/** A supplier listing put forward for comparison. */
export interface MatchCandidate {
  id: string;
  name: string;
  supplier: string;
  sku?: string | null;
}

/** What the caller gets back for one candidate. */
export interface MatchResult {
  id: string;
  confidence: number;
  band: ReturnType<typeof confidenceBand>;
  method: MatchMethod;
  /** Attribute-by-attribute, so a buyer can check the machine's work. */
  reasons: MatchReason[];
  /** One clause naming what decided it. */
  explanation: string;
}

export interface MatchRunSummary {
  /** What the query was understood to be, before any model was involved. */
  understood: {
    brand: string | null;
    category: string | null;
    specs: Record<string, string>;
    measurements: Array<{ value: number; unit: string }>;
    /** A likely typo in a brand name, or null. The search still runs as typed. */
    didYouMean: string | null;
  };
  results: MatchResult[];
  candidates: number;
  /** Pairs answered by barcode, article number, model code or specification. */
  decidedDeterministically: number;
  aiCallsMade: number;
  aiCacheHits: number;
  aiModel: string | null;
  aiSkippedReason: 'disabled' | 'quota' | 'unreachable' | null;
  durationMs: number;
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
  understand(query: string): MatchRunSummary['understood'] {
    const attributes = extractAttributes(query);

    return {
      brand: attributes.brand,
      category: attributes.category,
      specs: attributes.specs,
      measurements: attributes.measurements,
      didYouMean: suggestCorrection(query),
    };
  }

  async match(
    ownerId: string | null,
    query: string,
    candidates: MatchCandidate[],
    options: { useAi?: boolean; maxAiCandidates?: number } = {},
  ): Promise<MatchRunSummary> {
    const startedAt = Date.now();
    const queryAttributes = extractAttributes(query);

    const verdicts = new Map<string, MatchVerdict>();
    for (const candidate of candidates) {
      verdicts.set(
        candidate.id,
        matchDeterministically(
          queryAttributes,
          extractAttributes(candidate.name, { sku: candidate.sku }),
        ),
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
        queryAttributes,
        ambiguous,
        verdicts,
      );
      aiCacheHits = outcome.cacheHits;
      aiCallsMade = outcome.callsMade;
      skipped = outcome.skipped;
    } else if (ambiguous.length > 0) {
      skipped = 'disabled';
    }

    const summary: MatchRunSummary = {
      understood: this.understand(query),
      results: candidates.map((candidate) => this.present(candidate, verdicts.get(candidate.id)!)),
      candidates: candidates.length,
      decidedDeterministically,
      aiCallsMade,
      aiCacheHits,
      aiModel: this.claude.activeModel,
      aiSkippedReason: skipped,
      durationMs: Date.now() - startedAt,
    };

    // One structured line per search: enough to answer "why was this match
    // made" and "what did this search cost" months later, with no product
    // names from other accounts and no customer identifiers in the message.
    this.logger.log(
      `match query="${normaliseProductName(query)}" candidates=${summary.candidates} ` +
        `deterministic=${summary.decidedDeterministically} ai_calls=${aiCallsMade} ` +
        `ai_cache_hits=${aiCacheHits} model=${summary.aiModel ?? 'none'} ` +
        `skipped=${skipped ?? 'no'} ms=${summary.durationMs}`,
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
    queryAttributes: ProductAttributes,
    ambiguous: MatchCandidate[],
    verdicts: Map<string, MatchVerdict>,
  ): Promise<{
    cacheHits: number;
    callsMade: number;
    skipped: MatchRunSummary['aiSkippedReason'];
  }> {
    if (!this.claude.enabled) return { cacheHits: 0, callsMade: 0, skipped: 'disabled' };

    const model = this.claude.activeModel ?? 'pending';
    const fingerprints = new Map<string, string>();

    for (const candidate of ambiguous) {
      fingerprints.set(
        candidate.id,
        fingerprint(queryAttributes.normalised, candidate.name, model),
      );
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
        this.applyAiVerdict(verdicts, candidate.id, row.isSame, row.confidence, row.reason);
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

    const outcome = await this.claude.matchCandidates({
      query,
      candidates: unanswered.slice(0, allowance).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        supplier: candidate.supplier,
      })),
    });

    if (!outcome) return { cacheHits, callsMade: 0, skipped: 'unreachable' };

    for (const verdict of outcome.verdicts) {
      if (!verdicts.has(verdict.id)) continue;

      this.applyAiVerdict(verdicts, verdict.id, verdict.same, verdict.confidence, verdict.reason);

      // Written under the model that answered, so a later model version asks
      // again rather than inheriting an answer it did not give.
      await this.cache
        .upsert(
          {
            fingerprint: fingerprint(
              queryAttributes.normalised,
              unanswered.find((candidate) => candidate.id === verdict.id)?.name ?? '',
              outcome.model,
            ),
            isSame: verdict.same,
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
    same: boolean,
    confidence: number,
    reason: string,
  ): void {
    const current = verdicts.get(id);
    if (!current || current.blocked) return;

    const reasons = reason
      ? [...current.reasons, { label: 'AI', left: reason, right: '', agrees: same }]
      : current.reasons;

    verdicts.set(id, {
      ...current,
      method: 'ai',
      reasons,
      confidence: same
        ? Math.min(0.94, Math.max(current.confidence, confidence))
        : Math.min(current.confidence, 0.5),
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
    const periodStarted = user.aiPeriodStartedAt;
    const monthElapsed =
      !periodStarted || now.getTime() - periodStarted.getTime() > 30 * 24 * 3600_000;

    const used = monthElapsed ? 0 : user.aiMatchesUsed;
    const remaining = Math.max(0, user.aiMatchesLimit - used);
    const granted = Math.min(wanted, remaining);

    if (granted === 0) {
      this.logger.log(
        `Account ${ownerId} has spent its ${user.aiMatchesLimit} AI comparisons for this period; ` +
          'searching continues without AI.',
      );
      return 0;
    }

    await this.users.update(
      { id: user.id },
      {
        aiMatchesUsed: used + granted,
        aiPeriodStartedAt: monthElapsed ? now : (periodStarted ?? now),
      },
    );

    return granted;
  }

  private present(candidate: MatchCandidate, verdict: MatchVerdict): MatchResult {
    return {
      id: candidate.id,
      confidence: Math.round(verdict.confidence * 100) / 100,
      band: confidenceBand(verdict.confidence),
      method: verdict.method,
      reasons: verdict.reasons,
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
