import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { SavedSearch } from './saved-search.entity';

/**
 * What the shops said, the moment they said it.
 *
 * Written once and never updated. That is not a convention here, it is the
 * feature: a buyer who compared prices on Sunday and placed the order on
 * Monday needs to see the numbers they decided on, not the numbers that
 * replaced them. A snapshot that drifted with the shop would answer the wrong
 * question — "what does it cost now" — and the buyer already has a Refresh
 * button for that.
 *
 * The whole comparison lives in `payload`, exactly as the API returned it:
 * matches, alternatives, offers, the chosen best, every shop's own outcome
 * including the ones that failed or timed out. Restoring a search is therefore
 * handing that document back, not recomputing anything — which is what makes a
 * browser refresh cost one indexed read instead of a dozen HTTP requests to
 * other people's servers.
 *
 * The flat columns beside it are a projection of the same document. Postgres
 * cannot index into a jsonb value without reading every row, so the counts and
 * the status the history list needs are lifted out and indexed, and the
 * document is read only when a search is actually opened.
 */
@Entity('search_snapshots')
/** The only hot query: this search's snapshots, newest first. */
@Index('idx_search_snapshots_search_fetched', ['searchId', 'fetchedAt'])
/**
 * The owner is repeated here rather than joined for.
 *
 * Authorisation is the reason. Checking that a snapshot belongs to the caller
 * should not depend on remembering to join its parent — the check that is
 * easiest to write must also be the safe one, or eventually somebody writes
 * the other one.
 */
@Index('idx_search_snapshots_owner_fetched', ['ownerId', 'fetchedAt'])
export class SearchSnapshot {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ format: 'uuid' })
  @Column({ name: 'search_id', type: 'uuid' })
  searchId!: string;

  @ApiProperty({ format: 'uuid' })
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @ApiProperty({
    description: 'What this run concluded.',
    enum: ['MATCH', 'ALTERNATIVE', 'NO_MATCH'],
  })
  @Column({ type: 'varchar', length: 16 })
  status!: 'MATCH' | 'ALTERNATIVE' | 'NO_MATCH';

  @ApiProperty({ description: 'Offers a buyer could act on. Matches only.' })
  @Column({ name: 'offer_count', type: 'int', default: 0 })
  offerCount!: number;

  @ApiProperty({ description: 'Genuinely related articles that are not the one asked for.' })
  @Column({ name: 'alternative_count', type: 'int', default: 0 })
  alternativeCount!: number;

  @ApiProperty({ description: 'Shops asked in this run.' })
  @Column({ name: 'shops_asked', type: 'int', default: 0 })
  shopsAsked!: number;

  @ApiProperty({
    description:
      'Shops that answered. Lower than `shopsAsked` whenever one refused, failed or ran out of time — and that difference is part of what the snapshot preserves, so reopening a search does not silently retry the shops that were down.',
  })
  @Column({ name: 'shops_answered', type: 'int', default: 0 })
  shopsAnswered!: number;

  @ApiPropertyOptional({ description: 'The cheapest offer this run found, for the list.' })
  @Column({
    name: 'best_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value === null ? null : Number(value)),
    },
  })
  bestPrice!: number | null;

  @ApiPropertyOptional({ nullable: true })
  @Column({ name: 'best_currency', type: 'char', length: 3, nullable: true })
  bestCurrency!: string | null;

  @ApiProperty({ description: 'How long this run took, end to end.' })
  @Column({ name: 'duration_ms', type: 'int', default: 0 })
  durationMs!: number;

  /**
   * The comparison itself, as the API returned it.
   *
   * Everything the interface needs to draw the same screen again: the offers
   * with their prices, currencies, availability, financing and match verdicts,
   * the alternatives, the per-shop outcomes and errors. Stored rather than
   * referenced, because every one of those facts is a live row somewhere that
   * moves — which is exactly why recomputing it later gives a different answer.
   */
  @ApiProperty({ type: 'object', additionalProperties: true })
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /**
   * When the shops were asked — not when the row was written.
   *
   * The two differ by however long the search took, and it is the first that
   * the buyer is told and that staleness is measured from.
   */
  @ApiProperty()
  @Column({ name: 'fetched_at', type: 'timestamptz' })
  fetchedAt!: Date;

  @ManyToOne(() => SavedSearch, (search) => search.snapshots, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'search_id' })
  search?: SavedSearch;
}
