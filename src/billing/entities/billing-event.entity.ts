import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Every webhook the billing provider ever delivered.
 *
 * Two jobs:
 *
 * 1. **Idempotency.** Paddle and Lemon Squeezy both retry until they get a 2xx,
 *    and network timeouts mean a request can succeed at our end and still be
 *    retried. The unique index on `eventId` turns "process twice" into a
 *    constraint violation we can detect and ignore, so a customer never gets a
 *    second key issued because a retry arrived.
 *
 * 2. **Audit.** When a customer says "I paid and got nothing", the raw payload
 *    that arrived — or the absence of one — settles it.
 */
@Entity('billing_events')
export class BillingEvent {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({
    description: "The provider's own event id. Unique — this is the idempotency key.",
    example: 'evt_01hv8w9x2k3m4n5p6q7r8s9t0v',
  })
  @Index('idx_billing_events_event_id', { unique: true })
  @Column({ name: 'event_id', type: 'varchar', length: 191 })
  eventId!: string;

  @ApiProperty({ description: 'paddle | lemonsqueezy', example: 'paddle' })
  @Column({ type: 'varchar', length: 32 })
  provider!: string;

  @ApiProperty({ description: 'Provider event name.', example: 'subscription.created' })
  @Index('idx_billing_events_type')
  @Column({ name: 'event_type', type: 'varchar', length: 128 })
  eventType!: string;

  @ApiPropertyOptional({ description: 'Email the event resolved to.', nullable: true })
  @Column({ type: 'varchar', length: 320, nullable: true })
  email!: string | null;

  @ApiPropertyOptional({
    description: 'User the event was applied to.',
    format: 'uuid',
    nullable: true,
  })
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @ApiProperty({ description: 'Whether the event changed anything.', example: true })
  @Column({ type: 'boolean', default: false })
  processed!: boolean;

  @ApiPropertyOptional({ description: 'Why the event was ignored or failed.', nullable: true })
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @ApiProperty({
    description: 'Raw payload as received, for audits and replays.',
  })
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;
}
