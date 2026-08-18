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
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { RankedHitDto } from './discovery.dto';

export class BasketLineInputDto {
  @ApiProperty({
    description: 'One line of the order, as the buyer would write it on a list.',
    example: 'КАБЕЛ СВТ 3x2.5',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : (value as unknown)))
  query!: string;

  @ApiPropertyOptional({ description: 'How many. Multiplies the line.', default: 1, example: 100 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  @IsOptional()
  quantity?: number;
}

export class PriceBasketDto {
  @ApiProperty({
    description:
      'The order, line by line. Capped at 60: every line is a real question put to every supplier, and a list longer than this is an import rather than an order.',
    type: BasketLineInputDto,
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => BasketLineInputDto)
  lines!: BasketLineInputDto[];

  @ApiPropertyOptional({ description: 'Currency to total in.', default: 'EUR' })
  @IsString()
  @Length(3, 3)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : (value as unknown),
  )
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({
    description:
      'False asks every supplier again rather than reusing a recent answer. Slow — use it when the order is about to be placed and the figures must be current.',
    default: true,
  })
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : (value as unknown),
  )
  @IsBoolean()
  @IsOptional()
  useCache?: boolean;
}

export class BasketLineDto {
  @ApiProperty({ example: 'КАБЕЛ СВТ 3x2.5' }) query!: string;

  @ApiProperty({ example: 100 }) quantity!: number;

  @ApiProperty({
    description: "Each supplier's cheapest match for this line, cheapest first.",
    type: RankedHitDto,
    isArray: true,
  })
  offers!: RankedHitDto[];

  @ApiPropertyOptional({
    description: 'The cheapest of them, or null when nobody had it.',
    type: RankedHitDto,
    nullable: true,
  })
  cheapest!: RankedHitDto | null;
}

export class BasketSupplierDto {
  @ApiProperty({ format: 'uuid' }) shopId!: string;
  @ApiProperty({ example: 'ТМТ ЕЛКОМ' }) name!: string;
  @ApiProperty({ example: 'tmt-elkom.com' }) host!: string;

  @ApiProperty({ description: 'Lines this supplier can fill.', example: 8 }) linesCovered!: number;
  @ApiProperty({ description: 'Lines on the order.', example: 10 }) linesTotal!: number;

  @ApiPropertyOptional({
    description: 'What the order costs here, for the lines they carry, after your discount.',
    type: Number,
    nullable: true,
    example: 412.6,
  })
  total!: number | null;

  @ApiProperty({
    description:
      'Lines this supplier does not have. Shown rather than hidden: "cheapest, but missing three items" is a real answer, and concealing it recommends an order that cannot be placed.',
    type: String,
    isArray: true,
  })
  missing!: string[];
}

export class BasketSplitDto {
  @ApiPropertyOptional({ type: Number, nullable: true, example: 388.15 }) total!: number | null;
  @ApiProperty({ example: 10 }) linesPriced!: number;

  @ApiProperty({
    description: 'Who you would be ordering from.',
    type: String,
    isArray: true,
    example: ['Местен склад', 'ТМТ ЕЛКОМ'],
  })
  suppliers!: string[];
}

export class BasketResultDto {
  @ApiProperty({ example: 'EUR' }) currency!: string;
  @ApiProperty({ example: 2400 }) durationMs!: number;

  @ApiProperty({ type: BasketLineDto, isArray: true }) lines!: BasketLineDto[];

  @ApiProperty({
    description:
      'What the whole order costs from each supplier alone — complete orders first, then by price.',
    type: BasketSupplierDto,
    isArray: true,
  })
  suppliers!: BasketSupplierDto[];

  @ApiProperty({
    description: 'What it costs taking every line from whoever is cheapest on it.',
    type: BasketSplitDto,
  })
  split!: BasketSplitDto;

  @ApiPropertyOptional({
    description:
      'What splitting the order saves against the cheapest supplier who could fill all of it. Null when no single supplier can — comparing a split against a partial order compares two different purchases.',
    type: Number,
    nullable: true,
    example: 24.45,
  })
  saving!: number | null;
}
