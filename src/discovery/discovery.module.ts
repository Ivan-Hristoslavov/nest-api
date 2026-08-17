import { Module } from '@nestjs/common';

import { ScraperModule } from '../scraper/scraper.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryService } from './discovery.service';

@Module({
  // Reuses the scraper's parser, robots client and per-host rate limiter, so a
  // search obeys exactly the same manners as a price check.
  imports: [ScraperModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
