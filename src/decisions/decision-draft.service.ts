import { createHmac, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Configuration } from '../config/configuration';
import { PurchaseDecisionSnapshot } from './purchase-decision.snapshot';

/** How long a draft may be held before it must be priced again. */
const DRAFT_TTL_MS = 60 * 60 * 1000;

/**
 * A draft, as it travels to the client and back.
 *
 * The snapshot goes out in the clear on purpose. The interface needs it
 * anyway — it is what "how was this calculated?" reads from — so encrypting it
 * would hide it from the one party entitled to see it while protecting nothing:
 * every figure in it was just displayed to the same person.
 */
export interface SealedDecisionDraft {
  snapshot: PurchaseDecisionSnapshot;
  /** Proves the server produced this snapshot. See {@link DecisionDraftService}. */
  signature: string;
}

/**
 * Letting the client say "keep this one" without letting it say what it cost.
 *
 * The problem is narrow and worth stating exactly. Creating a purchase decision
 * must not re-run the optimiser — a second run would ask the suppliers again,
 * match again and quite possibly produce a *different* plan, so the stored
 * decision would not be the one the buyer looked at when they decided. But the
 * result of the first run lives in a response that has already been sent, and
 * the only party who still holds it is the client.
 *
 * Two obvious answers are both wrong:
 *
 *  - **Trust the client to post the result back.** This is a savings-proof
 *    feature. A payload the client can edit is a savings figure the client can
 *    invent, and the whole record becomes worthless as evidence.
 *  - **Keep the result in memory until the client confirms.** Works on one
 *    container and fails on two: the confirming request lands on the instance
 *    that never saw the basket. It also turns every exploratory comparison into
 *    retained state.
 *
 * So the server signs what it produced. The snapshot travels out and back
 * unchanged, and an HMAC over its canonical form proves it is byte-for-byte
 * what this server computed. Stateless, correct across any number of
 * instances, and unforgeable without the key.
 *
 * The key is derived from the operator API key, which is required at boot,
 * never leaves the server, and is identical on every instance of a deployment.
 * Rotating it invalidates outstanding drafts, which costs a buyer one re-run of
 * a comparison they have not yet acted on.
 */
@Injectable()
export class DecisionDraftService {
  private readonly key: Buffer;

  constructor(configService: ConfigService<Configuration, true>) {
    const auth = configService.get('auth', { infer: true });

    // Derived rather than used directly, so this signature can never be
    // mistaken for, or replayed as, an API key. The label is part of the
    // derivation for the same reason: a key derived for one purpose must not
    // verify a message written for another.
    this.key = createHmac('sha256', auth.apiKeys[0] ?? 'stoclify-decision-draft')
      .update('purchase-decision-draft-v1')
      .digest();
  }

  /** Signs a snapshot for the round trip through the client. */
  seal(snapshot: PurchaseDecisionSnapshot): SealedDecisionDraft {
    return { snapshot, signature: this.sign(snapshot) };
  }

  /**
   * Checks a returned draft and hands back the snapshot to store.
   *
   * Refuses rather than repairs. A draft that fails verification is either
   * tampered with or from another deployment, and in both cases the honest
   * answer is to price the order again — not to store a decision whose
   * provenance we cannot vouch for.
   */
  open(draft: SealedDecisionDraft): PurchaseDecisionSnapshot {
    if (!draft?.snapshot || typeof draft.signature !== 'string') {
      throw new BadRequestException('Решението е непълно. Остойностете поръчката отново.');
    }

    const expected = Buffer.from(this.sign(draft.snapshot), 'hex');
    const presented = Buffer.from(draft.signature, 'hex');

    // Length is checked first because `timingSafeEqual` throws on a mismatch
    // rather than returning false, and a thrown 500 would tell an attacker
    // more than a refusal does.
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new BadRequestException(
        'Това решение не идва от последното остойностяване. Направете сравнението отново и запазете резултата от него.',
      );
    }

    const decidedAt = Date.parse(draft.snapshot.decidedAt);

    // An age limit as well as a signature. A signature says the figures are
    // ours; it says nothing about whether they are still worth acting on, and
    // a decision saved from a week-old comparison would be a record of prices
    // nobody checked this week.
    if (!Number.isFinite(decidedAt) || Date.now() - decidedAt > DRAFT_TTL_MS) {
      throw new BadRequestException(
        'Това сравнение е отпреди повече от час. Направете го отново, за да запазите решение с актуални цени.',
      );
    }

    return draft.snapshot;
  }

  private sign(snapshot: PurchaseDecisionSnapshot): string {
    return createHmac('sha256', this.key).update(canonicalJson(snapshot)).digest('hex');
  }
}

/**
 * JSON with every object's keys in a fixed order.
 *
 * `JSON.stringify` preserves insertion order, and the client that echoes a
 * snapshot back has no obligation to preserve it — a parse and re-serialise
 * through almost any HTTP client is enough to reorder something. Signing the
 * raw text would therefore reject honest clients at random, which is worse than
 * useless: it would look like tampering.
 *
 * Sorting the keys makes the signature a function of the *value* rather than of
 * how it happened to be written. Arrays keep their order, because in a
 * snapshot their order is meaning — the cheapest alternative is first.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` has no JSON representation, so a key holding one disappears
    // on the way out and must not be signed on the way in.
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}
