import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingModule } from '../billing/billing.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SESSION_RESOLVER } from '../common/session-resolver';
import { AuthToken } from './entities/auth-token.entity';

/**
 * Sign-in for people.
 *
 * Imports BillingModule for the account lookup and the mail transport, and is
 * imported by AppModule ahead of the global guard — which resolves both kinds
 * of credential and therefore needs this one to exist first.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuthToken]), BillingModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Bound to the token the guard depends on, so `common` never has to import
    // `auth`. Global because the guard is registered once, in AppModule.
    { provide: SESSION_RESOLVER, useExisting: AuthService },
  ],
  exports: [AuthService, SESSION_RESOLVER],
})
export class AuthModule {}
