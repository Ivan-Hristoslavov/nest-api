import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ServerResponse } from 'node:http';
import { join } from 'node:path';

import helmet from 'helmet';

import { AppModule } from './app.module';
import { accessLogMiddleware } from './common/middleware/access-log.middleware';
import { AppConfig, CurrencyConfig } from './config/configuration';
import { convertibleCurrencies, setRatesPerEur } from './products/currency';
import { NodeEnvironment } from './config/env.validation';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffer startup logs until the app is ready, so nothing is lost when
    // initialization fails (e.g. a bad Supabase connection string).
    bufferLogs: true,
    // Keeps the untouched request bytes on `request.rawBody`. Billing webhook
    // signatures are computed over exactly those bytes: parsing and
    // re-serialising the JSON reorders keys and breaks every signature check.
    rawBody: true,
  });

  const logger = new Logger('Bootstrap');
  const appConfig = app.get(ConfigService).getOrThrow<AppConfig>('app');
  const isProduction = appConfig.nodeEnv === NodeEnvironment.Production;

  // Installed once, here, so the currency module stays a pure function nothing
  // has to inject a ConfigService to use. Without rates the pegged BGN/EUR
  // pair still converts and everything else reports itself uncomparable —
  // which is the honest answer, not a bug.
  setRatesPerEur(app.get(ConfigService).getOrThrow<CurrencyConfig>('currency').ratesPerEur);

  app.flushLogs();

  // First in the chain: every request is logged, including the ones guards
  // reject before any interceptor would run.
  app.use(accessLogMiddleware());

  // --- Security ------------------------------------------------------------
  app.use(
    helmet({
      // Swagger UI needs inline styles and scripts that helmet's default CSP
      // blocks, which would render the docs page blank.
      contentSecurityPolicy: appConfig.swaggerEnabled ? false : undefined,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    origin: appConfig.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'X-API-KEY'],
    credentials: false,
    maxAge: 86_400,
  });

  // Behind a load balancer the caller's IP arrives in X-Forwarded-For; without
  // this the rate limiter buckets every client into the proxy's single IP.
  if (isProduction) {
    app.set('trust proxy', 1);
  }

  // --- Static frontend -----------------------------------------------------
  // `public/` is served from the project root rather than `__dirname`, so the
  // same path works whether the app runs from `src` (ts-node) or `dist`.
  app.useStaticAssets(join(process.cwd(), 'public'), {
    index: ['index.html'],
    maxAge: isProduction ? '1h' : 0,
    setHeaders: (response: ServerResponse, path: string) => {
      // The UI is one file with its JavaScript inlined, so a cached copy is a
      // cached *application*. `max-age=0` still permits a browser to answer
      // from its in-memory cache without revalidating, which silently keeps
      // old code running after an edit. Outside production, forbid storing it
      // at all — the file is 130 KB on localhost, the cost is nil.
      if (!isProduction && path.endsWith('.html')) {
        response.setHeader('Cache-Control', 'no-store, must-revalidate');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Expires', '0');
      }
    },
  });

  // --- Routing -------------------------------------------------------------
  // `/health` stays outside the version prefix so uptime probes keep working
  // across future API versions.
  app.setGlobalPrefix(appConfig.apiPrefix, { exclude: ['health'] });

  // --- Request handling ----------------------------------------------------
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip undecorated properties and reject requests that send them: a
      // silently ignored typo in a field name is a debugging nightmare.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Turn plain JSON into DTO instances so @Type/@Transform run and
      // controllers receive real class instances.
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Close database connections and stop cron jobs on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // --- Documentation -------------------------------------------------------
  if (appConfig.swaggerEnabled) {
    setupSwagger(app, appConfig);
  }

  await app.listen(appConfig.port, '0.0.0.0');

  const url = await app.getUrl();
  logger.log(`Price Intelligence API running in ${appConfig.nodeEnv} mode`);
  logger.log(`REST API      ${url}/${appConfig.apiPrefix}`);
  logger.log(`Health probe  ${url}/health`);
  logger.log(`Currencies    ${convertibleCurrencies().join(', ')}`);

  if (appConfig.swaggerEnabled) {
    logger.log(`Swagger UI    ${url}/${appConfig.swaggerPath}`);
    logger.log(`OpenAPI JSON  ${url}/${appConfig.swaggerPath}-json`);
  }
}

void bootstrap();
