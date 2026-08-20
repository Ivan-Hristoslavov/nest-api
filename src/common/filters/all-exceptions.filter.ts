import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Request } from 'express';
import { QueryFailedError } from 'typeorm';

import { ErrorResponseDto } from '../dto/error-response.dto';
import { reportError } from '../observability';

/** PostgreSQL SQLSTATE codes we translate into meaningful HTTP statuses. */
const PG_ERROR_STATUS: Record<string, { status: HttpStatus; message: string }> = {
  '23505': {
    status: HttpStatus.CONFLICT,
    message: 'A record with these unique values already exists.',
  },
  '23503': {
    status: HttpStatus.CONFLICT,
    message: 'Referenced record does not exist or is still in use.',
  },
  '23502': { status: HttpStatus.BAD_REQUEST, message: 'A required field was missing.' },
  '22P02': { status: HttpStatus.BAD_REQUEST, message: 'Malformed value for one of the fields.' },
  '22003': { status: HttpStatus.BAD_REQUEST, message: 'Numeric value out of range.' },
};

interface DriverError {
  code?: string;
  detail?: string;
}

/**
 * Normalises every failure into {@link ErrorResponseDto} so clients (and the
 * OpenAPI contract) see one consistent error shape. Uses `HttpAdapterHost`
 * rather than the Express `Response` directly, keeping the filter valid if the
 * app is ever switched to Fastify.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();

    const { status, message, error } = this.resolve(exception);

    // `getRequestUrl` is typed loosely by the adapter interface; fall back to
    // the raw Express url when the adapter returns nothing.
    const path = (httpAdapter.getRequestUrl(request) as string | undefined) ?? request.url;

    const body: ErrorResponseDto = {
      statusCode: status,
      message,
      error,
      path,
      timestamp: new Date().toISOString(),
    };

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Sent onward as well as logged. A 500 nobody sees is a customer who
      // finds the bug before we do, and by then they have already decided
      // what the product is worth.
      reportError(exception, {
        path: body.path,
        userId: (request as { user?: { id?: string } }).user?.id,
      });

      this.logger.error(
        `${request.method} ${body.path} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${body.path} -> ${status}: ${JSON.stringify(message)}`);
    }

    httpAdapter.reply(ctx.getResponse(), body, status);
  }

  private resolve(exception: unknown): {
    status: HttpStatus;
    message: string | string[];
    error: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      if (typeof response === 'string') {
        return { status, message: response, error: exception.name };
      }

      const payload = response as { message?: string | string[]; error?: string };
      return {
        status,
        message: payload.message ?? exception.message,
        error: payload.error ?? exception.name,
      };
    }

    if (exception instanceof QueryFailedError) {
      const driverError = exception.driverError as DriverError | undefined;
      const mapped = driverError?.code ? PG_ERROR_STATUS[driverError.code] : undefined;

      if (mapped) {
        return { status: mapped.status, message: mapped.message, error: 'Database Constraint' };
      }

      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Database query failed.',
        error: 'Database Error',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error.',
      error: 'Internal Server Error',
    };
  }
}
