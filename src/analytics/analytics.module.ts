import { Module } from '@nestjs/common';

import { ProductsModule } from '../products/products.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  // ProductsModule re-exports TypeOrmModule.forFeature([Product, PriceHistory,
  // Competitor]), so the analytics queries reuse the same repositories.
  imports: [ProductsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
