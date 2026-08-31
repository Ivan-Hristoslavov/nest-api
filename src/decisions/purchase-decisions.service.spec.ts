import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Order, OrderStatus } from '../orders/entities/order.entity';
import { DecisionDraftService } from './decision-draft.service';
import { PurchaseDecision, SavingsKind } from './entities/purchase-decision.entity';
import { PurchaseDecisionSnapshot } from './purchase-decision.snapshot';
import { PurchaseDecisionsService } from './purchase-decisions.service';

/**
 * Storing decisions, and telling a forecast from a fact.
 *
 * Two properties are load-bearing here and both are about honesty rather than
 * mechanics: a decision belongs to exactly one account and is invisible to
 * every other, and a saving is called *realized* only when there is a
 * confirmed purchase behind every supplier in the plan.
 */

/** A plan across two suppliers: goods 240, delivery 10 each. */
const snapshot = (): PurchaseDecisionSnapshot => ({
  version: 1,
  decidedAt: new Date().toISOString(),
  currency: 'EUR',
  request: {
    lines: [{ query: 'cable', quantity: 100 }],
    currency: 'EUR',
    maxSuppliers: null,
    excludeShopIds: [],
    usedCache: true,
  },
  suppliers: [],
  lines: [],
  optimisation: {
    baseline: null,
    optimised: {
      kind: 'optimal',
      label: '2 доставчика',
      suppliersUsed: 2,
      productSubtotal: 240,
      shipping: 20,
      handlingFee: 0,
      total: 260,
      linesCovered: 2,
      suppliers: [
        {
          shopId: 'a',
          name: 'Shop a',
          linesCovered: 1,
          productSubtotal: 100,
          shipping: 10,
          shippingWaived: false,
          handlingFee: 0,
          total: 110,
          minOrderValue: 0,
          meetsMinimumOrder: true,
          warnings: [],
        },
        {
          shopId: 'b',
          name: 'Shop b',
          linesCovered: 1,
          productSubtotal: 140,
          shipping: 10,
          shippingWaived: false,
          handlingFee: 0,
          total: 150,
          minOrderValue: 0,
          meetsMinimumOrder: true,
          warnings: [],
        },
      ],
    },
    savings: 40,
    savingsPercent: 13.3,
    suppliersUsed: 2,
    alternatives: [],
    rejectedSuppliers: [],
    unassigned: [],
    explanation: { whyChosen: [], tradeOffs: [] },
    diagnostics: {
      lineCount: 1,
      assignableLines: 1,
      supplierCount: 2,
      candidateOffers: 2,
      combinationsEvaluated: 3,
      feasiblePlans: 3,
      boundedSearch: false,
      durationMs: 3,
    },
  },
  matching: { aiUsed: false, model: null, promptVersion: null, decidedDeterministically: 1 },
  durationMs: 2400,
});

const order = (over: Partial<Order>): Order =>
  ({ ownerId: 'u1', total: 0, status: OrderStatus.Draft, ...over }) as Order;

describe('PurchaseDecisionsService', () => {
  let service: PurchaseDecisionsService;
  let decisionRows: PurchaseDecision[];
  let orderRows: Order[];
  let updates: Array<Record<string, unknown>>;
  let findOneArgs: Array<Record<string, unknown>>;

  const stored = (over: Partial<PurchaseDecision> = {}): PurchaseDecision =>
    ({
      id: 'd1',
      ownerId: 'u1',
      number: 1,
      currency: 'EUR',
      baselineTotal: 300,
      optimisedTotal: 260,
      savings: 40,
      savingsKind: SavingsKind.Potential,
      realizedTotal: null,
      realizedSavings: null,
      snapshot: snapshot(),
      ...over,
    }) as PurchaseDecision;

  beforeEach(async () => {
    decisionRows = [];
    orderRows = [];
    updates = [];
    findOneArgs = [];

    const moduleRef = await Test.createTestingModule({
      providers: [
        PurchaseDecisionsService,
        {
          provide: getRepositoryToken(PurchaseDecision),
          useValue: {
            findOne: jest.fn((options: { where: Record<string, unknown> }) => {
              findOneArgs.push(options.where);
              return Promise.resolve(
                decisionRows.find((row) =>
                  Object.entries(options.where).every(
                    ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
                  ),
                ) ?? null,
              );
            }),
            update: jest.fn((where: unknown, patch: Record<string, unknown>) => {
              updates.push({ where, patch });
              return Promise.resolve({ affected: 1 });
            }),
          },
        },
        {
          provide: getRepositoryToken(Order),
          useValue: {
            find: jest.fn((options: { where: Record<string, unknown> }) =>
              Promise.resolve(
                orderRows.filter((row) =>
                  Object.entries(options.where).every(
                    ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
                  ),
                ),
              ),
            ),
          },
        },
        { provide: DecisionDraftService, useValue: { open: (draft: unknown) => draft } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(PurchaseDecisionsService);
  });

  describe('tenant isolation', () => {
    it('never returns another account’s decision', async () => {
      decisionRows.push(stored({ ownerId: 'someone-else' }));

      await expect(service.findOne('u1', 'd1')).rejects.toThrow(NotFoundException);
    });

    it('scopes the lookup by owner rather than filtering after the fact', async () => {
      decisionRows.push(stored());
      await service.findOne('u1', 'd1');

      // The owner is in the WHERE clause. A query that fetched by id and then
      // compared owners in JavaScript would pass a test that only checked the
      // return value, and would leak the moment somebody added an early return.
      expect(findOneArgs[0]).toEqual({ id: 'd1', ownerId: 'u1' });
    });

    it('reports a missing decision rather than a forbidden one', async () => {
      decisionRows.push(stored({ ownerId: 'someone-else' }));

      // "Forbidden" would confirm the row exists to whoever guessed its id.
      await expect(service.findOne('u1', 'd1')).rejects.toThrow(NotFoundException);
    });

    it('asks only for this owner’s orders when reading the ones behind a decision', async () => {
      orderRows.push(order({ id: 'o1', purchaseDecisionId: 'd1' }));
      orderRows.push(order({ id: 'o2', ownerId: 'other', purchaseDecisionId: 'd1' }));

      const found = await service.ordersFor('u1', 'd1');

      expect(found.map((row) => row.id)).toEqual(['o1']);
    });
  });

  describe('realized savings', () => {
    it('stays potential while the orders are still drafts', async () => {
      decisionRows.push(stored());
      orderRows.push(order({ shopId: 'a', purchaseDecisionId: 'd1', total: 100 }));
      orderRows.push(order({ shopId: 'b', purchaseDecisionId: 'd1', total: 140 }));

      await service.refreshRealizedSavings('u1', 'd1');

      expect(updates[0].patch).toMatchObject({
        savingsKind: SavingsKind.Potential,
        realizedTotal: null,
        realizedSavings: null,
      });
    });

    it('stays potential when only one of two suppliers was confirmed', async () => {
      decisionRows.push(stored());
      orderRows.push(
        order({ shopId: 'a', purchaseDecisionId: 'd1', total: 100, status: OrderStatus.Confirmed }),
      );
      orderRows.push(
        order({ shopId: 'b', purchaseDecisionId: 'd1', total: 140, status: OrderStatus.Sent }),
      );

      await service.refreshRealizedSavings('u1', 'd1');

      // Half a purchase is not a purchase. Claiming the full saving here is
      // exactly the overstatement the split exists to prevent.
      expect(updates[0].patch).toMatchObject({ savingsKind: SavingsKind.Potential });
    });

    it('becomes realized once every supplier in the plan is confirmed', async () => {
      decisionRows.push(stored());
      orderRows.push(
        order({ shopId: 'a', purchaseDecisionId: 'd1', total: 100, status: OrderStatus.Confirmed }),
      );
      orderRows.push(
        order({ shopId: 'b', purchaseDecisionId: 'd1', total: 140, status: OrderStatus.Confirmed }),
      );

      await service.refreshRealizedSavings('u1', 'd1');

      // Goods from the orders (240), delivery from the snapshot (10 + 10),
      // against the 300 baseline the decision recorded on the day.
      expect(updates[0].patch).toMatchObject({
        savingsKind: SavingsKind.Realized,
        realizedTotal: 260,
        realizedSavings: 40,
      });
    });

    it('follows what was actually ordered, not what the plan proposed', async () => {
      decisionRows.push(stored());
      // The buyer trimmed a quantity before sending: 90 rather than 100.
      orderRows.push(
        order({ shopId: 'a', purchaseDecisionId: 'd1', total: 90, status: OrderStatus.Confirmed }),
      );
      orderRows.push(
        order({ shopId: 'b', purchaseDecisionId: 'd1', total: 140, status: OrderStatus.Confirmed }),
      );

      await service.refreshRealizedSavings('u1', 'd1');

      expect(updates[0].patch).toMatchObject({ realizedTotal: 250, realizedSavings: 50 });
    });

    it('withdraws the claim when a confirmed order is cancelled again', async () => {
      decisionRows.push(
        stored({ savingsKind: SavingsKind.Realized, realizedTotal: 260, realizedSavings: 40 }),
      );
      orderRows.push(
        order({ shopId: 'a', purchaseDecisionId: 'd1', total: 100, status: OrderStatus.Confirmed }),
      );
      orderRows.push(
        order({ shopId: 'b', purchaseDecisionId: 'd1', total: 140, status: OrderStatus.Cancelled }),
      );

      await service.refreshRealizedSavings('u1', 'd1');

      expect(updates[0].patch).toMatchObject({
        savingsKind: SavingsKind.Potential,
        realizedTotal: null,
        realizedSavings: null,
      });
    });

    it('claims nothing when there was no baseline to measure against', async () => {
      decisionRows.push(stored({ baselineTotal: null, savings: null }));
      orderRows.push(
        order({ shopId: 'a', purchaseDecisionId: 'd1', total: 100, status: OrderStatus.Confirmed }),
      );
      orderRows.push(
        order({ shopId: 'b', purchaseDecisionId: 'd1', total: 140, status: OrderStatus.Confirmed }),
      );

      await service.refreshRealizedSavings('u1', 'd1');

      // Real money was spent, and there is still nothing to compare it with —
      // no single supplier could have filled this order. Reporting a saving
      // against nothing would be inventing the comparison.
      expect(updates[0].patch).toMatchObject({ savingsKind: SavingsKind.Potential });
    });

    it('does nothing at all for a decision on another account', async () => {
      decisionRows.push(stored({ ownerId: 'someone-else' }));

      await service.refreshRealizedSavings('u1', 'd1');

      expect(updates).toHaveLength(0);
    });

    it('never touches the snapshot or the potential saving', async () => {
      decisionRows.push(stored());
      orderRows.push(
        order({ shopId: 'a', purchaseDecisionId: 'd1', total: 100, status: OrderStatus.Confirmed }),
      );
      orderRows.push(
        order({ shopId: 'b', purchaseDecisionId: 'd1', total: 140, status: OrderStatus.Confirmed }),
      );

      await service.refreshRealizedSavings('u1', 'd1');

      // The forecast is history too. It stays exactly what the optimiser said.
      const patched = Object.keys(updates[0].patch as object);
      expect(patched.sort()).toEqual(['realizedSavings', 'realizedTotal', 'savingsKind']);
    });
  });
});
