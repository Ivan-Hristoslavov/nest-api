import { createHash, timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

import { Configuration } from '../../config/configuration';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Authenticates callers with a shared secret sent in a request header
 * (default: `X-API-KEY`).
 *
 * Registered globally in `AppModule` via `APP_GUARD`, so every route is
 * protected by default; opt out explicitly with `@Public()`.
 *
 * The comparison is constant-time over SHA-256 digests: hashing first
 * normalises the length (so `timingSafeEqual` never throws on mismatched
 * buffer sizes) and prevents the byte-by-byte early exit that would leak the
 * key one character at a time.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly headerName: string;
  private readonly keyDigests: Buffer[];

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService<Configuration, true>,
  ) {
    const auth = this.configService.get('auth', { infer: true });
    this.headerName = auth.apiKeyHeader;
    this.keyDigests = auth.apiKeys.map((key) => createHash('sha256').update(key, 'utf8').digest());

    if (this.keyDigests.length === 0) {
      // Fail closed rather than silently accepting every request.
      this.logger.error('No API keys configured — all protected routes will reject requests.');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presentedKey = this.extractKey(request);

    if (!presentedKey) {
      throw new UnauthorizedException(
        `Missing API key. Send it in the '${this.headerName}' header.`,
      );
    }

    if (!this.isValidKey(presentedKey)) {
      this.logger.warn(
        `Rejected request ${request.method} ${request.originalUrl} from ${request.ip ?? 'unknown'}: invalid API key.`,
      );
      throw new UnauthorizedException('Invalid API key.');
    }

    return true;
  }

  private extractKey(request: Request): string | undefined {
    const headerValue = request.headers[this.headerName];
    const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return raw?.trim() || undefined;
  }

  private isValidKey(presentedKey: string): boolean {
    const presentedDigest = createHash('sha256').update(presentedKey, 'utf8').digest();

    // `reduce` instead of `some` so every candidate is compared and the
    // total work does not depend on which key matched.
    return this.keyDigests.reduce(
      (matched, digest) => timingSafeEqual(presentedDigest, digest) || matched,
      false,
    );
  }
}
