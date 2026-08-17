import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Every numeric query parameter declares `type: Number` explicitly.
 *
 * Without it the Swagger plugin cannot reflect the type through
 * `@Type(() => Number)` and emits `$ref: '#/components/schemas/Object'` — a
 * schema that does not exist. Swagger UI fails to resolve the reference and
 * silently refuses to send the request, with no error anywhere.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Maximum number of items to return.',
    type: Number,
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 20;

  @ApiPropertyOptional({
    description: 'Number of items to skip before collecting the page.',
    type: Number,
    minimum: 0,
    default: 0,
    example: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset = 0;
}
