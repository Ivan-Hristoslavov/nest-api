import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDate, IsEnum, IsOptional, IsUUID } from 'class-validator';

import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { toOptionalBoolean } from '../../common/transformers/dto-transformers';
import { AlertSeverity, AlertType } from '../enums/alert.enums';

export class QueryAlertsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Only alerts for this product.', format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  productId?: string;

  @ApiPropertyOptional({ enum: AlertType, enumName: 'AlertType' })
  @IsEnum(AlertType)
  @IsOptional()
  type?: AlertType;

  @ApiPropertyOptional({ enum: AlertSeverity, enumName: 'AlertSeverity' })
  @IsEnum(AlertSeverity)
  @IsOptional()
  severity?: AlertSeverity;

  @ApiPropertyOptional({
    description: 'Only alerts nobody has acknowledged yet.',
    example: true,
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  unacknowledgedOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Only alerts raised at or after this instant (ISO-8601).',
    type: String,
    format: 'date-time',
    example: '2026-08-01T00:00:00.000Z',
  })
  @Type(() => Date)
  @IsDate()
  @IsOptional()
  since?: Date;
}
