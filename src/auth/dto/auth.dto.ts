import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';

import { trimString } from '../../common/transformers/dto-transformers';

export class RequestSignInDto {
  @ApiProperty({
    description:
      'The address the account is keyed on. Nothing is revealed about whether it exists.',
    format: 'email',
    example: 'kupuvach@moiat-magazin.bg',
  })
  @IsEmail()
  @MaxLength(255)
  @Transform(trimString)
  email!: string;

  @ApiPropertyOptional({
    description:
      'The language the interface is being read in, so the emails match it. Anything we do not offer falls back to Bulgarian.',
    example: 'ro',
    maxLength: 5,
  })
  @IsString()
  @IsOptional()
  @MaxLength(5)
  @Transform(trimString)
  locale?: string;
}

export class RegisterDto {
  @ApiProperty({
    description:
      'A mailbox you can open. Disposable and unroutable addresses are refused, because the link sent here is what turns the registration into an account.',
    format: 'email',
    example: 'kupuvach@moiat-magazin.bg',
  })
  @IsEmail()
  @MaxLength(255)
  @Transform(trimString)
  email!: string;

  @ApiPropertyOptional({ description: 'Company or person.', example: 'Електро Иванов ЕООД' })
  @IsString()
  @IsOptional()
  @MaxLength(160)
  @Transform(trimString)
  name?: string;

  @ApiPropertyOptional({
    description:
      'The language the interface is being read in, so the emails match it. Anything we do not offer falls back to Bulgarian.',
    example: 'ro',
    maxLength: 5,
  })
  @IsString()
  @IsOptional()
  @MaxLength(5)
  @Transform(trimString)
  locale?: string;
}

export class ExchangeSignInDto {
  @ApiProperty({ description: 'The token from the emailed link.', example: 'pg_link_7Qw…' })
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  @Transform(trimString)
  token!: string;
}

export class SessionDto {
  @ApiPropertyOptional({
    description:
      'Send as `Authorization: Bearer <token>`. This is a browser credential — the API key stays for scripts and is not returned here, because it cannot be read back.\n\nNull when `twoFactorRequired` is true: nobody is signed in yet.',
    nullable: true,
    example: 'pg_sess_9fK…',
  })
  token!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;

  @ApiPropertyOptional({ nullable: true, example: 'kupuvach@moiat-magazin.bg' })
  email!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'Електро Иванов ЕООД' })
  name!: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'pro' })
  plan!: string | null;

  @ApiPropertyOptional({
    description:
      'The API key, present only when this exchange opened a new account. Shown once — afterwards only its digest exists.',
    nullable: true,
    example: 'pk_live_7Qw…',
  })
  apiKey!: string | null;

  @ApiProperty({
    description:
      'True when the mailbox has been proved but a second factor is still owed. Nothing else in this response is filled in; send `challenge` to `POST /auth/totp/verify`.',
    example: false,
  })
  twoFactorRequired!: boolean;

  @ApiPropertyOptional({
    description: 'Short-lived receipt to exchange for a session once the code is verified.',
    nullable: true,
    example: 'pg_2fa_A1b…',
  })
  challenge!: string | null;
}

/** The six digits from an authenticator app, or one recovery code. */
export class TwoFactorCodeDto {
  @ApiProperty({ example: '482913' })
  @IsString()
  @Length(6, 32)
  code!: string;
}

export class VerifyTwoFactorDto extends TwoFactorCodeDto {
  @ApiProperty({ description: 'The challenge from `POST /auth/session`.' })
  @IsString()
  @Length(10, 200)
  challenge!: string;
}

/**
 * Everything needed to set a phone up — shown exactly once.
 *
 * The recovery codes in particular: they are stored only as digests, so this
 * response is the one moment they exist in readable form.
 */
export class TwoFactorEnrolmentDto {
  @ApiProperty({
    description: 'Base32 secret, for typing in by hand.',
    example: 'JBSWY3DPEHPK3PXP',
  })
  secret!: string;

  @ApiProperty({
    description: 'Turn this into a QR code for the app to scan.',
    example: 'otpauth://totp/Stoclify:kupuvach@example.com?secret=…',
  })
  otpauthUrl!: string;

  @ApiProperty({
    description: 'The same URI as a scannable SVG, inlined as a data URI.',
    example: 'data:image/svg+xml;base64,PHN2Zy…',
  })
  qrSvg!: string;

  @ApiProperty({
    description: 'Eight single-use codes for when the phone is lost. Shown once.',
    type: [String],
  })
  recoveryCodes!: string[];
}

/**
 * One signed-in device.
 *
 * Deliberately carries no token and no digest. This exists so somebody can
 * recognise a device and end it, not so anything here could sign them in.
 */
export class SessionSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({
    description: 'What the browser called itself. Enough to tell a phone from a laptop.',
    nullable: true,
    example: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)…',
  })
  userAgent!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastUsedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({
    description: 'True for the session making this request, so an interface can protect it.',
    example: true,
  })
  current!: boolean;
}
