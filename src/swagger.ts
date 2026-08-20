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
          'Сравнение на цени при вашите доставчици — същите данни, които виждате в таблото.',
          '',
          '**Автентикация** — всяко извикване освен `/health` и `/stats` иска ключа ви в',
          'хедъра `X-API-KEY`. Натиснете **Authorize** и го поставете, за да пробвате оттук.',
          '',
          'Ключът се издава веднъж и се пази само като хеш. Загубен ключ не се възстановява,',
          'а се заменя — старият спира да работи в същия момент.',
          '',
          '**Откъде да започнете**',
          '1. `POST /billing/signup` — безплатен акаунт и ключ.',
          '2. `POST /shops` — вашите доставчици.',
          '3. `POST /discovery/basket` — цена на цяла поръчка при всеки от тях.',
          '4. `POST /products` — какво да се следи, и `GET /alerts` за промените.',
          '',
          'Планът ви ограничава броя следени артикули; доставчиците са неограничени.',
        ].join('\n'),
      )
      .setVersion('1.0.0')
      .addApiKey(
        {
          type: 'apiKey',
          name: 'X-API-KEY',
          in: 'header',
          description: 'Ключът на акаунта. Издава се при регистрация или при плащане.',
        },
        API_KEY_SECURITY_SCHEME,
      )
      .addTag('Discovery', 'Търсене и цена на цяла поръчка при вашите доставчици')
      .addTag('Shops', 'Доставчиците, между които сравнявате — включително тези без сайт')
      .addTag('Products', 'Артикулите, чиито цени се следят')
      .addTag('Competitors', 'Офертите на отделните доставчици за един артикул')
      .addTag('Alerts', 'Известия при поскъпване, поевтиняване и спрели проверки')
      .addTag('Analytics', 'История, посока на цената и къде губите')
      .addTag('Scraper', 'Състояние на проверките и ръчно пускане')
      .addTag('Billing', 'Регистрация, планове и ключове')
      .addTag('Matching', 'Състояние на AI сравнението')
      .addTag('Stats', 'Публични броячи за началната страница')
      .addTag('Health', 'Проби на услугата и базата')
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
    customSiteTitle: 'Stoclify API — документация',
  });
}
