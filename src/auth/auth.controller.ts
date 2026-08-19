import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
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
import { AuthService, ExchangeFailure } from './auth.service';
import { ExchangeSignInDto, RegisterDto, RequestSignInDto, SessionDto } from './dto/auth.dto';

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
    await this.auth.requestSignInLink(dto.email, this.appUrl);
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
    await this.auth.register(dto.email, dto.name, this.appUrl);
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

    return {
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      email: result.user.email,
      name: result.user.name,
      plan: result.user.plan,
      // Present only when this link was the one that opened the account. It is
      // the single moment the key can be shown; after this it exists only as a
      // digest.
      apiKey: result.apiKey || null,
    };
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
