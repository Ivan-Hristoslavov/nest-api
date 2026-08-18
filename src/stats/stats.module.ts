import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Competitor } from '../products/entities/competitor.entity';
import { PriceHistory } from '../products/entities/price-history.entity';
import { Product } from '../products/entities/product.entity';
import { Shop } from '../shops/entities/shop.entity';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  imports: [TypeOrmModule.forFeature([Shop, Product, Competitor, PriceHistory])],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
