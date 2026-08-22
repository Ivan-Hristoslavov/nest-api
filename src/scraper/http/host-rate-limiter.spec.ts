import { HostRateLimiterService } from './host-rate-limiter.service';

/**
 * Two different promises to a supplier's website, and they are easy to
 * confuse: the gap keeps requests *slow*, the budget keeps them *few*. A site's
 * protection counts the second one, so spacing half a million requests a second
 * apart still gets the address blocked.
 */
describe('the daily budget for one supplier', () => {
  let limiter: HostRateLimiterService;

  beforeEach(() => {
    limiter = new HostRateLimiterService();
  });

  it('allows exactly the budget and then stops', () => {
    for (let request = 0; request < 5; request += 1) {
      expect(limiter.claim('shop.example', 5)).toBe(true);
    }

    expect(limiter.claim('shop.example', 5)).toBe(false);
    expect(limiter.spentToday('shop.example')).toBe(5);
  });

  it('counts each supplier separately', () => {
    expect(limiter.claim('one.example', 1)).toBe(true);
    expect(limiter.claim('one.example', 1)).toBe(false);

    // A shop we have not touched today is unaffected by another's spend.
    expect(limiter.claim('two.example', 1)).toBe(true);
  });

  it('treats a budget of zero as no limit at all', () => {
    for (let request = 0; request < 1000; request += 1) {
      expect(limiter.claim('shop.example', 0)).toBe(true);
    }
  });

  it('starts again tomorrow', () => {
    expect(limiter.claim('shop.example', 1)).toBe(true);
    expect(limiter.claim('shop.example', 1)).toBe(false);

    jest.useFakeTimers().setSystemTime(new Date(Date.now() + 24 * 3600_000));
    try {
      expect(limiter.claim('shop.example', 1)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the gap between two requests to one host', () => {
  it('serialises them and leaves the gap after each', async () => {
    const limiter = new HostRateLimiterService();
    const startedAt: number[] = [];

    const task = () => {
      startedAt.push(Date.now());
      return Promise.resolve('done');
    };

    await Promise.all([
      limiter.schedule('shop.example', 40, task),
      limiter.schedule('shop.example', 40, task),
      limiter.schedule('shop.example', 40, task),
    ]);

    expect(startedAt).toHaveLength(3);
    // Not overlapping, and spaced. The exact figures are timer-dependent, so
    // the assertion is the property rather than the milliseconds.
    expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(35);
    expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(35);
  });

  it('lets different hosts proceed without waiting for each other', async () => {
    const limiter = new HostRateLimiterService();
    const startedAt: Record<string, number> = {};

    await Promise.all([
      limiter.schedule('slow.example', 200, () => {
        startedAt.slow = Date.now();
        return Promise.resolve(null);
      }),
      limiter.schedule('fast.example', 0, () => {
        startedAt.fast = Date.now();
        return Promise.resolve(null);
      }),
    ]);

    // Politeness is per host; one slow supplier must not hold up the rest.
    expect(Math.abs(startedAt.slow - startedAt.fast)).toBeLessThan(50);
  });

  it('does not poison the queue when one task throws', async () => {
    const limiter = new HostRateLimiterService();

    await expect(
      limiter.schedule('shop.example', 0, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    // The next caller for the same host still runs.
    await expect(limiter.schedule('shop.example', 0, () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
  });
});
