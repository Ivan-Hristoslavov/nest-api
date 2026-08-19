import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'When this figure was last confirmed, for a price the buyer entered by hand. Absent for a scraped price, which was read moments ago. A hand-entered price cannot go stale on its own — nothing re-reads it — so its age is the only thing saying whether to trust it against a live one.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  recordedAt?: string | null;

  @ApiPropertyOptional({
    description:
      'Where the figure came from: read now, reused from a recent read, or entered by you.',
    enum: ['live', 'cached', 'manual'],
  })
  priceSource?: 'live' | 'cached' | 'manual';
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

export class DetectSearchDto {
  @ApiProperty({
    description:
      'The address bar after searching the shop by hand — the one URL the user can always produce.',
    format: 'uri',
    example: 'https://ardes.bg/search?q=%D0%BA%D1%80%D1%83%D1%88%D0%BA%D0%B0',
  })
  @IsString()
  @IsUrl({ require_protocol: true }, { message: 'searchUrl трябва да е пълен адрес с https://' })
  @MaxLength(2048)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : (value as unknown)))
  searchUrl!: string;

  @ApiProperty({
    description: 'What was typed into the shop’s search box to get that URL.',
    minLength: 2,
    maxLength: 120,
    example: 'крушка',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : (value as unknown)))
  sampleQuery!: string;
}

export class DetectedSampleDto {
  @ApiProperty({ example: 'LED крушка 9W E27 4000K' }) title!: string;
  @ApiProperty({ format: 'uri' }) url!: string;
  @ApiPropertyOptional({ type: Number, nullable: true, example: 3.49 }) price!: number | null;
}

export class DetectedShopDto {
  @ApiProperty({ example: 'ardes.bg' }) host!: string;

  @ApiProperty({ example: 'Ardes' }) name!: string;

  @ApiProperty({
    description: 'The search URL with the query replaced by `{q}` — ready to save on the shop.',
    example: 'https://ardes.bg/search?q={q}',
  })
  urlTemplate!: string;

  @ApiProperty({ description: 'CSS selector of one result tile.' }) tileSelector!: string;

  @ApiProperty({ description: 'CSS selector for the links inside a tile.' }) linkSelector!: string;

  @ApiPropertyOptional({ nullable: true }) titleSelector!: string | null;

  @ApiPropertyOptional({ nullable: true }) priceSelector!: string | null;

  @ApiProperty({
    description:
      'Share of result tiles that yielded a title, a link and a price (0–1). Below ~0.5, distrust the guess.',
    example: 0.9,
  })
  confidence!: number;

  @ApiProperty({
    type: DetectedSampleDto,
    isArray: true,
    description:
      'The first rows as the detector read them — shown back so the guess can be checked.',
  })
  samples!: DetectedSampleDto[];
}

export class CompareQueryDto extends SearchQueryDto {
  @ApiPropertyOptional({
    description: 'Currency to compare in. Only the pegged BGN/EUR pair is converted.',
    example: 'EUR',
    default: 'EUR',
  })
  @IsString()
  @Length(3, 3)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : (value as unknown),
  )
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ description: 'Drop results whose price could not be read.' })
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : (value as unknown),
  )
  @IsBoolean()
  @IsOptional()
  inStockOnly?: boolean;

  @ApiPropertyOptional({ description: 'Maximum ranked rows to return.', default: 60, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({
    description:
      'False compares on barcodes, article numbers and specifications only — never a model. Matching still runs and still returns confidence; it just stops before the part that costs money and adds latency.',
    default: true,
  })
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : (value as unknown),
  )
  @IsBoolean()
  @IsOptional()
  ai?: boolean;
}

export class MatchReasonDto {
  @ApiProperty({ example: 'Мощност' }) label!: string;
  @ApiProperty({ example: '12W' }) left!: string;
  @ApiProperty({ example: '12W' }) right!: string;
  @ApiProperty({ example: true }) agrees!: boolean;
}

export class MatchDto {
  @ApiProperty({
    description:
      'How sure we are that this offer is the article you searched for, 0–1. Above 0.95 something checkable proved it — a barcode, an article number, a model code. Between 0.85 and 0.94 the specifications agree. Below 0.7 do not treat it as the same product.',
    example: 0.96,
  })
  confidence!: number;

  @ApiProperty({ enum: ['certain', 'high', 'possible', 'weak'], example: 'certain' })
  band!: string;

  @ApiProperty({
    description: 'What decided it. Everything except `ai` is arithmetic on the two names.',
    enum: ['gtin', 'sku', 'model', 'attributes', 'text', 'ai', 'conflict', 'none'],
    example: 'attributes',
  })
  method!: string;

  @ApiProperty({ example: 'Съвпадат: марка, мощност, фасунга.' })
  explanation!: string;

  @ApiProperty({
    type: MatchReasonDto,
    isArray: true,
    description: 'Attribute by attribute, so the decision can be checked rather than trusted.',
  })
  reasons!: MatchReasonDto[];
}

export class RankedHitDto {
  @ApiPropertyOptional({
    type: () => MatchDto,
    description:
      'Whether this offer is the article you searched for, and why. Absent only when matching was not run.',
  })
  match?: MatchDto;

  @ApiProperty({
    description: 'Kind of article, so a cable is not price-compared against a cable drum.',
    example: 'кабел h05v-k',
  })
  groupKey!: string;

  @ApiProperty({ example: 'КАБЕЛ H05V-K' }) groupLabel!: string;

  @ApiProperty({
    description:
      'True when the product\'s own name contains what was searched for. Shop search engines are fuzzy — homefinishing.bg answers "СВТ" with "САТ.НИКЕЛ" — and a guess presented as a match makes the tool look broken when the shop was merely being generous. Unmatched rows are ranked after every real match.',
    example: true,
  })
  matched!: boolean;

  @ApiPropertyOptional({ format: 'uuid', nullable: true }) shopId!: string | null;

  @ApiProperty({ example: 'ТМТ ЕЛКОМ' }) shopName!: string;

  @ApiProperty({ example: 'tmt-elkom.com' }) host!: string;

  @ApiProperty({ example: 'КАБЕЛ H05V-K 1x1.5 ЧЕРЕН' }) name!: string;

  @ApiProperty({ format: 'uri' }) url!: string;

  @ApiPropertyOptional({
    description: 'Price as the shop advertises it.',
    type: Number,
    nullable: true,
    example: 0.98,
  })
  listedPrice!: number | null;

  @ApiProperty({ example: 'EUR' }) listedCurrency!: string;

  @ApiProperty({ description: 'Your negotiated discount at this shop.', example: 10 })
  discountPercent!: number;

  @ApiPropertyOptional({
    description:
      'What you actually pay: the listed price less your discount, converted. Null when the shop quotes a currency with no fixed rate to the target — a guessed rate is worse than an admitted gap.',
    type: Number,
    nullable: true,
    example: 0.88,
  })
  effectivePrice!: number | null;

  @ApiProperty({ example: 'EUR' }) effectiveCurrency!: string;

  @ApiPropertyOptional({ type: Boolean, nullable: true }) inStock!: boolean | null;

  @ApiPropertyOptional({
    description:
      'When a hand-entered price was last confirmed. Absent when the price was read live from the shop, seconds ago.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  recordedAt!: string | null;

  @ApiProperty({
    description:
      'Where this figure came from. `live` was read from the shop moments ago, `cached` within the last few hours, `manual` is what you entered for a supplier that publishes nothing. They carry different weight and the interface says which is which.',
    enum: ['live', 'cached', 'manual'],
    example: 'live',
  })
  priceSource!: 'live' | 'cached' | 'manual';
}

export class ShopOutcomeDto {
  @ApiProperty({ example: 'emag.bg' }) host!: string;
  @ApiProperty({ example: 'eMAG' }) name!: string;
  @ApiProperty({ example: true }) ok!: boolean;
  @ApiPropertyOptional({ nullable: true }) error!: string | null;
  @ApiProperty({ example: 412 }) durationMs!: number;
  @ApiProperty({ description: 'Results this shop returned.', example: 6 }) count!: number;
  @ApiProperty({ description: 'The URL that was fetched.', format: 'uri' }) searchUrl!: string;
}

export class MatchingSummaryDto {
  @ApiProperty({ description: 'What the query was understood to mean, before any model ran.' })
  understood!: Record<string, unknown>;

  @ApiProperty({ example: 24 }) candidates!: number;

  @ApiProperty({
    description: 'Pairs settled by barcode, article number, model code or specification — free.',
    example: 21,
  })
  decidedDeterministically!: number;

  @ApiProperty({ description: 'Requests actually sent to a model.', example: 1 })
  aiCallsMade!: number;

  @ApiProperty({ description: 'Pairs answered from a previous model verdict.', example: 2 })
  aiCacheHits!: number;

  @ApiPropertyOptional({ nullable: true, example: 'claude-haiku-4-5' })
  aiModel!: string | null;

  @ApiPropertyOptional({
    description: 'Why no model ran, when none did.',
    enum: ['disabled', 'quota', 'unreachable'],
    nullable: true,
  })
  aiSkippedReason!: string | null;

  @ApiPropertyOptional({
    description:
      'The monthly AI allowance of the calling account, including what this very search spent. Null for callers with no account to meter.',
    nullable: true,
    example: { used: 12, limit: 2000 },
  })
  aiQuota!: { used: number; limit: number } | null;

  @ApiProperty({ example: 180 }) durationMs!: number;
}

export class ComparisonDto {
  @ApiProperty({ example: 'крушка 20W' }) query!: string;

  @ApiProperty({ description: 'How long the whole fan-out took.', example: 1340 })
  durationMs!: number;

  @ApiProperty({
    type: ShopOutcomeDto,
    isArray: true,
    description:
      'What each shop did. "Found at 4 of 6, one refused" is a different answer from "nobody stocks it", and the ranked list alone cannot tell them apart.',
  })
  shops!: ShopOutcomeDto[];

  @ApiProperty({
    type: RankedHitDto,
    isArray: true,
    description:
      'Every offer found, most confident match first and cheapest-for-you within each confidence band. The cheapest row is the wrong answer when it is a different article.',
  })
  hits!: RankedHitDto[];

  @ApiPropertyOptional({
    type: MatchingSummaryDto,
    description:
      'What matching did and what it cost: how many pairs arithmetic settled, how many reached a model, which model, and how many came from cache.',
  })
  matching?: MatchingSummaryDto;
}
