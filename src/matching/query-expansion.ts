/**
 * Asking a supplier's own search engine a question it can answer.
 *
 * A buyer types "PVC pipe 50mm 4m". A supplier's search box, given that
 * verbatim, matches nothing at all — its catalogue says "PVC-U DN50 x 4000mm",
 * and its search is a `LIKE` over the title. The comparison then reports that
 * nobody stocks the item, which is the single most expensive wrong answer this
 * product can give: the buyer goes and orders it somewhere else.
 *
 * So the query is widened — but only just, and only when it has to be. Section
 * 31 is not negotiable: one request per supplier per question is what makes
 * the economics work, and a fan-out of eight spellings across six suppliers is
 * forty-eight requests to answer one question. What happens instead is that
 * the original is asked first and a *single* fallback is asked only of the
 * suppliers that came back empty-handed.
 */

import { GenericProduct } from './product-model';
import { formatQuantity } from './units';

export interface QueryVariant {
  query: string;
  kind: 'original' | 'identifier' | 'spelling' | 'canonical' | 'broad';
  /** Why this spelling exists, for the debugger and for the operator screen. */
  reason: string;
}

/**
 * The spellings worth trying, best first.
 *
 * The original is always index 0 and is always what runs. Everything after it
 * is a fallback, and at most one of them will ever be asked.
 */
export function expandQuery(raw: string, product: GenericProduct, limit = 4): QueryVariant[] {
  const variants: QueryVariant[] = [
    { query: raw.trim(), kind: 'original', reason: 'as the buyer typed it' },
  ];

  const seen = new Set([normalise(raw)]);

  const offer = (query: string, kind: QueryVariant['kind'], reason: string): void => {
    const trimmed = query.replace(/\s+/g, ' ').trim();
    if (trimmed.length < 2 || seen.has(normalise(trimmed))) return;
    seen.add(normalise(trimmed));
    variants.push({ query: trimmed, kind, reason });
  };

  // An article number or a model code is the one thing a shop's search is
  // reliably good at, and it is the narrowest possible question.
  const code = product.identifiers.gtins[0] ?? product.identifiers.modelCodes[0];
  if (code) offer(code, 'identifier', 'the code identifies the article on its own');

  // The same words, spelled the other way.
  //
  // This one is worth more in this market than everything below it. A
  // Bulgarian wholesaler writes a cable as "3х1,5" — Cyrillic х, decimal
  // comma — and a buyer types "3x1.5" on a Latin keyboard. The two strings
  // share not one byte, the shop's search is a LIKE over the title, and the
  // answer comes back empty from a supplier holding four hundred metres of it.
  const respelled = respell(raw);
  if (respelled) offer(respelled, 'spelling', 'the same size, spelled as the shops write it');

  // The trade's own spelling of what the buyer described: the kind of thing,
  // who makes it, and the one measurement that identifies it, written in the
  // canonical unit rather than whichever one the buyer happened to use.
  const identity = product.attributes.filter(
    (attribute) => attribute.role === 'identity' && attribute.quantity,
  );

  const head = [product.brand, product.productType?.raw].filter(Boolean).join(' ');

  if (head && identity.length > 0) {
    offer(
      `${head} ${formatQuantity(identity[0].quantity!).replace(/\s+/g, '')}`,
      'canonical',
      'the kind of article plus the measurement that identifies it',
    );
  }

  // The size on its own. Shops index the specification even when they name
  // the article something the buyer would never type — "СВТ", "ПВВМБ", "NYM"
  // are all the same cable to somebody who asked for 3x1.5.
  const sizes = product.attributes.filter(
    (attribute) => attribute.role === 'identity' && attribute.source === 'dimension',
  );

  if (sizes.length > 0) {
    offer(
      sizes[0].raw,
      'canonical',
      'the size on its own, which shops index even when the name differs',
    );
  }

  // The broadest question still worth asking. A supplier search that found
  // nothing for four terms will usually find the shelf for two, and the
  // matching that follows is what makes a broad answer safe: everything
  // irrelevant is scored out locally rather than shown.
  if (head) offer(head, 'broad', 'the kind of article, so the shelf can be read');
  else if (product.productType) {
    offer(product.productType.raw, 'broad', 'the kind of article, so the shelf can be read');
  }

  return variants.slice(0, limit);
}

/**
 * The one fallback a supplier that answered nothing is worth asking.
 *
 * Deliberately singular. Two fallbacks is three requests per supplier per
 * search, which triples the cost of the one expensive thing this system does
 * in exchange for a recall gain nobody has measured.
 */
export function fallbackFor(variants: QueryVariant[]): QueryVariant | null {
  return variants.find((variant) => variant.kind !== 'original') ?? null;
}

function normalise(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The query written the other way round, where the two ways exist.
 *
 * Two substitutions, both purely orthographic and neither of them a rule about
 * any product: the multiplication sign between two numbers, which is a Latin
 * x on a buyer's keyboard and a Cyrillic х in half the catalogues written in
 * this market; and the decimal separator, which is a comma in Europe and a
 * point everywhere a price list was exported from a spreadsheet.
 *
 * @returns the other spelling, or null when the query contains neither.
 */
export function respell(raw: string): string | null {
  let out = raw;
  let changed = false;

  const swapped = out.replace(
    /(\d\s*)([xх])(\s*\d)/gi,
    (_match, before: string, sign: string, after: string) => {
      changed = true;
      return `${before}${sign === 'x' || sign === 'X' ? 'х' : 'x'}${after}`;
    },
  );

  out = swapped;

  const separated = out.replace(
    /(\d)([.,])(\d)/g,
    (_match, before: string, sign: string, after: string) => {
      changed = true;
      return `${before}${sign === '.' ? ',' : '.'}${after}`;
    },
  );

  return changed ? separated : null;
}
