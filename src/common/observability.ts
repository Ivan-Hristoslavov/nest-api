import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';

import { ObservabilityConfig } from '../config/configuration';

const logger = new Logger('Observability');

let active = false;

/**
 * Crash reporting, if it has been configured.
 *
 * Called before the Nest application is created, because Sentry's
 * instrumentation has to be in place before the modules it patches are
 * loaded — initialise it afterwards and the traces arrive with half the
 * context missing.
 *
 * Without a DSN this does nothing at all and says so once. That is the right
 * default for a laptop, and the loud line at boot is what stops a deployment
 * quietly running blind for a month.
 */
export function initObservability(config: ObservabilityConfig): void {
  if (!config.sentryDsn) {
    logger.warn(
      'SENTRY_DSN is not set — crashes will only appear in the logs. Set it before taking customers.',
    );
    return;
  }

  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.environment,
    tracesSampleRate: config.tracesSampleRate,
    // Bodies can carry a customer's supplier list, their negotiated discounts
    // and, on the auth routes, a live sign-in token. None of that belongs in a
    // third-party error tracker, and the stack trace is what makes a report
    // useful anyway.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;

        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers['x-api-key'];
          delete event.request.headers.cookie;
        }
      }

      return event;
    },
  });

  active = true;
  logger.log(`Crash reporting on, environment "${config.environment}".`);
}

/**
 * Reports one failure, with the account it happened to.
 *
 * The account is identified by id rather than by email: it is enough to tell
 * one customer's crash from another's when triaging, and it keeps the address
 * out of a system that is not ours.
 */
export function reportError(error: unknown, context: { path?: string; userId?: string }): void {
  if (!active) return;

  Sentry.withScope((scope) => {
    if (context.userId) scope.setUser({ id: context.userId });
    if (context.path) scope.setTag('path', context.path);
    Sentry.captureException(error);
  });
}

/** Whether reports are going anywhere. Used by the health endpoint. */
export function observabilityActive(): boolean {
  return active;
}
