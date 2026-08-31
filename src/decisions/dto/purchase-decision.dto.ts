import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { PurchaseDecision } from '../entities/purchase-decision.entity';
import { PurchaseDecisionSnapshot } from '../purchase-decision.snapshot';

/**
 * Keeping the plan the buyer just looked at.
 *
 * The body is the `decision` object handed back by `POST /discovery/basket`,
 * returned unchanged. It is not validated field by field on purpose: the
 * signature already proves this server produced every figure in it, and a
 * second, weaker check written by hand would only be a way for the two to
 * disagree.
 */
export class CreatePurchaseDecisionDto {
  @ApiProperty({
    description:
      'The `decision` object from the basket response, passed back exactly as it was received — snapshot and signature together. Do not edit it: the signature is over the snapshot, and an altered figure is refused rather than stored.',
  })
  @IsObject()
  @IsNotEmptyObject()
  snapshot!: PurchaseDecisionSnapshot;

  @ApiProperty({
    description: 'The signature from the same `decision` object.',
    example: '4f1c…',
  })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'The signature is not one this server issued.' })
  signature!: string;
}

export class ListPurchaseDecisionsDto {
  @ApiPropertyOptional({ description: 'Page size.', default: 25, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Rows to skip.', default: 0, minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset?: number;

  @ApiPropertyOptional({ description: 'Decisions from this moment on.', example: '2026-08-01' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ description: 'Decisions up to this moment.', example: '2026-08-31' })
  @IsDateString()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({
    description: 'Only decisions this supplier took part in — chosen, beaten or refused.',
    format: 'uuid',
  })
  @IsUUID('4')
  @IsOptional()
  shopId?: string;

  @ApiPropertyOptional({ enum: ['date', 'savings'], default: 'date' })
  @IsIn(['date', 'savings'])
  @IsOptional()
  sort?: 'date' | 'savings';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : (value as unknown)))
  @IsIn(['asc', 'desc'])
  @IsOptional()
  order?: 'asc' | 'desc';
}

export class DecisionPageDto {
  @ApiProperty({ type: PurchaseDecision, isArray: true }) items!: PurchaseDecision[];
  @ApiProperty({ example: 42 }) total!: number;
  @ApiProperty({ example: 25 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}

class SavingsWindowDto {
  @ApiProperty({
    description: 'What the optimiser says was avoidable, on decisions not yet confirmed as bought.',
    example: 386,
  })
  potential!: number;

  @ApiProperty({
    description: 'What was saved on purchases the buyer confirmed happened.',
    example: 214,
  })
  realized!: number;

  @ApiProperty({ example: 9 }) decisions!: number;
}

export class SavingsSummaryDto {
  @ApiProperty({ example: 'EUR' }) currency!: string;

  @ApiProperty({ type: SavingsWindowDto }) month!: SavingsWindowDto;
  @ApiProperty({ type: SavingsWindowDto }) year!: SavingsWindowDto;
  @ApiProperty({ type: SavingsWindowDto }) allTime!: SavingsWindowDto;

  @ApiPropertyOptional({
    description: 'Across decisions that had a single-supplier baseline to measure against.',
    type: Number,
    nullable: true,
    example: 12.7,
  })
  averageSavingsPercent!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 18.4 })
  averageBasketLines!: number | null;

  @ApiProperty({ example: 6 }) splitDecisions!: number;
  @ApiProperty({ example: 3 }) singleSupplierDecisions!: number;
}
