import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingModule } from '../billing/billing.module';
import { DecisionsModule } from '../decisions/decisions.module';
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
 *
 * DecisionsModule comes in so an order can name the decision it carries out,
 * and so confirming one recomputes that decision's realized saving. The
 * dependency runs one way: decisions read orders through a repository rather
 * than through this module, so there is no cycle and no `forwardRef`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Order, OrderLine, Shop]), BillingModule, DecisionsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
