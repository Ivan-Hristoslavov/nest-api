import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GeneratedApiKey, generateApiKey, hashApiKey } from './api-key.util';
import { PLAN_PRODUCT_LIMIT, User, UserPlan, UserStatus } from './entities/user.entity';

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

    this.logger.log(`Created user ${created.id} (${created.email})`);
    return created;
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
    this.logger.log(`Issued API key ${generated.prefix}… for user ${saved.id} (${saved.email})`);

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
    }
    if (details.customerId !== undefined) user.paddleCustomerId = details.customerId;
    if (details.subscriptionId !== undefined) user.subscriptionId = details.subscriptionId;
    if (details.paymentId !== undefined) user.lastPaymentId = details.paymentId;
    if (details.expiresAt !== undefined) user.accessExpiresAt = details.expiresAt;

    const saved = await this.usersRepository.save(user);
    this.logger.log(`Activated user ${saved.id} (${saved.email}) on plan ${saved.plan}`);

    return saved;
  }

  /** Marks an account as lapsed. The key stays on the row but stops working. */
  async expire(userId: string, reason: string): Promise<User> {
    const user = await this.findOne(userId);

    user.status = UserStatus.Expired;
    const saved = await this.usersRepository.save(user);

    this.logger.warn(`Expired user ${saved.id} (${saved.email}): ${reason}`);
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
