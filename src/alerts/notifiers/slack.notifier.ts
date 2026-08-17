import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AlertsConfig, Configuration } from '../../config/configuration';
import { Alert } from '../entities/alert.entity';
import { AlertSeverity, AlertType } from '../enums/alert.enums';
import { AlertContext, AlertNotifier } from './notifier.interface';

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  [AlertSeverity.Info]: ':information_source:',
  [AlertSeverity.Warning]: ':warning:',
  [AlertSeverity.Critical]: ':rotating_light:',
};

const TYPE_LABEL: Record<AlertType, string> = {
  [AlertType.PriceDrop]: 'Price drop',
  [AlertType.PriceRise]: 'Price rise',
  [AlertType.Undercut]: 'Undercut',
  [AlertType.AllTimeLow]: 'All-time low',
  [AlertType.OutOfStock]: 'Out of stock',
  [AlertType.ScrapeFailing]: 'Listing failing',
};

/**
 * Posts alerts to a Slack incoming webhook using Block Kit.
 *
 * Blocks rather than plain text because the interesting part of a price alert
 * is the comparison — old vs new vs target — and a table of fields reads at a
 * glance where a sentence does not.
 */
@Injectable()
export class SlackNotifier implements AlertNotifier {
  readonly channel = 'slack';

  private readonly logger = new Logger(SlackNotifier.name);
  private readonly config: AlertsConfig;

  constructor(configService: ConfigService<Configuration, true>) {
    this.config = configService.get('alerts', { infer: true });
  }

  isConfigured(): boolean {
    return Boolean(this.config.slackWebhookUrl);
  }

  async send(alert: Alert, context: AlertContext): Promise<void> {
    if (!this.config.slackWebhookUrl) {
      throw new Error('Slack webhook URL is not configured');
    }

    const fields: Array<{ type: 'mrkdwn'; text: string }> = [];

    if (alert.oldPrice !== null) {
      fields.push({ type: 'mrkdwn', text: `*Was*\n${alert.oldPrice} ${alert.currency}` });
    }
    if (alert.newPrice !== null) {
      fields.push({ type: 'mrkdwn', text: `*Now*\n${alert.newPrice} ${alert.currency}` });
    }
    if (alert.changePercent !== null) {
      fields.push({ type: 'mrkdwn', text: `*Change*\n${alert.changePercent.toFixed(2)}%` });
    }
    if (context.targetPrice !== null) {
      fields.push({ type: 'mrkdwn', text: `*Target*\n${context.targetPrice} ${alert.currency}` });
    }
    if (context.competitorName) {
      fields.push({ type: 'mrkdwn', text: `*Competitor*\n${context.competitorName}` });
    }
    if (context.productSku) {
      fields.push({ type: 'mrkdwn', text: `*SKU*\n${context.productSku}` });
    }

    const blocks: unknown[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${SEVERITY_EMOJI[alert.severity]} ${TYPE_LABEL[alert.type]} — ${context.productName}`.slice(
            0,
            150,
          ),
          emoji: true,
        },
      },
      { type: 'section', text: { type: 'mrkdwn', text: alert.message } },
    ];

    if (fields.length > 0) {
      // Slack renders at most 10 fields per section.
      blocks.push({ type: 'section', fields: fields.slice(0, 10) });
    }

    if (context.competitorUrl) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `<${context.competitorUrl}|Open competitor listing>` }],
      });
    }

    const response = await fetch(this.config.slackWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: alert.message, blocks }),
      signal: AbortSignal.timeout(this.config.deliveryTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Slack responded ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    }

    this.logger.debug(`Alert ${alert.id} delivered to Slack.`);
  }
}
