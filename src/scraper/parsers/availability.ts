/**
 * Whether a shop says it has the thing.
 *
 * The price is half the answer. "95 €, изчерпан" is not an offer — it is the
 * memory of one — and quoting it as the cheapest source sends a buyer to a
 * shop that cannot supply them. That is a worse failure than a missing price,
 * because a missing price looks like missing information and a stale one looks
 * like an answer.
 *
 * The old reading was structured data only: `schema.org/OutOfStock` and
 * nothing else. That covers the shops with the best markup, which are the
 * shops least likely to be the problem. A Bulgarian wholesaler writes
 * "Изчерпан" in a span with no attributes at all, and to the parser that page
 * looked exactly like a shop with full shelves.
 *
 * Two rules shape everything below:
 *
 *   * **Absence is not presence.** A page that says nothing about stock gets
 *     `null`, never `true`. Half the storefronts in this trade only mark the
 *     out-of-stock items, so silence is the normal state of an available
 *     article — and also the normal state of a page we simply failed to read.
 *     Those must stay distinguishable.
 *
 *   * **Unavailable wins.** A product page carries a shelf of related items,
 *     and one of them may well be in stock while the article itself is not.
 *     Where a page says both things, the refusal is the one a buyer needs.
 */

/**
 * Phrases that mean "you cannot buy this today", checked first.
 *
 * Ordered before the positive list on purpose: "неналичен" contains
 * "наличен", "indisponibil" contains "disponibil", and every European language
 * builds its negative out of its positive. Reading the positives first would
 * report a sold-out article as available in exactly the languages this product
 * is sold in.
 *
 * Every pattern is anchored with an explicit "not a letter" lookaround under
 * the `u` flag rather than `\b`. JavaScript's `\b` is defined against `\w`,
 * which is `[A-Za-z0-9_]` and nothing else — so in "изчерпан" every position
 * is a boundary and in "наличен" none of them are. Written with `\b` these
 * patterns silently matched nothing at all in two of the three alphabets this
 * product is sold in.
 */
const UNAVAILABLE: RegExp[] = [
  // Bulgarian
  /изчерпан[аоеия]?(?![\p{L}])/u,
  /разпродаден[аоеия]?(?![\p{L}])/u,
  /продаден[аоеия]?(?![\p{L}])/u,
  /налич\p{L}*\s*[:\-]?\s*0(?![\d])/u,
  /няма\s+(в\s+)?налич/u,
  /без\s+налич/u,
  /не\s*налич(ен|на|но|ни)(?![\p{L}])/u,
  /не\s+е\s+налич/u,
  /времен(но|на)\s+(не)?налич/u,
  /времен(но|на)\s+изчерпан/u,
  /очаква\s*(се)?\s*достав/u,
  /по\s+заявка(?![\p{L}])/u,
  /спрян\s+от\s+производство/u,
  // English
  /out\s*of\s*stock/iu,
  /sold\s*out(?![\p{L}])/iu,
  /(currently|temporarily)\s+unavailable/iu,
  /not\s+available/iu,
  /unavailable(?![\p{L}])/iu,
  /back\s*order(ed)?(?![\p{L}])/iu,
  /discontinued(?![\p{L}])/iu,
  /no\s+longer\s+available/iu,
  // Romanian
  /stoc\s+epuizat/iu,
  /epuizat[ăa]?(?![\p{L}])/iu,
  /indisponibil[ăa]?(?![\p{L}])/iu,
  /nu\s+este\s+(în|in)\s+stoc/iu,
  // Greek
  /εξαντλή(θηκε|μένο)/u,
  /μη\s+διαθέσιμ/u,
  /δεν\s+είναι\s+διαθέσιμ/u,
];

/** Phrases that mean "you can buy this today". */
const AVAILABLE: RegExp[] = [
  // Bulgarian
  /в\s+наличност(?![\p{L}])/u,
  /има\s+наличност(?![\p{L}])/u,
  /налич(ен|на|но|ни)(?![\p{L}])/u,
  /на\s+склад(?![\p{L}])/u,
  /готов\s+за\s+изпращане/u,
  // English
  /in\s*stock(?![\p{L}])/iu,
  /available\s+(now|for\s+(order|delivery))/iu,
  /ready\s+to\s+ship/iu,
  // Romanian
  /(în|in)\s+stoc(?![\p{L}])/iu,
  /disponibil[ăa]?(?![\p{L}])/iu,
  // Greek
  /διαθέσιμ[οαη](?![\p{L}])/u,
  /σε\s+απόθεμα/u,
];

/**
 * What the words say about stock, or null where they say nothing.
 *
 * @param text visible page or tile text. Markup is not understood here —
 * strip it first, or the attribute values will be read as prose.
 */
export function readAvailability(text: string | null | undefined): boolean | null {
  if (!text) return null;

  // Lower-cased and de-spaced so "ИЗЧЕРПАН", "Изчерпан" and a phrase broken
  // across two table cells all read the same. Non-breaking spaces are common
  // in prices and stock labels alike and are not word separators to anybody
  // reading the page.
  const haystack = text
    .toLowerCase()
    .replace(/[    ]/g, ' ')
    .replace(/\s+/g, ' ');

  if (UNAVAILABLE.some((pattern) => pattern.test(haystack))) return false;
  if (AVAILABLE.some((pattern) => pattern.test(haystack))) return true;

  return null;
}

/**
 * The same question asked of a whole page, structured data first.
 *
 * `schema.org` is checked ahead of the prose because it is a claim the shop
 * made deliberately, in a form meant to be read by machines, while the prose
 * is whatever their template happened to render — including, on a product
 * page, the stock labels of six unrelated items in the "you may also like"
 * rail. Where the markup is silent, the words are all there is.
 */
export function availabilityOf(html: string, structured: string | null, text: string): boolean | null {
  if (structured) return !/OutOfStock|SoldOut|Discontinued|PreOrder|BackOrder/i.test(structured);
  if (/schema.org\/(OutOfStock|SoldOut|Discontinued)/i.test(html)) return false;
  if (/schema.org\/(InStock|InStoreOnly|LimitedAvailability)/i.test(html)) return true;

  return readAvailability(text);
}
