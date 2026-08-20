import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Product } from '../products/entities/product.entity';
import {
  PLAN_AI_MATCH_LIMIT,
  PLAN_PRODUCT_LIMIT,
  TRIAL_AI_MATCHES,
  TRIAL_DAYS,
  TRIAL_PLAN,
  User,
  UserPlan,
  UserStatus,
} from './entities/user.entity';
import { MailService } from './mail.service';
import { TrialService } from './trial.service';
import { UsersService } from './users.service';

/**
 * The trial is the only place the product gives something away, so both of its
 * edges matter: it must start once and it must end without costing anybody the
 * week of work they put in.
 */
describe('starting a trial', () => {
  const buildService = (stored: Partial<User>) => {
    const user = {
      id: 'u1',
      email: 'kupuvach@example.com',
      status: UserStatus.Active,
      plan: UserPlan.Free,
      productLimit: PLAN_PRODUCT_LIMIT[UserPlan.Free],
      aiMatchesLimit: PLAN_AI_MATCH_LIMIT[UserPlan.Free],
      aiMatchesUsed: 0,
      aiPeriodStartedAt: null,
      trialEndsAt: null,
      apiKeyPrefix: 'pk_live_QB-SxMCX',
      ...stored,
    } as User;

    const repository = {
      findOne: jest.fn().mockResolvedValue(user),
      save: jest.fn((input: User) => Promise.resolve(input)),
    };

    return { user, repository };
  };

  const service = async (stored: Partial<User>) => {
    const { repository } = buildService(stored);
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(User), useValue: repository }],
    }).compile();
    return { users: moduleRef.get(UsersService), repository };
  };

  it('puts a newly verified account on Pro for seven days', async () => {
    const { users } = await service({});

    const { user } = await users.activateWithTrial('u1');

    expect(user.plan).toBe(TRIAL_PLAN);
    expect(user.productLimit).toBe(PLAN_PRODUCT_LIMIT[TRIAL_PLAN]);
    // Pro's monthly allowance is not handed to somebody who has paid nothing.
    expect(user.aiMatchesLimit).toBe(TRIAL_AI_MATCHES);

    const daysOut = (user.trialEndsAt!.getTime() - Date.now()) / (24 * 3600_000);
    expect(daysOut).toBeGreaterThan(TRIAL_DAYS - 0.01);
    expect(daysOut).toBeLessThanOrEqual(TRIAL_DAYS);
  });

  it('does not restart a trial the account has already had', async () => {
    // The row is back on the free plan with a date in the past: a trial that
    // ran and ended. Signing in again must not buy another week.
    const finished = new Date(Date.now() - 30 * 24 * 3600_000);
    const { users, repository } = await service({ trialEndsAt: finished });

    const { user } = await users.activateWithTrial('u1');

    expect(user.plan).toBe(UserPlan.Free);
    expect(user.trialEndsAt).toBe(finished);
    expect(repository.save).not.toHaveBeenCalled();
  });
});

describe('ending a trial', () => {
  const owner = {
    id: 'u1',
    email: 'kupuvach@example.com',
    plan: TRIAL_PLAN,
    productLimit: PLAN_PRODUCT_LIMIT[TRIAL_PLAN],
    aiMatchesLimit: TRIAL_AI_MATCHES,
    aiMatchesUsed: 120,
    trialEndsAt: new Date(Date.now() - 60_000),
  } as User;

  /** Twenty-five articles under watch, newest movement first. */
  const watched = Array.from({ length: 25 }, (_, index) => ({ id: `p${index}` }) as Product);

  const build = async () => {
    const users = {
      save: jest.fn<Promise<User>, [User]>((input) => Promise.resolve(input)),
      find: jest.fn(),
    };
    const products = {
      find: jest.fn().mockResolvedValue(watched),
      update: jest.fn<Promise<void>, [string[], Partial<Product>]>(),
      count: jest.fn(),
    };
    const mail = { sendTrialEnded: jest.fn().mockResolvedValue(true), sendTrialEnding: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TrialService,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Product), useValue: products },
        { provide: MailService, useValue: mail },
      ],
    }).compile();

    return { service: moduleRef.get(TrialService), users, products, mail };
  };

  it('parks what the free plan cannot watch instead of deleting it', async () => {
    const { service, products } = await build();

    await service.endTrial({ ...owner } as User);

    const freeLimit = PLAN_PRODUCT_LIMIT[UserPlan.Free];
    const parked = products.update.mock.calls[0][0];

    expect(parked).toHaveLength(watched.length - freeLimit);
    // The ones kept are the first `freeLimit` of the list, which is ordered by
    // most recent movement — the articles the account was actually using.
    expect(parked).not.toContain('p0');
    expect(parked).toContain(`p${freeLimit}`);
    // Switched off, never removed: the week of data entry survives.
    expect(products.update.mock.calls[0][1]).toEqual({ isActive: false });
  });

  it('leaves the trial date in place, so the week cannot be taken twice', async () => {
    const { service, users } = await build();

    await service.endTrial({ ...owner } as User);
    const saved = users.save.mock.calls[0][0];

    expect(saved.plan).toBe(UserPlan.Free);
    expect(saved.productLimit).toBe(PLAN_PRODUCT_LIMIT[UserPlan.Free]);
    expect(saved.trialEndsAt).not.toBeNull();
    // The free allowance is a one-off and the trial's comparisons were it.
    expect(saved.aiMatchesUsed).toBeGreaterThanOrEqual(PLAN_AI_MATCH_LIMIT[UserPlan.Free]);
  });
});
