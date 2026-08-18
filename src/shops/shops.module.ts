import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DiscoveryModule } from '../discovery/discovery.module';
import { ManualPrice } from './entities/manual-price.entity';
import { Shop } from './entities/shop.entity';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';

@Module({
  // DiscoveryModule supplies the probe that works out how a new shop can be
  // searched, and ManualPricesService, which is declared there to keep the
  // dependency running one way.
  imports: [TypeOrmModule.forFeature([Shop, ManualPrice]), DiscoveryModule],
  controllers: [ShopsController],
  providers: [ShopsService],
  exports: [ShopsService],
})
export class ShopsModule {}
