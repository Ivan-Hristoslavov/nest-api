import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { numericTransformer } from '../../common/transformers/numeric-column.transformer';
import { Competitor } from './competitor.entity';
import { Product } from './product.entity';

/**
 * Append-only log of observed competitor prices.
 *
 * `Product.currentPrice` answers "what is the price now"; this table answers
 * "how did it get there" — the actual product of a price-intelligence system
 * (trend charts, undercut detection, repricing rules).
 */
@Entity('price_history')
@Index('idx_price_history_product_recorded', ['productId', 'recordedAt'])
@Index('idx_price_history_competitor_recorded', ['competitorId', 'recordedAt'])
export class PriceHistory {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ description: 'Product this observation belongs to.', format: 'uuid' })
  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @ManyToOne(() => Product, (product) => product.priceHistory, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product?: Product;

  @ApiPropertyOptional({
    description:
      'Competitor listing the price came from. Null for manual entries and rows written before multi-competitor tracking.',
    format: 'uuid',
    nullable: true,
  })
  @Column({ name: 'competitor_id', type: 'uuid', nullable: true })
  competitorId!: string | null;

  @ManyToOne(() => Competitor, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'competitor_id' })
  competitor?: Competitor;

  @ApiProperty({ description: 'Observed price.', type: Number, example: 289.99 })
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  price!: number;

  @ApiPropertyOptional({
    description: 'Price recorded immediately before this observation.',
    type: Number,
    example: 309.0,
    nullable: true,
  })
  @Column({
    name: 'previous_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  previousPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Signed relative change against the previous price, in percent.',
    type: Number,
    example: -6.15,
    nullable: true,
  })
  @Column({
    name: 'change_percent',
    type: 'numeric',
    precision: 8,
    scale: 4,
    nullable: true,
    transformer: numericTransformer,
  })
  changePercent!: number | null;

  @ApiProperty({ description: 'ISO-4217 currency code.', example: 'EUR' })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiProperty({
    description: 'Where the observation came from (competitor host or "manual").',
    example: 'competitor.example.com',
  })
  @Column({ type: 'varchar', length: 255 })
  source!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;
}
