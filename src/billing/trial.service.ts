import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';

import { Product } from '../products/entities/product.entity';
import { PLAN_AI_MATCH_LIMIT, PLAN_PRODUCT_LIMIT, User, UserPlan } from './entities/user.entity';
import { MailService } from './mail.service';

/**
 * How long before the end the reminder goes out.
 *
 * Two days, so it lands with a working day still in it. A reminder on the last
 * morning arrives after the decision has already been made by default.
 */
const REMINDER_DAYS_BEFORE = 2;

/**
 * What happens when the seven days run out.
 *
 * The hard question is not the plan — it is the articles. A trial account can
 * put five hundred articles under watch; the free plan watches ten. Deleting
 * the other four hundred and ninety would be the tidy implementation and an
 * indefensible product: the customer spent a week entering them, and losing
 * that work is a reason never to come back, not a reason to pay.
 *
 * So nothing is deleted. The ten most recently moved articles stay under
 * watch — most recently moved, not oldest, because those are the ones the
 * account was actually using — and the rest are switched off. They keep their
 * history, they are still listed, and a payment switches them all back on.
 */
@Injectable()
export class TrialService {
  private readonly logger = new Logger(TrialService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    private readonly mail: MailService,
  ) {}

  /**
   * Ends the trials that have run out, and warns the ones about to.
   *
   * Hourly rather than daily: a trial that began at 14:00 should end around
   * 14:00 seven days later, not at whatever hour a nightly job happens to run,
   * which could hand out an extra twenty-three hours or cut the last day short.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepTrials(): Promise<{ ended: number; warned: number }> {
    const ended = await this.endLapsedTrials();
    const warned = await this.remindTrialsEndingSoon();

    if (ended || warned) {
      this.logger.log(`Trials: ended ${ended}, reminded ${warned}.`);
    }

    return { ended, warned };
  }

  /** Moves every lapsed trial back to the free plan. */
  private async endLapsedTrials(): Promise<number> {
    const lapsed = await this.users.find({
      where: {
        trialEndsAt: LessThanOrEqual(new Date()),
        plan: Not(UserPlan.Free),
        // A paid subscription clears `trialEndsAt`, so a row that still has one
        // has not been bought. The check is belt and braces against a webhook
        // that updated the plan without going through `activate`.
        subscriptionId: IsNull(),
      },
      take: 200,
    });

    for (const user of lapsed) {
      await this.endTrial(user);
    }

    return lapsed.length;
  }

  /**
   * Downgrades one account and parks what the free plan cannot watch.
   *
   * `trialEndsAt` is deliberately left in place. It is the record that this
   * address has had its trial, and clearing it would let the same mailbox take
   * another seven days of Pro tomorrow.
   */
  async endTrial(user: User): Promise<void> {
    const freeLimit = PLAN_PRODUCT_LIMIT[UserPlan.Free];

    const watched = await this.products.find({
      where: { ownerId: user.id, isActive: true },
      order: { lastUpdated: 'DESC', createdAt: 'DESC' },
      select: { id: true },
    });

    const parked = watched.slice(freeLimit).map((product) => product.id);

    if (parked.length > 0) {
      await this.products.update(parked, { isActive: false });
    }

    user.plan = UserPlan.Free;
    user.productLimit = freeLimit;
    user.aiMatchesLimit = PLAN_AI_MATCH_LIMIT[UserPlan.Free];
    // Spent, not reset. The free allowance is a one-off, and the trial's three
    // hundred comparisons were it — generously so.
    user.aiMatchesUsed = Math.max(user.aiMatchesUsed, PLAN_AI_MATCH_LIMIT[UserPlan.Free]);

    await this.users.save(user);
    await this.mail.sendTrialEnded(user, watched.length, parked.length);

    this.logger.log(
      `Trial ended for ${user.email}: ${watched.length - parked.length} articles still watched, ${parked.length} parked.`,
    );
  }

  /**
   * Warns accounts two days out, once each.
   *
   * The window is one hour wide and the sweep runs hourly, so each account
   * falls inside it exactly once — no "reminded already" column needed, and no
   * customer gets the same warning twenty-four times.
   */
  private async remindTrialsEndingSoon(): Promise<number> {
    const now = Date.now();
    const from = new Date(now + REMINDER_DAYS_BEFORE * 24 * 3600_000);
    const to = new Date(from.getTime() + 3600_000);

    const ending = await this.users.find({
      where: {
        trialEndsAt: Between(from, to),
        plan: Not(UserPlan.Free),
        subscriptionId: IsNull(),
      },
      take: 200,
    });

    for (const user of ending) {
      const watched = await this.products.count({ where: { ownerId: user.id, isActive: true } });
      await this.mail.sendTrialEnding(user, REMINDER_DAYS_BEFORE, watched);
    }

    return ending.length;
  }
}
