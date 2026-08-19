import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { trimString } from '../../common/transformers/dto-transformers';

export class RotateApiKeyDto {
  @ApiProperty({
    description: 'Account whose key should be replaced. Matched case-insensitively.',
    format: 'email',
    example: 'kupuvach@moiat-magazin.bg',
  })
  @IsEmail()
  @MaxLength(255)
  @Transform(trimString)
  email!: string;

  @ApiPropertyOptional({
    description: 'Key environment. `test` keys are visibly distinct in logs and support tickets.',
    enum: ['live', 'test'],
    default: 'live',
  })
  @IsString()
  @IsIn(['live', 'test'])
  @IsOptional()
  environment?: 'live' | 'test' = 'live';
}

/**
 * The one and only time the plaintext key is ever returned.
 *
 * Only the SHA-256 digest is stored, so this response cannot be reproduced —
 * a lost key is replaced, never recovered.
 */
export class IssuedApiKeyDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'kupuvach@moiat-magazin.bg' })
  email!: string;

  @ApiProperty({
    description: 'Show this once, then let it disappear. It cannot be retrieved again.',
    example: 'pk_live_7Qw…',
  })
  apiKey!: string;

  @ApiProperty({
    description: 'Leading characters, safe to keep for identification.',
    example: 'pk_live_7Qw2Xn',
  })
  prefix!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  issuedAt!: string;

  @ApiProperty({
    description: 'Whether a previous key was destroyed by this call.',
    example: true,
  })
  replacedPreviousKey!: boolean;

  @ApiProperty({
    description:
      'Whether the key was emailed to the customer. False means it exists only in this response — deliver it by hand, because it cannot be read back.',
    example: true,
  })
  emailed!: boolean;
}

/** The caller's own account, for a customer holding a working key. */
export class MyAccountDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'kupuvach@moiat-magazin.bg' })
  email!: string;

  @ApiPropertyOptional({ nullable: true })
  name!: string | null;

  @ApiProperty({ example: 'active' })
  status!: string;

  @ApiProperty({ example: 'starter' })
  plan!: string;

  @ApiProperty({ description: 'How many products this plan may track.', example: 50 })
  productLimit!: number;

  @ApiPropertyOptional({
    description: 'Identifying prefix of the key in use. The rest is never stored.',
    nullable: true,
    example: 'pk_live_7Qw2Xn',
  })
  apiKeyPrefix!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  apiKeyIssuedAt!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  accessExpiresAt!: string | null;
}

export class StartCheckoutDto {
  @ApiProperty({
    description: 'Which plan to buy. `free` is not purchasable.',
    enum: ['starter', 'pro', 'business'],
    example: 'pro',
  })
  @IsIn(['starter', 'pro', 'business'])
  plan!: string;

  @ApiPropertyOptional({
    description:
      'Prefills the buyer’s email at checkout. Stripe collects it when omitted; either way it is what the account is keyed on, so a typo here creates an account under the wrong address.',
    format: 'email',
    example: 'buyer@example.com',
  })
  @IsEmail()
  @IsOptional()
  email?: string;
}

/** What a visitor supplies to open a free account. No password: the key is the credential. */
export class SignupDto {
  @ApiProperty({
    description: 'Where the key is sent, and the address the account is keyed on for ever after.',
    format: 'email',
    example: 'kupuvach@moiat-magazin.bg',
  })
  @IsEmail()
  @MaxLength(255)
  @Transform(trimString)
  email!: string;

  @ApiPropertyOptional({
    description: 'Company or person, for the operator’s customer list.',
    example: 'Електро Иванов ЕООД',
    maxLength: 160,
  })
  @IsString()
  @IsOptional()
  @MaxLength(160)
  @Transform(trimString)
  name?: string;
}

/**
 * The result of opening a free account.
 *
 * The key is in the body as well as in the email on purpose: the person is
 * looking at the page right now, and an onboarding that depends on an inbox
 * loses everyone whose mail is slow, filtered, or mistyped.
 */
export class FreeAccountDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'kupuvach@moiat-magazin.bg' })
  email!: string;

  @ApiProperty({
    description: 'Shown once. Only a hash is stored, so it cannot be read back.',
    example: 'pk_live_7Qw…',
  })
  apiKey!: string;

  @ApiProperty({ example: 'pk_live_7Qw2Xn' })
  prefix!: string;

  @ApiProperty({ example: 'free' })
  plan!: string;

  @ApiProperty({ description: 'Products the free plan may track.', example: 10 })
  productLimit!: number;

  @ApiProperty({
    description: 'Whether a copy also went out by email. False when SMTP is not configured.',
    example: true,
  })
  emailed!: boolean;
}

/** Confirmation for an irreversible account erasure. */
export class EraseAccountDto {
  @ApiProperty({
    description:
      'The account’s own email, repeated. A mismatch refuses the request — there is no undo and uuids look alike in a support ticket.',
    format: 'email',
    example: 'kupuvach@moiat-magazin.bg',
  })
  @IsEmail()
  @MaxLength(255)
  @Transform(trimString)
  confirmEmail!: string;
}
