import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

import { AppConfig } from './config/configuration';
import { API_KEY_SECURITY_SCHEME } from './common/decorators/api-key-auth.decorator';

/**
 * Builds the OpenAPI document. Split out from {@link setupSwagger} so tests can
 * assert on the document itself — a dangling `$ref` breaks Swagger UI silently
 * and is otherwise only discoverable by clicking through the docs page.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Stoclify API')
      .setDescription(
        [
          'Price comparison across your own suppliers — the same data you see in the dashboard.',
          '',
          '**Authentication.** Every call except `/health` and `/stats` wants your key in the',
          '`X-API-KEY` header. Press **Authorize**, paste it, and this page becomes a working',
          'client rather than a reference.',
          '',
          'A key is issued once and kept only as a hash. A lost key is not recovered, it is',
          'replaced — and the old one stops working at that moment.',
          '',
          '**Where to start**',
          '1. `POST /billing/signup` — a free account and a key.',
          '2. `POST /shops` — your suppliers.',
          '3. `POST /discovery/basket` — what a whole order costs at each of them.',
          '4. `POST /purchase-decisions` — keep the plan you chose, with the evidence behind it.',
          '5. `POST /products` — what to watch, and `GET /alerts` for what changed.',
          '',
          'Your plan caps how many articles you track; suppliers are unlimited.',
          '',
          '**A note on language.** This documentation is in English. The API itself answers',
          'people in theirs: error messages, plan labels and explanation sentences come back',
          "in the account's language, which is why some examples below are in Bulgarian —",
          'they are what the endpoint actually returns, not a translation of it. Product and',
          'supplier names in examples are real catalogue data for the same reason.',
        ].join('\n'),
      )
      .setVersion('1.0.0')
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-API-KEY',
          in: 'header',
          description: 'Your account key. Issued on signup, or when a payment succeeds.',
        },
        API_KEY_SECURITY_SCHEME,
      )
      .addTag('Discovery', 'Search, and what a whole order costs across your suppliers')
      .addTag(
        'Purchase decisions',
        'A chosen plan kept as evidence — the terms, prices and matches it was made on, frozen',
      )
      .addTag('Orders', 'Order requests sent to a supplier from your own company')
      .addTag('Shops', 'The suppliers you compare between — including the ones with no website')
      .addTag('Products', 'The articles whose prices are watched')
      .addTag('Competitors', 'What each supplier offers for one article')
      .addTag('Alerts', 'Notice when a price rises, falls, or stops being checked')
      .addTag('Analytics', 'History, where a price is heading, and where you are losing')
      .addTag('Scraper', 'How the price sweep is doing, and how to start one by hand')
      .addTag('Billing', 'Signup, plans and keys')
      .addTag('Auth', 'Signing in, sessions and the second factor')
      .addTag('Matching', 'Whether AI matching is reachable')
      .addTag('Admin', 'The operator view across every customer. Operator key only.')
      .addTag('Stats', 'Public counters for the front page')
      .addTag('Health', 'Probes for the service and the database')
      // No `.addServer()` here on purpose: `createDocument` already bakes the
      // global prefix into every path, so an extra server base would make
      // Swagger UI request /api/v1/api/v1/products and get a 404.
      .build(),
    {
      // Operation ids become `ProductsController_findAll` style names, which
      // client generators turn into readable method names.
      operationIdFactory: (controllerKey: string, methodKey: string) =>
        `${controllerKey.replace('Controller', '')}_${methodKey}`,
    },
  );
}

/**
 * Mounts Swagger UI at `SWAGGER_PATH` (default `/api/docs`) and the raw
 * document at `<path>-json`.
 *
 * The `apiKey` security scheme makes Swagger UI's "Authorize" button send the
 * `X-API-KEY` header on every try-it-out request, so the docs page is a working
 * client for the API rather than a read-only reference.
 */
export function setupSwagger(app: INestApplication, config: AppConfig): void {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup(config.swaggerPath, app, document, {
    jsonDocumentUrl: `${config.swaggerPath}-json`,
    swaggerOptions: {
      // Keeps the API key in the browser across reloads while testing.
      persistAuthorization: true,
      displayRequestDuration: true,
      docExpansion: 'list',
      filter: true,
      // Deliberately unsorted: the tags are declared in the order a new
      // customer needs them, and alphabetical order would open the docs on
      // "Alerts" — a thing you cannot receive until three other calls worked.
    },
    customSiteTitle: 'Stoclify API — documentation',
  });
}
