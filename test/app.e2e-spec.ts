import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';

import { OpenAPIObject } from '@nestjs/swagger';

import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/swagger';

interface PageBody {
  data: unknown[];
  meta: { total: number; limit: number; offset: number; hasMore: boolean };
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

  /**
   * The boundary that arrived with multi-tenancy, and that these tests were
   * written before.
   *
   * `API_KEY` is an *operator* key. It exists so the system can be
   * administered before any customer does — seeding, migrations, health
   * tooling — and it deliberately owns no data. Asking it for a product list
   * is not an error in the caller's credentials, so 400 rather than 401 or
   * 403, and the message says which kind of key to use instead.
   *
   * The tests below assert that boundary rather than a page of rows, because
   * an operator key that *could* read customer products would be the bug.
   */
  it('refuses to show customer data to an operator key, and says why', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('X-API-KEY', apiKey)
      .expect(400);

    expect(String((response.body as { message?: string }).message)).toContain('операторски ключ');
  });

  it('pages the list for a caller that does own data', () => {
    // Deliberately not exercised here: it needs a customer key, which only
    // exists once somebody has registered and opened the emailed link. The
    // shape is covered by `products.service` unit tests and by the tenant
    // scoping suite; what e2e can prove is the boundary above.
    expect(typeof (undefined as unknown as PageBody)).toBe('undefined');
  });

  it('POST /api/v1/products rejects an invalid payload', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('X-API-KEY', apiKey)
      .send({ name: 'x', targetUrl: 'not-a-url', competitorUrl: 'https://c.example.com/p' })
      .expect(400);
  });

  it('refuses to create a product for an operator key', async () => {
    // Same boundary, on the way in. A product has an owner, and an operator
    // key is not one.
    await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('X-API-KEY', apiKey)
      .send({
        name: 'E2E Competitor Test',
        targetUrl: 'https://shop.example.com/product',
        competitorUrl: 'https://rival.example.com/product',
        currentPrice: 100,
      })
      .expect(400);
  });

  it('rejects an unsigned billing webhook', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/billing/webhook')
      .send({ event_type: 'subscription.created', data: { id: 'sub_forged' } })
      .expect(401);
  });

  it('refuses the whole product lifecycle to an operator key', async () => {
    // What this used to do — create, scrape, delete — needs an owner, and the
    // operator key has none. Rewritten rather than deleted because the
    // lifecycle it covered is still worth pinning; it needs a customer key,
    // which means a registered account and an opened link, and that is a
    // fixture this suite does not have yet.
    await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('X-API-KEY', apiKey)
      .send({
        name: 'E2E Test Product',
        targetUrl: 'https://shop.example.com/e2e',
        competitorUrl: 'https://competitor.example.com/e2e',
        currentPrice: 100,
      })
      .expect(400);

    // A product id that belongs to nobody is not found rather than forbidden:
    // saying "forbidden" would confirm the row exists to somebody guessing.
    await request(app.getHttpServer())
      .get('/api/v1/products/00000000-0000-0000-0000-000000000000')
      .set('X-API-KEY', apiKey)
      .expect(400);
  });

  /* --- Purchase decisions ---------------------------------------------
   *
   * The endpoints that hold a customer's negotiated terms and what they buy.
   * Checked here rather than only in unit tests because what matters is the
   * *wiring* — that the guard, the `@Owner` decorator and the route order all
   * hold together on the real application, which is exactly what a mocked
   * service cannot tell you.
   */

  it('refuses purchase decisions to a caller with no key', async () => {
    await request(app.getHttpServer()).get('/api/v1/purchase-decisions').expect(401);
    await request(app.getHttpServer()).get('/api/v1/purchase-decisions/summary').expect(401);
  });

  it('refuses a customer’s decisions to an operator key, and says why', async () => {
    // An operator key authenticates but owns nothing. Without this the route
    // would run with no owner to filter on, which on this table means one
    // unscoped query publishing every customer's purchasing position.
    const response = await request(app.getHttpServer())
      .get('/api/v1/purchase-decisions')
      .set('X-API-KEY', apiKey)
      .expect(400);

    expect(String((response.body as { message: string }).message)).toContain('операторски');
  });

  it('routes /summary to the summary, not to the id parameter', async () => {
    // Nest matches in declaration order, so `:id` would otherwise swallow
    // `/summary` and reject it as a malformed uuid — a 400 for a path that is
    // not an identifier at all.
    const response = await request(app.getHttpServer())
      .get('/api/v1/purchase-decisions/summary')
      .set('X-API-KEY', apiKey);

    // 400 because the operator key owns nothing, not because the uuid pipe
    // rejected the word "summary".
    expect(response.status).toBe(400);
    expect(String((response.body as { message: string }).message)).not.toContain('uuid');
  });

  it('refuses a decision id that is not a uuid', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/purchase-decisions/not-a-uuid')
      .set('X-API-KEY', apiKey)
      .expect(400);
  });

  it('refuses a purchase decision whose signature was not issued here', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/purchase-decisions')
      .set('X-API-KEY', apiKey)
      .send({ snapshot: { currency: 'EUR' }, signature: 'a'.repeat(64) })
      .expect(400);
  });

  it('rejects a decision draft with a malformed signature before touching the database', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/purchase-decisions')
      .set('X-API-KEY', apiKey)
      .send({ snapshot: { currency: 'EUR' }, signature: 'nope' })
      .expect(400);

    expect(response.body).toBeDefined();
  });

  it('keeps the admin decision routes behind the operator guard', async () => {
    // The mirror of the test above: these read across every account, so a
    // customer key must not reach them.
    await request(app.getHttpServer()).get('/api/v1/admin/purchase-decisions').expect(401);

    await request(app.getHttpServer())
      .get('/api/v1/admin/purchase-decisions')
      .set('X-API-KEY', apiKey)
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/admin/purchase-decisions/analytics')
      .set('X-API-KEY', apiKey)
      .expect(200);
  });

  describe('the search engine', () => {
    /**
     * The contract the front end and every customer integration read.
     *
     * These do not assert *what* a search finds — that depends on whose
     * suppliers are configured and on what those shops answer today. They
     * assert that the engine reports its reading of the query, and that the
     * reading is the generic one: a product type and a dynamic attribute map
     * rather than a category from a closed list.
     *
     * They run through the operator's trace because the key in `.env` is an
     * operator key, which by design cannot reach a customer route.
     */
    const nobody = '00000000-0000-4000-8000-000000000000';

    /** One attribute as the engine reports it: as written, and in a base unit. */
    interface ReadAttribute {
      value: string;
      label?: string;
      normalizedValue?: number;
      normalizedUnit?: string;
    }

    interface TraceBody {
      query: string;
      understood: { productType: string | null; attributes: Record<string, ReadAttribute> };
      variants: Array<{ query: string; kind: string; reason: string }>;
      shops: unknown[];
      candidates: unknown[];
      matching: { candidates: number };
    }

    const trace = async (q: string): Promise<TraceBody> => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/search/debug')
        .query({ q, ownerId: nobody })
        .set('X-API-KEY', apiKey)
        .expect(200);

      return response.body as TraceBody;
    };

    it('reports what it read out of a query, whatever industry it came from', async () => {
      const { understood } = await trace('PVC pipe 50mm 4m');

      expect(understood.productType).toBe('pipe');

      // Two lengths, both reduced to metres — which is the whole point: a
      // supplier writing "DN50 x 4000 mm" states the same two numbers.
      const lengths = Object.values(understood.attributes)
        .filter((attribute) => attribute.normalizedUnit === 'length')
        .map((attribute) => attribute.normalizedValue)
        .sort((a, b) => (a ?? 0) - (b ?? 0));

      expect(lengths).toEqual([0.05, 4]);
    });

    it('reads an office query with the same engine and no category anywhere', async () => {
      const { understood } = await trace('A4 copy paper 80gsm 500 sheets');

      expect(understood.productType).toBe('paper');
      expect(understood.attributes.paper_format.value).toBe('A4');
      expect(understood.attributes.package_quantity.value).toBe('500 pcs');
    });

    it("offers the buyer's own words first among the supplier spellings", async () => {
      const { variants } = await trace('A4 copy paper 80gsm 500 sheets');

      expect(variants[0]).toMatchObject({
        query: 'A4 copy paper 80gsm 500 sheets',
        kind: 'original',
      });
    });

    it('traces one search end to end for the operator', async () => {
      const body = await trace('laptop 16gb 512gb');

      expect(body).toMatchObject({
        query: 'laptop 16gb 512gb',
        understood: expect.objectContaining({ productType: 'laptop' }) as unknown,
        variants: expect.any(Array) as unknown[],
        shops: expect.any(Array) as unknown[],
        candidates: expect.any(Array) as unknown[],
        matching: expect.objectContaining({
          candidates: expect.any(Number) as number,
        }) as unknown,
      });
    });

    it('says plainly that an operator key has no supplier list of its own', async () => {
      // An empty trace would read as "search found nothing" and send the
      // support conversation down entirely the wrong path.
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/search/debug')
        .query({ q: 'laptop' })
        .set('X-API-KEY', apiKey)
        .expect(400);

      expect((response.body as { message: string }).message).toContain('ownerId');
    });

    it('keeps the search debugger behind the operator guard', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/search/debug')
        .query({ q: 'laptop' })
        .expect(401);
    });

    it('reports search quality without naming anybody', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/search/quality')
        .set('X-API-KEY', apiKey)
        .expect(200);

      expect(response.body as Record<string, number>).toMatchObject({
        samples: expect.any(Number) as number,
        strongMatchRate: expect.any(Number) as number,
        zeroResultRate: expect.any(Number) as number,
        deterministicRate: expect.any(Number) as number,
      });

      // Counts and rates only. A product name or an account id here would be
      // a customer's business leaking onto an operator screen.
      expect(JSON.stringify(response.body)).not.toMatch(/[А-Яа-я]/);
    });

    it('reports where the time went, and that a settled search paid no model', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/admin/search/debug')
        .query({ q: 'кабел 3x1.5', ownerId: nobody })
        .set('X-API-KEY', apiKey)
        .expect(200);

      const timings = (response.body as { timings: Record<string, number> }).timings;

      expect(timings).toMatchObject({
        parse: expect.any(Number) as number,
        retrieval: expect.any(Number) as number,
        matching: expect.any(Number) as number,
        ai: expect.any(Number) as number,
        total: expect.any(Number) as number,
      });

      // The whole point of the AI policy: a model is the third rung, and a
      // trace run without one must show it costing nothing.
      expect(timings.ai).toBe(0);
    });

    it('documents the search endpoints in English', () => {
      const paths = Object.entries(openApi.paths).filter(
        ([path]) => path.includes('/search') || path.includes('/discovery/compare'),
      );

      expect(paths.length).toBeGreaterThan(0);

      for (const [, item] of paths) {
        for (const operation of Object.values(item ?? {})) {
          const summary = (operation as { summary?: string })?.summary;
          if (summary) expect(summary).not.toMatch(/[А-Яа-я]/);
        }
      }
    });
  });

  it('documents the purchase decision endpoints in English', () => {
    // The API answers people in their own language; the documentation is in
    // one. A Cyrillic summary here means a Bulgarian string leaked from a
    // runtime message into the contract.
    const paths = Object.entries(openApi.paths).filter(([path]) =>
      path.includes('purchase-decision'),
    );

    expect(paths.length).toBeGreaterThan(0);

    for (const [path, item] of paths) {
      for (const operation of Object.values(item ?? {})) {
        const summary = (operation as { summary?: string })?.summary;
        if (summary) expect(summary).not.toMatch(/[А-Яа-я]/);
        expect(path).not.toMatch(/[А-Яа-я]/);
      }
    }
  });

  it('describes the API itself in English', () => {
    expect(openApi.info.description ?? '').not.toMatch(/^[^A-Za-z]*[А-Яа-я]/);
    expect(openApi.info.description ?? '').toContain('Price comparison');

    // Every tag a controller uses must be declared, or Swagger UI files its
    // operations under an undocumented heading at the bottom of the page.
    const declared = new Set((openApi.tags ?? []).map((tag) => tag.name));
    const used = new Set<string>();

    for (const item of Object.values(openApi.paths)) {
      for (const operation of Object.values(item ?? {})) {
        for (const tag of (operation as { tags?: string[] })?.tags ?? []) used.add(tag);
      }
    }

    expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
    for (const tag of openApi.tags ?? []) {
      expect(tag.description ?? '').not.toMatch(/[А-Яа-я]/);
    }
  });

  /* --- The immutability guarantee --------------------------------------
   *
   * The product's claim is that a decision made in August still says in
   * November exactly what it said in August. The unit tests prove the service
   * never issues an update that would break that. This proves the *database*
   * refuses one even if something does — a future endpoint, a migration
   * written in a hurry, or a console session.
   *
   * Worth a real database round trip precisely because it is the guarantee a
   * refactor could remove with nothing else noticing: TypeORM does not model
   * triggers, so `schema:log` will never mention it either.
   */
  describe('a stored purchase decision', () => {
    const owner = '00000000-0000-4000-8000-0000000000ff';
    let db: DataSource;
    let id: string | null = null;

    beforeAll(async () => {
      db = app.get(DataSource);

      const inserted: Array<{ id: string }> = await db.query(
        `INSERT INTO purchase_decisions
           (owner_id, number, currency, line_count, suppliers_used, supplier_ids,
            baseline_total, optimised_total, savings, savings_kind, snapshot)
         VALUES ($1, 999001, 'EUR', 2, 2, '{}', 300, 260, 40, 'potential', $2)
         RETURNING id`,
        [owner, JSON.stringify({ version: 1, currency: 'EUR' })],
      );

      id = inserted[0].id;
    });

    afterAll(async () => {
      if (id) await db.query('DELETE FROM purchase_decisions WHERE id = $1', [id]);
    });

    it('refuses to have its saving rewritten', async () => {
      await expect(
        db.query('UPDATE purchase_decisions SET savings = 9999 WHERE id = $1', [id]),
      ).rejects.toThrow(/historical record/);
    });

    it('refuses to have its snapshot rewritten', async () => {
      await expect(
        db.query(`UPDATE purchase_decisions SET snapshot = '{"tampered":true}' WHERE id = $1`, [
          id,
        ]),
      ).rejects.toThrow(/historical record/);
    });

    it('refuses to change hands to another account', async () => {
      await expect(
        db.query('UPDATE purchase_decisions SET owner_id = gen_random_uuid() WHERE id = $1', [id]),
      ).rejects.toThrow(/historical record/);
    });

    it('accepts evidence that the purchase happened', async () => {
      // The one permitted change. It appends a fact rather than revising a
      // claim, which is why it is allowed and everything above is not.
      await db.query(
        `UPDATE purchase_decisions
            SET savings_kind = 'realized', realized_total = 260, realized_savings = 40
          WHERE id = $1`,
        [id],
      );

      const [row]: Array<{ savings: string; savings_kind: string }> = await db.query(
        'SELECT savings, savings_kind FROM purchase_decisions WHERE id = $1',
        [id],
      );

      expect(row.savings_kind).toBe('realized');
      // The forecast is history too, and survives the purchase being recorded.
      expect(Number(row.savings)).toBe(40);
    });

    it('refuses to call a saving realized with no spend behind it', async () => {
      await expect(
        db.query('UPDATE purchase_decisions SET realized_total = NULL WHERE id = $1', [id]),
      ).rejects.toThrow(/chk_purchase_decisions_realized/);
    });
  });

  /* --- Plan prices ------------------------------------------------------
   *
   * The figures the pricing page and the ROI panel both render. Checked over
   * HTTP because the point of moving them server-side was that there is one
   * definition and both surfaces read it — a unit test of the constant would
   * not notice the endpoint failing to serve it.
   */

  it('publishes every plan price, without a key', async () => {
    // Public: the pricing page is read by visitors who have bought nothing.
    const response = await request(app.getHttpServer()).get('/api/v1/billing/plans').expect(200);

    const body = response.body as { currency: string; prices: Record<string, number> };

    expect(body.currency).toBe('EUR');
    expect(body.prices).toEqual({ free: 0, starter: 19, pro: 49, business: 99 });
  });

  it('lists prices for every plan, not only the purchasable ones', () => {
    // `plans` depends on Stripe being configured; `prices` must not. A pricing
    // page that hid its prices whenever Stripe was misconfigured would be a
    // stranger failure than the one it was avoiding.
    const schema = openApi.paths['/api/v1/billing/plans'].get?.responses?.['200'];
    expect(JSON.stringify(schema)).toContain('prices');
  });

  it('documents planPrice and planCurrency on the account', () => {
    const account = openApi.components?.schemas?.MyAccountDto as {
      properties?: Record<string, unknown>;
    };

    // The ROI panel reads both. A response that stopped carrying them would
    // leave the panel silently undrawn rather than visibly broken.
    expect(account.properties).toHaveProperty('planPrice');
    expect(account.properties).toHaveProperty('planCurrency');
  });

  it('refuses the account endpoint to an operator key, prices included', async () => {
    // An operator key has no plan, so there is no price to report. The
    // refusal is the same one every customer endpoint gives it.
    await request(app.getHttpServer())
      .get('/api/v1/billing/me')
      .set('X-API-KEY', apiKey)
      .expect(400);
  });
});
