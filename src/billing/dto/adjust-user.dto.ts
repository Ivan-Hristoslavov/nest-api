import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

import { UserPlan, UserStatus } from '../entities/user.entity';

/**
 * What an operator may change about an account by hand.
 *
 * Everything here is normally decided by a payment. This exists for when a
 * payment is not going to decide it: a bank transfer, a lapse worth
 * overlooking, a week of extra headroom for somebody who asked nicely.
 *
 * Every field is optional and only what is sent is touched, so raising a
 * limit does not silently reset a status somebody set five minutes ago.
 */
export class AdjustUserDto {
  @ApiPropertyOptional({ enum: UserStatus, enumName: 'UserStatus' })
  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;

  @ApiPropertyOptional({ enum: UserPlan, enumName: 'UserPlan' })
  @IsEnum(UserPlan)
  @IsOptional()
  plan?: UserPlan;

  @ApiPropertyOptional({
    description:
      'Tracked articles allowed. Separate from the plan on purpose: a month of extra headroom is not a move onto a tier nobody is paying for.',
    minimum: 0,
    maximum: 100000,
    example: 250,
  })
  @Transform(({ value }) => (value === undefined || value === null ? value : Number(value)))
  @IsInt()
  @Min(0)
  @Max(100_000)
  @IsOptional()
  productLimit?: number;
}
