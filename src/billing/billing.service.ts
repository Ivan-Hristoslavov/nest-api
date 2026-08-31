import { redactEmail } from '../common/redact';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';

import { Configuration } from '../config/configuration';
import { BillingEvent } from './entities/billing-event.entity';
import { UserPlan } from './entities/user.entity';
import { MailService } from './mail.service';
import { UsersService } from './users.service';

/** Normalised view of a provider payload, so the handlers stay provider-agnostic. */
export interface NormalisedBillingEvent {
  eventId: string;
  eventType: string;
  email: string | null;
  name: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  paymentId: string | null;
  /** Plan slug from the product/variant name, when derivable. */
  plan: UserPlan | null;
  /** Price ids this payment covered, for recognising a top-up. */
  priceIds: string[];
  /** End of the paid period, when the provider states one. */
  expiresAt: Date | null;
}

export interface WebhookOutcome {
  received: true;
  processed: boolean;
  duplicate: boolean;
  note: string;
  userId?: string;
  /** The plaintext key, present only when one was just issued. */
  apiKey?: string;
}

/** Provider events that grant or renew access. */
const ACTIVATING_EVENTS = new Set([
  // Paddle Billing
  'subscription.created',
  'subscription.activated',
  'subscription.updated',
  'transaction.completed',
  'transaction.paid',
  // Lemon Squeezy
  'order_created',
  'subscription_created',
  'subscription_payment_success',
  'subscription_resumed',
  'subscription_unpaused',
  // Stripe
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_succeeded',
  'customer.subscription.created',
  // Generic
  'payment.succeeded',
]);

/** Provider events that revoke access. */
const REVOKING_EVENTS = new Set([
  'subscription.canceled',
  'subscription.cancelled',
  'subscription.paused',
  'subscription.past_due',
  'transaction.payment_failed',
  'subscription_cancelled',
  'subscription_expired',
  'subscription_paused',
  'subscription_payment_failed',
  // Stripe
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'payment.failed',
]);

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  private readonly topUpPacks: Record<string, number>;
  private readonly planByPriceId: Record<string, UserPlan>;

  constructor(
    @InjectRepository(BillingEvent)
    private readonly eventsRepository: Repository<BillingEvent>,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
    configService: ConfigService<Configuration, true>,
  ) {
    this.topUpPacks = configService.get('checkout', { infer: true }).topUpPacks;

    // Price id -> plan, inverted once at boot. Stripe names neither the plan
    // nor the product in a webhook payload, so without this the only thing
    // identifying what was bought is the price the buyer was charged.
    const prices = configService.get('stripe', { infer: true })?.prices ?? {};
    this.planByPriceId = Object.fromEntries(
      Object.entries(prices)
        .filter(([, priceId]) => Boolean(priceId))
        .map(([plan, priceId]) => [priceId, plan as UserPlan]),
    );
  }

  /**
   * Applies one verified webhook.
   *
   * The signature has already been checked by the controller; this method owns
   * idempotency and the state transition. It never throws for business reasons:
   * the provider must always receive a 2xx for anything it delivered correctly,
   * otherwise it retries forever over an event we simply do not care about.
   */
  async handleWebhook(provider: string, payload: Record<string, unknown>): Promise<WebhookOutcome> {
    const event = this.normalise(provider, payload);

    // Claim the event id first. The unique index makes this the single point
    // where a retry is detected, whatever the concurrency.
    const claim = await this.claim(event, payload);
    if (claim.duplicate) {
      this.logger.log(`Ignoring duplicate webhook ${event.eventId} (${event.eventType}).`);
      return {
        received: true,
        processed: false,
        duplicate: true,
        note: 'Event already processed',
      };
    }

    const record = claim.record;

    // Checked before activation: a top-up is a completed payment like any
    // other, and read as one it would move the customer onto a plan they did
    // not buy.
    const credited = this.topUpFor(event);

    if (credited > 0) {
      return this.creditTopUp(event, record, credited);
    }

    if (ACTIVATING_EVENTS.has(event.eventType)) {
      return this.activate(event, record);
    }

    if (REVOKING_EVENTS.has(event.eventType)) {
      return this.revoke(event, record);
    }

    await this.finish(record, false, `Event type "${event.eventType}" is not handled`);
    this.logger.debug(`Webhook ${event.eventId} (${event.eventType}) needs no action.`);

    return {
      received: true,
      processed: false,
      duplicate: false,
      note: `Event type "${event.eventType}" is not handled`,
    };
  }

  /**
   * Grants access: finds or creates the customer, activates them, and issues a
   * key when they do not have one yet.
   *
   * A key is *not* rotated on renewal — a subscription renewing every month
   * must not invalidate the key the customer has already deployed.
   */
  private async activate(
    event: NormalisedBillingEvent,
    record: BillingEvent,
  ): Promise<WebhookOutcome> {
    if (!event.email) {
      await this.finish(record, false, 'No customer email in payload');
      this.logger.error(`Webhook ${event.eventId} carried no customer email — cannot provision.`);
      return {
        received: true,
        processed: false,
        duplicate: false,
        note: 'No customer email in payload',
      };
    }

    const user = await this.usersService.findOrCreateByEmail(event.email, event.name);

    await this.usersService.activate(user.id, {
      plan: event.plan ?? UserPlan.Starter,
      customerId: event.customerId,
      subscriptionId: event.subscriptionId,
      paymentId: event.paymentId,
      expiresAt: event.expiresAt,
    });

    let apiKey: string | undefined;
    let delivered = false;

    if (!user.apiKeyPrefix) {
      const issued = await this.usersService.issueApiKey(user.id, 'live');
      apiKey = issued.apiKey;

      // The plaintext exists only here — the column holds a hash — so this is
      // the one moment it can be delivered. A failure to send is logged and
      // reported, never thrown: the charge succeeded and the account is live,
      // and a webhook that answers non-2xx makes the provider retry a payment
      // that already worked.
      delivered = await this.mail.sendApiKey(issued.user, issued.apiKey);

      if (!delivered) {
        this.logger.warn(
          `Issued the first API key for ${user.email} but could NOT email it. ` +
            'Deliver it from the operator screen — it cannot be retrieved later.',
        );
      }
    }

    const note = apiKey
      ? delivered
        ? 'Account activated, API key issued and emailed'
        : 'Account activated, API key issued but NOT delivered — send it manually'
      : 'Account activated';

    await this.finish(record, true, note, user.id);

    return {
      received: true,
      processed: true,
      duplicate: false,
      note,
      userId: user.id,
      apiKey,
    };
  }

  private async revoke(
    event: NormalisedBillingEvent,
    record: BillingEvent,
  ): Promise<WebhookOutcome> {
    const user = event.email ? await this.usersService.findByEmail(event.email) : null;

    if (!user) {
      await this.finish(record, false, 'No matching user to revoke');
      return {
        received: true,
        processed: false,
        duplicate: false,
        note: 'No matching user',
      };
    }

    await this.usersService.expire(user.id, `Billing event ${event.eventType}`);
    await this.finish(record, true, `Expired via ${event.eventType}`, user.id);

    return {
      received: true,
      processed: true,
      duplicate: false,
      note: 'Account access revoked',
      userId: user.id,
    };
  }

  /**
   * Inserts the audit row, treating a unique-violation as "already seen".
   * Insert-then-detect rather than check-then-insert: the latter has a race
   * window that two simultaneous retries fit through neatly.
   */
  private async claim(
    event: NormalisedBillingEvent,
    payload: Record<string, unknown>,
  ): Promise<{ duplicate: boolean; record: BillingEvent }> {
    const record = this.eventsRepository.create({
      eventId: event.eventId,
      provider: event.eventType.includes('_') ? 'lemonsqueezy' : 'paddle',
      eventType: event.eventType,
      email: event.email,
      payload,
      processed: false,
    });

    try {
      return { duplicate: false, record: await this.eventsRepository.save(record) };
    } catch (error) {
      const code = (error as QueryFailedError & { driverError?: { code?: string } }).driverError
        ?.code;

      if (error instanceof QueryFailedError && code === '23505') {
        return { duplicate: true, record };
      }

      throw error;
    }
  }

  private async finish(
    record: BillingEvent,
    processed: boolean,
    note: string,
    userId?: string,
  ): Promise<void> {
    record.processed = processed;
    record.note = note;
    if (userId) record.userId = userId;

    await this.eventsRepository.save(record);
  }

  /** How many comparisons this payment bought, or zero if it bought none. */
  private topUpFor(event: NormalisedBillingEvent): number {
    if (!ACTIVATING_EVENTS.has(event.eventType)) return 0;

    return event.priceIds.reduce((total, id) => total + (this.topUpPacks[id] ?? 0), 0);
  }

  /**
   * Adds bought comparisons to an account, creating it if the buyer is new.
   *
   * A top-up never changes the plan and never issues a key on its own: someone
   * buying more comparisons for an account they already use must not have that
   * account's key rotated as a side effect of paying.
   */
  private async creditTopUp(
    event: NormalisedBillingEvent,
    record: BillingEvent,
    count: number,
  ): Promise<WebhookOutcome> {
    if (!event.email) {
      await this.finish(record, false, 'No customer email in payload');
      return {
        received: true,
        processed: false,
        duplicate: false,
        note: 'No customer email in payload',
      };
    }

    const user = await this.usersService.findOrCreateByEmail(event.email, event.name);
    const credited = await this.usersService.creditAiComparisons(user.id, count);

    await this.finish(record, true, `Credited ${count} AI comparisons`, credited.id);
    await this.mail.sendTopUpReceipt(credited, count);

    this.logger.log(`Top-up: ${count} comparisons for ${redactEmail(credited.email)}`);

    return {
      received: true,
      processed: true,
      duplicate: false,
      note: `Credited ${count} AI comparisons`,
      userId: credited.id,
    };
  }

  /**
   * Flattens the two providers' very different payload shapes into one struct.
   *
   * Paddle Billing nests everything under `data`; Lemon Squeezy splits it
   * between `meta` and `data.attributes`. Both are read defensively — a missing
   * field must produce `null`, never a crash on someone else's schema change.
   */
  normalise(provider: string, payload: Record<string, unknown>): NormalisedBillingEvent {
    // Stripe nests the subject one level deeper — `data.object` — and names
    // the type `type` rather than `event_type`. Flattening it here keeps every
    // provider on one path rather than forking the whole method.
    const stripeObject = this.record(this.record(payload.data).object);
    const isStripe = Object.keys(stripeObject).length > 0 && Boolean(payload.type);

    const data = isStripe ? stripeObject : this.record(payload.data);
    const meta = this.record(payload.meta);
    const attributes = this.record(data.attributes);

    // Paddle: event_type + data.id; Lemon Squeezy: meta.event_name + data.id.
    const eventType =
      this.string(payload.event_type) ??
      this.string(payload.type) ??
      this.string(meta.event_name) ??
      'unknown';

    const eventId =
      this.string(payload.event_id) ??
      this.string(payload.notification_id) ??
      // Stripe's own `evt_…`, which is already stable across retries.
      (isStripe ? this.string(payload.id) : undefined) ??
      this.string(meta.event_id) ??
      // Lemon Squeezy has no event id: derive a stable one from the payload so
      // retries still collapse onto a single row.
      `${provider}:${eventType}:${this.string(data.id) ?? 'unknown'}:${
        this.string(attributes.updated_at) ?? this.string(data.occurred_at) ?? ''
      }`;

    const customer = this.record(data.customer);
    const customData = this.record(meta.custom_data);

    const email =
      // Stripe Checkout puts it here; a subscription event carries it on the
      // customer object once expanded.
      this.string(data.customer_email) ??
      this.string(this.record(data.customer_details).email) ??
      this.string(customer.email) ??
      this.string(attributes.user_email) ??
      this.string(data.customer_email) ??
      this.string(customData.email) ??
      this.string(payload.email);

    const name =
      this.string(this.record(data.customer_details).name) ??
      this.string(customer.name) ??
      this.string(attributes.user_name) ??
      this.string(customData.name);

    // Computed once: it identifies the plan as well as separating a top-up
    // from a subscription.
    const priceIds = this.priceIdsFrom(data, attributes);

    return {
      eventId,
      eventType,
      email: email ?? null,
      name: name ?? null,
      customerId:
        this.string(data.customer_id) ??
        this.string(customer.id) ??
        this.string(attributes.customer_id) ??
        null,
      subscriptionId:
        this.string(data.subscription_id) ??
        (eventType.startsWith('subscription') ? this.string(data.id) : null) ??
        null,
      paymentId:
        this.string(data.transaction_id) ??
        this.string(attributes.order_id) ??
        this.string(data.id) ??
        null,
      // The price is the fallback, and the more trustworthy of the two: a
      // label can be renamed in a dashboard, an id cannot. Without either,
      // `activate` falls back to the cheapest plan — so a Stripe payload
      // carrying neither would upgrade a customer who paid €99 to Занаят.
      plan: this.planFrom(attributes, data) ?? this.planFromPriceIds(priceIds),
      priceIds,
      expiresAt: this.dateFrom(
        this.string(data.next_billed_at) ??
          this.string(attributes.renews_at) ??
          this.string(attributes.ends_at) ??
          this.string(data.current_billing_period_ends_at),
      ),
    };
  }

  /**
   * Every price this payment covered.
   *
   * A top-up and a subscription arrive as the same kind of event, so the price
   * is the only thing that distinguishes them. Collected from the shapes the
   * three providers use rather than one, because the alternative is a top-up
   * silently read as a plan change.
   */
  private priceIdsFrom(
    data: Record<string, unknown>,
    attributes: Record<string, unknown>,
  ): string[] {
    const ids: string[] = [];

    const push = (value: unknown): void => {
      const id = this.string(value);
      if (id) ids.push(id);
    };

    // Paddle Billing: data.items[].price.id
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const record = this.record(item);
      push(this.record(record.price).id);
      push(record.price_id);
    }

    // Lemon Squeezy keeps the variant on the order attributes.
    push(attributes.variant_id);
    push(attributes.first_order_item);

    // Stripe: the price rides on the line items when they are expanded, and on
    // metadata otherwise.
    const lineItems = Array.isArray(this.record(data.line_items).data)
      ? (this.record(data.line_items).data as unknown[])
      : [];
    for (const line of lineItems) {
      push(this.record(this.record(line).price).id);
    }
    push(this.record(data.metadata).price_id);

    return [...new Set(ids)];
  }

  /** Maps a product/variant name onto a plan, defaulting to Starter. */
  /** The plan a payment's price ids belong to, from `STRIPE_*_PRICE_ID`. */
  private planFromPriceIds(priceIds: string[]): UserPlan | null {
    for (const id of priceIds) {
      const plan = this.planByPriceId[id];
      if (plan) return plan;
    }

    return null;
  }

  private planFrom(
    attributes: Record<string, unknown>,
    data: Record<string, unknown>,
  ): UserPlan | null {
    const label = (
      this.string(attributes.variant_name) ??
      this.string(attributes.product_name) ??
      this.string(data.plan) ??
      // Stripe names neither: a Checkout Session carries whatever metadata the
      // payment link was created with, and ours is created carrying the plan.
      this.string(this.record(data.metadata).plan) ??
      ''
    ).toLowerCase();

    if (!label) return null;
    if (label.includes('business') || label.includes('enterprise')) return UserPlan.Business;
    if (label.includes('pro')) return UserPlan.Pro;
    if (label.includes('starter') || label.includes('basic')) return UserPlan.Starter;

    return null;
  }

  private record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private string(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    return null;
  }

  private dateFrom(value: string | null): Date | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }

  /** Recent webhooks, for the support endpoint. */
  findRecentEvents(limit: number): Promise<BillingEvent[]> {
    return this.eventsRepository.find({ order: { receivedAt: 'DESC' }, take: limit });
  }

  /** Exposed for the tests and for documenting the state machine. */
  static get handledEventTypes(): { activating: string[]; revoking: string[] } {
    return { activating: [...ACTIVATING_EVENTS], revoking: [...REVOKING_EVENTS] };
  }
}
