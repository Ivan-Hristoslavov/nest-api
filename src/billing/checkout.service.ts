import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { Configuration, MailConfig, StripeConfig } from '../config/configuration';
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
  private readonly mail: MailConfig;
  private readonly stripe: Stripe | null;

  constructor(configService: ConfigService<Configuration, true>) {
    this.config = configService.get('stripe', { infer: true });
    this.mail = configService.get('mail', { infer: true });

    // No explicit apiVersion: the pinned one belongs to the installed SDK, and
    // hard-coding a different string is how a library upgrade starts failing
    // to compile for no useful reason.
    this.stripe = this.config.secretKey ? new Stripe(this.config.secretKey) : null;
  }

  get enabled(): boolean {
    return this.stripe !== null;
  }

  /** Which plans have a price configured, so the UI offers only real ones. */
  availablePlans(): Array<{ plan: PurchasablePlan; priceId: string }> {
    const plans: PurchasablePlan[] = [UserPlan.Starter, UserPlan.Pro, UserPlan.Business];

    return plans
      .map((plan) => ({ plan, priceId: this.config.prices[plan] }))
      .filter((entry): entry is { plan: PurchasablePlan; priceId: string } =>
        Boolean(entry.priceId),
      );
  }

  /**
   * Starts a subscription purchase and returns the URL to send the buyer to.
   *
   * @throws BadRequestException when Stripe or the plan's price is not
   * configured — an unconfigured plan must fail loudly here rather than send
   * somebody to a broken checkout page.
   */
  async createSession(plan: PurchasablePlan, email?: string): Promise<{ url: string; id: string }> {
    if (!this.stripe) {
      throw new BadRequestException(
        'Плащането не е настроено (липсва STRIPE_SECRET_KEY). Свържете се с нас, за да ви активираме акаунт.',
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
