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
import { Competitor } from '../../products/entities/competitor.entity';
import { Product } from '../../products/entities/product.entity';
import { AlertDeliveryStatus, AlertSeverity, AlertType } from '../enums/alert.enums';

/**
 * A noteworthy event, persisted before any attempt to deliver it.
 *
 * Storing first and sending second means an alert survives a Slack outage, a
 * restart, or a misconfigured webhook: delivery state lives on the row and
 * failed alerts can be retried or inspected instead of vanishing into a log.
 */
@Entity('alerts')
@Index('idx_alerts_created', ['createdAt'])
@Index('idx_alerts_product_created', ['productId', 'createdAt'])
@Index('idx_alerts_unacknowledged', ['acknowledgedAt'])
export class Alert {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ format: 'uuid' })
  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @ManyToOne(() => Product, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'product_id' })
  product?: Product;

  @ApiPropertyOptional({
    description: 'Competitor listing that triggered the alert, when applicable.',
    format: 'uuid',
    nullable: true,
  })
  @Column({ name: 'competitor_id', type: 'uuid', nullable: true })
  competitorId!: string | null;

  @ManyToOne(() => Competitor, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'competitor_id' })
  competitor?: Competitor;

  @ApiProperty({ enum: AlertType, enumName: 'AlertType', example: AlertType.Undercut })
  @Column({ type: 'enum', enum: AlertType })
  type!: AlertType;

  @ApiProperty({
    enum: AlertSeverity,
    enumName: 'AlertSeverity',
    example: AlertSeverity.Critical,
  })
  @Column({ type: 'enum', enum: AlertSeverity, default: AlertSeverity.Info })
  severity!: AlertSeverity;

  @ApiProperty({
    description: 'Human readable summary, reused verbatim by the notification channels.',
    example: 'Competitor A now sells Sony WH-1000XM5 at 289.99 EUR — 6.8% below your target.',
  })
  @Column({ type: 'text' })
  message!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 309.0 })
  @Column({
    name: 'old_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  oldPrice!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 289.99 })
  @Column({
    name: 'new_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  newPrice!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: -6.15 })
  @Column({
    name: 'change_percent',
    type: 'numeric',
    precision: 8,
    scale: 4,
    nullable: true,
    transformer: numericTransformer,
  })
  changePercent!: number | null;

  @ApiProperty({ example: 'EUR' })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiProperty({
    enum: AlertDeliveryStatus,
    enumName: 'AlertDeliveryStatus',
    example: AlertDeliveryStatus.Delivered,
  })
  @Column({
    name: 'delivery_status',
    type: 'enum',
    enum: AlertDeliveryStatus,
    default: AlertDeliveryStatus.Pending,
  })
  deliveryStatus!: AlertDeliveryStatus;

  @ApiPropertyOptional({
    description: 'Channels the alert reached, e.g. ["slack","webhook"].',
    type: [String],
    nullable: true,
  })
  @Column({ name: 'delivered_channels', type: 'text', array: true, nullable: true })
  deliveredChannels!: string[] | null;

  @ApiPropertyOptional({ description: 'Why delivery failed.', nullable: true })
  @Column({ name: 'delivery_error', type: 'text', nullable: true })
  deliveryError!: string | null;

  @ApiPropertyOptional({
    description: 'Set when a human marked the alert as handled.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'acknowledged_at', type: 'timestamptz', nullable: true })
  acknowledgedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
