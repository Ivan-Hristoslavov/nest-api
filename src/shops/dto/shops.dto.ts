import { IsPublicHttpUrlTemplate } from '../../common/validators/public-url.validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimUpperCase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const toOptionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/** The search wiring, shared by create and update. */
class SearchConfigDto {
  @ApiPropertyOptional({
    description:
      'Search URL with `{q}` where the query goes. Setting this makes the shop live-searchable immediately — no code change, no deploy.',
    example: 'https://ardes.bg/search?q={q}',
  })
  @IsString()
  @MaxLength(2048)
  @Matches(/\{q\}/, { message: 'searchUrlTemplate must contain {q}' })
  // Was a bare string: any scheme, any host, including this server's own.
  @IsPublicHttpUrlTemplate()
  @IsOptional()
  @Transform(trimString)
  searchUrlTemplate?: string;

  @ApiPropertyOptional({
    description: 'CSS selector for result links. Leave empty to use the generic one.',
    example: '.products.list li a.image',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  searchResultSelector?: string;

  @ApiPropertyOptional({
    description: 'CSS selector for one result tile — the box holding name, price and link.',
    example: 'form.item.product',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  searchTileSelector?: string;

  @ApiPropertyOptional({
    description: 'CSS selector for the product name inside a result tile.',
    example: '.product-name',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  searchTitleSelector?: string;

  @ApiPropertyOptional({
    description: 'CSS selector for the price inside a result tile.',
    example: '.product-price',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  searchPriceSelector?: string;

  @ApiPropertyOptional({
    description: 'Detector confidence this configuration came from, 0–1.',
    minimum: 0,
    maximum: 1,
    example: 0.9,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(1)
  @IsOptional()
  searchConfidence?: number;
}

export class CreateShopDto extends SearchConfigDto {
  @ApiPropertyOptional({
    description:
      'Set false for a supplier with no website — the local warehouse that emails a price list. Nothing is fetched for them; you enter their prices, and they still join the same comparison with your discount applied.',
    default: true,
  })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  hasWebsite?: boolean;

  @ApiProperty({
    description:
      'Shop domain. Protocol and `www.` are stripped; a subdomain is kept, because `bg.shop.eu` and `shop.eu` are different storefronts.',
    example: 'tmt-elkom.com',
  })
  @IsString()
  @MinLength(4)
  @MaxLength(255)
  @Transform(trimString)
  host!: string;

  @ApiPropertyOptional({ example: 'ТМТ ЕЛКОМ' })
  @IsString()
  @MaxLength(160)
  @IsOptional()
  @Transform(trimString)
  name?: string;

  @ApiPropertyOptional({
    description: "Your negotiated discount off this shop's listed prices, in percent.",
    minimum: 0,
    maximum: 100,
    example: 10,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  discountPercent?: number;

  @ApiPropertyOptional({ description: 'Currency this shop quotes in.', example: 'EUR' })
  @IsString()
  @Length(3, 3)
  @Transform(trimUpperCase)
  @IsOptional()
  currency?: string;
}

export class UpdateShopDto extends SearchConfigDto {
  @ApiPropertyOptional({ description: 'False for a supplier with no website.', default: true })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  hasWebsite?: boolean;

  @ApiPropertyOptional({ example: 'ТМТ ЕЛКОМ' })
  @IsString()
  @MaxLength(160)
  @IsOptional()
  @Transform(trimString)
  name?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, example: 10 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  discountPercent?: number;

  @ApiPropertyOptional({ example: 'EUR' })
  @IsString()
  @Length(3, 3)
  @Transform(trimUpperCase)
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ example: true })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
