import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DiscoveryModule } from '../discovery/discovery.module';
import { Shop } from './entities/shop.entity';
import { ShopsController } from './shops.controller';
import { ShopsService } from './shops.service';

@Module({
  // DiscoveryModule supplies the probe that works out how a new shop can be
  // searched. The dependency runs one way: shops know nothing about searching.
  imports: [TypeOrmModule.forFeature([Shop]), DiscoveryModule],
  controllers: [ShopsController],
  providers: [ShopsService],
  exports: [ShopsService],
})
export class ShopsModule {}
