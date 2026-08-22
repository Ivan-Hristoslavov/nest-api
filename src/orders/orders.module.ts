import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingModule } from '../billing/billing.module';
import { Shop } from '../shops/entities/shop.entity';
import { OrderLine } from './entities/order-line.entity';
import { Order } from './entities/order.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * Ordering.
 *
 * `Shop` is registered for its repository alone rather than by importing
 * ShopsModule: all this needs is to look one up and copy its name and address
 * onto the order, and importing the module would drag its controller and its
 * probing along with it.
 *
 * BillingModule comes in for `MailService` — the one transport in the system.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderLine, Shop]), BillingModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
