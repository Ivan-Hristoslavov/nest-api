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
export class Product {
  @ApiProperty({
    description: 'Primary key.',
    format: 'uuid',
    example: '6b0d9b4a-4a4e-4d51-9e2c-1f2f6f7f9a10',
  })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

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

  @ApiProperty({
    description: 'Our own product page — the listing whose price we defend.',
    format: 'uri',
    example: 'https://shop.example.com/products/sony-wh-1000xm5',
  })
  @Column({ name: 'target_url', type: 'text' })
  targetUrl!: string;

  @ApiProperty({
    description: 'Competitor product page that the scraper fetches.',
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
    description: 'Latest scraped competitor price. Null until the first successful scrape.',
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

  @OneToMany(() => PriceHistory, (priceHistory) => priceHistory.product)
  priceHistory?: PriceHistory[];
}
