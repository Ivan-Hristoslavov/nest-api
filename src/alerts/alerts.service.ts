import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';

import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { AlertsConfig, Configuration } from '../config/configuration';
import { QueryAlertsDto } from './dto/query-alerts.dto';
import { Alert } from './entities/alert.entity';
import { AlertDeliveryStatus, AlertSeverity, AlertType } from './enums/alert.enums';
import { ALERT_NOTIFIERS, AlertContext, AlertNotifier } from './notifiers/notifier.interface';

/** Everything needed to raise one alert. */
export interface RaiseAlertInput {
  productId: string;
  competitorId: string | null;
  type: AlertType;
  severity?: AlertSeverity;
  message: string;
  oldPrice: number | null;
  newPrice: number | null;
  changePercent: number | null;
  currency: string;
  context: AlertContext;
}

/** Default severity per alert type, overridable per call. */
const DEFAULT_SEVERITY: Record<AlertType, AlertSeverity> = {
  [AlertType.PriceDrop]: AlertSeverity.Warning,
  [AlertType.PriceRise]: AlertSeverity.Info,
  [AlertType.Undercut]: AlertSeverity.Critical,
  [AlertType.AllTimeLow]: AlertSeverity.Warning,
  [AlertType.OutOfStock]: AlertSeverity.Info,
  [AlertType.ScrapeFailing]: AlertSeverity.Warning,
};

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly config: AlertsConfig;

  constructor(
    @InjectRepository(Alert)
    private readonly alertsRepository: Repository<Alert>,
    @Inject(ALERT_NOTIFIERS)
    private readonly notifiers: AlertNotifier[],
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('alerts', { infer: true });
  }

  /**
   * Persists an alert, then attempts delivery.
   *
   * Persist-then-send, never send-then-persist: a Slack outage must not lose
   * the signal, and a stored alert with `deliveryStatus = failed` can be
   * inspected and retried. Delivery failures never propagate to the caller —
   * the scraper must not abort a sweep because a webhook is down.
   *
   * Returns null when the alert was suppressed by the cooldown.
   */
  async raise(input: RaiseAlertInput): Promise<Alert | null> {
    if (!this.config.enabled) return null;

    if (await this.isWithinCooldown(input)) {
      this.logger.debug(
        `Suppressed ${input.type} for product ${input.productId}: within the ${this.config.cooldownMinutes}min cooldown.`,
      );
      return null;
    }

    const alert = await this.alertsRepository.save(
      this.alertsRepository.create({
        productId: input.productId,
        competitorId: input.competitorId,
        type: input.type,
        severity: input.severity ?? DEFAULT_SEVERITY[input.type],
        message: input.message,
        oldPrice: input.oldPrice,
        newPrice: input.newPrice,
        changePercent: input.changePercent,
        currency: input.currency,
        deliveryStatus: AlertDeliveryStatus.Pending,
      }),
    );

    await this.deliver(alert, input.context);
    return alert;
  }

  /**
   * Sends an alert through every configured channel and records the outcome.
   * Channels are independent: Slack failing does not stop the webhook.
   */
  async deliver(alert: Alert, context: AlertContext): Promise<Alert> {
    const active = this.notifiers.filter((notifier) => notifier.isConfigured());

    if (active.length === 0) {
      alert.deliveryStatus = AlertDeliveryStatus.Skipped;
      alert.deliveryError = 'No notification channel configured';
      this.logger.warn(
        `Alert ${alert.id} (${alert.type}) stored but not sent — configure ALERT_SLACK_WEBHOOK_URL or ALERT_WEBHOOK_URL.`,
      );
      return this.alertsRepository.save(alert);
    }

    const delivered: string[] = [];
    const failures: string[] = [];

    await Promise.all(
      active.map(async (notifier) => {
        try {
          await notifier.send(alert, context);
          delivered.push(notifier.channel);
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'unknown error';
          failures.push(`${notifier.channel}: ${reason}`);
          this.logger.error(`Alert ${alert.id} failed on ${notifier.channel}: ${reason}`);
        }
      }),
    );

    alert.deliveredChannels = delivered.length > 0 ? delivered : null;
    alert.deliveryError = failures.length > 0 ? failures.join('; ').slice(0, 1000) : null;
    alert.deliveryStatus =
      delivered.length > 0 ? AlertDeliveryStatus.Delivered : AlertDeliveryStatus.Failed;

    return this.alertsRepository.save(alert);
  }

  async findAll(ownerId: string, query: QueryAlertsDto): Promise<PaginatedResponseDto<Alert>> {
    const qb = this.alertsRepository
      .createQueryBuilder('alert')
      // An inner join, not a left one: an alert always concerns a product, and
      // ownership is recorded there. Left-joining would return alerts whose
      // product row failed the filter.
      .innerJoinAndSelect('alert.product', 'product')
      .leftJoinAndSelect('alert.competitor', 'competitor')
      .where('product.owner_id = :ownerId', { ownerId });

    if (query.productId) {
      qb.andWhere('alert.productId = :productId', { productId: query.productId });
    }
    if (query.type) {
      qb.andWhere('alert.type = :type', { type: query.type });
    }
    if (query.severity) {
      qb.andWhere('alert.severity = :severity', { severity: query.severity });
    }
    if (query.unacknowledgedOnly) {
      qb.andWhere('alert.acknowledgedAt IS NULL');
    }
    if (query.since) {
      qb.andWhere('alert.createdAt >= :since', { since: query.since });
    }

    qb.orderBy('alert.createdAt', 'DESC')
      .addOrderBy('alert.id', 'ASC')
      .skip(query.offset)
      .take(query.limit);

    const [items, total] = await qb.getManyAndCount();
    return new PaginatedResponseDto(items, total, query.limit, query.offset);
  }

  async findOne(ownerId: string, id: string): Promise<Alert> {
    const alert = await this.alertsRepository
      .createQueryBuilder('alert')
      .innerJoinAndSelect('alert.product', 'product')
      .leftJoinAndSelect('alert.competitor', 'competitor')
      .where('alert.id = :id', { id })
      .andWhere('product.owner_id = :ownerId', { ownerId })
      .getOne();

    if (!alert) {
      throw new NotFoundException(`Alert with id "${id}" not found.`);
    }

    return alert;
  }

  /** Marks an alert as handled. Idempotent: the first timestamp is kept. */
  async acknowledge(ownerId: string, id: string): Promise<Alert> {
    const alert = await this.findOne(ownerId, id);

    if (alert.acknowledgedAt === null) {
      alert.acknowledgedAt = new Date();
      await this.alertsRepository.save(alert);
    }

    return alert;
  }

  /** Re-attempts delivery for an alert that previously failed. */
  async retryDelivery(ownerId: string, id: string, context: AlertContext): Promise<Alert> {
    return this.deliver(await this.findOne(ownerId, id), context);
  }

  async countUnacknowledged(ownerId: string): Promise<number> {
    // IsNull(), not `undefined`: an undefined value is treated as "no filter"
    // by TypeORM and would silently count every alert ever raised.
    return this.alertsRepository
      .createQueryBuilder('alert')
      .innerJoin('alert.product', 'product')
      .where('product.owner_id = :ownerId', { ownerId })
      .andWhere('alert.acknowledged_at IS NULL')
      .getCount();
  }

  /**
   * A competitor oscillating around the alert threshold would otherwise page
   * someone every hour. One alert per type per listing per cooldown window.
   */
  private async isWithinCooldown(input: RaiseAlertInput): Promise<boolean> {
    if (this.config.cooldownMinutes <= 0) return false;

    const since = new Date(Date.now() - this.config.cooldownMinutes * 60_000);
    const existing = await this.alertsRepository.count({
      where: {
        productId: input.productId,
        competitorId: input.competitorId ?? IsNull(),
        type: input.type,
        createdAt: MoreThan(since),
      },
    });

    return existing > 0;
  }
}
