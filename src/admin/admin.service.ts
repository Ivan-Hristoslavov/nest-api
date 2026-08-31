import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Alert } from '../alerts/entities/alert.entity';
import { BillingEvent } from '../billing/entities/billing-event.entity';
import { User, UserPlan, UserStatus } from '../billing/entities/user.entity';
import { Competitor } from '../products/entities/competitor.entity';
import { Product } from '../products/entities/product.entity';
import { Shop } from '../shops/entities/shop.entity';
import {
  AdminOverviewDto,
  BillingDayDto,
  CustomerCountsDto,
  DailyPointDto,
  EventTotalsDto,
  ScrapeHealthDto,
  WorkloadDto,
} from './dto/overview.dto';
import { ShopUsageDto } from './dto/shop-usage.dto';

/** Ranges the charts offer. Thirty is the default because a month of trading
 *  fits on one screen without the bars becoming hairlines; seven is for the
 *  morning after a change, and ninety is for arguing about a trend. */
export const WINDOW_CHOICES = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_CHOICES)[number];

const DEFAULT_WINDOW: WindowDays = 30;

/** A listing unchecked for longer than this is stale, whatever the schedule
 *  claims. The sweep runs hourly, so a full day of silence is a fault. */
const STALE_HOURS = 24;

function toDayKey(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

/**
 * Every day in the window, including the empty ones.
 *
 * A chart drawn straight from `GROUP BY day` silently omits days nothing
 * happened, which draws a flat line through a gap and reads as steady trade
 * during a week with no sales. The zeroes have to be real.
 */
function fillDays<T extends { day: string }>(
  rows: T[],
  days: number,
  make: (day: string) => T,
): T[] {
  const found = new Map(rows.map((row) => [row.day, row]));
  const series: T[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = toDayKey(daysAgo(offset));
    series.push(found.get(day) ?? make(day));
  }

  return series;
}

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(BillingEvent) private readonly events: Repository<BillingEvent>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Competitor) private readonly competitors: Repository<Competitor>,
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
    @InjectRepository(Alert) private readonly alerts: Repository<Alert>,
  ) {}

  async overview(days: WindowDays = DEFAULT_WINDOW): Promise<AdminOverviewDto> {
    // Issued together: they touch six tables and none depends on another, so
    // the page costs one round of queries rather than six in a row.
    const [customers, workload, events, scrape, signups, billing] = await Promise.all([
      this.customerCounts(days),
      this.workload(),
      this.eventTotals(),
      this.scrapeHealth(),
      this.signupsByDay(days),
      this.billingByDay(days),
    ]);

    return { days, customers, workload, events, scrape, signups, billing };
  }

  private async customerCounts(days: number): Promise<CustomerCountsDto> {
    const byStatus = await this.users
      .createQueryBuilder('user')
      .select('user.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('user.status')
      .getRawMany<{ status: UserStatus; count: string }>();

    const byPlanRows = await this.users
      .createQueryBuilder('user')
      .select('user.plan', 'plan')
      .addSelect('COUNT(*)', 'count')
      .groupBy('user.plan')
      .getRawMany<{ plan: UserPlan; count: string }>();

    const status = (wanted: UserStatus): number =>
      Number(byStatus.find((row) => row.status === wanted)?.count ?? 0);

    // Every plan appears, including the ones nobody is on: a bar chart that
    // drops empty categories rearranges itself as customers arrive.
    const byPlan: Record<string, number> = {};
    for (const plan of Object.values(UserPlan)) {
      byPlan[plan] = Number(byPlanRows.find((row) => row.plan === plan)?.count ?? 0);
    }

    const [newInWindow, onTrial] = await Promise.all([
      this.users
        .createQueryBuilder('user')
        .where('user.created_at >= :since', { since: daysAgo(days) })
        .getCount(),
      this.users.createQueryBuilder('user').where('user.trial_ends_at > NOW()').getCount(),
    ]);

    return {
      total: byStatus.reduce((sum, row) => sum + Number(row.count), 0),
      active: status(UserStatus.Active),
      pending: status(UserStatus.Pending),
      expired: status(UserStatus.Expired),
      suspended: status(UserStatus.Suspended),
      byPlan,
      newInWindow,
      onTrial,
    };
  }

  private async workload(): Promise<WorkloadDto> {
    const [products, competitors, shops, alerts] = await Promise.all([
      this.products.count(),
      this.competitors.count(),
      this.shops.count(),
      this.alerts.count(),
    ]);

    return { products, competitors, shops, alerts };
  }

  private async eventTotals(): Promise<EventTotalsDto> {
    // `note` rather than an error column: the table has no such column, and
    // the note it does have is set both when an event failed and when it was
    // deliberately ignored. Counting notes as failures would report every
    // "subscription.updated we do not act on" as a fault. What actually
    // matters is `processed` — an event that arrived and changed nothing is
    // the one behind "they paid and got nothing".
    const row = await this.events
      .createQueryBuilder('event')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE event.processed)', 'processed')
      .addSelect('COUNT(*) FILTER (WHERE event.note IS NOT NULL)', 'noted')
      .addSelect('MAX(event.received_at)', 'last')
      .getRawOne<{ total: string; processed: string; noted: string; last: Date | null }>();

    const total = Number(row?.total ?? 0);
    const processed = Number(row?.processed ?? 0);

    return {
      total,
      processed,
      unprocessed: total - processed,
      noted: Number(row?.noted ?? 0),
      lastReceivedAt: row?.last ? new Date(row.last).toISOString() : null,
    };
  }

  private async scrapeHealth(): Promise<ScrapeHealthDto> {
    const stale = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);

    // Every count here is scoped to active listings, and that is not a detail:
    // a switched-off listing keeps whatever status it had when it was switched
    // off, so counting those as failures reports work nobody is asking for.
    // It also made this tile disagree with the operations screen, which only
    // ever lists live listings — two numbers for one question is worse than
    // either number alone.
    const row = await this.competitors
      .createQueryBuilder('competitor')
      .select(
        "COUNT(*) FILTER (WHERE competitor.is_active AND competitor.scrape_status = 'success')",
        'ok',
      )
      .addSelect(
        "COUNT(*) FILTER (WHERE competitor.is_active AND competitor.scrape_status = 'failed')",
        'failed',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE competitor.is_active AND (competitor.last_updated IS NULL OR competitor.last_updated < :stale))',
        'stale',
      )
      .setParameter('stale', stale)
      .getRawOne<{ ok: string; failed: string; stale: string }>();

    return {
      ok: Number(row?.ok ?? 0),
      failed: Number(row?.failed ?? 0),
      stale: Number(row?.stale ?? 0),
    };
  }

  private async signupsByDay(days: number): Promise<DailyPointDto[]> {
    const rows = await this.users
      .createQueryBuilder('user')
      .select("TO_CHAR(DATE_TRUNC('day', user.created_at), 'YYYY-MM-DD')", 'day')
      .addSelect('COUNT(*)', 'count')
      .where('user.created_at >= :since', { since: daysAgo(days - 1) })
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string; count: string }>();

    return fillDays(
      rows.map((row) => ({ day: row.day, count: Number(row.count) })),
      days,
      (day) => ({ day, count: 0 }),
    );
  }

  private async billingByDay(days: number): Promise<BillingDayDto[]> {
    const rows = await this.events
      .createQueryBuilder('event')
      .select("TO_CHAR(DATE_TRUNC('day', event.received_at), 'YYYY-MM-DD')", 'day')
      .addSelect('COUNT(*)', 'received')
      .addSelect('COUNT(*) FILTER (WHERE event.processed)', 'processed')
      .where('event.received_at >= :since', { since: daysAgo(days - 1) })
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string; received: string; processed: string }>();

    return fillDays(
      rows.map((row) => {
        const received = Number(row.received);
        const processed = Number(row.processed);
        return { day: row.day, received, processed, unprocessed: received - processed };
      }),
      days,
      (day) => ({ day, received: 0, processed: 0, unprocessed: 0 }),
    );
  }

  /**
   * Supplier sites, one row per host rather than per customer.
   *
   * `MIN(name)` rather than any name in particular: the same host gets a
   * different label from every customer who added it, and the operator needs
   * something stable to read, not the most recent opinion.
   */
  async shopUsage(): Promise<ShopUsageDto[]> {
    const rows = await this.shops
      .createQueryBuilder('shop')
      .select('shop.host', 'host')
      .addSelect('MIN(shop.name)', 'name')
      .addSelect('COUNT(DISTINCT shop.owner_id)', 'owners')
      .addSelect('COUNT(*) FILTER (WHERE shop.is_active)', 'active')
      .addSelect('BOOL_OR(shop.has_website)', 'hasWebsite')
      .addSelect('MIN(shop.search_method)', 'searchMethod')
      .addSelect('MAX(shop.last_searched_at)', 'lastSearchedAt')
      .addSelect(
        '(SELECT COUNT(*) FROM manual_prices mp JOIN shops s ON s.id = mp.shop_id WHERE s.host = shop.host)',
        'manualPrices',
      )
      // The newest complaint, not the first: an error fixed last month is
      // noise next to one from this morning.
      .addSelect(
        '(SELECT s.search_blocked_reason FROM shops s WHERE s.host = shop.host AND s.search_blocked_reason IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1)',
        'blockedReason',
      )
      .addSelect(
        '(SELECT s.last_error FROM shops s WHERE s.host = shop.host AND s.last_error IS NOT NULL ORDER BY s.updated_at DESC LIMIT 1)',
        'lastError',
      )
      .groupBy('shop.host')
      .orderBy('owners', 'DESC')
      .addOrderBy('shop.host', 'ASC')
      .getRawMany<{
        host: string;
        name: string;
        owners: string;
        active: string;
        hasWebsite: boolean;
        searchMethod: string;
        lastSearchedAt: Date | null;
        manualPrices: string;
        blockedReason: string | null;
        lastError: string | null;
      }>();

    return rows.map((row) => ({
      host: row.host,
      name: row.name,
      owners: Number(row.owners),
      active: Number(row.active),
      hasWebsite: Boolean(row.hasWebsite),
      searchMethod: row.searchMethod,
      manualPrices: Number(row.manualPrices),
      lastSearchedAt: row.lastSearchedAt ? new Date(row.lastSearchedAt).toISOString() : null,
      blockedReason: row.blockedReason,
      lastError: row.lastError,
    }));
  }

  /** Recent webhooks, newest first. `onlyUnprocessed` is the support view:
   *  the events that arrived and did not turn into an account. */
  recentEvents(limit: number, onlyUnprocessed: boolean): Promise<BillingEvent[]> {
    const query = this.events
      .createQueryBuilder('event')
      .orderBy('event.received_at', 'DESC')
      .take(limit);

    if (onlyUnprocessed) query.where('event.processed = false');

    return query.getMany();
  }
}
