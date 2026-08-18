import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BillingModule } from '../billing/billing.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';
import { EmailNotifier } from './notifiers/email.notifier';
import { ALERT_NOTIFIERS } from './notifiers/notifier.interface';
import { SlackNotifier } from './notifiers/slack.notifier';
import { WebhookNotifier } from './notifiers/webhook.notifier';

@Module({
  // BillingModule for the SMTP transport and the account lookup behind the
  // email channel. It imports nothing from here, so the graph stays acyclic.
  imports: [TypeOrmModule.forFeature([Alert]), BillingModule],
  controllers: [AlertsController],
  providers: [
    AlertsService,
    SlackNotifier,
    WebhookNotifier,
    EmailNotifier,
    {
      // Collected into one list so AlertsService iterates channels without
      // knowing which exist; adding a channel means adding it here only.
      provide: ALERT_NOTIFIERS,
      useFactory: (slack: SlackNotifier, webhook: WebhookNotifier, email: EmailNotifier) => [
        slack,
        webhook,
        email,
      ],
      inject: [SlackNotifier, WebhookNotifier, EmailNotifier],
    },
  ],
  exports: [AlertsService],
})
export class AlertsModule {}
