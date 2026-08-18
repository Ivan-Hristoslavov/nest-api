import { convert, isConvertible } from '../products/currency';

/**
 * Turning a pile of search results into an answer.
 *
 * The question is never "what does this cost" — it is "who should I buy this
 * from", and that is a different number. A shop quoting 12.00 € with a 30 %
 * negotiated discount beats one quoting 9.50 € at list, and a shop quoting in
 * lev is not comparable to one quoting in euro until something converts it.
 * Ranking on the shelf price gets both of those backwards.
 */

export interface RankableOffer {
  title: string;
  url: string;
  price: number | null;
  currency: string | null;
  host: string;
  shopName: string;
  shopId: string | null;
  discountPercent: number;
  inStock?: boolean | null;
  /** Set only for a price the buyer entered by hand; see {@link RankedHit}. */
  recordedAt?: string | null;
}

export interface RankedHit {
  groupKey: string;
  groupLabel: string;
  /**
   * Whether the product's own name contains what was searched for.
   *
   * Shop search engines are fuzzy, and some are very fuzzy: homefinishing.bg
   * answers "СВТ" with "САТ.НИКЕЛ", "Суши **сет**" and a picture light. Those
   * are the shop's guesses, not matches, and presenting them the same way as a
   * real hit makes the tool look broken when the shop was merely being
   * generous.
   */
  matched: boolean;
  shopId: string | null;
  shopName: string;
  host: string;
  name: string;
  url: string;
  listedPrice: number | null;
  listedCurrency: string;
  discountPercent: number;
  effectivePrice: number | null;
  effectiveCurrency: string;
  inStock: boolean | null;
  /**
   * When a hand-entered price was last confirmed, or null for a live one.
   *
   * The comparison mixes prices read seconds ago with prices typed in weeks
   * ago, and they are not the same claim. Ranking them together is right — the
   * supplier with no website is often the cheapest — but presenting them
   * identically would not be.
   */
  recordedAt: string | null;
}

/**
 * Groups results by the kind of article they are.
 *
 * "Кабел" matches bare cable at 0.14 €/m and a cable drum at 19 €. Printing
 * one price range across the two invites exactly the wrong conclusion, so each
 * kind is ranked against its own.
 *
 * The signals, strongest first: a model code (H05V-K, ST9453B) — the closest
 * thing these catalogues have to an identity — then the leading noun, which is
 * what separates КАБЕЛ from МАКАРА.
 */
export function groupOf(name: string): { key: string; label: string } {
  const cleaned = (name || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return { key: 'other', label: 'Други' };

  const head = cleaned.split(/[\s./,+]/)[0].toUpperCase();

  const code = cleaned
    .toUpperCase()
    .split(/[\s,/]+/)
    // Brackets are punctuation, not part of the token. Retailers write the
    // equivalent incandescent wattage in parentheses — "13W (100W)" — and read
    // with the brackets attached, "(100W)" passes every model-code test and
    // becomes the group label. That splits one shelf of bulbs into a group per
    // wattage and labels them things like "КРУШКА (100W)".
    .map((token) => token.replace(/^[([{"'«]+|[)\]}"'».,;:]+$/g, ''))
    .find(
      (token) =>
        token.length >= 4 &&
        /[A-ZА-Я]/.test(token) &&
        /\d/.test(token) &&
        // A measurement is not an identity. "3x2.5MM2" is a cable's
        // cross-section — every shop selling that gauge writes it, so treating
        // it as a model code splits one comparable group into as many groups
        // as there are sizes, which is the opposite of grouping.
        !isMeasurement(token) &&
        !token.startsWith(head),
    );

  const label = code ? `${head} ${code}` : head;
  return { key: label.toLowerCase(), label };
}

/**
 * True for a token that states a size rather than names a product.
 *
 * Covers the bare unit ("5W", "25M") and the dimension form electrical
 * catalogues are full of: "3x2.5MM2", "1X1.5".
 */
function isMeasurement(token: string): boolean {
  return /^\d+(?:[.,]\d+)?(?:[XХ]\d+(?:[.,]\d+)?)*\s*(MM2|ММ2|MM|ММ|CM|СМ|M|М|W|WT|V|A|K|LM)?$/.test(
    token,
  );
}

/** Money, to the cent. */
function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Cyrillic letters that look Latin, folded onto their twins.
 *
 * Shops write "Е27" in Cyrillic about half the time and buyers type "E27" in
 * Latin. Without folding, a genuine match is reported as a fuzzy guess.
 */
const HOMOGLYPH_FROM = 'аеорсухкмтвнАЕОРСУХКМТВН';
const HOMOGLYPH_TO = 'aeopcyxkmtbhAEOPCYXKMTBH';

function fold(text: string): string {
  let out = '';
  for (const letter of text) {
    const index = HOMOGLYPH_FROM.indexOf(letter);
    out += index === -1 ? letter : HOMOGLYPH_TO[index];
  }
  return out.toLowerCase();
}

/** The words worth matching on: short ones match everything. */
function queryWords(query: string): string[] {
  return fold(query)
    .split(/[\s,./-]+/)
    .filter((word) => word.length >= 3);
}

/** True when the name carries every word of the query. */
function namesMatch(name: string, words: string[]): boolean {
  if (words.length === 0) return true;
  const folded = fold(name);
  return words.every((word) => folded.includes(word));
}

/** Applies the customer's discount and converts into one currency. */
export function toHit(offer: RankableOffer, target: string, words: string[] = []): RankedHit {
  const listed = offer.price;
  const currency = (offer.currency ?? 'EUR').toUpperCase();

  const discounted = listed === null ? null : listed * (1 - offer.discountPercent / 100);

  const convertible = isConvertible(currency, target);

  // Rounded here rather than left to the caller. 12.00 less 30 % is
  // 8.399999999999999 in binary floating point, and an API that answers with
  // that number invites every consumer to round it their own way — or to
  // compare two of them for equality and find they differ.
  const effective =
    discounted === null || !convertible ? null : round(convert(discounted, currency, target));

  const group = groupOf(offer.title);

  return {
    groupKey: group.key,
    groupLabel: group.label,
    matched: namesMatch(offer.title, words),
    shopId: offer.shopId,
    shopName: offer.shopName,
    host: offer.host,
    name: offer.title,
    url: offer.url,
    listedPrice: listed,
    listedCurrency: currency,
    discountPercent: offer.discountPercent,
    effectivePrice: effective,
    effectiveCurrency: convertible ? target : currency,
    inStock: offer.inStock ?? null,
    recordedAt: offer.recordedAt ?? null,
  };
}

/**
 * Cheapest first, kinds of article kept together.
 *
 * Offers with no readable price keep their place at the end rather than being
 * dropped — the shop does stock the item, which is worth knowing, and the link
 * still works. Silently discarding them would misreport coverage.
 */
export function rank(offers: RankableOffer[], target = 'EUR', limit = 60, query = ''): RankedHit[] {
  const words = queryWords(query);
  const hits = offers.map((offer) => toHit(offer, target, words));

  const byPrice = (a: RankedHit, b: RankedHit): number => {
    if (a.effectivePrice === null) return 1;
    if (b.effectivePrice === null) return -1;
    return a.effectivePrice - b.effectivePrice;
  };

  hits.sort(byPrice);

  const groups = new Map<string, RankedHit[]>();
  for (const hit of hits) {
    const bucket = groups.get(hit.groupKey);
    if (bucket) bucket.push(hit);
    else groups.set(hit.groupKey, [hit]);
  }

  // Real matches first, the shop's guesses after — each still cheapest-first
  // within its own half. Interleaving them by price alone put a satin-nickel
  // downlight above the thing the user actually asked for, purely because the
  // shop's search engine was feeling helpful.
  const ordered = [...groups.values()].sort((a, b) => byPrice(a[0], b[0]));
  const matched = ordered.filter((group) => group.some((hit) => hit.matched));
  const guessed = ordered.filter((group) => !group.some((hit) => hit.matched));

  return [...matched, ...guessed].flat().slice(0, limit);
}
