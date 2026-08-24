import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { numericTransformer } from '../../common/transformers/numeric-column.transformer';
import { Order } from './order.entity';

/**
 * One article on an order request.
 *
 * Everything here is a copy taken at the moment the order was built, not a
 * reference to something that can change underneath it. The supplier's page
 * may be edited tomorrow and the price with it; what the buyer sent, and what
 * the supplier received, has to stay exactly what it was — that is the whole
 * point of writing it down.
 */
@Entity('order_lines')
@Index('idx_order_lines_order', ['orderId'])
export class OrderLine {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.lines, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'order_id', foreignKeyConstraintName: 'fk_order_lines_order' })
  order?: Order;

  /**
   * What the buyer asked for, in their words.
   *
   * Kept alongside the supplier's own name for the article, because those are
   * two different facts and the difference is the thing a supplier needs to
   * resolve: "you sent me СВТ 3x2.5, I have ПВВ-МБ1 3х2,5, are they the same?"
   */
  @ApiProperty({ description: 'What the buyer asked for.', example: 'КАБЕЛ СВТ 3x2.5' })
  @Column({ type: 'varchar', length: 500 })
  query!: string;

  @ApiPropertyOptional({
    description: "The supplier's own name for the article, as their page had it.",
    nullable: true,
  })
  @Column({ name: 'matched_name', type: 'varchar', length: 500, nullable: true })
  matchedName!: string | null;

  @ApiPropertyOptional({ description: 'The page the price came from.', nullable: true })
  @Column({ type: 'text', nullable: true })
  url!: string | null;

  @ApiProperty({ example: 100 })
  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
  quantity!: number;

  @ApiProperty({
    description: 'Price per unit at the moment the order was built, after the buyer’s discount.',
    type: Number,
    example: 4.12,
  })
  @Column({
    name: 'unit_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  unitPrice!: number;

  @ApiProperty({ description: 'quantity × unitPrice.', type: Number, example: 412 })
  @Column({
    name: 'line_total',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  lineTotal!: number;
}
