import { redactEmail } from '../common/redact';
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
 * How long there is to produce a second factor.
 *
 * Five minutes: long enough to unlock a phone and find the right entry among
 * thirty, short enough that a challenge left open on a shared computer is not
 * a way in an hour later.
 */
const CHALLENGE_TTL_MS = 5 * 60_000;

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

/** One signed-in device, as the account's owner sees it. */
export interface SessionSummary {
  id: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  /** True for the session making the request, so it is not revoked by accident. */
  current: boolean;
}

/**
 * Handed back when the mailbox is proved but a second factor is still owed.
 *
 * The challenge grants nothing by itself: it is a receipt saying which account
 * is halfway through signing in, and it expires in minutes.
 */
export interface TwoFactorRequired {
  twoFactor: true;
  challenge: string;
  expiresAt: Date;
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

    this.logger.log(`${kind} link sent to ${redactEmail(user.email)}`);
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
  ): Promise<IssuedSession | TwoFactorRequired | { failure: ExchangeFailure }> {
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

    // An account with a second factor gets a challenge instead of a session.
    // The key, when this exchange issued one, still goes out: it was earned by
    // proving the mailbox, and withholding it would strand somebody who
    // enabled two-factor before their first script ever ran.
    if (user.hasTwoFactor()) {
      const challenge = await this.issueChallenge(user, apiKey);
      this.logger.log(`Second factor owed for ${redactEmail(user.email)}`);
      return challenge;
    }

    return this.openSession(user, userAgent, apiKey);
  }

  /** Mints the session itself, once everything owed has been paid. */
  private async openSession(
    user: User,
    userAgent: string | undefined,
    apiKey: string | undefined,
  ): Promise<IssuedSession> {
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

    this.logger.log(`Session opened for ${redactEmail(user.email)}`);
    return { token: session.token, expiresAt, user, apiKey };
  }

  /**
   * Records "this account is halfway in" for a few minutes.
   *
   * The API key, if this sign-in issued one, rides along on the row rather
   * than being returned now — it is shown exactly once, and that moment has to
   * be the response that finally opens the session.
   */
  private async issueChallenge(user: User, apiKey?: string): Promise<TwoFactorRequired> {
    const { token, hash } = generateToken('pg_2fa');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

    await this.tokens.save(
      this.tokens.create({
        userId: user.id,
        tokenHash: hash,
        kind: AuthTokenKind.TwoFactorChallenge,
        expiresAt,
        // Reused rather than adding a column: this field is only ever read for
        // sessions, and the key is gone from the row within minutes either way.
        userAgent: apiKey ? `key:${apiKey}` : null,
      }),
    );

    return { twoFactor: true, challenge: token, expiresAt };
  }

  /**
   * Spends a challenge, if the code that comes with it is right.
   *
   * The challenge is marked used before the session exists, for the same
   * reason a sign-in link is: raced twice, it must not produce two sessions.
   * A wrong code leaves the challenge alive so somebody who fat-fingered six
   * digits does not have to start from their inbox again.
   */
  async completeTwoFactor(
    challengeToken: string,
    verify: (userId: string) => Promise<boolean>,
    userAgent?: string,
  ): Promise<IssuedSession | { failure: ExchangeFailure | 'code' }> {
    const row = await this.tokens.findOne({
      where: { tokenHash: hashToken(challengeToken), kind: AuthTokenKind.TwoFactorChallenge },
    });

    if (!row) return { failure: 'unknown' };
    if (row.usedAt) return { failure: 'used' };
    if (row.expiresAt.getTime() < Date.now()) return { failure: 'expired' };

    if (!(await verify(row.userId))) return { failure: 'code' };

    await this.tokens.update({ id: row.id }, { usedAt: new Date() });

    const user = await this.users.findOne(row.userId);
    const apiKey = row.userAgent?.startsWith('key:') ? row.userAgent.slice(4) : undefined;

    return this.openSession(user, userAgent, apiKey);
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
   * The devices this account is signed in on.
   *
   * Without this, "sign out everywhere" is the only answer to a laptop left in
   * an office, and a customer who suspects one device has no way to look. The
   * digest is never returned: the current session is identified by comparing
   * the presented token's digest here, so the browser can say "this one" without
   * anything being handed back that could sign somebody in.
   */
  async listSessions(userId: string, currentToken?: string): Promise<SessionSummary[]> {
    const rows = await this.tokens.find({
      where: { userId, kind: AuthTokenKind.Session },
      order: { lastUsedAt: 'DESC', createdAt: 'DESC' },
      take: 50,
    });

    const currentHash = currentToken ? hashToken(currentToken) : null;
    const now = Date.now();

    return rows
      .filter((row) => row.expiresAt.getTime() > now)
      .map((row) => ({
        id: row.id,
        userAgent: row.userAgent,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        expiresAt: row.expiresAt,
        current: currentHash !== null && row.tokenHash === currentHash,
      }));
  }

  /**
   * Ends one named session.
   *
   * Scoped to the owner, so an id guessed or copied from somewhere else
   * revokes nothing. Returns whether a row was actually removed, which is what
   * lets the caller answer 404 rather than pretending.
   */
  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.tokens.delete({
      id: sessionId,
      userId,
      kind: AuthTokenKind.Session,
    });

    return (result.affected ?? 0) > 0;
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
