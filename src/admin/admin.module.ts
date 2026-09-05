import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Alert } from '../alerts/entities/alert.entity';
import { PurchaseDecision } from '../decisions/entities/purchase-decision.entity';
import { Order } from '../orders/entities/order.entity';
import { BillingEvent } from '../billing/entities/billing-event.entity';
import { User } from '../billing/entities/user.entity';
import { Competitor } from '../products/entities/competitor.entity';
import { Product } from '../products/entities/product.entity';
import { Shop } from '../shops/entities/shop.entity';
import { BillingModule } from '../billing/billing.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ApiOutreach } from './entities/api-outreach.entity';
import { DiscoveryModule } from '../discovery/discovery.module';
import { ScraperModule } from '../scraper/scraper.module';
import { OperationsService } from './operations.service';
import { OutreachService } from './outreach.service';
import { DecisionsAdminService } from './decisions-admin.service';
import { SearchCache } from '../discovery/entities/search-cache.entity';
import { ShopHealthService } from './shop-health.service';

@Module({
  imports: [
    // `PurchaseDecision` and `Order` are registered for their repositories
    // alone. The operator's questions cross every account, so they cannot go
    // through the tenant-scoped services that own those tables — and the point
    // of those services is that they have no method which could answer an
    // unscoped question in the first place.
    TypeOrmModule.forFeature([
      User,
      BillingEvent,
      Product,
      Competitor,
      Shop,
      Alert,
      ApiOutreach,
      PurchaseDecision,
      Order,
      // For the search health check: a query a shop has answered before is a
      // better probe than a guess.
      SearchCache,
    ]),
    // For MailService, which already knows how to reach the mail server and
    // how to wrap a letter in the layout every other email uses.
    BillingModule,
    // For ScraperService: the sweep's state and the button that starts one.
    ScraperModule,
    // For the search debugger and the search-quality counters. One way: the
    // search knows nothing about the operator screen, which is what lets it
    // run unchanged when nobody is watching.
    DiscoveryModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    OutreachService,
    OperationsService,
    DecisionsAdminService,
    ShopHealthService,
  ],
})
export class AdminModule {}
