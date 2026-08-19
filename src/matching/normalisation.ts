/**
 * Turning what a shop wrote into something two shops can be compared on.
 *
 * Suppliers describe one article four ways — "PHILIPS LED BULB 12W E27 4000K",
 * "Philips CorePro LED 12W 840 E27", "LED Е27 Philips 12 вата неутрална".
 * Everything in this file is deterministic: no model is called, no network is
 * touched, and the same input always produces the same output. That matters
 * for cost (most pairs never need a model) and for trust (a match a customer
 * disputes can be replayed exactly).
 */

/**
 * Cyrillic letters that look Latin, folded onto their twins.
 *
 * Shops write "Е27" in Cyrillic about half the time and buyers type "E27" in
 * Latin. The two strings differ in every byte and mean the same socket.
 */
const HOMOGLYPH_FROM = 'аеорсухкмтвнАЕОРСУХКМТВН';
const HOMOGLYPH_TO = 'aeopcyxkmtbhAEOPCYXKMTBH';

export function foldHomoglyphs(text: string): string {
  let out = '';
  for (const letter of text) {
    const index = HOMOGLYPH_FROM.indexOf(letter);
    out += index === -1 ? letter : HOMOGLYPH_TO[index];
  }
  return out;
}

/**
 * Unit spellings that mean the same measurement.
 *
 * Keyed by the *normalised* form so the table is also the answer. Multilingual
 * on purpose: a Bulgarian supplier writes "вата", a German one "Watt", and the
 * buyer may have typed either.
 */
const UNIT_ALIASES: Record<string, string> = {
  w: 'W',
  watt: 'W',
  watts: 'W',
  wt: 'W',
  вт: 'W',
  ват: 'W',
  вата: 'W',
  ватa: 'W',
  k: 'K',
  kelvin: 'K',
  келвин: 'K',
  v: 'V',
  volt: 'V',
  volts: 'V',
  в: 'V',
  волта: 'V',
  a: 'A',
  amp: 'A',
  amps: 'A',
  ampere: 'A',
  lm: 'LM',
  lumen: 'LM',
  lumens: 'LM',
  лумена: 'LM',
  m: 'M',
  meter: 'M',
  meters: 'M',
  metre: 'M',
  metres: 'M',
  метра: 'M',
  метър: 'M',
  mm: 'MM',
  мм: 'MM',
  cm: 'CM',
  см: 'CM',
  gb: 'GB',
  гб: 'GB',
  tb: 'TB',
  тб: 'TB',
  mb: 'MB',
  ghz: 'GHZ',
  mhz: 'MHZ',
  hz: 'HZ',
  kg: 'KG',
  кг: 'KG',
  g: 'G',
  inch: 'IN',
  inches: 'IN',
  '"': 'IN',
  '”': 'IN',
  '″': 'IN',
  цол: 'IN',
  цола: 'IN',
  zoll: 'IN',
};

/**
 * A number with a unit, as it appears anywhere in a product name.
 *
 * `12W`, `12 W`, `12 watt`, `12вата`, `4000 K`, `55"`, `1.5m`, `128 GB`.
 * Decimal commas are the European norm and are read as decimal points.
 */
const MEASUREMENT = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s*(` +
    Object.keys(UNIT_ALIASES)
      .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length)
      .join('|') +
    String.raw`)(?![a-zа-я0-9])`,
  'giu',
);

/** One measurement lifted out of a name. */
export interface Measurement {
  value: number;
  unit: string;
}

/**
 * Lowercase, single-spaced, punctuation-free, homoglyph-folded.
 *
 * The base every other comparison is built on. Deliberately keeps digits and
 * letters glued where the source glued them ("h05v-k" → "h05v k") rather than
 * inventing token boundaries inside model codes.
 */
export function normaliseText(raw: string): string {
  return foldHomoglyphs(raw || '')
    .toLowerCase()
    .replace(/[«»"'`´’‚„()[\]{}]/g, ' ')
    .replace(/[.,;:!?/\\|+]/g, ' ')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The canonical spelling of every measurement in a name.
 *
 * "12 watt" and "12W" both become "12W", so a comparison of two supplier names
 * does not depend on which spelling each chose. Values keep at most two
 * decimals: "1.50m" and "1.5 m" are the same length.
 */
export function normaliseUnits(raw: string): string {
  // Units are canonicalised *before* homoglyph folding, not after: folding
  // turns the Cyrillic "вата" into "bata", which matches no unit at all. The
  // fold is for letters that look Latin (Е27), and it runs later.
  return (raw || '').replace(MEASUREMENT, (_match, value: string, unit: string) => {
    const canonical = UNIT_ALIASES[unit.toLowerCase()];
    if (!canonical) return _match;
    return `${formatNumber(Number(value.replace(',', '.')))}${canonical}`;
  });
}

/** Every measurement in a name, canonicalised. */
export function measurementsOf(raw: string): Measurement[] {
  const found: Measurement[] = [];
  const text = raw || '';

  for (const match of text.matchAll(MEASUREMENT)) {
    const unit = UNIT_ALIASES[match[2].toLowerCase()];
    if (!unit) continue;
    found.push({ value: Number(match[1].replace(',', '.')), unit });
  }

  return found;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * The full normal form of a product name: canonical units, no punctuation,
 * no filler, tokens in the order the supplier wrote them.
 */
export function normaliseProductName(raw: string): string {
  return normaliseText(normaliseUnits(raw));
}

/**
 * Words that carry no identity, in the languages these catalogues use.
 *
 * Dropped before comparison so "LED крушка Philips" and "Philips LED bulb"
 * are not held apart by the noun for "bulb" being in different languages —
 * the specification is what identifies the article, and the specification is
 * written in digits everywhere.
 */
const STOP_WORDS = new Set([
  // English
  'the',
  'and',
  'with',
  'for',
  'of',
  'pcs',
  'pc',
  'piece',
  'pieces',
  'new',
  'set',
  // Bulgarian
  'и',
  'за',
  'с',
  'от',
  'на',
  'бр',
  'брой',
  'броя',
  'нов',
  'нова',
  'ново',
  'комплект',
  // German
  'und',
  'mit',
  'für',
  'stück',
  'neu',
  // French
  'et',
  'avec',
  'pour',
  'pièce',
  'pièces',
  'neuf',
]);

/** The tokens worth comparing: normalised, deduplicated, filler removed. */
export function tokensOf(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const token of normaliseProductName(raw).split(/[\s-]+/)) {
    if (!token || token.length < 2) continue;
    if (STOP_WORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }

  return out;
}

/**
 * Overlap between two names, weighted towards the rare tokens.
 *
 * Plain Jaccard treats "led" — which every bulb in the catalogue carries — as
 * evidence, and treats "e27" as no more telling. Tokens containing a digit are
 * weighted higher because in this domain they are the specification, which is
 * exactly what distinguishes two articles that share every word.
 */
export function similarity(left: string, right: string): number {
  const a = new Set(tokensOf(left));
  const b = new Set(tokensOf(right));

  if (a.size === 0 || b.size === 0) return 0;

  const weight = (token: string): number => (/\d/.test(token) ? 2.5 : 1);

  let shared = 0;
  let total = 0;

  for (const token of new Set([...a, ...b])) {
    const w = weight(token);
    total += w;
    if (a.has(token) && b.has(token)) shared += w;
  }

  return total === 0 ? 0 : Math.round((shared / total) * 1000) / 1000;
}

/**
 * A code that identifies an article rather than describing it.
 *
 * `H05V-K`, `ST9453B`, `CorePro840`. Letters and digits together, long enough
 * not to be a size, and not itself a measurement — "3x2.5mm2" is a
 * cross-section every supplier of that gauge prints, so treating it as an
 * identity would split one comparable group into one group per size.
 */
export function modelCodesOf(raw: string): string[] {
  const codes: string[] = [];

  for (const token of normaliseText(raw).split(/[\s]+/)) {
    const cleaned = token.replace(/^-+|-+$/g, '');
    if (cleaned.length < 4) continue;
    if (!/[a-z]/.test(cleaned) || !/\d/.test(cleaned)) continue;
    if (isMeasurementToken(cleaned)) continue;
    codes.push(cleaned.toUpperCase());
  }

  return [...new Set(codes)];
}

/** True for a token that states a size rather than names an article. */
export function isMeasurementToken(token: string): boolean {
  return /^\d+(?:[.,]\d+)?(?:[xх]\d+(?:[.,]\d+)?)*\s*(mm2|мм2|mm|мм|cm|см|m|м|w|wt|v|a|k|lm|gb|tb|in|kg|g|hz|ghz|mhz)?$/i.test(
    token,
  );
}

/**
 * An EAN-13, EAN-8, UPC-A or GTIN-14 found in text, checksum verified.
 *
 * The checksum is the point: any 13-digit run would otherwise be read as a
 * barcode, and these names are full of 13-digit runs that are order numbers.
 * A wrong barcode is the worst possible match key, because it is trusted
 * absolutely and skips every other check.
 */
export function gtinsOf(raw: string): string[] {
  const found: string[] = [];

  for (const match of (raw || '').matchAll(/\b\d{8,14}\b/g)) {
    const digits = match[0];
    if (![8, 12, 13, 14].includes(digits.length)) continue;
    if (isValidGtin(digits)) found.push(digits.padStart(14, '0'));
  }

  return [...new Set(found)];
}

/** GS1 mod-10 check digit. */
export function isValidGtin(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;

  const body = digits.slice(0, -1).split('').reverse();
  const check = Number(digits.slice(-1));

  const sum = body.reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1),
    0,
  );

  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Compares two part numbers as a human would read them off a box.
 *
 * `ST-9453/B`, `st9453b` and `ST 9453 B` are one part number written by three
 * people. Punctuation and case carry no meaning in a part number, so both
 * sides are reduced to their alphanumerics before comparison.
 */
export function sameIdentifier(left: string | null | undefined, right: string | null | undefined) {
  const a = canonicalIdentifier(left);
  const b = canonicalIdentifier(right);
  return a !== '' && a === b;
}

export function canonicalIdentifier(value: string | null | undefined): string {
  return foldHomoglyphs(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
