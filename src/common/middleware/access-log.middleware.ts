import { Logger } from '@nestjs/common';
import { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * One access-log line per request, registered with `app.use()` in `main.ts`.
 *
 * Deliberately middleware rather than an interceptor: interceptors run *after*
 * guards, so a request rejected by `ApiKeyGuard` (401) or the rate limiter
 * (429) never reaches them and leaves no trace in the HTTP log — exactly the
 * requests you most want to see. Middleware runs first and logs everything.
 *
 * Logs no headers and no bodies: the API key travels in a header and must never
 * reach the log sink.
 */
export function accessLogMiddleware(): RequestHandler {
  const logger = new Logger('HTTP');

  return (request: Request, response: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    let settled = false;

    const elapsedMs = (): string =>
      (Number(process.hrtime.bigint() - startedAt) / 1_000_000).toFixed(1);

    response.on('finish', () => {
      settled = true;
      const line = `${request.method} ${request.originalUrl} ${response.statusCode} ${elapsedMs()}ms`;

      if (response.statusCode >= 500) {
        logger.error(line);
      } else if (response.statusCode >= 400) {
        logger.warn(line);
      } else {
        logger.log(line);
      }
    });

    // 'close' without a prior 'finish' means the client hung up before the
    // response was sent — a browser tab closed, a timeout, or a dev-server
    // restart mid-request. Without this line such requests are invisible and
    // look like the server never received them.
    response.on('close', () => {
      if (!settled) {
        logger.warn(
          `${request.method} ${request.originalUrl} ABORTED by client after ${elapsedMs()}ms`,
        );
      }
    });

    next();
  };
}
