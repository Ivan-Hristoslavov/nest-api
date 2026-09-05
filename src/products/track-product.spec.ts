import { ScrapeStatus } from './enums/scrape-status.enum';
import { ProductsService } from './products.service';

/**
 * Watching a product at the shops somebody picked.
 *
 * The discovery flow's landing point, and the reason it has to be one
 * transaction: the browser used to create the product and then add each shop
 * with its own request, so a failure halfway left a product watching three of
 * the five that were chosen — with nothing on screen saying which two were
 * missing.
 *
 * The other thing under test is an absence. Nothing here is a new monitoring
 * mechanism: it writes the same rows the manual form always wrote, so the
 * scraper picks the product up without knowing which road it arrived by.
 */

interface Row {
  [key: string]: unknown;
}

function fakeDb() {
  const products: Row[] = [];
  const competitors: Row[] = [];
  const history: Row[] = [];
  let ids = 0;

  const repo = (rows: Row[]) => ({
    create: (row: Row) => ({ ...row }),
    save: async (row: Row) => {
      const saved = { id: row.id ?? `id-${++ids}`, ...row };
      rows.push(saved);
      return saved;
    },
    insert: async (row: Row) => {
      rows.push({ id: `id-${++ids}`, ...row });
    },
  });

  const byName: Record<string, Row[]> = { Product: products, Competitor: competitors, PriceHistory: history };

  const dataSource = {
    transaction: async <T>(work: (manager: unknown) => Promise<T>): Promise<T> =>
      work({ getRepository: (entity: { name: string }) => repo(byName[entity.name]) }),
  };

  return { products, competitors, history, dataSource };
}

const OWNER = '11111111-1111-1111-1111-111111111111';

function build() {
  const db = fakeDb();
  const service = new ProductsService(
    {} as never,
    {} as never,
    {} as never,
    db.dataSource as never,
  );
  return { db, service };
}

const stores = [
  { url: 'https://kris06.bg/product/42226/polirmashina.html', name: 'kris06.bg', price: 114.99, currency: 'EUR', inStock: true },
  { url: 'https://www.mashini.bg/vibratsionna-polirmashina.html', name: 'mashini.bg', price: 99, currency: 'EUR', inStock: true },
  { url: 'https://tomika.bg/product/polirmashina.html', name: 'tomika.bg', price: 95, currency: 'EUR', inStock: false },
];

describe('creating a product from what discovery found', () => {
  it('writes the product and every chosen shop together', async () => {
    const { db, service } = build();

    const product = await service.track(OWNER, { name: 'STATUS XPA12-75', stores });

    expect(db.products).toHaveLength(1);
    expect(db.competitors).toHaveLength(3);
    expect(product.competitorCount).toBe(3);
    expect(db.competitors.every((row) => row.productId === product.id)).toBe(true);
  });

  it('makes the first shop the primary listing', async () => {
    // The discovery screen puts the best match first, and the product row
    // quotes the primary when it has nothing better.
    const { db, service } = build();

    await service.track(OWNER, { name: 'STATUS XPA12-75', stores });

    const primaries = db.competitors.filter((row) => row.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].host).toBe('kris06.bg');
  });

  it('hands the product to the existing monitoring, unchanged', async () => {
    // Not a second mechanism. The scraper looks for pending, active rows and
    // knows nothing about how they got there.
    const { db, service } = build();

    await service.track(OWNER, { name: 'STATUS XPA12-75', stores });

    expect(db.products[0].scrapeStatus).toBe(ScrapeStatus.Pending);
    expect(db.competitors.every((row) => row.scrapeStatus === ScrapeStatus.Pending)).toBe(true);
    expect(db.competitors.every((row) => row.isActive === true)).toBe(true);
  });

  it('seeds the prices the search already read', async () => {
    // So the list shows real numbers before the first scrape instead of a row
    // of dashes. The scraper overwrites them on its first pass.
    const { db, service } = build();

    await service.track(OWNER, { name: 'STATUS XPA12-75', stores });

    expect(db.products[0].currentPrice).toBe(114.99);
    expect(db.competitors.map((row) => row.currentPrice)).toEqual([114.99, 99, 95]);
    expect(db.history).toHaveLength(1);
  });

  it('writes an opening reading the database will accept', async () => {
    /*
     * Written after this failed in production against the real schema.
     *
     * The first version left out `source`, which is NOT NULL with no default:
     * the insert failed, the transaction rolled back, and the reader was told
     * "A required field was missing" about a field no form had ever shown
     * them. A test asserting only that a row existed passed the whole time,
     * because the fake store has no constraints — so this asserts the shape
     * the column definitions actually require.
     */
    const { db, service } = build();

    await service.track(OWNER, { name: 'STATUS XPA12-75', stores });

    const [reading] = db.history;

    expect(reading.source).toBe('initial');
    expect(reading.currency).toBe('EUR');
    expect(reading.price).toBe(114.99);
    // Attributed to the shop it came from. A price belonging to no supplier is
    // not a smaller truth than one that does, it is a different one.
    expect(reading.competitorId).toBe(db.competitors[0].id);
    expect(reading.productId).toBe(db.products[0].id);

    // Every column the entity declares NOT NULL has a value.
    for (const column of ['productId', 'competitorId', 'price', 'currency', 'source']) {
      expect([column, reading[column]]).not.toEqual([column, undefined]);
      expect([column, reading[column]]).not.toEqual([column, null]);
    }
  });

  it('carries availability through from the search', async () => {
    const { db, service } = build();
    await service.track(OWNER, { name: 'STATUS XPA12-75', stores });

    expect(db.competitors.map((row) => row.inStock)).toEqual([true, true, false]);
  });

  it('keeps the identifying fields the reader confirmed', async () => {
    const { db, service } = build();

    await service.track(OWNER, {
      name: 'Bosch GSR 18V-55',
      brand: 'Bosch',
      model: 'GSR 18V-55',
      category: 'Винтоверт',
      gtin: '4059952512334',
      ourPrice: 145,
      targetPrice: 135,
      stores: [stores[0]],
    });

    expect(db.products[0]).toMatchObject({
      brand: 'Bosch',
      model: 'GSR 18V-55',
      category: 'Винтоверт',
      gtin: '4059952512334',
      ourPrice: 145,
      targetPrice: 135,
    });
  });

  it('leaves a field empty rather than inventing it', async () => {
    // The understanding step fills in what it read and nothing else. A brand
    // guessed to fill a column is a brand the matcher will later compare on.
    const { db, service } = build();

    await service.track(OWNER, { name: 'Нещо без марка', stores: [stores[0]] });

    expect(db.products[0].brand).toBeNull();
    expect(db.products[0].gtin).toBeNull();
    expect(db.products[0].model).toBeNull();
  });

  it('starts nothing when no shop was chosen', async () => {
    // Guarded by the DTO before it reaches here, and worth stating: a product
    // watched nowhere is a row that can never change, and creating it quietly
    // would look like the monitoring had started.
    const { db, service } = build();

    await expect(
      service.track(OWNER, { name: 'STATUS XPA12-75', stores: [] }),
    ).rejects.toThrow();

    expect(db.products).toHaveLength(0);
    expect(db.competitors).toHaveLength(0);
  });

  it('records no opening price when the search found none', async () => {
    const { db, service } = build();

    await service.track(OWNER, {
      name: 'STATUS XPA12-75',
      stores: [{ url: 'https://bg.status-tools.com/products/x/', name: 'bg.status-tools.com' }],
    });

    expect(db.products[0].currentPrice).toBeNull();
    expect(db.history).toHaveLength(0);
  });
});
