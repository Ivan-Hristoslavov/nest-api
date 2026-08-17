import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  toOptionalBoolean,
  trimString,
  upperCase,
} from '../../common/transformers/dto-transformers';
import { ScrapeStatus } from '../enums/scrape-status.enum';

export enum ProductSortField {
  Name = 'name',
  CurrentPrice = 'currentPrice',
  LastUpdated = 'lastUpdated',
  LastCheckedAt = 'lastCheckedAt',
  CreatedAt = 'createdAt',
}

export enum SortDirection {
  Asc = 'ASC',
  Desc = 'DESC',
}

export class QueryProductsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive partial match on name, SKU or competitor URL.',
    maxLength: 255,
    example: 'headphones',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by tracking state.',
    example: true,
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by the outcome of the last scrape attempt.',
    enum: ScrapeStatus,
    enumName: 'ScrapeStatus',
  })
  @IsEnum(ScrapeStatus)
  @IsOptional()
  scrapeStatus?: ScrapeStatus;

  @ApiPropertyOptional({
    description: 'Only products whose current price is at least this value.',
    type: Number,
    example: 100,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  minPrice?: number;

  @ApiPropertyOptional({
    description: 'Only products whose current price is at most this value.',
    type: Number,
    example: 500,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  maxPrice?: number;

  @ApiPropertyOptional({
    description: 'Only products priced below their configured target price.',
    example: true,
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  undercutOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Embed the competitor listings of each product in the response.',
    example: false,
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  includeCompetitors?: boolean;

  @ApiPropertyOptional({
    description: 'Field to sort by.',
    enum: ProductSortField,
    enumName: 'ProductSortField',
    default: ProductSortField.CreatedAt,
  })
  @IsEnum(ProductSortField)
  @IsOptional()
  sortBy: ProductSortField = ProductSortField.CreatedAt;

  @ApiPropertyOptional({
    description: 'Sort direction.',
    enum: SortDirection,
    enumName: 'SortDirection',
    default: SortDirection.Desc,
  })
  @Transform(upperCase)
  @IsEnum(SortDirection)
  @IsOptional()
  sortOrder: SortDirection = SortDirection.Desc;
}
