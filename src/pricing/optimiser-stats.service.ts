import { Injectable } from '@nestjs/common';

import { OptimisationResult } from './order-optimizer';

/**
 * What the optimiser has been doing lately, for the operator screen.
 *
 * Held in memory rather than in a table, and deliberately so: these are
 * operational counters, not a record. Their whole use is answering "is the
 * optimiser healthy right now", and a deploy resetting them costs nothing —
 * the same trade the host rate limiter already makes.
 *
 * A table would be the wrong shape twice over. It would write a row on the hot
 * path of every basket, and it would invite the question of retention for data
 * nobody will read after the afternoon it was written.
 *
 * Nothing here identifies a customer or names an article. Counts, durations
 * and totals only — an operator needs to know that plans are being found, not
 * what anybody is buying.
 */

/** How many recent runs are kept. A few hundred is a working day of traffic. */
const WINDOW = 200;

interface Sample {
  at: number;
  durationMs: number;
  lineCount: number;
  supplierCount: number;
  combinationsEvaluated: number;
  suppliersChosen: number;
  savings: number | null;
  boundedSearch: boolean;
  failed: boolean;
  unassignedLines: number;
}

export interface OptimiserStats {
  /** Runs held in the window, and how far back it reaches. */
  samples: number;
  since: string | null;

  runs: number;
  failures: number;
  /** Share of runs that found no placeable plan at all, 0–1. */
  failureRate: number;
  /** Share of runs where the search space was capped, 0–1. */
  boundedRate: number;

  durationMs: { average: number; p95: number; max: number };
  averageLines: number;
  averageSuppliersConsidered: number;
  averageSuppliersChosen: number;
  averageCombinations: number;

  /** Across runs that produced a saving. */
  averageSavings: number | null;
  totalSavings: number;
  /** Runs where a plan was found but no single supplier could have filled the order. */
  runsWithoutBaseline: number;
  /** Runs that left at least one line with no supplier. */
  runsWithUnassigned: number;
}

@Injectable()
export class OptimiserStatsService {
  private readonly samples: Sample[] = [];

  record(result: OptimisationResult): void {
    this.samples.push({
      at: Date.now(),
      durationMs: result.diagnostics.durationMs,
      lineCount: result.diagnostics.lineCount,
      supplierCount: result.diagnostics.supplierCount,
      combinationsEvaluated: result.diagnostics.combinationsEvaluated,
      suppliersChosen: result.best?.suppliersUsed ?? 0,
      savings: result.savings,
      boundedSearch: result.diagnostics.boundedSearch,
      failed: result.best === null,
      unassignedLines: result.unassigned.length,
    });

    // A plain shift rather than a ring buffer: the window is two hundred and
    // this runs once per basket, so the clarity is worth more than the cycles.
    while (this.samples.length > WINDOW) this.samples.shift();
  }

  snapshot(): OptimiserStats {
    const samples = this.samples;

    if (samples.length === 0) {
      return {
        samples: 0,
        since: null,
        runs: 0,
        failures: 0,
        failureRate: 0,
        boundedRate: 0,
        durationMs: { average: 0, p95: 0, max: 0 },
        averageLines: 0,
        averageSuppliersConsidered: 0,
        averageSuppliersChosen: 0,
        averageCombinations: 0,
        averageSavings: null,
        totalSavings: 0,
        runsWithoutBaseline: 0,
        runsWithUnassigned: 0,
      };
    }

    const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
    const withSavings = samples.filter(
      (sample): sample is Sample & { savings: number } => sample.savings !== null,
    );

    const mean = (values: number[]): number =>
      Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;

    return {
      samples: samples.length,
      since: new Date(samples[0].at).toISOString(),
      runs: samples.length,
      failures: samples.filter((sample) => sample.failed).length,
      failureRate: share(samples, (sample) => sample.failed),
      boundedRate: share(samples, (sample) => sample.boundedSearch),
      durationMs: {
        average: mean(durations),
        // Nearest-rank p95: with a window this small it is a sanity check,
        // not a statistic, and rounding it up is the safer direction.
        p95: durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)],
        max: durations[durations.length - 1],
      },
      averageLines: mean(samples.map((sample) => sample.lineCount)),
      averageSuppliersConsidered: mean(samples.map((sample) => sample.supplierCount)),
      averageSuppliersChosen: mean(
        samples.filter((sample) => !sample.failed).map((sample) => sample.suppliersChosen),
      ),
      averageCombinations: mean(samples.map((sample) => sample.combinationsEvaluated)),
      averageSavings:
        withSavings.length > 0 ? mean(withSavings.map((sample) => sample.savings)) : null,
      totalSavings:
        Math.round(withSavings.reduce((sum, sample) => sum + sample.savings, 0) * 100) / 100,
      // A plan with no baseline is one no single supplier could have filled.
      // Common and healthy; worth watching only if it becomes everything.
      runsWithoutBaseline: samples.filter((sample) => !sample.failed && sample.savings === null)
        .length,
      runsWithUnassigned: samples.filter((sample) => sample.unassignedLines > 0).length,
    };
  }
}

function share(samples: Sample[], predicate: (sample: Sample) => boolean): number {
  if (samples.length === 0) return 0;
  return Math.round((samples.filter(predicate).length / samples.length) * 1000) / 1000;
}
