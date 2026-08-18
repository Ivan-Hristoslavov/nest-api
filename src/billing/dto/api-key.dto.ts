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
