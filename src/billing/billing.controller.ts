import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiExcludeEndpoint,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { BillingService } from './billing.service';
import { WebhookResponseDto } from './dto/webhook-response.dto';
import { BillingEvent } from './entities/billing-event.entity';
import { WebhookSignatureService } from './webhook-signature.service';

@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly signatureService: WebhookSignatureService,
  ) {}

  /**
   * Payment provider webhook.
   *
   * `@Public()` because the caller is Paddle, not a customer — it has no API
   * key. The signature check *is* the authentication here, and it is the only
   * thing standing between this endpoint and anyone provisioning themselves a
   * paid account.
   *
   * Always answers 200 once the signature is valid, including for events we
   * ignore: a non-2xx makes the provider retry indefinitely.
   */
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Payment provider webhook (Paddle / Lemon Squeezy)',
    description: [
      'Receives billing events from the merchant of record and provisions accounts.',
      '',
      '**Authentication is the signature, not an API key.** The raw request body is verified with HMAC-SHA256 against `PADDLE_WEBHOOK_SECRET` / `LEMONSQUEEZY_WEBHOOK_SECRET`, in constant time, with a freshness window on the Paddle timestamp. An invalid signature is rejected with 401 and nothing is written.',
      '',
      'On a successful payment event the customer is found or created, activated, and — if they have no key yet — issued a fresh `X-API-KEY`.',
      '',
      'Idempotent: the provider event id is stored under a unique index, so retries are recognised and ignored.',
    ].join('\n'),
  })
  @ApiHeader({
    name: 'Paddle-Signature',
    description: 'Paddle signature: `ts=<unix>;h1=<hex>`. Sent by Paddle, not by you.',
    required: false,
  })
  @ApiHeader({
    name: 'X-Signature',
    description: 'Lemon Squeezy signature: HMAC-SHA256 hex of the raw body.',
    required: false,
  })
  @ApiOkResponse({
    description: 'Event accepted. Also returned for events that need no action.',
    type: WebhookResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Signature missing, malformed, stale, or wrong.',
    type: ErrorResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Body is not valid JSON.', type: ErrorResponseDto })
  async webhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ): Promise<WebhookResponseDto> {
    const check = this.signatureService.verify(request.rawBody, headers);

    if (!check.valid) {
      this.logger.warn(`Rejected billing webhook: ${check.reason ?? 'invalid signature'}`);
      throw new UnauthorizedException('Invalid webhook signature.');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(request.rawBody!.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('Webhook body is not valid JSON.');
    }

    const outcome = await this.billingService.handleWebhook(
      this.signatureService.provider,
      payload,
    );

    // The plaintext key is deliberately never returned to the provider.
    return {
      received: true,
      processed: outcome.processed,
      duplicate: outcome.duplicate,
      note: outcome.note,
    };
  }

  @ApiKeyAuth()
  @Get('events')
  @ApiOperation({
    summary: 'Recent billing webhooks',
    description:
      'The last events received, with their raw payloads — the first place to look when a customer says they paid and got nothing.',
  })
  @ApiOkResponse({ description: 'Recent events, newest first.', type: BillingEvent, isArray: true })
  recentEvents(@Query('limit') limit?: string): Promise<BillingEvent[]> {
    const parsed = Number.parseInt(limit ?? '20', 10);
    return this.billingService.findRecentEvents(
      Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 20,
    );
  }

  /** Not part of the public contract; used by the deployment smoke check. */
  @ApiExcludeEndpoint()
  @ApiKeyAuth()
  @Get('webhook/health')
  webhookHealth(): { provider: string; signatureConfigured: boolean } {
    return {
      provider: this.signatureService.provider,
      signatureConfigured: this.signatureService.isConfigured(),
    };
  }
}
