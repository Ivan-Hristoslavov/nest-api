import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BillingService } from './billing.service';
import { BillingEvent } from './entities/billing-event.entity';
import { User, UserPlan } from './entities/user.entity';
import { MailService } from './mail.service';
import { UsersService } from './users.service';

/**
 * Which plan a Stripe payment bought.
 *
 * Stripe's webhook payload names neither the plan nor the product — unlike
 * Paddle, which sends `product_name`, and Lemon Squeezy, which sends
 * `variant_name`. The plan was read from those two fields alone, so every
 * Stripe payment resolved to `null` and `activate` fell back to the cheapest
 * plan: a customer paying €99 for Верига was provisioned 100 tracked products
 * instead of 2,000, and nothing anywhere said so.
 *
 * Two sources now answer it, and this is what holds each of them honest.
 */
describe('the plan a Stripe payment bought', () => {
  const PRICES = {
    starter: 'price_starter_19',
    pro: 'price_pro_49',
    business: 'price_business_99',
  };

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
        apiKeyPrefix: null,
      }),
      activate: jest.fn().mockResolvedValue({ id: 'u1', email: 'kupuvach@example.com' }),
      issueApiKey: jest.fn().mockResolvedValue({
        user: { id: 'u1', email: 'kupuvach@example.com' } as User,
        apiKey: 'pk_live_new',
      }),
      creditAiComparisons: jest.fn(),
    };

    const mail = { sendApiKey: jest.fn().mockResolvedValue(true), sendTopUpReceipt: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: getRepositoryToken(BillingEvent), useValue: events },
        { provide: UsersService, useValue: users },
        { provide: MailService, useValue: mail },
        {
          provide: ConfigService,
          useValue: {
            get: (section: string) =>
              section === 'stripe' ? { prices: PRICES } : { topUpPacks: {} },
          },
        },
      ],
    }).compile();

    return { service: moduleRef.get(BillingService), users, mail };
  }

  /** A Checkout Session as Stripe posts it, with the metadata our links carry. */
  function session(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'evt_stripe_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_1',
          customer_details: { email: 'kupuvach@example.com', name: 'Иван' },
          ...overrides,
        },
      },
    };
  }

  it('reads the plan from the payment link metadata', async () => {
    const { service } = await build();

    const event = service.normalise('stripe', session({ metadata: { plan: 'business' } }));

    expect(event.plan).toBe(UserPlan.Business);
    expect(event.email).toBe('kupuvach@example.com');
  });

  it('falls back to the price that was charged when there is no metadata', async () => {
    const { service } = await build();

    const event = service.normalise(
      'stripe',
      session({ line_items: { data: [{ price: { id: PRICES.pro } }] } }),
    );

    expect(event.plan).toBe(UserPlan.Pro);
  });

  it('falls through to the price when the metadata names no plan we sell', async () => {
    const { service } = await build();

    const event = service.normalise(
      'stripe',
      session({
        metadata: { plan: 'something-else' },
        line_items: { data: [{ price: { id: PRICES.business } }] },
      }),
    );

    expect(event.plan).toBe(UserPlan.Business);
  });

  it('provisions the plan that was paid for, not the cheapest one', async () => {
    const { service, users } = await build();

    const outcome = await service.handleWebhook(
      'stripe',
      session({ metadata: { plan: 'business' } }),
    );

    expect(outcome.processed).toBe(true);
    expect(users.activate).toHaveBeenCalledWith('u1', expect.objectContaining({
      plan: UserPlan.Business,
    }));
  });

  it('still issues and emails the key on the way through', async () => {
    const { service, users, mail } = await build();

    await service.handleWebhook('stripe', session({ metadata: { plan: 'pro' } }));

    expect(users.issueApiKey).toHaveBeenCalledWith('u1', 'live');
    expect(mail.sendApiKey).toHaveBeenCalled();
  });

  it('leaves the other providers reading their own fields', async () => {
    const { service } = await build();

    const paddle = service.normalise('paddle', {
      event_id: 'evt_2',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_1',
        customer: { email: 'kupuvach@example.com' },
        attributes: { product_name: 'Stoclify Pro' },
      },
    });

    expect(paddle.plan).toBe(UserPlan.Pro);
  });
});
