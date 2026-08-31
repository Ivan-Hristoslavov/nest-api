/**
 * One shape for every product, in every industry.
 *
 * The old extraction had a fixed set of fields and a closed list of eight
 * categories, which meant a plumber's pipe and an office manager's paper both
 * arrived as "category: null, measurements: [ … ]" — a pile of anonymous
 * numbers with no idea what any of them measured.
 *
 * What replaces it is deliberately unopinionated: a type, whatever identifiers
 * exist, and a **dynamic** bag of attributes. Nothing declares in advance that
 * a laptop has memory or that a pipe has a diameter. The attributes are
 * whatever the text turned out to say, keyed by concept where a concept was
 * recognised and by dimension where it was not.
 */

import { AttributeRole } from './lexicon';
import { Quantity, QuantityKind, formatQuantity } from './units';

/** How an attribute came to be known, kept so the debugger can show its work. */
export type AttributeSource =
  /** A word beside the number named it: "16 GB RAM". */
  | 'label'
  /** Only the unit was there: "65W". Filed by dimension. */
  | 'unit'
  /** A coded specification matched: E27, IP44, A4. */
  | 'pattern'
  /** A vocabulary word: a colour, a material, a position. */
  | 'word'
  /** A dimension group: 3x2.5, 600x400x300. */
  | 'dimension'
  /** Supplied by the shop rather than read from a name. */
  | 'structured';

/** One thing a listing says about the article. */
export interface ProductAttribute {
  /** The concept, or the dimension where no concept was named. */
  key: string;
  label: string;
  role: AttributeRole;
  /** The dimension, when the value is a measurement. */
  kind: QuantityKind | null;
  /** The measurement, when there is one. */
  quantity: Quantity | null;
  /** The value as the supplier wrote it. */
  raw: string;
  /** The value reduced to something two suppliers can be compared on. */
  value: string;
  source: AttributeSource;
}

/** What a listing — or a query — was understood to be. */
export interface GenericProduct {
  /** The text as it arrived. */
  raw: string;
  /** Lower-cased, punctuation-free, homoglyphs folded, units canonicalised. */
  normalised: string;
  /**
   * What kind of thing this is, as written and — where the word is one we
   * know in more than one language — canonically.
   */
  productType: {
    raw: string;
    canonical: string;
    /**
     * True when the word was recognised across languages.
     *
     * Two *known* types disagreeing is a different article. Two unknown ones
     * disagreeing is nothing at all — which is what keeps the engine honest in
     * an industry it has never seen.
     */
    known: boolean;
  } | null;
  /** A manufacturer we are sure of. Never a guess; see {@link brandGuess}. */
  brand: string | null;
  /**
   * A word that sits where a brand usually sits.
   *
   * Used to widen a supplier search and shown in the debugger, never compared:
   * an unlisted word that merely *looks* like a brand is not evidence, and
   * treating it as one rejects matches for a conflict nobody stated.
   */
  brandGuess: string | null;
  identifiers: {
    /** Checksum-valid barcodes. */
    gtins: string[];
    /** The supplier's own article number, when they gave us one. */
    sku: string | null;
    /** Codes that identify rather than describe: H05V-K, ST9453B. */
    modelCodes: string[];
    /** Short alphanumerics that name a range or platform: F30, i5, S24. */
    designators: string[];
    /**
     * The range this belongs to, where the range is a name people use instead
     * of the maker: iPhone, ThinkPad, Galaxy.
     *
     * Kept apart from the brand because it is not one. It is what makes
     * `same_family` decidable: two listings sharing "iphone 15" and
     * disagreeing about storage are the same product line, not two unrelated
     * phones and not the same article.
     */
    family: string | null;
  };
  attributes: ProductAttribute[];
  /** How many the buyer wants — never part of what the article *is*. */
  requestedQuantity: number | null;
  /** Words left over once everything above was taken out. */
  tokens: string[];
}

/** The attributes of one concept, in the order they were found. */
export function attributesOf(product: GenericProduct, key: string): ProductAttribute[] {
  return product.attributes.filter((attribute) => attribute.key === key);
}

/** Every attribute of one dimension, whatever concept it was filed under. */
export function attributesOfKind(product: GenericProduct, kind: QuantityKind): ProductAttribute[] {
  return product.attributes.filter((attribute) => attribute.kind === kind);
}

/**
 * The dynamic attribute map section 4 describes, for an API response.
 *
 * A map rather than the internal list because that is the shape a client wants
 * — `attributes.ram.value` — and repeated attributes of one concept are rare
 * enough that keeping the first is the right trade for a payload.
 */
export function attributeMap(product: GenericProduct): Record<
  string,
  {
    value: string;
    unit?: string;
    normalizedValue?: number;
    normalizedUnit?: string;
    role: AttributeRole;
    label: string;
  }
> {
  const map: Record<
    string,
    {
      value: string;
      unit?: string;
      normalizedValue?: number;
      normalizedUnit?: string;
      role: AttributeRole;
      label: string;
    }
  > = {};

  for (const attribute of product.attributes) {
    // Repeats of one concept are numbered rather than dropped: a listing that
    // states two lengths has said two things, and a client showing one of them
    // would be showing half the article.
    let key = attribute.key;
    for (let index = 2; key in map; index += 1) key = `${attribute.key}_${index}`;

    map[key] = attribute.quantity
      ? {
          value: formatQuantity(attribute.quantity),
          unit: attribute.quantity.unit,
          normalizedValue: attribute.quantity.base,
          normalizedUnit: attribute.quantity.kind,
          role: attribute.role,
          label: attribute.label,
        }
      : { value: attribute.value, role: attribute.role, label: attribute.label };
  }

  return map;
}

/**
 * How two listings stand to each other.
 *
 * A boolean cannot carry this. "Is it the same?" has at least six useful
 * answers in a wholesale catalogue, and collapsing them loses exactly the
 * distinctions a buyer needs: a compatible part is not the same article but is
 * often the right purchase, and a same-family listing is the one to show when
 * the exact variant is out of stock.
 */
export type ProductRelation =
  /** Same purchasable article. */
  | 'same_product'
  /** Same product line, different variant: iPhone 15 128GB against 256GB. */
  | 'same_family'
  /** Same kind of thing from a different maker: two generic screws. */
  | 'same_type'
  /** Not the same article, but stated to fit what was asked for. */
  | 'compatible'
  /** Not enough stated either way. */
  | 'possible'
  /** Something identifying is stated differently on each side. */
  | 'conflict'
  /** Nothing in common worth reporting. */
  | 'unrelated';

/** Where a relation sits when results are grouped for a reader. */
export function relationGroup(
  relation: ProductRelation,
  confidence: number,
): 'strong' | 'possible' | 'similar' | 'excluded' {
  if (relation === 'conflict') return 'excluded';
  if (relation === 'unrelated') return 'excluded';
  if (relation === 'same_product' && confidence >= 0.85) return 'strong';
  if (relation === 'same_product' || relation === 'compatible' || relation === 'possible') {
    return 'possible';
  }
  return 'similar';
}
