import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';
import { ALERT_NOTIFIERS } from './notifiers/notifier.interface';
import { SlackNotifier } from './notifiers/slack.notifier';
import { WebhookNotifier } from './notifiers/webhook.notifier';

@Module({
  imports: [TypeOrmModule.forFeature([Alert])],
  controllers: [AlertsController],
  providers: [
    AlertsService,
    SlackNotifier,
    WebhookNotifier,
    {
      // Collected into one list so AlertsService iterates channels without
      // knowing which exist; adding a channel means adding it here only.
      provide: ALERT_NOTIFIERS,
      useFactory: (slack: SlackNotifier, webhook: WebhookNotifier) => [slack, webhook],
      inject: [SlackNotifier, WebhookNotifier],
    },
  ],
  exports: [AlertsService],
})
export class AlertsModule {}
