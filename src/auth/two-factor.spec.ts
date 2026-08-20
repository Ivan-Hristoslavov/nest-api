import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User } from '../billing/entities/user.entity';
import { open } from './secret-box';
import { codeAt } from './totp';
import { TwoFactorService } from './two-factor.service';

const KEY = 'a-test-key-at-least-sixteen-characters-long';

/**
 * The second factor only earns its place if three things hold: the secret is
 * unreadable in the database, a recovery code works exactly once, and nothing
 * can switch the protection off without passing it.
 */
describe('the second factor', () => {
  let service: TwoFactorService;
  let stored: Partial<User>;
  let repository: {
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    stored = { id: 'u1', totpSecret: null, totpConfirmedAt: null, totpRecoveryHashes: null };

    repository = {
      update: jest.fn((_id: string, patch: Partial<User>) => {
        Object.assign(stored, patch);
        return Promise.resolve({ affected: 1 });
      }),
      // A chainable stub, built once and returned from every step, so the
      // service's `.addSelect().where().getOne()` reads the same as it does
      // against a real repository.
      createQueryBuilder: jest.fn(() => {
        const builder = {
          addSelect: () => builder,
          where: () => builder,
          getOne: () => Promise.resolve(stored as User),
        };
        return builder;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TwoFactorService,
        { provide: getRepositoryToken(User), useValue: repository },
        {
          provide: ConfigService,
          useValue: { get: () => ({ totpEncryptionKey: KEY, apiKeyHeader: 'x-api-key' }) },
        },
      ],
    }).compile();

    service = moduleRef.get(TwoFactorService);
  });

  it('never stores the secret in a readable form', async () => {
    const enrolment = await service.beginEnrolment('u1', 'kupuvach@example.com');

    expect(stored.totpSecret).toBeTruthy();
    // The thing in the column is not the thing the phone was given.
    expect(stored.totpSecret).not.toContain(enrolment.secret);
    // And it is only readable with the key held outside the database.
    expect(open(stored.totpSecret as string, KEY)).toBe(enrolment.secret);
    expect(open(stored.totpSecret as string, 'a-different-key-entirely-here')).toBeNull();
  });

  it('stores recovery codes as digests, never as themselves', async () => {
    const enrolment = await service.beginEnrolment('u1', 'kupuvach@example.com');

    expect(enrolment.recoveryCodes).toHaveLength(8);
    for (const code of enrolment.recoveryCodes) {
      expect(stored.totpRecoveryHashes).not.toContain(code);
    }
  });

  it('is not switched on until a working code proves the phone is set up', async () => {
    const enrolment = await service.beginEnrolment('u1', 'kupuvach@example.com');
    expect(stored.totpConfirmedAt).toBeNull();

    expect(await service.enable('u1', '000000')).toBe(false);
    expect(stored.totpConfirmedAt).toBeNull();

    expect(await service.enable('u1', codeAt(enrolment.secret))).toBe(true);
    expect(stored.totpConfirmedAt).toBeInstanceOf(Date);
  });

  it('spends a recovery code exactly once', async () => {
    const enrolment = await service.beginEnrolment('u1', 'kupuvach@example.com');
    const [first] = enrolment.recoveryCodes;

    expect(await service.verify('u1', first)).toBe(true);
    // The same piece of paper is worth nothing the second time.
    expect(await service.verify('u1', first)).toBe(false);
    expect(await service.recoveryCodesLeft('u1')).toBe(7);
  });

  it('refuses to switch itself off without a working code', async () => {
    const enrolment = await service.beginEnrolment('u1', 'kupuvach@example.com');
    await service.enable('u1', codeAt(enrolment.secret));

    // This is the case it exists for: a stolen session must not be able to
    // remove the protection it is defeated by.
    expect(await service.disable('u1', '000000')).toBe(false);
    expect(stored.totpConfirmedAt).toBeInstanceOf(Date);

    expect(await service.disable('u1', codeAt(enrolment.secret))).toBe(true);
    expect(stored.totpConfirmedAt).toBeNull();
    expect(stored.totpSecret).toBeNull();
  });
});

describe('a deployment with no encryption key', () => {
  it('refuses to set two-factor up rather than storing the secret in the open', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        TwoFactorService,
        { provide: getRepositoryToken(User), useValue: { update: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => ({ apiKeyHeader: 'x-api-key' }) } },
      ],
    }).compile();

    const service = moduleRef.get(TwoFactorService);

    expect(service.available).toBe(false);
    await expect(service.beginEnrolment('u1', 'kupuvach@example.com')).rejects.toThrow(
      /TOTP_ENCRYPTION_KEY/,
    );
  });
});
