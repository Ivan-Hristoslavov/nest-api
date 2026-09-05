import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { SavedSearch } from './entities/saved-search.entity';
import { SearchSnapshot } from './entities/search-snapshot.entity';

/**
 * Remembering what the shops said, so a reload does not ask them again.
 *
 * A comparison is a dozen requests to other people's servers, and it used to
 * live only in the browser's memory. Pressing F5 threw it away and the buyer's
 * only route back to the prices they had been reading was to run all of it
 * again — expensive for us, rude to the shops, and frequently a *different*
 * answer, which is the worst part: the number they had decided on was gone.
 *
 * Two objects and one rule. A {@link SavedSearch} is the question and it is
 * mutable; a {@link SearchSnapshot} is the answer and it never changes. Every
 * execution appends a snapshot. Nothing edits one.
 */

/**
 * How long an answer is presented without a caveat.
 *
 * An hour, chosen against the layer below rather than out of the air: a
 * supplier's raw reply is cached for six, so a snapshot minutes old may already
 * rest on readings from earlier in the day, and pretending to more precision
 * than that would be a lie told confidently. An hour is short enough that a
 * buyer acting on a fresh badge is acting on today's price, and long enough
 * that a morning's work does not turn amber while they are still reading it.
 *
 * This governs a *label*, never a lifetime. Nothing here deletes a snapshot
 * because it aged — an old search that opens and shows old prices with the
 * date on them is the entire point of the feature.
 */
export const SNAPSHOT_FRESH_MS = 60 * 60 * 1000;

/**
 * Snapshots kept per search.
 *
 * A bound on growth rather than a retention policy. A buyer who refreshes one
 * search twice a day for a year would otherwise leave seven hundred documents
 * behind, and nobody reads the four hundredth. The search itself is never
 * removed, and neither is the newest answer — only the oldest beyond this
 * count, and only when a new one arrives to replace it.
 */
export const MAX_SNAPSHOTS_PER_SEARCH = 30;

/** One row of the history list: one article, however it was looked for. */
export interface SearchHistoryEntry {
  /** The most recent asking, and the one that opens. */
  id: string;
  /**
   * Every asking of this question, across scopes.
   *
   * Carried so that removing the row removes the article from the history
   * rather than one half of it — a reader who deletes "Bosch GSR 18V" and
   * watches it reappear because the other scope survived has been told the
   * button does not work.
   */
  ids: string[];
  query: string;
  /** The scope of the most recent asking. */
  scope: 'my_suppliers' | 'global';
  status: 'MATCH' | 'ALTERNATIVE' | 'NO_MATCH' | null;
  offerCount: number;
  /** Askings across every scope, so the count matches what was deleted. */
  runCount: number;
  /** The cheapest offer the most recent asking found, or null. */
  bestPrice: number | null;
  bestCurrency: string | null;
  lastRunAt: string | null;
  fresh: boolean;
}

/** A search reopened: the question, the answer, and how old the answer is. */
export interface RestoredSearch {
  id: string;
  query: string;
  scope: 'my_suppliers' | 'global';
  runCount: number;
  /** When the shops were asked. */
  fetchedAt: string;
  /** False once the answer is older than {@link SNAPSHOT_FRESH_MS}. */
  fresh: boolean;
  /** The comparison exactly as it was returned the first time. */
  payload: Record<string, unknown>;
}

/** The shape a snapshot is written from — the comparison, as the API returns it. */
export interface RecordableResult {
  status?: 'MATCH' | 'ALTERNATIVE' | 'NO_MATCH';
  durationMs?: number;
  offers?: unknown[];
  alternatives?: unknown[];
  bestOffer?: { effectivePrice?: number | null; effectiveCurrency?: string | null } | null;
  shops?: Array<{ ok?: boolean }>;
  [key: string]: unknown;
}

@Injectable()
export class SearchHistoryService {
  private readonly logger = new Logger(SearchHistoryService.name);

  /**
   * Executions in flight, keyed by owner and question.
   *
   * The double-click guard, and the reason it is a promise rather than a flag:
   * a second click does not get an error, it gets the answer the first click is
   * already fetching. Two people cannot share this map — it is per process, and
   * a second instance would run its own search — which is the honest limit of a
   * guard that costs nothing. It removes the case that actually happens, which
   * is one impatient buyer and one button.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @InjectRepository(SavedSearch)
    private readonly searches: Repository<SavedSearch>,
    @InjectRepository(SearchSnapshot)
    private readonly snapshots: Repository<SearchSnapshot>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Runs `execute` once, however many callers ask for it at the same moment.
   *
   * A buyer double-clicking Refresh, or a client retrying while the first
   * request is still open, must not start a second sweep of every supplier.
   * Both callers await the same execution and get the same snapshot.
   */
  async once<T>(ownerId: string, query: string, scope: string, execute: () => Promise<T>): Promise<T> {
    const key = `${ownerId}|${normaliseQuery(query)}|${scope}`;
    const running = this.inFlight.get(key);

    if (running) {
      this.logger.log(`Joined the search already running for "${query}" (${scope})`);
      return running as Promise<T>;
    }

    const started = execute().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);

    return started;
  }

  /**
   * Writes down what the shops said.
   *
   * Upserts the question and inserts an answer, in one transaction: a snapshot
   * whose search failed to save would be unreachable, and a search with no
   * snapshot is a history entry that opens onto nothing.
   *
   * Returns the search's id so the caller can put it in the response, which is
   * what lets the browser find its way back after a reload.
   */
  async record(
    ownerId: string,
    query: string,
    scope: 'my_suppliers' | 'global',
    result: RecordableResult,
  ): Promise<{ searchId: string; snapshotId: string; fetchedAt: Date }> {
    const trimmed = query.trim().slice(0, 160);
    const normalised = normaliseQuery(trimmed);
    const fetchedAt = new Date();

    const offers = Array.isArray(result.offers) ? result.offers.length : 0;
    const alternatives = Array.isArray(result.alternatives) ? result.alternatives.length : 0;
    const shops = Array.isArray(result.shops) ? result.shops : [];

    return this.dataSource.transaction(async (manager) => {
      const snapshots = manager.getRepository(SearchSnapshot);

      /*
       * One statement, because the counter has to be read and written without
       * anything getting between the two.
       *
       * The obvious spelling — upsert the row, then increment the counter — is
       * wrong twice over. It counts a first run as two, because the insert
       * seeds the column and the increment then steps it; and under two
       * simultaneous searches for the same article it either double-counts or
       * loses one, depending on how the two interleave.
       *
       * `ON CONFLICT ... DO UPDATE` says the whole thing at once: insert with
       * one run, or add a run to the row that exists. Postgres holds the row
       * for the duration, so identical searches arriving together are counted
       * exactly as often as they happened, and neither of them fails on a
       * unique index they both hit.
       */
      const [row] = (await manager.query(
        `INSERT INTO saved_searches
           (owner_id, query, normalised_query, scope, run_count,
            last_status, last_offer_count, last_best_price, last_best_currency,
            last_run_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, now(), now())
         ON CONFLICT (owner_id, normalised_query, scope) DO UPDATE SET
           query = EXCLUDED.query,
           run_count = saved_searches.run_count + 1,
           last_status = EXCLUDED.last_status,
           last_offer_count = EXCLUDED.last_offer_count,
           last_best_price = EXCLUDED.last_best_price,
           last_best_currency = EXCLUDED.last_best_currency,
           last_run_at = EXCLUDED.last_run_at,
           updated_at = now()
         RETURNING id`,
        [
          ownerId,
          trimmed,
          normalised,
          scope,
          result.status ?? null,
          offers,
          result.bestOffer?.effectivePrice ?? null,
          result.bestOffer?.effectiveCurrency ?? null,
          fetchedAt,
        ],
      )) as Array<{ id: string }>;

      const search = { id: row.id };

      const snapshot = await snapshots.save(
        snapshots.create({
          searchId: search.id,
          ownerId,
          status: result.status ?? 'NO_MATCH',
          offerCount: offers,
          alternativeCount: alternatives,
          shopsAsked: shops.length,
          shopsAnswered: shops.filter((shop) => shop.ok !== false).length,
          bestPrice: result.bestOffer?.effectivePrice ?? null,
          bestCurrency: result.bestOffer?.effectiveCurrency ?? null,
          durationMs: Math.round(result.durationMs ?? 0),
          payload: forStorage(result),
          fetchedAt,
        }),
      );

      await this.prune(manager.getRepository(SearchSnapshot), search.id);

      return { searchId: search.id, snapshotId: snapshot.id, fetchedAt };
    });
  }

  /**
   * This owner's questions, one per article, most recently asked first.
   *
   * The scopes are folded together here and nowhere else. They are genuinely
   * two searches — different shop lists, different snapshots, and a refresh
   * has to know which one it is repeating — but to a reader they are one
   * article looked for twice, and listing "Bosch GSR 18V" above "Bosch GSR
   * 18V" is a list that looks broken.
   *
   * The most recent asking wins the row: its id opens, its price and status
   * are shown. The others ride along in `ids` so deleting removes the article
   * rather than half of it.
   *
   * Rows are read past the requested limit and collapsed afterwards, because
   * the collapsing happens by article and the limit is expressed in articles.
   */
  async list(ownerId: string, limit = 25): Promise<SearchHistoryEntry[]> {
    const wanted = Math.min(Math.max(limit, 1), 100);

    const rows = await this.searches.find({
      where: { ownerId },
      order: { updatedAt: 'DESC' },
      // Two scopes at most per article, so twice the asking is always enough.
      take: wanted * 2,
    });

    const now = Date.now();
    const byArticle = new Map<string, SearchHistoryEntry>();

    for (const row of rows) {
      const seen = byArticle.get(row.normalisedQuery);

      if (seen) {
        // Ordered newest first, so anything arriving second is older: it
        // contributes its id and its runs, and nothing else.
        seen.ids.push(row.id);
        seen.runCount += row.runCount;
        continue;
      }

      byArticle.set(row.normalisedQuery, {
        id: row.id,
        ids: [row.id],
        query: row.query,
        scope: row.scope,
        status: row.lastStatus,
        offerCount: row.lastOfferCount,
        runCount: row.runCount,
        bestPrice: row.lastBestPrice,
        bestCurrency: row.lastBestCurrency,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        fresh: row.lastRunAt !== null && now - row.lastRunAt.getTime() < SNAPSHOT_FRESH_MS,
      });
    }

    return [...byArticle.values()].slice(0, wanted);
  }

  /**
   * One search, with the last thing the shops said about it.
   *
   * No supplier is contacted. That is the whole contract of this method: a
   * reload and a history click both land here, and both cost one indexed read
   * of the search and one of its newest snapshot.
   */
  async restore(ownerId: string, searchId: string): Promise<RestoredSearch> {
    const search = await this.searches.findOne({ where: { id: searchId } });

    /*
     * Missing and forbidden answer the same way.
     *
     * Telling a stranger that an id exists but is not theirs confirms the id,
     * and an id that can be confirmed can be enumerated. There is nothing here
     * worth that: to somebody who does not own it, a search they cannot read
     * and a search that does not exist are the same fact.
     */
    if (!search || search.ownerId !== ownerId) {
      throw new NotFoundException('Това търсене не съществува.');
    }

    const snapshot = await this.snapshots.findOne({
      where: { searchId: search.id },
      order: { fetchedAt: 'DESC' },
    });

    if (!snapshot) {
      throw new NotFoundException('Това търсене няма запазени резултати.');
    }

    return {
      id: search.id,
      query: search.query,
      scope: search.scope,
      runCount: search.runCount,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      fresh: Date.now() - snapshot.fetchedAt.getTime() < SNAPSHOT_FRESH_MS,
      payload: snapshot.payload,
    };
  }

  /** The question behind an id, for a refresh. Same ownership rule. */
  async find(ownerId: string, searchId: string): Promise<SavedSearch> {
    const search = await this.searches.findOne({ where: { id: searchId } });

    if (!search || search.ownerId !== ownerId) {
      throw new NotFoundException('Това търсене не съществува.');
    }

    return search;
  }

  /**
   * Removes an article from the history, in every scope it was looked for.
   *
   * The row a reader deletes is one article, so deleting it has to remove the
   * article. Removing only the scope behind that row would leave the same
   * words in the list, sourced from the other scope, which reads as a button
   * that did nothing.
   *
   * Ownership is checked on the row named in the request; the siblings are
   * then found by the owner's own question, so there is no id in this path
   * that did not come from this owner's rows.
   */
  async remove(ownerId: string, searchId: string): Promise<void> {
    const search = await this.find(ownerId, searchId);

    await this.searches.delete({
      ownerId,
      normalisedQuery: search.normalisedQuery,
    });
  }

  /**
   * Keeps the newest {@link MAX_SNAPSHOTS_PER_SEARCH} and drops the rest.
   *
   * Never the newest, never the search. A failure here is logged and ignored:
   * a snapshot that could not be tidied away is a few kilobytes, and letting
   * that fail the search which just succeeded would trade the feature for the
   * housekeeping.
   */
  private async prune(snapshots: Repository<SearchSnapshot>, searchId: string): Promise<void> {
    try {
      const surplus = await snapshots.find({
        where: { searchId },
        order: { fetchedAt: 'DESC' },
        skip: MAX_SNAPSHOTS_PER_SEARCH,
        select: { id: true },
      });

      if (surplus.length === 0) return;
      await snapshots.delete(surplus.map((row) => row.id));
    } catch (error) {
      this.logger.warn(
        `Could not prune snapshots for ${searchId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Two askings of the same question, reduced to one key.
 *
 * Case and whitespace only. It is tempting to go further — the matching engine
 * knows that "GSR18V" and "GSR 18V" name one article — but that judgement
 * belongs on the *results*, where it can be shown and argued with. Applied
 * here it would quietly merge "GSR 18V" and "GSR 18V-2" into a single history
 * entry, and those are two different tools.
 */
export function normaliseQuery(query: string): string {
  return (query ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * The comparison, minus what should not be kept.
 *
 * The operator trace is dropped: it holds every rejected candidate from every
 * shop, it is only ever requested by a support tool, and storing it would
 * multiply a snapshot's size for a document no buyer will open.
 */
function forStorage(result: RecordableResult): Record<string, unknown> {
  const { trace: _trace, ...rest } = result as Record<string, unknown> & { trace?: unknown };
  return rest;
}
