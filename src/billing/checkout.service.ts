import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { CheckoutConfig, Configuration, MailConfig, StripeConfig } from '../config/configuration';
import { UserPlan } from './entities/user.entity';

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
export class CheckoutService {
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

  get enabled(): boolean {
    return this.stripe !== null || Object.values(this.checkout.links).some(Boolean);
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
