import { SearchMetricsService } from './search-metrics.service';

/**
 * The counters exist so "search got worse last week" is a question with an
 * answer. They are worth a test for the same reason any reporting is: a metric
 * that quietly reports zero is worse than no metric, because somebody believes
 * it.
 */
describe('search quality counters', () => {
  const sample = (over: Partial<Parameters<SearchMetricsService['record']>[0]> = {}) => ({
    durationMs: 900,
    shopsAsked: 4,
    shopsAnswered: 4,
    widened: 0,
    candidates: 10,
    strong: 2,
    possible: 3,
    conflicts: 1,
    zeroResult: false,
    aiCalls: 0,
    decidedDeterministically: 9,
    topConfidence: 0.92,
    attributesUnderstood: 3,
    ...over,
  });

  it('reports nothing rather than zero when nothing has happened', () => {
    const stats = new SearchMetricsService().stats();

    expect(stats.samples).toBe(0);
    expect(stats.since).toBeNull();
  });

  it('counts the searches that found something and the ones that did not', () => {
    const metrics = new SearchMetricsService();

    metrics.record(sample());
    metrics.record(sample({ strong: 0, possible: 2 }));
    metrics.record(sample({ strong: 0, possible: 0, zeroResult: true }));

    const stats = metrics.stats();

    expect(stats.samples).toBe(3);
    expect(stats.strongMatchRate).toBeCloseTo(0.333, 2);
    expect(stats.possibleMatchRate).toBeCloseTo(0.333, 2);
    expect(stats.zeroResultRate).toBeCloseTo(0.333, 2);
  });

  it('reports how much of the work arithmetic settled without a model', () => {
    const metrics = new SearchMetricsService();

    metrics.record(sample({ candidates: 10, decidedDeterministically: 9, aiCalls: 1 }));
    metrics.record(sample({ candidates: 10, decidedDeterministically: 10, aiCalls: 0 }));

    const stats = metrics.stats();

    expect(stats.deterministicRate).toBeCloseTo(0.95, 2);
    expect(stats.aiFallbackRate).toBeCloseTo(0.5, 2);
  });

  it('reports how often a supplier had to be asked a second, wider question', () => {
    const metrics = new SearchMetricsService();

    metrics.record(sample({ widened: 0 }));
    metrics.record(sample({ widened: 2 }));

    expect(metrics.stats().queryWideningRate).toBeCloseTo(0.5, 2);
  });

  it('reports supplier coverage across every search in the window', () => {
    const metrics = new SearchMetricsService();

    metrics.record(sample({ shopsAsked: 4, shopsAnswered: 4 }));
    metrics.record(sample({ shopsAsked: 4, shopsAnswered: 2 }));

    expect(metrics.stats().supplierCoverage).toBeCloseTo(0.75, 2);
  });

  it('keeps the window bounded so a long-running process cannot grow forever', () => {
    const metrics = new SearchMetricsService();
    for (let index = 0; index < 400; index += 1) metrics.record(sample());

    expect(metrics.stats().samples).toBe(300);
  });
});
