import { createHash, timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { User } from '../../billing/entities/user.entity';
import { UsersService } from '../../billing/users.service';
import { KeyRevocationService } from '../key-revocation.service';
import { Configuration } from '../../config/configuration';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/** The authenticated principal, attached to the request for downstream use. */
export interface AuthenticatedRequest extends Request {
  user?: User;
  /** True when the caller used an operator key from the environment. */
  isAdmin?: boolean;
}

interface CacheEntry {
  /** The revocation epoch this entry was created under. */
  epoch: number;
  user: User | null;
  expiresAt: number;
}

/**
 * Authenticates callers with an API key in the `X-API-KEY` header.
 *
 * Two kinds of key are accepted:
 *
 * 1. **Customer keys**, issued by `BillingModule` when a payment succeeds and
 *    stored as a SHA-256 hash on the `users` table. The guard hashes the
 *    presented key and looks it up, then checks the account is active and not
 *    expired.
 * 2. **Operator keys**, from `API_KEY` / `API_KEYS`. These exist because the
 *    system must be administrable before any customer exists — seeding,
 *    migrations, health tooling and the very first product all predate the
 *    first payment. They are compared in constant time.
 *
 * Successful lookups are cached briefly. Without the cache every request pays a
 * database round trip — around 55ms against a database in another region, which
 * would dominate the response time of endpoints that otherwise take 60ms.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly headerName: string;
  private readonly operatorKeyDigests: Buffer[];
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  /** Bounds the cache so a key-guessing flood cannot grow it without limit. */
  private static readonly MAX_CACHE_ENTRIES = 5000;

  constructor(
    private readonly reflector: Reflector,
    private readonly usersService: UsersService,
    private readonly revocations: KeyRevocationService,
    configService: ConfigService<Configuration, true>,
  ) {
    const auth = configService.get('auth', { infer: true });
    this.headerName = auth.apiKeyHeader;
    this.cacheTtlMs = auth.keyCacheTtlMs;
    this.operatorKeyDigests = auth.apiKeys.map((key) =>
      createHash('sha256').update(key, 'utf8').digest(),
    );

    if (this.operatorKeyDigests.length === 0) {
      this.logger.warn(
        'No operator API keys configured. Only customer keys issued through billing will be accepted.',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const presentedKey = this.extractKey(request);

    if (!presentedKey) {
      throw new UnauthorizedException(
        `Missing API key. Send it in the '${this.headerName}' header.`,
      );
    }

    // Operator keys first: an in-memory comparison, no database involved.
    if (this.isOperatorKey(presentedKey)) {
      request.isAdmin = true;
      return true;
    }

    const user = await this.resolveUser(presentedKey);

    if (!user) {
      this.logger.warn(
        `Rejected ${request.method} ${request.originalUrl} from ${request.ip ?? 'unknown'}: unknown API key.`,
      );
      throw new UnauthorizedException('Invalid API key.');
    }

    if (!user.isActive()) {
      // 403, not 401: the key is genuine, the subscription is not. Telling the
      // two apart is what lets a client show "renew your plan" instead of
      // "check your credentials".
      throw new ForbiddenException(
        `Account is ${user.status}. Renew your subscription to reactivate this API key.`,
      );
    }

    request.user = user;
    request.isAdmin = false;
    this.usersService.touchLastUsed(user.id);

    return true;
  }

  private extractKey(request: Request): string | undefined {
    const headerValue = request.headers[this.headerName];
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return raw?.trim() || undefined;
  }

  private isOperatorKey(presentedKey: string): boolean {
    if (this.operatorKeyDigests.length === 0) return false;

    const presentedDigest = createHash('sha256').update(presentedKey, 'utf8').digest();

    // `reduce` rather than `some` so every candidate is compared and the total
    // work does not depend on which key matched.
    return this.operatorKeyDigests.reduce(
      (matched, digest) => timingSafeEqual(presentedDigest, digest) || matched,
      false,
    );
  }

  /** Cached lookup. Negative results are cached too, so a flood of invalid keys
   * cannot be turned into a flood of database queries. */
  private async resolveUser(presentedKey: string): Promise<User | null> {
    const cacheKey = createHash('sha256').update(presentedKey, 'utf8').digest('hex');
    const cached = this.cache.get(cacheKey);

    // A revocation since this entry was written makes it stale regardless of
    // its age: rotating a key or erasing an account must take effect now, not
    // when the TTL happens to lapse.
    if (cached && cached.expiresAt > Date.now() && cached.epoch === this.revocations.currentEpoch) {
      return cached.user;
    }

    const user = await this.usersService.findByApiKey(presentedKey);

    if (this.cache.size >= ApiKeyGuard.MAX_CACHE_ENTRIES) {
      this.cache.clear();
    }

    this.cache.set(cacheKey, {
      user,
      expiresAt: Date.now() + this.cacheTtlMs,
      epoch: this.revocations.currentEpoch,
    });
    return user;
  }

  /**
   * Drops a key from the cache.
   * Called after rotation or cancellation so revocation takes effect at once
   * instead of after the TTL.
   */
  invalidate(plaintextKey: string): void {
    this.cache.delete(createHash('sha256').update(plaintextKey, 'utf8').digest('hex'));
  }

  /** Empties the cache. Used by tests and by the admin revocation path. */
  invalidateAll(): void {
    this.cache.clear();
  }
}
