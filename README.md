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
7. Every new account gets **7 days of Pro, no card**. When it lapses the account drops to the free plan and the articles above that plan's limit are switched off rather than deleted — the week of data entry survives, and paying switches them back on. See `src/billing/trial.service.ts`.

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
| Hardening | helmet + explicit CSP, CORS allowlist, `@nestjs/throttler`, HMAC webhook signatures |

### Hardening notes

- **`CORS_ORIGINS=*` is refused at boot in production.** List the real origins.
- **The CSP is written out in `main.ts`**, and `script-src` is `'self'` alone — no `'unsafe-inline'`, no `'unsafe-eval'`. That is what makes an injected `<script>` inert on a page that keeps a session token in `localStorage`. It is affordable only because the front end has no inline script left: the stylesheet is built (`npm run build:css`) instead of compiled in the browser by the Tailwind CDN, and the application lives in `public/app.js`. Swagger UI needs inline script, so it gets a relaxed policy on its own path rather than the whole origin losing the header.
- **Sign-in links are rate limited twice**: per IP by the controller's throttle, and per mailbox in `AuthService`, so a caller with many IPs cannot bury one inbox.
- **Optional two-factor authentication (TOTP).** This is the answer to the one real weakness in a passwordless design: sign-in proves the mailbox, so whoever holds the mailbox holds the account — and a password would not change that, because a password reset goes through the same mailbox. The secret is the only value in the system that cannot be a digest (codes are computed from it), so it is encrypted with `TOTP_ENCRYPTION_KEY`, held in the environment rather than the database. Set that key or the feature refuses to switch on. Endpoints: `POST /auth/totp/setup`, `/enable`, `/disable`, `/verify`. The algorithm is implemented in `src/auth/totp.ts` and pinned by the RFC 6238 test vectors, which is what makes owning forty lines safer than a dependency in the authentication path.
- **Sessions are visible and revocable**: `GET /auth/sessions` lists the signed-in devices, `DELETE /auth/sessions/:id` ends one, `POST /auth/sign-out-everywhere` ends them all. The API key is deliberately untouched by all three.
- **Crashes are reported**, when `SENTRY_DSN` is set. Request bodies, cookies and the `Authorization` / `X-API-KEY` headers are stripped before anything leaves — a customer's supplier list and their negotiated discounts do not belong in a third-party error tracker.

---

## 3. Setup

```bash
npm install
```

`.env` is filled in. The values that matter most:

```
DB_HOST=aws-1-eu-west-3.pooler.supabase.com   # verified against the live pooler
SCRAPER_DRIVER=http                            # http = real pages, simulation = generated
BILLING_PROVIDER=stripe                        # which webhook signature is verified
STRIPE_SECRET_KEY=...                          # required for billing
STRIPE_WEBHOOK_SECRET=...                      # without it a buyer pays and nothing is provisioned
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
├── billing/                    # User, BillingEvent, webhook signatures, key issuance, trials
├── styles/input.css            # Tailwind entry + the app's own CSS
└── health/
```

```
public/
├── index.html                  # markup only — no inline script, no inline style
├── app.js                      # the whole interface
├── i18n.js                     # language switching; see §11
├── theme.js                    # sets the theme class before first paint
├── locales/en.json             # Bulgarian source string → English
└── styles.css                  # generated by `npm run build:css`, not tracked
```

The front end was one 9 600-line file with its CSS and JavaScript inlined. It
was split for three reasons, in order of weight: a page with inline script
cannot carry a CSP worth having, a browser had to re-download the entire
application to pick up a one-character change, and the Tailwind CDN compiled
every class at runtime with `new Function`.

**If the interface renders unstyled, `public/styles.css` was not built.** Every
`start` and `build` script runs `build:css` first, and `main.ts` logs an error
at boot when the file is missing. While editing classes, `npm run watch:css`.

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
| GET | `/api/v1/scraper/status` | **Operator key.** Driver, schedule, listings due across the deployment, last sweep |
| POST | `/api/v1/scraper/run` | **Operator key.** Sweep every account's due listings |
| GET | `/api/v1/scraper/status/mine` | How many of *your* listings are due, and whether a refresh is running |
| POST | `/api/v1/scraper/run/mine` | Re-check *your own* due listings now |
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
| **POST** | **`/api/v1/auth/register`** | **Public. Registers and emails a verification link** |
| POST | `/api/v1/auth/sign-in` | Public. Emails a one-time sign-in link |
| POST | `/api/v1/auth/session` | Public. Trades a link for a browser session |
| POST | `/api/v1/auth/sign-out` | Ends this session only |
| POST | `/api/v1/billing/checkout` | Public. Starts a Stripe Checkout Session |
| GET | `/api/v1/billing/plans` | Public. Which plans have a Stripe price configured |
| POST | `/api/v1/billing/webhook` | Stripe events |
| GET | `/api/v1/billing/events` | Recent webhooks, for support |
| GET | `/api/v1/billing/me` | The calling account: plan, limit, key prefix |
| GET | `/api/v1/stats` | Public. Aggregate counters the landing page prints |
| GET | `/health` | Public liveness + database probe |

---

> **Why two pairs of routes.** The deployment-wide `status` and `run` are
> operator-only because the sweep walks *every* tenant's queue: its per-listing
> results name products and suppliers belonging to accounts other than the
> caller's, and triggering it spends the platform's request budget against
> suppliers the caller has no relationship with. `status/mine` and `run/mine`
> answer the same questions for one account and can name nobody else.

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

Routine matching runs on **Claude Haiku**, chosen at runtime by asking the API which models the account has (`models.list()`) rather than hard-coding an id that will one day be retired. Accounts list aliases (`claude-haiku-4-5`), dated snapshots (`claude-haiku-4-5-20251001`) or both, so the match is by prefix — the alias wins where both appear, since it keeps following the current snapshot. If no Haiku is listed the cheapest available model is used, with a warning. Nothing calls Opus for a product search.

Check what a deployment resolved to:

```bash
curl -s localhost:3000/api/v1/matching/health -H "x-api-key: $API_KEY"
```

With no `ANTHROPIC_API_KEY` the AI half is off and matching still works — rungs 1 to 5 answer most pairs. That is the normal state of a fresh deployment, not a degraded one.

```
ANTHROPIC_API_KEY=                  # a real key from console.anthropic.com; empty = deterministic matching only
AI_MATCHING_ENABLED=true
AI_MATCH_MODEL=                     # pin one only to reproduce a disputed match
AI_MATCH_MAX_CANDIDATES=12          # per search, after ranking
AI_MATCH_TIMEOUT_MS=9000
```

### What keeps it cheap

- **Deterministic first.** A catalogue with barcodes never pays.
- **One call per search**, not one per candidate, and only for the shortlist that ranking already kept.
- **Verdicts are cached** under `sha256(normalised query | normalised candidate | model | prompt version)`. "12 watt" and "12W" are one question; a new prompt or model asks again rather than inheriting an answer it never gave.
- **Metered per account**, apart from price checks: a price check is one request to a shop, a comparison is tokens. Paid plans get 2 000 / 10 000 / 50 000 a month. The free plan gets **50 a month** — fifty Haiku comparisons cost cents, registration is throttled and refuses disposable domains, and a free plan whose meter stays at "50 of 50" for ever is a demo, not a plan. An account that runs out keeps searching with the AI half off until the month turns.

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

## 6b. Being tolerable to the suppliers

The scraper reads other companies' websites, so the question is not whether it
*can* but whether they will let it carry on. Three separate mechanisms, because
they answer different questions:

| Mechanism | Answers |
| --- | --- |
| Per-host serialisation + `SCRAPER_MIN_DELAY_MS` | How *fast* — never two overlapping requests to one shop, a second apart by default |
| `robots.txt`, including `Crawl-delay` | What the shop itself asks for. It always wins when it asks for more |
| `SCRAPER_HOST_DAILY_BUDGET` | How *many* — a hard ceiling per shop per day |
| `SCRAPER_SHARED_FETCH_MS` | How many *times over* — one page fetched once, however many customers watch it |

The last one is the one that decides whether this scales. The sweep walks
listing rows and every customer owns their own, so five hundred buyers watching
the same cable at the same shop used to be five hundred requests an hour for
one page: the request count scaled with **customers** rather than with
**articles**, and the more popular an article became the worse it got. The
share is keyed on the URL *and* the selector, so two customers reading
different prices off the same page still each get their own — handing one
customer another's number would be a wrong price presented with total
confidence, which is the one thing this product cannot do.

Rough arithmetic, and worth doing before advertising: 500 customers × 100
articles × 4 suppliers is 200,000 listings. Hourly, that is ~55 requests a
second spread over perhaps 30 Bulgarian shops — about 2 a second at each, day
and night, from one address. That gets blocked, and deserves to. With sharing,
the same load collapses to the number of *distinct* pages.

The best protection is still not technical. A supplier who understands that
being compared sends them orders usually has no objection; one conversation
with the five that matter is worth more than any setting, and if one says no it
is much better to know before their traffic goes up.

---

## 6c. Ordering

The comparison answers "where should I buy this today". Without the next
sentence the buyer copies that answer into an email by hand — the same forty
minutes the front page promises to give back, moved to the afternoon.

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/api/v1/orders` | Draft one order for one supplier, numbered within your account |
| GET | `/api/v1/orders` | Your orders, newest first |
| POST | `/api/v1/orders/:id/send` | Email it to the supplier |
| PATCH | `/api/v1/orders/:id/status` | Mark it confirmed or cancelled |
| DELETE | `/api/v1/orders/:id` | Discard a draft |

**This is not a marketplace, on purpose.** No money moves through it, nothing
is reserved, and the email goes out from the buyer's company with their address
in `Reply-To` — the supplier's answer reaches the person who can decide, not
us. Standing between two companies in a commercial transaction is a different
business with different liabilities, and it is not this one. The message says
whose order it is in the first line and labels the prices as *read from the
supplier's own site, please confirm*, because that is exactly what they are.

Three details worth keeping:

- **One order per supplier.** A basket split across three warehouses is three
  orders, because that is three deliveries and three invoices.
- **The supplier's name and address are copied onto the order, not joined.**
  Renaming a supplier next year must not rewrite what last year's order said.
- **Only `draft` and `sent` are known to the system.** Confirmed and cancelled
  happen in a phone call we never see, so the buyer marks them. A status
  guessed at would be worse than no status.

Requires `order_email` on the supplier. Without one the order still builds — it
just cannot be sent from here.

---

## 6d. Purchase decisions — the savings proof

The comparison says "you save €31.40". Three months later the customer is
deciding whether to renew, and that sentence is worth nothing unless it can be
turned into **"here is exactly why you saved €31.40"**.

It cannot be, if the number is recomputed from live rows. By November every
input has moved: the discount was renegotiated, delivery went up, the article
was relisted or delisted, the matcher was retrained, the optimiser was
improved. Recomputing would silently rewrite history, and the figure shown in
November would not be the figure the buyer acted on in August.

So a decision is **written down whole**, and never recomputed.

| Method | Path | What it does |
| --- | --- | --- |
| POST | `/api/v1/purchase-decisions` | Keep the plan from the last comparison |
| GET | `/api/v1/purchase-decisions` | Your decisions — pagination, date, supplier, savings sort |
| GET | `/api/v1/purchase-decisions/summary` | The savings screen |
| GET | `/api/v1/purchase-decisions/:id` | One decision, whole — the "how was this calculated?" payload |
| GET | `/api/v1/purchase-decisions/:id/orders` | Orders placed on it |

### How one is created, without running the optimiser twice

`POST /discovery/basket` already computes everything a decision needs. Running
the optimiser again at save time would ask the suppliers again and could return
a **different** plan — so the stored decision would not be the one the buyer
looked at. Equally, a decision must not be written on every comparison: the
interface re-prices whenever the supplier cap changes, and saving those would
fill the record with plans nobody chose and drag abandoned experiments into the
average saving.

The basket therefore returns a **sealed draft** — the complete snapshot plus an
HMAC over its canonical form — and stores nothing. If the buyer presses *use
this plan*, the client posts that object back unchanged and the server verifies
its own signature before writing a row. The result:

- no second optimiser run, no supplier re-queried, no model call — saving is
  one `INSERT`;
- nothing stored for a comparison nobody acted on;
- the round trip through an untrusted client **cannot** invent a saving;
- stateless, so it works across any number of containers.

The draft also expires after an hour. A signature says the figures are ours; it
says nothing about whether they are still worth acting on.

### Immutability

Enforced three times over, because this is evidence:

1. `PurchaseDecisionsService` has **no** update method.
2. A Postgres trigger (`trg_purchase_decisions_immutable`) raises on any UPDATE
   touching the snapshot, the terms, the plan or the saving.
3. Nothing joins to a supplier — the names, discounts and delivery terms are
   *copied*, so renaming or deleting a supplier changes no stored decision.

The only permitted change appends evidence of a purchase: `savings_kind`,
`realized_total` and `realized_savings`.

### Potential vs realized savings

Never merged, never summed. Reporting a forecast as a fact is the one claim a
customer will check against their own ledger.

- **Potential** — what the optimiser says the chosen plan avoids.
- **Realized** — what was avoided on a purchase that happened: every supplier
  in the plan has an order linked to the decision, and the buyer has marked
  each of them `confirmed`. Confirmation is the one fact only the buyer knows,
  which is why it is the gate.

A decision counts towards exactly one of the two. The realized figure takes
**goods from the linked orders** (the buyer may have trimmed a quantity before
sending) and **delivery and handling from the snapshot**, because an order
request does not carry them — keeping both sides of the comparison on the same
basis as the baseline, which includes delivery too.

### Provenance

Every line in a snapshot carries where its price came from — `live` / `cached`
/ `manual`, the URL, the supplier, when it was last confirmed and how old it
already was at the moment of the decision — and what settled its match: method,
confidence, the attributes compared, and whether a model was used with which
model and prompt version. Opening a decision after thirty days shows *"price
checked 28 Aug 2026, 14:31"*, not today's price.

### Retention

**Purchase decisions are business records and are never swept.** They are not
cache, and they must not be treated like `search_cache` or thinned like
`price_history`:

- no scheduled job deletes them, and none should be added;
- they survive the deletion of a supplier (`supplier_ids` is a plain array, not
  a foreign key) and of the orders placed on them;
- deleting a decision would break the order that references it, so the foreign
  key from `orders.purchase_decision_id` is `ON DELETE SET NULL` — the record
  of a purchase outlives the reasoning behind it, never the other way round.

The growth is bounded by how many orders a buyer actually places, which is tens
per month rather than the millions per year `price_history` sees. If a limit is
ever wanted, it belongs in an account-deletion path, not in a nightly sweep.

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

**Free, self-served — but not self-granted.** `POST /auth/register` creates a *pending* row and emails a link. Opening the link verifies the mailbox, activates the account, issues the key and opens a browser session in one step.

The key is deliberately not returned from the registration call. It used to be, on the argument that an onboarding depending on an inbox loses people — which is true, and beside the point: it made the address decoration, so a script could farm accounts and their monthly AI allowances from mailboxes nobody owns. Disposable domains and RFC 2606 addresses are refused outright, registration is throttled to 5 per hour per IP, and an address that already has an account is sent a sign-in link instead of a second registration.

**Signing in.** People get sessions, machines get keys. `POST /auth/sign-in` emails a one-time link (15 minutes, single use); `POST /auth/session` trades it for a session token sent as `Authorization: Bearer`; `POST /auth/sign-out` ends that one session and leaves other devices alone. The API key is untouched by any of it — rotating a key does not sign anyone out, and signing out does not break a customer's scripts.

**Paid.** Two ways, and the choice is a tax decision rather than a technical one.

| | Stripe | Paddle / Lemon Squeezy |
| --- | --- | --- |
| Who sells to the customer | you | them |
| Who owes EU VAT and files OSS | **you** | them |
| Who issues the invoice | you | them |
| Fees | lower | higher |
| Configuration here | `STRIPE_SECRET_KEY` + a price id per plan | `CHECKOUT_LINK_*` per plan |

`BILLING_PROVIDER` selects which webhook signature is verified — the event handling already understands Paddle, Lemon Squeezy and Stripe names. `CheckoutService` prefers a hosted link where one is set, because the merchant-of-record platforms hand out a URL per price rather than an API to create a session; Stripe's session API is used otherwise. A plan with neither is not offered for sale at all.



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

With `BILLING_PROVIDER=stripe`, the Stripe CLI forwards real test-mode events to the running app and signs them with the secret it prints on start — put that value in `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:3000/api/v1/billing/webhook
```

```bash
stripe trigger checkout.session.completed
```

Without the CLI, sign a body by hand. Stripe's header is `Stripe-Signature: t=<unix>,v1=<hex>` over `<t>.<raw body>`:

```bash
node -e "const c=require('crypto'),b=JSON.stringify({id:'evt_'+Date.now(),type:'checkout.session.completed',data:{object:{id:'cs_1',customer_details:{email:'you@example.com'},metadata:{plan:'pro'}}}}),t=Math.floor(Date.now()/1000);require('fs').writeFileSync('/tmp/wh.json',b);console.log('t='+t+',v1='+c.createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(t+'.'+b).digest('hex'))"
```

Then POST `/tmp/wh.json` with that value as the `Stripe-Signature` header.

For `BILLING_PROVIDER=paddle` the header is `Paddle-Signature: ts=<unix>;h1=<hex>` over `<ts>:<raw body>`, signed with `PADDLE_WEBHOOK_SECRET`.

---

## 8a. Price history retention

`price_history` is append-only, and it is the only table with no natural
ceiling: two thousand watched articles across four suppliers, re-checked
hourly, is roughly seventy million rows a year for one customer.

Nothing deletes a trend. `HistoryRetentionService` runs nightly and:

1. keeps **every** observation for `HISTORY_FULL_DAYS` (30), because "it moved
   twice on Tuesday" is a question people actually ask;
2. thins everything older to **one reading per listing per day**, which draws
   the same line at a thirtieth of the size;
3. drops anything past `HISTORY_KEEP_DAYS` (400) — just over a year, so this
   March can still be compared with last March.

Both passes are batched, because this runs against the database that is
serving customers.

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

### Reading `schema:log`

```bash
npm run schema:log
```

It will always propose a dozen statements, and **on a correctly migrated
database every one of them is wrong**. TypeORM compares the live schema against
what the *decorators* declare, and three kinds of object cannot be expressed as
a decorator at all:

- **Foreign keys** declared in migrations rather than as `@ManyToOne` relations
  — `fk_products_owner`, `fk_orders_owner`, `fk_orders_purchase_decision`;
- **Check constraints** — `chk_shops_vat_state`,
  `chk_purchase_decisions_realized`;
- **GIN and partial indexes** — `idx_purchase_decisions_suppliers` (array
  containment) and `idx_orders_purchase_decision` (partial, because nearly
  every order has no decision and indexing those NULLs would cost writes to
  answer nothing).

So the rule when reading it: **every line should be a `DROP`**, and every one
should name an object in that list. An `ADD` or an `ALTER … TYPE` is real
drift and means a migration is missing. Plain indexes *are* declared on the
entities and correctly stay out of the output.

The `purchase_decisions` immutability trigger is invisible to `schema:log`
entirely — TypeORM does not model triggers — which is another reason it is
written in the migration and asserted in tests rather than assumed.

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

## 10a. Continuous integration

`.github/workflows/ci.yml` runs lint, types, the 230 unit tests, the build and
a parse check over the front end on every push and pull request. The suite
existed before this did and was run when somebody remembered to, which is the
state in which tests quietly rot until the day they are needed.

The e2e suite is **not** in CI: it boots the real TypeORM connection and needs
a reachable database with credentials CI does not have. Run it by hand with
`npm run test:e2e`.

---

## 11. Launch checklist

Ordered so nothing on the list depends on something below it.

**Blocking — a customer hits these on day one**

- [ ] **Fill in `COMPANY`** near the bottom of [public/index.html](public/index.html): company name, EIK, address, contact email, mail provider, effective date. Until then the terms, the privacy policy, the GDPR appendix, the footer and every "write to us" button show `[ФИРМА]` and the contact link is disabled — visibly, on purpose.
- [ ] **Have a lawyer read the three legal pages.** They are written against what the code actually does, which is the hard half, but they are not legal advice.
- [x] **Run the migrations.** Last applied 2026-08-28: `SupplierCommercialTerms`, which adds the VAT, delivery and minimum-order columns every price now depends on. `npm run schema:log` proposes **seven** statements and no more, and all seven are TypeORM asking to drop constraints it has no metadata for — five foreign keys (`products.owner_id`, `search_cache.shop_id`, `auth_tokens.user_id`, `shops.owner_id`, `orders.owner_id`) and the two check constraints on `shops` (`chk_shops_vat_state`, `chk_shops_terms_non_negative`). That is the expected baseline; anything beyond those seven is real drift.
- [ ] **Rotate the credentials.** The database password and Supabase keys were shared in plain text during setup, and `API_KEY` is a sample.
- [ ] **Set `CORS_ORIGINS`** to your domain instead of `*`.
- [ ] **Repeat the Stripe setup in the live account.** The three plans, their prices and a hosted payment link each exist in the **test** account (`acct_1QdfKu…`) and are wired into `.env`, so `GET /billing/plans` answers `enabled: true` and the pricing buttons open a real Stripe page — one that takes test cards and no money. Create the same three in live, replace every value in the Stripe block of `.env`, and paste `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` yourself.
- [ ] **Set `STRIPE_WEBHOOK_SECRET` before selling anything.** A payment link takes the money on its own, but the webhook is what creates the account, issues the key and emails it. Until the secret is set, a buyer pays and receives nothing.
- [ ] **Check SMTP** with `GET /billing/mail/health` (operator key). Email carries both the API keys and the alerts; without it a paid account is a support ticket.
- [ ] **Point `APP_URL` and `APP_PUBLIC_URL`** at the real domain. Stripe redirects back to `APP_URL`, and every sign-in link in every email is built from `APP_PUBLIC_URL` — left at `localhost`, nobody but you can ever sign in.

**Worth doing before you advertise**

- [ ] Add your own suppliers and run one real order through `POST /discovery/basket`. The first search per supplier takes 6–20 seconds; after that it is cached.
- [ ] Decide what `ALERT_EMAIL_FALLBACK_TO` should be, or leave it unset.
- [ ] **Optional: set `ANTHROPIC_API_KEY`** to a real key from console.anthropic.com to switch on the AI half of product matching. Check it with `GET /api/v1/matching/health` (operator key) — a placeholder pasted literally is refused there and logged at boot rather than failing quietly on every search. Without it matching runs on barcodes, article numbers and specifications, which answers most pairs; with it the awkward ones — a German listing against a Bulgarian query — are answered too. See section 6a for what it costs and how it is bounded.
- [ ] Optional: set `FX_RATES_PER_EUR` (e.g. `USD:1.08,GBP:0.85`) if any supplier quotes outside BGN/EUR. Unset, those prices are reported as uncomparable rather than converted at a guess.
- [ ] **Check each supplier's terms** before adding it. `robots.txt` is honoured automatically; terms of service are not machine-readable and remain a human decision.
- [ ] Watch `GET /stats` — it is what the landing page prints, so it is also the fastest way to see whether sweeps are working.

**Already done, listed so it is not redone**

- Free self-serve signup, product limits enforced per plan at creation time, API keys emailed on issue, alerts by email as well as Slack and webhook, real counters on the landing page, terms/privacy/GDPR pages, Stripe Checkout wired end to end.
- A 7-day PRO trial on every new account, which ends by itself and parks rather than deletes what the free plan cannot watch (section 1, `src/billing/trial.service.ts`).
- A CSP that forbids inline script, sign-in links rate limited per mailbox as well as per IP, and `CORS_ORIGINS=*` refused at boot in production.
- English, switchable in the header (section 12), and a Dockerfile (section 13).

---

## 12. Languages

Bulgarian is the source, not a translation: the markup is written in it and
stays that way. Every other language is `public/locales/<code>.json`, a
dictionary keyed by the Bulgarian string — so editing a sentence in the HTML
makes its translation stop matching and the page falls back to the source,
rather than showing last month's wording in confident English.

To add a language: copy `en.json`, translate the values, and add the code to
`LANGUAGES` in `public/i18n.js`. Nothing else changes.

Two things are deliberately excluded. **The legal pages** (terms, privacy,
GDPR) and the operator screen stay Bulgarian — those three are written against
Bulgarian law, and a machine translation of them is a liability rather than a
feature. And **strings assembled in JavaScript** are only partly covered:
whole strings inserted into the page are translated by the observer in
`i18n.js`, but a phrase built by pasting a number into a sentence has to go
through `formatMessage` / `pluralMessage` in `app.js` by hand. The ones on the
dashboard do; some toasts and dialog messages do not yet, and fall back to
Bulgarian.

---

## 13. Deployment

```bash
docker build -t stoclify .
```

```bash
docker run --env-file .env -p 3000:3000 stoclify
```

The image is two-stage: the build stage compiles TypeScript and generates the
stylesheet, the runtime stage carries neither the compiler nor dev
dependencies, runs as `node` rather than root, and declares a `HEALTHCHECK`
against `/health` so a host will not route traffic to a container that cannot
reach its database.

Before the first real deploy, three environment values must be right or the
product does not work:

| Variable | Why it blocks |
| --- | --- |
| `APP_PUBLIC_URL` | Every sign-in link points here. Left as `localhost`, no customer can ever sign in. |
| `CORS_ORIGINS` | `*` is refused at boot in production. List the real origins. |
| `CHECKOUT_LINK_*` | Empty means the pricing buttons say "contact us" instead of taking money. |

---

