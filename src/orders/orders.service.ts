import { redactEmail } from '../common/redact';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';

import { User } from '../billing/entities/user.entity';
import { Shop } from '../shops/entities/shop.entity';
import { OrderLine } from './entities/order-line.entity';
import { Order, OrderStatus } from './entities/order.entity';

export interface DraftLine {
  query: string;
  matchedName?: string | null;
  url?: string | null;
  quantity: number;
  unitPrice: number;
}

export interface DraftOrder {
  shopId: string;
  note?: string | null;
  currency?: string;
  lines: DraftLine[];
}

/**
 * Turning "buy this here" into something a supplier can act on.
 *
 * The product already answers where to buy; without this the buyer copies the
 * answer into an email by hand, which is the same forty minutes the front page
 * promises to give back, moved to the afternoon.
 *
 * Deliberately not a marketplace. No money moves, no stock is reserved, and
 * nothing here commits either party — this builds a request, records what was
 * requested, and sends it *from the buyer*. Standing between two companies in
 * a commercial transaction is a different business with different liabilities,
 * and it is not the one being built.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  /** Order emails one account may send in a rolling 24 hours. */
  private static readonly MAX_SENDS_PER_DAY = 50;

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a draft, numbered within the account.
   *
   * The number and the row are written in one transaction with the count taken
   * under a lock, because two orders built in the same second must not both be
   * "#4" — the unique index would reject the second, and the buyer would lose
   * an order they had just spent five minutes assembling.
   */
  async create(owner: User, draft: DraftOrder): Promise<Order> {
    if (draft.lines.length === 0) {
      throw new BadRequestException('Поръчка без редове няма какво да каже на доставчика.');
    }

    const shop = await this.shops.findOne({ where: { id: draft.shopId, ownerId: owner.id } });

    if (!shop) {
      throw new NotFoundException('Няма такъв доставчик в списъка ви.');
    }

    return this.dataSource.transaction(async (manager) => {
      const orders = manager.getRepository(Order);

      // `pg_advisory_xact_lock` rather than a table lock: it is held for this
      // transaction only, it is scoped to this one account, and it costs
      // nothing to anybody ordering from a different account at the same time.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`orders:${owner.id}`]);

      const highest: Array<{ max: number | null }> = await manager.query(
        'SELECT MAX(number) AS max FROM orders WHERE owner_id = $1',
        [owner.id],
      );

      const lines = draft.lines.map((line) =>
        manager.create(OrderLine, {
          query: line.query,
          matchedName: line.matchedName ?? null,
          url: line.url ?? null,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          lineTotal: round(line.quantity * line.unitPrice),
        }),
      );

      const order = orders.create({
        ownerId: owner.id,
        number: (highest[0]?.max ?? 0) + 1,
        shopId: shop.id,
        shopName: shop.name,
        shopEmail: shop.orderEmail,
        status: OrderStatus.Draft,
        currency: draft.currency ?? shop.currency ?? 'EUR',
        total: round(lines.reduce((sum, line) => sum + line.lineTotal, 0)),
        note: draft.note?.trim() || null,
        lines,
      });

      const saved = await orders.save(order);
      this.logger.log(`Order #${saved.number} drafted for ${redactEmail(owner.email)} at ${shop.name}`);

      return saved;
    });
  }

  findAll(ownerId: string): Promise<Order[]> {
    return this.orders.find({ where: { ownerId }, order: { number: 'DESC' }, take: 200 });
  }

  async findOne(ownerId: string, id: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { id, ownerId } });

    // Scoped to the owner, so an id from somewhere else is *missing* rather
    // than forbidden: "forbidden" confirms the order exists to whoever guessed.
    if (!order) throw new NotFoundException('Няма такава поръчка.');

    return order;
  }

  /**
   * Refuses to keep sending once an account has sent a day's worth.
   *
   * The order email goes to an address the customer typed, from our server,
   * carrying whatever note they wrote. That is the shape of a mail relay, and
   * the only thing that had been standing in front of it was the global rate
   * limiter — which is about requests per minute, not about how much mail one
   * account can push through us in a day.
   *
   * The number is far above what a buyer does: placing fifty orders in a day
   * is a busy week's work. Somebody who genuinely hits it is somebody worth
   * talking to before the sending domain's reputation is spent for them.
   *
   * @throws BadRequestException when the day's allowance is gone.
   */
  async assertWithinDailySendLimit(ownerId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sent = await this.orders.count({ where: { ownerId, sentAt: MoreThan(since) } });

    if (sent >= OrdersService.MAX_SENDS_PER_DAY) {
      this.logger.warn(
        `Account ${ownerId} reached the daily order-email limit (${sent} in 24h).`,
      );

      throw new BadRequestException(
        `Изпратихте ${sent} поръчки за последните 24 часа, което е дневният лимит. ` +
          'Поръчката остава запазена — изпратете я утре или ни пишете.',
      );
    }
  }

  /** Records that it went out. Called only after the mail was accepted. */
  async markSent(order: Order): Promise<Order> {
    order.status = OrderStatus.Sent;
    order.sentAt = new Date();
    return this.orders.save(order);
  }

  /**
   * Moves an order to a state only the buyer can know.
   *
   * Confirmed and cancelled happen in a phone call or a reply we never see, so
   * they are marked by hand rather than inferred. A status this system guessed
   * at would be worse than no status.
   */
  async setStatus(ownerId: string, id: string, status: OrderStatus): Promise<Order> {
    const order = await this.findOne(ownerId, id);

    if (status === OrderStatus.Draft || status === OrderStatus.Sent) {
      throw new BadRequestException(
        'Само „потвърдена" и „отказана" се задават на ръка — останалите ги знае системата.',
      );
    }

    order.status = status;
    return this.orders.save(order);
  }

  /** Deletes a draft. Anything already sent is a record and stays. */
  async remove(ownerId: string, id: string): Promise<void> {
    const order = await this.findOne(ownerId, id);

    if (!order.isEditable()) {
      throw new BadRequestException(
        'Изпратената поръчка не се изтрива — доставчикът вече я е получил. Отбележете я като отказана.',
      );
    }

    await this.orders.delete({ id: order.id, ownerId });
  }
}

/** Money, to the cent, without the floating-point tail. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
