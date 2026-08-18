import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { ManualPrice } from '../shops/entities/manual-price.entity';
import { Shop } from '../shops/entities/shop.entity';
import { ManualPricesService } from '../shops/manual-prices.service';
import { SearchCache } from './entities/search-cache.entity';
import { ScraperModule } from '../scraper/scraper.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';
import { SearchDetectorService } from './search-detector.service';
import { ShopProbeService } from './shop-probe.service';
import { SitemapLookupService } from './sitemap-lookup.service';

@Module({
  // Reuses the scraper's parser, robots client and per-host rate limiter, so a
  // search obeys exactly the same manners as a price check.
  //
  // ManualPricesService is declared here rather than in ShopsModule, though it
  // is a shops concept: the search needs it, ShopsModule already imports this
  // module for the probe, and registering it there would close the loop into a
  // circular dependency. One owner, no forwardRef.
  imports: [ScraperModule, TypeOrmModule.forFeature([Shop, ManualPrice, SearchCache])],
  controllers: [DiscoveryController],
  providers: [
    DiscoveryService,
    SearchDetectorService,
    SitemapLookupService,
    ShopProbeService,
    ManualPricesService,
  ],
  exports: [
    DiscoveryService,
    SearchDetectorService,
    SitemapLookupService,
    ShopProbeService,
    ManualPricesService,
  ],
})
export class DiscoveryModule {}
