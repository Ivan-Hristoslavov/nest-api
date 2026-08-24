import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/** Merchant of record handling payments. */
export enum BillingProvider {
  Paddle = 'paddle',
  LemonSqueezy = 'lemonsqueezy',
  Stripe = 'stripe',
}

/** Which price source the scraper uses. */
export enum ScraperDriver {
  /** Fetch and parse real competitor pages. */
  Http = 'http',
  /** Generate plausible movement without network access. */
  Simulation = 'simulation',
}

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Staging = 'staging',
  Production = 'production',
}

/**
 * Coerces the loose string values coming from `process.env` into booleans.
 * Accepts: true/false, 1/0, yes/no, on/off (case-insensitive).
 */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return value;
};

const toNumber = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? value : parsed;
};

/**
 * Whitelist of every environment variable the application understands.
 * Validation runs once at bootstrap: a malformed .env fails fast and loudly
 * instead of producing a half-configured app that dies on the first query.
 */
export class EnvironmentVariables {
  // --- Application ---------------------------------------------------------
  @IsEnum(NodeEnvironment)
  @IsOptional()
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  PORT = 3000;

  @IsString()
  @IsOptional()
  API_PREFIX = 'api/v1';

  @IsString()
  @IsOptional()
  SWAGGER_PATH = 'api/docs';

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  SWAGGER_ENABLED = true;

  @IsString()
  @IsOptional()
  CORS_ORIGINS = '*';

  @IsString()
  @IsOptional()
  LOG_LEVEL = 'log';

  // --- API key auth --------------------------------------------------------
  @IsString()
  @IsOptional()
  API_KEY_HEADER = 'x-api-key';

  @IsString()
  @IsNotEmpty({ message: 'API_KEY must be set — it protects every endpoint of this API' })
  API_KEY!: string;

  @IsString()
  @IsOptional()
  API_KEYS?: string;

  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @IsOptional()
  API_KEY_CACHE_TTL_MS = 30000;

  // --- Billing -------------------------------------------------------------
  @IsEnum(BillingProvider)
  @IsOptional()
  BILLING_PROVIDER: BillingProvider = BillingProvider.Paddle;

  @IsString()
  @IsOptional()
  PADDLE_WEBHOOK_SECRET?: string;

  @IsString()
  @IsOptional()
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;

  @Transform(toNumber)
  @IsInt()
  @Min(5)
  @Max(3600)
  @IsOptional()
  BILLING_SIGNATURE_TOLERANCE_SECONDS = 300;

  // --- Database ------------------------------------------------------------
  @IsString()
  @IsNotEmpty()
  DB_HOST!: string;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  DB_PORT = 5432;

  @IsString()
  @IsNotEmpty()
  DB_USERNAME!: string;

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD!: string;

  @IsString()
  @IsNotEmpty()
  DB_NAME!: string;

  @IsString()
  @IsOptional()
  DB_SCHEMA = 'public';

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  DB_SSL = true;

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  DB_SSL_REJECT_UNAUTHORIZED = false;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  DB_POOL_SIZE = 10;

  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  DB_POOL_MIN_SIZE = 2;

  @Transform(toNumber)
  @IsInt()
  @Min(1000)
  @IsOptional()
  DB_CONNECT_TIMEOUT_MS = 15000;

  @Transform(toNumber)
  @IsInt()
  @Min(1000)
  @IsOptional()
  DB_IDLE_TIMEOUT_MS = 600000;

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  DB_SYNCHRONIZE = false;

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  DB_LOGGING = false;

  // --- Supabase project ----------------------------------------------------
  @IsUrl({ require_tld: false })
  @IsOptional()
  SUPABASE_URL?: string;

  @IsString()
  @IsOptional()
  SUPABASE_PUBLISHABLE_KEY?: string;

  @IsUrl({ require_tld: false })
  @IsOptional()
  SUPABASE_JWKS_URL?: string;

  // --- Stripe --------------------------------------------------------------
  // Used when BILLING_PROVIDER=stripe. The price ids must be *this* product's
  // — create the plans in the Stripe dashboard first; ids from another product
  // will happily charge the wrong amount for the wrong thing.
  @IsString()
  @IsOptional()
  STRIPE_SECRET_KEY?: string;

  @IsString()
  @IsOptional()
  STRIPE_WEBHOOK_SECRET?: string;

  @IsString()
  @IsOptional()
  STRIPE_STARTER_PRICE_ID?: string;

  @IsString()
  @IsOptional()
  STRIPE_PRO_PRICE_ID?: string;

  @IsString()
  @IsOptional()
  STRIPE_BUSINESS_PRICE_ID?: string;

  // --- Outgoing email ------------------------------------------------------
  // Leave SMTP_HOST empty to run without mail: the key is then issued and
  // reported in the response, and an operator delivers it by hand.
  @IsString()
  @IsOptional()
  SMTP_HOST?: string;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(65535)
  @IsOptional()
  SMTP_PORT = 587;

  /** Implicit TLS. Defaults to true on 465, the port that requires it. */
  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  SMTP_SECURE?: boolean;

  @IsString()
  @IsOptional()
  SMTP_USERNAME?: string;

  @IsString()
  @IsOptional()
  SMTP_PASSWORD?: string;

  /** Sender address, e.g. "Stoclify <billing@example.com>". */
  @IsString()
  @IsOptional()
  SMTP_FROM?: string;

  /**
   * Resend's API key, and the reason this service can send mail at all from a
   * host that blocks SMTP.
   *
   * Railway — and most of its neighbours — close outbound 25, 465 and 587 so
   * their addresses cannot be used to send spam. That closes SMTP entirely, to
   * Gmail and to Resend's own SMTP endpoint alike. Resend's REST API goes over
   * 443, which nobody blocks.
   *
   * Set it and mail goes through Resend; leave it empty and the SMTP settings
   * above are used, which is what a laptop wants.
   */
  @IsString()
  @IsOptional()
  RESEND_API_KEY?: string;

  /** Where customers sign in — put in the email beside their key. */
  @IsString()
  @IsOptional()
  APP_PUBLIC_URL = 'http://localhost:3000';

  @IsString()
  @IsOptional()
  SUPPORT_EMAIL?: string;

  // --- Scraper -------------------------------------------------------------
  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  SCRAPER_ENABLED = true;

  @IsString()
  @IsOptional()
  SCRAPER_CRON = '0 * * * *';

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  SCRAPER_BATCH_SIZE = 25;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  SCRAPER_CONCURRENCY = 5;

  @Transform(toNumber)
  @IsInt()
  @Min(100)
  @IsOptional()
  SCRAPER_TIMEOUT_MS = 5000;

  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @IsOptional()
  SCRAPER_MIN_DELAY_MS = 1000;

  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  SCRAPER_ALERT_THRESHOLD_PERCENT = 5;

  @IsEnum(ScraperDriver)
  @IsOptional()
  SCRAPER_DRIVER: ScraperDriver = ScraperDriver.Simulation;

  @IsString()
  @IsOptional()
  SCRAPER_USER_AGENT =
    'PriceIntelligenceBot/1.0 (+https://example.com/bot; compatible; contact@example.com)';

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  SCRAPER_RESPECT_ROBOTS = true;

  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @Max(10)
  @IsOptional()
  SCRAPER_MAX_RETRIES = 2;

  @Transform(toNumber)
  @IsInt()
  @Min(100)
  @IsOptional()
  SCRAPER_RETRY_BASE_DELAY_MS = 1000;

  /**
   * The key the TOTP secrets are encrypted with.
   *
   * Kept out of the database on purpose: a dump of the table is useless
   * without it, and that separation is the whole reason a second factor
   * survives a leak. Without it set, two-factor authentication cannot be
   * switched on — refusing is the honest answer, storing the secrets in plain
   * text is not.
   *
   * Generate with `openssl rand -base64 32`.
   */
  @IsString()
  @MinLength(16)
  @IsOptional()
  TOTP_ENCRYPTION_KEY?: string;

  /**
   * Where crashes are reported, if anywhere.
   *
   * Empty in development and on any deployment that has not been given one,
   * and the integration stays switched off rather than half-initialised. A
   * server whose only record of a 500 is a log line nobody is tailing is a
   * server whose customers find its bugs before it does.
   */
  @IsString()
  @IsOptional()
  SENTRY_DSN?: string;

  /**
   * Fraction of requests traced for performance, 0 to 1.
   *
   * Zero by default: traces cost money per event and the first thing anybody
   * needs from this is stack traces on errors, not flame graphs.
   */
  @Transform(toNumber)
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  SENTRY_TRACES_SAMPLE_RATE = 0;

  /**
   * The most requests one supplier's site may receive from us in a day.
   *
   * The per-host gap controls *rate*, which is what stops a burst. This
   * controls *volume*, which is what a WAF actually counts: nothing before it
   * stopped the sweep making six requests a second to one shop around the
   * clock, and half a million requests a day from one address gets blocked
   * however politely they are spaced.
   *
   * Two thousand is generous for a supplier whose catalogue anybody is
   * genuinely watching, and far below the threshold at which a site owner
   * notices us at all. Listings that do not fit wait for tomorrow rather than
   * failing — being a day late on a price is survivable, being blocked is not.
   */
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @IsOptional()
  SCRAPER_HOST_DAILY_BUDGET = 2000;

  /**
   * How long a fetched page may be reused for another customer.
   *
   * Two customers watching the same article at the same shop is one page, not
   * two. Without this the request count scales with customers rather than with
   * articles, which is the difference between a service a supplier tolerates
   * and one it blocks.
   *
   * Thirty minutes: under the default hourly check interval, so nobody's data
   * goes stale, and long enough that customers checked in different batches of
   * the same sweep still share.
   */
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @IsOptional()
  SCRAPER_SHARED_FETCH_MS = 1_800_000;

  /**
   * How long every single observation is kept.
   *
   * Inside this window the history is complete, to the check: this is what
   * "the price moved twice on Tuesday" is answered from. Outside it, one
   * reading per listing per day is enough to draw the same line.
   */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @IsOptional()
  HISTORY_FULL_DAYS = 30;

  /**
   * How long the thinned history is kept before it goes entirely.
   *
   * Just over a year by default, so a buyer can still compare this March with
   * last March — which is the comparison that catches an annual price list
   * being quietly reissued.
   */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @IsOptional()
  HISTORY_KEEP_DAYS = 400;

  // --- Alerting ------------------------------------------------------------
  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  ALERTS_ENABLED = true;

  @IsUrl({ require_tld: false })
  @IsOptional()
  ALERT_SLACK_WEBHOOK_URL?: string;

  @IsUrl({ require_tld: false })
  @IsOptional()
  ALERT_WEBHOOK_URL?: string;

  @IsString()
  @IsOptional()
  ALERT_WEBHOOK_SECRET?: string;

  @Transform(toNumber)
  @IsInt()
  @Min(1000)
  @IsOptional()
  ALERT_DELIVERY_TIMEOUT_MS = 8000;

  @Transform(toNumber)
  @IsInt()
  @Min(0)
  @IsOptional()
  ALERT_COOLDOWN_MINUTES = 60;

  /**
   * Where alerts go when the account that owns the product has no usable
   * address — seeded demo data, or an operator's own products. Without it
   * those alerts are stored and never mailed to anyone.
   */
  @IsEmail()
  @IsOptional()
  ALERT_EMAIL_FALLBACK_TO?: string;

  // --- AI product matching -------------------------------------------------
  /**
   * Without a key the matcher runs deterministically and the product still
   * works — barcodes, article numbers and specifications answer most pairs.
   * The key buys the remainder: the pairs where one supplier writes "840" and
   * the other writes "4000K".
   */
  @IsString()
  @IsOptional()
  ANTHROPIC_API_KEY?: string;

  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  AI_MATCHING_ENABLED = true;

  /**
   * Pinning a model is for reproducing a disputed match, not for normal use.
   * Left unset, the service asks the API which models exist and takes the
   * cheapest one it knows how to use — so a retired model cannot take the
   * search down with it.
   */
  @IsString()
  @IsOptional()
  AI_MATCH_MODEL?: string;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(40)
  @IsOptional()
  AI_MATCH_MAX_CANDIDATES = 12;

  @Transform(toNumber)
  @IsInt()
  @Min(1000)
  @IsOptional()
  AI_MATCH_TIMEOUT_MS = 9000;

  /**
   * Hosted checkout links, one per plan.
   *
   * Paddle and Lemon Squeezy — the platforms that act as merchant of record
   * and issue the invoice — hand you a URL per price rather than an API to
   * create a session. Set these and the pricing buttons work regardless of
   * which provider is behind them; leave them unset and the Stripe session
   * API is used instead.
   */
  @IsUrl({ require_tld: false })
  @IsOptional()
  CHECKOUT_LINK_STARTER?: string;

  @IsUrl({ require_tld: false })
  @IsOptional()
  CHECKOUT_LINK_PRO?: string;

  @IsUrl({ require_tld: false })
  @IsOptional()
  CHECKOUT_LINK_BUSINESS?: string;

  /**
   * Where somebody buys more AI comparisons when the allowance runs out.
   *
   * The search itself never stops — matching falls back to barcodes, article
   * numbers and specifications, which settle most pairs — so this is a way to
   * buy back the help with the awkward ones, not a way to unblock the product.
   */
  @IsUrl({ require_tld: false })
  @IsOptional()
  CHECKOUT_LINK_TOPUP?: string;

  /**
   * Which purchases credit comparisons, as `price_id:count` pairs.
   *
   * The webhook cannot otherwise tell a top-up from a subscription: both
   * arrive as a completed payment. Without this mapping a top-up would be
   * read as a plan change, which is the wrong thing entirely.
   */
  @IsString()
  @IsOptional()
  TOPUP_PRICE_IDS?: string;

  // --- Currency ------------------------------------------------------------
  /**
   * Rates against the euro for currencies outside the pegged BGN pair, as
   * `USD:1.08,GBP:0.85`. Unset means unconvertible, which is reported as such
   * rather than guessed — a made-up rate is a wrong comparison presented as a
   * fact.
   */
  @IsString()
  @IsOptional()
  FX_RATES_PER_EUR?: string;

  // --- Rate limiting -------------------------------------------------------
  @Transform(toNumber)
  @IsInt()
  @Min(1000)
  @IsOptional()
  THROTTLE_TTL_MS = 60000;

  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @IsOptional()
  THROTTLE_LIMIT = 120;
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  // An env var set to the empty string means "not configured" — `.env` files
  // habitually carry `ALERT_WEBHOOK_URL=` as a placeholder. Without this, an
  // empty value reaches @IsUrl and fails validation at boot.
  const withoutBlanks = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => !(typeof value === 'string' && value.trim() === '')),
  );

  const validated = plainToInstance(EnvironmentVariables, withoutBlanks, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `  - ${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return validated;
}
