import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { Alert } from '../alerts/entities/alert.entity';
import { BillingEvent } from '../billing/entities/billing-event.entity';
import { User } from '../billing/entities/user.entity';
import { SearchCache } from '../discovery/entities/search-cache.entity';
import { AuthToken } from '../auth/entities/auth-token.entity';
import { MatchCache } from '../matching/entities/match-cache.entity';
import { ManualPrice } from '../shops/entities/manual-price.entity';
import { Order } from '../orders/entities/order.entity';
import { OrderLine } from '../orders/entities/order-line.entity';
import { Shop } from '../shops/entities/shop.entity';
import { DatabaseConfig } from '../config/configuration';
import { Competitor } from '../products/entities/competitor.entity';
import { PriceHistory } from '../products/entities/price-history.entity';
import { Product } from '../products/entities/product.entity';

/**
 * Builds the TypeORM connection options for a Supabase PostgreSQL instance.
 *
 * Shared by `AppModule` (runtime) and `data-source.ts` (TypeORM CLI) so the two
 * can never drift apart.
 *
 * Supabase specifics:
 * - TLS is mandatory. Supabase's pooler presents a certificate signed by its own
 *   CA, so `rejectUnauthorized` defaults to false. For strict verification,
 *   download the project CA certificate and pass it as `ssl.ca` instead.
 * - Port 6543 is the transaction pooler: connections are handed back after each
 *   transaction and prepared statements are unavailable. Port 5432 is the
 *   session pooler and behaves like a regular Postgres connection — required if
 *   you rely on `synchronize` or run migrations.
 */
export function buildTypeOrmOptions(config: DatabaseConfig): TypeOrmModuleOptions {
  const isTransactionPooler = config.port === 6543;

  return {
    type: 'postgres',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    schema: config.schema,
    // Entities are listed explicitly rather than glob-scanned: globs break
    // once the app is bundled or run from `dist`.
    entities: [
      Product,
      Competitor,
      PriceHistory,
      Alert,
      User,
      BillingEvent,
      Shop,
      ManualPrice,
      SearchCache,
      MatchCache,
      AuthToken,
      // Listed here, not just in `OrdersModule`'s `forFeature`.
      //
      // `forFeature` records an entity for `autoLoadEntities`, which is off —
      // so the repository was injectable, the routes mapped at boot and every
      // call to one of them threw `EntityMetadataNotFoundError` on its first
      // query. This list is also the CLI's whole view of the schema: an entity
      // missing from it is a table `migration:generate` believes nobody wants,
      // and proposes dropping.
      Order,
      OrderLine,
    ],
    migrations: [`${__dirname}/migrations/*.{ts,js}`],
    migrationsTableName: 'typeorm_migrations',
    synchronize: config.synchronize,
    logging: config.logging ? ['query', 'error', 'warn', 'migration'] : ['error', 'warn'],
    ssl: config.ssl ? { rejectUnauthorized: config.sslRejectUnauthorized } : false,
    // Retry the initial connection: Supabase projects resuming from idle can
    // refuse the first few attempts.
    retryAttempts: 5,
    retryDelay: 3000,
    autoLoadEntities: false,
    extra: {
      max: config.poolSize,
      // Keep a couple of connections warm. Opening a new one costs a full TLS
      // handshake to the Supabase region (~350ms from outside it), which is
      // what makes the *first* request after a pause feel slow.
      min: config.poolMinSize,
      connectionTimeoutMillis: config.connectTimeoutMs,
      // How long an unused connection may sit in the pool before it is closed.
      // Short values turn every pause in traffic into a reconnect; the default
      // here (10 min) keeps the pool warm across normal idle gaps.
      idleTimeoutMillis: config.idleTimeoutMs,
      // TCP keepalive stops NAT/load balancers from silently dropping an idle
      // socket, which would surface as a hung query rather than a clean retry.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      application_name: 'nest-api-price-intelligence',
      // PgBouncer in transaction mode hands the connection back after every
      // transaction, so a large client-side pool buys nothing and a stuck
      // statement must not hold a slot forever.
      ...(isTransactionPooler
        ? { statement_timeout: 30_000, max: Math.min(config.poolSize, 5) }
        : {}),
    },
  };
}
