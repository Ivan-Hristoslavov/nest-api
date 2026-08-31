/**
 * Turning what somebody pasted into a list of things to buy.
 *
 * A buyer does not fill in a form. They paste a line out of an email, or a
 * column out of a spreadsheet, or they type three things one under the other
 * because that is how the list arrived. Every one of those is a purchase
 * request and none of them is a syntax.
 *
 * So there is no syntax. The rules below are how people already write, read
 * back rather than imposed: one article per line, and a quantity at the end if
 * there is one — after a comma, after a dash, with a unit or without, in
 * Cyrillic or Latin.
 *
 * Deliberately deterministic and deliberately small. This runs before anything
 * else in a search, on every request, and a model asked to split three lines
 * into three lines would be the most expensive regular expression ever
 * written.
 */

/** One article somebody wants, and how many of it. */
export interface RequestedLine {
  /** The article, as they wrote it, with the quantity taken off the end. */
  query: string;
  quantity: number;
  /** The unit they counted in, when they said one. Kept for the order, not for matching. */
  unit: string | null;
}

/** How many lines one request may hold before it stops being a request. */
const MAX_LINES = 60;

/**
 * A quantity at the end of a line.
 *
 * Everything about this pattern is a concession to how people actually type:
 * the separator may be a comma, a dash, an ×, or nothing at all; the number may
 * carry a decimal comma; the unit may be Cyrillic or Latin or absent. What it
 * will not do is eat a specification — see {@link looksLikeSpecification}.
 */
const TRAILING_QUANTITY =
  /[\s,;–—-]+(?:[xх×]\s*)?(\d+(?:[.,]\d+)?)\s*(бр\.?|броя|бройки|шт|pcs?|pieces?|компл\.?|к-т|sets?|м|m|метра|метър|мл|l|л|литра|кг|kg|г|g|опак\.?|пакета?|packs?)?\s*$/iu;

/** A leading count: "10 x LED лампа". */
const LEADING_QUANTITY = /^\s*(\d{1,4})\s*[xх×]\s+(?=\S)/u;

/**
 * Splits a pasted request into the articles it asks for.
 *
 * @returns one entry per non-empty line, in the order they were written.
 */
export function parseRequest(text: string): RequestedLine[] {
  const lines = (text || '')
    // A semicolon is a line break somebody typed sideways.
    .split(/[\n\r;]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_LINES);

  const parsed: RequestedLine[] = [];

  for (const line of lines) {
    parsed.push(parseLine(line));
  }

  return parsed.filter((entry) => entry.query.length >= 2);
}

/** One line, with its quantity separated from the article. */
export function parseLine(raw: string): RequestedLine {
  let query = raw.trim();
  let quantity = 1;
  let unit: string | null = null;

  const leading = LEADING_QUANTITY.exec(query);
  if (leading) {
    quantity = Number(leading[1]);
    query = query.slice(leading[0].length).trim();
  }

  const trailing = TRAILING_QUANTITY.exec(query);

  if (trailing && !looksLikeSpecification(query, trailing)) {
    const value = Number(trailing[1].replace(',', '.'));

    if (Number.isFinite(value) && value > 0) {
      // A leading count and a trailing one are two different claims — "10 x
      // cable, 100m" is ten drums of a hundred metres — and the article is
      // what is left when both have been taken off.
      quantity = leading ? quantity : value;
      unit = trailing[2] ? trailing[2].toLowerCase().replace(/\.$/, '') : null;
      query = query.slice(0, trailing.index).trim();
    }
  }

  return { query: query.replace(/[\s,;–—-]+$/u, '').trim(), quantity, unit };
}

/**
 * Whether the number at the end of the line is part of the article.
 *
 * The expensive mistake in both directions. Read "LED лампа 9W" as nine lamps
 * and the buyer is quoted for the wrong thing; refuse to read "кабел, 100м" as
 * a hundred metres and they have to retype every line of their own order.
 *
 * Three things separate them, and all three are about the *article*, not about
 * any product category:
 *
 *  * a unit that measures rather than counts is a specification — 9W, 2.5mm²,
 *    250ml — so only counting units and bare numbers are quantities;
 *  * a bare number with no separator before it is usually a size ("СВТ 3x2.5"
 *    ends in 2.5, and nobody means two and a half cables);
 *  * taking it off must leave an article behind.
 */
function looksLikeSpecification(line: string, match: RegExpExecArray): boolean {
  // The abbreviation people type carries a full stop about half the time, and
  // "бр." must count exactly as "бр" does.
  const unit = (match[2] ?? '').toLowerCase().replace(/\.$/, '');
  const separator = match[0].slice(0, match[0].indexOf(match[1]));

  // Nothing left once the number is gone: it was the article.
  if (line.slice(0, match.index).trim().length < 2) return true;

  // A counting unit is never a specification. "100 бр" is a hundred of them.
  if (
    /^(бр|броя|бройки|шт|pc|pcs|piece|pieces|компл|к-т|set|sets|опак|пакет|пакета|pack|packs)$/.test(
      unit,
    )
  ) {
    return false;
  }

  // A bare number needs a separator to be a quantity. "СВТ 3x2.5" and
  // "лампа 9" end in numbers that are part of what is being asked for.
  if (!unit) return !/[,;–—]/.test(separator);

  // A unit of measure after a separator is a quantity — "кабел, 100м" — and
  // without one it is a specification: "кабел 100м" is a hundred-metre drum.
  return !/[,;–—]/.test(separator);
}
