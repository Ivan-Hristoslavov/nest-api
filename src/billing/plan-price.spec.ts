import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLAN_CURRENCY, PLAN_PRICE, UserPlan, planPriceOf } from './entities/user.entity';

/**
 * One definition of what a plan costs.
 *
 * The number here is printed in two places that a customer will hold up next
 * to each other: the pricing page, and the "you paid X, we saved you Y" line
 * inside their account. They used to be two separate constants — one in the
 * page's markup, one in `app.js` — and nothing stopped them disagreeing. A
 * subscription figure that contradicts the pricing page does not read as a
 * display bug; it reads as the saving beside it being made up.
 */
describe('plan prices', () => {
  it('prices every plan the system can put an account on', () => {
    // A plan added to the enum without a price would reach `planPriceOf` as an
    // unknown string and quietly return null, leaving the ROI panel blank for
    // whoever is on it. Caught here instead.
    for (const plan of Object.values(UserPlan)) {
      expect(typeof PLAN_PRICE[plan]).toBe('number');
      expect(PLAN_PRICE[plan]).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the published prices', () => {
    // Pinned deliberately. These are the figures on the pricing page and in
    // Stripe; a change here is a commercial decision, and it should have to be
    // made on purpose rather than arrived at while editing something else.
    expect(PLAN_PRICE).toEqual({ free: 0, starter: 19, pro: 49, business: 99 });
  });

  it('prices the free plan at zero rather than leaving it out', () => {
    // Zero and "unknown" are different answers and the interface treats them
    // differently. Leaving `free` out of the table would make an account on it
    // indistinguishable from an account on a plan this deploy has never heard
    // of, and only one of those is a problem.
    expect(PLAN_PRICE[UserPlan.Free]).toBe(0);
    expect(planPriceOf('free')).toBe(0);
  });

  it('rises with every tier', () => {
    const tiers = [UserPlan.Free, UserPlan.Starter, UserPlan.Pro, UserPlan.Business];
    const prices = tiers.map((plan) => PLAN_PRICE[plan]);

    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(new Set(prices).size).toBe(prices.length);
  });

  it('quotes one currency, and names it', () => {
    expect(PLAN_CURRENCY).toBe('EUR');
    expect(PLAN_CURRENCY).toMatch(/^[A-Z]{3}$/);
  });

  describe('planPriceOf', () => {
    it.each(Object.values(UserPlan))('answers for %s', (plan) => {
      expect(planPriceOf(plan)).toBe(PLAN_PRICE[plan]);
    });

    it('returns null for a plan this deploy has no price for', () => {
      // The `plan` column is a string to Postgres. A value written by an older
      // deploy, a future tier or a hand-run UPDATE can reach a reader that has
      // no price for it, and "not known" is the only honest answer — falling
      // back to another tier's price would print a number nobody is charged.
      expect(planPriceOf('enterprise')).toBeNull();
      expect(planPriceOf('PRO')).toBeNull();
    });

    it('returns null rather than throwing on a missing plan', () => {
      expect(planPriceOf(null)).toBeNull();
      expect(planPriceOf(undefined)).toBeNull();
      expect(planPriceOf('')).toBeNull();
    });

    it('cannot be fooled by a name inherited from Object.prototype', () => {
      // `PLAN_PRICE['constructor']` is a function, not a price. Read through a
      // bare index it would sail past a `typeof price === 'number'` check only
      // by luck; asserted here because the plan value comes from a database
      // column rather than from the enum.
      expect(planPriceOf('constructor')).toBeNull();
      expect(planPriceOf('toString')).toBeNull();
      expect(planPriceOf('__proto__')).toBeNull();
    });
  });
});

/**
 * The interface holds no prices of its own.
 *
 * The point of moving these server-side was not tidiness — it was that two
 * copies of a number cannot be kept in step by intention alone. So the test is
 * not "the frontend has the right prices", it is **"the frontend has no
 * prices"**: the pricing page and the ROI panel both render whatever the
 * server sends, and there is nothing left that could disagree with it.
 */
describe('the interface does not keep its own copy of the prices', () => {
  const APP = readFileSync(join(__dirname, '../../public/app.js'), 'utf8');
  const INDEX = readFileSync(join(__dirname, '../../public/index.html'), 'utf8');

  it('has no price table in app.js', () => {
    expect(APP).not.toContain('PLAN_PRICES');

    // Nor the figures themselves, written into a lookup by another name. The
    // amounts still appear in this file inside sample and demo data, so the
    // check is for the shape of a price map rather than for the digits.
    expect(APP).not.toMatch(/\b(starter|pro|business)\s*:\s*\d+\s*[,}]/);
  });

  it('reads the subscription figure from /billing/me', () => {
    const roi = APP.slice(APP.indexOf('function currentPlanPrice('));
    const body = roi.slice(0, roi.indexOf('\n}\n') + 3);

    expect(body).toContain('account.planPrice');
  });

  it('renders the pricing cards from /billing/plans', () => {
    // Each card carries the plan it is for, so the painter can fill it from
    // the same table the account screen reads.
    for (const plan of ['starter', 'pro', 'business']) {
      expect(INDEX).toContain(`data-plan-price="${plan}"`);
    }

    expect(APP).toContain('paintPlanPrices');
  });

  it('ships markup that already agrees with the server', () => {
    // The cards carry their price as text too, so the page is right with
    // JavaScript off and right before the fetch resolves. That copy is allowed
    // to exist only because this test fails the moment it drifts.
    for (const plan of ['starter', 'pro', 'business'] as const) {
      const card = new RegExp(
        `data-plan-price="${plan}"[^>]*>[^0-9]*${PLAN_PRICE[plan as UserPlan]}<`,
      );
      expect(INDEX).toMatch(card);
    }
  });
});
