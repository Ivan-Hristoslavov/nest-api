import { HostRateLimiterService } from './host-rate-limiter.service';

/**
 * Both maps in the scraper are keyed by hostname, and the hostnames are chosen
 * by customers on a plan that advertises unlimited suppliers. Neither was
 * bounded: every host anybody ever pointed a listing at stayed in memory until
 * the process restarted. These are the tests that say it does not any more.
 */
describe('memory the scraper holds per host', () => {
  describe('the queue chain', () => {
    it('forgets a host once its work has finished', async () => {
      const limiter = new HostRateLimiterService();

      await limiter.schedule('shop-a.example', 0, async () => 'done');
      await limiter.schedule('shop-b.example', 0, async () => 'done');

      // The deletion is chained onto the settled promise, so it lands on a
      // later turn of the microtask queue than the await above.
      await new Promise((resolve) => setImmediate(resolve));

      expect(limiter.trackedHosts).toBe(0);
    });

    it('does not grow with the number of hosts swept', async () => {
      const limiter = new HostRateLimiterService();

      for (let i = 0; i < 500; i += 1) {
        await limiter.schedule(`shop-${i}.example`, 0, async () => i);
      }

      await new Promise((resolve) => setImmediate(resolve));

      expect(limiter.trackedHosts).toBe(0);
    });

    it('keeps a host that still has work queued behind it', async () => {
      const limiter = new HostRateLimiterService();

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const running = limiter.schedule('busy.example', 0, () => held);
      expect(limiter.trackedHosts).toBe(1);

      release();
      await running;
      await new Promise((resolve) => setImmediate(resolve));

      expect(limiter.trackedHosts).toBe(0);
    });

    it('still serialises requests to one host', async () => {
      const limiter = new HostRateLimiterService();
      const order: string[] = [];

      const first = limiter.schedule('shop.example', 0, async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('first');
      });
      const second = limiter.schedule('shop.example', 0, async () => {
        order.push('second');
      });

      await Promise.all([first, second]);

      expect(order).toEqual(['first', 'second']);
    });
  });

  describe('the daily spend counter', () => {
    it('drops yesterday’s hosts when a new day starts', () => {
      jest.useFakeTimers();

      try {
        jest.setSystemTime(new Date('2026-08-23T10:00:00Z'));

        const limiter = new HostRateLimiterService();
        for (let i = 0; i < 100; i += 1) {
          limiter.claim(`shop-${i}.example`, 10);
        }

        expect(limiter.spentToday('shop-0.example')).toBe(1);

        jest.setSystemTime(new Date('2026-08-24T10:00:00Z'));

        // The first claim of the new day is what triggers the sweep.
        limiter.claim('shop-fresh.example', 10);

        expect(limiter.spentToday('shop-0.example')).toBe(0);
        expect(limiter.spentToday('shop-fresh.example')).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('still refuses a host that has spent its budget', () => {
      const limiter = new HostRateLimiterService();

      expect(limiter.claim('shop.example', 2)).toBe(true);
      expect(limiter.claim('shop.example', 2)).toBe(true);
      expect(limiter.claim('shop.example', 2)).toBe(false);
    });
  });
});
