# nest-api — Price Intelligence API

Competitor price tracking as a paid API. NestJS + TypeORM on Supabase PostgreSQL, real web scraping, alerting, analytics, and self-service accounts provisioned by payment webhooks.

---

## 1. What it does

1. You register products and the competitor listings you want watched.
2. A scheduled sweep fetches each listing, extracts the price and stores it.
3. Movements beyond a threshold, undercuts and all-time lows raise alerts and go out to Slack or a webhook.
4. Analytics endpoints answer "who sets the market price, which way is it moving, where are we losing".
5. Customers pay through Paddle or Lemon Squeezy; the webhook activates their account and issues their API key.

---

## 2. Stack

| Concern | Choice |
| --- | --- |
| Framework | NestJS 11 (TypeScript, strict null checks) |
| Database | Supabase PostgreSQL 17 via the session pooler |
| ORM | TypeORM 0.3, migrations, repository pattern |
| Scraping | axios + cheerio, robots.txt aware, per-host rate limiting |
| Scheduling | `@nestjs/schedule` dynamic cron |
| Payments | Paddle / Lemon Squeezy webhooks (merchant of record) |
| Auth | `X-API-KEY`, hashed in the database, constant-time operator keys |
| Docs | OpenAPI 3 at `/api/docs` |
| Hardening | helmet, CORS allowlist, `@nestjs/throttler`, HMAC webhook signatures |

---

## 3. Setup

```bash
npm install
```

`.env` is filled in. The values that matter most:

```
DB_HOST=aws-1-eu-west-3.pooler.supabase.com   # verified against the live pooler
SCRAPER_DRIVER=http                            # http = real pages, simulation = generated
PADDLE_WEBHOOK_SECRET=...                      # required for billing
```

Apply the schema, seed a demo catalog, run:

```bash
npm run migration:run
```

```bash
npm run seed
```

```bash
npm run start:dev
```

| URL | What |
| --- | --- |
| http://localhost:3000/api/docs | Swagger UI — click **Authorize**, paste `API_KEY` |
| http://localhost:3000/api/v1 | REST API |
| http://localhost:3000/health | Public probe |

---

## 4. Project structure

```
src/
├── main.ts                     # bootstrap: rawBody, helmet, CORS, prefix, pipes, Swagger
├── app.module.ts               # config, TypeORM, global guards/filter
├── config/                     # env whitelist + validation, typed configuration
├── database/
│   ├── migrations/             # InitialSchema, CompetitorsAlertsBilling, backfill
│   ├── data-source.ts          # TypeORM CLI entrypoint
│   └── seed.ts                 # demo catalog, idempotent
├── common/                     # guard, decorators, DTOs, filter, access-log middleware
├── products/
│   ├── entities/               # Product, Competitor, PriceHistory
│   ├── products.service.ts     # CRUD, stats
│   ├── competitors.service.ts  # listings + the transactional price write path
│   └── *.controller.ts
├── scraper/
│   ├── fetchers/               # http (axios) and simulation drivers behind one interface
│   ├── parsers/                # price extraction + per-retailer site profiles
│   ├── http/                   # robots.txt client, per-host rate limiter
│   └── scraper.service.ts      # cron sweep, concurrency, graceful shutdown
├── alerts/                     # Alert entity, Slack and webhook notifiers
├── analytics/                  # per-product and portfolio analytics
├── billing/                    # User, BillingEvent, webhook signatures, key issuance
└── health/
```

---

## 5. Endpoints

Everything except `/health` and the billing webhook needs `X-API-KEY`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/products` | Track a product (creates its primary listing) |
| GET | `/api/v1/products` | Search, filter, sort, paginate |
| GET | `/api/v1/products/stats` | Aggregate counters |
| GET/PATCH/DELETE | `/api/v1/products/:id` | Read, update, delete |
| GET | `/api/v1/products/:id/history` | Price observations |
| POST | `/api/v1/products/:id/prices` | Manual price for the primary listing |
| GET/POST | `/api/v1/products/:id/competitors` | List / add rival listings |
| PATCH/DELETE | `…/competitors/:competitorId` | Update / remove a listing |
| PATCH | `…/competitors/:competitorId/promote` | Make it the primary listing |
| POST | `…/competitors/:competitorId/prices` | Manual price for one rival |
| GET | `/api/v1/scraper/status` | Driver, schedule, listings due, last sweep |
| POST | `/api/v1/scraper/run` | Sweep everything that is due |
| **POST** | **`/api/v1/scraper/trigger/:id`** | **Scrape one product now (real fetch)** |
| POST | `/api/v1/scraper/competitors/:id/refresh` | Re-check one listing now |
| GET | `/api/v1/analytics/products/:id?days=30` | Min/max/avg, volatility, trend, series |
| GET | `/api/v1/analytics/overview` | Portfolio position and biggest movers |
| GET | `/api/v1/alerts` | Price alerts, newest first |
| PATCH | `/api/v1/alerts/:id/acknowledge` | Mark handled |
| POST | `/api/v1/billing/webhook` | Paddle / Lemon Squeezy events |
| GET | `/api/v1/billing/events` | Recent webhooks, for support |
| GET | `/health` | Public liveness + database probe |

---

## 6. Scraping

### Drivers

`SCRAPER_DRIVER=http` fetches real pages. `simulation` generates plausible movement without touching the network — used by the demo and the e2e suite, so neither depends on a retailer being reachable.

### Extraction

`PriceParserService` tries, in order:

1. **selector** — CSS selector configured on the listing;
2. **site-profile** — a per-retailer entry in [site-profiles.ts](src/scraper/parsers/site-profiles.ts);
3. **json-ld** — `schema.org/Product` offers;
4. **microdata** — `itemprop="price"`;
5. **meta** — OpenGraph / `product:price:amount`;
6. **heuristic** — selectors common across storefronts.

The amount parser handles locale ambiguity: `1.299,00 €`, `1,299.00 USD` and `1 299,00 лв.` all become `1299`.

### vario.bg

Verified against a live page. It publishes **two** prices — 428.00 лв. and 218.83 € — so the generic microdata strategy would silently store euros in a BGN column. The profile pins the BGN node:

```ts
{
  host: 'vario.bg',
  priceSelectors: ['#subtotal_price_bgn', 'em.current_price', '.current_price'],
  currency: 'BGN',
}
```

Adding a retailer means one entry in that file. A `priceSelector` stored on a listing always overrides it.

### Manners

`robots.txt` is honoured including `Crawl-delay`; requests to one host are serialised with a minimum gap while different hosts run in parallel; 429/5xx are retried with backoff and honour `Retry-After`; 403/404 and unparsable pages are not retried. A listing that fails ten times in a row is deactivated and raises an alert.

**Scraping is not automatically legal.** robots.txt is a technical signal, not permission — many retailers forbid it in their terms of service regardless. Check the terms of every site you add.

---

## 7. Alerting

`price_drop`, `price_rise`, `undercut`, `all_time_low`, `out_of_stock`, `scrape_failing`.

Alerts are **persisted before delivery**, so a Slack outage cannot lose one, and a failed alert can be inspected and retried. Channels are independent — Slack failing does not stop the webhook. A cooldown (`ALERT_COOLDOWN_MINUTES`) stops a listing oscillating around the threshold from paging someone hourly.

```
ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ALERT_WEBHOOK_URL=https://your-app.example.com/hooks/price
ALERT_WEBHOOK_SECRET=...   # payloads signed HMAC-SHA256 in X-Signature
```

With neither set, alerts are still stored, with `deliveryStatus: "skipped"`.

---

## 8. Billing and API keys

### Flow

```
customer pays on your frontend
        ↓
Paddle / Lemon Squeezy → POST /api/v1/billing/webhook
        ↓
signature verified over the RAW body (HMAC-SHA256, constant time, freshness window)
        ↓
event id claimed under a unique index  → retries collapse into one
        ↓
user found or created → status=active, plan + limits applied
        ↓
first time only: a 256-bit API key is generated, hashed, stored
        ↓
plaintext returned once — email it here; it can never be retrieved again
```

### Keys are never stored in plaintext

The `users` table holds a SHA-256 hash plus a display prefix. A database leak does not compromise anyone's account. Rotation is destructive on purpose: issuing a new key kills the old one immediately.

### Two kinds of key

- **Customer keys** — issued by billing, looked up in the database, must belong to an `active` account whose access window has not lapsed. A genuine key on a lapsed account gets **403 with a "renew your subscription" message**, not 401 — so a client can tell "pay us" from "check your credentials".
- **Operator keys** — `API_KEY` / `API_KEYS` from the environment. They exist because the system must be administrable before the first customer exists. Compared in constant time, never hit the database.

Lookups are cached for `API_KEY_CACHE_TTL_MS` (default 30s), including misses, so an invalid-key flood cannot become a database flood.

### Testing the webhook locally

```bash
node -e "const c=require('crypto'),b=JSON.stringify({event_id:'evt_'+Date.now(),event_type:'subscription.created',data:{id:'sub_1',customer:{email:'you@example.com'}}}),t=Math.floor(Date.now()/1000);require('fs').writeFileSync('/tmp/wh.json',b);console.log('ts='+t+';h1='+c.createHmac('sha256',process.env.PADDLE_WEBHOOK_SECRET).update(t+':'+b).digest('hex'))"
```

Then POST `/tmp/wh.json` with that value as the `Paddle-Signature` header.

---

## 9. Migrations

`DB_SYNCHRONIZE` is **false**. Schema changes go through migrations:

```bash
npm run migration:generate -- src/database/migrations/YourChange
```

```bash
npm run migration:run
```

Three migrations ship: the baseline schema (idempotent, so an existing `synchronize`-built database adopts it cleanly), the competitors/alerts/billing tables, and a data backfill that gives every pre-existing product its primary listing — without it those products would be silently skipped by every sweep.

---

## 10. Scripts

```bash
npm run start:dev        # watch mode
npm run build            # compile to dist/
npm test                 # unit tests, no database needed
npm run test:e2e         # end-to-end, needs a reachable database
npm run lint             # eslint --fix
npm run seed             # demo catalog (add -- --reset to wipe first)
npm run migration:run    # apply pending migrations
```

---

## 11. Before this earns money

- **Rotate the credentials.** The database password and Supabase keys were shared in plain text during setup, and `API_KEY` is a sample.
- **Set a real `PADDLE_WEBHOOK_SECRET`.** Without it the webhook rejects everything — which is the correct failure mode, but it means no customer is ever provisioned.
- **Send the key to the customer.** `BillingService` issues it and logs that it must be delivered; wiring the actual email is the one deliberate gap, because it needs an email provider you choose.
- **Set `CORS_ORIGINS`** to your frontend instead of `*`.
- **Check each retailer's terms** before adding it.
- **Enforce `productLimit`.** The plan limits are stored on the user; the check at product-creation time is not wired up yet.
