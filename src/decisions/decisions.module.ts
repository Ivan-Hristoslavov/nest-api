import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Order } from '../orders/entities/order.entity';
import { DecisionDraftService } from './decision-draft.service';
import { PurchaseDecision } from './entities/purchase-decision.entity';
import { PurchaseDecisionsController } from './purchase-decisions.controller';
import { PurchaseDecisionsService } from './purchase-decisions.service';

/**
 * Purchase decisions.
 *
 * `Order` is registered for its repository alone rather than by importing
 * OrdersModule. The dependency genuinely runs both ways — an order points at
 * the decision it came from, and a decision has to read its orders to know
 * whether the purchase happened — and importing both modules into each other
 * would need a `forwardRef` to express a relationship that is really just two
 * tables and one foreign key. A repository each, and no cycle.
 *
 * `DecisionDraftService` is exported because DiscoveryModule seals a draft into
 * every basket response. Nothing else about decisions belongs in the basket,
 * and nothing else is exported.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PurchaseDecision, Order])],
  controllers: [PurchaseDecisionsController],
  providers: [PurchaseDecisionsService, DecisionDraftService],
  exports: [PurchaseDecisionsService, DecisionDraftService],
})
export class DecisionsModule {}
