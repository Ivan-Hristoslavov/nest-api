import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { OutreachStatus } from '../entities/api-outreach.entity';
import { OUTREACH_LOCALES, OutreachLocale } from '../outreach-templates';

export class PreviewOutreachDto {
  @ApiProperty({ example: 'partner.example.com' })
  @IsString()
  @MaxLength(255)
  host!: string;

  @ApiPropertyOptional({
    enum: OUTREACH_LOCALES,
    description: 'Overrides the language guessed from the domain.',
  })
  @IsOptional()
  @IsIn(OUTREACH_LOCALES)
  locale?: OutreachLocale;
}

export class OutreachDraftDto {
  @ApiProperty({ example: 'bg' })
  locale!: OutreachLocale;

  @ApiProperty({
    description: 'Why this language was chosen.',
    example: 'домейнът завършва на .bg',
  })
  localeReason!: string;

  @ApiProperty() subject!: string;
  @ApiProperty() body!: string;

  @ApiProperty({ example: 2, description: 'Customers already tracking this site.' })
  buyers!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'An address a customer entered for sending orders to this supplier. Offered as a hint only — it was given to us for placing orders, not for our own correspondence, so it is never filled in automatically.',
  })
  knownOrderEmail!: string | null;
}

export class SendOutreachDto {
  @ApiProperty({ example: 'partner.example.com' })
  @IsString()
  @MaxLength(255)
  host!: string;

  @ApiProperty({ example: 'office@partner.example.com' })
  @IsEmail()
  @MaxLength(320)
  recipient!: string;

  @ApiProperty({ enum: OUTREACH_LOCALES })
  @IsIn(OUTREACH_LOCALES)
  locale!: OutreachLocale;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(300)
  subject!: string;

  @ApiProperty()
  @IsString()
  @MinLength(40)
  @MaxLength(20000)
  body!: string;
}

export class UpdateOutreachDto {
  @ApiProperty({ enum: OutreachStatus })
  @IsEnum(OutreachStatus)
  status!: OutreachStatus;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
