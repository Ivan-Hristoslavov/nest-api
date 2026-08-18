import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { DiscoveredProductDto } from '../dto/discovery.dto';

/**
 * What one shop last answered for one question.
 *
 * Not the catalogue crawl coming back. The crawl read every page a shop had,
 * whatever anyone wanted; this holds only answers somebody actually asked for,
 * so the cost still follows demand rather than the size of a supplier's
 * catalogue. Nothing is fetched to fill it.
 *
 * It exists because a basket is expensive and repetitive. Pricing forty lines
 * against a shop that must be read through its sitemap is forty times eight
 * page fetches — eleven minutes, which no one will wait for. And a buyer orders
 * the same cable every month: the second basket is the same questions again.
 * Cached, it answers instantly; uncached, the feature is unusable.
 *
 * The trade is staleness, and it is bounded and stated. A cached answer carries
 * the time it was fetched, the comparison passes that through, and the interface
 * shows it — the same treatment a hand-entered price gets, for the same reason.
 */
@Entity('search_cache')
@Index('idx_search_cache_lookup', ['shopId', 'query'], { unique: true })
export class SearchCache {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'shop_id', type: 'uuid' })
  shopId!: string;

  /** Normalised: trimmed, lowercased, whitespace collapsed. */
  @Column({ type: 'varchar', length: 160 })
  query!: string;

  @Column({ type: 'jsonb' })
  products!: DiscoveredProductDto[];

  /**
   * How long the answer took to obtain the first time.
   *
   * Kept so the saving is measurable rather than assumed — a cache nobody can
   * show the benefit of is a cache nobody trusts enough to size.
   */
  @Column({ name: 'duration_ms', type: 'int', default: 0 })
  durationMs!: number;

  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
