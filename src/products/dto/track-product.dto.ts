import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

import { IsPublicHttpUrl } from '../../common/validators/public-url.validator';

/**
 * One shop the buyer chose to watch, as the discovery screen offered it.
 *
 * The price and title come along because they are already known — the search
 * read them moments ago — and seeding them means the product list has real
 * numbers in it before the first scrape rather than a row of dashes. The
 * scraper overwrites them on its first pass either way.
 */
export class TrackedStoreDto {
  @ApiProperty({ example: 'https://kris06.bg/product/42226/polirmashina.html' })
  @IsPublicHttpUrl()
  url!: string;

  @ApiProperty({ description: 'Shop name, as it should appear in the list.', example: 'kris06.bg' })
  @IsString()
  @Length(1, 160)
  name!: string;

  @ApiPropertyOptional({ description: 'The price the search found, if it found one.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({ default: 'EUR' })
  @IsString()
  @Length(3, 3)
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ description: 'Whether the shop said it had this.' })
  @Transform(({ value }) => (value === undefined || value === null ? undefined : Boolean(value)))
  @IsBoolean()
  @IsOptional()
  inStock?: boolean;
}

/**
 * A product to watch, and the shops to watch it at.
 *
 * One request rather than the several the browser used to make. Creating the
 * product and then adding each shop separately meant a half-created product
 * whenever one of the calls failed — a row in the list watching two of the five
 * shops the buyer picked, with nothing saying so. Here either all of it exists
 * or none of it does.
 *
 * The identifying fields are optional because the discovery flow fills them in
 * from what it read, and the reader corrects them rather than supplying them.
 */
export class TrackProductDto {
  @ApiProperty({ description: 'What to call this product.', example: 'Bosch GSR 18V-55' })
  @IsString()
  @Length(2, 255)
  name!: string;

  @ApiPropertyOptional({ description: 'Your own article number.' })
  @IsString()
  @Length(1, 64)
  @IsOptional()
  sku?: string;

  @ApiPropertyOptional({ example: 'Bosch' })
  @IsString()
  @Length(1, 120)
  @IsOptional()
  brand?: string;

  @ApiPropertyOptional({ example: 'GSR 18V-55' })
  @IsString()
  @Length(1, 120)
  @IsOptional()
  model?: string;

  @ApiPropertyOptional()
  @IsString()
  @Length(1, 160)
  @IsOptional()
  manufacturer?: string;

  @ApiPropertyOptional()
  @IsString()
  @Length(1, 120)
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ description: 'Barcode, where one was found. Never guessed.' })
  @IsString()
  @Length(8, 14)
  @IsOptional()
  gtin?: string;

  @ApiPropertyOptional({ description: 'What you pay for this today.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  ourPrice?: number;

  @ApiPropertyOptional({ description: 'Tell me when it drops below this.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  targetPrice?: number;

  @ApiPropertyOptional({ default: 'EUR' })
  @IsString()
  @Length(3, 3)
  @IsOptional()
  currency?: string;

  /**
   * The shops to watch, in the order the reader confirmed them.
   *
   * At least one: a product watched nowhere is a row that can never change,
   * and creating it silently would look like the monitoring had started.
   */
  @ApiProperty({ type: [TrackedStoreDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => TrackedStoreDto)
  stores!: TrackedStoreDto[];
}
