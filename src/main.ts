import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ServerResponse } from 'node:http';
import { setDefaultResultOrder } from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import compression from 'compression';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { accessLogMiddleware } from './common/middleware/access-log.middleware';
import { AppConfig, CurrencyConfig, configuration } from './config/configuration';
import { initObservability } from './common/observability';
import { convertibleCurrencies, setRatesPerEur } from './products/currency';
import { NodeEnvironment } from './config/env.validation';
import { SeoService } from './seo/seo.service';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  // Prefer IPv4 when a name resolves to both.
  //
  // `smtp.gmail.com` publishes an A record and a AAAA record, and Node picks
  // whichever the resolver lists first — often the AAAA one. A host with no
  // route out over IPv6, which is the default on most container platforms,
  // then fails with `ENETUNREACH 2a00:1450:…:465` for a server that answers
  // perfectly well over IPv4. It cost a signup: the verification email timed
  // out, so the account existed and its owner never heard about it.
  //
  // Set for the process rather than for the mailer, because the scraper
  // reaches out to arbitrary hosts and would hit exactly the same wall. This
  // is a preference, not a restriction — a name with only a AAAA record is
  // still used.
  setDefaultResultOrder('ipv4first');

  // Before the application, not after: Sentry patches the modules it traces as
  // they load, so initialising it later leaves half the context missing.
  initObservability(configuration().observability);

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

  // The interface is a 270 KB script, a 37 KB stylesheet and a translation
  // dictionary per language, all of them text and all of them compressing to
  // roughly a quarter of that. Uncompressed they were the single largest cost
  // of opening the page, paid again on every visit.
  //
  // `threshold` leaves small JSON replies alone: below about a kilobyte the
  // gzip header costs more than the compression saves, and every price lookup
  // this API answers is smaller than that.
  app.use(compression({ threshold: 1024 }));

  // --- Security ------------------------------------------------------------
  // The policy is written out rather than left to helmet's defaults, because
  // those defaults are `script-src 'self'` with no room for the Swagger page,
  // and switching CSP off for Swagger — which is what used to happen — left
  // the customer-facing app unprotected too.
  //
  // `script-src` carries no 'unsafe-inline' and no 'unsafe-eval'. That is the
  // point of the whole arrangement: the interface holds a session token in
  // localStorage, so one injected <script> would be an account takeover, and
  // this is the header that makes an injected tag inert. It costs nothing only
  // because the page has no inline script left to allow — everything lives in
  // /app.js and /theme.js, and the stylesheet is built rather than compiled in
  // the browser by the Tailwind CDN.
  //
  // Swagger UI is the one exception, and it gets its own relaxed policy on its
  // own path rather than switching the header off for the whole origin: the
  // docs page renders itself with inline script, and it holds nothing worth
  // stealing.
  const strictCsp = helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Styles still need 'unsafe-inline' for the handful of `style="..."`
        // attributes in the markup; unlike a script, an injected stylesheet
        // cannot read a token.
        //
        // cdnjs is gone from both lists: the icons are a generated stylesheet
        // served from here, so there is no third party left to allow.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        // Product photos come from the supplier's own domain, which is any
        // domain — that is the product. Restricted to https so a downgraded
        // image cannot be used to strip the page's transport security.
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    // Supplier images are hot-linked from their own domains, which do not
    // send CORP headers; the default `same-origin` would block every one.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // The sign-in link lands as `#signin=<token>` — a fragment, which is
    // never sent to a server. This keeps the rest of the URL from leaking too.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  const docsCsp = helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  const docsPrefix = `/${appConfig.swaggerPath}`;

  app.use((request: Request, response: Response, next: NextFunction) =>
    appConfig.swaggerEnabled && request.path.startsWith(docsPrefix)
      ? docsCsp(request, response, next)
      : strictCsp(request, response, next),
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
  // The stylesheet is generated by `npm run build:css`, which every start and
  // build script runs first. Said out loud at boot because the failure mode is
  // otherwise baffling: the app serves 200s, the API works, and the page looks
  // like unstyled 1996.
  if (!existsSync(join(process.cwd(), 'public', 'styles.css'))) {
    logger.error(
      'public/styles.css is missing — the interface will render unstyled. Run `npm run build:css`.',
    );
  }

  // The head a crawler reads is assembled here, not written into the file.
  //
  // `index.html` is one static page, so the canonical link, the language
  // alternates and the structured data all depend on the domain the app is
  // deployed at — which the file cannot know. Registered before the static
  // handler because that handler answers `/` and would otherwise send the
  // untouched file.
  //
  // Read once and cached: the HTML is 130 KB and this runs on every visit. In
  // development the cache is skipped, so editing the markup does not require a
  // restart to see the change.
  const seo = app.get(SeoService);
  const indexPath = join(process.cwd(), 'public', 'index.html');
  const indexCache = new Map<string, string>();

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    if (request.path !== '/' && request.path !== '/index.html') return next();
    if (!existsSync(indexPath)) return next();

    const asked = typeof request.query.lang === 'string' ? request.query.lang : null;
    const key = asked ?? '';

    let html = isProduction ? indexCache.get(key) : undefined;
    if (html === undefined) {
      html = readFileSync(indexPath, 'utf8').replace(
        '</head>',
        `${seo.headTags(asked)}\n  </head>`,
      );
      if (isProduction) indexCache.set(key, html);
    }

    response.type('html').send(html);
  });

  // `public/` is served from the project root rather than `__dirname`, so the
  // same path works whether the app runs from `src` (ts-node) or `dist`.
  app.useStaticAssets(join(process.cwd(), 'public'), {
    index: ['index.html'],
    maxAge: isProduction ? '1h' : 0,
    setHeaders: (response: ServerResponse, path: string) => {
      // A cached copy of any of these is a cached *application*. `max-age=0`
      // still permits a browser to answer from its in-memory cache without
      // revalidating, which silently keeps old code running after an edit —
      // and now that the interface lives in app.js rather than inside the
      // HTML, the rule has to cover the script and the stylesheet too, or a
      // developer edits app.js and reloads onto the previous version.
      if (!isProduction && /\.(html|js|css|json)$/.test(path)) {
        response.setHeader('Cache-Control', 'no-store, must-revalidate');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Expires', '0');
      }
    },
  });

  // --- Routing -------------------------------------------------------------
  // `/health` stays outside the version prefix so uptime probes keep working
  // across future API versions; the two crawler files are outside it because
  // no crawler asks for `/api/v1/robots.txt`.
  app.setGlobalPrefix(appConfig.apiPrefix, {
    exclude: ['health', 'robots.txt', 'sitemap.xml'],
  });

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
