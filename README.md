# nest-api — Price Intelligence API

Competitor price tracking service. NestJS + TypeORM connected directly to a cloud Supabase PostgreSQL instance, documented with OpenAPI, protected by an API-key guard.

---

## 1. Stack

| Concern        | Choice                                                  |
| -------------- | ------------------------------------------------------- |
| Framework      | NestJS 11 (TypeScript, strict null checks)              |
| Database       | Supabase PostgreSQL 17 via the session pooler           |
| ORM            | TypeORM 0.3 (`@nestjs/typeorm`), repository pattern     |
| Validation     | `class-validator` + `class-transformer` DTOs            |
| Docs           | OpenAPI 3 / Swagger UI at `/api/docs`                   |
| Scheduling     | `@nestjs/schedule` dynamic cron job                     |
| Auth           | `X-API-KEY` header, constant-time comparison            |
| Hardening      | `helmet`, CORS allowlist, `@nestjs/throttler`           |

---

## 2. Setup

### 2.1 Install

```bash
npm install
```

### 2.2 Configure

`.env` is already filled in with your Supabase credentials. The only value that is not obvious from the dashboard is the pooler host, which was verified against the live pooler:

```
DB_HOST=aws-1-eu-west-3.pooler.supabase.com   # project hvbmnlvknptlclhxlxbi lives in eu-west-3
DB_PORT=5432                                   # session pooler (DDL + synchronize)
DB_USERNAME=postgres.hvbmnlvknptlclhxlxbi
DB_NAME=postgres
```

Use port `6543` instead if you deploy to a serverless platform — that is the transaction pooler; it does not support prepared statements, so keep `DB_SYNCHRONIZE=false` and use migrations there.

### 2.3 Run

```bash
npm run start:dev
```

On first boot `DB_SYNCHRONIZE=true` creates `products`, `price_history` and the `products_scrape_status_enum` type in your Supabase database.

| URL                                  | What                              |
| ------------------------------------ | --------------------------------- |
| http://localhost:3000/api/docs       | Swagger UI (click **Authorize**)  |
| http://localhost:3000/api/docs-json  | Raw OpenAPI document              |
| http://localhost:3000/api/v1         | REST API                          |
| http://localhost:3000/health         | Public probe (no API key)         |

### 2.4 Try it

```bash
curl -X POST http://localhost:3000/api/v1/products \
  -H "X-API-KEY: pk_dev_9f2b7c41a5e84d16b0c3ee77a1d24f80" \
  -H "Content-Type: application/json" \
  -d '{"name":"Sony WH-1000XM5","targetUrl":"https://shop.example.com/p/1","competitorUrl":"https://competitor.example.com/p/1","currentPrice":309.00,"targetPrice":279.00}'
```

Then trigger a price check for that product:

```bash
curl -X POST "http://localhost:3000/api/v1/scraper/products/<PRODUCT_ID>/refresh" -H "X-API-KEY: pk_dev_9f2b7c41a5e84d16b0c3ee77a1d24f80"
```

---

## 3. Project structure

```
src/
├── main.ts                     # bootstrap: helmet, CORS, prefix, ValidationPipe, Swagger
├── app.module.ts               # ConfigModule, TypeOrmModule.forRootAsync, global guards/filter
├── swagger.ts                  # OpenAPI document + Swagger UI setup
├── config/
│   ├── env.validation.ts       # whitelist + validation of every env var (fails fast at boot)
│   └── configuration.ts        # typed, nested runtime configuration
├── database/
│   ├── typeorm-options.factory.ts  # shared connection options (app + CLI)
│   └── data-source.ts          # DataSource for the TypeORM migration CLI
├── common/
│   ├── guards/api-key.guard.ts # global X-API-KEY guard
│   ├── decorators/             # @Public(), @ApiKeyAuth()
│   ├── dto/                    # pagination, page envelope, error shape
│   ├── filters/                # exception -> consistent JSON, PG error codes -> HTTP
│   ├── interceptors/           # access log
│   ├── swagger/                # generic paginated-response schema helper
│   └── transformers/           # numeric column -> number
├── products/
│   ├── entities/product.entity.ts
│   ├── entities/price-history.entity.ts
│   ├── dto/                    # create, update, query, record-price, price-check-result
│   ├── products.service.ts     # CRUD + transactional price application
│   ├── products.controller.ts
│   └── products.module.ts
├── scraper/
│   ├── price-fetcher.service.ts  # simulated competitor fetch — the swap-in seam
│   ├── scraper.service.ts        # cron sweep, concurrency, overlap protection
│   ├── scraper.controller.ts
│   └── scraper.module.ts
└── health/                     # public liveness + Supabase probe
```

---

## 4. Endpoints

All routes require `X-API-KEY` except `/health`.

| Method | Path                                       | Purpose                                              |
| ------ | ------------------------------------------ | ---------------------------------------------------- |
| POST   | `/api/v1/products`                         | Track a new product                                  |
| GET    | `/api/v1/products`                         | List — search, filters, sorting, pagination          |
| GET    | `/api/v1/products/stats`                   | Aggregate counters for dashboards                    |
| GET    | `/api/v1/products/:id`                     | One product                                          |
| PATCH  | `/api/v1/products/:id`                     | Partial update                                       |
| DELETE | `/api/v1/products/:id`                     | Delete product + history (cascade)                   |
| GET    | `/api/v1/products/:id/history`             | Price observations, newest first                     |
| POST   | `/api/v1/products/:id/prices`              | Record a price observed elsewhere                    |
| GET    | `/api/v1/scraper/status`                   | Scheduler state, products due, last sweep summary    |
| POST   | `/api/v1/scraper/run`                      | Run a sweep now                                      |
| POST   | `/api/v1/scraper/products/:id/refresh`     | Re-check one product, ignoring its interval          |
| GET    | `/health`                                  | Public liveness + database probe                     |

List query parameters: `search`, `isActive`, `scrapeStatus`, `minPrice`, `maxPrice`, `undercutOnly`, `sortBy`, `sortOrder`, `limit`, `offset`.

---

## 5. How the pieces work

### API key guard

`ApiKeyGuard` is registered globally through `APP_GUARD`, so **every** route is protected unless it carries `@Public()`. It hashes both the presented key and the configured keys with SHA-256 and compares with `timingSafeEqual`, which keeps the comparison constant-time and immune to length-based probing. `API_KEYS` accepts a comma-separated list so a key can be rotated without downtime: add the new key, let clients migrate, then drop the old one.

### Data model

`products` holds the current state; `price_history` is an append-only log of observations. That split is what makes this a price *intelligence* API rather than a price *storage* API — trends, undercut detection and repricing rules all read from the history.

Money is stored as `numeric(12,2)`, never floating point, and converted to `number` at the entity boundary by `NumericColumnTransformer`.

### Applying a price

`ProductsService.applyPriceObservation()` is the single write path used by both the scraper and the manual endpoint. It runs in one transaction with a `SELECT ... FOR UPDATE` on the product row, so two concurrent checks cannot interleave and produce inconsistent history. It writes a history row **only when the price actually changed** — otherwise an hourly sweep would append millions of identical rows per year. It also maintains `lowestPrice` / `highestPrice`, resets the failure state, and flags moves beyond `SCRAPER_ALERT_THRESHOLD_PERCENT` plus undercuts of `targetPrice`.

### Scraper

`ScraperService` registers its cron job dynamically from `SCRAPER_CRON`, so the schedule changes with an env var rather than a code change. Per sweep it takes the products whose own `checkIntervalMinutes` has elapsed, oldest first, up to `SCRAPER_BATCH_SIZE`, and processes them through a fixed worker pool of `SCRAPER_CONCURRENCY`. Overlapping sweeps are skipped. A product that fails 10 checks in a row is deactivated so a dead URL stops burning requests.

`PriceFetcherService.fetch()` is the **only** simulated part: a bounded random walk around the last known price with a 5% simulated failure rate. Replace its body with a real HTTP request plus a per-retailer parser (or a scraping provider) and nothing else in the codebase changes.

---

## 6. Moving off `synchronize`

`synchronize: true` is fine for this first boot and dangerous afterwards — it will silently drop columns to match the entities. Once the schema exists:

```bash
# 1. turn it off
#    .env: DB_SYNCHRONIZE=false

# 2. capture the current schema as the baseline migration
npm run migration:generate -- src/database/migrations/InitialSchema

# 3. apply migrations from now on
npm run migration:run
```

The CLI uses `src/database/data-source.ts`, which reuses the same connection options and forces `synchronize: false`.

---

## 7. Scripts

```bash
npm run start:dev        # watch mode
npm run build            # compile to dist/
npm run start:prod       # run the compiled build
npm test                 # unit tests (no database needed)
npm run test:e2e         # end-to-end tests (needs a reachable database)
npm run lint             # eslint --fix
npm run migration:run    # apply pending migrations
```

---

## 8. Security notes

- `.env` is gitignored. The credentials in it were shared in plain text during setup — **rotate the database password** (Supabase → Project Settings → Database → Reset password) and replace the sample `API_KEY` with a long random secret before this touches anything real:
  ```bash
  node -e "console.log('pk_' + require('crypto').randomBytes(24).toString('hex'))"
  ```
- `DB_SSL_REJECT_UNAUTHORIZED=false` accepts Supabase's pooler certificate without verifying the chain. For strict verification, download the project CA certificate from the dashboard and pass it as `ssl.ca` in `typeorm-options.factory.ts`.
- `CORS_ORIGINS=*` is a development default. Set an explicit comma-separated allowlist before deploying.
- The API key is a service-to-service secret. It is never logged — the access-log interceptor deliberately records no headers.
- `SUPABASE_JWKS_URL` is present in `.env` for the next step: verifying Supabase Auth JWTs for end-user requests, alongside the API key used for machine clients.
