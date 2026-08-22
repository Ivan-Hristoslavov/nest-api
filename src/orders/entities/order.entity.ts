import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../common/transformers/numeric-column.transformer';
import { OrderLine } from './order-line.entity';

/**
 * Where an order request has got to.
 *
 * Only `Draft` and `Sent` are things this system knows for itself. Whether the
 * supplier confirmed it happens in a phone call or a reply we never see, so
 * the last two are marked by the buyer. Inventing a "confirmed" state from a
 * delivery receipt would be a guess presented as a fact, and an order is
 * exactly the wrong place for one.
 */
export enum OrderStatus {
  Draft = 'draft',
  Sent = 'sent',
  Confirmed = 'confirmed',
  Cancelled = 'cancelled',
}

/**
 * A request to buy, addressed to one supplier.
 *
 * The product answers "where should I buy this today"; this is the sentence
 * after it. Deliberately a *request*, not a transaction: no money moves
 * through here, no stock is reserved, and the email that goes out is from the
 * buyer's company rather than from us. We are the tool that worked out where
 * to send it, not a party to the sale — which is both the honest description
 * and the one that keeps us out of a commercial dispute between two other
 * companies.
 *
 * One order per supplier. A basket split across three warehouses is three of
 * these, because that is three separate conversations, three deliveries and
 * three invoices.
 */
@Entity('orders')
@Index('idx_orders_owner_created', ['ownerId', 'createdAt'])
@Index('idx_orders_owner_number', ['ownerId', 'number'], { unique: true })
export class Order {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  /**
   * Sequential per account, starting at 1.
   *
   * Per account rather than global: a buyer's third order is "#3" to them, and
   * a number that jumps to 4,812 because other customers exist tells them how
   * many other customers exist. It is also what they will quote down the phone.
   */
  @ApiProperty({ description: 'Order number, sequential within this account.', example: 3 })
  @Column({ type: 'int' })
  number!: number;

  @ApiProperty({ format: 'uuid', description: 'Supplier this order goes to.' })
  @Column({ name: 'shop_id', type: 'uuid' })
  shopId!: string;

  /**
   * The supplier's name as it was when the order was made.
   *
   * Copied rather than joined. An order is a record of something that
   * happened, and renaming a supplier next year must not silently rewrite what
   * last year's order said.
   */
  @ApiProperty({ example: 'Електро Склад' })
  @Column({ name: 'shop_name', type: 'varchar', length: 255 })
  shopName!: string;

  @ApiPropertyOptional({ nullable: true, example: 'orders@supplier.bg' })
  @Column({ name: 'shop_email', type: 'varchar', length: 320, nullable: true })
  shopEmail!: string | null;

  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus', example: OrderStatus.Draft })
  @Index('idx_orders_status')
  @Column({ type: 'varchar', length: 16, default: OrderStatus.Draft })
  status!: OrderStatus;

  @ApiProperty({ example: 'EUR' })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiProperty({
    description: 'Sum of the lines, at the prices shown when the order was built.',
    type: Number,
    example: 412.6,
  })
  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
  total!: number;

  @ApiPropertyOptional({
    description: 'Anything the buyer wants the supplier to read.',
    nullable: true,
  })
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  @ApiProperty({ type: () => OrderLine, isArray: true })
  @OneToMany(() => OrderLine, (line) => line.order, { cascade: ['insert'], eager: true })
  lines!: OrderLine[];

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /** Whether this can still be edited. Once it has gone out, it has gone out. */
  isEditable(): boolean {
    return this.status === OrderStatus.Draft;
  }
}
