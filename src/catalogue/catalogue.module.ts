import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ScraperModule } from '../scraper/scraper.module';
import { CatalogueCrawlerService } from './catalogue-crawler.service';
import { CatalogueController } from './catalogue.controller';
import { CatalogueService } from './catalogue.service';
import { Offer } from './entities/offer.entity';
import { Shop } from './entities/shop.entity';
import { SitemapService } from './sitemap.service';

@Module({
  // Reuses the scraper's fetcher, robots client and per-host rate limiter, so
  // indexing a catalogue is exactly as polite as checking one price.
  imports: [TypeOrmModule.forFeature([Shop, Offer]), ScraperModule],
  controllers: [CatalogueController],
  providers: [CatalogueService, SitemapService, CatalogueCrawlerService],
  exports: [CatalogueService],
})
export class CatalogueModule {}
