import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

import { toOptionalBoolean } from '../transformers/dto-transformers';

/**
 * The second half of a destructive delete.
 *
 * Deleting a product or a supplier takes its recorded history with it — months
 * of prices that cannot be fetched again, because the pages that showed them
 * have moved on. The dashboard asks "are you sure"; a script does not, and the
 * API is the thing a script calls.
 *
 * So a delete that would destroy history is refused until the caller says so
 * in the request. Anything with nothing to lose deletes without ceremony: a
 * confirmation everybody has to click for every case is one nobody reads.
 */
export class PurgeQueryDto {
  @ApiPropertyOptional({
    description:
      'Required when the target has recorded price history. Without it such a delete is refused with 409 and a count of what would have been destroyed.',
    default: false,
    example: true,
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  purge?: boolean = false;
}
