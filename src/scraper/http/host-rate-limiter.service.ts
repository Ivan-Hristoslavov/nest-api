import { Injectable } from '@nestjs/common';

/**
 * Serialises requests per host and enforces a minimum gap between them.
 *
 * The sweep runs several products in parallel, and without this a catalog with
 * forty listings on one retailer would fire forty simultaneous requests at it —
 * the fastest possible way to get blocked, and rude besides. Concurrency stays
 * global; politeness is per host.
 */
@Injectable()
export class HostRateLimiterService {
  /** Per host: a promise chain that resolves when the next slot is free. */
  private readonly queues = new Map<string, Promise<void>>();

  /**
   * Runs `task` no sooner than `minGapMs` after the previous task for `host`.
   * Tasks for the same host never overlap; different hosts are independent.
   */
  schedule<T>(host: string, minGapMs: number, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(host) ?? Promise.resolve();

    const run = previous.then(async () => {
      const result = await task();
      // The gap is applied *after* the request, so the next caller waits.
      if (minGapMs > 0) await this.sleep(minGapMs);
      return result;
    });

    // The queue tracks completion only; a failed task must not poison the chain.
    this.queues.set(
      host,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );

    return run;
  }

  /** Number of hosts currently tracked. Used by tests and diagnostics. */
  get trackedHosts(): number {
    return this.queues.size;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
