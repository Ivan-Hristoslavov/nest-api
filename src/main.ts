import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { accessLogMiddleware } from './common/middleware/access-log.middleware';
import { AppConfig } from './config/configuration';
import { NodeEnvironment } from './config/env.validation';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffer startup logs until the app is ready, so nothing is lost when
    // initialization fails (e.g. a bad Supabase connection string).
    bufferLogs: true,
  });

  const logger = new Logger('Bootstrap');
  const appConfig = app.get(ConfigService).getOrThrow<AppConfig>('app');
  const isProduction = appConfig.nodeEnv === NodeEnvironment.Production;

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

  if (appConfig.swaggerEnabled) {
    logger.log(`Swagger UI    ${url}/${appConfig.swaggerPath}`);
    logger.log(`OpenAPI JSON  ${url}/${appConfig.swaggerPath}-json`);
  }
}

void bootstrap();
