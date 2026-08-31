import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiExcludeEndpoint,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { redactEmail } from '../common/redact';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { AdminGuard } from '../common/guards/admin.guard';
import { KeyRevocationService } from '../common/key-revocation.service';
import { AuthenticatedRequest } from '../common/guards/api-key.guard';
import { BillingService } from './billing.service';
import { CheckoutService, PurchasablePlan } from './checkout.service';
import { MailService } from './mail.service';
import {
  ActivateAccountDto,
  EraseAccountDto,
  IssuedApiKeyDto,
  MyAccountDto,
  RotateApiKeyDto,
  StartCheckoutDto,
} from './dto/api-key.dto';
import { AdjustUserDto } from './dto/adjust-user.dto';
import { WebhookResponseDto } from './dto/webhook-response.dto';
import { BillingEvent } from './entities/billing-event.entity';
import {
  PLAN_CURRENCY,
  PLAN_PRICE,
  User,
  UserPlan,
  effectiveAiUsage,
  planPriceOf,
} from './entities/user.entity';
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
    private readonly checkout: CheckoutService,
    private readonly revocations: KeyRevocationService,
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

  @Public()
  @Get('plans')
  @ApiOperation({
    summary: 'Plans that can actually be bought',
    description:
      'Only plans with a price configured in Stripe. A plan listed without one would send the buyer to a checkout that cannot complete, so the pricing page asks this rather than assuming.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'False when Stripe is not configured at all.' },
        plans: { type: 'array', items: { type: 'string', example: 'pro' } },
        currency: { type: 'string', example: 'EUR' },
        prices: {
          type: 'object',
          description:
            'Monthly price per plan, including the ones that cannot be bought here. The pricing page renders from this rather than from figures written into its own markup, which is what stops it disagreeing with the subscription figure shown inside the account.',
          additionalProperties: { type: 'number' },
          example: { free: 0, starter: 19, pro: 49, business: 99 },
        },
      },
    },
  })
  plans(): {
    enabled: boolean;
    plans: string[];
    topUpUrl: string | null;
    currency: string;
    prices: Record<string, number>;
  } {
    return {
      enabled: this.checkout.enabled,
      plans: this.checkout.availablePlans().map((entry) => entry.plan),
      // Null when nothing is configured, so the interface offers a top-up only
      // where one can actually be bought.
      topUpUrl: this.checkout.topUpUrl,
      currency: PLAN_CURRENCY,
      // Every plan, not only the purchasable ones. `plans` above answers "what
      // can be bought right now", which depends on Stripe being configured;
      // this answers "what does each tier cost", which does not. A pricing page
      // that hid its prices whenever Stripe was misconfigured would be a
      // stranger failure than the one it was avoiding.
      prices: { ...PLAN_PRICE },
    };
  }

  @Public()
  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a subscription purchase',
    description:
      'Creates a Stripe Checkout Session and returns the URL to send the buyer to.\n\n`@Public()` because the caller is a visitor who has not bought anything yet and therefore has no key — that is the whole point of the endpoint. No card data touches this application: Stripe collects it and reports the outcome over the webhook, which is what creates the account and emails the key.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        id: { type: 'string', example: 'cs_test_a1b2c3' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'Unknown plan, or Stripe is not configured.',
    type: ErrorResponseDto,
  })
  async startCheckout(@Body() dto: StartCheckoutDto): Promise<{ url: string; id: string }> {
    return this.checkout.createSession(dto.plan as PurchasablePlan, dto.email);
  }

  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Get('events')
  @ApiOperation({
    summary: 'Recent billing webhooks',
    description:
      "The last events received, with their raw payloads — the first place to look when a customer says they paid and got nothing.\n\nOperator only. The rows are not filtered by owner and the payloads carry other customers' email addresses and subscription identifiers, so a customer key reading this would be reading everybody's billing history.",
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

    // The stored counter is only reset lazily; the shared helper applies the
    // rollover so this endpoint never shows last month's spend as this month's.
    const aiUsage = effectiveAiUsage(user);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
      plan: user.plan,
      productLimit: user.productLimit,
      // From the one server-side table of prices, so the interface never has
      // to hold a copy — the copy is what drifts from the pricing page.
      planPrice: planPriceOf(user.plan),
      planCurrency: PLAN_CURRENCY,
      aiMatchesUsed: aiUsage.used,
      aiMatchesLimit: aiUsage.limit,
      aiMatchesRenew: aiUsage.renews,
      apiKeyPrefix: user.apiKeyPrefix,
      apiKeyIssuedAt: user.apiKeyIssuedAt ? user.apiKeyIssuedAt.toISOString() : null,
      accessExpiresAt: user.accessExpiresAt ? user.accessExpiresAt.toISOString() : null,
      // Only reported while it is running. A finished trial is stored — it is
      // what stops a second one — but the interface has nothing to say about it.
      trialEndsAt: user.isOnTrial() ? user.trialEndsAt!.toISOString() : null,
      trialDaysLeft: user.isOnTrial() ? user.trialDaysLeft() : null,
      // The state, never the secret: this is what lets the interface show
      // "on" without anything sensitive leaving the server.
      totpEnabled: user.hasTwoFactor(),
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

  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Post('users/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open an account by hand (operator only)',
    description:
      'For the customer who paid by bank transfer, or whose plan is agreed rather than bought — the case the pricing page promises when it says "write to us and we will activate you". Activates a pending registration and places it on a plan; issues a first key if the account has none, and never rotates one it already has.',
  })
  @ApiOkResponse({ type: IssuedApiKeyDto })
  @ApiNotFoundResponse({ description: 'No account with that email.', type: ErrorResponseDto })
  async activateAccount(@Body() dto: ActivateAccountDto): Promise<IssuedApiKeyDto> {
    const user = await this.usersService.findByEmail(dto.email);

    if (!user) {
      throw new NotFoundException(`Няма акаунт с имейл "${dto.email}".`);
    }

    const activated = await this.usersService.activate(user.id, {
      plan: (dto.plan as UserPlan | undefined) ?? undefined,
    });

    const { user: withKey, apiKey } = await this.usersService.activateFreeAccount(activated.id);

    // Only a first key is issued here. Rotating one the customer already uses
    // would break their integration as a side effect of a plan change.
    const issuedNow = apiKey !== '';

    if (issuedNow) await this.mail.sendApiKey(withKey, apiKey);

    this.logger.warn(
      `Operator activated ${withKey.email} on plan ${withKey.plan}` +
        (issuedNow ? ' and issued a first key.' : ' (existing key kept).'),
    );

    return {
      userId: withKey.id,
      email: withKey.email,
      apiKey,
      prefix: withKey.apiKeyPrefix ?? '',
      issuedAt: (withKey.apiKeyIssuedAt ?? new Date()).toISOString(),
      replacedPreviousKey: false,
      emailed: issuedNow,
    };
  }

  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Patch('users/:id')
  @ApiOperation({
    summary: 'Change an account by hand (operator only)',
    description:
      'Status, plan and tracked-article limit. Everything here is normally decided by a payment; this is for when a payment is not going to decide it — a bank transfer, a lapse worth overlooking, a week of extra headroom.\n\nOnly what you send is touched. Every change is logged with what it was before, because six months later somebody will ask why this account is on this plan.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: User })
  @ApiNotFoundResponse({ description: 'No account with this id.', type: ErrorResponseDto })
  async adjustUser(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AdjustUserDto,
  ): Promise<User> {
    const user = await this.usersService.adjust(id, dto);

    // A suspended account must stop working now, not when the guard's cache
    // happens to expire.
    this.revocations.revokeCachedKeys(`account ${id} adjusted by an operator`);

    return user;
  }

  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Erase an account and its data (operator only)',
    description:
      'Deletes the account together with every product, listing, price record, alert and hand-entered price it owns. This is what answers a GDPR erasure request, and it is not reversible — the caller must repeat the account’s email as confirmation.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Account and all its data erased.' })
  @ApiConflictResponse({
    description: 'The confirmation email does not match the account.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'No account with this id.', type: ErrorResponseDto })
  async eraseAccount(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: EraseAccountDto,
  ): Promise<void> {
    const { email } = await this.usersService.eraseAccount(id, query.confirmEmail);

    // The row is gone; the guard's cache must not keep authorising it for the
    // rest of the TTL. An erased account that still answers 200 for half a
    // minute is not erased.
    this.revocations.revokeCachedKeys(`account ${id} erased`);

    this.logger.warn(`Operator erased account ${id} (${redactEmail(email)}) on request.`);
  }

  private async issue(
    userId: string,
    environment: 'live' | 'test',
    replacedPreviousKey: boolean,
  ): Promise<IssuedApiKeyDto> {
    const { user, apiKey } = await this.usersService.issueApiKey(userId, environment);

    // Rotation is destructive by design and says so: the old key has to stop
    // working now, not when a cached lookup happens to expire.
    this.revocations.revokeCachedKeys(`key rotated for ${user.email}`);

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

  /**
   * Not part of the public contract; used by the deployment smoke check.
   *
   * Operator-only: whether the webhook secret is set is a fact about the
   * deployment's readiness to take money, and telling a customer that it is
   * *not* set names the one gap worth probing.
   */
  @ApiExcludeEndpoint()
  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Get('webhook/health')
  webhookHealth(): { provider: string; signatureConfigured: boolean } {
    return {
      provider: this.signatureService.provider,
      signatureConfigured: this.signatureService.isConfigured(),
    };
  }
}
