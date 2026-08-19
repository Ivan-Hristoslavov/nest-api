import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MailService } from '../../billing/mail.service';
import { UsersService } from '../../billing/users.service';
import { AlertsConfig, Configuration } from '../../config/configuration';
import { Alert } from '../entities/alert.entity';
import { AlertSeverity, AlertType } from '../enums/alert.enums';
import { dataRows, escapeHtml, paragraph, renderEmail } from '../../billing/email-layout';
import { AlertContext, AlertNotifier } from './notifier.interface';

const TYPE_LABEL: Record<AlertType, string> = {
  [AlertType.PriceDrop]: 'Поевтиняване',
  [AlertType.PriceRise]: 'Поскъпване',
  [AlertType.Undercut]: 'Под вашата целева цена',
  [AlertType.AllTimeLow]: 'Най-ниска цена досега',
  [AlertType.OutOfStock]: 'Изчерпан',
  [AlertType.ScrapeFailing]: 'Проверката спря да работи',
};

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  [AlertSeverity.Info]: '#0ea5e9',
  [AlertSeverity.Warning]: '#f59e0b',
  [AlertSeverity.Critical]: '#ef4444',
};

/**
 * Sends an alert to the customer's own inbox.
 *
 * Slack and the webhook are one endpoint for the whole deployment — fine for
 * an operator, useless for a customer who has not run a Slack workspace in
 * their life. Email is the channel a buyer already has, which is why the
 * pricing page may name it.
 *
 * The recipient is the account that owns the product, resolved per alert.
 * Getting this wrong would mail one customer another customer's supplier
 * prices, so an unresolvable owner sends nothing rather than falling back to
 * a guess — the configured fallback is only used when the alert has no owner
 * at all (seeded demo rows).
 */
@Injectable()
export class EmailNotifier implements AlertNotifier {
  readonly channel = 'email';

  private readonly logger = new Logger(EmailNotifier.name);
  private readonly config: AlertsConfig;
  private readonly appUrl: string;

  constructor(
    configService: ConfigService<Configuration, true>,
    private readonly mail: MailService,
    private readonly users: UsersService,
  ) {
    this.config = configService.get('alerts', { infer: true });
    this.appUrl = configService.get('mail', { infer: true })?.appUrl ?? '';
  }

  isConfigured(): boolean {
    return this.mail.enabled;
  }

  async send(alert: Alert, context: AlertContext): Promise<void> {
    const to = await this.recipient(context);

    if (!to) {
      throw new Error('No recipient: the product has no owner with an email address');
    }

    const label = TYPE_LABEL[alert.type];
    const subject = `${label}: ${context.productName}`;

    const rows: Array<[string, string]> = [];

    if (alert.oldPrice !== null) rows.push(['Беше', `${alert.oldPrice} ${alert.currency}`]);
    if (alert.newPrice !== null) rows.push(['Сега', `${alert.newPrice} ${alert.currency}`]);
    if (alert.changePercent !== null) {
      rows.push([
        'Промяна',
        `${alert.changePercent > 0 ? '+' : ''}${alert.changePercent.toFixed(2)}%`,
      ]);
    }
    if (context.targetPrice !== null) {
      rows.push(['Вашата цел', `${context.targetPrice} ${alert.currency}`]);
    }
    if (context.competitorName) rows.push(['Доставчик', context.competitorName]);
    if (context.productSku) rows.push(['Артикул №', context.productSku]);

    const { html, text } = renderEmail({
      title: subject,
      // What the inbox shows next to the subject: the movement itself, so the
      // mail can be triaged without opening it.
      preheader:
        alert.oldPrice !== null && alert.newPrice !== null
          ? `${alert.oldPrice} → ${alert.newPrice} ${alert.currency} при ${context.competitorName ?? 'доставчик'}`
          : alert.message,
      heading: context.productName,
      appUrl: this.appUrl,
      body: [
        {
          html: `<p style="margin:0 0 14px;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${SEVERITY_COLOR[alert.severity]}">${escapeHtml(label)}</p>`,
          text: label,
        },
        paragraph(escapeHtml(alert.message)),
        dataRows(rows),
      ],
      cta: context.competitorUrl
        ? { label: 'Отвори офертата', url: context.competitorUrl }
        : { label: 'Виж в таблото', url: this.appUrl },
      footnotes: [
        'Получавате това, защото следите този артикул. Прагът се настройва за всеки артикул поотделно.',
      ],
    });

    const sent = await this.mail.deliver(to, subject, html, text);

    // `deliver` swallows transport errors and reports false, which is right for
    // a payment webhook and wrong here: an alert that did not arrive must be
    // recorded as failed so it can be retried.
    if (!sent) {
      throw new Error(`SMTP refused the message for ${to}`);
    }

    this.logger.debug(`Alert ${alert.id} emailed to ${to}.`);
  }

  private async recipient(context: AlertContext): Promise<string | null> {
    if (!context.ownerId) {
      return this.config.emailFallbackTo ?? null;
    }

    try {
      const owner = await this.users.findOne(context.ownerId);
      return owner.email;
    } catch {
      // A product whose owner row is gone. Never substitute another address:
      // the fallback is an operator's inbox, and these are somebody's prices.
      this.logger.warn(`Alert owner ${context.ownerId} no longer exists — not emailed.`);
      return null;
    }
  }
}
