import { IsPublicHttpUrlTemplate } from '../../common/validators/public-url.validator';
import { VatState } from '../../pricing/effective-cost';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
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

/**
 * The commercial terms a price depends on, beyond the discount.
 *
 * Shared by create and update, and every field is optional: a supplier added
 * without them prices exactly as suppliers did before these existed. That is
 * what keeps the change safe for shops already in the database.
 */
class CommercialTermsDto extends SearchConfigDto {
  @ApiPropertyOptional({
    description:
      'Whether this shop quotes with VAT, without it, or has not said. Left unset it stays `unknown`, and offers on an unknown basis are shown but marked as not directly comparable against offers whose basis is known — because assuming is a 20% error, larger than almost any discount.',
    enum: VatState,
    enumName: 'VatState',
    example: VatState.Exclusive,
  })
  @IsEnum(VatState)
  @IsOptional()
  vatState?: VatState;

  @ApiPropertyOptional({
    description: 'VAT rate in percent. Only used when the shop quotes VAT-inclusive.',
    minimum: 0,
    maximum: 100,
    example: 20,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  @IsOptional()
  vatRate?: number;

  @ApiPropertyOptional({
    description: 'Flat delivery charge per order. Charged once per order, not per article.',
    minimum: 0,
    example: 12,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  shippingCost?: number;

  @ApiPropertyOptional({
    description:
      'Goods total at or above which delivery is free. Send `null` to clear it, meaning delivery is never free.',
    minimum: 0,
    nullable: true,
    example: 300,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  freeShippingOver?: number | null;

  @ApiPropertyOptional({
    description: 'Per-order charge that is not delivery — packing, documents, a card fee.',
    minimum: 0,
    example: 0,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  handlingFee?: number;

  @ApiPropertyOptional({
    description:
      'Below this goods total the supplier will not accept an order. A supplier under their minimum is reported as unavailable rather than ranked as cheapest.',
    minimum: 0,
    example: 200,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  minOrderValue?: number;

  @ApiPropertyOptional({
    description:
      'Anything about the terms the fields above cannot hold — a rebate, a seasonal condition, a person to ask. Read by people, never by the pricing code.',
    maxLength: 2000,
  })
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  @Transform(trimString)
  termsNote?: string;
}

export class CreateShopDto extends CommercialTermsDto {
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

export class UpdateShopDto extends CommercialTermsDto {
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
