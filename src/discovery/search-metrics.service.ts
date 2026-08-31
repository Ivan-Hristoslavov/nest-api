import { Injectable } from '@nestjs/common';

/**
 * Whether search is any good this afternoon.
 *
 * Held in memory rather than in a table, and deliberately so — the same trade
 * the optimiser's counters already make. These answer one question, "is search
 * healthy right now", and a deploy resetting them costs nothing. A table would
 * write a row on the hot path of every search and then raise the question of
 * retention for data nobody reads after the day it was written.
 *
 * Nothing here identifies a customer or names an article. Counts, durations
 * and rates only: an operator needs to know that queries are being understood,
 * not what anybody is buying.
 */

/** How many recent searches are kept. A few hundred is a working day. */
const WINDOW = 300;

interface Sample {
  at: number;
  durationMs: number;
  shopsAsked: number;
  shopsAnswered: number;
  widened: number;
  candidates: number;
  strong: number;
  possible: number;
  conflicts: number;
  zeroResult: boolean;
  aiCalls: number;
  decidedDeterministically: number;
  topConfidence: number;
  attributesUnderstood: number;
}

export interface SearchQualityStats {
  samples: number;
  since: string | null;

  /** Share of searches that produced at least one strong match, 0–1. */
  strongMatchRate: number;
  /** Share that produced a possible match but nothing strong, 0–1. */
  possibleMatchRate: number;
  /** Share that produced nothing at all, 0–1. */
  zeroResultRate: number;
  /** Share of candidates ruled out on a stated conflict, 0–1. */
  conflictRate: number;
  /** Share of searches where a model was consulted, 0–1. */
  aiFallbackRate: number;
  /** Share of comparisons settled by arithmetic alone, 0–1. */
  deterministicRate: number;
  /** Share of searches where at least one supplier had to be asked twice, 0–1. */
  queryWideningRate: number;
  /** Share of suppliers that answered when asked, 0–1. */
  supplierCoverage: number;

  averageConfidence: number;
  /** Attributes read out of the average query. The engine understanding more. */
  averageAttributesUnderstood: number;
  averageCandidates: number;
  durationMs: { average: number; p95: number; max: number };
}

@Injectable()
export class SearchMetricsService {
  private readonly samples: Sample[] = [];

  record(sample: Omit<Sample, 'at'>): void {
    this.samples.push({ ...sample, at: Date.now() });
    if (this.samples.length > WINDOW) this.samples.splice(0, this.samples.length - WINDOW);
  }

  stats(): SearchQualityStats {
    const samples = this.samples;
    const count = samples.length;

    if (count === 0) {
      return {
        samples: 0,
        since: null,
        strongMatchRate: 0,
        possibleMatchRate: 0,
        zeroResultRate: 0,
        conflictRate: 0,
        aiFallbackRate: 0,
        deterministicRate: 0,
        queryWideningRate: 0,
        supplierCoverage: 0,
        averageConfidence: 0,
        averageAttributesUnderstood: 0,
        averageCandidates: 0,
        durationMs: { average: 0, p95: 0, max: 0 },
      };
    }

    const share = (predicate: (sample: Sample) => boolean): number =>
      round(samples.filter(predicate).length / count);

    const mean = (pick: (sample: Sample) => number): number =>
      round(samples.reduce((total, sample) => total + pick(sample), 0) / count);

    const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const totalCandidates = samples.reduce((total, sample) => total + sample.candidates, 0);
    const totalConflicts = samples.reduce((total, sample) => total + sample.conflicts, 0);
    const totalDeterministic = samples.reduce(
      (total, sample) => total + sample.decidedDeterministically,
      0,
    );
    const asked = samples.reduce((total, sample) => total + sample.shopsAsked, 0);
    const answered = samples.reduce((total, sample) => total + sample.shopsAnswered, 0);

    return {
      samples: count,
      since: new Date(samples[0].at).toISOString(),

      strongMatchRate: share((sample) => sample.strong > 0),
      possibleMatchRate: share((sample) => sample.strong === 0 && sample.possible > 0),
      zeroResultRate: share((sample) => sample.zeroResult),
      conflictRate: totalCandidates === 0 ? 0 : round(totalConflicts / totalCandidates),
      aiFallbackRate: share((sample) => sample.aiCalls > 0),
      deterministicRate: totalCandidates === 0 ? 0 : round(totalDeterministic / totalCandidates),
      queryWideningRate: share((sample) => sample.widened > 0),
      supplierCoverage: asked === 0 ? 0 : round(answered / asked),

      averageConfidence: mean((sample) => sample.topConfidence),
      averageAttributesUnderstood: mean((sample) => sample.attributesUnderstood),
      averageCandidates: mean((sample) => sample.candidates),
      durationMs: {
        average: Math.round(durations.reduce((total, value) => total + value, 0) / count),
        p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))],
        max: durations[durations.length - 1],
      },
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
