import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { Shop } from '../shops/entities/shop.entity';
import { ScraperModule } from '../scraper/scraper.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';
import { SearchDetectorService } from './search-detector.service';
import { ShopProbeService } from './shop-probe.service';
import { SitemapLookupService } from './sitemap-lookup.service';

@Module({
  // Reuses the scraper's parser, robots client and per-host rate limiter, so a
  // search obeys exactly the same manners as a price check.
  imports: [ScraperModule, TypeOrmModule.forFeature([Shop])],
  controllers: [DiscoveryController],
  providers: [DiscoveryService, SearchDetectorService, SitemapLookupService, ShopProbeService],
  exports: [DiscoveryService, SearchDetectorService, SitemapLookupService, ShopProbeService],
})
export class DiscoveryModule {}
