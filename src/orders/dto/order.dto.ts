import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

import { OrderStatus } from '../entities/order.entity';

export class OrderLineInputDto {
  @ApiProperty({ description: 'What you are asking for.', example: 'КАБЕЛ СВТ 3x2.5' })
  @IsString()
  @Length(1, 500)
  query!: string;

  @ApiPropertyOptional({
    description: "The supplier's own name for it, when the comparison found one.",
    nullable: true,
  })
  @IsString()
  @IsOptional()
  @Length(0, 500)
  matchedName?: string;

  @ApiPropertyOptional({ description: 'The page the price came from.', nullable: true })
  @IsString()
  @IsOptional()
  @Length(0, 2000)
  url?: string;

  @ApiProperty({ example: 100 })
  @IsNumber()
  @IsPositive()
  quantity!: number;

  @ApiProperty({ description: 'Per unit, after your discount.', example: 4.12 })
  @IsNumber()
  @Min(0)
  unitPrice!: number;
}

export class CreateOrderDto {
  @ApiProperty({ format: 'uuid', description: 'Which of your suppliers this goes to.' })
  @IsUUID()
  shopId!: string;

  @ApiPropertyOptional({ description: 'Anything the supplier should read.', nullable: true })
  @IsString()
  @IsOptional()
  @Length(0, 2000)
  note?: string;

  @ApiPropertyOptional({ example: 'EUR' })
  @IsString()
  @IsOptional()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({
    description:
      'The purchase decision this order carries out, when it came from a saved plan.\n\nLinking it is what later lets the saving be reported as *realized* rather than *potential*: once every supplier in the plan has an order here and each is marked confirmed, the decision stops claiming a forecast and starts reporting what was actually spent.',
    format: 'uuid',
  })
  @IsUUID('4')
  @IsOptional()
  purchaseDecisionId?: string;

  @ApiProperty({ type: OrderLineInputDto, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  // Bounded because this becomes an email somebody has to read. An order of
  // two hundred lines is a spreadsheet, and belongs in one.
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  lines!: OrderLineInputDto[];
}

export class UpdateOrderStatusDto {
  @ApiProperty({
    enum: [OrderStatus.Confirmed, OrderStatus.Cancelled],
    description:
      'Only the two states this system cannot know for itself. Draft and sent are set by what actually happened.',
  })
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}
