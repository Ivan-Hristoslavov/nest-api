import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { PurchaseDecisionSnapshot } from '../../decisions/purchase-decision.snapshot';
import { CostWarningDto, RankedHitDto } from './discovery.dto';

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
  @IsOptional()
  lines?: BasketLineInputDto[];

  @ApiPropertyOptional({
    description:
      'The order as somebody pasted it — one article per line, with a quantity at the end if there is one.\n\nSent instead of `lines` when the request came from a person rather than from software. The splitting rules are the ones people already write by: a comma, a dash or nothing before the number; a unit or none; Cyrillic or Latin. A specification is never read as a quantity — "LED лампа 9W" is one lamp, not nine.\n\nIgnored when `lines` is given, so an existing integration is untouched.',
    example: 'СВТ 3x2.5, 100м\nСВТ 3x1.5, 50м\nLED лампа 9W, 10бр',
  })
  @IsString()
  @Length(2, 4000)
  @IsOptional()
  text?: string;

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

  @ApiPropertyOptional({
    description:
      'How many suppliers you are willing to split the order across.\n\nA real constraint rather than a tuning knob: three deliveries to accept, three invoices to reconcile and three people to chase is often worth more than the €5 the third supplier saves. Unset, every combination is considered and the alternatives show what fewer suppliers would cost.',
    minimum: 1,
    maximum: 10,
    example: 2,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  maxSuppliers?: number;

  @ApiPropertyOptional({
    description:
      'Suppliers to leave out of this order — one you are between contracts with, or one whose delivery time does not suit this job. The plan is recalculated without them.',
    type: String,
    isArray: true,
    example: ['6b0d9b4a-4a4e-4d51-9e2c-1f2f6f7f9a10'],
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  @IsOptional()
  excludeShopIds?: string[];
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

/** One line, as the plan places it. */
export class PlanLineDto {
  @ApiProperty({ example: 'КАБЕЛ СВТ 3x2.5' }) query!: string;
  @ApiProperty({ example: 100 }) quantity!: number;
  @ApiProperty({ format: 'uuid' }) shopId!: string;

  @ApiPropertyOptional({
    description: "The supplier's own name for the article, for the order that goes out.",
    nullable: true,
  })
  matchedName!: string | null;

  @ApiPropertyOptional({ format: 'uri', nullable: true }) url!: string | null;

  @ApiProperty({ description: 'Net of VAT, per unit, in the plan’s currency.', example: 1.08 })
  unitPrice!: number;

  @ApiProperty({ example: 108 }) lineTotal!: number;

  @ApiProperty({ description: 'How sure we are this is the article you asked for.', example: 0.96 })
  confidence!: number;

  @ApiProperty({
    description:
      'Where the figure came from. A `manual` price with an old `recordedAt` still wins on price if it is cheapest — but the plan says so rather than hiding it.',
    enum: ['live', 'cached', 'manual'],
    example: 'live',
  })
  priceSource!: 'live' | 'cached' | 'manual';

  @ApiPropertyOptional({
    description: 'When a hand-entered or cached figure was last confirmed.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  recordedAt!: string | null;

  @ApiProperty({
    description: 'Whether this figure is directly comparable with the others. See `cost`.',
    enum: ['known', 'assumed', 'uncertain'],
    example: 'known',
  })
  vatCertainty!: string;
}

/** One supplier's share of a plan, fully costed. */
export class PlanSupplierDto {
  @ApiProperty({ format: 'uuid' }) shopId!: string;
  @ApiProperty({ example: 'ТМТ ЕЛКОМ' }) name!: string;

  @ApiProperty({ type: PlanLineDto, isArray: true }) lines!: PlanLineDto[];
  @ApiProperty({ example: 9 }) linesCovered!: number;

  @ApiProperty({ description: 'Goods after discount, net of VAT.', example: 253.5 })
  productSubtotal!: number;

  @ApiProperty({ description: 'Charged once for this supplier’s share.', example: 8 })
  shipping!: number;

  @ApiProperty({ description: 'True when the free-delivery threshold was met.', example: false })
  shippingWaived!: boolean;

  @ApiProperty({ example: 0 }) handlingFee!: number;

  @ApiProperty({ description: 'goods + delivery + handling.', example: 261.5 })
  total!: number;

  @ApiProperty({
    description:
      'Always true inside a plan — a supplier who would refuse their share makes the whole plan impossible, so such plans are never returned.',
    example: true,
  })
  meetsMinimumOrder!: boolean;

  @ApiProperty({ example: 200 }) minOrderValue!: number;
  @ApiProperty({ example: 0 }) minimumShortfall!: number;

  @ApiProperty({ type: CostWarningDto, isArray: true }) warnings!: CostWarningDto[];
}

/** One way of placing the order. */
export class PurchasePlanDto {
  @ApiProperty({
    description:
      '`optimal` is the cheapest placeable plan. `single_supplier` is the whole order at one supplier. `fewest_suppliers` trades money for fewer deliveries. `alternative` is a genuinely different shape.',
    enum: ['optimal', 'single_supplier', 'fewest_suppliers', 'alternative'],
    example: 'optimal',
  })
  kind!: string;

  @ApiProperty({ description: 'One clause for the interface.', example: '2 доставчика' })
  label!: string;

  @ApiProperty({ type: PlanSupplierDto, isArray: true }) suppliers!: PlanSupplierDto[];
  @ApiProperty({ example: 2 }) suppliersUsed!: number;

  @ApiProperty({ description: 'Goods across every supplier, net of VAT.', example: 1440 })
  productSubtotal!: number;

  @ApiProperty({ description: 'Delivery across every supplier, added up.', example: 35 })
  shipping!: number;

  @ApiProperty({ example: 0 }) handlingFee!: number;

  @ApiProperty({ description: 'What placing this plan actually costs.', example: 1475 })
  total!: number;

  @ApiProperty({ example: 25 }) linesCovered!: number;

  @ApiPropertyOptional({
    description: 'Against the single-supplier baseline. Null when there is no baseline.',
    type: Number,
    nullable: true,
    example: 214,
  })
  savings!: number | null;

  @ApiProperty({ type: CostWarningDto, isArray: true }) warnings!: CostWarningDto[];
}

/** A line no supplier could fill, and why. */
export class UnassignedLineDto {
  @ApiProperty({ example: 'ПВЦ тръба ф20' }) query!: string;
  @ApiProperty({ example: 50 }) quantity!: number;

  @ApiProperty({
    description:
      '`no_offers` — nobody returned it. `all_rejected` — offers came back but none survived the confidence, availability or price checks.',
    enum: ['no_offers', 'all_rejected'],
    example: 'no_offers',
  })
  reason!: string;

  @ApiProperty({
    description: 'Which supplier’s offer was dropped and why.',
    type: 'array',
    items: {
      type: 'object',
      properties: { shopId: { type: 'string' }, reason: { type: 'string' } },
    },
  })
  rejections!: Array<{ shopId: string; reason: string }>;
}

/** A supplier who could not take part, and why. */
export class RejectedSupplierDto {
  @ApiProperty({ format: 'uuid' }) shopId!: string;
  @ApiProperty({ example: 'ТМТ ЕЛКОМ' }) name!: string;

  @ApiProperty({
    enum: ['below_minimum_order', 'excluded_by_customer'],
    example: 'below_minimum_order',
  })
  reason!: string;

  @ApiProperty({
    description: 'Written for the buyer.',
    example: 'ТМТ ЕЛКОМ не приема поръчки под 200 EUR. Тази поръчка при тях е 157.5 EUR.',
  })
  message!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 157.5 })
  goodsTotal?: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 200 })
  minOrderValue?: number;
}

/** Why this plan, in sentences the interface can print. */
export class PlanExplanationDto {
  @ApiProperty({
    description: 'Why the chosen plan won, and what each supplier is doing in it.',
    type: String,
    isArray: true,
  })
  whyChosen!: string[];

  @ApiProperty({
    description: 'What was given up, and what it would have cost. Often empty.',
    type: String,
    isArray: true,
  })
  tradeOffs!: string[];
}

/** What the optimiser did, for the operator screen. Not for the buyer. */
export class OptimisationDiagnosticsDto {
  @ApiProperty({ example: 25 }) lineCount!: number;
  @ApiProperty({ example: 23 }) assignableLines!: number;
  @ApiProperty({ example: 6 }) supplierCount!: number;
  @ApiProperty({ example: 94 }) candidateOffers!: number;
  @ApiProperty({ example: 63 }) combinationsEvaluated!: number;
  @ApiProperty({ example: 12 }) feasiblePlans!: number;

  @ApiProperty({
    description:
      'True when the search space was capped and only small combinations were tried — the answer is the best of what was tried, not provably the best there is.',
    example: false,
  })
  boundedSearch!: boolean;

  @ApiProperty({ example: 3 }) durationMs!: number;
}

/**
 * Where to place this order.
 *
 * The answer the basket exists to give. Everything above it — `suppliers`,
 * `split` — describes *what things cost*; this describes *what to do*.
 */
export class OptimisedOrderDto {
  @ApiPropertyOptional({
    description: 'The cheapest plan that can actually be placed. Null when none can.',
    type: PurchasePlanDto,
    nullable: true,
  })
  best!: PurchasePlanDto | null;

  @ApiPropertyOptional({
    description:
      'The cheapest single supplier who could take the whole order **and would accept it**. One below their minimum is not a baseline: ordering everything from them is not something the buyer can do.',
    type: PurchasePlanDto,
    nullable: true,
  })
  baseline!: PurchasePlanDto | null;

  @ApiPropertyOptional({
    description:
      '`baseline.total − best.total`. Null when no single supplier could fill the order — comparing a split against a partial order compares two different purchases.',
    type: Number,
    nullable: true,
    example: 214,
  })
  savings!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 12.7 })
  savingsPercent!: number | null;

  @ApiProperty({
    description:
      'Meaningfully different plans, not near-identical variants: the single-supplier order, the cheapest at each smaller supplier count. Never repeats `best`.',
    type: PurchasePlanDto,
    isArray: true,
  })
  alternatives!: PurchasePlanDto[];

  @ApiProperty({ type: UnassignedLineDto, isArray: true })
  unassigned!: UnassignedLineDto[];

  @ApiProperty({ type: RejectedSupplierDto, isArray: true })
  rejectedSuppliers!: RejectedSupplierDto[];

  @ApiProperty({ type: PlanExplanationDto })
  explanation!: PlanExplanationDto;

  @ApiProperty({ type: OptimisationDiagnosticsDto })
  diagnostics!: OptimisationDiagnosticsDto;
}

export class BasketSupplierDto {
  @ApiProperty({ format: 'uuid' }) shopId!: string;
  @ApiProperty({ example: 'ТМТ ЕЛКОМ' }) name!: string;
  @ApiProperty({ example: 'tmt-elkom.com' }) host!: string;

  @ApiProperty({ description: 'Lines this supplier can fill.', example: 8 }) linesCovered!: number;
  @ApiProperty({ description: 'Lines on the order.', example: 10 }) linesTotal!: number;

  @ApiPropertyOptional({
    description:
      'Goods only, for the lines they carry, after your discount and net of VAT.\n\n**Unchanged in meaning from before delivery and minimum orders existed** — it is the product subtotal, and it is deliberately *not* what the order costs. That figure is `effectiveTotal`.',
    type: Number,
    nullable: true,
    example: 412.6,
  })
  total!: number | null;

  @ApiPropertyOptional({
    description: 'Same as `total`, named for what it is. Prefer this over `total` in new code.',
    type: Number,
    nullable: true,
    example: 412.6,
  })
  goodsTotal!: number | null;

  @ApiProperty({
    description: 'Delivery for this order at this supplier. Zero when the free threshold is met.',
    example: 12,
  })
  shippingCost!: number;

  @ApiProperty({
    description: 'True when the goods total cleared this supplier’s free-delivery threshold.',
    example: false,
  })
  shippingWaived!: boolean;

  @ApiProperty({
    description: 'Per-order charge that is not delivery — packing, documents, a card fee.',
    example: 0,
  })
  handlingFee!: number;

  @ApiPropertyOptional({
    description:
      'What leaving this order here **actually costs**: goods + delivery + handling. This is the figure to compare between suppliers; `total` is only the product subtotal.',
    type: Number,
    nullable: true,
    example: 424.6,
  })
  effectiveTotal!: number | null;

  @ApiProperty({
    description:
      'Whether this supplier will accept an order of this size. A supplier below their minimum is not the cheapest one — they are not an option, and ranking them first recommends an order that will be refused.',
    example: true,
  })
  meetsMinimumOrder!: boolean;

  @ApiProperty({ description: 'This supplier’s minimum order value.', example: 200 })
  minOrderValue!: number;

  @ApiProperty({
    description: 'How far short of the minimum this order falls, or 0 when it clears it.',
    example: 0,
  })
  minimumShortfall!: number;

  @ApiProperty({
    description:
      'Anything the buyer should know before trusting these figures — an unstated VAT basis, a price that could not be converted, an order below the minimum.',
    type: CostWarningDto,
    isArray: true,
  })
  warnings!: CostWarningDto[];

  @ApiProperty({
    description:
      'Lines this supplier does not have. Shown rather than hidden: "cheapest, but missing three items" is a real answer, and concealing it recommends an order that cannot be placed.',
    type: String,
    isArray: true,
  })
  missing!: string[];
}

export class BasketSplitDto {
  @ApiPropertyOptional({
    description: 'Goods only, taking every line from whoever is cheapest on it.',
    type: Number,
    nullable: true,
    example: 388.15,
  })
  total!: number | null;

  @ApiPropertyOptional({
    description: 'Same as `total`, named for what it is.',
    type: Number,
    nullable: true,
    example: 388.15,
  })
  goodsTotal!: number | null;

  @ApiProperty({
    description: 'Delivery across every supplier the split would order from, added up.',
    example: 20,
  })
  shippingCost!: number;

  @ApiPropertyOptional({
    description:
      'What the split **actually costs**: goods + every supplier’s delivery and handling. Splitting an order saves on goods and adds a delivery per supplier, so this is the only figure worth comparing against a single supplier’s `effectiveTotal`.',
    type: Number,
    nullable: true,
    example: 408.15,
  })
  effectiveTotal!: number | null;

  @ApiProperty({
    description:
      'Whether every supplier in this split would accept their share. False means the split is arithmetically cheaper and cannot actually be placed.',
    example: true,
  })
  allSuppliersViable!: boolean;

  @ApiProperty({ example: 10 }) linesPriced!: number;

  @ApiProperty({
    description: 'Who you would be ordering from.',
    type: String,
    isArray: true,
    example: ['Местен склад', 'ТМТ ЕЛКОМ'],
  })
  suppliers!: string[];
}

/**
 * A decision as it travels out and, if the buyer keeps it, back.
 *
 * The snapshot is deliberately opaque here rather than modelled field by field
 * in Swagger. Its shape is the decision record's, it is documented on
 * `GET /purchase-decisions/{id}`, and a second declaration of it in the basket
 * response would be one more place for the two to drift apart. What a client
 * needs to know about it is simpler than its shape: pass it back untouched.
 */
export class DecisionDraftDto {
  @ApiProperty({
    description:
      'The whole decision, frozen: request, supplier terms, lines with price and matching provenance, the plan, its baseline and its alternatives.',
    type: 'object',
    additionalProperties: true,
  })
  snapshot!: PurchaseDecisionSnapshot;

  @ApiProperty({
    description:
      'Proof this server produced these figures. Post it back with the snapshot; an altered snapshot is refused rather than stored.',
    example: '9f2c4b…',
  })
  signature!: string;
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
      'Saving on **goods only**, against the cheapest supplier who could fill the whole order. Null when no single supplier can — comparing a split against a partial order compares two different purchases.\n\nKept for compatibility. It overstates the benefit, because splitting adds a delivery per supplier; `effectiveSaving` is the number to show a customer.',
    type: Number,
    nullable: true,
    example: 24.45,
  })
  saving!: number | null;

  @ApiPropertyOptional({
    description:
      'What splitting **really** saves: the difference in `effectiveTotal`, so delivery and handling are on both sides of the comparison. Null when no single supplier could fill the order, or when the split is not placeable.',
    type: Number,
    nullable: true,
    example: 12.45,
  })
  effectiveSaving!: number | null;

  @ApiProperty({
    description:
      'Where to place this order.\n\n`suppliers` and `split` above say what things cost; this says what to do. It is the only figure here that accounts for delivery, minimum orders and handling together, and the only one that will never recommend an order a supplier would refuse.\n\nAdded alongside the existing fields rather than replacing them, so a client written against the earlier contract keeps working.',
    type: OptimisedOrderDto,
  })
  plan!: OptimisedOrderDto;

  @ApiPropertyOptional({
    description:
      'This comparison, ready to be kept as a permanent record — every supplier’s terms, every price with where and when it was read, every match with what decided it, the chosen plan and everything it beat.\n\n**Nothing has been stored.** Pricing an order to see what it would cost is not a decision, and saving one on every comparison would fill the record with plans nobody chose. To keep this one, post the object back **unchanged** to `POST /purchase-decisions`. Nothing is recalculated then — the figures are already here — so the stored decision is exactly the one you were shown.\n\nIt is also what an interface should read to answer "how was this calculated?", before anything is saved at all.\n\nNull when no plan could be placed.',
    type: DecisionDraftDto,
    nullable: true,
  })
  decision!: DecisionDraftDto | null;
}
