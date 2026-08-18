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
}

export interface AuthConfig {
  apiKeyHeader: string;
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

export interface ScraperConfig {
  enabled: boolean;
  cron: string;
  batchSize: number;
  concurrency: number;
  timeoutMs: number;
  minDelayMs: number;
  alertThresholdPercent: number;
  driver: ScraperDriver;
  userAgent: string;
  respectRobots: boolean;
  maxRetries: number;
  retryBaseDelayMs: number;
}

export interface AlertsConfig {
  enabled: boolean;
  slackWebhookUrl?: string;
  webhookUrl?: string;
  webhookSecret?: string;
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
  /** Where the customer is told to go and paste their key. */
  appUrl: string;
  supportEmail?: string;
}

export interface ThrottleConfig {
  ttlMs: number;
  limit: number;
}

export interface Configuration {
  app: AppConfig;
  auth: AuthConfig;
  database: DatabaseConfig;
  supabase: SupabaseConfig;
  scraper: ScraperConfig;
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

function parseCorsOrigins(value: string): string[] | true {
  const trimmed = value.trim();
  if (trimmed === '*' || trimmed === '') return true;
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
      corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
      logLevel: env.LOG_LEVEL,
    },
    auth: {
      apiKeyHeader: env.API_KEY_HEADER.toLowerCase(),
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
      enabled: Boolean(env.SMTP_HOST && env.SMTP_FROM),
      host: env.SMTP_HOST ?? '',
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
      username: env.SMTP_USERNAME,
      password: env.SMTP_PASSWORD,
      from: env.SMTP_FROM ?? '',
      appUrl: env.APP_PUBLIC_URL,
      supportEmail: env.SUPPORT_EMAIL,
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
      alertThresholdPercent: env.SCRAPER_ALERT_THRESHOLD_PERCENT,
      driver: env.SCRAPER_DRIVER,
      userAgent: env.SCRAPER_USER_AGENT,
      respectRobots: env.SCRAPER_RESPECT_ROBOTS,
      maxRetries: env.SCRAPER_MAX_RETRIES,
      retryBaseDelayMs: env.SCRAPER_RETRY_BASE_DELAY_MS,
    },
    alerts: {
      enabled: env.ALERTS_ENABLED,
      slackWebhookUrl: env.ALERT_SLACK_WEBHOOK_URL,
      webhookUrl: env.ALERT_WEBHOOK_URL,
      webhookSecret: env.ALERT_WEBHOOK_SECRET,
      deliveryTimeoutMs: env.ALERT_DELIVERY_TIMEOUT_MS,
      cooldownMinutes: env.ALERT_COOLDOWN_MINUTES,
    },
    throttle: {
      ttlMs: env.THROTTLE_TTL_MS,
      limit: env.THROTTLE_LIMIT,
    },
  };
};
