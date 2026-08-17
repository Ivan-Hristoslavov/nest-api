import { createHmac } from 'node:crypto';

import { ConfigService } from '@nestjs/config';

import { Configuration } from '../config/configuration';
import { BillingProvider } from '../config/env.validation';
import { WebhookSignatureService } from './webhook-signature.service';

const SECRET = 'pdl_ntfset_01hv8w9x2k3m4n5p6q7r8s9t0v';
const BODY = JSON.stringify({ event_type: 'subscription.created', data: { id: 'sub_123' } });

// `null` means "no secret configured" — an explicit `undefined` would fall back
// to the default parameter and silently test the wrong thing.
function createService(
  provider: BillingProvider,
  secret: string | null = SECRET,
  toleranceSeconds = 300,
): WebhookSignatureService {
  const configService = {
    get: jest.fn().mockReturnValue({
      provider,
      webhookSecret: secret ?? undefined,
      signatureToleranceSeconds: toleranceSeconds,
    }),
  } as unknown as ConfigService<Configuration, true>;

  return new WebhookSignatureService(configService);
}

function paddleHeader(body: string, secret = SECRET, timestamp = nowSeconds()): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}:${body}`).digest('hex');
  return `ts=${timestamp};h1=${digest}`;
}

function lemonHeader(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('WebhookSignatureService', () => {
  describe('Paddle', () => {
    it('accepts a correctly signed request', () => {
      const service = createService(BillingProvider.Paddle);
      const result = service.verify(Buffer.from(BODY), {
        'paddle-signature': paddleHeader(BODY),
      });

      expect(result.valid).toBe(true);
    });

    it('rejects a signature made with the wrong secret', () => {
      const service = createService(BillingProvider.Paddle);
      const result = service.verify(Buffer.from(BODY), {
        'paddle-signature': paddleHeader(BODY, 'attacker-secret'),
      });

      expect(result).toEqual({ valid: false, reason: 'Signature mismatch' });
    });

    it('rejects a request whose body was altered after signing', () => {
      const service = createService(BillingProvider.Paddle);
      const header = paddleHeader(BODY);
      const tampered = JSON.stringify({
        event_type: 'subscription.created',
        data: { id: 'sub_ATTACKER' },
      });

      expect(service.verify(Buffer.from(tampered), { 'paddle-signature': header }).valid).toBe(
        false,
      );
    });

    it('rejects a replayed request outside the freshness window', () => {
      const service = createService(BillingProvider.Paddle, SECRET, 60);
      const staleTimestamp = nowSeconds() - 3600;

      const result = service.verify(Buffer.from(BODY), {
        'paddle-signature': paddleHeader(BODY, SECRET, staleTimestamp),
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/old, tolerance is 60s/);
    });

    it('rejects a missing header', () => {
      const service = createService(BillingProvider.Paddle);

      expect(service.verify(Buffer.from(BODY), {})).toEqual({
        valid: false,
        reason: 'Missing Paddle-Signature header',
      });
    });

    it('rejects a malformed header', () => {
      const service = createService(BillingProvider.Paddle);

      expect(service.verify(Buffer.from(BODY), { 'paddle-signature': 'garbage' })).toEqual({
        valid: false,
        reason: 'Malformed Paddle-Signature header',
      });
    });
  });

  describe('Lemon Squeezy', () => {
    it('accepts a correctly signed request', () => {
      const service = createService(BillingProvider.LemonSqueezy);

      expect(service.verify(Buffer.from(BODY), { 'x-signature': lemonHeader(BODY) }).valid).toBe(
        true,
      );
    });

    it('rejects a wrong signature', () => {
      const service = createService(BillingProvider.LemonSqueezy);

      expect(
        service.verify(Buffer.from(BODY), { 'x-signature': lemonHeader(BODY, 'nope') }).valid,
      ).toBe(false);
    });
  });

  describe('fail-closed behaviour', () => {
    it('rejects everything when no secret is configured', () => {
      const service = createService(BillingProvider.Paddle, null);
      const result = service.verify(Buffer.from(BODY), {
        'paddle-signature': paddleHeader(BODY),
      });

      expect(result.valid).toBe(false);
      expect(service.isConfigured()).toBe(false);
    });

    it('rejects when the raw body was not captured', () => {
      const service = createService(BillingProvider.Paddle);
      const result = service.verify(undefined, { 'paddle-signature': paddleHeader(BODY) });

      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/rawBody/);
    });
  });
});
