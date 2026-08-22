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
   * Per host: how many requests today, and which day that is.
   *
   * The gap above controls *rate*, which is what keeps a burst polite. This
   * controls *volume*, which is what a site's protection actually counts:
   * spacing six requests a second a second apart is still half a million
   * requests a day from one address, and no amount of politeness makes that
   * look like a browser.
   *
   * Held in memory. A restart forgets the count, which at worst spends one
   * extra day's budget on the day of a deploy — cheaper than a table and a
   * write on every fetch.
   */
  private readonly spend = new Map<string, { day: string; count: number }>();

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

  /**
   * Claims one request against a host's daily budget.
   *
   * @returns false when today's allowance is gone, and the caller should skip
   * rather than wait — a listing checked tomorrow instead of now is a price
   * one day old, which is survivable; being blocked is not.
   */
  claim(host: string, dailyBudget: number): boolean {
    if (dailyBudget <= 0) return true;

    const today = new Date().toISOString().slice(0, 10);
    const current = this.spend.get(host);

    if (!current || current.day !== today) {
      this.spend.set(host, { day: today, count: 1 });
      return true;
    }

    if (current.count >= dailyBudget) return false;

    current.count += 1;
    return true;
  }

  /** What has been spent on a host today. For diagnostics and the tests. */
  spentToday(host: string): number {
    const current = this.spend.get(host);
    return current && current.day === new Date().toISOString().slice(0, 10) ? current.count : 0;
  }

  /** Number of hosts currently tracked. Used by tests and diagnostics. */
  get trackedHosts(): number {
    return this.queues.size;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
