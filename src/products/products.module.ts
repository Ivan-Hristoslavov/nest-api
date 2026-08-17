import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [TypeOrmModule.forFeature([Product, PriceHistory])],
  controllers: [ProductsController],
  providers: [ProductsService],
  // ScraperModule drives price updates through this service.
  exports: [ProductsService, TypeOrmModule],
})
export class ProductsModule {}
