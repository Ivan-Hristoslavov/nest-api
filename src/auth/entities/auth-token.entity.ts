import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * What a token is for.
 *
 * Both live in one table because they are the same shape and the same
 * lifecycle — a random secret, hashed, with an expiry — and splitting them
 * would mean two sweepers, two lookups and two chances to forget one.
 */
export enum AuthTokenKind {
  /** Single use, minutes long, arrives by email. Exchanging it ends it. */
  SignInLink = 'sign_in_link',
  /** What the browser holds afterwards. Long-lived, revocable, renewable. */
  Session = 'session',
  /**
   * The first link, which also proves the mailbox exists.
   *
   * Separate from a plain sign-in link because exchanging it does more:
   * it turns a pending registration into a usable account and issues the
   * API key that registration deliberately did not hand out.
   */
  Verification = 'verification',
}

/**
 * A browser's proof of who it is.
 *
 * Deliberately not the API key. A key is a machine credential: it belongs in a
 * script, it is shown once, and rotating it breaks whatever was using it. A
 * person signing in on a laptop needs the opposite — something that can be
 * handed out again tomorrow, expired on its own, and revoked from one device
 * without touching the integration that runs their price sweep.
 *
 * Only the digest is stored, for the same reason API keys store only a digest:
 * a leaked database must not hand over live credentials.
 */
@Entity('auth_tokens')
@Index('idx_auth_tokens_hash', ['tokenHash'], { unique: true })
@Index('idx_auth_tokens_user', ['userId'])
export class AuthToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  /** SHA-256 of the token, hex. The plaintext exists only in the email or the browser. */
  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: AuthTokenKind;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /**
   * When a sign-in link was spent.
   *
   * Kept rather than deleted so a second click on the same link can say "this
   * link was already used" instead of the indistinguishable "invalid link",
   * which sends people to support convinced the email is broken.
   */
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  /** Enough to tell one signed-in device from another in a support call. */
  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
