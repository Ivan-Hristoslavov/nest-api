import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../common/transformers/numeric-column.transformer';
import { Shop } from './shop.entity';

/**
 * A price the buyer entered by hand, for a supplier with no website.
 *
 * The tool reads shops that publish prices. The supplier who is often
 * *cheapest* publishes nothing: the small local warehouse two streets away
 * with no site, who sends an Excel price list by email or quotes down the
 * phone. Comparing only what can be scraped means comparing the wrong set and
 * confidently naming the wrong winner.
 *
 * So these rows sit beside the scraped offers in the same ranking, with the
 * same discount applied. What separates them is honesty about age: a price
 * read from a page seconds ago and one typed in three weeks ago are not the
 * same claim, and {@link updatedAt} is shown next to every hand-entered row.
 */
@Entity('manual_prices')
// The whole point is looking these up by shop while searching.
@Index('idx_manual_prices_shop', ['shopId'])
export class ManualPrice {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ format: 'uuid' })
  @Column({ name: 'shop_id', type: 'uuid' })
  shopId!: string;

  @ManyToOne(() => Shop, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'shop_id' })
  shop?: Shop;

  @ApiProperty({
    description: 'The article, as this supplier calls it on their price list.',
    example: 'КАБЕЛ СВТ 3x2.5',
  })
  @Column({ type: 'varchar', length: 300 })
  name!: string;

  @ApiPropertyOptional({
    description: "The supplier's own article number, when their list states one.",
    nullable: true,
    example: 'SVT-3X25',
  })
  @Column({ name: 'shop_code', type: 'varchar', length: 120, nullable: true })
  shopCode!: string | null;

  @ApiProperty({
    description:
      'Price as the supplier quotes it, before your discount. The comparison applies the discount, exactly as it does for a scraped price.',
    example: 1.42,
  })
  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericTransformer })
  price!: number;

  @ApiProperty({ example: 'EUR' })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiPropertyOptional({
    description: 'What the price is per — metre, piece, roll. Free text, as the list says it.',
    nullable: true,
    example: 'м',
  })
  @Column({ type: 'varchar', length: 32, nullable: true })
  unit!: string | null;

  @ApiPropertyOptional({
    description: 'Where this figure came from: an emailed list, a phone call, a visit.',
    nullable: true,
    example: 'ценоразпис по имейл, 12.08',
  })
  @Column({ type: 'varchar', length: 255, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /**
   * When the figure was last confirmed.
   *
   * The most important column on the row. A hand-entered price has no way of
   * going stale on its own — nothing re-reads it — so the age is the only
   * thing telling the buyer whether to trust it against a live one.
   */
  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
