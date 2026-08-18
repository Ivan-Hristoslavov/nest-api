import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
} from 'class-validator';

import {
  toOptionalBoolean,
  trimString,
  trimUpperCase,
} from '../../common/transformers/dto-transformers';

export class CreateShopDto {
  @ApiProperty({
    description: 'Shop domain. Protocol and `www.` are stripped.',
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
    description: "Leave empty to read it from the shop's robots.txt.",
    format: 'uri',
    example: 'https://www.tmt-elkom.com/sitemap.xml',
  })
  @IsString()
  @MaxLength(2048)
  @IsOptional()
  @Transform(trimString)
  sitemapUrl?: string;

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

  @ApiPropertyOptional({ example: 'EUR' })
  @IsString()
  @Length(3, 3)
  @Transform(trimUpperCase)
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({
    description:
      'Search URL with `{q}` where the query goes. Setting this makes the shop live-searchable immediately — no code change, no deploy.',
    example: 'https://ardes.bg/search?q={q}',
  })
  @IsString()
  @MaxLength(2048)
  @Matches(/\{q\}/, { message: 'searchUrlTemplate must contain {q}' })
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
    description: 'CSS selector for the price inside a result tile.',
    example: '.product-price',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  searchPriceSelector?: string;
}

export class UpdateShopDto {
  @ApiPropertyOptional({ example: 'ТМТ ЕЛКОМ' })
  @IsString()
  @MaxLength(160)
  @IsOptional()
  @Transform(trimString)
  name?: string;

  @ApiPropertyOptional({ format: 'uri' })
  @IsString()
  @MaxLength(2048)
  @IsOptional()
  @Transform(trimString)
  sitemapUrl?: string;

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

  @ApiPropertyOptional({
    description:
      'Search URL with `{q}` where the query goes. Setting this makes the shop live-searchable immediately — no code change, no deploy.',
    example: 'https://ardes.bg/search?q={q}',
  })
  @IsString()
  @MaxLength(2048)
  @Matches(/\{q\}/, { message: 'searchUrlTemplate must contain {q}' })
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
    description: 'CSS selector for the price inside a result tile.',
    example: '.product-price',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  @Transform(trimString)
  searchPriceSelector?: string;
}

export class SearchOffersDto {
  @ApiProperty({ description: 'What to look for.', minLength: 2, example: 'крушка 20W' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  @Transform(trimString)
  q!: string;

  @ApiPropertyOptional({ description: 'Restrict to one shop.', format: 'uuid' })
  @IsUUID('4')
  @IsOptional()
  shopId?: string;

  @ApiPropertyOptional({ description: 'Hide offers the shop marked out of stock.' })
  @Transform(toOptionalBoolean)
  @IsBoolean()
  @IsOptional()
  inStockOnly?: boolean;

  @ApiPropertyOptional({ description: 'Currency to compare in.', default: 'EUR' })
  @IsString()
  @Length(3, 3)
  @Transform(trimUpperCase)
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 40 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}

export class OfferHitDto {
  @ApiProperty({
    description:
      'Identity of the *kind* of article, so unlike things are never priced against each other. A bare cable sold by the metre and a cable reel both match the word "кабел"; quoting one price range across the two is misleading, not helpful.',
    example: 'кабел|h05v-k',
  })
  groupKey!: string;

  @ApiProperty({
    description: 'Human label for the group, shown as its heading.',
    example: 'КАБЕЛ H05V-K',
  })
  groupLabel!: string;

  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) shopId!: string;
  @ApiProperty({ example: 'ТМТ ЕЛКОМ' }) shopName!: string;
  @ApiProperty({ example: 'tmt-elkom.com' }) host!: string;
  @ApiProperty({ example: 'Лампа LED 5W/E14 4000K 400lm' }) name!: string;
  @ApiProperty({ format: 'uri' }) url!: string;
  @ApiPropertyOptional({ nullable: true }) shopCode!: string | null;
  @ApiPropertyOptional({ nullable: true, format: 'uri' }) imageUrl!: string | null;

  @ApiProperty({ description: 'Price as the shop shows it.', example: 0.98 })
  listedPrice!: number;

  @ApiProperty({ example: 'EUR' }) listedCurrency!: string;

  @ApiProperty({ description: 'Discount applied for this customer.', example: 10 })
  discountPercent!: number;

  @ApiPropertyOptional({
    description:
      'What you actually pay, after the discount and converted. Null when the currencies are not convertible without inventing a rate.',
    type: Number,
    nullable: true,
    example: 0.88,
  })
  effectivePrice!: number | null;

  @ApiProperty({ example: 'EUR' }) effectiveCurrency!: string;
  @ApiPropertyOptional({ nullable: true }) inStock!: boolean | null;

  @ApiPropertyOptional({
    description: 'When this price was last read. Older prices are shown as older.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  lastSeenAt!: string | null;
}

/** Whether a shop can be indexed at all, decided before anyone waits on it. */
export class ShopCheckDto {
  @ApiProperty({ example: 'tmt-elkom.com' }) host!: string;

  @ApiProperty({
    description: 'True only when a real product page gave up a real price.',
    example: true,
  })
  usable!: boolean;

  @ApiPropertyOptional({ nullable: true, format: 'uri' }) sitemapUrl!: string | null;

  @ApiProperty({ description: 'Product-looking pages found in the sitemap.', example: 7548 })
  pages!: number;

  @ApiPropertyOptional({
    description: 'The page we tested, so the claim can be checked by hand.',
    nullable: true,
    format: 'uri',
  })
  sampleUrl!: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 0.98 })
  samplePrice!: number | null;

  @ApiPropertyOptional({ nullable: true, example: 'ЛАМПА LED 5W/E14 4000K' })
  sampleName!: string | null;

  @ApiPropertyOptional({
    description: 'Why the shop cannot be indexed, in words the shop owner can act on.',
    nullable: true,
  })
  reason!: string | null;
}

export class ShopWithCheckDto {
  @ApiProperty({ type: () => Object, description: 'The registered shop.' })
  shop!: Record<string, unknown>;

  @ApiProperty({ type: ShopCheckDto })
  check!: ShopCheckDto;
}

/**
 * A page the sitemap knows about but the index has not read yet.
 *
 * Costs nothing to produce — the name is in the URL — so the whole catalogue
 * is findable before any of it is crawled.
 */
export class SuggestionDto {
  @ApiProperty({ format: 'uuid' }) shopId!: string;
  @ApiProperty({ example: 'ТМТ ЕЛКОМ' }) shopName!: string;
  @ApiProperty({ format: 'uri' }) url!: string;

  @ApiProperty({
    description: 'Name read off the URL slug. Rough, but enough to recognise the article.',
    example: 'luna fiksxrom37152argus ii ct 2114 c',
  })
  guessedName!: string;
}

export class IndexNowDto {
  @ApiProperty({
    description: 'Pages to fetch and index right now. At most ten — somebody is waiting.',
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  urls!: string[];
}

export class CrawlResultDto {
  @ApiProperty({ format: 'uuid' }) shopId!: string;
  @ApiProperty({ example: 'tmt-elkom.com' }) host!: string;

  @ApiProperty({ description: 'Pages the sitemap offered, after filtering.', example: 6841 })
  sitemapUrls!: number;

  @ApiProperty({ description: 'Pages tried in this batch.', example: 50 })
  attempted!: number;

  @ApiProperty({ description: 'Pages that yielded a price.', example: 46 })
  indexed!: number;

  @ApiProperty({ description: 'Pages with no price — categories, articles.', example: 3 })
  skipped!: number;

  @ApiProperty({ description: 'Pages that failed to load.', example: 1 })
  failed!: number;

  @ApiProperty({ description: 'Roughly how many pages are still unseen.', example: 6791 })
  remaining!: number;

  @ApiProperty({ description: 'Offers indexed for this shop in total.', example: 782 })
  offerCount!: number;

  @ApiProperty({ example: 128_400 }) durationMs!: number;

  @ApiProperty({
    description:
      'Up to five pages that did not become offers, with the reason. Mostly category pages, which is normal — but this is where a genuinely broken shop shows itself.',
    type: [String],
    example: ['https://shop.bg/contacts: Page fetched but no single price could be extracted.'],
  })
  problems!: string[];
}
