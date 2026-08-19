import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
  @ApiProperty({
    description:
      'Send as `Authorization: Bearer <token>`. This is a browser credential — the API key stays for scripts and is not returned here, because it cannot be read back.',
    example: 'pg_sess_9fK…',
  })
  token!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ example: 'kupuvach@moiat-magazin.bg' })
  email!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Електро Иванов ЕООД' })
  name!: string | null;

  @ApiProperty({ example: 'pro' })
  plan!: string;

  @ApiPropertyOptional({
    description:
      'The API key, present only when this exchange opened a new account. Shown once — afterwards only its digest exists.',
    nullable: true,
    example: 'pk_live_7Qw…',
  })
  apiKey!: string | null;
}
