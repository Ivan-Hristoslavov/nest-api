import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Lifecycle of a paying account. */
export enum UserStatus {
  /** Registered but not paid — the API key, if any, is refused. */
  Pending = 'pending',
  /** Paid and in good standing. */
  Active = 'active',
  /** Subscription lapsed or payment failed. */
  Expired = 'expired',
  /** Suspended by us. Never reactivated by a webhook. */
  Suspended = 'suspended',
}

/** Plans, used for the per-plan tracking limits. */
export enum UserPlan {
  Free = 'free',
  Starter = 'starter',
  Pro = 'pro',
  Business = 'business',
}

/** Maximum tracked products per plan. */
export const PLAN_PRODUCT_LIMIT: Record<UserPlan, number> = {
  [UserPlan.Free]: 5,
  [UserPlan.Starter]: 50,
  [UserPlan.Pro]: 500,
  [UserPlan.Business]: 5000,
};

/**
 * A paying customer and the API key they authenticate with.
 *
 * **The plaintext key is never stored.** `apiKeyHash` holds a SHA-256 digest
 * and `apiKeyPrefix` the first few characters, purely so a key can be
 * identified in a UI ("pk_live_9f2b…"). The plaintext is returned exactly once,
 * when the key is issued, and must be delivered to the customer there and then.
 *
 * That is the difference between a database leak being an inconvenience and it
 * being a full compromise of every customer's account.
 */
@Entity('users')
export class User {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ApiProperty({ description: 'Billing email. Unique.', example: 'customer@example.com' })
  @Index('idx_users_email', { unique: true })
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @ApiPropertyOptional({ description: 'Company or contact name.', nullable: true })
  @Column({ type: 'varchar', length: 255, nullable: true })
  name!: string | null;

  /**
   * SHA-256 of the API key. Indexed because the guard looks the key up on
   * every single request.
   */
  @Index('idx_users_api_key_hash', { unique: true })
  @Column({ name: 'api_key_hash', type: 'varchar', length: 64, nullable: true, select: false })
  apiKeyHash!: string | null;

  @ApiPropertyOptional({
    description: 'First characters of the API key, for identifying it in a UI.',
    nullable: true,
    example: 'pk_live_9f2b7c41',
  })
  @Column({ name: 'api_key_prefix', type: 'varchar', length: 24, nullable: true })
  apiKeyPrefix!: string | null;

  @ApiPropertyOptional({
    description: 'When the current key was issued.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'api_key_issued_at', type: 'timestamptz', nullable: true })
  apiKeyIssuedAt!: Date | null;

  @ApiPropertyOptional({
    description: 'Last time this key authenticated a request.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'api_key_last_used_at', type: 'timestamptz', nullable: true })
  apiKeyLastUsedAt!: Date | null;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus', example: UserStatus.Active })
  @Index('idx_users_status')
  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.Pending })
  status!: UserStatus;

  @ApiProperty({ enum: UserPlan, enumName: 'UserPlan', example: UserPlan.Starter })
  @Column({ type: 'enum', enum: UserPlan, default: UserPlan.Free })
  plan!: UserPlan;

  @ApiProperty({
    description: 'Maximum tracked products allowed on the current plan.',
    example: 50,
  })
  @Column({ name: 'product_limit', type: 'int', default: PLAN_PRODUCT_LIMIT[UserPlan.Free] })
  productLimit!: number;

  @ApiPropertyOptional({
    description: 'Customer id at the merchant of record (Paddle / Lemon Squeezy).',
    nullable: true,
    example: 'ctm_01hv8w...',
  })
  @Index('idx_users_paddle_customer')
  @Column({ name: 'paddle_customer_id', type: 'varchar', length: 128, nullable: true })
  paddleCustomerId!: string | null;

  @ApiPropertyOptional({
    description: 'Subscription id at the merchant of record.',
    nullable: true,
    example: 'sub_01hv8w...',
  })
  @Column({ name: 'subscription_id', type: 'varchar', length: 128, nullable: true })
  subscriptionId!: string | null;

  @ApiPropertyOptional({
    description: 'Identifier of the most recent successful payment.',
    nullable: true,
  })
  @Column({ name: 'last_payment_id', type: 'varchar', length: 128, nullable: true })
  lastPaymentId!: string | null;

  @ApiPropertyOptional({
    description: 'When the subscription was last renewed.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'last_payment_at', type: 'timestamptz', nullable: true })
  lastPaymentAt!: Date | null;

  @ApiPropertyOptional({
    description: 'When access lapses if no further payment arrives.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'access_expires_at', type: 'timestamptz', nullable: true })
  accessExpiresAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * Whether this account may call the API right now.
   * Status alone is not enough: a subscription can lapse between webhooks, so
   * the expiry date is checked too.
   */
  isActive(now: Date = new Date()): boolean {
    if (this.status !== UserStatus.Active) return false;
    return this.accessExpiresAt === null || this.accessExpiresAt > now;
  }
}
