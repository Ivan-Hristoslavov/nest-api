import { EnvironmentVariables, NodeEnvironment, validateEnv } from './env.validation';

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
  apiKeys: string[];
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
    },
    throttle: {
      ttlMs: env.THROTTLE_TTL_MS,
      limit: env.THROTTLE_LIMIT,
    },
  };
};
