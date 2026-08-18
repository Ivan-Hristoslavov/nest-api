import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../common/transformers/numeric-column.transformer';
import { Shop } from './shop.entity';

/**
 * One product page at one shop, as we last read it.
 *
 * This is our own copy of the shop's catalogue, not a live view. It exists so
 * a search can answer in milliseconds without touching anyone's servers — and
 * so it works at all for shops whose search is client-side or closed to
 * crawlers while their product pages are open.
 *
 * `lastSeenAt` says how stale the number is, and the UI shows it. A price from
 * three weeks ago presented as today's price is worse than no price.
 */
@Entity('offers')
// One row per product page. A re-crawl updates, never duplicates.
@Unique('uq_offers_shop_url', ['shopId', 'url'])
@Index('idx_offers_shop_price', ['shopId', 'price'])
export class Offer {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ format: 'uuid' })
  @Column({ name: 'shop_id', type: 'uuid' })
  shopId!: string;

  @ManyToOne(() => Shop, (shop) => shop.offers, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'shop_id' })
  shop?: Shop;

  @ApiProperty({ format: 'uri' })
  @Column({ type: 'text' })
  url!: string;

  @ApiProperty({ example: 'Лампа LED 5W/E14 4000K 400lm' })
  @Column({ type: 'varchar', length: 500 })
  name!: string;

  @ApiPropertyOptional({
    description: "The shop's own article number, when the page states one.",
    nullable: true,
  })
  @Column({ name: 'shop_code', type: 'varchar', length: 120, nullable: true })
  shopCode!: string | null;

  @ApiPropertyOptional({
    description: 'Barcode, when stated. The only reliable way to prove two shops sell one item.',
    nullable: true,
  })
  @Column({ type: 'varchar', length: 14, nullable: true })
  gtin!: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 0.98 })
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  price!: number | null;

  @ApiProperty({ example: 'EUR' })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiPropertyOptional({ nullable: true })
  @Column({ name: 'in_stock', type: 'boolean', nullable: true })
  inStock!: boolean | null;

  @ApiPropertyOptional({ format: 'uri', nullable: true })
  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl!: string | null;

  @ApiPropertyOptional({
    description: 'When this page was last read successfully.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @ApiPropertyOptional({ description: 'Why the last read failed.', nullable: true })
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
