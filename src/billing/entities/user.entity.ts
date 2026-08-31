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

/**
 * Tracked articles allowed per plan.
 *
 * Articles, not suppliers. Suppliers cost almost nothing to serve — one request
 * per shop per question, only when somebody asks — while *tracked* articles are
 * re-checked on a schedule for ever, which is the actual bill. Metering the
 * cheap thing would also cap the useful one: the more suppliers a buyer
 * compares, the more they save, and charging for that sells against the
 * product.
 *
 * The free tier is deliberately usable rather than a demo. A buyer with ten
 * articles under watch discovers within a month whether this saves them money,
 * and that is a better sales argument than any page of features.
 */
export const PLAN_PRODUCT_LIMIT: Record<UserPlan, number> = {
  [UserPlan.Free]: 10,
  [UserPlan.Starter]: 100,
  [UserPlan.Pro]: 500,
  [UserPlan.Business]: 2000,
};

/**
 * What each plan costs per month.
 *
 * The one place this number is written down. Before this it existed twice —
 * in the pricing page's markup and again in the interface's ROI panel — which
 * is two places to change and one of them to forget. A subscription figure
 * that disagrees with the pricing page is not a cosmetic bug: it sits directly
 * under the words "you paid X, we saved you Y", which is the claim a customer
 * checks against their own bank statement.
 *
 * `free` is zero, and callers must treat it as "no subscription to measure
 * against" rather than as a price. An ROI of "you paid €0 and saved €386" is
 * arithmetic, not an argument, and dividing by it is worse.
 *
 * **This is the display price. Stripe holds what is actually charged**, as a
 * price id rather than an amount, so the two are separate facts by
 * construction and nothing in the type system ties them together.
 * {@link CheckoutService.verifyPrices} compares them once at boot and complains
 * loudly if they have drifted, which is the closest thing to a guarantee that
 * is available without putting a Stripe call on a hot path.
 */
export const PLAN_PRICE: Record<UserPlan, number> = {
  [UserPlan.Free]: 0,
  [UserPlan.Starter]: 19,
  [UserPlan.Pro]: 49,
  [UserPlan.Business]: 99,
};

/**
 * The currency every plan is priced in.
 *
 * A constant rather than a column because it is one: the prices above are
 * euro amounts, and a per-account currency would mean per-account prices,
 * which is a different product. Named and exported anyway, so no caller has to
 * assume it and none of them can quietly assume something else.
 */
export const PLAN_CURRENCY = 'EUR';

/**
 * What this plan costs, for a plan value that may have come from anywhere.
 *
 * The row's `plan` column is a string as far as Postgres is concerned, so a
 * value written by an older deploy, a hand-run UPDATE or a future tier can
 * reach a reader that has no price for it. Returning `null` for those says
 * "not known" and lets the interface leave the figure out, which is the only
 * honest option — falling back to another plan's price would put a number
 * under somebody's subscription that nobody charges.
 */
export function planPriceOf(plan: string | null | undefined): number | null {
  if (!plan) return null;
  const price = (PLAN_PRICE as Record<string, number | undefined>)[plan];
  return typeof price === 'number' ? price : null;
}

/**
 * AI comparisons an account may spend per month.
 *
 * Metered apart from price checks because it is a different cost with a
 * different shape: a price check is one request to a shop, a comparison is
 * tokens. Generous on purpose — the deterministic matcher answers most pairs
 * for nothing, so these numbers are only ever reached by genuinely ambiguous
 * catalogues, and an account that hits the ceiling keeps searching with the
 * AI half switched off rather than being stopped.
 */
/**
 * The AI allowance as it stands right now.
 *
 * The counter on the row is only reset lazily, when something next spends
 * from it — so a row can carry last month's number for weeks. Every reader
 * must therefore apply the same rollover rule, and having each one reimplement
 * "has a month passed" is how the meter and the invoice-facing display end up
 * disagreeing. This is the one definition.
 */
export function effectiveAiUsage(
  user: Pick<User, 'plan' | 'aiMatchesUsed' | 'aiMatchesLimit' | 'aiPeriodStartedAt'>,
  now = new Date(),
): { used: number; limit: number; renews: boolean } {
  // The free allowance does not renew, and that is the whole anti-abuse
  // design. A monthly free allowance is worth farming — open three mailboxes,
  // get three allowances, every month, for ever. A one-off allowance is worth
  // farming once, for a handful of comparisons, which is not worth anyone's
  // morning. Paying customers get a monthly one because they are paying for it.
  const renews = user.plan !== UserPlan.Free;

  if (!renews) {
    return { used: user.aiMatchesUsed, limit: user.aiMatchesLimit, renews };
  }

  const started = user.aiPeriodStartedAt;
  const monthElapsed = !started || now.getTime() - started.getTime() > 30 * 24 * 3600_000;

  return { used: monthElapsed ? 0 : user.aiMatchesUsed, limit: user.aiMatchesLimit, renews };
}

/**
 * The trial: seven days on Pro, no card.
 *
 * Seven rather than fourteen because of what the product is. A buyer finds out
 * whether this saves them money the first morning a supplier moves a price —
 * which happens within days, not weeks. A fortnight does not produce more
 * evidence, it produces two weekends of forgetting, and the account that has
 * gone quiet for eleven days does not come back for the reminder on the
 * twelfth. Seven days is still two full working weeks' worth of price
 * movement, and it ends while the reason they signed up is fresh.
 */
export const TRIAL_DAYS = 7;
export const TRIAL_PLAN = UserPlan.Pro;

/**
 * AI comparisons the trial includes.
 *
 * Not Pro's ten thousand. Every one of those is tokens spent on somebody who
 * has paid nothing, and a trial allowance large enough to run a catalogue
 * migration through is a trial allowance worth opening mailboxes for. Three
 * hundred is more than any honest evaluation spends — the deterministic
 * matcher answers most pairs without the model at all.
 */
export const TRIAL_AI_MATCHES = 300;

export const PLAN_AI_MATCH_LIMIT: Record<UserPlan, number> = {
  // Once, not per month — enough to see what the model settles that arithmetic
  // cannot, not enough to be worth opening mailboxes for.
  [UserPlan.Free]: 50,
  [UserPlan.Starter]: 2_000,
  [UserPlan.Pro]: 10_000,
  [UserPlan.Business]: 50_000,
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

  @ApiPropertyOptional({
    description:
      'Language this account is written to. Captured from the browser when the account is opened; empty means the source language.',
    example: 'ro',
    nullable: true,
  })
  @Column({ name: 'locale', type: 'varchar', length: 5, nullable: true })
  locale!: string | null;

  @ApiProperty({
    description: 'Maximum tracked products allowed on the current plan.',
    example: 50,
  })
  @Column({ name: 'product_limit', type: 'int', default: PLAN_PRODUCT_LIMIT[UserPlan.Free] })
  productLimit!: number;

  @ApiProperty({ description: 'AI comparisons spent in the current month.', example: 42 })
  @Column({ name: 'ai_matches_used', type: 'int', default: 0 })
  aiMatchesUsed!: number;

  @ApiProperty({ description: 'AI comparisons this plan allows per month.', example: 2000 })
  @Column({ name: 'ai_matches_limit', type: 'int', default: PLAN_AI_MATCH_LIMIT[UserPlan.Free] })
  aiMatchesLimit!: number;

  @ApiPropertyOptional({
    description: 'When the current AI allowance period began.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'ai_period_started_at', type: 'timestamptz', nullable: true })
  aiPeriodStartedAt!: Date | null;

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

  /**
   * When the free trial of a paid plan runs out.
   *
   * Null for an account that never had one, and cleared the moment a payment
   * lands — a paying customer is not on trial, and leaving the date behind
   * would have the sweeper downgrade somebody who has just bought.
   */
  @ApiPropertyOptional({
    description: 'End of the free trial, if one is running.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Index('idx_users_trial_ends_at')
  @Column({ name: 'trial_ends_at', type: 'timestamptz', nullable: true })
  trialEndsAt!: Date | null;

  @ApiPropertyOptional({
    description: 'When access lapses if no further payment arrives.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'access_expires_at', type: 'timestamptz', nullable: true })
  accessExpiresAt!: Date | null;

  /**
   * The TOTP secret, encrypted.
   *
   * Never returned by any endpoint and never selected by an ordinary lookup:
   * the only thing that needs it is the code check on sign-in. `select: false`
   * means a stray `findOne` cannot leak it into a response by accident, the
   * way `apiKeyHash` is protected.
   */
  @Column({ name: 'totp_secret', type: 'varchar', length: 255, nullable: true, select: false })
  totpSecret!: string | null;

  @ApiPropertyOptional({
    description: 'When two-factor authentication was switched on. Null when it is off.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'totp_confirmed_at', type: 'timestamptz', nullable: true })
  totpConfirmedAt!: Date | null;

  /**
   * Digests of the unused recovery codes.
   *
   * Hashed, like everything else that is only ever compared — a recovery code
   * is a password to the account and a leaked list of them in plain text would
   * be worse than having no second factor at all. Each is removed as it is
   * spent, so the column doubles as the count of how many are left.
   */
  @Column({ name: 'totp_recovery_hashes', type: 'jsonb', nullable: true, select: false })
  totpRecoveryHashes!: string[] | null;

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

  /** Whether a second factor is required to sign this account in. */
  hasTwoFactor(): boolean {
    return this.totpConfirmedAt !== null;
  }

  /** Whether this account is inside its free trial right now. */
  isOnTrial(now: Date = new Date()): boolean {
    return this.trialEndsAt !== null && this.trialEndsAt > now;
  }

  /**
   * Whole days of trial left, rounded up, or null when there is no trial.
   *
   * Rounded up because that is how a person counts: at eighteen hours to go
   * they have "one day left", not zero. Rounding down would have the banner
   * say nothing remains while the account is still on Pro.
   */
  trialDaysLeft(now: Date = new Date()): number | null {
    if (!this.trialEndsAt) return null;
    const remaining = this.trialEndsAt.getTime() - now.getTime();
    return remaining <= 0 ? 0 : Math.ceil(remaining / (24 * 3600_000));
  }
}
