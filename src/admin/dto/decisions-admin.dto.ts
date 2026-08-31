import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { SavingsKind } from '../../decisions/entities/purchase-decision.entity';

/**
 * One decision, as the operator list shows it.
 *
 * The shape of a decision without its contents. Everything here answers an
 * operational question — did the optimiser find a plan, how hard did it work,
 * did the customer act on it — and none of it says what anybody bought. The
 * snapshot is deliberately absent: a support screen does not need a customer's
 * article list to answer "why does this customer say the plan is wrong", and a
 * screen that shows it by default shows it to everyone who opens the panel.
 */
export class AdminDecisionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'buyer@example.com' })
  customerEmail!: string | null;

  @ApiProperty({ example: 7 }) number!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ example: 'EUR' }) currency!: string;

  @ApiProperty({ description: 'Lines on the order.', example: 25 }) lineCount!: number;
  @ApiProperty({ example: 2 }) suppliersUsed!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1689 })
  baselineTotal!: number | null;

  @ApiProperty({ example: 1475 }) optimisedTotal!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 214 })
  savings!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 12.7 })
  savingsPercent!: number | null;

  @ApiProperty({ enum: SavingsKind, enumName: 'SavingsKind' }) savingsKind!: SavingsKind;

  @ApiPropertyOptional({ type: Number, nullable: true })
  realizedSavings!: number | null;

  @ApiProperty({
    description:
      'True when the optimiser capped its search — the answer is the best of what it tried.',
    example: false,
  })
  boundedSearch!: boolean;

  @ApiProperty({ description: 'How long the whole comparison took.', example: 2400 })
  durationMs!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 63 })
  combinationsEvaluated!: number | null;

  @ApiProperty({ description: 'Lines no supplier could fill.', example: 0 })
  unassignedLines!: number;

  @ApiProperty({ description: 'Orders placed against this decision.', example: 2 })
  ordersLinked!: number;

  @ApiProperty({ description: 'How many of those the buyer marked confirmed.', example: 2 })
  ordersConfirmed!: number;
}

export class AdminDecisionsPageDto {
  @ApiProperty({ type: AdminDecisionDto, isArray: true }) items!: AdminDecisionDto[];
  @ApiProperty({ example: 128 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}

export class DecisionAnalyticsDto {
  @ApiProperty({ example: 30 }) days!: number;

  @ApiProperty({ description: 'Decisions kept in the window.', example: 214 })
  decisions!: number;

  @ApiProperty({ description: 'Accounts that kept at least one.', example: 18 })
  customers!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 18.4 })
  averageBasketLines!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1.8 })
  averageSuppliersUsed!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 2410 })
  averageDurationMs!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 11.2 })
  averageSavingsPercent!: number | null;

  @ApiProperty({
    description:
      'Summed across decisions with no confirmed purchase behind them. Never added to `realizedSavings` — a decision counts towards one or the other.',
    example: 41280,
  })
  potentialSavings!: number;

  @ApiProperty({ description: 'Summed across decisions with confirmed orders.', example: 8140 })
  realizedSavings!: number;

  @ApiProperty({ description: 'Share of kept decisions that saved anything, 0–1.', example: 0.81 })
  shareWithSavings!: number;

  @ApiProperty({ description: 'Share whose plan splits across suppliers, 0–1.', example: 0.64 })
  shareSplit!: number;

  @ApiProperty({ example: 0.36 }) shareSingleSupplier!: number;

  @ApiProperty({
    description: 'Share where the optimiser had to cap its search. Worth watching, not alarming.',
    example: 0.02,
  })
  shareBoundedSearch!: number;

  @ApiProperty({
    description:
      'Share where no single supplier could have filled the order, so there was no saving to quote. Common and healthy; a problem only if it becomes everything.',
    example: 0.19,
  })
  shareWithoutBaseline!: number;

  @ApiProperty({ description: 'Decisions that turned into at least one order.', example: 96 })
  decisionsWithOrders!: number;

  @ApiProperty({ example: 141 }) ordersPlaced!: number;
}

/**
 * One customer's purchasing, for the account screen.
 *
 * Assembled to answer one question and no other: is this customer getting
 * enough out of the product to keep paying for it? Everything in it is either
 * a measure of value delivered or a measure of engagement, and the two savings
 * figures stay separate so the answer survives being quoted.
 */
export class CustomerPurchasingDto {
  @ApiProperty({ format: 'uuid' }) ownerId!: string;

  @ApiPropertyOptional({ type: String, nullable: true }) email!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) plan!: string | null;

  @ApiProperty({ example: 30 }) days!: number;

  @ApiProperty({ description: 'Decisions kept, all time.', example: 34 }) decisions!: number;
  @ApiProperty({ example: 9 }) decisionsInWindow!: number;

  @ApiProperty({ example: 4820 }) potentialSavings!: number;
  @ApiProperty({ example: 1284 }) realizedSavings!: number;
  @ApiProperty({ example: 1130 }) potentialSavingsInWindow!: number;
  @ApiProperty({ example: 386 }) realizedSavingsInWindow!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 21.5 })
  averageBasketLines!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 13.4 })
  averageSavingsPercent!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1.9 })
  averageSuppliersUsed!: number | null;

  @ApiProperty({ example: 22 }) orders!: number;

  @ApiProperty({
    description: 'Orders placed off a saved plan rather than assembled by hand.',
    example: 17,
  })
  ordersFromDecision!: number;

  @ApiProperty({ example: 14 }) ordersConfirmed!: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastDecisionAt!: string | null;

  @ApiProperty({
    description: 'Suppliers this customer’s decisions keep landing on.',
    type: 'array',
    items: {
      type: 'object',
      properties: { shopId: { type: 'string', format: 'uuid' }, decisions: { type: 'number' } },
    },
  })
  topSuppliers!: Array<{ shopId: string; decisions: number }>;
}
