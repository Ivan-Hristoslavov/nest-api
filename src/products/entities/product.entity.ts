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
import { ScrapeStatus } from '../enums/scrape-status.enum';
import { Competitor } from './competitor.entity';
import { PriceHistory } from './price-history.entity';

/**
 * A product whose competitor price we track.
 *
 * Column names are snake_case (Postgres convention, readable in the Supabase
 * table editor); TypeScript properties stay camelCase (NestJS convention).
 * Monetary columns are `numeric(12,2)` — never floats — and are converted to
 * `number` by {@link numericTransformer}.
 */
@Entity('products')
// Drives the scheduler queue: "active products, least recently checked first".
@Index('idx_products_active_last_checked', ['isActive', 'lastCheckedAt'])
@Index('idx_products_competitor_url', ['competitorUrl'])
// The dashboard groups and filters by brand and by category; without these two
// every such view is a sequential scan over the whole catalogue.
@Index('idx_products_owner', ['ownerId'])
@Index('idx_products_brand', ['brand'])
@Index('idx_products_category', ['category'])
export class Product {
  @ApiProperty({
    description: 'Primary key.',
    format: 'uuid',
    example: '6b0d9b4a-4a4e-4d51-9e2c-1f2f6f7f9a10',
  })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The account this product belongs to.
   *
   * Every query is filtered by it. What this protects is not merely privacy:
   * the comparison ranks by each customer's *negotiated discount*, and a
   * supplier discount is a commercial secret. Two customers sharing a table
   * would be reading each other's terms.
   */
  @ApiProperty({ description: 'Owning account.', format: 'uuid' })
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @ApiProperty({
    description: 'Human readable product name.',
    maxLength: 255,
    example: 'Sony WH-1000XM5 Wireless Headphones',
  })
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @ApiPropertyOptional({
    description: 'Internal stock keeping unit. Unique when present.',
    maxLength: 64,
    example: 'SKU-WH1000XM5-BLK',
  })
  @Column({ type: 'varchar', length: 64, nullable: true, unique: true })
  sku!: string | null;

  @ApiPropertyOptional({
    description:
      'Brand as it appears on the box — what a buyer searches for. Kept separate from the manufacturer: Redmi is a brand of Xiaomi, Specna Arms of Global Airsoft.',
    maxLength: 120,
    nullable: true,
    example: 'Samsung',
  })
  @Column({ type: 'varchar', length: 120, nullable: true })
  brand!: string | null;

  @ApiPropertyOptional({
    description: 'Legal manufacturer or importer. Useful when negotiating, and for warranty terms.',
    maxLength: 160,
    nullable: true,
    example: 'Samsung Electronics Co., Ltd.',
  })
  @Column({ type: 'varchar', length: 160, nullable: true })
  manufacturer!: string | null;

  @ApiPropertyOptional({
    description: 'Manufacturer model designation, distinct from our own SKU.',
    maxLength: 120,
    nullable: true,
    example: 'QE55Q7F2AUXXH',
  })
  @Column({ type: 'varchar', length: 120, nullable: true })
  model!: string | null;

  @ApiPropertyOptional({
    description: 'Catalogue category, used to group the dashboard.',
    maxLength: 120,
    nullable: true,
    example: 'Телевизори',
  })
  @Column({ type: 'varchar', length: 120, nullable: true })
  category!: string | null;

  @ApiPropertyOptional({
    description:
      'EAN-13 / UPC / GTIN-14 barcode. The only identifier shared across shops, so it is what matches our row to theirs.',
    maxLength: 14,
    nullable: true,
    example: '8806095507415',
  })
  @Column({ type: 'varchar', length: 14, nullable: true })
  gtin!: string | null;

  @ApiPropertyOptional({
    description: 'Product image, for the catalogue view.',
    format: 'uri',
    nullable: true,
  })
  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl!: string | null;

  @ApiPropertyOptional({
    description:
      'Free-form specification sheet — whatever the category needs, without a migration per attribute.',
    nullable: true,
    example: { Диагонал: '55"', Резолюция: '4K UHD', Панел: 'QLED' },
  })
  @Column({ type: 'jsonb', nullable: true })
  attributes!: Record<string, string> | null;

  @ApiPropertyOptional({
    description: 'Internal note — supply terms, minimum order quantity, whatever the buyer needs.',
    nullable: true,
  })
  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @ApiProperty({
    description: 'Our own product page — the listing whose price we defend.',
    format: 'uri',
    example: 'https://shop.example.com/products/sony-wh-1000xm5',
  })
  @Column({ name: 'target_url', type: 'text' })
  targetUrl!: string;

  @ApiProperty({
    description:
      'Primary competitor page. Denormalised from the primary row in `competitors` and kept in sync by ProductsService — a product may track several rivals.',
    format: 'uri',
    example: 'https://competitor.example.com/audio/sony-wh-1000xm5',
  })
  @Column({ name: 'competitor_url', type: 'text' })
  competitorUrl!: string;

  @ApiProperty({
    description: 'ISO-4217 currency code for every price on this record.',
    minLength: 3,
    maxLength: 3,
    example: 'EUR',
  })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiPropertyOptional({
    description:
      'Cheapest price across all active competitors — the market price we react to. Null until the first successful scrape.',
    type: Number,
    format: 'double',
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
    description: 'Competitor price observed before the most recent change.',
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
    description: 'Price floor we want to stay above. Used to flag undercutting.',
    type: Number,
    example: 279.0,
    nullable: true,
  })
  @Column({
    name: 'target_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  targetPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Lowest competitor price ever recorded.',
    type: Number,
    example: 259.99,
    nullable: true,
  })
  @Column({
    name: 'lowest_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  lowestPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Highest competitor price ever recorded.',
    type: Number,
    example: 349.0,
    nullable: true,
  })
  @Column({
    name: 'highest_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  highestPrice!: number | null;

  @ApiPropertyOptional({
    description: 'When the price last actually changed (not merely re-checked).',
    type: String,
    format: 'date-time',
    example: '2026-08-17T08:00:12.004Z',
    nullable: true,
  })
  @Column({ name: 'last_updated', type: 'timestamptz', nullable: true })
  lastUpdated!: Date | null;

  @ApiPropertyOptional({
    description: 'When the scraper last attempted this product, successful or not.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  @ApiProperty({
    description: 'Outcome of the most recent scrape attempt.',
    enum: ScrapeStatus,
    enumName: 'ScrapeStatus',
    example: ScrapeStatus.Success,
  })
  @Column({
    name: 'scrape_status',
    type: 'enum',
    enum: ScrapeStatus,
    default: ScrapeStatus.Pending,
  })
  scrapeStatus!: ScrapeStatus;

  @ApiPropertyOptional({
    description: 'Error message from the last failed scrape.',
    nullable: true,
    example: 'Timed out after 10000ms',
  })
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @ApiProperty({
    description: 'Consecutive failed scrape attempts. Reset to 0 on success.',
    example: 0,
  })
  @Column({ name: 'failure_count', type: 'int', default: 0 })
  failureCount!: number;

  @ApiProperty({
    description: 'Inactive products are skipped by the scheduled sweep.',
    example: true,
  })
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @ApiProperty({
    description: 'Desired minimum interval between two scrapes, in minutes.',
    minimum: 5,
    example: 60,
  })
  @Column({ name: 'check_interval_minutes', type: 'int', default: 60 })
  checkIntervalMinutes!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ApiPropertyOptional({
    description: 'Competitor listing currently offering the lowest price.',
    format: 'uuid',
    nullable: true,
  })
  @Column({ name: 'cheapest_competitor_id', type: 'uuid', nullable: true })
  cheapestCompetitorId!: string | null;

  @ApiProperty({ description: 'Number of active competitor listings tracked.', example: 3 })
  @Column({ name: 'competitor_count', type: 'int', default: 0 })
  competitorCount!: number;

  @ApiPropertyOptional({
    description: 'Our own price, for margin and undercut reporting.',
    type: Number,
    nullable: true,
    example: 299.0,
  })
  @Column({
    name: 'our_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  ourPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Competitor listings tracked for this product.',
    type: () => [Competitor],
  })
  @OneToMany(() => Competitor, (competitor) => competitor.product)
  competitors?: Competitor[];

  @OneToMany(() => PriceHistory, (priceHistory) => priceHistory.product)
  priceHistory?: PriceHistory[];
}
