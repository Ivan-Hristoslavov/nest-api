import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { numericTransformer } from '../../common/transformers/numeric-column.transformer';
import { PurchaseDecisionSnapshot } from '../purchase-decision.snapshot';

/**
 * How much of a saving we are entitled to claim.
 *
 * The distinction this product lives or dies by. "The optimiser says this plan
 * is €214 cheaper" and "you spent €214 less" are different sentences, and
 * printing the first in the place of the second is the single most damaging
 * thing a tool like this can do — it is the claim a customer will check against
 * their own accounts, and the one that ends the relationship when it does not
 * survive checking.
 *
 * So the default is `potential`, always, and it only becomes `realized` when
 * the system holds evidence that the purchase happened: an order per supplier
 * in the plan, and the buyer having marked each of them confirmed. Confirmation
 * is the one fact only the buyer knows — it happens in a phone call or a reply
 * we never see — which is precisely why it is the right gate. A saving inferred
 * from a draft nobody sent would be a guess wearing the word "realized".
 */
export enum SavingsKind {
  /** What the optimiser says the plan would have saved. */
  Potential = 'potential',
  /** What was saved on a purchase the buyer confirmed happened. */
  Realized = 'realized',
}

/**
 * A decision to buy, and the whole case for it.
 *
 * The product already answers "where should I buy this today". This is what
 * makes that answer still checkable in November: not the recommendation, but
 * the evidence behind it, frozen at the moment it was acted on.
 *
 * **Why a document column rather than six tables.** Everything in `snapshot`
 * is written once and read whole. It is never queried by an inner field, never
 * joined to, and never updated — which is the exact shape `jsonb` is for.
 * Modelling it relationally would buy nothing and cost a great deal: five or
 * six child tables, each needing its own guard against the updates that would
 * quietly rewrite history, and a read that fans out into six queries to
 * reassemble a document nobody wanted decomposed.
 *
 * **Why the flat columns alongside it.** Listing, filtering, sorting and
 * summing are the queries this table actually serves — "my decisions this
 * month, biggest saving first", "total potential savings this year". Those
 * cannot run off a jsonb document without reading every row, so the handful of
 * values they need are lifted out and indexed. They are a projection of the
 * snapshot, written from it at insert time and never independently.
 *
 * **Why nothing here is a foreign key to a supplier.** `supplier_ids` is an
 * array of ids for filtering, not a relation. Deleting a supplier must not
 * cascade into the record of an order that was placed with them, and renaming
 * one must not rewrite what last quarter's decision said. The names, the
 * discounts and the delivery terms all live in the snapshot, copied.
 */
@Entity('purchase_decisions')
// The list screen: this owner's decisions, newest first.
@Index('idx_purchase_decisions_owner_created', ['ownerId', 'createdAt'])
// The savings screen: this owner's decisions, biggest saving first.
@Index('idx_purchase_decisions_owner_savings', ['ownerId', 'savings'])
// Declared here as well as in the migration so `schema:log` does not propose
// dropping it. The GIN index on `supplier_ids` and the partial index on
// `orders.purchase_decision_id` cannot be expressed as decorators and stay
// migration-only — see the drift note in the README.
@Index('idx_purchase_decisions_owner_number', ['ownerId', 'number'], { unique: true })
export class PurchaseDecision {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  /**
   * Sequential within the account, like an order number.
   *
   * Per account rather than global, for the same reason orders are: "decision
   * #7" is a thing a buyer can say on the phone, and a number that jumps to
   * 4,812 tells them how many other customers exist.
   */
  @ApiProperty({ description: 'Decision number, sequential within this account.', example: 7 })
  @Column({ type: 'int' })
  number!: number;

  @ApiProperty({ example: 'EUR' })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiProperty({ description: 'Lines on the order this decision priced.', example: 25 })
  @Column({ name: 'line_count', type: 'int' })
  lineCount!: number;

  @ApiProperty({ description: 'Suppliers the chosen plan orders from.', example: 2 })
  @Column({ name: 'suppliers_used', type: 'int' })
  suppliersUsed!: number;

  /**
   * Every supplier who bore on this decision — chosen, beaten or refused.
   *
   * An array rather than a join table because the only question asked of it is
   * "which decisions involved this supplier", which a GIN index answers
   * directly, and because a join table would invite a foreign key that must not
   * exist. See the class comment.
   */
  @ApiProperty({ description: 'Suppliers involved, for filtering.', type: [String] })
  @Column({ name: 'supplier_ids', type: 'uuid', array: true, default: () => "'{}'" })
  supplierIds!: string[];

  @ApiPropertyOptional({
    description:
      'What the whole order would have cost at the cheapest single supplier who would have accepted it. Null when no single supplier could fill it.',
    type: Number,
    nullable: true,
    example: 1689,
  })
  @Column({
    name: 'baseline_total',
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  baselineTotal!: number | null;

  @ApiProperty({ description: 'What the chosen plan costs.', type: Number, example: 1475 })
  @Column({
    name: 'optimised_total',
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: numericTransformer,
  })
  optimisedTotal!: number;

  @ApiPropertyOptional({
    description:
      '`baselineTotal − optimisedTotal`, frozen. Null when there was no baseline to measure against — comparing a split order against a partial one compares two different purchases.',
    type: Number,
    nullable: true,
    example: 214,
  })
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  savings!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 12.7 })
  @Column({
    name: 'savings_percent',
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  savingsPercent!: number | null;

  @ApiProperty({
    enum: SavingsKind,
    enumName: 'SavingsKind',
    description:
      'Whether `savings` is what the plan would have saved, or what a confirmed purchase did save. Never presented as the latter without the orders to prove it.',
    example: SavingsKind.Potential,
  })
  @Index('idx_purchase_decisions_savings_kind')
  @Column({ name: 'savings_kind', type: 'varchar', length: 16, default: SavingsKind.Potential })
  savingsKind!: SavingsKind;

  @ApiPropertyOptional({
    description:
      'What was actually spent, on the lines that were ordered and confirmed. Null until that evidence exists.',
    type: Number,
    nullable: true,
  })
  @Column({
    name: 'realized_total',
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  realizedTotal!: number | null;

  @ApiPropertyOptional({
    description: '`baselineTotal − realizedTotal`. Null until the purchase is confirmed.',
    type: Number,
    nullable: true,
  })
  @Column({
    name: 'realized_savings',
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  realizedSavings!: number | null;

  @ApiProperty({ description: 'True when the optimiser had to cap its search.', example: false })
  @Column({ name: 'bounded_search', type: 'boolean', default: false })
  boundedSearch!: boolean;

  @ApiProperty({ description: 'How long the comparison took, end to end.', example: 2400 })
  @Column({ name: 'duration_ms', type: 'int', default: 0 })
  durationMs!: number;

  /**
   * The decision itself.
   *
   * Written once at insert and never updated. Everything above is a projection
   * of something in here; if the two ever disagree, this is the record and the
   * columns are the index.
   */
  @ApiProperty({ description: 'The whole decision, frozen.' })
  @Column({ type: 'jsonb' })
  snapshot!: PurchaseDecisionSnapshot;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /*
   * There is deliberately no `@UpdateDateColumn` and no `updatedAt`.
   *
   * Not an omission. A column named "updated at" on this table would be an
   * invitation to update it, and the one property this row has to keep is that
   * it never changes. The two realized-savings columns are the sole exception,
   * they are written by one method that appends evidence rather than revising a
   * claim, and the database refuses every other update outright — see the
   * trigger in the migration.
   */
}
