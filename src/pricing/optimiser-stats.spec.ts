import { OptimisationResult } from './order-optimizer';
import { OptimiserStatsService } from './optimiser-stats.service';

/** A run, shaped just enough for the counters to read. */
function run(overrides: {
  durationMs?: number;
  lineCount?: number;
  supplierCount?: number;
  combinations?: number;
  suppliersUsed?: number | null;
  savings?: number | null;
  bounded?: boolean;
  unassigned?: number;
}): OptimisationResult {
  const suppliersUsed = overrides.suppliersUsed;

  return {
    currency: 'EUR',
    best:
      suppliersUsed === null
        ? null
        : ({ suppliersUsed: suppliersUsed ?? 1 } as OptimisationResult['best']),
    baseline: null,
    savings: overrides.savings ?? null,
    savingsPercent: null,
    alternatives: [],
    unassigned: Array.from({ length: overrides.unassigned ?? 0 }, () => ({
      query: 'x',
      quantity: 1,
      reason: 'no_offers' as const,
      rejections: [],
    })),
    rejectedSuppliers: [],
    explanation: { whyChosen: [], tradeOffs: [] },
    diagnostics: {
      lineCount: overrides.lineCount ?? 10,
      assignableLines: overrides.lineCount ?? 10,
      supplierCount: overrides.supplierCount ?? 3,
      candidateOffers: 30,
      combinationsEvaluated: overrides.combinations ?? 7,
      feasiblePlans: 4,
      boundedSearch: overrides.bounded ?? false,
      durationMs: overrides.durationMs ?? 5,
    },
  };
}

describe('optimiser stats', () => {
  let stats: OptimiserStatsService;

  beforeEach(() => {
    stats = new OptimiserStatsService();
  });

  it('reports an honest zero before anything has run', () => {
    const snapshot = stats.snapshot();

    expect(snapshot.runs).toBe(0);
    expect(snapshot.since).toBeNull();
    expect(snapshot.averageSavings).toBeNull();
    // Not NaN. An empty window divided by itself is the classic way these
    // gauges start lying on the first deploy.
    expect(snapshot.failureRate).toBe(0);
    expect(snapshot.durationMs.average).toBe(0);
  });

  it('counts runs and failures apart', () => {
    stats.record(run({ suppliersUsed: 2 }));
    stats.record(run({ suppliersUsed: 1 }));
    stats.record(run({ suppliersUsed: null })); // no placeable plan

    const snapshot = stats.snapshot();

    expect(snapshot.runs).toBe(3);
    expect(snapshot.failures).toBe(1);
    expect(snapshot.failureRate).toBeCloseTo(0.333, 2);
  });

  it('averages only over runs that found a plan', () => {
    stats.record(run({ suppliersUsed: 3 }));
    stats.record(run({ suppliersUsed: 1 }));
    stats.record(run({ suppliersUsed: null }));

    // A failed run has no chosen suppliers; counting it as zero would drag the
    // average towards a number no plan ever had.
    expect(stats.snapshot().averageSuppliersChosen).toBe(2);
  });

  it('reports durations including a p95', () => {
    for (const durationMs of [1, 2, 3, 4, 100]) {
      stats.record(run({ durationMs, suppliersUsed: 1 }));
    }

    const { durationMs } = stats.snapshot();

    expect(durationMs.max).toBe(100);
    expect(durationMs.average).toBe(22);
    expect(durationMs.p95).toBe(100);
  });

  it('sums savings only where there was a baseline to save against', () => {
    stats.record(run({ suppliersUsed: 2, savings: 10 }));
    stats.record(run({ suppliersUsed: 2, savings: 20 }));
    stats.record(run({ suppliersUsed: 2, savings: null })); // no single supplier could fill it

    const snapshot = stats.snapshot();

    expect(snapshot.totalSavings).toBe(30);
    expect(snapshot.averageSavings).toBe(15);
    expect(snapshot.runsWithoutBaseline).toBe(1);
  });

  it('tracks how often the search had to be capped', () => {
    stats.record(run({ suppliersUsed: 1, bounded: true }));
    stats.record(run({ suppliersUsed: 1, bounded: false }));

    expect(stats.snapshot().boundedRate).toBe(0.5);
  });

  it('tracks runs that left lines unassigned', () => {
    stats.record(run({ suppliersUsed: 1, unassigned: 2 }));
    stats.record(run({ suppliersUsed: 1, unassigned: 0 }));

    expect(stats.snapshot().runsWithUnassigned).toBe(1);
  });

  it('keeps the window bounded so the counters cannot grow without limit', () => {
    for (let i = 0; i < 500; i += 1) stats.record(run({ suppliersUsed: 1 }));

    expect(stats.snapshot().samples).toBe(200);
  });

  it('carries nothing that identifies a customer or an article', () => {
    stats.record(run({ suppliersUsed: 2, savings: 10 }));

    const serialised = JSON.stringify(stats.snapshot());

    // The whole point of the shape: an operator gauge that cannot leak a
    // supplier list or a price into a screen shared over a support call.
    expect(serialised).not.toMatch(/query|shopId|supplierName|ownerId|price/i);
  });
});
