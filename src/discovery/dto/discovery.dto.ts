import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class DiscoveredProductDto {
  @ApiProperty({ description: 'Product title as the shop lists it.' })
  title!: string;

  @ApiProperty({ description: 'Absolute product page URL — ready to track.', format: 'uri' })
  url!: string;

  @ApiPropertyOptional({
    description: 'Price read from the search tile, when the shop shows one.',
    type: Number,
    nullable: true,
  })
  price!: number | null;

  @ApiPropertyOptional({ nullable: true, example: 'EUR' })
  currency!: string | null;

  @ApiProperty({ example: 'emag.bg' })
  host!: string;

  @ApiProperty({ example: 'eMAG' })
  shopName!: string;
}

export class ShopSearchResultDto {
  @ApiProperty({ example: 'emag.bg' })
  host!: string;

  @ApiProperty({ example: 'eMAG' })
  name!: string;

  @ApiProperty({ description: 'The search URL that was fetched.', format: 'uri' })
  searchUrl!: string;

  @ApiProperty({ description: 'Whether this shop could be searched.', example: true })
  ok!: boolean;

  @ApiPropertyOptional({
    description: 'Why the shop could not be searched.',
    nullable: true,
    example: null,
  })
  error!: string | null;

  @ApiProperty({ example: 412 })
  durationMs!: number;

  @ApiProperty({ type: DiscoveredProductDto, isArray: true })
  products!: DiscoveredProductDto[];
}

export class SearchQueryDto {
  @ApiProperty({
    description: 'What to look for. A model number finds far more than a description.',
    minLength: 2,
    maxLength: 120,
    example: 'iPhone 17 Pro 256GB',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : (value as unknown)))
  q!: string;

  @ApiPropertyOptional({
    description: 'Restrict the search to these shop hosts. Omit to search all of them.',
    type: [String],
    example: ['emag.bg'],
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map((host) => host.trim()) : (value as unknown),
  )
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  hosts?: string[];
}
