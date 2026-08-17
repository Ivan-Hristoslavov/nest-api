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
      .setTitle('Price Intelligence API')
      .setDescription(
        [
          'Competitor price tracking service.',
          '',
          '**Authentication** — every endpoint except `/health` requires a shared secret in the',
          '`X-API-KEY` header. Click **Authorize** and paste the key from your `.env`.',
          '',
          '**Modules**',
          '- `Products` — CRUD over tracked products, price history and aggregate statistics.',
          '- `Scraper` — scheduler status, manual sweeps and single-product refreshes.',
          '- `Health` — unauthenticated liveness and Supabase connectivity probe.',
        ].join('\n'),
      )
      .setVersion('1.0.0')
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-API-KEY',
          in: 'header',
          description: 'Shared secret that authenticates the client.',
        },
        API_KEY_SECURITY_SCHEME,
      )
      .addTag('Products', 'Manage the products whose competitor prices are tracked')
      .addTag('Scraper', 'Control and observe the price scraping scheduler')
      .addTag('Health', 'Service and database probes')
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
      tagsSorter: 'alpha',
    },
    customSiteTitle: 'Price Intelligence API — Docs',
  });
}
