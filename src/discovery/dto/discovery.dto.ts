import { IsPublicHttpUrl } from '../../common/validators/public-url.validator';
import { CostWarningKind, VatCertainty, VatState } from '../../pricing/effective-cost';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
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

  @ApiPropertyOptional({
    description:
      'Whether the shop says it has this. `false` means it said so plainly — "изчерпан", "out of stock", "stoc epuizat" — and the row is shown as unavailable rather than quoted as a source. `null` means the shop said nothing, which is the normal state of an available article at a shop that only labels what it has run out of, and is never read as a refusal.',
    type: Boolean,
    nullable: true,
  })
  inStock?: boolean | null;

  @ApiPropertyOptional({
    description:
      'Financing the shop offers on this article, exactly as its page states it — number of payments, the monthly figure, and the lender where the page names one. Nothing is calculated here: no rate is inferred and no total is derived, because a financing figure this system computed and got wrong is one a customer can disprove against their contract.',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        months: { type: 'number', example: 12 },
        monthly: { type: 'number', example: 8.76 },
        currency: { type: 'string', example: 'EUR' },
        provider: { type: 'string', nullable: true, example: 'TBI Bank' },
      },
    },
  })
  instalments?: Array<{
    months: number;
    monthly: number;
    currency: string;
    provider: string | null;
  }>;
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

  @ApiPropertyOptional({
    description:
      'What this shop was actually asked, when the original query returned nothing and a widened spelling was tried. Absent when the shop answered the query as typed — which is the usual case, and the one that costs one request.',
    example: 'PVC pipe',
  })
  usedQuery?: string;

  @ApiPropertyOptional({
    description:
      'False for a shop this account holds no terms with, reached only because the search scope was `global`. Its price is the shelf price — no negotiated discount applies, because nobody negotiated one.',
    default: true,
  })
  isMine?: boolean;

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
  // Not `@IsUrl`: that accepts `http://127.0.0.1:3000/` and
  // `http://169.254.169.254/…` as perfectly well-formed addresses. This one
  // refuses the protocols and literal addresses we will not fetch, and says so
  // immediately instead of letting the request fail later somewhere obscure.
  @IsPublicHttpUrl({ message: 'searchUrl трябва да е публичен адрес с https://' })
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

  @ApiPropertyOptional({
    description:
      'Where to look.\n\n`my_suppliers` — the default — asks only the shops this account holds terms with, which is the working question for a buyer: *can I get this from somebody I already deal with?*\n\n`global` adds the verified shelf of shops the account has **not** added. Their prices are shelf prices: no negotiated discount is applied and no agreed delivery terms exist, because nobody negotiated any. Reach for it when the first answer was "nobody stocks it".',
    enum: ['my_suppliers', 'global'],
    default: 'my_suppliers',
  })
  @IsIn(['my_suppliers', 'global'])
  @IsOptional()
  scope?: 'my_suppliers' | 'global';
}

export class MatchReasonDto {
  @ApiProperty({ example: 'Мощност' }) label!: string;
  @ApiProperty({ example: '12W' }) left!: string;
  @ApiProperty({ example: '12W' }) right!: string;
  @ApiProperty({ example: true }) agrees!: boolean;

  @ApiProperty({
    description:
      'Why it agrees or does not. `agrees` alone cannot tell a buyer whether the supplier disagreed about the capacity or simply never mentioned it — and those are the two halves of a purchasing decision.',
    enum: ['match', 'missing', 'conflict'],
    example: 'match',
    required: false,
  })
  status?: 'match' | 'missing' | 'conflict';
}

/** One attribute as the two sides stated it. */
export class AttributeComparisonDto {
  @ApiProperty({
    description:
      'The concept, or the dimension where the supplier named none. Dynamic: whatever the two listings turned out to state.',
    example: 'storage',
  })
  key!: string;

  @ApiProperty({ example: 'Storage' }) label!: string;

  @ApiProperty({
    description:
      'What this attribute decides. `identity` disagreeing is a different article; `variant` is another version of the same one; `compatibility` is whether it fits; `package` is how many come in the box.',
    enum: ['identity', 'variant', 'compatibility', 'package', 'commercial', 'descriptive'],
    example: 'identity',
  })
  role!: string;

  @ApiProperty({ nullable: true, example: '512 GB' }) query!: string | null;
  @ApiProperty({ nullable: true, example: '512 GB' }) candidate!: string | null;

  @ApiProperty({ enum: ['match', 'missing', 'conflict'], example: 'match' })
  status!: 'match' | 'missing' | 'conflict';
}

/**
 * What a query was understood to be.
 *
 * Deliberately open: `attributes` carries whatever the query turned out to
 * state, keyed by concept where one was recognised and by dimension where it
 * was not. There is no list of supported categories, here or anywhere else.
 */
export class UnderstandingDto {
  @ApiProperty({
    nullable: true,
    example: 'pipe',
    description: "The kind of thing, in the buyer's own words.",
  })
  productType!: string | null;

  @ApiProperty({ nullable: true, example: 'philips' })
  brand!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Kept under its old name for clients written against it; it carries the product type.',
    example: 'pipe',
  })
  category!: string | null;

  @ApiProperty({
    description:
      'Every attribute read out of the query. Keys are dynamic — `ram`, `diameter`, `grammage`, `package_quantity` — and each value carries the measurement as written plus its value in a base unit, which is what two suppliers are actually compared on.',
    example: {
      diameter: {
        value: '50 mm',
        unit: 'mm',
        normalizedValue: 0.05,
        normalizedUnit: 'length',
        role: 'identity',
        label: 'Diameter',
      },
    },
  })
  attributes!: Record<string, unknown>;

  @ApiProperty({ description: 'Values that are not measurements, kept for older clients.' })
  specs!: Record<string, string>;

  @ApiProperty({
    description: 'Measurements as written, kept for older clients.',
    isArray: true,
    type: Object,
  })
  measurements!: Array<{ value: number; unit: string }>;

  @ApiProperty({ description: 'Barcodes, article numbers and model codes found in the query.' })
  identifiers!: Record<string, unknown>;

  @ApiProperty({
    nullable: true,
    description: 'How many the buyer wants — never part of what the article is.',
    example: 20,
  })
  requestedQuantity!: number | null;

  @ApiProperty({
    nullable: true,
    description: 'A likely typo in a brand name. Offered, never applied: the search runs as typed.',
    example: 'iphone 15',
  })
  didYouMean!: string | null;
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
    description:
      'How this offer stands to what was searched for. A boolean could not carry this: a variant of the same line and a part made to fit are both useful answers, and both used to arrive as "not a match".',
    enum: [
      'same_product',
      'same_family',
      'same_type',
      'compatible',
      'possible',
      'conflict',
      'unrelated',
    ],
    example: 'same_product',
  })
  relation!: string;

  @ApiProperty({
    description: 'Which pile this belongs in when results are shown.',
    enum: ['strong', 'possible', 'similar', 'excluded'],
    example: 'strong',
  })
  group!: string;

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

  @ApiProperty({
    type: AttributeComparisonDto,
    isArray: true,
    description: 'Attributes both sides state and agree on.',
  })
  matchedAttributes!: AttributeComparisonDto[];

  @ApiProperty({
    type: AttributeComparisonDto,
    isArray: true,
    description:
      'Attributes one side states and the other is silent about. Doubt, not refusal — a supplier who states less has said less, not something different.',
  })
  missingAttributes!: AttributeComparisonDto[];

  @ApiProperty({
    type: AttributeComparisonDto,
    isArray: true,
    description:
      'Attributes both sides state differently. A conflict in an identifying attribute ends the comparison.',
  })
  conflicts!: AttributeComparisonDto[];
}

/** One thing the buyer should know before trusting a figure. */
export class CostWarningDto {
  @ApiProperty({
    description: 'Machine-readable reason, so a client can decide how to show it.',
    enum: [
      'vat_unknown',
      'vat_not_comparable',
      'currency_not_convertible',
      'price_unreadable',
      'below_minimum_order',
    ],
    example: 'vat_unknown',
  })
  kind!: CostWarningKind;

  @ApiProperty({ description: 'Written for the buyer, not for the log.' })
  message!: string;
}

/**
 * The full working behind one unit price.
 *
 * Carried on every offer so a customer can be shown *how* a figure was reached
 * — list price, discount, VAT treatment, currency — without a second request
 * and without the interface re-deriving anything. A number a buyer cannot
 * unpick is a number they check by hand, which is the work this replaces.
 */
export class EffectiveCostDto {
  @ApiPropertyOptional({ type: Number, nullable: true, example: 1.2 })
  listPrice!: number | null;

  @ApiProperty({ example: 'EUR' }) listCurrency!: string;

  @ApiProperty({ example: 15 }) discountPercent!: number;

  @ApiPropertyOptional({
    description: 'After the discount, still in the supplier’s currency and VAT basis.',
    type: Number,
    nullable: true,
    example: 1.02,
  })
  discountedUnitPrice!: number | null;

  @ApiProperty({
    description: 'Whether this supplier quotes with VAT, without it, or has not said.',
    enum: ['inclusive', 'exclusive', 'unknown'],
    example: 'exclusive',
  })
  vatState!: VatState;

  @ApiProperty({ example: 20 }) vatRate!: number;

  @ApiProperty({
    description:
      '`known` — the VAT treatment is on file and this figure is net of VAT. `assumed` — nobody has said, and the quoted number is used as-is; safe against other assumed figures. `uncertain` — this offer sits beside one whose basis *is* known, so one may be gross and the other net and nothing says which. An `uncertain` figure must never be presented as a straight price comparison.',
    enum: ['known', 'assumed', 'uncertain'],
    example: 'known',
  })
  vatCertainty!: VatCertainty;

  @ApiPropertyOptional({
    description: 'Net of VAT, in the supplier’s currency.',
    type: Number,
    nullable: true,
    example: 1.02,
  })
  netUnitPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Net of VAT, converted to the currency you asked to compare in.',
    type: Number,
    nullable: true,
    example: 1.02,
  })
  effectiveUnitPrice!: number | null;

  @ApiProperty({ example: 'EUR' }) effectiveCurrency!: string;

  @ApiProperty({ example: 1 }) quantity!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1.02 })
  netLineTotal!: number | null;

  @ApiProperty({ type: CostWarningDto, isArray: true })
  warnings!: CostWarningDto[];
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

  @ApiProperty({
    description:
      'Whether this figure can be set against the others without a caveat. See `cost.vatCertainty`.',
    enum: ['known', 'assumed', 'uncertain'],
    example: 'known',
  })
  vatCertainty!: VatCertainty;

  @ApiProperty({
    description: 'This supplier’s VAT treatment, as configured.',
    enum: ['inclusive', 'exclusive', 'unknown'],
    example: 'exclusive',
  })
  vatState!: VatState;

  @ApiProperty({
    description: 'Anything the buyer should know before trusting this figure.',
    type: CostWarningDto,
    isArray: true,
  })
  warnings!: CostWarningDto[];

  @ApiProperty({
    description:
      'The full working behind `effectivePrice`, so it can be shown rather than trusted.',
    type: EffectiveCostDto,
  })
  cost!: EffectiveCostDto;
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
  @ApiProperty({
    description: 'What the query was understood to mean, before any model ran.',
    type: UnderstandingDto,
  })
  understood!: UnderstandingDto;

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
    example: { used: 12, limit: 2000, renews: true },
  })
  aiQuota!: { used: number; limit: number; renews: boolean } | null;

  @ApiProperty({
    description:
      'Filters worth offering, taken from the candidates this search actually found rather than from a list written in advance. Search a laptop and you get memory, storage and screen; search a pipe and you get diameter, length and material. Nobody declared either set.',
    isArray: true,
    type: Object,
    example: [
      {
        key: 'diameter',
        label: 'Диаметър',
        role: 'identity',
        values: [{ value: '50 mm', count: 4 }],
      },
    ],
  })
  facets!: Array<{
    key: string;
    label: string;
    role: string;
    values: Array<{ value: string; count: number }>;
  }>;

  @ApiProperty({ example: 180 }) durationMs!: number;
}

export class ComparisonDto {
  @ApiProperty({ example: 'крушка 20W' }) query!: string;

  @ApiProperty({ description: 'How long the whole fan-out took.', example: 1340 })
  durationMs!: number;

  @ApiPropertyOptional({
    description:
      "The spellings a supplier may be asked, the buyer's own always first. At most one of the others is ever sent, and only to a supplier whose own search came back empty — one request per supplier per question is what makes this affordable.",
    isArray: true,
    type: Object,
    example: [
      { query: 'PVC pipe 50mm 4m', kind: 'original', reason: 'as the buyer typed it' },
      {
        query: 'pipe 50mm',
        kind: 'canonical',
        reason: 'the kind of article plus the measurement that identifies it',
      },
    ],
  })
  variants?: Array<{ query: string; kind: string; reason: string }>;

  @ApiPropertyOptional({
    description: 'Where this search looked.',
    enum: ['my_suppliers', 'global'],
    example: 'my_suppliers',
  })
  scope?: string;

  @ApiPropertyOptional({
    description:
      'How many results fell in each pile, so a client can lead with the answer instead of with forty rows.',
    example: { strong: 3, possible: 5, similar: 2, excluded: 4 },
  })
  groups?: Record<string, number>;

  @ApiPropertyOptional({
    description:
      'Where the milliseconds went: reading the query, asking the suppliers, ranking, matching on specifications, and a model where one was needed at all. `ai` is zero on a search the specifications settled, which is most of them. `widened` is 1 when the question had to be asked a second time in another spelling.',
    example: { parse: 1, retrieval: 1180, ranking: 3, matching: 6, ai: 0, widened: 0, total: 1204 },
  })
  timings?: {
    parse: number;
    retrieval: number;
    ranking: number;
    matching: number;
    ai: number;
    widened: number;
    total: number;
  };

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

/** How much of the history to return. */
export class SearchHistoryQueryDto {
  @ApiPropertyOptional({
    description: 'How many searches to return, newest first.',
    minimum: 1,
    maximum: 100,
    default: 25,
  })
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}

/** A product page somebody pasted, before we have looked at it. */
export class PreviewUrlDto {
  @ApiProperty({
    description: 'Address of the product page to read.',
    example: 'https://kris06.bg/product/42226/polirmashina-status-hd-xpa12-75.html',
  })
  @IsPublicHttpUrl()
  url!: string;
}

/**
 * What we recognised at an address, for the reader to confirm.
 *
 * The fallback for a shop the search cannot reach — one that forbids crawling,
 * publishes no catalogue, or that the matcher simply missed. Nothing is saved
 * from this call: it reads the page, says what it found, and waits.
 */
export class UrlPreviewDto {
  @ApiProperty({ example: 'https://kris06.bg/product/42226/...' })
  url!: string;

  @ApiProperty({ example: 'kris06.bg' })
  host!: string;

  @ApiPropertyOptional({
    description: 'The product name as the page titles it, or null where the page has no title we could read.',
    nullable: true,
  })
  title!: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  price!: number | null;

  @ApiPropertyOptional({ nullable: true })
  currency!: string | null;

  @ApiPropertyOptional({
    description: 'Whether the page says it has this. Null where it says nothing.',
    type: Boolean,
    nullable: true,
  })
  inStock!: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  imageUrl!: string | null;

  @ApiPropertyOptional({
    description:
      'How the price was found: `json-ld`, `microdata`, `meta`, `site-profile`, `selector` or `heuristic`. Shown so a reader can judge how much to trust a figure nobody has confirmed.',
    nullable: true,
  })
  strategy!: string | null;

  @ApiProperty({
    description:
      'False when the page could not be read at all. The reader may still add the address — a page we cannot parse today is one the scraper may manage tomorrow — but they are told first.',
  })
  ok!: boolean;

  @ApiPropertyOptional({ nullable: true })
  error!: string | null;
}
