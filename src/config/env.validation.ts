import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';

/** Merchant of record handling payments. */
export enum BillingProvider {
  Paddle = 'paddle',
  LemonSqueezy = 'lemonsqueezy',
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

  // --- Catalogue crawler ---------------------------------------------------
  // Indexing a supplier's whole catalogue is thousands of pages, and requests
  // to one host are serialised on purpose — so it is hours of work that nobody
  // should have to sit through pressing a button. It runs in the background.
  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  CATALOGUE_CRAWL_ENABLED = true;

  @IsString()
  @IsOptional()
  CATALOGUE_CRAWL_CRON = '*/5 * * * *';

  /** Pages per run. At ~2.5 s a page, 100 fills roughly four of the five minutes. */
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  CATALOGUE_CRAWL_BATCH = 100;

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
  SCRAPER_MIN_DELAY_MS = 150;

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
