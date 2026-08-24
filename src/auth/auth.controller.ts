import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { AuthenticatedRequest } from '../common/guards/api-key.guard';
import { bearerOf } from '../common/session-resolver';
import { Configuration } from '../config/configuration';
import { AuthService, ExchangeFailure, IssuedSession } from './auth.service';
import {
  ExchangeSignInDto,
  RegisterDto,
  RequestSignInDto,
  SessionDto,
  SessionSummaryDto,
  TwoFactorCodeDto,
  TwoFactorEnrolmentDto,
  VerifyTwoFactorDto,
} from './dto/auth.dto';
import { TwoFactorService } from './two-factor.service';

const FAILURE_MESSAGE: Record<ExchangeFailure, string> = {
  unknown: 'Тази връзка не е валидна. Поискайте нова от страницата за вход.',
  expired: 'Връзката е изтекла. Поискайте нова — новата важи 15 минути.',
  used: 'Тази връзка вече е използвана. Поискайте нова.',
};

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly appUrl: string;

  constructor(
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
    configService: ConfigService<Configuration, true>,
  ) {
    this.appUrl = configService.get('mail', { infer: true }).appUrl;
  }

  @Public()
  // Harder than the rest of the API: this endpoint sends mail on behalf of an
  // anonymous caller, which is the shape of thing that gets used to flood
  // somebody else's inbox.
  @Throttle({ default: { ttl: 3_600_000, limit: 6 } })
  @Post('sign-in')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email a sign-in link',
    description:
      'Always answers 202, whether or not the address has an account. Telling an anonymous caller which addresses are registered would turn this into a customer list; the person who typed their own address learns the answer from their inbox.',
  })
  @ApiNoContentResponse({ description: 'If there is an account, a link is on its way.' })
  async requestSignIn(@Body() dto: RequestSignInDto): Promise<{ sent: true }> {
    await this.auth.requestSignInLink(dto.email, this.appUrl, dto.locale);
    return { sent: true };
  }

  @Public()
  // Creates a row and sends mail for an anonymous caller — the shape of thing
  // that gets used to flood somebody else's inbox, or to farm free accounts.
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Register for the free plan',
    description:
      'Sends a link that verifies the mailbox and opens the account. No key comes back here: handing one out on request made the address decoration, and let a script farm accounts — and their monthly AI allowances — from mailboxes nobody owns. An address that already has an account gets a sign-in link instead, and the response is the same either way.',
  })
  @ApiOkResponse({ schema: { type: 'object', properties: { sent: { type: 'boolean' } } } })
  @ApiBadRequestResponse({
    description: 'A disposable or unroutable address.',
    type: ErrorResponseDto,
  })
  async register(@Body() dto: RegisterDto): Promise<{ sent: true }> {
    await this.auth.register(dto.email, dto.name, this.appUrl, dto.locale);
    return { sent: true };
  }

  @Public()
  @Throttle({ default: { ttl: 3_600_000, limit: 30 } })
  @Post('session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trade a sign-in link for a session',
    description:
      'The link works once. What comes back is a browser credential sent as `Authorization: Bearer <token>` — not the API key, which is a machine credential and cannot be read back anyway.',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiBadRequestResponse({ description: 'Unknown, spent or expired link.', type: ErrorResponseDto })
  async exchange(
    @Body() dto: ExchangeSignInDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<SessionDto> {
    const result = await this.auth.exchange(dto.token, userAgent);

    if ('failure' in result) {
      throw new BadRequestException(FAILURE_MESSAGE[result.failure]);
    }

    // An account with a second factor is not signed in yet. What comes back is
    // a challenge, and `POST /auth/totp/verify` finishes the job.
    if ('twoFactor' in result) {
      return {
        token: null,
        expiresAt: result.expiresAt.toISOString(),
        email: null,
        name: null,
        plan: null,
        apiKey: null,
        twoFactorRequired: true,
        challenge: result.challenge,
      };
    }

    return sessionResponse(result);
  }

  @Public()
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @Post('totp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finish signing in with a second factor',
    description:
      'Trades the challenge from `POST /auth/session` for a real session. Accepts either the six digits from the authenticator app or one recovery code, which is spent as it is used.',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiBadRequestResponse({ description: 'Bad challenge or wrong code.', type: ErrorResponseDto })
  async verifyTwoFactor(
    @Body() dto: VerifyTwoFactorDto,
    @Headers('user-agent') userAgent?: string,
  ): Promise<SessionDto> {
    const result = await this.auth.completeTwoFactor(
      dto.challenge,
      (userId) => this.twoFactor.verify(userId, dto.code),
      userAgent,
    );

    if ('failure' in result) {
      throw new BadRequestException(
        result.failure === 'code'
          ? 'Кодът не е верен. Проверете часа на телефона си и опитайте пак.'
          : FAILURE_MESSAGE[result.failure],
      );
    }

    return sessionResponse(result);
  }

  @ApiKeyAuth()
  @Post('totp/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start setting up a second factor',
    description:
      'Returns a secret, the `otpauth://` URI to turn into a QR code, and eight recovery codes. Nothing is enforced until `POST /auth/totp/enable` succeeds — switching it on before the phone has produced a working code is how somebody locks themselves out.\n\n**The recovery codes are shown once.**',
  })
  @ApiOkResponse({ type: TwoFactorEnrolmentDto })
  async setupTwoFactor(@Req() request: AuthenticatedRequest): Promise<TwoFactorEnrolmentDto> {
    const owner = request.user;
    if (!owner) throw new BadRequestException('Този ключ не принадлежи на акаунт.');

    const enrolment = await this.twoFactor.beginEnrolment(owner.id, owner.email);

    return {
      secret: enrolment.secret,
      otpauthUrl: enrolment.otpauthUrl,
      qrSvg: enrolment.qrSvg,
      recoveryCodes: enrolment.recoveryCodes,
    };
  }

  @ApiKeyAuth()
  @Post('totp/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Switch the second factor on',
    description: 'Takes a code from the app, proving the phone is set up correctly.',
  })
  @ApiNoContentResponse({ description: 'Two-factor authentication is on.' })
  async enableTwoFactor(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TwoFactorCodeDto,
  ): Promise<void> {
    const owner = request.user;
    if (!owner) throw new BadRequestException('Този ключ не принадлежи на акаунт.');

    const enabled = await this.twoFactor.enable(owner.id, dto.code);

    if (!enabled) {
      throw new BadRequestException('Кодът не е верен. Проверете часа на телефона си.');
    }
  }

  @ApiKeyAuth()
  @Post('totp/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Switch the second factor off',
    description:
      'Requires a working code. That is the point: a stolen session is exactly what the second factor exists to survive, and one that could switch it off would survive nothing.',
  })
  @ApiNoContentResponse({ description: 'Two-factor authentication is off.' })
  async disableTwoFactor(
    @Req() request: AuthenticatedRequest,
    @Body() dto: TwoFactorCodeDto,
  ): Promise<void> {
    const owner = request.user;
    if (!owner) throw new BadRequestException('Този ключ не принадлежи на акаунт.');

    const disabled = await this.twoFactor.disable(owner.id, dto.code);
    if (!disabled) throw new BadRequestException('Кодът не е верен.');
  }

  @ApiKeyAuth()
  @Get('sessions')
  @ApiOperation({
    summary: 'Devices this account is signed in on',
    description:
      'One row per live session, newest use first. The session making the request is flagged, so an interface can stop somebody revoking the browser they are sitting in front of.\n\nNo token or digest is returned — there is nothing here that could sign anybody in.',
  })
  @ApiOkResponse({ type: [SessionSummaryDto] })
  async sessions(@Req() request: AuthenticatedRequest): Promise<SessionSummaryDto[]> {
    const owner = request.user;
    if (!owner) throw new BadRequestException('Този ключ не принадлежи на акаунт.');

    const rows = await this.auth.listSessions(
      owner.id,
      bearerOf(request.headers.authorization) ?? undefined,
    );

    return rows.map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      expiresAt: row.expiresAt.toISOString(),
      current: row.current,
    }));
  }

  @ApiKeyAuth()
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End one other session',
    description:
      "For the laptop left in an office. Scoped to the caller's own account, so an id from somewhere else revokes nothing.",
  })
  @ApiNoContentResponse({ description: 'That session is over.' })
  async revokeSession(
    @Req() request: AuthenticatedRequest,
    @Param('id') sessionId: string,
  ): Promise<void> {
    const owner = request.user;
    if (!owner) throw new BadRequestException('Този ключ не принадлежи на акаунт.');

    const removed = await this.auth.revokeSession(owner.id, sessionId);
    if (!removed) throw new NotFoundException('Няма такъв активен вход.');
  }

  @ApiKeyAuth()
  @Post('sign-out-everywhere')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End every session, including this one',
    description:
      'The answer to "I think somebody else has been in my account". The API key is deliberately untouched: rotating that is a separate, more destructive decision that breaks whatever scripts the customer is running.',
  })
  @ApiNoContentResponse({ description: 'Every device is signed out.' })
  async signOutEverywhere(@Req() request: AuthenticatedRequest): Promise<void> {
    const owner = request.user;
    if (!owner) throw new BadRequestException('Този ключ не принадлежи на акаунт.');

    await this.auth.signOutEverywhere(owner.id);
  }

  @ApiKeyAuth()
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'End this session',
    description:
      'Ends only the session that made the request. Other devices stay signed in, and the API key is untouched.',
  })
  @ApiNoContentResponse({ description: 'Signed out.' })
  async signOut(@Req() request: AuthenticatedRequest): Promise<void> {
    const token = bearerOf(request.headers.authorization);
    if (token) await this.auth.signOut(token);
  }
}

/** One shape for both ways a session can be handed over. */
function sessionResponse(result: IssuedSession): SessionDto {
  return {
    token: result.token,
    expiresAt: result.expiresAt.toISOString(),
    email: result.user.email,
    name: result.user.name,
    plan: result.user.plan,
    // Present only when this sign-in was the one that opened the account. It
    // is the single moment the key can be shown; after this it exists only as
    // a digest.
    apiKey: result.apiKey || null,
    twoFactorRequired: false,
    challenge: null,
  };
}
