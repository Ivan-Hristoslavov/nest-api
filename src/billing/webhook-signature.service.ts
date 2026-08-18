import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BillingConfig, Configuration } from '../config/configuration';
import { BillingProvider } from '../config/env.validation';

export interface SignatureCheck {
  valid: boolean;
  reason?: string;
}

/**
 * Verifies that a webhook really came from the payment provider.
 *
 * This is the single most security-critical function in the billing module:
 * the endpoint it protects hands out API keys. Without a correct signature
 * check, anyone who learns the URL can POST a fabricated "payment succeeded"
 * and provision themselves a paid account.
 *
 * Three rules are enforced:
 *
 * 1. **The signature is computed over the raw bytes.** `JSON.parse` followed by
 *    `JSON.stringify` reorders keys and changes whitespace, which changes the
 *    digest — signature checks against a re-serialised body are guaranteed to
 *    fail, and "fix" attempts usually end with the check being disabled.
 * 2. **Comparison is constant-time.** `===` on strings leaks the correct prefix
 *    through timing and lets an attacker forge a signature byte by byte.
 * 3. **Timestamps are bounded.** Without a freshness window a captured valid
 *    request can be replayed forever.
 */
@Injectable()
export class WebhookSignatureService {
  private readonly logger = new Logger(WebhookSignatureService.name);
  private readonly config: BillingConfig;

  constructor(configService: ConfigService<Configuration, true>) {
    this.config = configService.get('billing', { infer: true });
  }

  get provider(): BillingProvider {
    return this.config.provider;
  }

  isConfigured(): boolean {
    return Boolean(this.config.webhookSecret);
  }

  /**
   * @param rawBody the exact bytes received, before any parsing.
   * @param headers the request headers, lowercased by Node.
   */
  verify(rawBody: Buffer | undefined, headers: Record<string, unknown>): SignatureCheck {
    if (!this.config.webhookSecret) {
      return {
        valid: false,
        reason:
          'No webhook secret configured. Set PADDLE_WEBHOOK_SECRET, STRIPE_WEBHOOK_SECRET or LEMONSQUEEZY_WEBHOOK_SECRET.',
      };
    }

    if (!rawBody || rawBody.length === 0) {
      return {
        valid: false,
        reason: 'Raw request body unavailable — the app must be created with { rawBody: true }.',
      };
    }

    if (this.config.provider === BillingProvider.Paddle) {
      return this.verifyPaddle(rawBody, headers);
    }

    if (this.config.provider === BillingProvider.Stripe) {
      return this.verifyStripe(rawBody, headers);
    }

    return this.verifyLemonSqueezy(rawBody, headers);
  }

  /**
   * Stripe sends `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`, the digest
   * covering `<t>.<raw body>`.
   *
   * Several `v1` values can be present while a secret is being rotated, and
   * any one of them matching is a valid signature. Comparing only the first
   * would reject genuine traffic for the whole rotation window.
   */
  private verifyStripe(rawBody: Buffer, headers: Record<string, unknown>): SignatureCheck {
    const header = this.headerValue(headers, 'stripe-signature');
    if (!header) return { valid: false, reason: 'Missing Stripe-Signature header' };

    const parts = new Map<string, string[]>();
    for (const piece of header.split(',')) {
      const [key, value] = piece.split('=', 2);
      if (!key || value === undefined) continue;
      const bucket = parts.get(key.trim()) ?? [];
      bucket.push(value.trim());
      parts.set(key.trim(), bucket);
    }

    const timestamp = parts.get('t')?.[0];
    const signatures = parts.get('v1') ?? [];

    if (!timestamp || signatures.length === 0) {
      return { valid: false, reason: 'Malformed Stripe-Signature header' };
    }

    // Checked before the digest: a replayed body carries a real signature, and
    // only the age gives it away.
    const fresh = this.checkFreshness(Number.parseInt(timestamp, 10));
    if (!fresh.valid) return fresh;

    const expected = createHmac('sha256', this.config.webhookSecret!)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    for (const presented of signatures) {
      if (this.compare(expected, presented).valid) return { valid: true };
    }

    this.logger.warn('Webhook signature mismatch — request rejected.');
    return { valid: false, reason: 'Signature mismatch' };
  }

  /**
   * Paddle Billing sends `Paddle-Signature: ts=<unix>;h1=<hex>`, where the
   * digest covers `<ts>:<raw body>`. Including the timestamp inside the signed
   * payload is what makes the freshness check meaningful — otherwise an
   * attacker would simply rewrite the header.
   */
  private verifyPaddle(rawBody: Buffer, headers: Record<string, unknown>): SignatureCheck {
    const header = this.headerValue(headers, 'paddle-signature');
    if (!header) return { valid: false, reason: 'Missing Paddle-Signature header' };

    const parts = new Map<string, string>();
    for (const segment of header.split(';')) {
      const [key, value] = segment.split('=');
      if (key && value) parts.set(key.trim(), value.trim());
    }

    const timestamp = parts.get('ts');
    const signature = parts.get('h1');

    if (!timestamp || !signature) {
      return { valid: false, reason: 'Malformed Paddle-Signature header' };
    }

    const freshness = this.checkFreshness(Number.parseInt(timestamp, 10));
    if (!freshness.valid) return freshness;

    const expected = createHmac('sha256', this.config.webhookSecret!)
      .update(`${timestamp}:${rawBody.toString('utf8')}`)
      .digest('hex');

    return this.compare(expected, signature);
  }

  /**
   * Lemon Squeezy sends `X-Signature: <hex>`, an HMAC-SHA256 of the raw body
   * with no timestamp. Replay protection therefore relies entirely on event-id
   * idempotency, which {@link BillingService} enforces.
   */
  private verifyLemonSqueezy(rawBody: Buffer, headers: Record<string, unknown>): SignatureCheck {
    const signature = this.headerValue(headers, 'x-signature');
    if (!signature) return { valid: false, reason: 'Missing X-Signature header' };

    const expected = createHmac('sha256', this.config.webhookSecret!).update(rawBody).digest('hex');

    return this.compare(expected, signature);
  }

  private checkFreshness(timestampSeconds: number): SignatureCheck {
    if (!Number.isFinite(timestampSeconds)) {
      return { valid: false, reason: 'Signature timestamp is not a number' };
    }

    const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
    if (ageSeconds > this.config.signatureToleranceSeconds) {
      return {
        valid: false,
        reason: `Signature is ${Math.round(ageSeconds)}s old, tolerance is ${this.config.signatureToleranceSeconds}s`,
      };
    }

    return { valid: true };
  }

  private compare(expected: string, presented: string): SignatureCheck {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const presentedBuffer = Buffer.from(presented, 'utf8');

    // timingSafeEqual throws on a length mismatch, so check length first —
    // length is not a secret, the contents are.
    if (expectedBuffer.length !== presentedBuffer.length) {
      return { valid: false, reason: 'Signature length mismatch' };
    }

    if (!timingSafeEqual(expectedBuffer, presentedBuffer)) {
      this.logger.warn('Webhook signature mismatch — request rejected.');
      return { valid: false, reason: 'Signature mismatch' };
    }

    return { valid: true };
  }

  private headerValue(headers: Record<string, unknown>, name: string): string | null {
    const value = headers[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
  }
}
