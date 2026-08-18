import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiExcludeEndpoint,
  ApiHeader,
  ApiNotFoundResponse,
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
import { AdminGuard } from '../common/guards/admin.guard';
import { AuthenticatedRequest } from '../common/guards/api-key.guard';
import { BillingService } from './billing.service';
import { MailService } from './mail.service';
import { IssuedApiKeyDto, MyAccountDto, RotateApiKeyDto } from './dto/api-key.dto';
import { WebhookResponseDto } from './dto/webhook-response.dto';
import { BillingEvent } from './entities/billing-event.entity';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { WebhookSignatureService } from './webhook-signature.service';

@ApiTags('Billing')
@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly signatureService: WebhookSignatureService,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
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

  @ApiKeyAuth()
  @Get('me')
  @ApiOperation({
    summary: 'The account behind the API key',
    description:
      'Plan, limits, expiry and the identifying prefix of the key in use. Only the prefix — the key itself is stored as a digest and cannot be read back.',
  })
  @ApiOkResponse({ description: 'The calling account.', type: MyAccountDto })
  @ApiUnauthorizedResponse({
    description: 'Operator keys have no account.',
    type: ErrorResponseDto,
  })
  me(@Req() request: AuthenticatedRequest): MyAccountDto {
    const user = request.user;

    // An operator key authenticates without belonging to anyone, so there is
    // no account to describe. Saying so beats inventing an empty one.
    if (!user) {
      throw new BadRequestException(
        'This is an operator key, not a customer key — it has no billing account.',
      );
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      plan: user.plan,
      productLimit: user.productLimit,
      apiKeyPrefix: user.apiKeyPrefix,
      apiKeyIssuedAt: user.apiKeyIssuedAt ? user.apiKeyIssuedAt.toISOString() : null,
      accessExpiresAt: user.accessExpiresAt ? user.accessExpiresAt.toISOString() : null,
    };
  }

  @ApiKeyAuth()
  @Post('me/api-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace your own API key',
    description:
      'For a key that still works but should not — pasted into a ticket, committed to a repo, or held by someone who has left.\n\n**The old key stops working the moment this returns.** The new one is in the response and nowhere else.',
  })
  @ApiOkResponse({ description: 'The new key, shown once.', type: IssuedApiKeyDto })
  async rotateOwnApiKey(@Req() request: AuthenticatedRequest): Promise<IssuedApiKeyDto> {
    const user = request.user;

    if (!user) {
      throw new BadRequestException(
        'This is an operator key. Rotate it by changing API_KEY in the environment.',
      );
    }

    return this.issue(user.id, 'live', Boolean(user.apiKeyPrefix));
  }

  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Get('users')
  @ApiOperation({
    summary: 'Every customer account (operator only)',
    description:
      'The operator\'s customer list: who has paid, on what plan, how many products they are allowed, and the prefix of the key they hold.\n\nThe key prefix is here so a customer reading "pk_live_9f2b…" down the phone can be matched to their account. The key itself is not recoverable — only a hash is stored — so a lost key is replaced, never retrieved.',
  })
  @ApiOkResponse({ type: User, isArray: true })
  listUsers(): Promise<User[]> {
    return this.usersService.findAll();
  }

  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Post('users/api-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue a replacement key for a customer (operator only)',
    description:
      "The recovery path for a customer who has lost their key. They cannot ask for a new one themselves — presenting the lost key is exactly what they cannot do — so an operator does it for them and hands the result over.\n\nRequires an operator key from `API_KEY` / `API_KEYS`; a customer key is refused. Otherwise knowing somebody's email address would be enough to destroy their access, since issuing a key revokes the previous one.",
  })
  @ApiOkResponse({ description: 'The new key, shown once.', type: IssuedApiKeyDto })
  @ApiNotFoundResponse({ description: 'No account with this email.', type: ErrorResponseDto })
  async rotateCustomerApiKey(@Body() dto: RotateApiKeyDto): Promise<IssuedApiKeyDto> {
    const user = await this.usersService.findByEmail(dto.email);

    if (!user) {
      throw new NotFoundException(`No account for "${dto.email}".`);
    }

    this.logger.warn(
      `Operator issued a replacement API key for ${user.email}. Any previous key is now dead.`,
    );

    return this.issue(user.id, dto.environment ?? 'live', Boolean(user.apiKeyPrefix));
  }

  private async issue(
    userId: string,
    environment: 'live' | 'test',
    replacedPreviousKey: boolean,
  ): Promise<IssuedApiKeyDto> {
    const { user, apiKey } = await this.usersService.issueApiKey(userId, environment);

    // Emailed as well as returned. The response reaches whoever made the
    // request — often an operator acting for the customer — and the customer
    // is the one who needs the key.
    const emailed = await this.mail.sendApiKey(user, apiKey, replacedPreviousKey);

    return {
      userId: user.id,
      email: user.email,
      apiKey,
      prefix: user.apiKeyPrefix ?? '',
      issuedAt: (user.apiKeyIssuedAt ?? new Date()).toISOString(),
      replacedPreviousKey,
      emailed,
    };
  }

  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Get('mail/health')
  @ApiOperation({
    summary: 'Is outgoing email working? (operator only)',
    description:
      'Opens a connection to the SMTP server and authenticates, without sending anything. Worth checking before a launch: a paid account whose key cannot be emailed is a support ticket, not a customer.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        ok: { type: 'boolean' },
        detail: { type: 'string' },
      },
    },
  })
  async mailHealth(): Promise<{ enabled: boolean; ok: boolean; detail: string }> {
    const result = await this.mail.verify();
    return { enabled: this.mail.enabled, ...result };
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
