import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { trimString, trimUpperCase } from '../../common/transformers/dto-transformers';

/** URLs must be absolute http(s) — the scraper cannot fetch anything else. */
const URL_OPTIONS = { protocols: ['http', 'https'], require_protocol: true, require_tld: true };

export class CreateProductDto {
  @ApiProperty({
    description: 'Human readable product name.',
    minLength: 2,
    maxLength: 255,
    example: 'Sony WH-1000XM5 Wireless Headphones',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trimString)
  name!: string;

  @ApiPropertyOptional({
    description: 'Internal stock keeping unit. Must be unique across products.',
    maxLength: 64,
    example: 'SKU-WH1000XM5-BLK',
  })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  @Transform(trimString)
  sku?: string;

  @ApiProperty({
    description: 'Our own product page — the listing whose price we defend.',
    format: 'uri',
    example: 'https://shop.example.com/products/sony-wh-1000xm5',
  })
  @IsUrl(URL_OPTIONS)
  @MaxLength(2048)
  targetUrl!: string;

  @ApiProperty({
    description: 'Competitor product page the scraper will fetch.',
    format: 'uri',
    example: 'https://competitor.example.com/audio/sony-wh-1000xm5',
  })
  @IsUrl(URL_OPTIONS)
  @MaxLength(2048)
  competitorUrl!: string;

  @ApiPropertyOptional({
    description: 'ISO-4217 currency code (three uppercase letters).',
    default: 'EUR',
    example: 'EUR',
  })
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be three uppercase letters, e.g. EUR' })
  @Transform(trimUpperCase)
  @IsOptional()
  currency?: string = 'EUR';

  @ApiPropertyOptional({
    description: 'Known competitor price at creation time. Overwritten by the first scrape.',
    type: Number,
    minimum: 0,
    example: 309.0,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999)
  @IsOptional()
  currentPrice?: number;

  @ApiPropertyOptional({
    description: 'Price floor. Competitor prices below this value are flagged as undercutting.',
    type: Number,
    minimum: 0,
    example: 279.0,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999)
  @IsOptional()
  targetPrice?: number;

  @ApiPropertyOptional({
    description: 'Whether the scheduled sweep should include this product.',
    default: true,
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean = true;

  @ApiPropertyOptional({
    description: 'Minimum minutes between two scrapes of this product.',
    minimum: 5,
    maximum: 10080,
    default: 60,
    example: 60,
  })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(10_080)
  @IsOptional()
  checkIntervalMinutes?: number = 60;
}
