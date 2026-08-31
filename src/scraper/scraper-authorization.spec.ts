import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AdminGuard } from '../common/guards/admin.guard';
import { AuthenticatedRequest } from '../common/guards/api-key.guard';
import { resolveOwnerAccount } from '../common/decorators/owner.decorator';
import { User } from '../billing/entities/user.entity';
import { ScraperController } from './scraper.controller';
import { ScraperService } from './scraper.service';

/**
 * Proof that one customer cannot read or drive another customer's scraping.
 *
 * The bug this guards against was not a missing filter but a missing *guard*:
 * `GET /scraper/status` and `POST /scraper/run` were reachable with any
 * customer key. The first returns `lastRun.results`, one row per listing
 * checked by the last deployment-wide sweep — product names, supplier names
 * and prices belonging to every account. The second lets one account spend the
 * platform's whole request budget against suppliers it has no relationship
 * with, and hands back that same cross-tenant payload.
 *
 * Neither failure is loud. Both are tested here at the two levels that matter:
 * the metadata a customer key is actually checked against, and the queries the
 * scoped replacements issue.
 */

/** Reads the guards Nest would apply to a handler, exactly as the framework does. */
function guardsFor(method: keyof ScraperController): unknown[] {
  const reflector = new Reflector();

  // Read off the prototype descriptor rather than the method reference: the
  // metadata hangs on the function, and pulling the function out of the class
  // to pass it around is exactly what `unbound-method` warns about.
  const descriptor = Object.getOwnPropertyDescriptor(ScraperController.prototype, method);
  const handler = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;

  const onHandler = handler ? (reflector.get<unknown[]>('__guards__', handler) ?? []) : [];
  const onClass = reflector.get<unknown[]>('__guards__', ScraperController) ?? [];

  return [...onClass, ...onHandler];
}

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('scraper authorization', () => {
  describe('deployment-wide routes are operator-only', () => {
    it.each([
      ['getStatus', 'GET /scraper/status'],
      ['run', 'POST /scraper/run'],
    ] as Array<[keyof ScraperController, string]>)(
      '%s (%s) is protected by AdminGuard',
      (method) => {
        expect(guardsFor(method)).toContain(AdminGuard);
      },
    );

    it('AdminGuard refuses a customer key', () => {
      const guard = new AdminGuard();
      const customer = contextFor({ isAdmin: false, user: { id: 'acc-a' } as User });

      expect(() => guard.canActivate(customer)).toThrow(ForbiddenException);
    });

    it('AdminGuard refuses a session with no operator flag at all', () => {
      const guard = new AdminGuard();

      expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
    });

    it('AdminGuard admits an operator key', () => {
      const guard = new AdminGuard();

      expect(guard.canActivate(contextFor({ isAdmin: true }))).toBe(true);
    });
  });

  describe('the tenant-scoped replacements are not operator-only', () => {
    it.each([
      ['getOwnStatus', 'GET /scraper/status/mine'],
      ['runOwn', 'POST /scraper/run/mine'],
      ['trigger', 'POST /scraper/trigger/:id'],
      ['refresh', 'POST /scraper/competitors/:id/refresh'],
    ] as Array<[keyof ScraperController, string]>)(
      '%s (%s) carries no AdminGuard, so customers can use it',
      (method) => {
        expect(guardsFor(method)).not.toContain(AdminGuard);
      },
    );
  });

  describe('@Owner() refuses an operator key', () => {
    // The counterpart of the guard above: routes a customer *may* call must
    // still name an account, and an operator key has none. Without this an
    // operator key would fall through to a service method with `undefined` as
    // the tenant filter — which is every row, of every tenant.

    it('returns the account for a customer key', () => {
      const request = contextFor({ user: { id: 'acc-a' } as User, isAdmin: false });

      expect(resolveOwnerAccount(request).id).toBe('acc-a');
    });

    it('throws for an operator key, which has no account', () => {
      expect(() => resolveOwnerAccount(contextFor({ isAdmin: true }))).toThrow(BadRequestException);
    });

    it('throws when nothing authenticated at all', () => {
      expect(() => resolveOwnerAccount(contextFor({}))).toThrow(BadRequestException);
    });
  });

  describe('an owner sweep touches only that owner', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    function serviceWith(overrides: Record<string, unknown> = {}): {
      service: ScraperService;
      competitors: Record<string, jest.Mock>;
    } {
      const competitors = {
        findDueForScrape: jest.fn().mockResolvedValue([]),
        countDueForScrape: jest.fn().mockResolvedValue(0),
        ...overrides,
      };

      // Partial mocks on purpose: this suite asserts authorization and
      // scoping, not the fetch path, so the collaborators it never reaches are
      // left unbuilt rather than half-built and misleading.
      /* eslint-disable @typescript-eslint/no-unsafe-argument */
      const service = new ScraperService(
        {} as any,
        competitors as any,
        { driver: 'simulation' } as any,
        { addCronJob: jest.fn() } as any,
        {
          get: () => ({
            enabled: true,
            cron: '0 * * * *',
            batchSize: 25,
            concurrency: 5,
          }),
        } as any,
      );
      /* eslint-enable @typescript-eslint/no-unsafe-argument */

      return { service, competitors };
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */

    it('asks the queue for one account only', async () => {
      const { service, competitors } = serviceWith();

      await service.runOwnerSweep('acc-a');

      expect(competitors.findDueForScrape).toHaveBeenCalledWith(25, 'acc-a');
    });

    it('never reaches the unscoped queue', async () => {
      const { service, competitors } = serviceWith();

      await service.runOwnerSweep('acc-a');

      // A call with a single argument is the deployment-wide queue.
      const calls = competitors.findDueForScrape.mock.calls as unknown[][];
      for (const call of calls) {
        expect(call).toHaveLength(2);
        expect(call[1]).toBe('acc-a');
      }
    });

    it('counts only that account when reporting status', async () => {
      const { service, competitors } = serviceWith({
        countDueForScrape: jest.fn().mockResolvedValue(3),
      });

      const status = await service.getOwnerStatus('acc-b');

      expect(competitors.countDueForScrape).toHaveBeenCalledWith('acc-b');
      expect(status.dueNow).toBe(3);
    });

    it('reports nothing that could name another tenant', async () => {
      const { service } = serviceWith();

      const status = await service.getOwnerStatus('acc-b');

      // The cross-tenant fields of ScraperStatusDto must not appear here.
      expect(status).not.toHaveProperty('lastRun');
      expect(status).not.toHaveProperty('lastRunAt');
      expect(Object.keys(status).sort()).toEqual(['cron', 'dueNow', 'enabled', 'running']);
    });

    it('does not record an owner refresh as the deployment-wide last run', async () => {
      const { service } = serviceWith();

      await service.runOwnerSweep('acc-a');
      const global = await service.getStatus();

      // Otherwise one customer's refresh would become the payload the operator
      // screen — and, before this change, every other customer — reads back.
      expect(global.lastRun).toBeNull();
      expect(global.lastRunAt).toBeNull();
    });

    it('collapses a second refresh from the same account into the first', async () => {
      const { service, competitors } = serviceWith();

      await Promise.all([service.runOwnerSweep('acc-a'), service.runOwnerSweep('acc-a')]);

      expect(competitors.findDueForScrape).toHaveBeenCalledTimes(1);
    });

    it('lets two different accounts refresh independently', async () => {
      const { service, competitors } = serviceWith();

      await Promise.all([service.runOwnerSweep('acc-a'), service.runOwnerSweep('acc-b')]);

      expect(competitors.findDueForScrape).toHaveBeenCalledTimes(2);
      expect(competitors.findDueForScrape).toHaveBeenCalledWith(25, 'acc-a');
      expect(competitors.findDueForScrape).toHaveBeenCalledWith(25, 'acc-b');
    });
  });
});
