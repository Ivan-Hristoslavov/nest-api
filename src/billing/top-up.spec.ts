import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BillingService } from './billing.service';
import { BillingEvent } from './entities/billing-event.entity';
import { User, UserPlan } from './entities/user.entity';
import { MailService } from './mail.service';
import { parseTopUpPacks } from './top-up-packs';
import { UsersService } from './users.service';

/**
 * A top-up and a subscription reach the webhook as the same thing: a completed
 * payment. Told apart only by the price that was paid for — and getting that
 * wrong moves somebody onto a plan they did not buy, or silently swallows
 * money they spent on comparisons.
 */
describe('AI top-ups', () => {
  const PACK = 'pri_topup_1000';

  async function build() {
    const events = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((input: Partial<BillingEvent>) => input as BillingEvent),
      save: jest.fn((input: BillingEvent) => Promise.resolve({ ...input, id: input.id ?? 'e1' })),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: 'e1' }] }),
    };

    const users = {
      findOrCreateByEmail: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'kupuvach@example.com',
        plan: UserPlan.Free,
      }),
      creditAiComparisons: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'kupuvach@example.com',
        aiMatchesLimit: 1050,
        aiMatchesUsed: 50,
      }),
      activate: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'kupuvach@example.com',
        plan: UserPlan.Pro,
        apiKeyPrefix: 'pk_live_x',
      }),
      issueApiKey: jest.fn().mockResolvedValue({
        user: { id: 'u1', email: 'kupuvach@example.com' } as User,
        apiKey: 'pk_live_new',
      }),
    };

    const mail = { sendTopUpReceipt: jest.fn().mockResolvedValue(true), sendApiKey: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: getRepositoryToken(BillingEvent), useValue: events },
        { provide: UsersService, useValue: users },
        { provide: MailService, useValue: mail },
        {
          provide: ConfigService,
          useValue: { get: () => ({ topUpPacks: { [PACK]: 1000 } }) },
        },
      ],
    }).compile();

    return { service: moduleRef.get(BillingService), users, mail, events };
  }

  it('reads the packs an operator configured', () => {
    expect(parseTopUpPacks('pri_a:1000, pri_b:5000')).toEqual({ pri_a: 1000, pri_b: 5000 });
    // Junk must not become a pack that credits NaN comparisons.
    expect(parseTopUpPacks('pri_a:abc,pri_b:0,:100')).toEqual({});
    expect(parseTopUpPacks(undefined)).toEqual({});
  });

  it('finds the price a Paddle payment covered', async () => {
    const { service } = await build();

    const event = service.normalise('paddle', {
      event_id: 'evt_1',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_1',
        customer: { email: 'kupuvach@example.com' },
        items: [{ price: { id: PACK } }],
      },
    });

    expect(event.priceIds).toContain(PACK);
  });

  it('credits comparisons instead of changing the plan', async () => {
    const { service, users, mail } = await build();

    const outcome = await service.handleWebhook('paddle', {
      event_id: 'evt_2',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_2',
        customer: { email: 'kupuvach@example.com' },
        items: [{ price: { id: PACK } }],
      },
    });

    expect(users.creditAiComparisons).toHaveBeenCalledWith('u1', 1000);
    // The plan is untouched: somebody buying comparisons did not buy a plan.
    expect(users.activate).not.toHaveBeenCalled();
    expect(mail.sendTopUpReceipt).toHaveBeenCalled();
    expect(outcome.processed).toBe(true);
  });

  it('leaves an ordinary subscription payment alone', async () => {
    const { service, users } = await build();

    await service.handleWebhook('paddle', {
      event_id: 'evt_3',
      event_type: 'subscription.created',
      data: {
        id: 'sub_1',
        customer: { email: 'kupuvach@example.com' },
        items: [{ price: { id: 'pri_monthly_pro' } }],
      },
    });

    expect(users.creditAiComparisons).not.toHaveBeenCalled();
  });
});
