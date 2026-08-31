import { VatCertainty, VatState } from '../pricing/effective-cost';
import { OptimiserLine, OptimiserOptions, optimiseOrder } from '../pricing/order-optimizer';
import { SupplierTerms } from '../pricing/effective-cost';
import {
  LineProvenance,
  SnapshotContext,
  buildSnapshot,
  provenanceKey,
} from './purchase-decision.snapshot';

/**
 * What a decision has to survive.
 *
 * The claim under test is not "the snapshot has the right fields". It is the
 * one the product is sold on: **a decision made in August still says in
 * November exactly what it said in August**, whatever has happened to the
 * suppliers, the prices or the code in between.
 *
 * So these tests do the thing that would break it. They build a decision, then
 * change the discount, the delivery charge and the price, re-run the optimiser
 * to prove the *live* answer moved, and assert that the snapshot did not.
 */

const terms = (over: Partial<SupplierTerms> & { shopId: string }): SupplierTerms => ({
  name: `Shop ${over.shopId}`,
  currency: 'EUR',
  discountPercent: 0,
  vatState: VatState.Exclusive,
  vatRate: 20,
  shippingCost: 0,
  freeShippingOver: null,
  handlingFee: 0,
  minOrderValue: 0,
  ...over,
});

const offer = (shopId: string, unitPrice: number, over: Record<string, unknown> = {}) => ({
  shopId,
  unitPrice,
  confidence: 0.96,
  available: null,
  priceSource: 'live' as const,
  recordedAt: null,
  vatCertainty: VatCertainty.Known,
  matchedName: `${shopId} article`,
  url: `https://${shopId}.example/p`,
  ...over,
});

const provenanceFor = (
  query: string,
  shopId: string,
  listPrice: number,
): [string, LineProvenance] => [
  provenanceKey(query, shopId),
  {
    price: {
      source: 'live',
      url: `https://${shopId}.example/p`,
      supplierId: shopId,
      supplierName: `Shop ${shopId}`,
      recordedAt: null,
    },
    match: {
      method: 'attributes',
      confidence: 0.96,
      band: 'certain',
      explanation: 'Съвпадат: марка, мощност.',
      attributes: [{ label: 'мощност', left: '12W', right: '12W', agrees: true }],
      aiUsed: false,
      model: null,
      promptVersion: null,
      manualOverride: null,
    },
    listPrice,
    listCurrency: 'EUR',
    discountPercent: 0,
    vatState: VatState.Exclusive,
  },
];

/** Two suppliers, one cheaper on each line — so the plan is genuinely a split. */
function scenario(supplierTerms: SupplierTerms[]) {
  const lines: OptimiserLine[] = [
    { query: 'cable', quantity: 100, offers: [offer('a', 1), offer('b', 2)] },
    { query: 'socket', quantity: 50, offers: [offer('a', 4), offer('b', 3)] },
  ];

  const options: OptimiserOptions = { currency: 'EUR', minConfidence: 0.7 };
  const map = new Map(supplierTerms.map((entry) => [entry.shopId as string, entry]));

  return { lines, options, map };
}

function contextFor(
  suppliers: SupplierTerms[],
  decidedAt = new Date('2026-08-28T14:31:00Z'),
): SnapshotContext {
  return {
    decidedAt,
    durationMs: 2400,
    request: {
      lines: [
        { query: 'cable', quantity: 100 },
        { query: 'socket', quantity: 50 },
      ],
      currency: 'EUR',
      maxSuppliers: null,
      excludeShopIds: [],
      usedCache: true,
    },
    suppliers: suppliers.map((entry) => ({
      shopId: entry.shopId as string,
      name: entry.name,
      host: `${entry.shopId as string}.example`,
      currency: entry.currency,
      discountPercent: entry.discountPercent,
      vatState: entry.vatState,
      vatRate: entry.vatRate,
      shippingCost: entry.shippingCost,
      freeShippingOver: entry.freeShippingOver,
      handlingFee: entry.handlingFee,
      minOrderValue: entry.minOrderValue,
    })),
    provenance: new Map([
      provenanceFor('cable', 'a', 1),
      provenanceFor('cable', 'b', 2),
      provenanceFor('socket', 'a', 4),
      provenanceFor('socket', 'b', 3),
    ]),
    matching: {
      aiUsed: false,
      model: null,
      promptVersion: null,
      decidedDeterministically: 4,
    },
  };
}

describe('buildSnapshot', () => {
  it('captures the plan, the baseline and what was saved', () => {
    const today = [
      terms({ shopId: 'a', shippingCost: 10 }),
      terms({ shopId: 'b', shippingCost: 10 }),
    ];
    const { lines, options, map } = scenario(today);

    const snapshot = buildSnapshot(optimiseOrder(lines, map, options), contextFor(today));

    expect(snapshot).not.toBeNull();
    // 100 × 1 from a, 50 × 3 from b, plus a delivery each.
    expect(snapshot!.optimisation.optimised.total).toBe(270);
    expect(snapshot!.optimisation.optimised.suppliersUsed).toBe(2);
    // Everything at a: 100 × 1 + 50 × 4 + one delivery.
    expect(snapshot!.optimisation.baseline!.total).toBe(310);
    expect(snapshot!.optimisation.savings).toBe(40);
  });

  it('records where every price came from and what decided every match', () => {
    const today = [terms({ shopId: 'a' }), terms({ shopId: 'b' })];
    const { lines, options, map } = scenario(today);

    const snapshot = buildSnapshot(optimiseOrder(lines, map, options), contextFor(today))!;
    const cable = snapshot.lines.find((line) => line.query === 'cable')!;

    expect(cable.price).toMatchObject({
      source: 'live',
      url: 'https://a.example/p',
      supplierName: 'Shop a',
      stale: false,
      ageHours: 0,
    });

    expect(cable.match).toMatchObject({
      method: 'attributes',
      confidence: 0.96,
      aiUsed: false,
      manualOverride: null,
    });
    expect(cable.match.attributes).toHaveLength(1);
  });

  it('ages a cached price against the moment the decision was made, not against now', () => {
    const today = [terms({ shopId: 'a' }), terms({ shopId: 'b' })];
    const lines: OptimiserLine[] = [
      {
        query: 'cable',
        quantity: 100,
        offers: [
          offer('a', 1, { priceSource: 'cached', recordedAt: '2026-08-28T08:31:00Z' }),
          offer('b', 2),
        ],
      },
    ];

    const context = contextFor(today);
    context.request.lines = [{ query: 'cable', quantity: 100 }];

    const snapshot = buildSnapshot(
      optimiseOrder(lines, new Map(today.map((entry) => [entry.shopId as string, entry])), {
        currency: 'EUR',
        minConfidence: 0.7,
      }),
      context,
    )!;

    // Decided at 14:31, read at 08:31.
    expect(snapshot.lines[0].price.ageHours).toBe(6);
    expect(snapshot.lines[0].price.stale).toBe(true);
  });

  it('keeps only the suppliers that bore on the decision', () => {
    const today = [
      terms({ shopId: 'a' }),
      terms({ shopId: 'b' }),
      // Configured, but nobody's offer and nobody's rejection: irrelevant to
      // this decision, and copying their negotiated terms in would be storing
      // commercial detail the record has no use for.
      terms({ shopId: 'c', discountPercent: 40 }),
    ];
    const { lines, options } = scenario(today);
    const map = new Map(today.map((entry) => [entry.shopId as string, entry]));

    const snapshot = buildSnapshot(optimiseOrder(lines, map, options), contextFor(today))!;

    expect(snapshot.suppliers.map((supplier) => supplier.shopId).sort()).toEqual(['a', 'b']);
  });

  it('refuses to record a decision when no plan could be placed', () => {
    const impossible = [terms({ shopId: 'a', minOrderValue: 100_000 })];
    const lines: OptimiserLine[] = [{ query: 'cable', quantity: 1, offers: [offer('a', 1)] }];

    const result = optimiseOrder(lines, new Map([['a', impossible[0]]]), {
      currency: 'EUR',
      minConfidence: 0.7,
    });

    expect(buildSnapshot(result, contextFor(impossible))).toBeNull();
  });
});

describe('a snapshot after the world moves', () => {
  /**
   * The test the whole feature exists for.
   *
   * Every input is changed underneath a stored decision — the discount, the
   * delivery charge and the price — and the live optimiser is re-run to prove
   * the change is real. The snapshot must not move by a cent.
   */
  it('does not change when the supplier discount, delivery or price changes', () => {
    const august = [
      terms({ shopId: 'a', shippingCost: 10, discountPercent: 0 }),
      terms({ shopId: 'b', shippingCost: 10, discountPercent: 0 }),
    ];

    const { lines, options, map } = scenario(august);
    const stored = buildSnapshot(optimiseOrder(lines, map, options), contextFor(august))!;

    // Deep-frozen the way the database holds it: a document, not a view.
    const asStored = JSON.parse(JSON.stringify(stored)) as typeof stored;

    // --- November. Everything has moved. ---
    const november = [
      terms({ shopId: 'a', shippingCost: 25, discountPercent: 30 }),
      terms({ shopId: 'b', shippingCost: 25, discountPercent: 15 }),
    ];
    const laterLines: OptimiserLine[] = [
      { query: 'cable', quantity: 100, offers: [offer('a', 0.7), offer('b', 1.7)] },
      { query: 'socket', quantity: 50, offers: [offer('a', 3.4), offer('b', 2.55)] },
    ];

    const liveNow = optimiseOrder(
      laterLines,
      new Map(november.map((entry) => [entry.shopId as string, entry])),
      options,
    );

    // The live answer really did move — otherwise this test proves nothing.
    expect(liveNow.best!.total).not.toBe(asStored.optimisation.optimised.total);

    // And the record did not.
    expect(asStored.optimisation.optimised.total).toBe(270);
    expect(asStored.optimisation.baseline!.total).toBe(310);
    expect(asStored.optimisation.savings).toBe(40);
    expect(asStored.suppliers.find((supplier) => supplier.shopId === 'a')!.discountPercent).toBe(0);
    expect(asStored.suppliers.find((supplier) => supplier.shopId === 'a')!.shippingCost).toBe(10);
    expect(asStored.lines.find((line) => line.query === 'cable')!.unitPrice).toBe(1);
  });

  it('keeps the price a supplier quoted even after the article is delisted', () => {
    const august = [terms({ shopId: 'a' }), terms({ shopId: 'b' })];
    const { lines, options, map } = scenario(august);
    const stored = buildSnapshot(optimiseOrder(lines, map, options), contextFor(august))!;

    // The article is gone: no offers at all from anybody.
    const gone = optimiseOrder([{ query: 'cable', quantity: 100, offers: [] }], map, options);

    expect(gone.best).toBeNull();
    // The decision still knows what it was, what it cost and where it was read.
    const cable = stored.lines.find((line) => line.query === 'cable')!;
    expect(cable.unitPrice).toBe(1);
    expect(cable.url).toBe('https://a.example/p');
  });
});
