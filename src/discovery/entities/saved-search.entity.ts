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

import { SearchSnapshot } from './search-snapshot.entity';

/**
 * A question the buyer asked, kept apart from the answers it got.
 *
 * The distinction is the whole point of this table. "Bosch GSR 18V" is one
 * question a buyer returns to — this morning, this afternoon, next week — and
 * each asking produces a different set of prices. Storing the question and the
 * answer together would mean either losing the older prices or duplicating the
 * question, and the buyer wants neither: they want to see that this article was
 * 149.99 € on Sunday and 159.99 € on Monday, under one heading.
 *
 * So a search is a stable row that accumulates {@link SearchSnapshot}s. Asking
 * the same thing again does not create a second history entry; it adds a
 * snapshot to the one that exists and moves `updatedAt`.
 *
 * Scoped to an owner like every other table here, and for the same reason: the
 * comparison ranks by each customer's negotiated discount, so a search anybody
 * could open by guessing an id would publish the terms one buyer agreed with a
 * supplier.
 */
@Entity('saved_searches')
/**
 * The history screen's only query: this owner's searches, most recent first.
 * On `updatedAt` rather than `createdAt`, because a question asked again
 * belongs at the top of the list, not where it first appeared.
 */
@Index('idx_saved_searches_owner_updated', ['ownerId', 'updatedAt'])
/**
 * One row per question per scope.
 *
 * The scope is part of the identity: "at my suppliers" and "everywhere" are
 * different questions with different answers, and folding them together would
 * make a snapshot's shop list depend on which button was pressed last.
 *
 * Unique so that asking again appends rather than accumulating near-duplicate
 * history entries — and so that the append can be an upsert rather than a
 * read-then-write, which is what makes two simultaneous identical searches
 * safe.
 */
@Index('idx_saved_searches_owner_query', ['ownerId', 'normalisedQuery', 'scope'], { unique: true })
export class SavedSearch {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ format: 'uuid' })
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @ApiProperty({
    description: 'What the buyer typed, kept exactly as they typed it.',
    example: 'Bosch GSR 18V',
  })
  @Column({ type: 'varchar', length: 160 })
  query!: string;

  /**
   * The same question with the noise taken out, used only to decide whether
   * two askings are the same asking.
   *
   * Deliberately shallow — case and whitespace and nothing else. The matching
   * engine already knows that "GSR 18V" and "GSR18V" describe one article, and
   * that judgement belongs there, on the results. Applying it here would fold
   * "GSR 18V" and "GSR 18V-2" into one history entry, and they are two
   * different tools a buyer would be alarmed to see merged.
   */
  @ApiProperty({ example: 'bosch gsr 18v' })
  @Column({ name: 'normalised_query', type: 'varchar', length: 160 })
  normalisedQuery!: string;

  @ApiProperty({
    description: 'Where this search looked. Part of the question, not a filter on it.',
    enum: ['my_suppliers', 'global'],
  })
  @Column({ type: 'varchar', length: 16, default: 'my_suppliers' })
  scope!: 'my_suppliers' | 'global';

  @ApiProperty({ description: 'How many times this question has been asked.' })
  @Column({ name: 'run_count', type: 'int', default: 1 })
  runCount!: number;

  @ApiPropertyOptional({
    description:
      'What the most recent asking concluded, copied here so the history list can be drawn without reading a snapshot per row.',
    enum: ['MATCH', 'ALTERNATIVE', 'NO_MATCH'],
    nullable: true,
  })
  @Column({ name: 'last_status', type: 'varchar', length: 16, nullable: true })
  lastStatus!: 'MATCH' | 'ALTERNATIVE' | 'NO_MATCH' | null;

  @ApiPropertyOptional({
    description: 'Offers the most recent asking produced. A projection, for the same reason.',
  })
  @Column({ name: 'last_offer_count', type: 'int', default: 0 })
  lastOfferCount!: number;

  @ApiPropertyOptional({
    description:
      'The cheapest offer the most recent run found, or null where it found none. A copy of the newest snapshot\u2019s figure, kept here so a list of twenty searches costs one query instead of twenty documents.',
    nullable: true,
  })
  @Column({
    name: 'last_best_price',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value === null ? null : Number(value)),
    },
  })
  lastBestPrice!: number | null;

  @ApiPropertyOptional({ nullable: true })
  @Column({ name: 'last_best_currency', type: 'char', length: 3, nullable: true })
  lastBestCurrency!: string | null;

  @ApiPropertyOptional({ description: 'When the suppliers were last actually asked.' })
  @Column({ name: 'last_run_at', type: 'timestamptz', nullable: true })
  lastRunAt!: Date | null;

  @ApiProperty()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => SearchSnapshot, (snapshot) => snapshot.search)
  snapshots?: SearchSnapshot[];
}
