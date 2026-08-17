import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { trimString } from '../../common/transformers/dto-transformers';

/** One product and every shop that sells it, in a single row. */
export class BulkProductDto {
  @ApiProperty({ example: 'Смартфон Apple iPhone 17 Pro 256GB' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  @Transform(trimString)
  name!: string;

  @ApiPropertyOptional({ example: 'PHONE-IP17P-256' })
  @IsString()
  @MaxLength(64)
  @IsOptional()
  @Transform(trimString)
  sku?: string;

  @ApiProperty({
    description: 'Product page URLs, one per shop. The first becomes the primary listing.',
    type: [String],
    example: ['https://www.emag.bg/…/pd/XXXX/', 'https://istyle.bg/products/…'],
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  urls!: string[];

  @ApiPropertyOptional({ example: 'EUR' })
  @IsString()
  @MaxLength(3)
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ description: 'Our selling price.', type: Number })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  ourPrice?: number;

  @ApiPropertyOptional({ description: 'Alert threshold.', type: Number })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  targetPrice?: number;
}

export class BulkImportDto {
  @ApiProperty({
    description: 'Up to 500 products in one request.',
    type: BulkProductDto,
    isArray: true,
  })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkProductDto)
  products!: BulkProductDto[];

  @ApiPropertyOptional({
    description:
      'Update products whose SKU already exists instead of reporting them as duplicates.',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  updateExisting?: boolean = true;

  @ApiPropertyOptional({
    description:
      'Validate everything and report what would happen, without writing. Run this first on a large file.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  dryRun?: boolean = false;
}

export class BulkRowResultDto {
  @ApiProperty({ description: '1-based row number, matching the source file.', example: 42 })
  row!: number;

  @ApiProperty({ example: 'Смартфон Apple iPhone 17 Pro 256GB' })
  name!: string;

  @ApiProperty({
    enum: ['created', 'updated', 'skipped', 'failed'],
    example: 'created',
  })
  status!: 'created' | 'updated' | 'skipped' | 'failed';

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  productId!: string | null;

  @ApiProperty({ description: 'Shops attached to this product.', example: 3 })
  listingsAdded!: number;

  @ApiPropertyOptional({ nullable: true, example: null })
  message!: string | null;
}

export class BulkImportResultDto {
  @ApiProperty({ example: 500 })
  received!: number;

  @ApiProperty({ example: 480 })
  created!: number;

  @ApiProperty({ example: 15 })
  updated!: number;

  @ApiProperty({ example: 3 })
  skipped!: number;

  @ApiProperty({ example: 2 })
  failed!: number;

  @ApiProperty({ description: 'Shop listings attached in total.', example: 1240 })
  listingsAdded!: number;

  @ApiProperty({ description: 'Whether anything was actually written.', example: false })
  dryRun!: boolean;

  @ApiProperty({ example: 8241 })
  durationMs!: number;

  @ApiProperty({ type: BulkRowResultDto, isArray: true })
  rows!: BulkRowResultDto[];
}
