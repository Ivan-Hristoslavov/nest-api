import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { CheckoutConfig, Configuration, MailConfig, StripeConfig } from '../config/configuration';
import { PLAN_CURRENCY, PLAN_PRICE, UserPlan } from './entities/user.entity';

/** Plans a visitor can buy. `free` is not one of them. */
export type PurchasablePlan = Extract<
  UserPlan,
  UserPlan.Starter | UserPlan.Pro | UserPlan.Business
>;

/**
 * Turning a visitor into a paying customer.
 *
 * A Checkout Session is the whole of the purchase flow: Stripe collects the
 * card and the billing details, and tells us afterwards over the webhook. No
 * card data reaches this application, which is the point — handling it would
 * put the whole system inside PCI scope for no benefit.
 *
 * The email is passed through so the account created by the webhook belongs to
 * the person who paid, rather than to whoever happened to be signed in.
 */
@Injectable()
export class CheckoutService implements OnModuleInit {
  private readonly logger = new Logger(CheckoutService.name);
  private readonly config: StripeConfig;
  private readonly checkout: CheckoutConfig;
  private readonly mail: MailConfig;
  private readonly stripe: Stripe | null;

  constructor(configService: ConfigService<Configuration, true>) {
    this.config = configService.get('stripe', { infer: true });
    this.checkout = configService.get('checkout', { infer: true });
    this.mail = configService.get('mail', { infer: true });

    // No explicit apiVersion: the pinned one belongs to the installed SDK, and
    // hard-coding a different string is how a library upgrade starts failing
    // to compile for no useful reason.
    this.stripe = this.config.secretKey ? new Stripe(this.config.secretKey) : null;
  }

  /**
   * Checks the prices we advertise against the ones Stripe will charge.
   *
   * These are two separate facts by construction. `PLAN_PRICE` is what the
   * pricing page and the ROI panel display; Stripe holds a *price id*, and the
   * amount behind it can be edited in their dashboard by somebody who will not
   * think to change a TypeScript constant. Nothing in either system notices,
   * and the failure is silent and expensive: the page offers €49, the card is
   * charged something else, and the first person to find out is the customer
   * reading their statement.
   *
   * Once at boot rather than per request. The alternative — asking Stripe
   * inside `/billing/me` — would put a third-party network call on a hot path
   * to render a number that changes a few times a year.
   *
   * A warning rather than a refusal to start. A mismatch is a business problem
   * and this is the only place it becomes visible, but it is not a reason to
   * take a working service down, and Stripe being unreachable at boot must
   * never be.
   */
  async onModuleInit(): Promise<void> {
    if (!this.stripe) return;

    for (const [plan, expected] of Object.entries(PLAN_PRICE)) {
      const priceId = this.config.prices[plan as PurchasablePlan];
      if (!priceId) continue;

      try {
        const price = await this.stripe.prices.retrieve(priceId);

        // Stripe quotes in minor units, and `unit_amount` is null for tiered
        // or metered prices — which these are not, but a null must not be
        // silently read as zero and reported as a mismatch against €49.
        if (price.unit_amount === null || price.unit_amount === undefined) {
          this.logger.warn(
            `Stripe price ${priceId} for "${plan}" has no fixed amount, so the advertised ` +
              `${expected} ${PLAN_CURRENCY} could not be checked against it.`,
          );
          continue;
        }

        const actual = price.unit_amount / 100;
        const currency = (price.currency ?? '').toUpperCase();

        if (actual !== expected || currency !== PLAN_CURRENCY) {
          this.logger.error(
            `Plan "${plan}" is advertised at ${expected} ${PLAN_CURRENCY} but Stripe charges ` +
              `${actual} ${currency}. The pricing page and every ROI figure are now wrong. ` +
              `Fix PLAN_PRICE in user.entity.ts, or the price in Stripe.`,
          );
        }
      } catch (error) {
        // Never fatal. A Stripe outage at boot is not a reason to refuse to
        // serve a comparison, and this check earns nothing at that moment.
        this.logger.warn(
          `Could not check the Stripe price for "${plan}": ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  get enabled(): boolean {
    return this.stripe !== null || Object.values(this.checkout.links).some(Boolean);
  }

  /** Where more AI comparisons are sold, when that is offered at all. */
  get topUpUrl(): string | null {
    return this.checkout.topUpLink ?? null;
  }

  /**
   * Which plans can actually be bought right now.
   *
   * A plan counts as buyable if it has a hosted link or a Stripe price — the
   * pricing page asks this rather than assuming, so a button never opens a
   * checkout that cannot complete.
   */
  availablePlans(): Array<{ plan: PurchasablePlan }> {
    const plans: PurchasablePlan[] = [UserPlan.Starter, UserPlan.Pro, UserPlan.Business];

    return plans
      .filter((plan) => Boolean(this.checkout.links[plan] ?? this.config.prices[plan]))
      .map((plan) => ({ plan }));
  }

  /**
   * Starts a subscription purchase and returns the URL to send the buyer to.
   *
   * @throws BadRequestException when Stripe or the plan's price is not
   * configured — an unconfigured plan must fail loudly here rather than send
   * somebody to a broken checkout page.
   */
  async createSession(plan: PurchasablePlan, email?: string): Promise<{ url: string; id: string }> {
    // A hosted link wins where one exists. Paddle and Lemon Squeezy — the
    // platforms that act as merchant of record, charge the customer in their
    // own name and handle EU VAT — give you a URL per price rather than an API
    // to create a session, and that is the arrangement most small sellers want.
    const link = this.checkout.links[plan];

    if (link) {
      // The email is passed along where the provider accepts it, so the
      // account the webhook creates belongs to the person who paid rather than
      // to whatever address they type at the till.
      const url = new URL(link);
      if (email) url.searchParams.set('checkout[email]', email);

      this.logger.log(`Hosted checkout link handed out for plan ${plan}`);
      return { url: url.toString(), id: `link_${plan}` };
    }

    if (!this.stripe) {
      throw new BadRequestException(
        'Плащането не е настроено (няма нито CHECKOUT_LINK_*, нито STRIPE_SECRET_KEY). ' +
          'Свържете се с нас, за да ви активираме акаунт.',
      );
    }

    const priceId = this.config.prices[plan];

    if (!priceId) {
      throw new BadRequestException(
        `Планът "${plan}" няма цена в Stripe. Създайте продукта в Stripe и задайте STRIPE_${plan.toUpperCase()}_PRICE_ID.`,
      );
    }

    const base = this.mail.appUrl.replace(/\/+$/, '');

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // Prefilled when known, collected by Stripe otherwise. Either way the
      // webhook receives it, and it is what the account is keyed on.
      customer_email: email,
      success_url: `${base}/?checkout=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/?checkout=cancelled`,
      // Carried back on the webhook, so the plan is known without having to
      // map a price id to a plan a second time.
      metadata: { plan },
      subscription_data: { metadata: { plan } },
      allow_promotion_codes: true,
    });

    if (!session.url) {
      throw new BadRequestException('Stripe не върна адрес за плащане. Опитайте пак.');
    }

    this.logger.log(`Checkout session ${session.id} created for plan ${plan}`);

    return { url: session.url, id: session.id };
  }
}
