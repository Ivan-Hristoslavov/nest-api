import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { User } from '../billing/entities/user.entity';
import { MailService } from '../billing/mail.service';
import { UsersService } from '../billing/users.service';
import { classifyEmail } from './disposable-domains';
import { AuthToken, AuthTokenKind } from './entities/auth-token.entity';

/** A link is worth minutes; long enough to switch to the inbox, not to leak. */
const LINK_TTL_MS = 15 * 60_000;

/** A session lasts until it is inconvenient rather than until it is unsafe. */
const SESSION_TTL_MS = 30 * 24 * 3600_000;

/**
 * How many links one address may be sent in an hour, and over what window.
 *
 * The controller already throttles per IP, which stops one machine from
 * hammering the endpoint. It does not stop the thing this is for: a caller
 * spread across many addresses aiming every request at *one* mailbox, which
 * turns a sign-in form into a way to bury somebody's inbox. Four is above what
 * a confused person needs — request, misplace it, request again — and far
 * below what a flood needs to be worth mounting.
 */
const LINKS_PER_EMAIL = 4;
const LINK_WINDOW_MS = 3600_000;

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  user: User;
  /**
   * Present only when this exchange also activated a new account.
   *
   * The key is shown exactly once and never again, so the one moment it can be
   * handed over is the request that created it — which is now the request that
   * also proved somebody reads the mailbox.
   */
  apiKey?: string;
}

/** Why an exchange failed, in terms the interface can explain. */
export type ExchangeFailure = 'unknown' | 'expired' | 'used';

/**
 * Signing a person in.
 *
 * No passwords, and deliberately so. A password means a reset flow, a strength
 * policy, a breach list to check against and a hash to argue about — all to
 * verify something this system can verify directly: that the person reads the
 * mailbox the account is keyed on. That is the same proof a password reset
 * ultimately rests on, so the flow skips to it.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(AuthToken) private readonly tokens: Repository<AuthToken>,
    private readonly users: UsersService,
    private readonly mail: MailService,
  ) {}

  /**
   * Registers an address, without giving anything away yet.
   *
   * The previous flow handed the API key back in the response, which meant the
   * email address was decoration: a script could farm accounts — and their AI
   * allowances — from addresses nobody owns. Now registration only creates a
   * pending row and sends a link; the key is issued when that link is opened.
   * An address that cannot receive mail therefore never becomes an account.
   *
   * Deliberately quiet about whether the address is already registered, for
   * the same reason as sign-in: it would otherwise answer "is this person a
   * customer" to anyone who asks.
   */
  async register(email: string, name: string | undefined, appUrl: string): Promise<void> {
    const verdict = classifyEmail(email);

    if (verdict !== 'ok') {
      // Refused loudly rather than silently, because unlike an unknown address
      // this is something the person can fix by using their real one.
      throw new BadRequestException(
        verdict === 'disposable'
          ? 'Този имейл е от услуга за временни адреси. Използвайте служебния си имейл — на него пращаме ключа и известията за цените.'
          : 'Този адрес не може да получава поща. Използвайте истински имейл.',
      );
    }

    const existing = await this.users.findByEmail(email);

    // An existing account gets a sign-in link instead: the person almost
    // certainly forgot they had one, and that is the thing they wanted.
    const user = existing ?? (await this.users.createPendingAccount(email, name));

    await this.issueLink(
      user,
      existing ? AuthTokenKind.SignInLink : AuthTokenKind.Verification,
      appUrl,
    );
  }

  /**
   * Emails a sign-in link, if there is an account to sign into.
   *
   * Returns nothing either way. Telling an anonymous caller whether an address
   * is registered turns this endpoint into a customer-list oracle, and the
   * person who typed their own address correctly learns the answer from their
   * inbox a second later.
   */
  async requestSignInLink(email: string, appUrl: string): Promise<void> {
    const user = await this.users.findByEmail(email);

    if (!user) {
      this.logger.log(`Sign-in requested for an address with no account.`);
      return;
    }

    await this.issueLink(user, AuthTokenKind.SignInLink, appUrl);
  }

  /**
   * Whether this address has already had its share of links this hour.
   *
   * Held in memory rather than in the database: it is a rate limit, not a
   * record, and the cost of a process restart forgetting one is that somebody
   * gets a fifth email. Across several instances each keeps its own count, so
   * the real ceiling is `LINKS_PER_EMAIL × instances` — still bounded, and the
   * shared counter this would otherwise need (Redis) is not worth adding a
   * dependency for.
   */
  private readonly linksSent = new Map<string, number[]>();

  private mayReceiveLink(email: string): boolean {
    const key = email.toLowerCase();
    const now = Date.now();
    const recent = (this.linksSent.get(key) ?? []).filter((at) => now - at < LINK_WINDOW_MS);

    if (recent.length >= LINKS_PER_EMAIL) {
      this.linksSent.set(key, recent);
      return false;
    }

    recent.push(now);
    this.linksSent.set(key, recent);

    // Nothing sweeps this map, so it is swept here: any address whose window
    // has lapsed is dropped whenever the map grows past a size no real
    // hour of traffic reaches.
    if (this.linksSent.size > 10_000) {
      for (const [address, times] of this.linksSent) {
        if (times.every((at) => now - at >= LINK_WINDOW_MS)) this.linksSent.delete(address);
      }
    }

    return true;
  }

  /** Creates a one-time link of either kind and mails it. */
  private async issueLink(user: User, kind: AuthTokenKind, appUrl: string): Promise<void> {
    if (!this.mayReceiveLink(user.email)) {
      // Quiet, like every other outcome of this endpoint. Saying "too many"
      // would confirm the address exists to anyone willing to ask five times.
      this.logger.warn(`Suppressed a ${kind} link: this address has had its hourly share.`);
      return;
    }

    const { token, hash } = generateToken('pg_link');

    await this.tokens.save(
      this.tokens.create({
        userId: user.id,
        tokenHash: hash,
        kind,
        expiresAt: new Date(Date.now() + LINK_TTL_MS),
      }),
    );

    const url = `${appUrl.replace(/\/+$/, '')}/#signin=${token}`;
    const minutes = Math.round(LINK_TTL_MS / 60_000);

    if (kind === AuthTokenKind.Verification) {
      await this.mail.sendVerificationLink(user, url, minutes);
    } else {
      await this.mail.sendSignInLink(user, url, minutes);
    }

    this.logger.log(`${kind} link sent to ${user.email}`);
  }

  /**
   * Trades a link for a session.
   *
   * The link is marked used before the session exists, so a link raced twice
   * cannot produce two sessions.
   */
  async exchange(
    token: string,
    userAgent?: string,
  ): Promise<IssuedSession | { failure: ExchangeFailure }> {
    const row = await this.tokens.findOne({
      where: [
        { tokenHash: hashToken(token), kind: AuthTokenKind.SignInLink },
        { tokenHash: hashToken(token), kind: AuthTokenKind.Verification },
      ],
    });

    if (!row) return { failure: 'unknown' };
    if (row.usedAt) return { failure: 'used' };
    if (row.expiresAt.getTime() < Date.now()) return { failure: 'expired' };

    await this.tokens.update({ id: row.id }, { usedAt: new Date() });

    let user = await this.users.findOne(row.userId);
    let apiKey: string | undefined;

    // The link that proves the mailbox is also the one that opens the account.
    // Until this moment the row exists but grants nothing.
    if (row.kind === AuthTokenKind.Verification) {
      const issued = await this.users.activateWithTrial(user.id);
      user = issued.user;
      apiKey = issued.apiKey;
      await this.mail.sendApiKey(user, issued.apiKey);
    }

    const session = generateToken('pg_sess');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await this.tokens.save(
      this.tokens.create({
        userId: user.id,
        tokenHash: session.hash,
        kind: AuthTokenKind.Session,
        expiresAt,
        userAgent: userAgent?.slice(0, 255) ?? null,
      }),
    );

    this.logger.log(`Session opened for ${user.email}`);
    return { token: session.token, expiresAt, user, apiKey };
  }

  /**
   * Who is holding this session, or null.
   *
   * Called on every request the browser makes, so it does the least possible:
   * one indexed lookup by digest, and a last-used stamp that is not awaited.
   */
  async resolveSession(token: string): Promise<User | null> {
    const row = await this.tokens.findOne({
      where: { tokenHash: hashToken(token), kind: AuthTokenKind.Session },
    });

    if (!row || row.expiresAt.getTime() < Date.now()) return null;

    void this.tokens.update({ id: row.id }, { lastUsedAt: new Date() }).catch(() => undefined);

    return this.users.findOne(row.userId).catch(() => null);
  }

  /** Ends this one session. Other devices keep theirs. */
  async signOut(token: string): Promise<void> {
    await this.tokens.delete({ tokenHash: hashToken(token), kind: AuthTokenKind.Session });
  }

  /** Ends every session of an account — after a key rotation, or on request. */
  async signOutEverywhere(userId: string): Promise<void> {
    await this.tokens.delete({ userId, kind: AuthTokenKind.Session });
  }

  /**
   * Drops what has expired.
   *
   * Spent links and dead sessions are of no use to anyone and are exactly the
   * rows an attacker would most like to find, so they do not accumulate.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweepExpired(): Promise<number> {
    const result = await this.tokens.delete({ expiresAt: LessThan(new Date()) });
    const removed = result.affected ?? 0;

    if (removed > 0) this.logger.log(`Swept ${removed} expired sign-in links and sessions.`);

    return removed;
  }
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

function generateToken(prefix: string): { token: string; hash: string } {
  const token = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}
