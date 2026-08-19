import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { User, UserStatus } from '../../billing/entities/user.entity';
import { UsersService } from '../../billing/users.service';
import { Configuration } from '../../config/configuration';
import { KeyRevocationService } from '../key-revocation.service';
import { ApiKeyGuard, AuthenticatedRequest } from './api-key.guard';

const OPERATOR_KEY = 'pk_operator_valid_key_0123456789';
const ROTATED_OPERATOR_KEY = 'pk_operator_rotated_key_98765432';
const CUSTOMER_KEY = 'pk_live_customer_key_abcdefghijkl';

function buildUser(overrides: Partial<User> = {}): User {
  const user = new User();

  Object.assign(user, {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'customer@example.com',
    status: UserStatus.Active,
    accessExpiresAt: null,
    ...overrides,
  });

  return user;
}

function createContext(headers: Record<string, string | string[]> = {}): {
  context: ExecutionContext;
  request: AuthenticatedRequest;
} {
  const request = {
    headers,
    method: 'GET',
    originalUrl: '/api/v1/products',
    ip: '127.0.0.1',
  } as unknown as AuthenticatedRequest;

  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext,
  };
}

function createGuard(options: {
  operatorKeys?: string[];
  user?: User | null;
  sessionUser?: User | null;
  isPublic?: boolean;
  cacheTtlMs?: number;
}): {
  guard: ApiKeyGuard;
  usersService: { findByApiKey: jest.Mock; touchLastUsed: jest.Mock };
  sessions: { resolveSession: jest.Mock };
  revocations: KeyRevocationService;
} {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(options.isPublic ?? false),
  } as unknown as Reflector;

  const usersService = {
    findByApiKey: jest.fn().mockResolvedValue(options.user ?? null),
    touchLastUsed: jest.fn(),
  };

  const configService = {
    get: jest.fn().mockReturnValue({
      apiKeyHeader: 'x-api-key',
      apiKeys: options.operatorKeys ?? [OPERATOR_KEY, ROTATED_OPERATOR_KEY],
      keyCacheTtlMs: options.cacheTtlMs ?? 30000,
    }),
  } as unknown as ConfigService<Configuration, true>;

  const revocations = new KeyRevocationService();
  const sessions = { resolveSession: jest.fn().mockResolvedValue(options.sessionUser ?? null) };

  return {
    guard: new ApiKeyGuard(
      reflector,
      usersService as unknown as UsersService,
      sessions,
      revocations,
      configService,
    ),
    usersService,
    sessions,
    revocations,
  };
}

describe('ApiKeyGuard', () => {
  describe('operator keys', () => {
    it('accepts a key from the environment without touching the database', async () => {
      const { guard, usersService } = createGuard({});
      const { context, request } = createContext({ 'x-api-key': OPERATOR_KEY });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.isAdmin).toBe(true);
      expect(usersService.findByApiKey).not.toHaveBeenCalled();
    });

    it('accepts any key from the rotation list', async () => {
      const { guard } = createGuard({});
      const { context } = createContext({ 'x-api-key': ROTATED_OPERATOR_KEY });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('rejects a key that is only a prefix of a valid one', async () => {
      const { guard } = createGuard({});
      const { context } = createContext({ 'x-api-key': OPERATOR_KEY.slice(0, -1) });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('customer keys', () => {
    it('accepts an active customer and attaches them to the request', async () => {
      const user = buildUser();
      const { guard, usersService } = createGuard({ user });
      const { context, request } = createContext({ 'x-api-key': CUSTOMER_KEY });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toBe(user);
      expect(request.isAdmin).toBe(false);
      expect(usersService.touchLastUsed).toHaveBeenCalledWith(user.id);
    });

    it('rejects an unknown key', async () => {
      const { guard } = createGuard({ user: null });
      const { context } = createContext({ 'x-api-key': CUSTOMER_KEY });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses a pending account with 403, not 401', async () => {
      const { guard } = createGuard({ user: buildUser({ status: UserStatus.Pending }) });
      const { context } = createContext({ 'x-api-key': CUSTOMER_KEY });

      // The key is genuine; the subscription is not. A client must be able to
      // tell "renew your plan" from "check your credentials".
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an expired account', async () => {
      const { guard } = createGuard({ user: buildUser({ status: UserStatus.Expired }) });
      const { context } = createContext({ 'x-api-key': CUSTOMER_KEY });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an active account whose access window has elapsed', async () => {
      const { guard } = createGuard({
        user: buildUser({ accessExpiresAt: new Date(Date.now() - 1000) }),
      });
      const { context } = createContext({ 'x-api-key': CUSTOMER_KEY });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('caching', () => {
    it('resolves a repeated key from cache instead of querying again', async () => {
      const { guard, usersService } = createGuard({ user: buildUser() });

      await guard.canActivate(createContext({ 'x-api-key': CUSTOMER_KEY }).context);
      await guard.canActivate(createContext({ 'x-api-key': CUSTOMER_KEY }).context);
      await guard.canActivate(createContext({ 'x-api-key': CUSTOMER_KEY }).context);

      expect(usersService.findByApiKey).toHaveBeenCalledTimes(1);
    });

    it('caches misses too, so invalid keys cannot flood the database', async () => {
      const { guard, usersService } = createGuard({ user: null });

      await expect(
        guard.canActivate(createContext({ 'x-api-key': CUSTOMER_KEY }).context),
      ).rejects.toThrow();
      await expect(
        guard.canActivate(createContext({ 'x-api-key': CUSTOMER_KEY }).context),
      ).rejects.toThrow();

      expect(usersService.findByApiKey).toHaveBeenCalledTimes(1);
    });

    it('re-queries after the entry is invalidated', async () => {
      const { guard, usersService } = createGuard({ user: buildUser() });

      await guard.canActivate(createContext({ 'x-api-key': CUSTOMER_KEY }).context);
      guard.invalidate(CUSTOMER_KEY);
      await guard.canActivate(createContext({ 'x-api-key': CUSTOMER_KEY }).context);

      expect(usersService.findByApiKey).toHaveBeenCalledTimes(2);
    });
  });

  describe('request shape', () => {
    it('rejects a request without the header', async () => {
      const { guard } = createGuard({});

      await expect(guard.canActivate(createContext().context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an empty header value', async () => {
      const { guard } = createGuard({});
      const { context } = createContext({ 'x-api-key': '   ' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('lets @Public() routes through untouched', async () => {
      const { guard, usersService } = createGuard({ isPublic: true });

      await expect(guard.canActivate(createContext().context)).resolves.toBe(true);
      expect(usersService.findByApiKey).not.toHaveBeenCalled();
    });
  });
});

describe('revocation beats the cache', () => {
  it('stops honouring a cached key the moment one is revoked', async () => {
    const user = {
      id: 'u1',
      status: UserStatus.Active,
      isActive: () => true,
    } as unknown as User;

    const { guard, usersService, revocations } = createGuard({ user });

    const first = createContext({ 'x-api-key': 'pk_live_customer' });
    await expect(guard.canActivate(first.context)).resolves.toBe(true);

    // Second call is served from the cache — no second lookup.
    const second = createContext({ 'x-api-key': 'pk_live_customer' });
    await expect(guard.canActivate(second.context)).resolves.toBe(true);
    expect(usersService.findByApiKey).toHaveBeenCalledTimes(1);

    // Rotation or erasure happens elsewhere; the account is gone.
    revocations.revokeCachedKeys('erased in a test');
    usersService.findByApiKey.mockResolvedValue(null);

    const third = createContext({ 'x-api-key': 'pk_live_customer' });
    await expect(guard.canActivate(third.context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.findByApiKey).toHaveBeenCalledTimes(2);
  });
});

describe('sessions', () => {
  const signedIn = {
    id: 'u1',
    email: 'kupuvach@example.com',
    status: UserStatus.Active,
    isActive: () => true,
  } as unknown as User;

  it('accepts a browser signed in with a link', async () => {
    const { guard, sessions, usersService } = createGuard({ sessionUser: signedIn });
    const { context, request } = createContext({ authorization: 'Bearer pg_sess_abc' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBe(signedIn);
    expect(request.isAdmin).toBe(false);
    expect(sessions.resolveSession).toHaveBeenCalledWith('pg_sess_abc');
    // A session is not a key: no key lookup happens at all.
    expect(usersService.findByApiKey).not.toHaveBeenCalled();
  });

  it('refuses an expired session with a message a person can act on', async () => {
    const { guard } = createGuard({ sessionUser: null });
    const { context } = createContext({ authorization: 'Bearer pg_sess_stale' });

    await expect(guard.canActivate(context)).rejects.toThrow(/Влезте отново/);
  });

  it('still accepts an API key when no session is presented', async () => {
    const { guard } = createGuard({ user: signedIn });
    const { context, request } = createContext({ 'x-api-key': 'pk_live_customer' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBe(signedIn);
  });
});
