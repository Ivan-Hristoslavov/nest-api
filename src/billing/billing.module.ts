import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingEvent } from './entities/billing-event.entity';
import { User } from './entities/user.entity';
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
  imports: [TypeOrmModule.forFeature([User, BillingEvent])],
  controllers: [BillingController],
  providers: [BillingService, UsersService, WebhookSignatureService],
  exports: [UsersService, BillingService],
})
export class BillingModule {}
