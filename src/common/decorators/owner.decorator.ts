import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';

import { User } from '../../billing/entities/user.entity';
import { AuthenticatedRequest } from '../guards/api-key.guard';

/**
 * The account that owns everything this request may touch.
 *
 * Every data endpoint takes this and passes it to its service, and every
 * service filters on it. Making it a required parameter rather than something
 * a service could read for itself is the point: forget it anywhere and the
 * compiler objects, whereas an implicit context silently returns another
 * customer's rows.
 *
 * What is at stake is not only privacy. The comparison ranks by each
 * customer's *negotiated discount*, so an unscoped query publishes the terms
 * one buyer agreed with a supplier to whoever else holds a key.
 *
 * An operator key authenticates without belonging to anyone, so it has no
 * owner and is refused here — the same answer `/billing/me` gives. Operator
 * keys are for the billing and customer screens; customer data needs a
 * customer key.
 *
 * The rule lives in {@link resolveOwnerAccount} rather than inline, because
 * `createParamDecorator` returns a decorator *factory* and not the function it
 * wraps: a test reaching through the decorator gets the factory. This is a
 * rule worth asserting directly — it is the single line standing between an
 * operator key and an unfiltered tenant query.
 */
export function resolveOwnerAccount(context: ExecutionContext): User {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

  if (!request.user) {
    throw new BadRequestException(
      'Това е операторски ключ — той няма акаунт и не вижда клиентски данни. ' +
        'Използвайте клиентски ключ.',
    );
  }

  return request.user;
}

export const Owner = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => resolveOwnerAccount(context).id,
);

/**
 * The whole account, for the handful of places that need more than its id —
 * chiefly the plan limits.
 *
 * Same refusal for an operator key, and for the same reason.
 */
export const OwnerAccount = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => resolveOwnerAccount(context),
);

/**
 * The account behind this request, or null for an operator key.
 *
 * The exception rather than the rule, and it exists for one shape of endpoint:
 * an operator tool that acts *on* a customer's data rather than on its own.
 * The search debugger is the case — an operator has no supplier list of their
 * own, so the account to search is named in the request instead of inferred
 * from the key.
 *
 * Deliberately not a general-purpose relaxation. Every customer-facing route
 * keeps {@link Owner}, which refuses an operator key outright; this returns
 * null and makes the caller decide, which is only safe where the route is
 * already behind the operator guard.
 */
export const OptionalOwner = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user?.id ?? null,
);
