import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { AuthenticatedRequest } from './api-key.guard';

/**
 * Restricts a route to operator keys.
 *
 * Runs after the global {@link ApiKeyGuard}, which has already authenticated
 * the caller and flagged whether the key came from the environment
 * (`API_KEY` / `API_KEYS`) or from the `users` table.
 *
 * The distinction matters for key recovery: a customer who lost their key
 * cannot present it, so the request has to be made by someone else. Letting a
 * *customer* key rotate an arbitrary account would turn "I know your email"
 * into "I can revoke your access", since rotation destroys the old key.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.isAdmin) {
      throw new ForbiddenException('This endpoint requires an operator API key.');
    }

    return true;
  }
}
