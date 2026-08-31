import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { VatState } from '../pricing/effective-cost';
import { DecisionDraftService, canonicalJson } from './decision-draft.service';
import { PurchaseDecisionSnapshot, SNAPSHOT_VERSION } from './purchase-decision.snapshot';

/**
 * The seal on a draft.
 *
 * A purchase decision is evidence, and it makes a round trip through the
 * client before it is stored. These tests hold the line that makes that safe:
 * the server will store what it computed, and nothing else — not a saving
 * inflated by one euro, not a plan from someone else's deployment, and not a
 * comparison old enough that the prices in it are no longer a claim about
 * today.
 */

const service = (apiKey = 'operator-key'): DecisionDraftService =>
  new DecisionDraftService({
    get: () => ({ apiKeys: [apiKey] }),
  } as unknown as ConfigService<never, true>);

const snapshot = (over: Partial<PurchaseDecisionSnapshot> = {}): PurchaseDecisionSnapshot => ({
  version: SNAPSHOT_VERSION,
  decidedAt: new Date().toISOString(),
  currency: 'EUR',
  request: {
    lines: [{ query: 'cable', quantity: 100 }],
    currency: 'EUR',
    maxSuppliers: null,
    excludeShopIds: [],
    usedCache: true,
  },
  suppliers: [
    {
      shopId: 'a',
      name: 'Shop a',
      host: 'a.example',
      currency: 'EUR',
      discountPercent: 0,
      vatState: VatState.Exclusive,
      vatRate: 20,
      shippingCost: 10,
      freeShippingOver: null,
      handlingFee: 0,
      minOrderValue: 0,
    },
  ],
  lines: [],
  optimisation: {
    baseline: null,
    optimised: {
      kind: 'optimal',
      label: '1 доставчик',
      suppliersUsed: 1,
      productSubtotal: 100,
      shipping: 10,
      handlingFee: 0,
      total: 110,
      linesCovered: 1,
      suppliers: [],
    },
    savings: 40,
    savingsPercent: 12.7,
    suppliersUsed: 1,
    alternatives: [],
    rejectedSuppliers: [],
    unassigned: [],
    explanation: { whyChosen: [], tradeOffs: [] },
    diagnostics: {
      lineCount: 1,
      assignableLines: 1,
      supplierCount: 1,
      candidateOffers: 1,
      combinationsEvaluated: 1,
      feasiblePlans: 1,
      boundedSearch: false,
      durationMs: 3,
    },
  },
  matching: { aiUsed: false, model: null, promptVersion: null, decidedDeterministically: 1 },
  durationMs: 2400,
  ...over,
});

describe('DecisionDraftService', () => {
  it('accepts back exactly what it issued', () => {
    const drafts = service();
    const sealed = drafts.seal(snapshot());

    expect(drafts.open(sealed)).toEqual(sealed.snapshot);
  });

  it('accepts a draft whose keys came back in a different order', () => {
    const drafts = service();
    const sealed = drafts.seal(snapshot());

    // What a client that rebuilds the object does. Every key and value is
    // still there; only the insertion order differs. This is the honest-client
    // case, and rejecting it would look exactly like tampering.
    const reordered = reverseKeys(sealed.snapshot) as PurchaseDecisionSnapshot;

    expect(reordered).toEqual(sealed.snapshot);
    expect(Object.keys(reordered)).not.toEqual(Object.keys(sealed.snapshot));

    expect(() => drafts.open({ snapshot: reordered, signature: sealed.signature })).not.toThrow();
  });

  it('refuses a saving that was edited on the way back', () => {
    const drafts = service();
    const sealed = drafts.seal(snapshot());

    const inflated = {
      ...sealed,
      snapshot: {
        ...sealed.snapshot,
        optimisation: { ...sealed.snapshot.optimisation, savings: 4000 },
      },
    };

    expect(() => drafts.open(inflated)).toThrow(BadRequestException);
  });

  it('refuses a draft sealed with a different key', () => {
    const sealed = service('one-key').seal(snapshot());

    expect(() => service('another-key').open(sealed)).toThrow(BadRequestException);
  });

  it('refuses a comparison old enough that its prices are no longer a claim', () => {
    const drafts = service();
    const sealed = drafts.seal(
      snapshot({ decidedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }),
    );

    // Correctly signed — and still refused. A signature says the figures are
    // ours, not that they are current.
    expect(() => drafts.open(sealed)).toThrow(/отпреди повече от час/);
  });

  it('refuses a malformed draft without throwing something unhelpful', () => {
    const drafts = service();

    expect(() => drafts.open({ snapshot: undefined, signature: 'abc' } as never)).toThrow(
      BadRequestException,
    );
    // A signature of the wrong length must be a refusal, not a crash inside
    // the comparison.
    expect(() => drafts.open({ snapshot: snapshot(), signature: 'ab' })).toThrow(
      BadRequestException,
    );
  });
});

describe('canonicalJson', () => {
  it('gives the same text however the object was built', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('keeps array order, which is meaning', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined the way JSON.stringify does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

/** The same document with every object's keys inserted in the opposite order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== 'object') return value;

  const rebuilt: Record<string, unknown> = {};
  for (const key of Object.keys(value).reverse()) {
    rebuilt[key] = reverseKeys((value as Record<string, unknown>)[key]);
  }

  return rebuilt;
}
