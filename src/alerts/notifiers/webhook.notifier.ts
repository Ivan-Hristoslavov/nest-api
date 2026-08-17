import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AlertsConfig, Configuration } from '../../config/configuration';
import { Alert } from '../entities/alert.entity';
import { AlertContext, AlertNotifier } from './notifier.interface';

/**
 * Posts alerts as JSON to a caller-supplied endpoint.
 *
 * The body is signed with HMAC-SHA256 over `<timestamp>.<body>` and sent in
 * `X-Signature`, with the timestamp in `X-Signature-Timestamp`. Signing the
 * timestamp alongside the payload is what makes a captured request unusable
 * later — a bare body signature can be replayed forever.
 */
@Injectable()
export class WebhookNotifier implements AlertNotifier {
  readonly channel = 'webhook';

  private readonly logger = new Logger(WebhookNotifier.name);
  private readonly config: AlertsConfig;

  constructor(configService: ConfigService<Configuration, true>) {
    this.config = configService.get('alerts', { infer: true });
  }

  isConfigured(): boolean {
    return Boolean(this.config.webhookUrl);
  }

  async send(alert: Alert, context: AlertContext): Promise<void> {
    if (!this.config.webhookUrl) {
      throw new Error('Alert webhook URL is not configured');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      message: alert.message,
      productId: alert.productId,
      productName: context.productName,
      productSku: context.productSku,
      competitorId: alert.competitorId,
      competitorName: context.competitorName,
      competitorUrl: context.competitorUrl,
      oldPrice: alert.oldPrice,
      newPrice: alert.newPrice,
      changePercent: alert.changePercent,
      targetPrice: context.targetPrice,
      currency: alert.currency,
      createdAt: alert.createdAt.toISOString(),
    });

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'PriceIntelligenceAPI/1.0',
    };

    if (this.config.webhookSecret) {
      headers['x-signature-timestamp'] = timestamp;
      headers['x-signature'] = WebhookNotifier.sign(body, timestamp, this.config.webhookSecret);
    }

    const response = await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.config.deliveryTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Webhook responded ${response.status}`);
    }

    this.logger.debug(`Alert ${alert.id} delivered to webhook.`);
  }

  /** Computes the signature. Exported shape so receivers can mirror it. */
  static sign(body: string, timestamp: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  }

  /**
   * Verifies a signature produced by {@link sign}.
   *
   * Not used by this service — provided so the receiving end (and the tests)
   * have one canonical implementation to check against, compared in constant
   * time so a receiver copying this code does not leak the secret byte by byte.
   */
  static verify(body: string, timestamp: string, secret: string, signature: string): boolean {
    const expected = Buffer.from(WebhookNotifier.sign(body, timestamp, secret));
    const presented = Buffer.from(signature);

    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }
}
