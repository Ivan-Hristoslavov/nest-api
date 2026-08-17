import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { OpenAPIObject } from '@nestjs/swagger';

import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/swagger';

interface ProductBody {
  id: string;
}

interface PageBody {
  data: unknown[];
  meta: { total: number; limit: number; offset: number; hasMore: boolean };
}

interface PriceCheckBody {
  productId: string;
  status: string;
}

/**
 * End-to-end smoke test.
 *
 * Requires a reachable database (the .env credentials): the app boots the real
 * TypeORM connection. Run with `npm run test:e2e`.
 */
describe('Price Intelligence API (e2e)', () => {
  let app: INestApplication<App>;
  // Populated after the app boots: ConfigModule is what loads .env into process.env.
  let apiKey = '';
  let openApi: OpenAPIObject;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    await app.init();
    apiKey = process.env.API_KEY ?? '';
    openApi = buildOpenApiDocument(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  // A dangling $ref makes Swagger UI silently refuse to send the request, with
  // no error in the console and nothing in the server log. Catch it here rather
  // than by clicking through the docs page.
  it('serves an OpenAPI document with no dangling schema references', () => {
    const defined = new Set(Object.keys(openApi.components?.schemas ?? {}));
    const dangling: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;

      const record = node as Record<string, unknown>;
      if (typeof record.$ref === 'string') {
        const name = record.$ref.replace('#/components/schemas/', '');
        if (!defined.has(name)) dangling.push(`${path} -> ${record.$ref}`);
      }

      for (const [key, value] of Object.entries(record)) walk(value, `${path}/${key}`);
    };

    walk(openApi.paths, 'paths');
    walk(openApi.components?.schemas, 'schemas');

    expect(dangling).toEqual([]);
  });

  it('documents limit and offset as numbers, not as an opaque $ref', () => {
    const params = (openApi.paths['/api/v1/products'].get?.parameters ?? []) as Array<{
      name: string;
      schema: { type?: string };
    }>;

    expect(params.find((p) => p.name === 'limit')?.schema.type).toBe('number');
    expect(params.find((p) => p.name === 'offset')?.schema.type).toBe('number');
  });

  it('GET /health is public and reports the database state', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toMatchObject({ status: 'ok', database: { status: 'up' } });
  });

  it('GET /api/v1/products rejects a request without an API key', async () => {
    await request(app.getHttpServer()).get('/api/v1/products').expect(401);
  });

  it('GET /api/v1/products rejects a wrong API key', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('X-API-KEY', 'definitely-not-the-key')
      .expect(401);
  });

  it('GET /api/v1/products returns a page with a valid API key', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('X-API-KEY', apiKey)
      .expect(200);

    const page = response.body as PageBody;
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.meta.limit).toBe(20);
    expect(page.meta.offset).toBe(0);
    expect(typeof page.meta.total).toBe('number');
  });

  it('POST /api/v1/products rejects an invalid payload', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('X-API-KEY', apiKey)
      .send({ name: 'x', targetUrl: 'not-a-url', competitorUrl: 'https://c.example.com/p' })
      .expect(400);
  });

  it('creates a product together with its primary competitor listing', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('X-API-KEY', apiKey)
      .send({
        name: 'E2E Competitor Test',
        targetUrl: 'https://shop.example.com/e2e-competitors',
        competitorUrl: 'https://competitor.example.com/e2e-competitors',
        currentPrice: 200,
      })
      .expect(201);

    const { id } = created.body as ProductBody;

    const listings = await request(app.getHttpServer())
      .get(`/api/v1/products/${id}/competitors`)
      .set('X-API-KEY', apiKey)
      .expect(200);

    const competitors = listings.body as Array<{ isPrimary: boolean; url: string }>;
    expect(competitors).toHaveLength(1);
    expect(competitors[0].isPrimary).toBe(true);
    expect(competitors[0].url).toBe('https://competitor.example.com/e2e-competitors');

    await request(app.getHttpServer())
      .delete(`/api/v1/products/${id}`)
      .set('X-API-KEY', apiKey)
      .expect(204);
  });

  it('rejects an unsigned billing webhook', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/billing/webhook')
      .send({ event_type: 'subscription.created', data: { id: 'sub_forged' } })
      .expect(401);
  });

  it('creates, scrapes and deletes a product', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('X-API-KEY', apiKey)
      .send({
        name: 'E2E Test Product',
        targetUrl: 'https://shop.example.com/e2e',
        competitorUrl: 'https://competitor.example.com/e2e',
        currentPrice: 100,
      })
      .expect(201);

    const { id } = created.body as ProductBody;

    // The trigger endpoint checks every listing of the product and returns one
    // result each. With SCRAPER_DRIVER=http the example.com URL cannot resolve,
    // which is exactly the point: a dead retailer must produce a recorded
    // failure, not an exception.
    const triggered = await request(app.getHttpServer())
      .post(`/api/v1/scraper/trigger/${id}`)
      .set('X-API-KEY', apiKey)
      .expect(200);

    const checks = triggered.body as PriceCheckBody[];
    expect(checks).toHaveLength(1);
    expect(checks[0].productId).toBe(id);
    expect(['success', 'failed']).toContain(checks[0].status);

    await request(app.getHttpServer())
      .get(`/api/v1/products/${id}/history`)
      .set('X-API-KEY', apiKey)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/products/${id}`)
      .set('X-API-KEY', apiKey)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/api/v1/products/${id}`)
      .set('X-API-KEY', apiKey)
      .expect(404);
  });
});
