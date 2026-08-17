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
import { ScrapeStatus } from '../enums/scrape-status.enum';
import { Product } from './product.entity';

/**
 * One competitor listing for a product.
 *
 * A product is rarely sold by a single rival, and "the market price" is the
 * cheapest of several. Each competitor carries its own URL, its own scrape
 * state and its own price, so a failing retailer never hides the others.
 *
 * `Product.currentPrice` is derived from these rows: it is the lowest price
 * among the active competitors.
 */
@Entity('competitors')
// Prevents the same listing being tracked twice for one product.
@Unique('uq_competitors_product_url', ['productId', 'url'])
// Drives the scraper queue: active listings, least recently checked first.
@Index('idx_competitors_active_last_checked', ['isActive', 'lastCheckedAt'])
export class Competitor {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ description: 'Product this listing belongs to.', format: 'uuid' })
  @Column({ name: 'product_id', type: 'uuid' })
  productId!: string;

  @ManyToOne(() => Product, (product) => product.competitors, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'product_id' })
  product?: Product;

  @ApiProperty({
    description: 'Retailer name, for readable alerts and dashboards.',
    maxLength: 120,
    example: 'Competitor A',
  })
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @ApiProperty({
    description: 'Product page to scrape.',
    format: 'uri',
    example: 'https://competitor-a.example.com/audio/sony-wh-1000xm5',
  })
  @Column({ type: 'text' })
  url!: string;

  @ApiProperty({
    description: 'Hostname extracted from the URL. Used for per-host rate limiting.',
    example: 'competitor-a.example.com',
  })
  @Column({ type: 'varchar', length: 255 })
  host!: string;

  @ApiProperty({
    description: 'The primary listing mirrors `Product.competitorUrl`. Exactly one per product.',
    example: true,
  })
  @Column({ name: 'is_primary', type: 'boolean', default: false })
  isPrimary!: boolean;

  @ApiProperty({ description: 'Inactive listings are skipped by the sweep.', example: true })
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @ApiPropertyOptional({
    description:
      'CSS selector pointing at the price element. Only needed when the page exposes no structured data (JSON-LD / microdata / meta tags), which the parser tries first.',
    maxLength: 255,
    example: '.product-price__amount',
    nullable: true,
  })
  @Column({ name: 'price_selector', type: 'varchar', length: 255, nullable: true })
  priceSelector!: string | null;

  @ApiPropertyOptional({
    description:
      'Attribute to read the price from instead of the element text (e.g. "content", "data-price").',
    maxLength: 64,
    example: 'content',
    nullable: true,
  })
  @Column({ name: 'price_attribute', type: 'varchar', length: 64, nullable: true })
  priceAttribute!: string | null;

  @ApiProperty({ description: 'ISO-4217 currency code for this listing.', example: 'EUR' })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiPropertyOptional({
    description: 'Latest observed price at this competitor.',
    type: Number,
    example: 289.99,
    nullable: true,
  })
  @Column({
    name: 'current_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  currentPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Price observed before the most recent change.',
    type: Number,
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
    description: 'Whether the listing reported the item as in stock on the last check.',
    nullable: true,
  })
  @Column({ name: 'in_stock', type: 'boolean', nullable: true })
  inStock!: boolean | null;

  @ApiPropertyOptional({
    description: 'When this listing last changed price.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'last_updated', type: 'timestamptz', nullable: true })
  lastUpdated!: Date | null;

  @ApiPropertyOptional({
    description: 'When this listing was last fetched, successfully or not.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  @ApiProperty({ enum: ScrapeStatus, enumName: 'ScrapeStatus' })
  @Column({
    name: 'scrape_status',
    type: 'enum',
    enum: ScrapeStatus,
    default: ScrapeStatus.Pending,
  })
  scrapeStatus!: ScrapeStatus;

  @ApiPropertyOptional({ description: 'Reason for the last failure.', nullable: true })
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @ApiProperty({ description: 'Consecutive failures. Reset to 0 on success.', example: 0 })
  @Column({ name: 'failure_count', type: 'int', default: 0 })
  failureCount!: number;

  @ApiPropertyOptional({
    description: 'Which extraction strategy produced the last price.',
    example: 'json-ld',
    nullable: true,
  })
  @Column({ name: 'last_strategy', type: 'varchar', length: 32, nullable: true })
  lastStrategy!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
