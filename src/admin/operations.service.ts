import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Alert } from '../alerts/entities/alert.entity';
import { Competitor } from '../products/entities/competitor.entity';
import { ScrapeRunResultDto } from '../scraper/dto/scrape-run-result.dto';
import { ScraperService } from '../scraper/scraper.service';
import {
  AdminAlertDto,
  ScrapeFailureDto,
  ScrapeReportDto,
  StaleListingDto,
} from './dto/operations.dto';

/** A listing unchecked for longer than this is stale, whatever the schedule
 *  claims. The sweep runs hourly, so a full day of silence is a fault. */
const STALE_HOURS = 24;

/**
 * Pulls the host out of a stored URL.
 *
 * Done in SQL rather than in JavaScript so the grouping happens in the
 * database: pulling every failing listing across every customer into memory to
 * group four hosts would be the wrong shape at the first retailer who breaks
 * a thousand listings at once.
 */
const HOST_EXPRESSION = "regexp_replace(competitor.url, '^https?://(www\\.)?([^/:]+).*$', '\\2')";

@Injectable()
export class OperationsService {
  constructor(
    @InjectRepository(Competitor) private readonly competitors: Repository<Competitor>,
    @InjectRepository(Alert) private readonly alerts: Repository<Alert>,
    private readonly scraper: ScraperService,
  ) {}

  async scrapeReport(): Promise<ScrapeReportDto> {
    const [status, failures, stale] = await Promise.all([
      this.scraper.getStatus(),
      this.failuresByHost(),
      this.staleListings(),
    ]);

    return { status, failures, stale };
  }

  /** Runs a sweep now. The operator's path to the same work the cron does. */
  runSweep(): Promise<ScrapeRunResultDto> {
    return this.scraper.runSweep('manual');
  }

  private async failuresByHost(): Promise<ScrapeFailureDto[]> {
    const rows = await this.competitors
      .createQueryBuilder('competitor')
      .select(HOST_EXPRESSION, 'host')
      .addSelect('COUNT(*)', 'listings')
      .addSelect('SUM(competitor.failure_count)', 'attempts')
      .addSelect('MAX(competitor.last_checked_at)', 'lastCheckedAt')
      // The newest complaint on the host, not an arbitrary one: an error from
      // three weeks ago is not what you are about to go and fix.
      .addSelect(
        `(ARRAY_AGG(competitor.last_error ORDER BY competitor.last_checked_at DESC NULLS LAST))[1]`,
        'lastError',
      )
      .where("competitor.scrape_status = 'failed'")
      .andWhere('competitor.is_active')
      // The expression again rather than the alias: Postgres would not accept
      // `GROUP BY host` against the output column here and asked for the
      // column behind it, so it is spelled out on both sides.
      .groupBy(HOST_EXPRESSION)
      .orderBy('COUNT(*)', 'DESC')
      .limit(50)
      .getRawMany<{
        host: string;
        listings: string;
        attempts: string | null;
        lastError: string | null;
        lastCheckedAt: Date | null;
      }>();

    return rows.map((row) => ({
      host: row.host,
      listings: Number(row.listings),
      attempts: Number(row.attempts ?? 0),
      lastError: row.lastError,
      lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
    }));
  }

  private async staleListings(): Promise<StaleListingDto[]> {
    const cutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000);

    const rows = await this.competitors
      .createQueryBuilder('competitor')
      .innerJoin('competitor.product', 'product')
      .select('competitor.id', 'id')
      .addSelect('product.name', 'product')
      .addSelect('competitor.name', 'competitor')
      .addSelect(HOST_EXPRESSION, 'host')
      .addSelect('competitor.last_updated', 'lastUpdated')
      .where('competitor.is_active')
      .andWhere('(competitor.last_updated IS NULL OR competitor.last_updated < :cutoff)', {
        cutoff,
      })
      // Nulls last: a listing that has never been priced is a different
      // problem from one that stopped, and the ones that stopped are the ones
      // that changed recently enough to be worth chasing.
      .orderBy('competitor.last_updated', 'DESC', 'NULLS LAST')
      .limit(100)
      .getRawMany<{
        id: string;
        product: string;
        competitor: string;
        host: string;
        lastUpdated: Date | null;
      }>();

    return rows.map((row) => ({
      id: row.id,
      product: row.product,
      competitor: row.competitor,
      host: row.host,
      lastUpdated: row.lastUpdated ? new Date(row.lastUpdated).toISOString() : null,
    }));
  }

  /**
   * Recent alerts across every customer.
   *
   * Joined to the product and its owner in one query. The alert row alone says
   * "price dropped 12%" without saying whose product or which customer needed
   * to hear about it, which is unreadable on an operator screen.
   */
  async recentAlerts(limit: number, undeliveredOnly: boolean): Promise<AdminAlertDto[]> {
    const query = this.alerts
      .createQueryBuilder('alert')
      .innerJoin('alert.product', 'product')
      .leftJoin('users', 'owner', 'owner.id = product.owner_id')
      .select('alert.id', 'id')
      .addSelect('alert.type', 'type')
      .addSelect('alert.severity', 'severity')
      .addSelect('alert.message', 'message')
      .addSelect('alert.delivery_status', 'deliveryStatus')
      .addSelect('alert.delivery_error', 'deliveryError')
      .addSelect('alert.acknowledged_at', 'acknowledgedAt')
      .addSelect('alert.created_at', 'createdAt')
      .addSelect('product.name', 'product')
      .addSelect('owner.email', 'owner')
      .orderBy('alert.created_at', 'DESC')
      .limit(limit);

    if (undeliveredOnly) query.where("alert.delivery_status <> 'delivered'");

    const rows = await query.getRawMany<{
      id: string;
      type: string;
      severity: string;
      message: string;
      deliveryStatus: string;
      deliveryError: string | null;
      acknowledgedAt: Date | null;
      createdAt: Date;
      product: string;
      owner: string | null;
    }>();

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      severity: row.severity,
      message: row.message,
      product: row.product,
      owner: row.owner,
      deliveryStatus: row.deliveryStatus,
      deliveryError: row.deliveryError,
      acknowledged: Boolean(row.acknowledgedAt),
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }
}
