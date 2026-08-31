/**
 * Reading a product out of a line of text, without knowing what industry it
 * belongs to.
 *
 * The rule this file obeys is section 30's: no branch anywhere asks what kind
 * of product this is. It asks what the *words* are — is there a unit, is there
 * a label beside it, is this token a colour, is that one a code — and files
 * what it finds under the concept the words named. A pipe, a laptop and a pack
 * of copier paper all go through the same eleven passes, and none of the
 * passes has heard of any of them.
 *
 * The passes run in order of how much they know, and each one blanks out the
 * text it consumed so a later, vaguer pass cannot claim it twice. That
 * ordering is the whole trick: "1920x1080" is a resolution before it is two
 * numbers, "3x2.5" is a cross-section before it is a three, and whatever is
 * still standing at the end is the noun the buyer was actually asking for.
 */

import {
  CODED_SPECS,
  COLOURS,
  ConceptDefinition,
  CONCEPTS,
  DEFAULT_UNITS,
  KNOWN_BRANDS,
  MATERIALS,
  NOISE_WORDS,
  POSITIONS,
  PRODUCT_FAMILIES,
  ROLE_BY_KIND,
  TYPE_SYNONYMS,
} from './lexicon';
import { GenericProduct, ProductAttribute } from './product-model';
import { BASE_UNIT, QuantityKind, UNIT_SPELLINGS, quantityOf, unitCandidates } from './units';
import {
  canonicalIdentifier,
  foldHomoglyphs,
  gtinsOf,
  normaliseBorrowedTerms,
  normaliseProductName,
} from './normalisation';

/**
 * Text as every lookup in this file sees it.
 *
 * Folded, because a Bulgarian supplier writes "Е27" with a Cyrillic Е and a
 * buyer types a Latin one. The lexicons are folded by the same function at
 * module load, so both sides of every comparison have had the same violence
 * done to them — which is the only way folding is safe.
 */
export function fold(text: string): string {
  return foldHomoglyphs(normaliseBorrowedTerms((text || '').toLowerCase()));
}

/** A lexicon, folded once so lookups need not fold on every call. */
function foldedIndex<T>(source: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(source).map(([key, value]) => [fold(key), value]));
}

const FOLDED_COLOURS = foldedIndex(COLOURS);
const FOLDED_MATERIALS = foldedIndex(MATERIALS);
const FOLDED_POSITIONS = foldedIndex(POSITIONS);
const FOLDED_TYPES = foldedIndex(TYPE_SYNONYMS);
const FOLDED_NOISE = new Set([...NOISE_WORDS].map((word) => fold(word)));

/** Label spellings, folded, longest first — so "hard drive" beats "drive". */
const FOLDED_LABELS: Array<{ spelling: string; concept: ConceptDefinition }> = CONCEPTS.flatMap(
  (concept) => concept.labels.map((spelling) => ({ spelling: fold(spelling), concept })),
).sort((a, b) => b.spelling.length - a.spelling.length);

const LABEL_BY_SPELLING = new Map(FOLDED_LABELS.map((entry) => [entry.spelling, entry.concept]));

/** How many words either side of a number may name it. */
const LABEL_WINDOW = 3;

/**
 * Every measurement in the text: a number, then a unit we recognise.
 *
 * The number may not follow a letter. Without that guard "H05V-K" — a cable
 * type every electrical wholesaler prints — reads as five volts, the model
 * code is eaten along with it, and two listings of the same cable stop
 * matching on the one thing that identified them.
 */
const MEASUREMENT = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s*(` +
    UNIT_SPELLINGS.map((spelling) => spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    String.raw`)(?![\p{L}\p{N}])`,
  'giu',
);

/** `3x2.5`, `50 x 4000 mm`, `600x400x300` — and never from inside a part number. */
const DIMENSION_GROUP =
  /(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s*[x×х]\s*(\d+(?:[.,]\d+)?)(?:\s*[x×х]\s*(\d+(?:[.,]\d+)?))?\s*([\p{L}"”²³]{0,4})/giu;

/** `20 x cable` — how many the buyer wants, which is not what the article is. */
const LEADING_QUANTITY = /^\s*(\d{1,4})\s*[x×х]\s+(?=\p{L})/u;

/** `x100`, `x 50` — how many come in the box, which is part of what it is. */
const TRAILING_PACK = /(?:^|[^\p{L}\p{N}])[x×х]\s*(\d{1,5})(?![\p{L}\p{N}])/giu;

export interface InterpretOptions {
  /** The supplier's own article number, when the shop gave us one. */
  sku?: string | null;
  /** Anything else the shop published: a description, a spec table, a URL. */
  context?: string | null;
  /** Attributes the shop published as data rather than as prose. */
  structured?: Record<string, string> | null;
}

/**
 * What a line of text says about a product.
 *
 * Deterministic and free: no network, no model, same answer every time. That
 * matters twice over — the model only ever sees what this could not settle,
 * and a match a customer disputes can be replayed exactly.
 */
export function interpret(text: string, options: InterpretOptions = {}): GenericProduct {
  const raw = text ?? '';
  const attributes: ProductAttribute[] = [];

  // The working copy. Every pass blanks out what it consumed, so the passes
  // that follow see only what nobody has claimed.
  let work = fold(raw);

  // The same text with the Cyrillic left alone, purely so that what is shown
  // back to a reader says "крушка" rather than the folded "kpyшka". Folding is
  // one letter for one letter, so the two strings stay in step and a span
  // found in one can be read out of the other.
  const display = normaliseBorrowedTerms(raw.toLowerCase());
  const shown = (start: number, end: number): string =>
    display.length === work.length ? display.slice(start, end) : work.slice(start, end);

  const consume = (start: number, end: number): void => {
    work = work.slice(0, start) + ' '.repeat(end - start) + work.slice(end);
  };

  const add = (attribute: ProductAttribute): void => {
    // A supplier who writes the same fact twice — "12W … 12 Watt" — has said
    // it once. Repeats of a *different* value are kept: two lengths on a pipe
    // are two facts.
    const already = attributes.some(
      (existing) => existing.key === attribute.key && existing.value === attribute.value,
    );
    if (!already) attributes.push(attribute);
  };

  // --- 1. how many the buyer wants ---------------------------------------
  //
  // Taken out before anything else, because it is the one number in the line
  // that says nothing about the article. "20 x USB cable 2m" is a 2-metre
  // cable, twenty times — and a matcher that read the 20 as a specification
  // would rule out every listing that sells them singly.
  let requestedQuantity: number | null = null;
  const leading = LEADING_QUANTITY.exec(work);
  if (leading) {
    requestedQuantity = Number(leading[1]);
    consume(leading.index, leading.index + leading[0].length);
  }

  // --- 2. barcodes --------------------------------------------------------
  const gtins = gtinsOf(raw);
  for (const gtin of gtins) {
    const index = work.indexOf(gtin.replace(/^0+/, ''));
    if (index >= 0) consume(index, index + gtin.replace(/^0+/, '').length);
  }

  // --- 3. coded specifications -------------------------------------------
  //
  // Sockets, connectors, thread sizes, paper formats, ingress ratings. None of
  // them is a plain number, every one of them decides whether two articles are
  // interchangeable, and they are matched first so that no later pass can read
  // "1920x1080" as a pair of measurements.
  for (const spec of CODED_SPECS) {
    const pattern = new RegExp(spec.pattern.source, spec.pattern.flags.replace('g', '') + 'g');
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(work)) !== null) {
      const written = canonicalIdentifier(match[0]).toUpperCase();
      if (!written) continue;

      // "Type-C" becomes "USB-C" here, once, rather than in every comparison
      // that might meet one of the two spellings.
      const value = spec.aliases?.[written] ?? written;

      add({
        key: spec.key,
        label: spec.label,
        role: spec.role,
        kind: null,
        quantity: null,
        raw: match[0].trim(),
        value,
        source: 'pattern',
      });

      // A thread states two lengths as well as a fitting: M8x50 is an 8 mm
      // bolt 50 mm long. Reading them out is what lets a query written as
      // "M8 50mm" meet a listing written as "M8x50".
      const thread = /^m(\d{1,3})(?:\s*[x×х]\s*(\d+(?:[.,]\d+)?))?$/i.exec(
        match[0].replace(/\s+/g, ''),
      );
      if (spec.key === 'thread' && thread) {
        pushQuantity(add, 'diameter', Number(thread[1]), 'mm', match[0], 'pattern');
        if (thread[2]) {
          pushQuantity(
            add,
            'length',
            Number(thread[2].replace(',', '.')),
            'mm',
            match[0],
            'pattern',
          );
        }
      }

      consume(match.index, match.index + match[0].length);
      pattern.lastIndex = match.index;
    }
  }

  // --- 4. dimension groups ------------------------------------------------
  //
  // "3x2.5" is a cable's cores and cross-section, "600x400x300" is a box, and
  // "50 x 4000 mm" is a pipe. What they have in common is the only thing this
  // pass needs to know: the numbers belong together, and reading them apart
  // loses the fact that they do.
  //
  // Two rules earned the hard way, both from live catalogue data:
  //
  //  * **The value carries no unit.** One shop writes "3x1.5", the next
  //    "3x1.5mm", the third "3x1.5 мм²". They are one cable. Keeping the unit
  //    in the value made those three different articles and blocked the match
  //    on a conflict that existed only in punctuation.
  //
  //  * **The unit must be a dimension.** "1x24W" is not a size — it is one
  //    panel of twenty-four watts. Read as a group it invented a length, a
  //    power of 1 W and a filter nobody could use.
  {
    let match: RegExpExecArray | null;
    DIMENSION_GROUP.lastIndex = 0;

    while ((match = DIMENSION_GROUP.exec(work)) !== null) {
      const parts = [match[1], match[2], match[3]]
        .filter(Boolean)
        .map((part) => Number(part.replace(',', '.')));
      const trailing = (match[4] ?? '').trim();
      const unit = trailing ? unitCandidates(trailing)[0] : null;

      // A unit that measures something other than space means these numbers
      // were never a size. "1 x 24 W" is a count and a rating; the count is
      // taken here and the rating is left for the measurement pass to read.
      if (unit && unit.kind !== 'length' && unit.kind !== 'area') {
        if (parts.length === 2) {
          const quantity = quantityOf(parts[0], 'pcs', 'count');
          if (quantity && parts[0] >= 1) {
            add({
              key: 'package_quantity',
              label: 'Pack size',
              role: 'package',
              kind: 'count',
              quantity,
              raw: match[0].trim(),
              value: `${trim(parts[0])}pcs`,
              source: 'pattern',
            });
          }

          // Only the count and the "x" are consumed; the measurement itself
          // stays on the page for the next pass.
          const consumedTo = match.index + match[0].indexOf(match[2]);
          consume(match.index, consumedTo);
          DIMENSION_GROUP.lastIndex = match.index;
          continue;
        }

        DIMENSION_GROUP.lastIndex = match.index + match[0].length;
        continue;
      }

      add({
        key: parts.length === 2 ? 'cross_section' : 'dimensions',
        label: parts.length === 2 ? 'Cross-section' : 'Dimensions',
        role: 'identity',
        kind: null,
        quantity: null,
        raw: match[0].trim(),
        // No unit. See above: the unit is how a shop spells it, not what it is.
        value: parts
          .map((part) => trim(part))
          .join('X')
          .toUpperCase(),
        source: 'dimension',
      });

      // With a unit stated, each part is also a measurement — but a quiet one.
      // It is what lets "PVC-U DN50 x 4000 mm" meet "PVC pipe 50mm 4m", and it
      // must never be able to *refuse* a match: a cable's "3x1.5mm" would
      // otherwise contradict every listing that states a real length.
      if (unit) {
        for (const part of parts) {
          const quantity = quantityOf(part, trailing, unit.kind);
          if (!quantity) continue;

          add({
            key: quantity.kind,
            label: titleOf(quantity.kind),
            role: 'descriptive',
            kind: quantity.kind,
            quantity,
            raw: match[0].trim(),
            value: `${trim(quantity.value)}${quantity.unit}`,
            source: 'dimension',
          });
        }
      }

      consume(match.index, match.index + match[0].length);
      DIMENSION_GROUP.lastIndex = match.index;
    }
  }

  // --- 5. measurements, and the words that name them ----------------------
  {
    let match: RegExpExecArray | null;
    MEASUREMENT.lastIndex = 0;
    const spans: Array<{ start: number; end: number }> = [];

    while ((match = MEASUREMENT.exec(work)) !== null) {
      const value = Number(match[1].replace(',', '.'));
      const spelling = match[2];

      // What the number is about, if any word near it says so. The nearest
      // label wins, and a label found is consumed with the number — otherwise
      // "RAM" would go on to be considered as the product's name.
      const named = labelNear(work, match.index, match.index + match[0].length);
      const concept = named?.concept ?? null;

      const quantity = quantityOf(value, spelling, concept?.kind ?? null);
      if (!quantity) continue;

      const key = concept
        ? concept.key
        : quantity.kind === 'count'
          ? 'package_quantity'
          : quantity.kind;

      add({
        key,
        label: concept?.label ?? titleOf(quantity.kind),
        role: concept?.role ?? ROLE_BY_KIND[quantity.kind],
        kind: quantity.kind,
        quantity,
        raw: match[0].trim(),
        value: `${trim(quantity.value)}${quantity.unit}`,
        source: concept ? 'label' : 'unit',
      });

      spans.push({ start: match.index, end: match.index + match[0].length });
      if (named) spans.push({ start: named.start, end: named.end });
    }

    for (const span of spans) consume(span.start, span.end);
  }

  // --- 6. numbers whose unit everybody in the trade leaves out -------------
  //
  // "512 SSD", "DN50", "80 gsm", "pack of 100". The unit is missing because
  // within a trade it is obvious, and filling it in is a property of the
  // concept rather than of any product — which is why it costs no rule about
  // laptops or about pipes.
  for (const [key, defaultUnit] of Object.entries(DEFAULT_UNITS)) {
    const concept = CONCEPTS.find((entry) => entry.key === key);
    if (!concept) continue;

    for (const spelling of concept.labels.map(fold)) {
      const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [
        new RegExp(
          `(?<![\\p{L}\\p{N}])${escaped}\\s*[:\\-]?\\s*(\\d+(?:[.,]\\d+)?)(?![\\p{L}\\p{N}])`,
          'giu',
        ),
        new RegExp(`(?<![\\p{L}\\p{N}])(\\d+(?:[.,]\\d+)?)\\s*${escaped}(?![\\p{L}\\p{N}])`, 'giu'),
      ];

      for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(work)) !== null) {
          const value = Number(match[1].replace(',', '.'));
          const quantity = quantityOf(value, defaultUnit, concept.kind);
          if (!quantity) continue;

          add({
            key: concept.key,
            label: concept.label,
            role: concept.role,
            kind: quantity.kind,
            quantity,
            raw: match[0].trim(),
            value: `${trim(quantity.value)}${quantity.unit}`,
            source: 'label',
          });

          consume(match.index, match.index + match[0].length);
          pattern.lastIndex = match.index;
        }
      }
    }
  }

  // --- 7. what comes in the box -------------------------------------------
  {
    let match: RegExpExecArray | null;
    TRAILING_PACK.lastIndex = 0;

    while ((match = TRAILING_PACK.exec(work)) !== null) {
      const quantity = quantityOf(Number(match[1]), 'pcs', 'count');
      if (!quantity) continue;

      add({
        key: 'package_quantity',
        label: 'Pack size',
        role: 'package',
        kind: 'count',
        quantity,
        raw: match[0].trim(),
        value: `${trim(quantity.value)}pcs`,
        source: 'pattern',
      });

      consume(match.index, match.index + match[0].length);
      TRAILING_PACK.lastIndex = match.index;
    }
  }

  // --- 8. vocabulary: colour, material, where it goes ----------------------
  const words = tokenise(work);
  const usedWords = new Set<number>();

  words.forEach((word, index) => {
    const classes: Array<[Map<string, string>, string, string, ProductAttribute['role']]> = [
      [FOLDED_COLOURS, 'colour', 'Colour', 'variant'],
      [FOLDED_MATERIALS, 'material', 'Material', 'variant'],
      [FOLDED_POSITIONS, 'position', 'Position', 'compatibility'],
    ];

    // A word that names a kind of product is a kind of product first. "Paper"
    // is in the materials table because a cup can be made of it, and reading
    // "copy paper A4" as a material left the type as "copy".
    if (FOLDED_TYPES.has(word.text) || FOLDED_TYPES.has(stem(word.text))) return;

    for (const [lexicon, key, label, role] of classes) {
      const value = lexicon.get(word.text) ?? lexicon.get(stem(word.text));
      if (!value) continue;

      add({
        key,
        label,
        role,
        kind: null,
        quantity: null,
        raw: word.text,
        value,
        source: 'word',
      });
      usedWords.add(index);
      return;
    }
  });

  // --- 9. codes that identify rather than describe -------------------------
  const modelCodes: string[] = [];
  const designators: string[] = [];

  words.forEach((word, index) => {
    if (usedWords.has(index)) return;

    const cleaned = word.text.replace(/^-+|-+$/g, '');
    if (!/[a-z]/.test(cleaned) || !/\d/.test(cleaned)) return;

    if (cleaned.length >= 4) {
      modelCodes.push(cleaned.toUpperCase());
      usedWords.add(index);
    } else if (cleaned.length >= 2) {
      // "F30", "i5", "S24" — too short to be sure of, and far too useful to
      // throw away. Kept apart from the model codes so that agreeing on one is
      // supporting evidence rather than proof.
      designators.push(cleaned.toUpperCase());
      usedWords.add(index);
    }
  });

  // --- 9b. the range, where people name the range instead of the maker ------
  //
  // "iPhone 15" and "Galaxy S24" are how buyers and shops both write these, and
  // the manufacturer often appears nowhere. Joined to the number beside it, the
  // range becomes the closest thing such a listing has to a model code — which
  // is what lets a 128 GB and a 256 GB iPhone 15 be recognised as one family
  // rather than as two unrelated phones.
  let family: string | null = null;
  const foldedFamilies = PRODUCT_FAMILIES.map(fold);

  words.forEach((word, index) => {
    if (family || !foldedFamilies.includes(word.text)) return;

    const next = words[index + 1];
    const numbered =
      next && /^\d{1,4}[a-z]?$/.test(next.text) ? `${word.text} ${next.text}` : word.text;

    family = numbered;
    usedWords.add(index);
    if (numbered !== word.text) usedWords.add(index + 1);
    modelCodes.push(numbered.replace(/\s+/g, '').toUpperCase());
  });

  // --- 10. who made it -----------------------------------------------------
  const spaced = ` ${words.map((word) => word.text).join(' ')} `;
  const brand =
    [...KNOWN_BRANDS]
      .sort((a, b) => b.length - a.length)
      .map(fold)
      .find((candidate) => spaced.includes(` ${candidate} `)) ?? null;

  if (brand) {
    words.forEach((word, index) => {
      if (word.text === brand) usedWords.add(index);
    });
  }

  // --- 11. what kind of thing it is ---------------------------------------
  const remaining = words
    .map((word, index) => ({ ...word, index }))
    .filter((word) => !usedWords.has(word.index))
    .filter((word) => word.text.length >= 2)
    .filter((word) => !FOLDED_NOISE.has(word.text))
    .filter((word) => !PRODUCT_FAMILIES.map(fold).includes(word.text))
    .filter((word) => !LABEL_BY_SPELLING.has(word.text));

  const typed = typeOf(remaining, shown);
  const productType = typed
    ? { raw: typed.raw, canonical: typed.canonical, known: typed.known }
    : null;

  // A word sitting where a brand sits, for widening a supplier search. Never
  // compared: an unlisted word that merely looks like a brand is not evidence.
  const brandGuess =
    brand === null && remaining.length > 1 && remaining[0].start !== typed?.start
      ? remaining[0].text
      : null;

  // --- what the shop told us outright --------------------------------------
  if (options.structured) {
    for (const [name, value] of Object.entries(options.structured)) {
      if (!value) continue;
      const concept = LABEL_BY_SPELLING.get(fold(name));

      add({
        key: concept?.key ?? fold(name).replace(/[^a-z0-9_]+/g, '_'),
        label: concept?.label ?? name,
        role: concept?.role ?? 'descriptive',
        kind: concept?.kind ?? null,
        quantity: null,
        raw: value,
        value: fold(value).trim(),
        source: 'structured',
      });
    }
  }

  const sku = options.sku ? canonicalIdentifier(options.sku).toUpperCase() || null : null;

  return {
    raw,
    normalised: normaliseProductName(raw),
    productType,
    brand,
    brandGuess,
    identifiers: {
      gtins,
      sku,
      modelCodes: [...new Set(modelCodes)],
      designators: [...new Set(designators)],
      family,
    },
    attributes,
    requestedQuantity,
    tokens: remaining.map((word) => word.text),
  };
}

/**
 * The concept named by a word next to a number, if any word next to it is one.
 *
 * Looks both ways and takes the nearest, because suppliers write it both ways:
 * "RAM 16GB" and "16GB RAM" are the same claim. Multi-word labels are tried
 * longest first so "colour temperature" is not read as a temperature.
 */
function labelNear(
  text: string,
  start: number,
  end: number,
): { concept: ConceptDefinition; start: number; end: number } | null {
  const before = tokensBefore(text, start, LABEL_WINDOW);
  const after = tokensAfter(text, end, LABEL_WINDOW);

  // Nearest first, and on each side try the longest phrase that still touches
  // the number: "hard drive 512" must not be read as "drive".
  for (let width = 1; width <= LABEL_WINDOW; width += 1) {
    for (const side of [after, before]) {
      const window = side === after ? side.slice(0, width) : side.slice(-width);
      if (window.length < width) continue;

      const phrase = window.map((token) => token.text).join(' ');
      const concept = LABEL_BY_SPELLING.get(phrase);
      if (!concept) continue;

      return { concept, start: window[0].start, end: window[window.length - 1].end };
    }
  }

  return null;
}

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{L}\p{N}][\p{L}\p{N}+._/-]*/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }

  return tokens;
}

function tokensBefore(text: string, position: number, count: number): Token[] {
  return tokenise(text.slice(0, position)).slice(-count);
}

function tokensAfter(text: string, position: number, count: number): Token[] {
  return tokenise(text.slice(position))
    .slice(0, count)
    .map((token) => ({
      text: token.text,
      start: token.start + position,
      end: token.end + position,
    }));
}

/**
 * The noun the buyer was asking for.
 *
 * A known cross-lingual name wins, so a Bulgarian "крушка" and a German
 * "Lampe" are one kind of thing. Where no word is known — which is the normal
 * case for an industry nobody has written a row for — the first surviving word
 * is used as it stands. That is not a fallback so much as the design: an
 * unrecognised type still compares against itself perfectly well, and two
 * unrecognised types disagreeing is a doubt rather than a verdict.
 */
function typeOf(
  words: Token[],
  shown: (start: number, end: number) => string,
): { raw: string; canonical: string; known: boolean; start: number } | null {
  for (let index = 0; index < words.length - 1; index += 1) {
    const pair = `${words[index].text} ${words[index + 1].text}`;
    const canonical = FOLDED_TYPES.get(pair) ?? FOLDED_TYPES.get(stem(pair));
    if (canonical) {
      return {
        raw: shown(words[index].start, words[index + 1].end),
        canonical,
        known: true,
        start: words[index].start,
      };
    }
  }

  for (const word of words) {
    const canonical = FOLDED_TYPES.get(word.text) ?? FOLDED_TYPES.get(stem(word.text));
    if (canonical) {
      return { raw: shown(word.start, word.end), canonical, known: true, start: word.start };
    }
  }

  // Nothing in the table recognised it, which is the normal case for an
  // industry nobody has written a row for. The word stands for itself: it
  // still matches another listing that uses the same word, and two words
  // nobody knows disagreeing is a silence rather than a contradiction.
  const head = words.find((word) => word.text.length >= 3 && !/\d/.test(word.text));
  return head
    ? {
        raw: shown(head.start, head.end),
        canonical: stem(head.text),
        known: false,
        start: head.start,
      }
    : null;
}

/**
 * Singular and plural, folded together.
 *
 * Crude on purpose, and symmetric: both sides of every comparison go through
 * it, so an over-eager trim that turns "gas" into "ga" does so on both sides
 * and costs nothing. A real stemmer would need a language, and the language is
 * exactly what is not known here.
 */
export function stem(word: string): string {
  let out = word;
  if (out.length > 4 && /(ies)$/.test(out)) return `${out.slice(0, -3)}y`;
  if (out.length > 4 && /(ses|xes|ches|shes)$/.test(out)) return out.slice(0, -2);
  if (out.length > 3 && /s$/.test(out) && !/ss$/.test(out)) out = out.slice(0, -1);
  if (out.length > 4 && /(ove|ata|ite|ове)$/.test(out)) out = out.slice(0, -3);
  if (out.length > 3 && /[иаяе]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function pushQuantity(
  add: (attribute: ProductAttribute) => void,
  key: string,
  value: number,
  spelling: string,
  raw: string,
  source: ProductAttribute['source'],
): void {
  const concept = CONCEPTS.find((entry) => entry.key === key);
  const quantity = quantityOf(value, spelling, concept?.kind ?? null);
  if (!quantity) return;

  add({
    key: concept ? concept.key : quantity.kind,
    label: concept?.label ?? titleOf(quantity.kind),
    role: concept?.role ?? ROLE_BY_KIND[quantity.kind],
    kind: quantity.kind,
    quantity,
    raw,
    value: `${trim(quantity.value)}${quantity.unit}`,
    source,
  });
}

/** A dimension's name, for an attribute nobody labelled. */
function titleOf(kind: QuantityKind): string {
  const words = kind.replace(/_/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${BASE_UNIT[kind]})`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
