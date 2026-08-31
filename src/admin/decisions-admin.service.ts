import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../billing/entities/user.entity';
import { PurchaseDecision, SavingsKind } from '../decisions/entities/purchase-decision.entity';
import { Order, OrderStatus } from '../orders/entities/order.entity';
import { round } from '../pricing/effective-cost';
import {
  AdminDecisionDto,
  AdminDecisionsPageDto,
  CustomerPurchasingDto,
  DecisionAnalyticsDto,
} from './dto/decisions-admin.dto';

/**
 * Purchase decisions, as the operator sees them.
 *
 * Separate from `PurchaseDecisionsService` on purpose, and the difference is
 * the whole reason this file exists. That service is tenant-scoped by
 * construction — every query it can make carries an owner id, which is what
 * makes it safe to expose to customers. This one deliberately reads across
 * accounts, so it lives behind `AdminGuard` in the one controller whose
 * unfiltered access is the point and can be audited in a single place.
 *
 * Mixing the two would mean an owner-scoped service growing an unscoped
 * method, and the next reader having to check every call site to know which
 * kind they were looking at.
 *
 * What the operator gets is deliberately not everything. The list carries the
 * shape of a decision — how big, how many suppliers, what it saved, whether it
 * turned into an order — and not the snapshot. Reading which articles a
 * customer buys is not needed to answer "is the optimiser working" or "is this
 * customer getting value", and a screen that shows it by default is a screen
 * that leaks a customer's purchasing to anyone with an operator key open.
 */
@Injectable()
export class DecisionsAdminService {
  constructor(
    @InjectRepository(PurchaseDecision)
    private readonly decisions: Repository<PurchaseDecision>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /** Decisions across every customer, newest first. */
  async list(limit = 50, offset = 0, ownerId?: string): Promise<AdminDecisionsPageDto> {
    const builder = this.decisions
      .createQueryBuilder('decision')
      // A left join, because a customer can be deleted while their decisions
      // remain as a business record. An inner join would silently drop exactly
      // the rows an operator is most likely to be investigating.
      .leftJoin(User, 'customer', 'customer.id = decision.owner_id')
      .leftJoin(
        (query) =>
          query
            .from(Order, 'order')
            .select('order.purchase_decision_id', 'decision_id')
            .addSelect('COUNT(*)', 'orders')
            .addSelect(
              `COUNT(*) FILTER (WHERE order.status = '${OrderStatus.Confirmed}')`,
              'confirmed',
            )
            .where('order.purchase_decision_id IS NOT NULL')
            .groupBy('order.purchase_decision_id'),
        'linked',
        'linked.decision_id = decision.id',
      )
      .select([
        'decision.id AS id',
        'decision.owner_id AS "ownerId"',
        'customer.email AS "customerEmail"',
        'decision.number AS number',
        'decision.created_at AS "createdAt"',
        'decision.currency AS currency',
        'decision.line_count AS "lineCount"',
        'decision.suppliers_used AS "suppliersUsed"',
        'decision.baseline_total AS "baselineTotal"',
        'decision.optimised_total AS "optimisedTotal"',
        'decision.savings AS savings',
        'decision.savings_percent AS "savingsPercent"',
        'decision.savings_kind AS "savingsKind"',
        'decision.realized_savings AS "realizedSavings"',
        'decision.bounded_search AS "boundedSearch"',
        'decision.duration_ms AS "durationMs"',
        `decision.snapshot #>> '{optimisation,diagnostics,combinationsEvaluated}' AS "combinationsEvaluated"`,
        `jsonb_array_length(decision.snapshot #> '{optimisation,unassigned}') AS "unassignedLines"`,
        'COALESCE(linked.orders, 0) AS "ordersLinked"',
        'COALESCE(linked.confirmed, 0) AS "ordersConfirmed"',
      ])
      .orderBy('decision.created_at', 'DESC')
      .limit(Math.min(Math.max(limit, 1), 200))
      .offset(Math.max(offset, 0));

    if (ownerId) builder.andWhere('decision.owner_id = :ownerId', { ownerId });

    const rows = await builder.getRawMany<Record<string, unknown>>();

    const countBuilder = this.decisions.createQueryBuilder('decision');
    if (ownerId) countBuilder.where('decision.owner_id = :ownerId', { ownerId });

    return {
      items: rows.map(toAdminDecision),
      total: await countBuilder.getCount(),
      limit,
      offset,
    };
  }

  /**
   * Is the optimiser earning its keep?
   *
   * Everything here is counted over decisions the customer chose to keep, not
   * over every comparison run. That is the honest denominator for these
   * questions: a comparison somebody ran and walked away from says nothing
   * about whether the optimiser found a saving worth acting on. The live health
   * of the optimiser itself — including runs that found nothing — is already
   * answered by `GET /admin/optimiser`, which counts every run.
   */
  async analytics(days = 30): Promise<DecisionAnalyticsDto> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const row = await this.decisions
      .createQueryBuilder('decision')
      .where('decision.created_at >= :since', { since })
      .select('COUNT(*)', 'decisions')
      .addSelect('COUNT(DISTINCT decision.owner_id)', 'customers')
      .addSelect('AVG(decision.line_count)', 'averageBasketLines')
      .addSelect('AVG(decision.suppliers_used)', 'averageSuppliersUsed')
      .addSelect('AVG(decision.duration_ms)', 'averageDurationMs')
      .addSelect('COUNT(*) FILTER (WHERE decision.savings > 0)', 'withSavings')
      .addSelect('COUNT(*) FILTER (WHERE decision.suppliers_used > 1)', 'split')
      .addSelect('COUNT(*) FILTER (WHERE decision.suppliers_used = 1)', 'single')
      .addSelect('COUNT(*) FILTER (WHERE decision.bounded_search)', 'bounded')
      .addSelect('COUNT(*) FILTER (WHERE decision.baseline_total IS NULL)', 'withoutBaseline')
      .addSelect('AVG(decision.savings_percent)', 'averageSavingsPercent')
      .addSelect(
        `COALESCE(SUM(CASE WHEN decision.savings_kind = :potential THEN decision.savings ELSE 0 END), 0)`,
        'potentialSavings',
      )
      .addSelect(`COALESCE(SUM(decision.realized_savings), 0)`, 'realizedSavings')
      .setParameter('potential', SavingsKind.Potential)
      .getRawOne<Record<string, string | null>>();

    const decisions = Number(row?.decisions ?? 0);
    const withSavings = Number(row?.withSavings ?? 0);

    const linked = await this.orders
      .createQueryBuilder('order')
      .where('order.purchase_decision_id IS NOT NULL')
      .andWhere('order.created_at >= :since', { since })
      .select('COUNT(DISTINCT order.purchase_decision_id)', 'decisions')
      .addSelect('COUNT(*)', 'orders')
      .getRawOne<{ decisions: string; orders: string }>();

    return {
      days,
      decisions,
      customers: Number(row?.customers ?? 0),
      averageBasketLines: numeric(row?.averageBasketLines),
      averageSuppliersUsed: numeric(row?.averageSuppliersUsed),
      averageDurationMs: numeric(row?.averageDurationMs),
      averageSavingsPercent: numeric(row?.averageSavingsPercent),
      potentialSavings: round(Number(row?.potentialSavings ?? 0)),
      realizedSavings: round(Number(row?.realizedSavings ?? 0)),
      // Guarded rather than left to produce NaN: a day with no decisions is
      // normal early on, and a dashboard reading "NaN%" is how an operator
      // learns to stop trusting the panel.
      shareWithSavings: ratio(withSavings, decisions),
      shareSplit: ratio(Number(row?.split ?? 0), decisions),
      shareSingleSupplier: ratio(Number(row?.single ?? 0), decisions),
      shareBoundedSearch: ratio(Number(row?.bounded ?? 0), decisions),
      shareWithoutBaseline: ratio(Number(row?.withoutBaseline ?? 0), decisions),
      decisionsWithOrders: Number(linked?.decisions ?? 0),
      ordersPlaced: Number(linked?.orders ?? 0),
    };
  }

  /**
   * One customer's purchasing, for the account screen.
   *
   * The question this answers is the founder's, not the buyer's: *is this
   * customer getting real value?* A subscription against a saving is the only
   * form of that question with an arithmetic answer, so both sides are here —
   * and they are kept apart from each other, with realized never folded into
   * potential, so the answer stays defensible when it is quoted back.
   */
  async customerPurchasing(ownerId: string, days = 30): Promise<CustomerPurchasingDto> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [totals, window, orders, suppliers] = await Promise.all([
      this.decisions
        .createQueryBuilder('decision')
        .where('decision.owner_id = :ownerId', { ownerId })
        .select('COUNT(*)', 'decisions')
        .addSelect('AVG(decision.line_count)', 'averageBasketLines')
        .addSelect('AVG(decision.savings_percent)', 'averageSavingsPercent')
        .addSelect('AVG(decision.suppliers_used)', 'averageSuppliersUsed')
        .addSelect('MAX(decision.created_at)', 'lastDecisionAt')
        .addSelect(
          `COALESCE(SUM(CASE WHEN decision.savings_kind = :potential THEN decision.savings ELSE 0 END), 0)`,
          'potentialSavings',
        )
        .addSelect('COALESCE(SUM(decision.realized_savings), 0)', 'realizedSavings')
        .setParameter('potential', SavingsKind.Potential)
        .getRawOne<Record<string, string | null>>(),

      this.decisions
        .createQueryBuilder('decision')
        .where('decision.owner_id = :ownerId', { ownerId })
        .andWhere('decision.created_at >= :since', { since })
        .select('COUNT(*)', 'decisions')
        .addSelect(
          `COALESCE(SUM(CASE WHEN decision.savings_kind = :potential THEN decision.savings ELSE 0 END), 0)`,
          'potentialSavings',
        )
        .addSelect('COALESCE(SUM(decision.realized_savings), 0)', 'realizedSavings')
        .setParameter('potential', SavingsKind.Potential)
        .getRawOne<Record<string, string | null>>(),

      this.orders
        .createQueryBuilder('order')
        .where('order.owner_id = :ownerId', { ownerId })
        .select('COUNT(*)', 'orders')
        .addSelect('COUNT(*) FILTER (WHERE order.purchase_decision_id IS NOT NULL)', 'fromDecision')
        .addSelect(`COUNT(*) FILTER (WHERE order.status = '${OrderStatus.Confirmed}')`, 'confirmed')
        .getRawOne<Record<string, string | null>>(),

      // Which suppliers this customer's decisions keep landing on. `unnest`
      // over the filter column rather than over the snapshot: it is indexed,
      // and it already holds exactly the ids this question is about.
      //
      // A raw query because the query builder has no `unnest`, and typed at
      // this boundary rather than left as `any`: everything downstream reads
      // two named columns off these rows, and `any` would turn a renamed
      // column into `undefined` in the response instead of a compile error.
      this.decisions.query<SupplierTallyRow[]>(
        `SELECT supplier_id, COUNT(*) AS decisions
           FROM purchase_decisions, unnest(supplier_ids) AS supplier_id
          WHERE owner_id = $1
          GROUP BY supplier_id
          ORDER BY decisions DESC
          LIMIT 5`,
        [ownerId],
      ),
    ]);

    const customer = await this.users.findOne({ where: { id: ownerId } });

    return {
      ownerId,
      email: customer?.email ?? null,
      plan: customer?.plan ?? null,
      days,
      decisions: Number(totals?.decisions ?? 0),
      decisionsInWindow: Number(window?.decisions ?? 0),
      potentialSavings: round(Number(totals?.potentialSavings ?? 0)),
      realizedSavings: round(Number(totals?.realizedSavings ?? 0)),
      potentialSavingsInWindow: round(Number(window?.potentialSavings ?? 0)),
      realizedSavingsInWindow: round(Number(window?.realizedSavings ?? 0)),
      averageBasketLines: numeric(totals?.averageBasketLines),
      averageSavingsPercent: numeric(totals?.averageSavingsPercent),
      averageSuppliersUsed: numeric(totals?.averageSuppliersUsed),
      orders: Number(orders?.orders ?? 0),
      ordersFromDecision: Number(orders?.fromDecision ?? 0),
      ordersConfirmed: Number(orders?.confirmed ?? 0),
      lastDecisionAt: totals?.lastDecisionAt ? new Date(totals.lastDecisionAt).toISOString() : null,
      topSuppliers: suppliers.map((row) => ({
        shopId: row.supplier_id,
        decisions: Number(row.decisions),
      })),
    };
  }
}

/** One row of the "which suppliers does this customer keep using" tally. */
interface SupplierTallyRow {
  supplier_id: string;
  /** Postgres returns COUNT(*) as a string. */
  decisions: string;
}

function toAdminDecision(row: Record<string, unknown>): AdminDecisionDto {
  const number = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    customerEmail: (row.customerEmail as string | null) ?? null,
    number: Number(row.number),
    createdAt: new Date(row.createdAt as string).toISOString(),
    currency: String(row.currency).trim(),
    lineCount: Number(row.lineCount),
    suppliersUsed: Number(row.suppliersUsed),
    baselineTotal: number(row.baselineTotal),
    optimisedTotal: Number(row.optimisedTotal),
    savings: number(row.savings),
    savingsPercent: number(row.savingsPercent),
    savingsKind: String(row.savingsKind) as SavingsKind,
    realizedSavings: number(row.realizedSavings),
    boundedSearch: Boolean(row.boundedSearch),
    durationMs: Number(row.durationMs),
    combinationsEvaluated: number(row.combinationsEvaluated),
    unassignedLines: Number(row.unassignedLines ?? 0),
    ordersLinked: Number(row.ordersLinked ?? 0),
    ordersConfirmed: Number(row.ordersConfirmed ?? 0),
  };
}

/** An average Postgres returns as a string, or null when there was nothing to average. */
function numeric(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round(parsed) : null;
}

/** A share, 0–1, and 0 rather than NaN when the denominator is empty. */
function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 1000;
}
