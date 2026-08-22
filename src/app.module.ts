import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { BillingModule } from './billing/billing.module';
import { ShopsModule } from './shops/shops.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { KeyRevocationModule } from './common/key-revocation.service';
import { Configuration, configuration } from './config/configuration';
import { buildTypeOrmOptions } from './database/typeorm-options.factory';
import { HealthModule } from './health/health.module';
import { MatchingModule } from './matching/matching.module';
import { OrdersModule } from './orders/orders.module';
import { ProductsModule } from './products/products.module';
import { ScraperModule } from './scraper/scraper.module';
import { StatsModule } from './stats/stats.module';

@Module({
  imports: [
    // Loaded first and marked global so every module can inject ConfigService.
    // `configuration()` validates process.env and throws at boot on bad input.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // `.env.local` wins over `.env`, letting a developer override shared
      // defaults without touching the committed example file.
      envFilePath: ['.env.local', '.env'],
      load: [configuration],
      expandVariables: true,
    }),

    // Async so the connection is built from validated configuration rather than
    // from raw process.env read at import time.
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Configuration, true>) =>
        buildTypeOrmOptions(configService.get('database', { infer: true })),
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<Configuration, true>) => {
        const throttle = configService.get('throttle', { infer: true });
        return { throttlers: [{ ttl: throttle.ttlMs, limit: throttle.limit }] };
      },
    }),

    // Powers the recurring competitor price sweep in ScraperModule.
    ScheduleModule.forRoot(),

    // Global, and imported before BillingModule: both the guard's cache and
    // the billing code that revokes keys resolve the same instance.
    KeyRevocationModule,

    // BillingModule first: ApiKeyGuard resolves customer keys through the
    // UsersService it exports.
    BillingModule,
    // After BillingModule (it uses the account lookup) and before the global
    // guard, which resolves sessions through the token this binds.
    AuthModule,
    ProductsModule,
    OrdersModule,
    AlertsModule,
    ScraperModule,
    DiscoveryModule,
    MatchingModule,
    ShopsModule,
    AnalyticsModule,
    StatsModule,
    HealthModule,
  ],
  providers: [
    // Guard order matters: rate limiting runs first so an attacker brute-forcing
    // API keys is throttled before the (more expensive) key comparison.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Access logging lives in middleware (see main.ts), not an interceptor:
    // interceptors run after guards and would miss every 401 and 429.
  ],
})
export class AppModule {}
