import { parseRates } from '../products/currency';
import { parseTopUpPacks } from '../billing/top-up-packs';
import {
  BillingProvider,
  EnvironmentVariables,
  NodeEnvironment,
  ScraperDriver,
  validateEnv,
} from './env.validation';

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  port: number;
  apiPrefix: string;
  swaggerPath: string;
  swaggerEnabled: boolean;
  corsOrigins: string[] | true;
  logLevel: string;
  /**
   * The origin this site is reached at, without a trailing slash.
   *
   * Every absolute URL a crawler is given — the canonical link, the language
   * alternates, the sitemap, the structured data — is built from this. Left at
   * localhost it is still correct, just useless, which is the right failure:
   * a guessed production domain would put a wrong canonical on every page.
   */
  publicUrl: string;
}

export interface AuthConfig {
  apiKeyHeader: string;
  /** Encrypts stored TOTP secrets. Absent means two-factor cannot be enabled. */
  totpEncryptionKey?: string;
  /** Operator keys from the environment; customer keys live in the database. */
  apiKeys: string[];
  keyCacheTtlMs: number;
}

export interface BillingConfig {
  provider: BillingProvider;
  /** Secret for the active provider. */
  webhookSecret?: string;
  signatureToleranceSeconds: number;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  schema: string;
  ssl: boolean;
  sslRejectUnauthorized: boolean;
  poolSize: number;
  poolMinSize: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  synchronize: boolean;
  logging: boolean;
}

export interface SupabaseConfig {
  url?: string;
  publishableKey?: string;
  jwksUrl?: string;
}

export interface ShopHealthConfig {
  enabled: boolean;
  cron: string;
}

export interface ScraperConfig {
  enabled: boolean;
  cron: string;
  batchSize: number;
  concurrency: number;
  timeoutMs: number;
  minDelayMs: number;
  /** Per-supplier ceiling for one search. See SEARCH_SUPPLIER_TIMEOUT_MS. */
  supplierTimeoutMs: number;
  alertThresholdPercent: number;
  driver: ScraperDriver;
  userAgent: string;
  respectRobots: boolean;
  maxRetries: number;
  retryBaseDelayMs: number;
  /** Hard ceiling on requests to one supplier per day. 0 disables it. */
  hostDailyBudget: number;
  /** How long a fetched page is reused across customers. 0 disables sharing. */
  sharedFetchMs: number;
}

export interface AlertsConfig {
  enabled: boolean;
  slackWebhookUrl?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  emailFallbackTo?: string;
  deliveryTimeoutMs: number;
  cooldownMinutes: number;
}

/**
 * Outgoing email.
 *
 * Not a nicety. A customer who pays and receives nothing has bought nothing:
 * the API key is issued as a hash and the plaintext exists for one moment
 * inside one request. Without a way to send it, every sale needs an operator
 * to notice and hand a key over by chat.
 */
/** Stripe Checkout, when Stripe is the merchant of record. */
export interface CheckoutConfig {
  /** Hosted payment page per plan, from whichever provider issues invoices. */
  links: Partial<Record<'starter' | 'pro' | 'business', string>>;
  /** Where to buy more AI comparisons, when that is offered at all. */
  topUpLink?: string;
  /** Provider price id → comparisons credited by that purchase. */
  topUpPacks: Record<string, number>;
}

export interface StripeConfig {
  secretKey?: string;
  webhookSecret?: string;
  /** Price id per plan. A plan with no price cannot be bought. */
  prices: Partial<Record<'starter' | 'pro' | 'business', string>>;
}

export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Implicit TLS (port 465). Otherwise STARTTLS is negotiated. */
  secure: boolean;
  username?: string;
  password?: string;
  from: string;
  /** Set to send over Resend's HTTPS API instead of SMTP. */
  resendApiKey?: string;
  /** Where the customer is told to go and paste their key. */
  appUrl: string;
  supportEmail?: string;
  /** Where operational findings go — a supplier's search that stopped working. */
  operatorEmail?: string;
}

export interface MatchingConfig {
  enabled: boolean;
  apiKey?: string;
  /** Empty unless an operator pinned one; otherwise discovered at runtime. */
  model?: string;
  maxCandidates: number;
  timeoutMs: number;
}

/**
 * Finding the shops nobody configured.
 *
 * "Everywhere" cannot mean a longer hardcoded list — a buyer asking for a
 * polishing machine should not have to know which storefronts this system was
 * taught. The model runs the searches; the addresses it returns are fetched
 * and judged here, exactly like a configured supplier's rows.
 */
export interface WebDiscoveryConfig {
  enabled: boolean;
  apiKey?: string;
  model: string;
  maxSearches: number;
  maxPages: number;
  timeoutMs: number;
}

/**
 * How long observed prices are kept, and at what resolution.
 *
 * `price_history` is append-only and never stops growing: two thousand watched
 * articles checked hourly is around seventeen million rows a year, per
 * customer. The trend charts do not need that — they need every reading while
 * it is recent and one a day after that.
 */
/**
 * Crash reporting.
 *
 * Off unless a DSN is supplied, and deliberately so: a half-initialised
 * reporter that swallows errors on its way to nowhere is worse than none.
 */
export interface ObservabilityConfig {
  sentryDsn?: string;
  tracesSampleRate: number;
  environment: string;
}

export interface HistoryConfig {
  fullDays: number;
  keepDays: number;
}

export interface CurrencyConfig {
  /** Units per one euro, e.g. `{ USD: 1.08 }`. Empty means "do not convert". */
  ratesPerEur: Record<string, number>;
}

export interface ThrottleConfig {
  ttlMs: number;
  limit: number;
}

export interface Configuration {
  app: AppConfig;
  checkout: CheckoutConfig;
  matching: MatchingConfig;
  webDiscovery: WebDiscoveryConfig;
  currency: CurrencyConfig;
  history: HistoryConfig;
  observability: ObservabilityConfig;
  auth: AuthConfig;
  database: DatabaseConfig;
  supabase: SupabaseConfig;
  scraper: ScraperConfig;
  shopHealth: ShopHealthConfig;
  billing: BillingConfig;
  stripe: StripeConfig;
  mail: MailConfig;
  alerts: AlertsConfig;
  throttle: ThrottleConfig;
}

/**
 * Splits `API_KEY` + `API_KEYS` into a de-duplicated list, so a key can be
 * rotated without downtime: publish the new key, let clients migrate, drop
 * the old one from API_KEYS.
 */
function collectApiKeys(env: EnvironmentVariables): string[] {
  const keys = [env.API_KEY, ...(env.API_KEYS?.split(',') ?? [])]
    .map((key) => key?.trim())
    .filter((key): key is string => Boolean(key));

  return [...new Set(keys)];
}

function parseCorsOrigins(value: string, nodeEnv: NodeEnvironment): string[] | true {
  const trimmed = value.trim();

  if (trimmed === '*' || trimmed === '') {
    // A wildcard is right for a laptop and wrong for a live deployment: it
    // invites any page on the internet to drive this API from a visitor's
    // browser. Refused at boot rather than warned about, because a warning in
    // a startup log is a warning nobody reads.
    if (nodeEnv === NodeEnvironment.Production) {
      throw new Error(
        'CORS_ORIGINS may not be "*" in production. List the origins that are allowed to call ' +
          'this API from a browser, e.g. CORS_ORIGINS=https://stoclify.bg,https://www.stoclify.bg',
      );
    }
    return true;
  }

  return trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Single source of truth for runtime configuration. Registered on
 * `ConfigModule.forRoot({ load: [configuration] })` and consumed through
 * `ConfigService<Configuration, true>` for type-safe lookups.
 */
export const configuration = (): Configuration => {
  const env = validateEnv(process.env);

  return {
    app: {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      apiPrefix: env.API_PREFIX.replace(/^\/+|\/+$/g, ''),
      swaggerPath: env.SWAGGER_PATH.replace(/^\/+|\/+$/g, ''),
      swaggerEnabled: env.SWAGGER_ENABLED,
      corsOrigins: parseCorsOrigins(env.CORS_ORIGINS, env.NODE_ENV),
      logLevel: env.LOG_LEVEL,
      publicUrl: env.APP_PUBLIC_URL.replace(/\/+$/, ''),
    },
    observability: {
      sentryDsn: env.SENTRY_DSN?.trim() || undefined,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
      environment: env.NODE_ENV,
    },
    history: {
      fullDays: env.HISTORY_FULL_DAYS,
      keepDays: Math.max(env.HISTORY_KEEP_DAYS, env.HISTORY_FULL_DAYS),
    },
    auth: {
      apiKeyHeader: env.API_KEY_HEADER.toLowerCase(),
      totpEncryptionKey: env.TOTP_ENCRYPTION_KEY?.trim() || undefined,
      apiKeys: collectApiKeys(env),
      keyCacheTtlMs: env.API_KEY_CACHE_TTL_MS,
    },
    billing: {
      provider: env.BILLING_PROVIDER,
      webhookSecret:
        env.BILLING_PROVIDER === BillingProvider.Paddle
          ? env.PADDLE_WEBHOOK_SECRET
          : env.BILLING_PROVIDER === BillingProvider.Stripe
            ? env.STRIPE_WEBHOOK_SECRET
            : env.LEMONSQUEEZY_WEBHOOK_SECRET,
      signatureToleranceSeconds: env.BILLING_SIGNATURE_TOLERANCE_SECONDS,
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      prices: {
        starter: env.STRIPE_STARTER_PRICE_ID,
        pro: env.STRIPE_PRO_PRICE_ID,
        business: env.STRIPE_BUSINESS_PRICE_ID,
      },
    },
    mail: {
      // Enabled by having somewhere to send from. A half-configured mailer
      // that throws on every send is worse than one that is plainly off.
      // A sender address plus somewhere to send from: either Resend, or SMTP.
      enabled: Boolean(env.SMTP_FROM && (env.RESEND_API_KEY || env.SMTP_HOST)),
      host: env.SMTP_HOST ?? '',
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
      username: env.SMTP_USERNAME,
      password: env.SMTP_PASSWORD,
      from: env.SMTP_FROM ?? '',
      resendApiKey: env.RESEND_API_KEY,
      appUrl: env.APP_PUBLIC_URL,
      supportEmail: env.SUPPORT_EMAIL,
      operatorEmail: env.OPERATOR_EMAIL ?? env.SUPPORT_EMAIL,
    },
    database: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      username: env.DB_USERNAME,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      schema: env.DB_SCHEMA,
      ssl: env.DB_SSL,
      sslRejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED,
      poolSize: env.DB_POOL_SIZE,
      poolMinSize: Math.min(env.DB_POOL_MIN_SIZE, env.DB_POOL_SIZE),
      connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
      synchronize: env.DB_SYNCHRONIZE,
      logging: env.DB_LOGGING,
    },
    supabase: {
      url: env.SUPABASE_URL,
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
      jwksUrl: env.SUPABASE_JWKS_URL,
    },
    scraper: {
      enabled: env.SCRAPER_ENABLED,
      cron: env.SCRAPER_CRON,
      batchSize: env.SCRAPER_BATCH_SIZE,
      concurrency: env.SCRAPER_CONCURRENCY,
      timeoutMs: env.SCRAPER_TIMEOUT_MS,
      minDelayMs: env.SCRAPER_MIN_DELAY_MS,
      supplierTimeoutMs: env.SEARCH_SUPPLIER_TIMEOUT_MS,
      alertThresholdPercent: env.SCRAPER_ALERT_THRESHOLD_PERCENT,
      driver: env.SCRAPER_DRIVER,
      userAgent: env.SCRAPER_USER_AGENT,
      respectRobots: env.SCRAPER_RESPECT_ROBOTS,
      maxRetries: env.SCRAPER_MAX_RETRIES,
      retryBaseDelayMs: env.SCRAPER_RETRY_BASE_DELAY_MS,
      hostDailyBudget: env.SCRAPER_HOST_DAILY_BUDGET,
      sharedFetchMs: env.SCRAPER_SHARED_FETCH_MS,
    },
    shopHealth: {
      enabled: env.SHOP_HEALTH_ENABLED,
      cron: env.SHOP_HEALTH_CRON,
    },
    alerts: {
      enabled: env.ALERTS_ENABLED,
      slackWebhookUrl: env.ALERT_SLACK_WEBHOOK_URL,
      webhookUrl: env.ALERT_WEBHOOK_URL,
      webhookSecret: env.ALERT_WEBHOOK_SECRET,
      emailFallbackTo: env.ALERT_EMAIL_FALLBACK_TO,
      deliveryTimeoutMs: env.ALERT_DELIVERY_TIMEOUT_MS,
      cooldownMinutes: env.ALERT_COOLDOWN_MINUTES,
    },
    checkout: {
      links: {
        starter: env.CHECKOUT_LINK_STARTER,
        pro: env.CHECKOUT_LINK_PRO,
        business: env.CHECKOUT_LINK_BUSINESS,
      },
      topUpLink: env.CHECKOUT_LINK_TOPUP,
      topUpPacks: parseTopUpPacks(env.TOPUP_PRICE_IDS),
    },
    matching: {
      // Enabled *and* keyed. A deployment with the flag on and no key would
      // otherwise report AI matching as available and then never do any.
      enabled: env.AI_MATCHING_ENABLED && Boolean(env.ANTHROPIC_API_KEY),
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.AI_MATCH_MODEL,
      maxCandidates: env.AI_MATCH_MAX_CANDIDATES,
      timeoutMs: env.AI_MATCH_TIMEOUT_MS,
    },
    webDiscovery: {
      // Keyed as well as enabled, for the same reason matching is: a flag on
      // with no key reports a capability that can never run.
      enabled: env.WEB_DISCOVERY_ENABLED && Boolean(env.ANTHROPIC_API_KEY),
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.WEB_DISCOVERY_MODEL,
      maxSearches: env.WEB_DISCOVERY_MAX_SEARCHES,
      maxPages: env.WEB_DISCOVERY_MAX_PAGES,
      timeoutMs: env.WEB_DISCOVERY_TIMEOUT_MS,
    },
    currency: {
      ratesPerEur: parseRates(env.FX_RATES_PER_EUR),
    },
    throttle: {
      ttlMs: env.THROTTLE_TTL_MS,
      limit: env.THROTTLE_LIMIT,
    },
  };
};
