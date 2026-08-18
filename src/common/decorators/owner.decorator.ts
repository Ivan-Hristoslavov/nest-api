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
 */
export const Owner = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

  if (!request.user) {
    throw new BadRequestException(
      'Това е операторски ключ — той няма акаунт и не вижда клиентски данни. ' +
        'Използвайте клиентски ключ.',
    );
  }

  return request.user.id;
});

/**
 * The whole account, for the handful of places that need more than its id —
 * chiefly the plan limits.
 *
 * Same refusal for an operator key, and for the same reason.
 */
export const OwnerAccount = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      throw new BadRequestException(
        'Това е операторски ключ — той няма акаунт и не вижда клиентски данни. ' +
          'Използвайте клиентски ключ.',
      );
    }

    return request.user;
  },
);
