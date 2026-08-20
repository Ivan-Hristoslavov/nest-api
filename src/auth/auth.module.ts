import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingModule } from '../billing/billing.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';
import { SESSION_RESOLVER } from '../common/session-resolver';
import { AuthToken } from './entities/auth-token.entity';
import { User } from '../billing/entities/user.entity';

/**
 * Sign-in for people.
 *
 * Imports BillingModule for the account lookup and the mail transport, and is
 * imported by AppModule ahead of the global guard — which resolves both kinds
 * of credential and therefore needs this one to exist first.
 */
@Global()
@Module({
  // `User` for its repository alone — TwoFactorService reads and writes the
  // encrypted secret directly, and BillingModule already provides the rest.
  imports: [TypeOrmModule.forFeature([AuthToken, User]), BillingModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Bound to the token the guard depends on, so `common` never has to import
    // `auth`. Global because the guard is registered once, in AppModule.
    { provide: SESSION_RESOLVER, useExisting: AuthService },
    TwoFactorService,
  ],
  exports: [AuthService, SESSION_RESOLVER],
})
export class AuthModule {}
