# nest-api — Price Intelligence API

Supplier price comparison for buyers, sold as a paid API with a web front end. NestJS + TypeORM on Supabase PostgreSQL, real web scraping, alerting, analytics, self-service free accounts and paid ones provisioned by Stripe webhooks.

---

## 1. What it does

A buyer — an electrician, a shop, a distributor — has five wholesale suppliers and no way to tell which is cheapest this morning.

1. They register their suppliers. Each is probed for a working search, and `robots.txt` is checked before anything else happens. A supplier with no website at all is added by uploading its price list.
2. They ask for one article, or price a whole order at once. Every supplier is asked in parallel and the offers are grouped by size, so 3x1.5 is never compared against a drum of 5x4.
3. What they buy regularly goes under watch. A scheduled sweep re-checks each listing, stores movements and raises alerts past a threshold, below a target price, or when a listing starts failing.
4. Alerts go to the customer's own email, to Slack, or to their webhook.
5. Analytics answer "which way is this moving and where am I losing".
6. Accounts: free ones self-serve at `POST /billing/signup`, paid ones are created by the Stripe webhook. Either way the key is issued once and emailed.

---

## 2. Stack

| Concern | Choice |
| --- | --- |
| Framework | NestJS 11 (TypeScript, strict null checks) |
| Database | Supabase PostgreSQL 17 via the session pooler |
| ORM | TypeORM 0.3, migrations, repository pattern |
| Scraping | axios + cheerio, robots.txt aware, per-host rate limiting |
| Scheduling | `@nestjs/schedule` dynamic cron |
| Payments | Stripe Checkout + webhooks (no card data touches this app) |
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
| GET/POST | `/api/v1/shops` | Suppliers to compare, including ones with no website |
| POST | `…/shops/:id/probe` | Re-check whether a supplier is searchable |
| GET/POST | `…/shops/:id/prices` | Prices you typed in yourself, for a supplier with no site |
| GET | `/api/v1/discovery/search` | Live search across your suppliers |
| **POST** | **`/api/v1/discovery/basket`** | **Price a whole order at every supplier** |
| GET | `/api/v1/discovery/compare` | Offers for one article, grouped |
| POST | `/api/v1/discovery/detect` | Probe a domain before adding it |
| **POST** | **`/api/v1/billing/signup`** | **Public. Free account + key, no card** |
| POST | `/api/v1/billing/checkout` | Public. Starts a Stripe Checkout Session |
| GET | `/api/v1/billing/plans` | Public. Which plans have a Stripe price configured |
| POST | `/api/v1/billing/webhook` | Stripe events |
| GET | `/api/v1/billing/events` | Recent webhooks, for support |
| GET | `/api/v1/billing/me` | The calling account: plan, limit, key prefix |
| GET | `/api/v1/stats` | Public. Aggregate counters the landing page prints |
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

## 6a. Product matching

Three suppliers, one bulb, three names:

```
PHILIPS LED BULB 12W E27 4000K
Philips CorePro LED 12W 840 E27
LED E27 Philips 12W Neutral White
```

The buyer needs these treated as one article and priced against each other. Text matching cannot do it — the second says `840` where the first says `4000K` — and asking a model about every pair would cost more than the subscription.

### The ladder

Evidence strongest first. Each rung that answers ends the comparison.

| # | Rung | Confidence | Costs |
| --- | --- | --- | --- |
| 1 | EAN/UPC/GTIN, checksum verified | 1.00 | nothing |
| 2 | Supplier article number | 0.99 | nothing |
| 3 | **Stated conflict** in something identifying | 0.00, blocked | nothing |
| 4 | Shared model code (`H05V-K`, `ST9453B`) | 0.95 | nothing |
| 5 | Brand + two agreeing specifications | 0.86–0.94 | nothing |
| 6 | Partial evidence — some agreement, incomplete | 0.35–0.84 | **one model call, batched** |

The three names above are settled at rung 5. What reaches a model is the rest: a German listing that shares no vocabulary with a Bulgarian query, or one that names the brand and nothing else.

Rung 3 sits below the identifiers deliberately. A barcode is issued per variant, so a shared one cannot mean two capacities; a model code is shared across a family, so where the names state 128 GB against 256 GB, the names win.

### What cannot match

A difference in a stated identifying attribute is not a matter of opinion, so it never reaches a model and no model can overturn it:

- `iPhone 15 128GB` vs `iPhone 15 256GB`
- `Samsung TV 55"` vs `Samsung TV 65"`
- `12W` vs `15W`, `3x1.5` vs `5x4`, Philips vs Osram

A specification stated by one side and missing on the other is **not** a conflict — that is exactly the `840` case — so silence lowers confidence and is what the model is asked about.

### Category-specific attributes

Two numbers in gigabytes are not one fact. `16GB 512GB` is memory *and* storage, and reading them as an unlabelled pair costs twice: two listings agreeing on both look like one agreement, and a listing quoting only the disk looks like it disagrees about memory it never mentioned.

Which number is which cannot be read off the unit, so it is read off the category and the magnitudes — the way a person does it:

| Category | Roles |
| --- | --- |
| laptop, phone | memory / storage (smaller is RAM where both are stated; TB is storage at 1000 GB), screen, CPU clock |
| monitor, tv | screen size, refresh rate |
| LED bulb | power, colour temperature, luminous flux (never identifying), voltage |
| cable | cross-section, length, voltage |
| breaker | current, voltage |

Categories are recognised in Bulgarian, English, German and French. Where the category is unknown, measurements are compared by unit, and a side quoting fewer values in the same unit is treated as having said less rather than something different.

### Model routing

Routine matching runs on **Claude Haiku**, chosen at runtime by asking the API which models the account has (`models.list()`) rather than hard-coding an id that will one day be retired. If Haiku is absent the cheapest available model is used, with a warning. Nothing calls Opus for a product search.

With no `ANTHROPIC_API_KEY` the AI half is off and matching still works — rungs 1 to 5 answer most pairs. That is the normal state of a fresh deployment, not a degraded one.

```
ANTHROPIC_API_KEY=sk-ant-...        # absent = deterministic matching only
AI_MATCHING_ENABLED=true
AI_MATCH_MODEL=                     # pin one only to reproduce a disputed match
AI_MATCH_MAX_CANDIDATES=12          # per search, after ranking
AI_MATCH_TIMEOUT_MS=9000
```

### What keeps it cheap

- **Deterministic first.** A catalogue with barcodes never pays.
- **One call per search**, not one per candidate, and only for the shortlist that ranking already kept.
- **Verdicts are cached** under `sha256(normalised query | normalised candidate | model | prompt version)`. "12 watt" and "12W" are one question; a new prompt or model asks again rather than inheriting an answer it never gave.
- **Metered per account**, apart from price checks: a price check is one request to a shop, a comparison is tokens. Limits are 200 / 2 000 / 10 000 / 50 000 a month by plan. An account that runs out keeps searching with the AI half off.

`GET /api/v1/discovery/compare` reports exactly what happened, so the cost is inspectable rather than assumed:

```json
"matching": {
  "candidates": 24,
  "decidedDeterministically": 21,
  "aiCallsMade": 1,
  "aiCacheHits": 2,
  "aiModel": "claude-haiku-4-5",
  "aiSkippedReason": null
}
```

Pass `?ai=false` to compare on specifications alone.

### Confidence, and what the interface does with it

| Band | Meaning | In the table |
| --- | --- | --- |
| 0.95–1.00 | Something checkable proved it | `съвпада 96%` |
| 0.85–0.94 | Specifications agree | `съвпада 88%` |
| 0.70–0.84 | Probably, something unverified | `вероятно 78%` |
| below 0.70 | Not convinced | listed under **Може да не е същият артикул** |

Rows below 0.70 are shown but excluded from the price comparison — they cannot win "cheapest", and they do not set the range or the saving. A lower price on a different article is not a saving, and letting one head the table argues for buying the wrong thing.

A model may raise confidence but never past 0.94: the bands above are reserved for evidence a customer can check themselves. Every row carries its reasoning — brand, wattage, socket, one line each — because a match nobody can check is a match nobody should trust with an order.

---

## 7. Alerting

`price_drop`, `price_rise`, `undercut`, `all_time_low`, `out_of_stock`, `scrape_failing`.

Alerts are **persisted before delivery**, so a Slack outage cannot lose one, and a failed alert can be inspected and retried. Channels are independent — Slack failing does not stop the webhook. A cooldown (`ALERT_COOLDOWN_MINUTES`) stops a listing oscillating around the threshold from paging someone hourly.

Three channels:

```
ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
ALERT_WEBHOOK_URL=https://your-app.example.com/hooks/price
ALERT_WEBHOOK_SECRET=...          # payloads signed HMAC-SHA256 in X-Signature
ALERT_EMAIL_FALLBACK_TO=ops@...   # only for alerts whose product has no owner
```

Slack and the webhook are one endpoint for the whole deployment — an operator's channels. **Email is the customer's**: the recipient is resolved per alert from the account that owns the product, and it is on whenever SMTP is configured. An owner that cannot be resolved sends nothing rather than falling back, because the fallback is an operator inbox and these are somebody's negotiated prices.

With no channel configured, alerts are still stored, with `deliveryStatus: "skipped"`.

---

## 8. Billing and API keys

### Two ways in

**Free, self-served.** `POST /billing/signup` with an email creates an active account on the free plan (10 tracked articles), issues a key, emails it *and* returns it in the response — an onboarding that depends on an inbox loses everyone whose mail is slow or mistyped. Throttled to 5 per hour per IP. An address that already has an account is refused with 409 rather than re-keyed: issuing is destructive, so re-keying would let a stranger lock a customer out.

**Paid.**

```
visitor clicks a plan → POST /api/v1/billing/checkout → Stripe Checkout
        ↓
Stripe → POST /api/v1/billing/webhook
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

- **Customer keys** — issued by signup or by billing, looked up in the database, must belong to an `active` account whose access window has not lapsed. A genuine key on a lapsed account gets **403 with a "renew your subscription" message**, not 401 — so a client can tell "pay us" from "check your credentials".
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

## 11. Launch checklist

Ordered so nothing on the list depends on something below it.

**Blocking — a customer hits these on day one**

- [ ] **Fill in `COMPANY`** near the bottom of [public/index.html](public/index.html): company name, EIK, address, contact email, mail provider, effective date. Until then the terms, the privacy policy, the GDPR appendix, the footer and every "write to us" button show `[ФИРМА]` and the contact link is disabled — visibly, on purpose.
- [ ] **Have a lawyer read the three legal pages.** They are written against what the code actually does, which is the hard half, but they are not legal advice.
- [ ] **Rotate the credentials.** The database password and Supabase keys were shared in plain text during setup, and `API_KEY` is a sample.
- [ ] **Set `CORS_ORIGINS`** to your domain instead of `*`.
- [ ] **Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and a price id per plan** (`STRIPE_STARTER_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, `STRIPE_BUSINESS_PRICE_ID`). Without them the pricing buttons degrade to "write to us" — correct, but nobody can buy. `GET /billing/plans` tells you what is live.
- [ ] **Check SMTP** with `GET /billing/mail/health` (operator key). Email carries both the API keys and the alerts; without it a paid account is a support ticket.
- [ ] **Point `APP_URL`** at the real domain — Stripe redirects back to it after checkout.

**Worth doing before you advertise**

- [ ] Add your own suppliers and run one real order through `POST /discovery/basket`. The first search per supplier takes 6–20 seconds; after that it is cached.
- [ ] Decide what `ALERT_EMAIL_FALLBACK_TO` should be, or leave it unset.
- [ ] **Optional: set `ANTHROPIC_API_KEY`** to switch on the AI half of product matching. Without it matching runs on barcodes, article numbers and specifications, which answers most pairs; with it the awkward ones — a German listing against a Bulgarian query — are answered too. See section 6a for what it costs and how it is bounded.
- [ ] Optional: set `FX_RATES_PER_EUR` (e.g. `USD:1.08,GBP:0.85`) if any supplier quotes outside BGN/EUR. Unset, those prices are reported as uncomparable rather than converted at a guess.
- [ ] **Check each supplier's terms** before adding it. `robots.txt` is honoured automatically; terms of service are not machine-readable and remain a human decision.
- [ ] Watch `GET /stats` — it is what the landing page prints, so it is also the fastest way to see whether sweeps are working.

**Already done, listed so it is not redone**

- Free self-serve signup, product limits enforced per plan at creation time, API keys emailed on issue, alerts by email as well as Slack and webhook, real counters on the landing page, terms/privacy/GDPR pages, Stripe Checkout wired end to end.
