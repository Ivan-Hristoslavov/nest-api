import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { NumericColumnTransformer } from '../../common/transformers/numeric-column.transformer';

/**
 * One question already put to a model, and the answer it gave.
 *
 * Two suppliers' names for an article do not change between Tuesday and
 * Wednesday, so asking twice buys nothing and costs twice. The fingerprint is
 * built from the *normalised* pair plus the model and prompt version, which
 * makes the cache self-invalidating in the two ways that matter: rename a
 * product and the fingerprint changes, change the prompt and every old answer
 * stops being consulted.
 */
@Entity('ai_match_cache')
@Index('idx_ai_match_cache_fingerprint', ['fingerprint'], { unique: true })
// Cache eviction reads by age.
@Index('idx_ai_match_cache_created', ['createdAt'])
export class MatchCache {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** sha256(normalised query | normalised candidate | model | prompt version). */
  @Column({ type: 'char', length: 64 })
  fingerprint!: string;

  @Column({ name: 'is_same', type: 'boolean' })
  isSame!: boolean;

  @Column({
    type: 'numeric',
    precision: 4,
    scale: 3,
    transformer: new NumericColumnTransformer(),
  })
  confidence!: number;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'varchar', length: 64 })
  model!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
