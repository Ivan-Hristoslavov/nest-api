import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Product } from '../products/entities/product.entity';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { CheckoutService } from './checkout.service';
import { BillingEvent } from './entities/billing-event.entity';
import { User } from './entities/user.entity';
import { MailService } from './mail.service';
import { TrialService } from './trial.service';
import { UsersService } from './users.service';
import { WebhookSignatureService } from './webhook-signature.service';

/**
 * Payments, accounts and API keys.
 *
 * `UsersService` is exported because `ApiKeyGuard` — registered globally in
 * `AppModule` — resolves customer keys through it. `BillingModule` is therefore
 * imported by `AppModule` before the guard is declared.
 */
@Module({
  // `Product` is registered for its repository alone, not by importing
  // ProductsModule — that module already depends on this one for UsersService,
  // and importing it back would close the circle.
  imports: [TypeOrmModule.forFeature([User, BillingEvent, Product])],
  controllers: [BillingController],
  providers: [
    BillingService,
    UsersService,
    WebhookSignatureService,
    MailService,
    CheckoutService,
    TrialService,
  ],
  exports: [UsersService, BillingService, MailService, TrialService],
})
export class BillingModule {}
