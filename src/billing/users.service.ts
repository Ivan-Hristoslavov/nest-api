import { redactEmail } from '../common/redact';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { normaliseLocale } from './email-locale';
import { Repository } from 'typeorm';

import { GeneratedApiKey, generateApiKey, hashApiKey } from './api-key.util';
import {
  PLAN_AI_MATCH_LIMIT,
  PLAN_PRODUCT_LIMIT,
  TRIAL_AI_MATCHES,
  TRIAL_DAYS,
  TRIAL_PLAN,
  User,
  UserPlan,
  UserStatus,
} from './entities/user.entity';

/** A newly issued key, with the plaintext the caller must deliver to the user. */
export interface IssuedApiKey {
  user: User;
  /** Present exactly once. Never retrievable again. */
  apiKey: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /**
   * Looks a user up by the presented API key.
   *
   * The key is hashed before the query, so the plaintext never reaches the
   * database, the query log, or a slow-query report. `apiKeyHash` carries
   * `select: false`, hence the explicit `addSelect`.
   */
  async findByApiKey(plaintext: string): Promise<User | null> {
    return this.usersRepository
      .createQueryBuilder('user')
      .addSelect('user.apiKeyHash')
      .where('user.api_key_hash = :hash', { hash: hashApiKey(plaintext) })
      .getOne();
  }

  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email: this.normaliseEmail(email) } });
  }

  /**
   * Every account, newest first — the operator's customer list.
   *
   * Deliberately never selects `apiKeyHash`: an operator screen needs to say
   * *which* key an account holds, not to be able to reconstruct it. The prefix
   * is enough to match a key a customer reads out over the phone.
   */
  findAll(): Promise<User[]> {
    return this.usersRepository.find({ order: { createdAt: 'DESC' }, take: 500 });
  }

  async findOne(id: string): Promise<User> {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException(`User with id "${id}" not found.`);
    }

    return user;
  }

  /**
   * Finds a user by email, creating a pending one when absent.
   * Emails are normalised, so `Foo@Example.com ` and `foo@example.com` are the
   * same account — otherwise a customer who pays twice gets two accounts and
   * neither has their history.
   */
  async findOrCreateByEmail(email: string, name?: string | null): Promise<User> {
    const normalised = this.normaliseEmail(email);
    const existing = await this.findByEmail(normalised);

    if (existing) {
      if (name && !existing.name) {
        existing.name = name;
        return this.usersRepository.save(existing);
      }
      return existing;
    }

    const created = await this.usersRepository.save(
      this.usersRepository.create({
        email: normalised,
        name: name ?? null,
        status: UserStatus.Pending,
        plan: UserPlan.Free,
        productLimit: PLAN_PRODUCT_LIMIT[UserPlan.Free],
      }),
    );

    this.logger.log(`Created user ${created.id} (${redactEmail(created.email)})`);
    return created;
  }

  /**
   * Opens a free account for somebody who has paid nothing yet.
   *
   * Active rather than pending, because the free plan *is* the entitlement —
   * a pending account holds a key the guard refuses, which reads as a broken
   * signup rather than as a boundary.
   *
   * An existing address is refused instead of quietly re-issuing. Issuing is
   * destructive: it would kill the key that address is already using, so a
   * stranger typing a customer's email would lock them out. The refusal does
   * tell an attacker that an address is registered — accepted deliberately,
   * since there is no password to guess and the alternative hands anyone a
   * denial-of-service against any customer they can name.
   */
  /**
   * Records the language somebody is currently reading in.
   *
   * Called on registration and on every sign-in request, because a person who
   * signed up in one language and comes back in another is telling us
   * something newer than what is stored. Written only when it actually
   * changed — a sign-in should not cost a write for nothing.
   */
  async rememberLocale(user: User, locale?: string | null): Promise<void> {
    if (!locale) return;

    const wanted = normaliseLocale(locale);
    if (user.locale === wanted) return;

    user.locale = wanted;
    await this.usersRepository.update(user.id, { locale: wanted });
  }

  async createPendingAccount(
    email: string,
    name?: string | null,
    locale?: string | null,
  ): Promise<User> {
    const normalised = this.normaliseEmail(email);
    const existing = await this.findByEmail(normalised);

    if (existing) return existing;

    const created = await this.usersRepository.save(
      this.usersRepository.create({
        email: normalised,
        name: name?.trim() || null,
        // What the browser was displaying when they signed up. Every email
        // this account ever gets is written in it.
        locale: normaliseLocale(locale),
        // Pending, not active: the row exists so a link can point at it, and
        // grants nothing until that link is opened. A registration from an
        // address nobody reads therefore leaves a dormant row rather than a
        // working account with an AI allowance to spend.
        status: UserStatus.Pending,
        plan: UserPlan.Free,
        productLimit: PLAN_PRODUCT_LIMIT[UserPlan.Free],
        aiMatchesLimit: PLAN_AI_MATCH_LIMIT[UserPlan.Free],
      }),
    );

    this.logger.log(`Pending registration: ${redactEmail(created.email)} (${created.id})`);
    return created;
  }

  /**
   * Turns a verified registration into an account, and starts its trial.
   *
   * The trial is granted here rather than at registration for the same reason
   * the key is: until the link is opened, nobody has shown they read the
   * mailbox, and an unverified address that gets seven days of Pro is seven
   * days of Pro for anybody with a script.
   *
   * Only ever once per account. A second pass — somebody signing in again, an
   * operator re-running activation — must not restart the clock, or the trial
   * is unlimited to anyone who notices.
   */
  async activateWithTrial(userId: string): Promise<{ user: User; apiKey: string }> {
    const issued = await this.activateFreeAccount(userId);
    const user = issued.user;

    // `trialEndsAt` set means it has already been given, whether it is still
    // running or long over.
    if (user.trialEndsAt || user.plan !== UserPlan.Free) {
      return issued;
    }

    user.plan = TRIAL_PLAN;
    user.productLimit = PLAN_PRODUCT_LIMIT[TRIAL_PLAN];
    user.aiMatchesLimit = TRIAL_AI_MATCHES;
    user.aiPeriodStartedAt = new Date();
    user.trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 3600_000);

    const saved = await this.usersRepository.save(user);
    this.logger.log(
      `Trial started for ${redactEmail(saved.email)}, ends ${saved.trialEndsAt?.toISOString()}`,
    );

    return { user: saved, apiKey: issued.apiKey };
  }

  /**
   * Turns a verified registration into a usable account.
   *
   * Idempotent in the way that matters: an account that is already active
   * keeps its key rather than having it rotated out from under whatever is
   * using it, and only a genuinely new one is issued a first key.
   */
  async activateFreeAccount(userId: string): Promise<{ user: User; apiKey: string }> {
    const user = await this.findOne(userId);

    if (user.status !== UserStatus.Active) {
      user.status = UserStatus.Active;
      await this.usersRepository.save(user);
      this.logger.log(`Verified and activated ${redactEmail(user.email)}`);
    }

    // Tested on the prefix, not the hash: `apiKeyHash` carries `select: false`
    // and is therefore undefined on a plain `findOne`, which made this look
    // like an account with no key and rotated one that was in daily use — an
    // operator activating a plan would silently break the customer's scripts.
    if (user.apiKeyPrefix) {
      return { user, apiKey: '' };
    }

    const issued = await this.issueApiKey(user.id, 'live');
    return { user: issued.user, apiKey: issued.apiKey };
  }

  /**
   * Issues a new API key, replacing any previous one.
   *
   * Rotation is destructive by design: the old key stops working the moment
   * this returns, which is exactly what you want when a key is suspected
   * leaked.
   */
  async issueApiKey(userId: string, environment: 'live' | 'test' = 'live'): Promise<IssuedApiKey> {
    const user = await this.findOne(userId);
    const generated: GeneratedApiKey = generateApiKey(environment);

    user.apiKeyHash = generated.hash;
    user.apiKeyPrefix = generated.prefix;
    user.apiKeyIssuedAt = new Date();

    const saved = await this.usersRepository.save(user);
    this.logger.log(
      `Issued API key ${generated.prefix}… for user ${saved.id} (${redactEmail(saved.email)})`,
    );

    return { user: saved, apiKey: generated.plaintext };
  }

  /** Activates an account and moves it onto a plan. */
  async activate(
    userId: string,
    details: {
      plan?: UserPlan;
      customerId?: string | null;
      subscriptionId?: string | null;
      paymentId?: string | null;
      expiresAt?: Date | null;
    },
  ): Promise<User> {
    const user = await this.findOne(userId);

    user.status = UserStatus.Active;
    user.lastPaymentAt = new Date();

    if (details.plan) {
      user.plan = details.plan;
      user.productLimit = PLAN_PRODUCT_LIMIT[details.plan];
      user.aiMatchesLimit = PLAN_AI_MATCH_LIMIT[details.plan];
      if (user.trialEndsAt) {
        // Whatever trial was running is over, and well over: they bought. Left
        // set, the date would have the nightly sweeper downgrade a paying
        // customer to the free plan on the day their trial would have lapsed.
        //
        // The allowance restarts with the purchase rather than carrying the
        // trial's spend into the first paid month, which would sell somebody a
        // plan and hand them part of it already used.
        user.trialEndsAt = null;
        user.aiMatchesUsed = 0;
        user.aiPeriodStartedAt = new Date();
      }
    }
    if (details.customerId !== undefined) user.paddleCustomerId = details.customerId;
    if (details.subscriptionId !== undefined) user.subscriptionId = details.subscriptionId;
    if (details.paymentId !== undefined) user.lastPaymentId = details.paymentId;
    if (details.expiresAt !== undefined) user.accessExpiresAt = details.expiresAt;

    const saved = await this.usersRepository.save(user);
    this.logger.log(
      `Activated user ${saved.id} (${redactEmail(saved.email)}) on plan ${saved.plan}`,
    );

    return saved;
  }

  /**
   * Erases an account and everything it owns.
   *
   * The privacy policy promises this, so it has to be something an operator
   * can actually do rather than a sentence. `owner_id` carries
   * `ON DELETE CASCADE`, so removing the row takes the products, listings,
   * price history, alerts and hand-entered prices with it.
   *
   * The caller must repeat the account's email. There is no undo, ids look
   * alike in a support ticket, and "delete this account" typed against the
   * wrong uuid is otherwise indistinguishable from the right one.
   */
  async eraseAccount(id: string, confirmEmail: string): Promise<{ email: string }> {
    const user = await this.findOne(id);

    if (this.normaliseEmail(confirmEmail) !== user.email) {
      throw new ConflictException(
        `Потвърждението не съвпада. Акаунт ${id} е на ${user.email}; повторете точно този адрес.`,
      );
    }

    await this.usersRepository.delete({ id });

    this.logger.warn(
      `ERASED account ${id} (${user.email}) and all data owned by it. This is not reversible.`,
    );

    return { email: user.email };
  }

  /**
   * Adds bought comparisons to an account's allowance.
   *
   * Raises the ceiling rather than lowering the count, so a top-up survives
   * the monthly reset on a paid plan and does not quietly expire at the end of
   * the month somebody bought it in — they paid for comparisons, not for a
   * window in which to make them.
   */
  async creditAiComparisons(userId: string, count: number): Promise<User> {
    const user = await this.findOne(userId);

    user.aiMatchesLimit += count;
    const saved = await this.usersRepository.save(user);

    this.logger.log(
      `Credited ${count} AI comparisons to ${saved.email}; allowance is now ${saved.aiMatchesLimit}.`,
    );

    return saved;
  }

  /** Marks an account as lapsed. The key stays on the row but stops working. */
  async expire(userId: string, reason: string): Promise<User> {
    const user = await this.findOne(userId);

    user.status = UserStatus.Expired;
    const saved = await this.usersRepository.save(user);

    this.logger.warn(`Expired user ${saved.id} (${redactEmail(saved.email)}): ${reason}`);
    return saved;
  }

  /**
   * Changes an account by hand.
   *
   * The operator screen reads; this is what lets it act. Everything here is
   * something a webhook would normally decide, and sometimes a webhook is not
   * going to: a customer who paid by bank transfer, one whose subscription
   * lapsed for a reason we agreed to overlook, one who needs a bigger
   * allowance for a week.
   *
   * Only the three fields worth touching. Plan and limit are separate on
   * purpose — raising somebody's articles for a month is not the same as
   * moving them onto a plan they are not paying for, and conflating them
   * would make the generous version of the first look like the second in
   * every report afterwards.
   */
  async adjust(
    id: string,
    changes: { status?: UserStatus; plan?: UserPlan; productLimit?: number },
  ): Promise<User> {
    const user = await this.findOne(id);
    const before = { status: user.status, plan: user.plan, productLimit: user.productLimit };

    if (changes.status) user.status = changes.status;
    if (changes.plan) user.plan = changes.plan;
    if (changes.productLimit !== undefined) user.productLimit = changes.productLimit;

    const saved = await this.usersRepository.save(user);

    // Written down because it is the one change to an account that no payment
    // explains, and six months later somebody will ask why this customer is
    // on this plan.
    this.logger.warn(
      `Operator adjusted ${saved.id} (${redactEmail(saved.email)}): ` +
        `status ${before.status}→${saved.status}, plan ${before.plan}→${saved.plan}, ` +
        `limit ${before.productLimit}→${saved.productLimit}`,
    );

    return saved;
  }

  /**
   * Records that a key was just used.
   *
   * Fire-and-forget and deliberately not awaited by the guard: last-seen is
   * useful for support, not worth adding a write to the critical path of every
   * authenticated request.
   */
  touchLastUsed(userId: string): void {
    void this.usersRepository
      .update({ id: userId }, { apiKeyLastUsedAt: new Date() })
      .catch((error: unknown) => {
        this.logger.debug(
          `Could not update last-used for ${userId}: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      });
  }

  private normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
