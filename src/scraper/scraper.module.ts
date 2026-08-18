import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Configuration } from '../config/configuration';
import { ScraperDriver } from '../config/env.validation';
import { ProductsModule } from '../products/products.module';
import { HttpPriceFetcherService } from './fetchers/http-price-fetcher.service';
import { PRICE_SOURCE } from './fetchers/price-source.interface';
import { SimulatedPriceFetcherService } from './fetchers/simulated-price-fetcher.service';
import { HostRateLimiterService } from './http/host-rate-limiter.service';
import { RobotsService } from './http/robots.service';
import { PriceParserService } from './parsers/price-parser.service';
import { ScraperController } from './scraper.controller';
import { ScraperService } from './scraper.service';

@Module({
  // ProductsModule re-exports TypeOrmModule.forFeature([...]) and
  // CompetitorsService, so the scraper can read listings and write observations.
  imports: [ProductsModule],
  controllers: [ScraperController],
  providers: [
    ScraperService,
    PriceParserService,
    RobotsService,
    HostRateLimiterService,
    HttpPriceFetcherService,
    SimulatedPriceFetcherService,
    {
      // `SCRAPER_DRIVER` decides which implementation the scraper talks to.
      // Both are instantiated; only the selected one is injected, so switching
      // driver is an env var and a restart, never a code change.
      provide: PRICE_SOURCE,
      useFactory: (
        configService: ConfigService<Configuration, true>,
        http: HttpPriceFetcherService,
        simulated: SimulatedPriceFetcherService,
      ) =>
        configService.get('scraper', { infer: true }).driver === ScraperDriver.Http
          ? http
          : simulated,
      inject: [ConfigService, HttpPriceFetcherService, SimulatedPriceFetcherService],
    },
  ],
  // The parser, robots client, rate limiter and the selected fetcher are reused
  // by DiscoveryModule, so a live search obeys exactly the same manners as a
  // tracked-price check: robots.txt, one host at a time, the same delay.
  exports: [
    ScraperService,
    PriceParserService,
    RobotsService,
    HostRateLimiterService,
    PRICE_SOURCE,
  ],
})
export class ScraperModule {}
