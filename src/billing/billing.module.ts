import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { BillingEvent } from './entities/billing-event.entity';
import { User } from './entities/user.entity';
import { MailService } from './mail.service';
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
  providers: [BillingService, UsersService, WebhookSignatureService, MailService],
  exports: [UsersService, BillingService, MailService],
})
export class BillingModule {}
