import { INestApplication, ValidationPipe } from '@nestjs/common';
import { encode } from 'iconv-lite';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { MailService } from '../src/billing/mail.service';
import { TrialService } from '../src/billing/trial.service';
import {
  PLAN_AI_MATCH_LIMIT,
  PLAN_PRODUCT_LIMIT,
  TRIAL_AI_MATCHES,
  TRIAL_PLAN,
  User,
  UserPlan,
} from '../src/billing/entities/user.entity';

/**
 * The path that sells, end to end, against the real database.
 *
 * Everything below is covered by unit tests in pieces, and the pieces passing
 * is what made the gap easy to miss: nobody had run registration, the trial,
 * a supplier, its price list, a comparison and the lapse *in that order*, on
 * one account, through HTTP. That sequence is the product. A break anywhere
 * along it is a customer who paid and got nothing, and none of it is visible
 * to a test that mocks the repository it depends on.
 *
 * Mail is the one thing stubbed. The verification link exists only inside an
 * email, so the stub is also how the test opens the account — which is exactly
 * what a person does with their inbox.
 */
describe('the account lifecycle (e2e)', () => {
  const EMAIL = `e2e-lifecycle-${Date.now()}@stoclify-e2e.test`;

  let app: INestApplication<App>;
  let db: DataSource;
  let apiKey = '';
  let ownerId = '';

  /** Every link the app tried to email, in order. */
  const links: Array<{ to: string; url: string }> = [];

  /**
   * The token out of a link.
   *
   * It rides in the fragment (`/#signin=…`), not the query string, so that a
   * referrer header cannot carry it to a third party. `URL` does not parse a
   * fragment into parameters, so it is read directly.
   */
  const tokenIn = (url: string): string => /#signin=([^&]+)/.exec(url)?.[1] ?? '';

  const mail = {
    enabled: true,
    sendVerificationLink: jest.fn((user: User, url: string) => {
      links.push({ to: user.email, url });
      return Promise.resolve(true);
    }),
    sendSignInLink: jest.fn((user: User, url: string) => {
      links.push({ to: user.email, url });
      return Promise.resolve(true);
    }),
    sendApiKey: jest.fn().mockResolvedValue(true),
    sendTrialEnded: jest.fn().mockResolvedValue(true),
    sendTrialEnding: jest.fn().mockResolvedValue(true),
    deliver: jest.fn().mockResolvedValue(true),
    verify: jest.fn().mockResolvedValue({ ok: true, detail: 'stubbed' }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Nothing in this file may put a message in a real inbox. The address is
      // deliberately at a domain that cannot receive one either.
      .overrideProvider(MailService)
      .useValue(mail)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    await app.init();
    db = app.get(DataSource);
  });

  afterAll(async () => {
    // The account and everything hanging off it. Ordered by dependency, and
    // guarded so a failure halfway through the suite still cleans up.
    if (ownerId) {
      await db.query(
        `DELETE FROM manual_prices WHERE shop_id IN (SELECT id FROM shops WHERE owner_id = $1)`,
        [ownerId],
      );
      await db.query(
        `DELETE FROM competitors WHERE product_id IN (SELECT id FROM products WHERE owner_id = $1)`,
        [ownerId],
      );
      await db.query('DELETE FROM products WHERE owner_id = $1', [ownerId]);
      await db.query('DELETE FROM shops WHERE owner_id = $1', [ownerId]);
      await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [ownerId]);
      await db.query('DELETE FROM users WHERE id = $1', [ownerId]);
    }

    await app?.close();
  });

  const withKey = () =>
    request(app.getHttpServer()).get('/api/v1/products').set('X-API-KEY', apiKey);

  /* --- Opening the account -------------------------------------------- */

  it('registers without handing out a key', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: EMAIL, name: 'E2E Купувач' })
      .expect(202);

    // The key is what the address is worth. Returning it here would make the
    // mailbox decoration and let a script farm accounts.
    expect(JSON.stringify(response.body)).not.toContain('pk_');
    expect(links).toHaveLength(1);
    expect(links[0].to).toBe(EMAIL);
  });

  it('grants nothing until the mailbox is proved', async () => {
    const [row]: Array<{ id: string; status: string; api_key_hash: string | null }> =
      await db.query('SELECT id, status, api_key_hash FROM users WHERE email = $1', [EMAIL]);

    ownerId = row.id;

    expect(row.status).toBe('pending');
    expect(row.api_key_hash).toBeNull();
  });

  it('opens the account, starts the trial and issues the key exactly once', async () => {
    const token = tokenIn(links[0].url);
    expect(token).toBeTruthy();

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/session')
      .send({ token })
      .expect(200);

    const body = response.body as { apiKey: string | null; plan: string };

    expect(body.plan).toBe(TRIAL_PLAN);
    expect(body.apiKey).toMatch(/^pk_/);
    apiKey = body.apiKey as string;

    const [row]: Array<{ status: string; plan: string; trial_ends_at: string | null }> =
      await db.query('SELECT status, plan, trial_ends_at FROM users WHERE id = $1', [ownerId]);

    expect(row.status).toBe('active');
    expect(row.plan).toBe(TRIAL_PLAN);
    expect(row.trial_ends_at).not.toBeNull();
  });

  it('refuses the same link a second time', async () => {
    // Single use, and refused as a bad request rather than as a credential
    // problem: the token is spent, which is a fact about the link the caller
    // sent, not about who they are.
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/session')
      .send({ token: tokenIn(links[0].url) })
      .expect(400);

    // A link that worked twice is a link worth stealing from an inbox that has
    // already been read, so nothing about the account comes back with it.
    expect(JSON.stringify(response.body)).not.toContain('pk_');
  });

  it('lets the new key through where an unknown one is refused', async () => {
    await withKey().expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('X-API-KEY', 'pk_live_definitely_not_a_key')
      .expect(401);
  });

  /* --- The supplier nobody can scrape ---------------------------------- */

  let shopId = '';

  it('adds the supplier with no website', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/shops?probe=false')
      .set('X-API-KEY', apiKey)
      .send({
        host: 'e2e-sklad.test',
        name: 'Складът от улицата',
        hasWebsite: false,
        discountPercent: 10,
        currency: 'BGN',
      })
      .expect(201);

    const shop = response.body as { id: string; searchMethod: string; hasWebsite: boolean };

    shopId = shop.id;
    expect(shop.hasWebsite).toBe(false);
    // Nothing is fetched for this supplier, and the probe must not have tried.
    expect(shop.searchMethod).toBe('manual');
  });

  it('takes its price list as the file it arrives as', async () => {
    // A Bulgarian Excel export: windows-1251, semicolons, decimal commas, the
    // net column before the gross one.
    const windows1251 = encode(
      'Арт. №;Наименование;Мярка;Цена без ДДС;Цена с ДДС\r\n' +
        'SVT-3X25;КАБЕЛ СВТ 3x2.5;м;1,42;1,70\r\n' +
        'LED-12;Лампа LED 12W E27;бр;3,20;3,84\r\n' +
        'VINT-45;Винт 4.5x50;бр;по запитване;\r\n',
      'windows-1251',
    );

    const response = await request(app.getHttpServer())
      .post(`/api/v1/shops/${shopId}/prices/upload?dryRun=true`)
      .set('X-API-KEY', apiKey)
      .attach('file', windows1251, 'ceni.csv')
      .expect(200);

    const read = (response.body as { read: Record<string, unknown> }).read;

    expect(read.rows).toBe(2);
    // The row priced "по запитване" is skipped and reported, not refused: a
    // list with a line like that is still a list.
    expect(read.skipped).toBe(1);
    expect(String((read.problems as string[])[0])).toContain('ред 4');
    // The net column, not the gross one beside it.
    expect((read.columns as { price: { index: number } }).price.index).toBe(3);

    await request(app.getHttpServer())
      .post(`/api/v1/shops/${shopId}/prices/upload`)
      .set('X-API-KEY', apiKey)
      .attach('file', windows1251, 'ceni.csv')
      .expect(200)
      .expect((res) => {
        const result = (res.body as { result: { imported: number } }).result;
        expect(result.imported).toBe(2);
      });
  });

  it('re-imports the same list without doubling it', async () => {
    const revised = Buffer.from(
      'Арт. №;Наименование;Мярка;Цена без ДДС\r\n' +
        'SVT-3X25;КАБЕЛ СВТ 3x2.5;м;1,55\r\n' +
        'LED-12;Лампа LED 12W E27;бр;3,20\r\n',
      'utf8',
    );

    const response = await request(app.getHttpServer())
      .post(`/api/v1/shops/${shopId}/prices/upload`)
      .set('X-API-KEY', apiKey)
      .attach('file', revised, 'ceni-revised.csv')
      .expect(200);

    const result = (response.body as { result: { imported: number; updated: number } }).result;

    expect(result.imported).toBe(0);
    expect(result.updated).toBe(2);

    const rows = await request(app.getHttpServer())
      .get(`/api/v1/shops/${shopId}/prices`)
      .set('X-API-KEY', apiKey)
      .expect(200);

    expect((rows.body as unknown[]).length).toBe(2);
  });

  it('answers a comparison with the price that was uploaded, at this account’s terms', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/discovery/compare')
      .query({ q: 'кабел СВТ 3x2.5' })
      .set('X-API-KEY', apiKey)
      .expect(200);

    const body = response.body as {
      bestOffer: {
        shopName: string;
        listedPrice: number;
        listedCurrency: string;
        effectivePrice: number;
        effectiveCurrency: string;
        priceSource: string;
      } | null;
    };

    expect(body.bestOffer).not.toBeNull();
    const best = body.bestOffer!;

    expect(best.shopName).toBe('Складът от улицата');
    expect(best.priceSource).toBe('manual');
    expect(best.listedPrice).toBe(1.55);
    expect(best.listedCurrency).toBe('BGN');
    // The order matters and is asserted rather than approximated: the discount
    // comes off in the supplier's own currency, where it was negotiated, and
    // the result is converted. 1.55 BGN − 10% = 1.40 (rounded), ÷ 1.95583 =
    // 0.72 €. Converting first and discounting after gives 0.71, and a cent on
    // every line of a hundred-line order is a wrong answer about who is
    // cheapest.
    expect(best.effectiveCurrency).toBe('EUR');
    expect(best.effectivePrice).toBe(0.72);
  });

  /* --- What the trial leaves behind ------------------------------------ */

  it('watches more articles than the free plan allows', async () => {
    const free = PLAN_PRODUCT_LIMIT[UserPlan.Free];

    for (let i = 0; i < free + 2; i += 1) {
      // A product must be watched somewhere — a row nothing checks can never
      // change, and creating one quietly would look like monitoring had
      // started. The host is RFC 2606 reserved, so no request ever leaves.
      await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('X-API-KEY', apiKey)
        .send({
          name: `Артикул ${i + 1}`,
          sku: `E2E-${i + 1}`,
          targetUrl: `https://e2e-sklad.test/artikul-${i + 1}`,
          competitorUrl: `https://e2e-konkurent.test/artikul-${i + 1}`,
        })
        .expect(201);
    }

    const [{ count }]: Array<{ count: string }> = await db.query(
      'SELECT count(*) FROM products WHERE owner_id = $1 AND is_active = true',
      [ownerId],
    );

    expect(Number(count)).toBe(free + 2);
  });

  it('parks the overflow when the week runs out, and deletes nothing', async () => {
    const free = PLAN_PRODUCT_LIMIT[UserPlan.Free];
    const user = await db.getRepository(User).findOneOrFail({ where: { id: ownerId } });

    // Spend part of the trial's allowance first, so the reset is observable.
    await db.query('UPDATE users SET ai_matches_used = $1 WHERE id = $2', [
      TRIAL_AI_MATCHES - 40,
      ownerId,
    ]);
    user.aiMatchesUsed = TRIAL_AI_MATCHES - 40;

    await app.get(TrialService).endTrial(user);

    const [row]: Array<{
      plan: string;
      product_limit: number;
      ai_matches_used: number;
      ai_matches_limit: number;
      trial_ends_at: string | null;
    }> = await db.query(
      `SELECT plan, product_limit, ai_matches_used, ai_matches_limit, trial_ends_at
         FROM users WHERE id = $1`,
      [ownerId],
    );

    expect(row.plan).toBe(UserPlan.Free);
    expect(row.product_limit).toBe(free);
    // The date stays, so the week cannot be taken twice.
    expect(row.trial_ends_at).not.toBeNull();
    // A fresh month on the free plan, not the trial's spend carried across: a
    // meter reading "50 of 50" on the first free morning is a reason not to
    // come back.
    expect(row.ai_matches_used).toBe(0);
    expect(row.ai_matches_limit).toBe(PLAN_AI_MATCH_LIMIT[UserPlan.Free]);

    const [counts]: Array<{ total: string; active: string }> = await db.query(
      `SELECT count(*) AS total, count(*) FILTER (WHERE is_active) AS active
         FROM products WHERE owner_id = $1`,
      [ownerId],
    );

    // Every article survives. Two are switched off, which is what makes the
    // week of data entry worth paying to switch back on.
    expect(Number(counts.total)).toBe(free + 2);
    expect(Number(counts.active)).toBe(free);
  });

  it('leaves the key and the suppliers working on the free plan', async () => {
    await withKey().expect(200);

    const shops = await request(app.getHttpServer())
      .get('/api/v1/shops')
      .set('X-API-KEY', apiKey)
      .expect(200);

    // The supplier list is not metered. Its prices are the week of work the
    // lapse is not allowed to cost.
    expect((shops.body as unknown[]).length).toBe(1);

    const prices = await request(app.getHttpServer())
      .get(`/api/v1/shops/${shopId}/prices`)
      .set('X-API-KEY', apiKey)
      .expect(200);

    expect((prices.body as unknown[]).length).toBe(2);
  });
});
