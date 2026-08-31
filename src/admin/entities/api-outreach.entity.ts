import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum OutreachStatus {
  /** Written and sent; nothing back yet. */
  Sent = 'sent',
  /** They answered, and the answer is still being worked out. */
  Replied = 'replied',
  /** They said yes — credentials or a feed followed. */
  Granted = 'granted',
  /** They said no. Worth recording so nobody writes again next quarter. */
  Declined = 'declined',
}

/**
 * One approach to one supplier site, asking for a feed instead of a scraper.
 *
 * Keyed by host rather than by shop row: the same wholesaler is a separate
 * `shops` row for every customer who added it, and writing to them once per
 * customer is how a partnership request turns into spam. One host, one letter,
 * one answer.
 *
 * The sent copy is stored rather than re-rendered from the template. Templates
 * get edited, and "what did we actually promise them" is a question that has
 * to survive the next edit.
 */
@Entity('api_outreach')
export class ApiOutreach {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ example: 'partner.example.com' })
  @Index('idx_api_outreach_host', { unique: true })
  @Column({ type: 'varchar', length: 255 })
  host!: string;

  @ApiProperty({ example: 'office@partner.example.com' })
  @Column({ type: 'varchar', length: 320 })
  recipient!: string;

  @ApiProperty({ example: 'bg', description: 'Language the letter was written in.' })
  @Column({ type: 'varchar', length: 5 })
  locale!: string;

  @ApiProperty()
  @Column({ type: 'text' })
  subject!: string;

  @ApiProperty({ description: 'The plain-text body exactly as it was sent.' })
  @Column({ type: 'text' })
  body!: string;

  @ApiProperty({ enum: OutreachStatus, example: OutreachStatus.Sent })
  @Column({ type: 'varchar', length: 16, default: OutreachStatus.Sent })
  status!: OutreachStatus;

  @ApiPropertyOptional({ description: "What came back, in the operator's words.", nullable: true })
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'sent_at', type: 'timestamptz' })
  sentAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
