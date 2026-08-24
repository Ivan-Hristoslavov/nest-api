import { IsPublicHttpUrl } from '../../common/validators/public-url.validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
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

  @ApiPropertyOptional({
    description: 'Brand as printed on the box.',
    maxLength: 120,
    example: 'Samsung',
  })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  @Transform(trimString)
  brand?: string;

  @ApiPropertyOptional({
    description: 'Legal manufacturer or importer, when it differs from the brand.',
    maxLength: 160,
    example: 'Samsung Electronics Co., Ltd.',
  })
  @IsString()
  @MaxLength(160)
  @IsOptional()
  @Transform(trimString)
  manufacturer?: string;

  @ApiPropertyOptional({
    description: "Manufacturer's model designation.",
    maxLength: 120,
    example: 'QE55Q7F2AUXXH',
  })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  @Transform(trimString)
  model?: string;

  @ApiPropertyOptional({
    description: 'Catalogue category.',
    maxLength: 120,
    example: 'Телевизори',
  })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  @Transform(trimString)
  category?: string;

  @ApiPropertyOptional({
    description: 'EAN-13 / UPC / GTIN-14 barcode — 8 to 14 digits.',
    example: '8806095507415',
  })
  @IsString()
  @Matches(/^\d{8,14}$/, { message: 'gtin must be 8 to 14 digits' })
  @IsOptional()
  @Transform(trimString)
  gtin?: string;

  @ApiPropertyOptional({ description: 'Product image.', format: 'uri' })
  @IsUrl(URL_OPTIONS)
  @IsPublicHttpUrl()
  @MaxLength(2048)
  @IsOptional()
  imageUrl?: string;

  @ApiPropertyOptional({
    description: 'Specification sheet as flat key/value pairs.',
    example: { Диагонал: '55"', Панел: 'QLED' },
  })
  @IsObject()
  @IsOptional()
  attributes?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Free-text internal note.', maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  @Transform(trimString)
  notes?: string;

  @ApiProperty({
    description: 'Our own product page — the listing whose price we defend.',
    format: 'uri',
    example: 'https://shop.example.com/products/sony-wh-1000xm5',
  })
  @IsUrl(URL_OPTIONS)
  @IsPublicHttpUrl()
  @MaxLength(2048)
  targetUrl!: string;

  @ApiProperty({
    description: 'Competitor product page the scraper will fetch.',
    format: 'uri',
    example: 'https://competitor.example.com/audio/sony-wh-1000xm5',
  })
  @IsUrl(URL_OPTIONS)
  @IsPublicHttpUrl()
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
    description: 'Name for the primary competitor listing. Defaults to its hostname.',
    maxLength: 120,
    example: 'Competitor A',
  })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  @Transform(trimString)
  competitorName?: string;

  @ApiPropertyOptional({
    description:
      'CSS selector for the price on the primary competitor page. Only needed when the page exposes no structured data.',
    maxLength: 255,
    example: '.product-price__amount',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  priceSelector?: string;

  @ApiPropertyOptional({
    description: 'What you pay for this today, after your discount.',
    type: Number,
    minimum: 0,
    example: 299.0,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999)
  @IsOptional()
  ourPrice?: number;

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
