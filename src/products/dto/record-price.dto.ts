import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Manually submitted price observation (integrations, CSV imports, QA). */
export class RecordPriceDto {
  @ApiProperty({
    description: 'Observed competitor price.',
    type: Number,
    minimum: 0,
    example: 289.99,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999)
  price!: number;

  @ApiPropertyOptional({
    description: 'Origin of the observation. Defaults to "manual".',
    maxLength: 255,
    example: 'manual',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  source?: string;
}
