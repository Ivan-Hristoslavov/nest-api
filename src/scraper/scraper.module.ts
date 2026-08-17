import { Module } from '@nestjs/common';

import { ProductsModule } from '../products/products.module';
import { PriceFetcherService } from './price-fetcher.service';
import { ScraperController } from './scraper.controller';
import { ScraperService } from './scraper.service';

@Module({
  // ProductsModule re-exports TypeOrmModule.forFeature([Product, PriceHistory]),
  // so ScraperService can inject the Product repository directly.
  imports: [ProductsModule],
  controllers: [ScraperController],
  providers: [ScraperService, PriceFetcherService],
  exports: [ScraperService],
})
export class ScraperModule {}
