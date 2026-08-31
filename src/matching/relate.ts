/**
 * Deciding how two listings stand to each other, without knowing the trade.
 *
 * The old matcher asked one question — same or not — and answered it from a
 * table of attributes that only existed for eight categories. Outside those
 * eight it compared anonymous numbers by set overlap, which is why a 50 mm
 * pipe and a 4 m pipe looked like agreement and a 50 mm pipe and a DN50 one
 * looked like nothing at all.
 *
 * What replaces it turns on one idea. Attributes are compared **by dimension,
 * not by name**. A length is a length whether the supplier called it a length,
 * a diameter, or nothing at all, and once both sides are reduced to base units
 * the comparison is arithmetic. Names are then used to *label* what matched,
 * never to decide whether it could.
 *
 * The second idea is that silence is not disagreement. A value one side states
 * and the other omits is a missing value, and missing values lower confidence
 * and are what a model is later asked about. Two values both stated and
 * different is the only thing that ends the conversation.
 */

import { AttributeRole } from './lexicon';
import { GenericProduct, ProductAttribute, ProductRelation } from './product-model';
import { QuantityKind, formatQuantity, sameQuantity } from './units';
import { canonicalIdentifier, containsAllTokens, similarity } from './normalisation';

/** One attribute, as the two sides stated it. */
export interface AttributeComparison {
  key: string;
  label: string;
  role: AttributeRole;
  /** What the buyer asked for, or null where they said nothing. */
  query: string | null;
  /** What the supplier states, or null where they say nothing. */
  candidate: string | null;
  status: 'match' | 'missing' | 'conflict';
}

export type MatchMethod =
  'gtin' | 'sku' | 'model' | 'attributes' | 'text' | 'ai' | 'conflict' | 'none';

export interface RelationVerdict {
  relation: ProductRelation;
  /** 0–1, and never a guess dressed as certainty. */
  confidence: number;
  method: MatchMethod;
  /** Every attribute both sides state and agree on. */
  matched: AttributeComparison[];
  /** Every attribute one side states and the other does not. */
  missing: AttributeComparison[];
  /** Every attribute both sides state differently. */
  conflicts: AttributeComparison[];
  /**
   * True when the difference is one no model should be paid to reconsider.
   *
   * 128 GB against 256 GB needs no second opinion, and buying one spends money
   * to be told what arithmetic already knew.
   */
  blocked: boolean;
  /** True when a model could settle something arithmetic could not. */
  needsAi: boolean;
}

export interface RelationThresholds {
  /** At or above this, the same article without asking a model. */
  certain: number;
  /** Below this, not presented as a match at all. */
  floor: number;
}

export const DEFAULT_RELATION_THRESHOLDS: RelationThresholds = { certain: 0.9, floor: 0.7 };

/** Roles whose disagreement means the buyer would receive the wrong thing. */
const BLOCKING_ROLES = new Set<AttributeRole>(['identity', 'compatibility']);

/**
 * How two products stand to each other.
 *
 * Runs a ladder from strongest evidence to weakest and stops at the first rung
 * that answers, because most pairs are settled long before the bottom and the
 * bottom is where the money goes.
 */
export function relate(
  query: GenericProduct,
  candidate: GenericProduct,
  thresholds: RelationThresholds = DEFAULT_RELATION_THRESHOLDS,
): RelationVerdict {
  const comparisons = compare(query, candidate);

  const matched = comparisons.filter((entry) => entry.status === 'match');
  const missing = comparisons.filter((entry) => entry.status === 'missing');
  const conflicts = comparisons.filter((entry) => entry.status === 'conflict');

  // Whether this listing says it fits what the buyer asked for, worked out
  // before the conflict check rather than after it. An aftermarket brake pad
  // names BMW and is made by Brembo: read as a plain brand disagreement that
  // is a refusal, and read in context it is the purchase the buyer wanted.
  const fitment = fitsWhatWasAsked(query, candidate);

  const blocking = conflicts.filter(
    (entry) => BLOCKING_ROLES.has(entry.role) && !(fitment && entry.key === 'brand'),
  );
  const variantConflicts = conflicts.filter((entry) => entry.role === 'variant');

  const identityMatches = matched.filter(
    (entry) => entry.role === 'identity' && entry.key !== 'brand' && entry.key !== 'type',
  );

  /**
   * Everything both sides state and agree on that is not mere description.
   *
   * A pack size agreeing is evidence even though a pack size does not identify
   * an article, and two cups agreeing on volume *and* on how many come in the
   * box is a stronger answer than one agreeing on volume alone. Counting only
   * identity attributes lost that, and lost it in exactly the trades — food,
   * catering, consumables — where the pack is half of what is being bought.
   */
  const agreements = matched.filter(
    (entry) =>
      entry.role !== 'descriptive' &&
      entry.role !== 'commercial' &&
      entry.key !== 'brand' &&
      entry.key !== 'type',
  );
  const brandAgrees = matched.some((entry) => entry.key === 'brand');
  const typeAgrees = matched.some((entry) => entry.key === 'type');

  const base = { matched, missing, conflicts };

  // --- Rung 1: a barcode ---------------------------------------------------
  //
  // Ahead of the conflict check, and only just. A barcode is issued per
  // variant, so a shared one cannot mean two variants — while everything the
  // conflict check reads is inferred from words, and inference loses to an
  // identifier.
  const sharedGtin = query.identifiers.gtins.find((gtin) =>
    candidate.identifiers.gtins.includes(gtin),
  );

  if (sharedGtin) {
    return {
      ...base,
      relation: 'same_product',
      confidence: 1,
      method: 'gtin',
      blocked: false,
      needsAi: false,
      matched: [
        {
          key: 'gtin',
          label: 'Barcode',
          role: 'identity',
          query: sharedGtin,
          candidate: sharedGtin,
          status: 'match',
        },
        ...matched,
      ],
    };
  }

  // --- Rung 2: the supplier's own article number ---------------------------
  if (
    query.identifiers.sku &&
    candidate.identifiers.sku &&
    query.identifiers.sku === candidate.identifiers.sku
  ) {
    return {
      ...base,
      relation: 'same_product',
      confidence: 0.99,
      method: 'sku',
      blocked: false,
      needsAi: false,
      matched: [
        {
          key: 'sku',
          label: 'Article number',
          role: 'identity',
          query: query.identifiers.sku,
          candidate: candidate.identifiers.sku,
          status: 'match',
        },
        ...matched,
      ],
    };
  }

  // --- Rung 3: something identifying, stated differently on each side ------
  //
  // Below the identifiers and above everything else. A model code is shared
  // across a family — the 128 GB and the 256 GB phone often carry the same
  // one — so where the names state different capacities, the names win.
  if (blocking.length > 0) {
    return {
      ...base,
      relation: 'conflict',
      confidence: 0,
      method: 'conflict',
      blocked: true,
      needsAi: false,
    };
  }

  const sharedModel = sharedIdentifier(query, candidate);

  // --- Rung 4: the same line, a different version --------------------------
  //
  // Section 13's case, and the reason a variant is not simply an identity. The
  // buyer asked for black and this one is white: it is the same product line,
  // it is not what they asked for, and telling them either of those things
  // alone would be a lie by omission.
  if (variantConflicts.length > 0) {
    return {
      ...base,
      relation: sharedModel ? 'same_family' : 'same_type',
      confidence: sharedModel ? 0.6 : 0.45,
      method: 'attributes',
      blocked: false,
      needsAi: false,
    };
  }

  // --- Rung 5: a shared model code ----------------------------------------
  if (sharedModel) {
    return {
      ...base,
      relation: 'same_product',
      confidence: 0.95,
      method: 'model',
      blocked: false,
      needsAi: false,
      matched: [
        {
          key: 'model',
          label: 'Model',
          role: 'identity',
          query: sharedModel,
          candidate: sharedModel,
          status: 'match',
        },
        ...matched,
      ],
    };
  }

  // --- Rung 6: made for what was asked for, by somebody else ---------------
  //
  // An aftermarket brake pad names the car it fits and not the carmaker. That
  // is not the same article and it is very often the right purchase, so it
  // gets a relation of its own rather than being rounded to either answer.
  if (fitment) {
    return {
      ...base,
      relation: 'compatible',
      confidence: 0.72,
      method: 'attributes',
      blocked: false,
      needsAi: identityMatches.length === 0,
      matched: [fitment, ...matched],
    };
  }

  // --- Rung 6b: the buyer named a part number -------------------------------
  //
  // High-precision mode, and the rule that ends the whole class of failure
  // this engine kept producing. Somebody who types "STATUS XPA12-75" is not
  // describing a machine, they are naming one — and a listing that cannot
  // show that part number is not that machine, whatever else it shares.
  //
  // Without this the ladder fell through to rung 9, where overlapping
  // vocabulary alone reaches 0.84. That is a *similarity* score, and the
  // system was reading it as product identity: enough to clear the floor,
  // enough to be quoted, enough — being cheap — to be crowned the best offer.
  // A screen protector cannot be the best price for a polisher, and no amount
  // of shared words should have been able to say otherwise.
  //
  // Silence about the code is refusal here, not doubt. That inverts the rule
  // the rest of this file follows, and it is the right inversion: the buyer
  // stated the one thing that identifies the article, so a listing omitting
  // it has failed the only test that was set.
  if (query.identifiers.modelCodes.length > 0) {
    return {
      ...base,
      relation: 'unrelated',
      confidence: Math.min(0.3, similarity(query.raw, candidate.raw)),
      method: 'text',
      blocked: false,
      // Nothing for a model to settle. It cannot put a part number into a
      // listing that does not carry one, and paying it to confirm that is the
      // waste this ladder exists to avoid.
      needsAi: false,
    };
  }

  // --- Rung 7: everything the buyer asked for is satisfied ------------------
  //
  // The rule that replaced counting agreements, and the reason a search that
  // used to return nothing now returns the shelf.
  //
  // Counting was the wrong question. "кабел 2x1.5" states exactly one thing,
  // so it could never reach two agreements, and a listing that was precisely
  // the cable asked for scored 0.64 and fell below the floor — invisible.
  // Meanwhile a chatty listing agreeing on three incidental numbers scored
  // higher than the right answer.
  //
  // What matters is coverage: did the buyer state anything identifying, and is
  // every one of those things satisfied? Nothing they asked for is missing,
  // nothing is contradicted — conflicts left at rung 3 — so this is the
  // article. How *much* they asked for only decides how sure we are.
  const asked = comparisons.filter(
    (entry) =>
      entry.query !== null &&
      BLOCKING_ROLES.has(entry.role) &&
      entry.key !== 'brand' &&
      entry.key !== 'type',
  );

  const unresolved = asked.filter((entry) => entry.status !== 'match');

  // A brand the buyer did not name is a brand they did not care about. Where
  // they did name one it agrees, because a disagreement is a conflict and left
  // at rung 3.
  const brandIsFine = brandAgrees || !query.brand;

  if (asked.length > 0 && unresolved.length === 0 && (brandIsFine || typeAgrees)) {
    return {
      ...base,
      relation: 'same_product',
      confidence: Math.min(
        0.94,
        (brandAgrees ? 0.86 : typeAgrees ? 0.84 : 0.82) + 0.02 * agreements.length,
      ),
      method: 'attributes',
      blocked: false,
      // Already above the certainty line where the brand or the kind agrees:
      // another opinion cannot change the decision, so buying one is waste.
      needsAi: !brandAgrees && !typeAgrees,
    };
  }

  // The older reading, kept for the case the coverage rule cannot see: the
  // buyer stated nothing identifying, but both listings state the same two
  // specifications and agree on who made it. Two 12 W E27 Philips bulbs are
  // one article however either side chose to phrase it.
  if (identityMatches.length >= 2 && (brandAgrees || typeAgrees)) {
    return {
      ...base,
      relation: 'same_product',
      confidence: Math.min(0.94, (brandAgrees ? 0.86 : 0.84) + 0.02 * agreements.length),
      method: 'attributes',
      blocked: false,
      needsAi: false,
    };
  }

  // --- Rung 8: a question with nothing to match on -------------------------
  //
  // "лампа" states no brand, no measurement, no code. Demanding specifications
  // would answer "nothing matches" to a question with thousands of answers, so
  // the answer is as precise as the question: does the listing carry the words.
  const bare =
    query.attributes.filter((attribute) => attribute.role !== 'package').length === 0 &&
    query.identifiers.modelCodes.length === 0 &&
    query.identifiers.designators.length === 0 &&
    !query.brand;

  if (bare) {
    const contains = containsAllTokens(candidate.raw, query.raw);
    return {
      ...base,
      relation: contains ? 'same_type' : 'unrelated',
      confidence: contains ? 0.75 : Math.min(0.4, similarity(query.raw, candidate.raw)),
      method: 'text',
      blocked: false,
      // A model cannot make a vague question precise, and paying it to confirm
      // that a lamp is a lamp is the definition of waste.
      needsAi: false,
    };
  }

  // --- Rung 9: partial evidence -------------------------------------------
  //
  // Text similarity alone badly understates the two cases this product exists
  // for. A German listing shares almost no words with a Bulgarian query and
  // every specification. A listing naming only the brand shares one word and
  // may well be the same article. So agreement on things that identify counts
  // for more than overlapping vocabulary.
  const text = similarity(query.raw, candidate.raw);
  const sharedDesignator = query.identifiers.designators.some((code) =>
    candidate.identifiers.designators.includes(code),
  );

  const evidence =
    agreements.length + (brandAgrees ? 1 : 0) + (typeAgrees ? 1 : 0) + (sharedDesignator ? 1 : 0);
  const fromEvidence = evidence > 0 ? 0.4 + 0.12 * evidence : 0;
  const confidence = Math.min(0.84, Math.max(text, fromEvidence));

  return {
    ...base,
    relation: relationFor(confidence, evidence, typeAgrees, missing.length),
    confidence,
    method: 'text',
    blocked: false,
    // Worth a model only where something real is unresolved. With no agreeing
    // attribute and no shared vocabulary there is nothing to resolve, and the
    // shop's search engine was simply being generous.
    needsAi: confidence >= 0.35 && confidence < thresholds.certain,
  };
}

/**
 * The part number both sides carry, however either of them spelled it.
 *
 * `ST-9453/B`, `st9453b` and `ST 9453 B` are one part number written by three
 * people, and comparing the tokens as extracted made them three articles.
 * Both sides are reduced to their alphanumerics — the comparison
 * {@link canonicalIdentifier} was written for and that this rung never used.
 *
 * The listing's whole name is searched as well as its extracted codes: a shop
 * writing "Полирмашина вибрационна Status HD XPA12-75, 750W" states the code
 * plainly, and whether the extractor happened to isolate it as a token is an
 * accident of punctuation that should not decide a purchase. Only codes of
 * five characters or more are looked for that way — shorter ones appear inside
 * longer numbers by coincidence, and a coincidence is not an identity.
 */
export function sharedIdentifier(
  query: GenericProduct,
  candidate: GenericProduct,
): string | null {
  const theirs = candidate.identifiers.modelCodes.map(canonicalIdentifier);
  const haystack = canonicalIdentifier(candidate.raw);

  for (const code of query.identifiers.modelCodes) {
    const wanted = canonicalIdentifier(code);
    if (!wanted) continue;

    if (theirs.includes(wanted)) return code;
    if (wanted.length >= 5 && haystack.includes(wanted)) return code;
  }

  return null;
}

function relationFor(
  confidence: number,
  evidence: number,
  typeAgrees: boolean,
  missing: number,
): ProductRelation {
  if (confidence < 0.35) return 'unrelated';
  if (evidence >= 2 && missing > 0) return 'possible';
  if (typeAgrees && evidence <= 1) return 'same_type';
  return 'possible';
}

/**
 * Compares two interpretations attribute by attribute.
 *
 * Measurements are reconciled by dimension first — see {@link reconcile} —
 * then the values that are not measurements are compared by name, then the
 * things that are neither: who made it, what kind of thing it is, what range
 * it belongs to.
 */
export function compare(query: GenericProduct, candidate: GenericProduct): AttributeComparison[] {
  const comparisons: AttributeComparison[] = [];

  // --- measurements, by dimension -----------------------------------------
  const kinds = new Set<QuantityKind>([
    ...query.attributes.filter((a) => a.quantity).map((a) => a.quantity!.kind),
    ...candidate.attributes.filter((a) => a.quantity).map((a) => a.quantity!.kind),
  ]);

  for (const kind of kinds) {
    comparisons.push(
      ...reconcile(
        query.attributes.filter((a) => a.quantity?.kind === kind),
        candidate.attributes.filter((a) => a.quantity?.kind === kind),
      ),
    );
  }

  // --- values that are not measurements, by name ---------------------------
  const named = (product: GenericProduct): Map<string, ProductAttribute[]> => {
    const map = new Map<string, ProductAttribute[]>();
    for (const attribute of product.attributes) {
      if (attribute.quantity) continue;
      map.set(attribute.key, [...(map.get(attribute.key) ?? []), attribute]);
    }
    return map;
  };

  const leftNamed = named(query);
  const rightNamed = named(candidate);

  for (const key of new Set([...leftNamed.keys(), ...rightNamed.keys()])) {
    const left = leftNamed.get(key) ?? [];
    const right = rightNamed.get(key) ?? [];
    const role = (left[0] ?? right[0]).role;
    const label = (left[0] ?? right[0]).label;

    if (left.length === 0 || right.length === 0) {
      comparisons.push({
        key,
        label,
        role,
        query: left.map((entry) => entry.value).join(', ') || null,
        candidate: right.map((entry) => entry.value).join(', ') || null,
        status: 'missing',
      });
      continue;
    }

    // Overlap rather than equality: a supplier stating two colours has said
    // more than the buyer, not something different.
    const shared = left.find((entry) => right.some((other) => other.value === entry.value));

    comparisons.push({
      key,
      label,
      role,
      query: left.map((entry) => entry.value).join(', '),
      candidate: right.map((entry) => entry.value).join(', '),
      status: shared ? 'match' : 'conflict',
    });
  }

  // --- who made it ---------------------------------------------------------
  //
  // Only a manufacturer we are sure of on both sides can produce a conflict. A
  // word that merely sits where a brand sits is not evidence, and treating one
  // as a brand would reject matches over a disagreement nobody stated.
  if (query.brand || candidate.brand) {
    comparisons.push({
      key: 'brand',
      label: 'Brand',
      role: query.brand && candidate.brand ? 'identity' : 'descriptive',
      query: query.brand,
      candidate: candidate.brand,
      status:
        query.brand && candidate.brand
          ? query.brand === candidate.brand
            ? 'match'
            : 'conflict'
          : 'missing',
    });
  }

  // --- what kind of thing it is -------------------------------------------
  if (query.productType && candidate.productType) {
    const agrees =
      query.productType.canonical === candidate.productType.canonical ||
      query.productType.raw === candidate.productType.raw;

    // Two *recognised* kinds disagreeing is a different article. Where either
    // word was not recognised, a disagreement is a silence: the engine has no
    // opinion about industries nobody has written a row for, and pretending
    // otherwise is how a generic matcher starts rejecting good matches.
    const decisive = query.productType.known && candidate.productType.known;

    comparisons.push({
      key: 'type',
      label: 'Product type',
      role: decisive ? 'identity' : 'descriptive',
      query: query.productType.raw,
      candidate: candidate.productType.raw,
      status: agrees ? 'match' : decisive ? 'conflict' : 'missing',
    });
  }

  // --- the range it belongs to --------------------------------------------
  if (query.identifiers.family && candidate.identifiers.family) {
    comparisons.push({
      key: 'family',
      label: 'Range',
      role: 'identity',
      query: query.identifiers.family,
      candidate: candidate.identifiers.family,
      status: query.identifiers.family === candidate.identifiers.family ? 'match' : 'conflict',
    });
  }

  return comparisons;
}

/**
 * Matches up the measurements of one dimension, whatever they were called.
 *
 * This is the part that makes the engine domain-agnostic. "16GB 512GB" against
 * "16 GB RAM, 512 GB SSD" is two agreements, because 16 equals 16 and 512
 * equals 512 — no rule about laptops was consulted. "16GB 512GB" against
 * "16GB RAM" is one agreement and one *silence*, because the candidate has no
 * unclaimed capacity left to disagree with. And "128GB" against "256GB" is a
 * conflict, because both sides have an unclaimed value and they differ.
 *
 * Section 12 in three sentences, and it holds for millimetres and millilitres
 * exactly as it holds for gigabytes.
 */
export function reconcile(
  left: ProductAttribute[],
  right: ProductAttribute[],
): AttributeComparison[] {
  const comparisons: AttributeComparison[] = [];
  const takenRight = new Set<number>();

  const unmatchedLeft: ProductAttribute[] = [];

  for (const attribute of left) {
    const index = right.findIndex(
      (other, position) =>
        !takenRight.has(position) && sameQuantity(attribute.quantity!, other.quantity!),
    );

    if (index === -1) {
      unmatchedLeft.push(attribute);
      continue;
    }

    takenRight.add(index);
    const other = right[index];

    comparisons.push({
      // The labelled side names the agreement: a buyer reads "Storage 512 GB",
      // not "Data 512 GB", and one of the two sides usually knew.
      key: attribute.source === 'label' ? attribute.key : other.key,
      label: attribute.source === 'label' ? attribute.label : other.label,
      // An agreement is worth what the *stronger* side thought it was worth,
      // even when the other side only spelled it inside a dimension group —
      // "50 mm" meeting the 50 in "DN50 x 4000 mm" is a real agreement.
      role: strongestRole(attribute.role, other.role),
      query: formatQuantity(attribute.quantity!),
      candidate: formatQuantity(other.quantity!),
      status: 'match',
    });
  }

  const unmatchedRight = right.filter((_, position) => !takenRight.has(position));

  // Both sides still holding a value of this dimension, and they are not the
  // same value: that is a stated difference, and it ends the conversation.
  const contested = Math.min(unmatchedLeft.length, unmatchedRight.length);

  for (let index = 0; index < contested; index += 1) {
    const mine = unmatchedLeft[index];
    const theirs = unmatchedRight[index];

    // Unless one of them was read out of a dimension group. "3x1.5mm" on a
    // cable states a cross-section, and the two millimetres in it are not a
    // length the shop is claiming — they are how the cross-section is spelled.
    // Left able to refuse, they contradicted every listing that stated a real
    // length, and a cable search returned nothing at all.
    const spelled = mine.source === 'dimension' || theirs.source === 'dimension';

    comparisons.push({
      key: mine.source === 'label' ? mine.key : theirs.key,
      label: mine.source === 'label' ? mine.label : theirs.label,
      role: spelled ? 'descriptive' : strongestRole(mine.role, theirs.role),
      query: formatQuantity(mine.quantity!),
      candidate: formatQuantity(theirs.quantity!),
      status: spelled ? 'missing' : 'conflict',
    });
  }

  // Whatever is left over on one side alone is something that side said and
  // the other did not. Silence, not disagreement.
  for (const attribute of unmatchedLeft.slice(contested)) {
    comparisons.push({
      key: attribute.key,
      label: attribute.label,
      role: attribute.role,
      query: formatQuantity(attribute.quantity!),
      candidate: null,
      status: 'missing',
    });
  }

  for (const attribute of unmatchedRight.slice(contested)) {
    comparisons.push({
      key: attribute.key,
      label: attribute.label,
      role: attribute.role,
      query: null,
      candidate: formatQuantity(attribute.quantity!),
      status: 'missing',
    });
  }

  return comparisons;
}

/**
 * When two sides disagree about how much an attribute matters, the stricter
 * reading wins.
 *
 * One supplier labelling a number as storage and another leaving it bare must
 * not make the comparison weaker than either side thought it was.
 */
function strongestRole(left: AttributeRole, right: AttributeRole): AttributeRole {
  const order: AttributeRole[] = [
    'identity',
    'compatibility',
    'variant',
    'package',
    'commercial',
    'descriptive',
  ];
  return order[Math.min(order.indexOf(left), order.indexOf(right))];
}

/**
 * Whether the candidate says it fits what the buyer asked for.
 *
 * A brake pad listing that names BMW and the F30 platform, sold under a brand
 * that is not BMW, is exactly this: not the article, and quite possibly the
 * purchase. Recognised generically — a maker or a platform code the buyer
 * named, appearing in a listing whose own maker is somebody else.
 */
function fitsWhatWasAsked(
  query: GenericProduct,
  candidate: GenericProduct,
): AttributeComparison | null {
  if (!query.brand || !candidate.brand || query.brand === candidate.brand) return null;

  const mentionsMaker = ` ${candidate.normalised} `.includes(` ${query.brand} `);
  const sharedPlatform = query.identifiers.designators.some((code) =>
    candidate.identifiers.designators.includes(code),
  );

  if (!mentionsMaker || !sharedPlatform) return null;

  return {
    key: 'fits',
    label: 'Fits',
    role: 'compatibility',
    query: `${query.brand} ${query.identifiers.designators.join(' ')}`.trim(),
    candidate: `${query.brand} ${query.identifiers.designators.join(' ')}`.trim(),
    status: 'match',
  };
}
