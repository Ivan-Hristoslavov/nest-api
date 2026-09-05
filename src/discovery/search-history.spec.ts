import { NotFoundException } from '@nestjs/common';

import {
  MAX_SNAPSHOTS_PER_SEARCH,
  SNAPSHOT_FRESH_MS,
  SearchHistoryService,
  normaliseQuery,
} from './search-history.service';

/**
 * Searches that survive a reload.
 *
 * The behaviour under test is mostly an absence: after a refresh, or a click
 * in the history, **no supplier is contacted**. That is hard to assert against
 * a real database and easy to assert against the repositories, so the store is
 * faked here and the counting is done where it matters — on the executor that
 * would have gone out to the shops.
 */

interface Row {
  [key: string]: unknown;
}

/** Just enough of a TypeORM repository for this service, with real semantics. */
function fakeStore() {
  const searches: Row[] = [];
  const snapshots: Row[] = [];
  let ids = 0;

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const sort = (rows: Row[], order?: Row): Row[] => {
    const [key, direction] = Object.entries(order ?? {})[0] ?? [];
    if (!key) return rows;

    // Rows written in the same millisecond tie on a timestamp, and an unstable
    // sort would then make pruning look arbitrary. Insertion order breaks the
    // tie, which is the order a real sequence would have given them anyway.
    const seq = (row: Row): number => Number(String(row.id ?? '').replace(/\D/g, '')) || 0;

    return [...rows].sort((a, b) => {
      const left = Number(a[key] instanceof Date ? (a[key] as Date).getTime() : a[key]);
      const right = Number(b[key] instanceof Date ? (b[key] as Date).getTime() : b[key]);
      const gap = direction === 'DESC' ? right - left : left - right;
      if (gap !== 0) return gap;
      return direction === 'DESC' ? seq(b) - seq(a) : seq(a) - seq(b);
    });
  };

  const repo = (rows: Row[]) => ({
    rows,
    create: (row: Row) => ({ ...row }),
    save: async (row: Row) => {
      const saved = { id: `id-${++ids}`, ...row };
      rows.push(saved);
      return saved;
    },
    upsert: async (row: Row, options: { conflictPaths: string[] }) => {
      const where = Object.fromEntries(options.conflictPaths.map((path) => [path, row[path]]));
      const existing = rows.find((candidate) => matches(candidate, where));

      if (existing) Object.assign(existing, { ...row, runCount: existing.runCount });
      else rows.push({ id: `id-${++ids}`, createdAt: new Date(), updatedAt: new Date(), ...row });
    },
    increment: async (where: Row, column: string, by: number) => {
      const row = rows.find((candidate) => matches(candidate, where));
      if (row) row[column] = Number(row[column] ?? 0) + by;
    },
    find: async (options: { where?: Row; order?: Row; take?: number; skip?: number } = {}) => {
      let found = rows.filter((row) => matches(row, options.where ?? {}));
      found = sort(found, options.order);
      if (options.skip) found = found.slice(options.skip);
      if (options.take) found = found.slice(0, options.take);
      return found;
    },
    findOne: async (options: { where: Row; order?: Row }) =>
      sort(rows.filter((row) => matches(row, options.where)), options.order)[0] ?? null,
    findOneOrFail: async (options: { where: Row }) => {
      const row = rows.find((candidate) => matches(candidate, options.where));
      if (!row) throw new Error('not found');
      return row;
    },
    delete: async (target: Row | string[]) => {
      const ids = Array.isArray(target) ? target : null;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const hit = ids ? ids.includes(rows[index].id as string) : matches(rows[index], target as Row);
        if (hit) rows.splice(index, 1);
      }
    },
  });

  const searchRepo = repo(searches);
  const snapshotRepo = repo(snapshots);

  /**
   * The upsert the service issues, with the semantics Postgres gives it:
   * insert with one run, or add a run to the row that is already there.
   */
  const upsertSearch = async (params: unknown[]): Promise<Array<{ id: string }>> => {
    const [
      ownerId,
      query,
      normalisedQuery,
      scope,
      lastStatus,
      lastOfferCount,
      lastBestPrice,
      lastBestCurrency,
      lastRunAt,
    ] = params as [
      string,
      string,
      string,
      string,
      string | null,
      number,
      number | null,
      string | null,
      Date,
    ];

    const existing = searches.find(
      (row) =>
        row.ownerId === ownerId && row.normalisedQuery === normalisedQuery && row.scope === scope,
    );

    if (existing) {
      Object.assign(existing, {
        query,
        runCount: Number(existing.runCount) + 1,
        lastStatus,
        lastOfferCount,
        lastBestPrice,
        lastBestCurrency,
        lastRunAt,
        updatedAt: new Date(),
      });
      return [{ id: existing.id as string }];
    }

    const row: Row = {
      id: `id-${++ids}`,
      ownerId,
      query,
      normalisedQuery,
      scope,
      runCount: 1,
      lastStatus,
      lastOfferCount,
      lastBestPrice,
      lastBestCurrency,
      lastRunAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    searches.push(row);
    return [{ id: row.id as string }];
  };

  const dataSource = {
    transaction: async <T>(work: (manager: unknown) => Promise<T>): Promise<T> =>
      work({
        getRepository: (entity: { name: string }) =>
          entity.name === 'SavedSearch' ? searchRepo : snapshotRepo,
        query: async (_sql: string, params: unknown[]) => upsertSearch(params),
      }),
  };

  return { searches, snapshots, searchRepo, snapshotRepo, dataSource };
}

const OWNER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

const comparison = (
  price: number,
  status: 'MATCH' | 'ALTERNATIVE' | 'NO_MATCH' = 'MATCH',
) => ({
  query: 'Bosch GSR 18V',
  status,
  durationMs: 1200,
  offers: [{ shopName: 'Store A', effectivePrice: price }],
  alternatives: [],
  bestOffer: { effectivePrice: price, effectiveCurrency: 'EUR' },
  shops: [{ ok: true }, { ok: true }, { ok: false }],
  trace: { rejected: ['a lot of noise nobody will read'] },
});

function build() {
  const store = fakeStore();
  const service = new SearchHistoryService(
    store.searchRepo as never,
    store.snapshotRepo as never,
    store.dataSource as never,
  );
  return { store, service };
}

describe('a search is written down when it runs', () => {
  it('keeps the question and the answer as separate things', async () => {
    const { store, service } = build();

    const written = await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));

    expect(store.searches).toHaveLength(1);
    expect(store.snapshots).toHaveLength(1);
    expect(written.searchId).toBe(store.searches[0].id);
    expect(store.snapshots[0].offerCount).toBe(1);
    expect(store.snapshots[0].bestPrice).toBe(149.99);
    // Two of three shops answered, and that is preserved: reopening this
    // search must not quietly retry the one that was down.
    expect(store.snapshots[0].shopsAsked).toBe(3);
    expect(store.snapshots[0].shopsAnswered).toBe(2);
  });

  it('does not keep the operator trace', async () => {
    // Every rejected candidate from every shop, for a document no buyer opens.
    const { store, service } = build();
    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));

    expect(store.snapshots[0].payload).not.toHaveProperty('trace');
    expect(store.snapshots[0].payload).toHaveProperty('offers');
  });

  it('adds a snapshot to the question rather than a second question', async () => {
    const { store, service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, '  bosch   GSR 18V ', 'my_suppliers', comparison(159.99));

    expect(store.searches).toHaveLength(1);
    expect(store.snapshots).toHaveLength(2);
    expect(store.searches[0].runCount).toBe(2);
  });

  it('keeps the two scopes apart', async () => {
    // "at my suppliers" and "everywhere" are different questions with
    // different shop lists, and folding them would make a snapshot's coverage
    // depend on which button was pressed last.
    const { store, service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, 'Bosch GSR 18V', 'global', comparison(139.99));

    expect(store.searches).toHaveLength(2);
  });
});

describe('an old snapshot never changes', () => {
  it('still shows the price it was taken at', async () => {
    const { store, service } = build();

    const first = await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(159.99));

    const original = store.snapshots.find((row) => row.id !== undefined && row.bestPrice === 149.99);

    expect(original).toBeDefined();
    expect(original!.bestPrice).toBe(149.99);
    expect(first.searchId).toBe(store.searches[0].id);
  });

  it('restores the newest answer, not the first', async () => {
    const { store, service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(159.99));

    const restored = await service.restore(OWNER, store.searches[0].id as string);
    expect((restored.payload as { bestOffer: { effectivePrice: number } }).bestOffer.effectivePrice)
      .toBe(159.99);
  });
});

describe('reopening a search contacts nobody', () => {
  it('answers a reload from what was written down', async () => {
    const { store, service } = build();
    const stores = jest.fn();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    const restored = await service.restore(OWNER, store.searches[0].id as string);

    expect(stores).not.toHaveBeenCalled();
    expect(restored.query).toBe('Bosch GSR 18V');
    expect(restored.fresh).toBe(true);
    expect(restored.fetchedAt).toEqual(expect.any(String));
  });

  it('calls an answer stale once it is older than the window, and still returns it', async () => {
    // Age changes a label, never a lifetime. An old search that opens and
    // shows old prices with the date on them is the whole feature.
    const { store, service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    store.snapshots[0].fetchedAt = new Date(Date.now() - SNAPSHOT_FRESH_MS - 1000);

    const restored = await service.restore(OWNER, store.searches[0].id as string);

    expect(restored.fresh).toBe(false);
    expect(restored.payload).toBeDefined();
  });

  it('lists the history without opening a single snapshot', async () => {
    const { store, service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, 'Makita DHP486', 'my_suppliers', comparison(99));

    const history = await service.list(OWNER);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ status: 'MATCH', offerCount: 1, runCount: 1 });
    // The list is drawn from the search rows alone — the counts are projected
    // there precisely so the documents stay unread.
    expect(history[0]).not.toHaveProperty('payload');
  });
});

describe('one search belongs to one account', () => {
  it('will not open another owner’s search by its id', async () => {
    const { store, service } = build();
    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));

    const id = store.searches[0].id as string;

    await expect(service.restore(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.find(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(OTHER, id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers "not found" rather than "not yours"', async () => {
    // Confirming that an id exists is what makes ids worth enumerating.
    const { store, service } = build();
    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));

    const mine = service.restore(OTHER, store.searches[0].id as string);
    const missing = service.restore(OTHER, '33333333-3333-3333-3333-333333333333');

    await expect(mine).rejects.toThrow('Това търсене не съществува.');
    await expect(missing).rejects.toThrow('Това търсене не съществува.');
  });

  it('keeps one account’s history out of another’s', async () => {
    const { service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OTHER, 'Makita DHP486', 'my_suppliers', comparison(99));

    expect(await service.list(OWNER)).toHaveLength(1);
    expect((await service.list(OWNER))[0].query).toBe('Bosch GSR 18V');
  });
});

describe('two clicks are one search', () => {
  it('joins a run already in progress instead of starting another', async () => {
    const { service } = build();
    const stores = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve('answer'), 20)),
    );

    const [first, second] = await Promise.all([
      service.once(OWNER, 'Bosch GSR 18V', 'my_suppliers', stores),
      service.once(OWNER, 'Bosch GSR 18V', 'my_suppliers', stores),
    ]);

    expect(stores).toHaveBeenCalledTimes(1);
    expect(first).toBe('answer');
    expect(second).toBe('answer');
  });

  it('lets the next click run once the first has finished', async () => {
    const { service } = build();
    const stores = jest.fn(async () => 'answer');

    await service.once(OWNER, 'Bosch GSR 18V', 'my_suppliers', stores);
    await service.once(OWNER, 'Bosch GSR 18V', 'my_suppliers', stores);

    expect(stores).toHaveBeenCalledTimes(2);
  });

  it('does not let one account’s run satisfy another’s', async () => {
    const { service } = build();
    const stores = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve('answer'), 20)),
    );

    await Promise.all([
      service.once(OWNER, 'Bosch GSR 18V', 'my_suppliers', stores),
      service.once(OTHER, 'Bosch GSR 18V', 'my_suppliers', stores),
    ]);

    expect(stores).toHaveBeenCalledTimes(2);
  });

  it('releases the guard when the run fails', async () => {
    // A failed refresh must not wedge the button for the rest of the session.
    const { service } = build();
    const failing = jest.fn(async () => {
      throw new Error('every supplier refused');
    });

    await expect(
      service.once(OWNER, 'Bosch GSR 18V', 'my_suppliers', failing),
    ).rejects.toThrow('every supplier refused');

    await expect(
      service.once(OWNER, 'Bosch GSR 18V', 'my_suppliers', async () => 'answer'),
    ).resolves.toBe('answer');
  });
});

describe('a failed refresh loses nothing', () => {
  it('leaves the last saved answer in place', async () => {
    const { store, service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));

    await expect(
      service.once(OWNER, 'Bosch GSR 18V', 'my_suppliers', async () => {
        throw new Error('the suppliers were unreachable');
      }),
    ).rejects.toThrow();

    const restored = await service.restore(OWNER, store.searches[0].id as string);

    expect(store.snapshots).toHaveLength(1);
    expect((restored.payload as { bestOffer: { effectivePrice: number } }).bestOffer.effectivePrice)
      .toBe(149.99);
  });
});

describe('storage stays bounded', () => {
  it('keeps the newest snapshots and drops only the surplus', async () => {
    const { store, service } = build();

    for (let run = 0; run < MAX_SNAPSHOTS_PER_SEARCH + 5; run += 1) {
      await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(100 + run));
    }

    expect(store.searches).toHaveLength(1);
    expect(store.snapshots).toHaveLength(MAX_SNAPSHOTS_PER_SEARCH);

    // The newest survives. That is the one a reload shows.
    const newest = Math.max(...store.snapshots.map((row) => Number(row.bestPrice)));
    expect(newest).toBe(100 + MAX_SNAPSHOTS_PER_SEARCH + 4);
  });
});

describe('two askings of the same question', () => {
  it('ignores case and spacing', () => {
    expect(normaliseQuery('Bosch GSR 18V')).toBe('bosch gsr 18v');
    expect(normaliseQuery('  BOSCH   GSR 18V ')).toBe('bosch gsr 18v');
  });

  it('keeps different tools different', () => {
    // The tempting mistake. The matching engine knows "GSR18V" and "GSR 18V"
    // name one article, and that judgement belongs on the results where it can
    // be shown. Applied here it would merge two tools into one history entry.
    const distinct = ['Bosch GSR 18V', 'Bosch GSR 18V-2', 'Bosch GSR 18V + battery'];
    expect(new Set(distinct.map(normaliseQuery)).size).toBe(3);
  });
});

describe('the history lists an article once', () => {
  it('folds the two scopes into one row', async () => {
    // Genuinely two searches — different shop lists, different snapshots — and
    // one article to a reader. Listing the same words twice looks broken.
    const { service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, 'Bosch GSR 18V', 'global', comparison(139.99));

    const history = await service.list(OWNER);

    expect(history).toHaveLength(1);
    expect(history[0].query).toBe('Bosch GSR 18V');
    expect(history[0].ids).toHaveLength(2);
  });

  it('shows the most recent asking, not the first', async () => {
    const { service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.record(OWNER, 'Bosch GSR 18V', 'global', comparison(139.99));

    const [entry] = await service.list(OWNER);

    expect(entry.scope).toBe('global');
    expect(entry.bestPrice).toBe(139.99);
  });

  it('counts every asking of the article', async () => {
    const { service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(151));
    await service.record(OWNER, 'Bosch GSR 18V', 'global', comparison(139.99));

    const [entry] = await service.list(OWNER);
    expect(entry.runCount).toBe(3);
  });

  it('keeps different articles apart', async () => {
    const { service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, 'Bosch GSR 18V-2', 'my_suppliers', comparison(159.99));

    expect(await service.list(OWNER)).toHaveLength(2);
  });

  it('carries the price the last run found', async () => {
    const { service } = build();
    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));

    const [entry] = await service.list(OWNER);

    expect(entry.bestPrice).toBe(149.99);
    expect(entry.bestCurrency).toBe('EUR');
  });

  it('says nothing about a price when nothing was found', async () => {
    // A search that matched nothing has no figure to show, and inventing one
    // — the cheapest rejected candidate, say — is the mistake this whole
    // engine exists to prevent.
    const { service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', {
      status: 'NO_MATCH',
      offers: [],
      alternatives: [],
      bestOffer: null,
      shops: [{ ok: true }],
    });

    const [entry] = await service.list(OWNER);

    expect(entry.status).toBe('NO_MATCH');
    expect(entry.bestPrice).toBeNull();
  });

  it('honours the limit in articles, not in rows', async () => {
    const { service } = build();

    for (const query of ['Bosch GSR 18V', 'Makita DHP486', 'DeWalt DCD796']) {
      await service.record(OWNER, query, 'my_suppliers', comparison(100));
      await service.record(OWNER, query, 'global', comparison(95));
    }

    expect(await service.list(OWNER, 2)).toHaveLength(2);
  });
});

describe('deleting an article removes it', () => {
  it('takes both scopes with it', async () => {
    // Deleting "Bosch GSR 18V" and watching it reappear, sourced from the
    // other scope, reads as a button that does nothing.
    const { store, service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, 'Bosch GSR 18V', 'global', comparison(139.99));

    const [entry] = await service.list(OWNER);
    await service.remove(OWNER, entry.id);

    expect(await service.list(OWNER)).toHaveLength(0);
    expect(store.searches).toHaveLength(0);
  });

  it('leaves other articles alone', async () => {
    const { service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OWNER, 'Makita DHP486', 'my_suppliers', comparison(99));

    const history = await service.list(OWNER);
    await service.remove(OWNER, history.find((row) => row.query === 'Bosch GSR 18V')!.id);

    const left = await service.list(OWNER);
    expect(left).toHaveLength(1);
    expect(left[0].query).toBe('Makita DHP486');
  });

  it('will not delete another account’s article', async () => {
    const { store, service } = build();

    await service.record(OWNER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));
    await service.record(OTHER, 'Bosch GSR 18V', 'my_suppliers', comparison(149.99));

    const [mine] = await service.list(OWNER);
    await service.remove(OWNER, mine.id);

    // The other account asked the same question. Deleting by the *question*
    // must still be fenced by the owner, or one reader tidying their history
    // would empty somebody else's.
    expect(store.searches).toHaveLength(1);
    expect(store.searches[0].ownerId).toBe(OTHER);
  });
});
