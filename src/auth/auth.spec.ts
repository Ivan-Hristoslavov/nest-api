import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User } from '../billing/entities/user.entity';
import { MailService } from '../billing/mail.service';
import { UsersService } from '../billing/users.service';
import { AuthService } from './auth.service';
import { AuthToken, AuthTokenKind } from './entities/auth-token.entity';

/**
 * Sign-in is the one flow where a mistake hands somebody another person's
 * prices. These pin the three ways that happens: a link that outlives its
 * welcome, a link that works twice, and an endpoint that reveals who has an
 * account.
 */
describe('AuthService', () => {
  let service: AuthService;
  let tokens: {
    findOne: jest.Mock<Promise<AuthToken | null>, [unknown]>;
    create: jest.Mock<AuthToken, [Partial<AuthToken>]>;
    save: jest.Mock<Promise<AuthToken>, [AuthToken]>;
    update: jest.Mock<Promise<void>, [unknown, unknown]>;
    delete: jest.Mock<Promise<{ affected: number }>, [unknown]>;
  };
  let users: {
    findByEmail: jest.Mock<Promise<User | null>, [string]>;
    findOne: jest.Mock<Promise<User>, [string]>;
  };
  let mail: { sendSignInLink: jest.Mock<Promise<boolean>, [User, string, number]> };

  const account = { id: 'u1', email: 'kupuvach@example.com' } as User;

  /** A stored row, with only the fields a given test cares about. */
  const row = (over: Partial<AuthToken>): AuthToken => ({
    id: 't1',
    userId: 'u1',
    tokenHash: 'x'.repeat(64),
    kind: AuthTokenKind.SignInLink,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    lastUsedAt: null,
    userAgent: null,
    createdAt: new Date(),
    ...over,
  });

  beforeEach(async () => {
    tokens = {
      findOne: jest.fn<Promise<AuthToken | null>, [unknown]>().mockResolvedValue(null),
      create: jest.fn<AuthToken, [Partial<AuthToken>]>((input) => input as AuthToken),
      save: jest.fn<Promise<AuthToken>, [AuthToken]>((input) =>
        Promise.resolve({ ...input, id: input.id ?? 't1' }),
      ),
      update: jest.fn<Promise<void>, [unknown, unknown]>().mockResolvedValue(undefined),
      delete: jest
        .fn<Promise<{ affected: number }>, [unknown]>()
        .mockResolvedValue({ affected: 1 }),
    };
    users = {
      findByEmail: jest.fn<Promise<User | null>, [string]>().mockResolvedValue(account),
      findOne: jest.fn<Promise<User>, [string]>().mockResolvedValue(account),
    };
    mail = {
      sendSignInLink: jest.fn<Promise<boolean>, [User, string, number]>().mockResolvedValue(true),
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

  it('emails a link that is stored only as a digest', async () => {
    await service.requestSignInLink('kupuvach@example.com', 'https://app.example');

    const stored = tokens.save.mock.calls[0][0];
    const emailedUrl = mail.sendSignInLink.mock.calls[0][1];
    const emailedToken = emailedUrl.split('#signin=')[1];

    expect(stored.kind).toBe(AuthTokenKind.SignInLink);
    expect(stored.tokenHash).toHaveLength(64);
    // The thing in the email must not be the thing in the database.
    expect(stored.tokenHash).not.toContain(emailedToken);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('says nothing and sends nothing for an address with no account', async () => {
    users.findByEmail.mockResolvedValue(null);

    await expect(
      service.requestSignInLink('stranger@example.com', 'https://app.example'),
    ).resolves.toBeUndefined();

    expect(mail.sendSignInLink).not.toHaveBeenCalled();
    expect(tokens.save).not.toHaveBeenCalled();
  });

  it('refuses a link that has already been spent', async () => {
    tokens.findOne.mockResolvedValue(
      row({
        id: 't1',
        userId: 'u1',
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    await expect(service.exchange('pg_link_x')).resolves.toEqual({ failure: 'used' });
  });

  it('refuses a link that has expired', async () => {
    tokens.findOne.mockResolvedValue(
      row({
        id: 't1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      }),
    );

    await expect(service.exchange('pg_link_x')).resolves.toEqual({ failure: 'expired' });
  });

  it('marks the link spent before the session exists', async () => {
    tokens.findOne.mockResolvedValue(
      row({
        id: 't1',
        userId: 'u1',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const result = await service.exchange('pg_link_x', 'Firefox');
    const issued = 'token' in result ? result.token : '';

    expect(tokens.update).toHaveBeenCalledWith({ id: 't1' }, { usedAt: expect.any(Date) as Date });
    expect(issued.startsWith('pg_sess_')).toBe(true);
    // Ordering matters: a link raced twice must not yield two sessions.
    expect(tokens.update.mock.invocationCallOrder[0]).toBeLessThan(
      tokens.save.mock.invocationCallOrder[0],
    );
  });

  it('does not resolve an expired session', async () => {
    tokens.findOne.mockResolvedValue(
      row({
        id: 's1',
        userId: 'u1',
        expiresAt: new Date(Date.now() - 1000),
      }),
    );

    await expect(service.resolveSession('pg_sess_x')).resolves.toBeNull();
  });

  it('stops one mailbox being buried, however many addresses ask', async () => {
    // The controller's throttle counts requests per IP, so a caller with a
    // pool of them is unlimited by it. This counts per mailbox instead.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await service.requestSignInLink('kupuvach@example.com', 'https://app.example');
    }

    expect(mail.sendSignInLink).toHaveBeenCalledTimes(4);

    await service.requestSignInLink('kupuvach@example.com', 'https://app.example');

    expect(mail.sendSignInLink).toHaveBeenCalledTimes(4);
    // And nothing was written either — a suppressed link leaves no live token.
    expect(tokens.save).toHaveBeenCalledTimes(4);
  });

  it('signs out one device without touching the others', async () => {
    await service.signOut('pg_sess_x');

    expect(tokens.delete).toHaveBeenCalledWith({
      tokenHash: expect.any(String) as string,
      kind: AuthTokenKind.Session,
    });
  });
});
