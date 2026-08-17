import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertsModule } from '../alerts/alerts.module';
import { CompetitorsController } from './competitors.controller';
import { CompetitorsService } from './competitors.service';
import { Competitor } from './entities/competitor.entity';
import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product, PriceHistory, Competitor]), AlertsModule],
  controllers: [ProductsController, CompetitorsController],
  providers: [ProductsService, CompetitorsService],
  // ScraperModule and AnalyticsModule drive price updates through these.
  exports: [ProductsService, CompetitorsService, TypeOrmModule],
})
export class ProductsModule {}
