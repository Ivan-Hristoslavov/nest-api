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
   * Both maps are keyed by host, and the set of hosts is chosen by customers.
   *
   * Nothing bounded them: every hostname anybody ever pointed a listing at
   * stayed in memory for the life of the process, and the plan sells
   * "unlimited suppliers". A queue whose chain has settled is holding a
   * resolved promise nobody will ever await again, and yesterday's spend row
   * answers no question at all — so both are dropped once they stop meaning
   * anything.
   */
  private static readonly MAX_TRACKED_HOSTS = 5_000;

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
    const settled = run.then(
      () => undefined,
      () => undefined,
    );

    this.queues.set(host, settled);

    // Dropped once the chain behind it has settled, unless a later caller has
    // already replaced it — that one is still someone's queue. This is what
    // keeps the map the size of the sweep rather than the size of history.
    void settled.then(() => {
      if (this.queues.get(host) === settled) this.queues.delete(host);
    });

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
      this.pruneSpend(today);
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

  /**
   * Forgets hosts whose last request was on an earlier day.
   *
   * Runs only when a host is seen for the first time today, so the cost falls
   * on the first sweep after midnight rather than on every request. The cap is
   * the backstop for the pathological case — thousands of distinct hosts
   * inside a single day — where the oldest rows go first.
   */
  private pruneSpend(today: string): void {
    for (const [host, entry] of this.spend) {
      if (entry.day !== today) this.spend.delete(host);
    }

    if (this.spend.size <= HostRateLimiterService.MAX_TRACKED_HOSTS) return;

    const excess = this.spend.size - HostRateLimiterService.MAX_TRACKED_HOSTS;
    let dropped = 0;

    for (const host of this.spend.keys()) {
      if (dropped >= excess) break;
      this.spend.delete(host);
      dropped += 1;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
