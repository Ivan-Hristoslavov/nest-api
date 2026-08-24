import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User, UserStatus } from '../billing/entities/user.entity';
import { MailService } from '../billing/mail.service';
import { UsersService } from '../billing/users.service';
import { AuthService } from './auth.service';
import { classifyEmail } from './disposable-domains';
import { AuthToken, AuthTokenKind } from './entities/auth-token.entity';

/**
 * Registration used to hand the API key back in its own response, which made
 * the email address decoration: a script could farm accounts, and their
 * monthly AI allowances, from mailboxes nobody owns. These pin the shape that
 * replaced it — nothing is granted until somebody opens the mail.
 */
describe('registration', () => {
  let service: AuthService;
  let users: {
    findByEmail: jest.Mock<Promise<User | null>, [string]>;
    findOne: jest.Mock<Promise<User>, [string]>;
    createPendingAccount: jest.Mock<Promise<User>, [string, string | undefined, string | undefined]>;
    rememberLocale: jest.Mock<Promise<void>, [User, string | undefined]>;
    activateWithTrial: jest.Mock<Promise<{ user: User; apiKey: string }>, [string]>;
  };
  let mail: {
    sendVerificationLink: jest.Mock<Promise<boolean>, [User, string, number]>;
    sendSignInLink: jest.Mock<Promise<boolean>, [User, string, number]>;
    sendApiKey: jest.Mock<Promise<boolean>, [User, string]>;
  };
  let tokens: {
    findOne: jest.Mock<Promise<AuthToken | null>, [unknown]>;
    create: jest.Mock<AuthToken, [Partial<AuthToken>]>;
    save: jest.Mock<Promise<AuthToken>, [AuthToken]>;
    update: jest.Mock<Promise<void>, [unknown, unknown]>;
    delete: jest.Mock<Promise<{ affected: number }>, [unknown]>;
  };

  const pending = {
    id: 'u1',
    email: 'kupuvach@moiat-magazin.bg',
    status: UserStatus.Pending,
    totpConfirmedAt: null,
    // The fixture is a plain object, so the entity's own methods have to be
    // supplied: `exchange` asks whether a second factor is owed.
    hasTwoFactor: () => false,
  } as unknown as User;

  beforeEach(async () => {
    tokens = {
      findOne: jest.fn<Promise<AuthToken | null>, [unknown]>().mockResolvedValue(null),
      create: jest.fn<AuthToken, [Partial<AuthToken>]>((input) => input as AuthToken),
      save: jest.fn<Promise<AuthToken>, [AuthToken]>((input) => Promise.resolve(input)),
      update: jest.fn<Promise<void>, [unknown, unknown]>().mockResolvedValue(undefined),
      delete: jest
        .fn<Promise<{ affected: number }>, [unknown]>()
        .mockResolvedValue({ affected: 0 }),
    };
    users = {
      findByEmail: jest.fn<Promise<User | null>, [string]>().mockResolvedValue(null),
      findOne: jest.fn<Promise<User>, [string]>().mockResolvedValue(pending),
      createPendingAccount: jest
        .fn<Promise<User>, [string, string | undefined, string | undefined]>()
        .mockResolvedValue(pending),
      rememberLocale: jest.fn<Promise<void>, [User, string | undefined]>().mockResolvedValue(),
      activateWithTrial: jest
        .fn<Promise<{ user: User; apiKey: string }>, [string]>()
        .mockResolvedValue({
          user: { ...pending, status: UserStatus.Active } as User,
          apiKey: 'pk_live_new',
        }),
    };
    mail = {
      sendVerificationLink: jest
        .fn<Promise<boolean>, [User, string, number]>()
        .mockResolvedValue(true),
      sendSignInLink: jest.fn<Promise<boolean>, [User, string, number]>().mockResolvedValue(true),
      sendApiKey: jest.fn<Promise<boolean>, [User, string]>().mockResolvedValue(true),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(AuthToken), useValue: tokens },
        { provide: UsersService, useValue: users },
        { provide: MailService, useValue: mail },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  it('creates nothing usable until the mailbox is opened', async () => {
    await service.register('kupuvach@moiat-magazin.bg', 'Магазин', 'https://app.example');

    // A pending row and a link. No key, no active account.
    expect(users.createPendingAccount).toHaveBeenCalled();
    expect(users.activateWithTrial).not.toHaveBeenCalled();
    expect(mail.sendVerificationLink).toHaveBeenCalled();

    const stored = tokens.save.mock.calls[0][0];
    expect(stored.kind).toBe(AuthTokenKind.Verification);
  });

  it('refuses a throwaway mailbox', async () => {
    await expect(
      service.register('someone@mailinator.com', undefined, 'https://app.example'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(users.createPendingAccount).not.toHaveBeenCalled();
  });

  it('refuses an address that can never receive mail', async () => {
    // RFC 2606 reserves example.com precisely so it cannot be delivered to —
    // an account keyed on one could never be verified.
    await expect(
      service.register('test@example.com', undefined, 'https://app.example'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends an existing account a sign-in link rather than a second registration', async () => {
    users.findByEmail.mockResolvedValue({ ...pending, status: UserStatus.Active } as User);

    await service.register('kupuvach@moiat-magazin.bg', undefined, 'https://app.example');

    expect(users.createPendingAccount).not.toHaveBeenCalled();
    expect(mail.sendSignInLink).toHaveBeenCalled();
    expect(mail.sendVerificationLink).not.toHaveBeenCalled();
  });

  it('opens the account and issues the key when the link is used', async () => {
    tokens.findOne.mockResolvedValue({
      id: 't1',
      userId: 'u1',
      tokenHash: 'x'.repeat(64),
      kind: AuthTokenKind.Verification,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      lastUsedAt: null,
      userAgent: null,
      createdAt: new Date(),
    });

    const result = await service.exchange('pg_link_x');

    expect(users.activateWithTrial).toHaveBeenCalledWith('u1');
    expect('apiKey' in result && result.apiKey).toBe('pk_live_new');
    // The key also goes to the mailbox, because the browser shows it once.
    expect(mail.sendApiKey).toHaveBeenCalled();
  });

  it('knows which addresses are worth refusing', () => {
    expect(classifyEmail('a@moiat-magazin.bg')).toBe('ok');
    expect(classifyEmail('a@mailinator.com')).toBe('disposable');
    expect(classifyEmail('a@example.com')).toBe('unroutable');
    expect(classifyEmail('a@something.invalid')).toBe('unroutable');
  });
});

/**
 * Activation must never cost somebody their working key.
 *
 * `apiKeyHash` carries `select: false`, so it is absent from an ordinary
 * lookup — testing it for "does this account have a key" answered no for every
 * account, and rotated a credential that was in daily use.
 */
describe('activating an account that already has a key', () => {
  it('keeps the existing key rather than rotating it', async () => {
    const repository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'u1',
        email: 'kupuvach@example.com',
        status: UserStatus.Active,
        // What a real lookup returns: a prefix, and no hash.
        apiKeyPrefix: 'pk_live_QB-SxMCX',
        apiKeyHash: undefined,
      }),
      save: jest.fn((input: User) => Promise.resolve(input)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, { provide: getRepositoryToken(User), useValue: repository }],
    }).compile();

    const service = moduleRef.get(UsersService);
    const result = await service.activateFreeAccount('u1');

    expect(result.apiKey).toBe('');
    // Nothing was written: no rotation, and no needless status update.
    expect(repository.save).not.toHaveBeenCalled();
  });
});
