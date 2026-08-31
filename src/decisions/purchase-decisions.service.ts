import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Order, OrderStatus } from '../orders/entities/order.entity';
import { round } from '../pricing/effective-cost';
import { DecisionDraftService, SealedDecisionDraft } from './decision-draft.service';
import { PurchaseDecision, SavingsKind } from './entities/purchase-decision.entity';
import { PurchaseDecisionSnapshot } from './purchase-decision.snapshot';

export interface DecisionQuery {
  limit?: number;
  offset?: number;
  /** ISO dates. Inclusive at both ends of the day they name. */
  from?: string;
  to?: string;
  shopId?: string;
  sort?: 'date' | 'savings';
  order?: 'asc' | 'desc';
}

export interface DecisionPage {
  items: PurchaseDecision[];
  total: number;
  limit: number;
  offset: number;
}

export interface SavingsSummary {
  currency: string;
  month: { potential: number; realized: number; decisions: number };
  year: { potential: number; realized: number; decisions: number };
  allTime: { potential: number; realized: number; decisions: number };
  /** Across decisions that had a baseline to measure against. */
  averageSavingsPercent: number | null;
  averageBasketLines: number | null;
  /** Decisions whose plan splits across more than one supplier. */
  splitDecisions: number;
  singleSupplierDecisions: number;
}

/**
 * Keeping decisions, and keeping them honest.
 *
 * Everything here is scoped to an owner, without exception. A purchase
 * decision holds a customer's negotiated discounts, their delivery terms, their
 * suppliers' minimum orders and what they buy — which taken together is close
 * to the whole of their purchasing position. One row leaking across accounts
 * would be worse than a leaked price list, because it is a leaked price list
 * *plus* the buying pattern that goes with it.
 *
 * There is no `update`. Not "an update that is not called anywhere" — no
 * method, so nothing to call by accident, and the database refuses the
 * statement even if something did. The one write after insert appends evidence
 * of a purchase, and it is named for that rather than for the row it touches.
 */
@Injectable()
export class PurchaseDecisionsService {
  private readonly logger = new Logger(PurchaseDecisionsService.name);

  /** A page nobody asked a size for, and the largest one anybody may ask for. */
  private static readonly DEFAULT_LIMIT = 25;
  private static readonly MAX_LIMIT = 100;

  constructor(
    @InjectRepository(PurchaseDecision)
    private readonly decisions: Repository<PurchaseDecision>,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly drafts: DecisionDraftService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Stores a decision from the comparison the buyer was actually shown.
   *
   * The snapshot arrives sealed and is verified before anything is written, so
   * every figure on the row came from this server's own optimiser run. Nothing
   * is recomputed: no supplier is asked, no model is called, and the optimiser
   * does not run a second time. This method is persistence and nothing else,
   * which is what makes it fast enough to sit behind a button and what makes
   * the stored decision identical to the displayed one.
   */
  async create(ownerId: string, draft: SealedDecisionDraft): Promise<PurchaseDecision> {
    const snapshot = this.drafts.open(draft);

    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(PurchaseDecision);

      // The same numbering lock orders use, and for the same reason: two
      // decisions saved in the same second must not both be "#4", and losing
      // one to a unique-index collision would lose a comparison the buyer
      // cannot cheaply repeat.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`decisions:${ownerId}`]);

      const highest: Array<{ max: number | null }> = await manager.query(
        'SELECT MAX(number) AS max FROM purchase_decisions WHERE owner_id = $1',
        [ownerId],
      );

      const decision = repository.create({
        ownerId,
        number: (highest[0]?.max ?? 0) + 1,
        currency: snapshot.currency,
        lineCount: snapshot.request.lines.length,
        suppliersUsed: snapshot.optimisation.suppliersUsed,
        supplierIds: supplierIdsOf(snapshot),
        baselineTotal: snapshot.optimisation.baseline?.total ?? null,
        optimisedTotal: snapshot.optimisation.optimised.total,
        savings: snapshot.optimisation.savings,
        savingsPercent: snapshot.optimisation.savingsPercent,
        // Always. A decision is a plan until there are confirmed orders behind
        // it, and there cannot be any the moment it is created.
        savingsKind: SavingsKind.Potential,
        realizedTotal: null,
        realizedSavings: null,
        boundedSearch: snapshot.optimisation.diagnostics.boundedSearch,
        durationMs: snapshot.durationMs,
        snapshot,
      });

      const saved = await repository.save(decision);

      this.logger.log(
        `Decision #${saved.number} saved for ${ownerId}: ` +
          `${saved.lineCount} lines, ${saved.suppliersUsed} suppliers, ` +
          `saving ${saved.savings ?? 'none'} ${saved.currency}`,
      );

      return saved;
    });
  }

  async findOne(ownerId: string, id: string): Promise<PurchaseDecision> {
    const decision = await this.decisions.findOne({ where: { id, ownerId } });

    // Scoped to the owner, so somebody else's id is *missing* rather than
    // forbidden. "Forbidden" would confirm the decision exists to whoever
    // guessed at its id, which on this table is a confirmation that a
    // competitor is buying.
    if (!decision) throw new NotFoundException('Няма такова решение.');

    return decision;
  }

  /** The orders placed against one decision, newest first. */
  ordersFor(ownerId: string, decisionId: string): Promise<Order[]> {
    return this.orders.find({
      where: { ownerId, purchaseDecisionId: decisionId },
      order: { number: 'DESC' },
    });
  }

  async list(ownerId: string, query: DecisionQuery = {}): Promise<DecisionPage> {
    const limit = Math.min(
      Math.max(query.limit ?? PurchaseDecisionsService.DEFAULT_LIMIT, 1),
      PurchaseDecisionsService.MAX_LIMIT,
    );
    const offset = Math.max(query.offset ?? 0, 0);

    const builder = this.decisions
      .createQueryBuilder('decision')
      .where('decision.ownerId = :ownerId', { ownerId });

    if (query.from) builder.andWhere('decision.createdAt >= :from', { from: query.from });
    if (query.to) builder.andWhere('decision.createdAt <= :to', { to: query.to });

    // `&&` is the array-overlap operator, which is what the GIN index on this
    // column answers. A subquery over the jsonb document would answer the same
    // question by reading every row.
    if (query.shopId) {
      builder.andWhere('decision.supplierIds && ARRAY[:shopId]::uuid[]', { shopId: query.shopId });
    }

    const direction = query.order === 'asc' ? 'ASC' : 'DESC';

    if (query.sort === 'savings') {
      // NULLS LAST in both directions: a decision with no baseline has no
      // saving to sort by, and floating those to the top of "biggest saving
      // first" would put the least informative rows where the answer goes.
      builder.orderBy('decision.savings', direction, 'NULLS LAST');
      builder.addOrderBy('decision.createdAt', 'DESC');
    } else {
      builder.orderBy('decision.createdAt', direction);
    }

    const [items, total] = await builder.skip(offset).take(limit).getManyAndCount();

    return { items, total, limit, offset };
  }

  /**
   * The savings screen, in one query per window.
   *
   * Potential and realized are summed separately and never added together. A
   * decision that became a confirmed purchase contributes its realized figure
   * and stops contributing its potential one — otherwise the same saving would
   * be counted twice, once as a forecast and once as a fact, which is the
   * arithmetic behind every overstated ROI claim ever made.
   */
  async summary(ownerId: string, now = new Date()): Promise<SavingsSummary> {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

    const [month, year, allTime, shape] = await Promise.all([
      this.totals(ownerId, monthStart),
      this.totals(ownerId, yearStart),
      this.totals(ownerId, null),
      this.shape(ownerId),
    ]);

    return {
      currency: shape.currency,
      month,
      year,
      allTime,
      averageSavingsPercent: shape.averageSavingsPercent,
      averageBasketLines: shape.averageBasketLines,
      splitDecisions: shape.splitDecisions,
      singleSupplierDecisions: shape.singleSupplierDecisions,
    };
  }

  private async totals(
    ownerId: string,
    since: Date | null,
  ): Promise<{ potential: number; realized: number; decisions: number }> {
    const builder = this.decisions
      .createQueryBuilder('decision')
      .where('decision.ownerId = :ownerId', { ownerId });

    if (since) builder.andWhere('decision.createdAt >= :since', { since });

    const row = await builder
      .select(
        `COALESCE(SUM(CASE WHEN decision.savings_kind = :potential THEN decision.savings ELSE 0 END), 0)`,
        'potential',
      )
      .addSelect(`COALESCE(SUM(decision.realized_savings), 0)`, 'realized')
      .addSelect('COUNT(*)', 'decisions')
      .setParameter('potential', SavingsKind.Potential)
      .getRawOne<{ potential: string; realized: string; decisions: string }>();

    return {
      potential: round(Number(row?.potential ?? 0)),
      realized: round(Number(row?.realized ?? 0)),
      decisions: Number(row?.decisions ?? 0),
    };
  }

  private async shape(ownerId: string): Promise<{
    currency: string;
    averageSavingsPercent: number | null;
    averageBasketLines: number | null;
    splitDecisions: number;
    singleSupplierDecisions: number;
  }> {
    const row = await this.decisions
      .createQueryBuilder('decision')
      .where('decision.ownerId = :ownerId', { ownerId })
      .select('AVG(decision.savings_percent)', 'averageSavingsPercent')
      .addSelect('AVG(decision.line_count)', 'averageBasketLines')
      .addSelect('COUNT(*) FILTER (WHERE decision.suppliers_used > 1)', 'split')
      .addSelect('COUNT(*) FILTER (WHERE decision.suppliers_used = 1)', 'single')
      // The currency the account actually decides in, rather than a default
      // that would be wrong for anybody not using it.
      .addSelect('MODE() WITHIN GROUP (ORDER BY decision.currency)', 'currency')
      .getRawOne<{
        averageSavingsPercent: string | null;
        averageBasketLines: string | null;
        split: string;
        single: string;
        currency: string | null;
      }>();

    return {
      currency: row?.currency ?? 'EUR',
      averageSavingsPercent:
        row?.averageSavingsPercent === null || row?.averageSavingsPercent === undefined
          ? null
          : round(Number(row.averageSavingsPercent)),
      averageBasketLines:
        row?.averageBasketLines === null || row?.averageBasketLines === undefined
          ? null
          : round(Number(row.averageBasketLines)),
      splitDecisions: Number(row?.split ?? 0),
      singleSupplierDecisions: Number(row?.single ?? 0),
    };
  }

  /**
   * Re-reads the orders behind a decision and records what was actually bought.
   *
   * Called whenever an order linked to a decision changes state. It never
   * touches the snapshot and never revises `savings` — the potential figure
   * stays exactly what the optimiser said on the day. It only adds the second
   * pair of numbers, and only when the evidence supports them.
   *
   * **What counts as evidence.** Every supplier in the chosen plan has an order
   * against this decision, and every one of those orders is marked confirmed by
   * the buyer. Anything less and the decision stays potential: a draft is an
   * intention, a sent order is a request the supplier may yet refuse, and only
   * the buyer knows which requests turned into purchases.
   *
   * **What the realized figure is made of.** Goods come from the linked orders,
   * because that is what was actually ordered and the buyer may have changed a
   * quantity before sending. Delivery and handling come from the snapshot,
   * because an order request does not carry them — the supplier's terms as
   * recorded on the day are the best evidence available, and using them keeps
   * both sides of the comparison on the same basis as the baseline, which
   * includes delivery too.
   */
  async refreshRealizedSavings(ownerId: string, decisionId: string): Promise<void> {
    const decision = await this.decisions.findOne({ where: { id: decisionId, ownerId } });
    if (!decision) return;

    const orders = await this.orders.find({
      where: { ownerId, purchaseDecisionId: decisionId },
    });

    const plan = decision.snapshot.optimisation.optimised;
    const confirmed = orders.filter((order) => order.status === OrderStatus.Confirmed);
    const confirmedShops = new Set(confirmed.map((order) => order.shopId));

    const complete = plan.suppliers.every((supplier) => confirmedShops.has(supplier.shopId));

    if (!complete || confirmed.length === 0 || decision.baselineTotal === null) {
      // Evidence withdrawn — an order un-confirmed, or never complete. The
      // claim goes back to what it can support rather than lingering as a fact
      // nothing supports any more.
      await this.decisions.update(
        { id: decision.id, ownerId },
        { savingsKind: SavingsKind.Potential, realizedTotal: null, realizedSavings: null },
      );
      return;
    }

    const goods = confirmed.reduce((sum, order) => sum + order.total, 0);

    // Overheads for the suppliers actually ordered from, taken from the
    // snapshot. Suppliers in the plan the buyer did not order from contribute
    // nothing — they cost nothing, because no delivery came from them.
    const overheads = plan.suppliers
      .filter((supplier) => confirmedShops.has(supplier.shopId))
      .reduce((sum, supplier) => sum + supplier.shipping + supplier.handlingFee, 0);

    const realizedTotal = round(goods + overheads);

    await this.decisions.update(
      { id: decision.id, ownerId },
      {
        savingsKind: SavingsKind.Realized,
        realizedTotal,
        realizedSavings: round(decision.baselineTotal - realizedTotal),
      },
    );

    this.logger.log(
      `Decision #${decision.number} realized: spent ${realizedTotal} ${decision.currency} ` +
        `against a ${decision.baselineTotal} baseline.`,
    );
  }
}

/** Every supplier the snapshot mentions, deduplicated, for the filter column. */
function supplierIdsOf(snapshot: PurchaseDecisionSnapshot): string[] {
  return [...new Set(snapshot.suppliers.map((supplier) => supplier.shopId))];
}
