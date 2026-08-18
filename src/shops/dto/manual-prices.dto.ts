import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ManualPriceDto {
  @ApiProperty({
    description: 'The article, as this supplier calls it on their list.',
    example: 'КАБЕЛ СВТ 3x2.5',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  @Transform(trim)
  name!: string;

  @ApiProperty({
    description: 'Price as quoted, before your discount. The comparison applies the discount.',
    example: 1.42,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @ApiPropertyOptional({ description: "The supplier's article number.", example: 'SVT-3X25' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  @Transform(trim)
  shopCode?: string;

  @ApiPropertyOptional({ example: 'EUR', default: 'EUR' })
  @IsString()
  @Length(3, 3)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : (value as unknown),
  )
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ description: 'Per metre, per piece, per roll.', example: 'м' })
  @IsString()
  @MaxLength(32)
  @IsOptional()
  @Transform(trim)
  unit?: string;

  @ApiPropertyOptional({
    description: 'Where the figure came from — an emailed list, a phone call.',
    example: 'ценоразпис по имейл, 12.08',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trim)
  note?: string;
}

export class ImportManualPricesDto {
  @ApiProperty({
    description:
      "A whole price list. Re-importing updates the rows already held rather than doubling them, keyed on the supplier's article number where there is one and on the name otherwise.",
    type: ManualPriceDto,
    isArray: true,
  })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => ManualPriceDto)
  prices!: ManualPriceDto[];
}

export class ImportResultDto {
  @ApiProperty({ description: 'Rows that were new.', example: 380 }) imported!: number;
  @ApiProperty({ description: 'Rows that replaced an existing figure.', example: 42 })
  updated!: number;
  @ApiProperty({ example: 0 }) failed!: number;
  @ApiProperty({
    type: String,
    isArray: true,
    description: 'The first few failures, with the row number.',
  })
  problems!: string[];
}
