import { InstalmentPlan } from '../scraper/parsers/instalments';
import {
  CostWarning,
  LineCost,
  NEUTRAL_TERMS,
  SupplierTerms,
  VatCertainty,
  VatState,
  effectiveLineCost,
} from '../pricing/effective-cost';

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
  /** Financing the shop states on this article, if any. */
  instalments?: InstalmentPlan[];
  /** When the figure was obtained, for anything not read just now. */
  recordedAt?: string | null;
  /** Where the figure came from. See {@link RankedHit.priceSource}. */
  priceSource?: 'live' | 'cached' | 'manual';
  /**
   * The supplier's full commercial terms, when they are known.
   *
   * Optional so that an offer from a host matching no configured shop still
   * ranks. Absent, only `discountPercent` above applies and the VAT basis is
   * reported as unknown — which is the truth about such an offer.
   */
  terms?: SupplierTerms;
  /**
   * Whether this buyer holds terms with the shop this came from.
   *
   * False only for an offer reached because the search scope was widened past
   * the buyer's own supplier list. It is not a lesser offer — it may well be
   * the only one — but it is a different kind of answer: no negotiated
   * discount, no agreed delivery, and an account that does not exist yet.
   */
  isMine?: boolean;
}

export interface RankedHit {
  groupKey: string;
  groupLabel: string;
  /** False for a shop this buyer holds no terms with. See {@link RankableOffer.isMine}. */
  isMine: boolean;
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
   * What the shop will let a buyer pay monthly, as the shop states it.
   *
   * A price is one number and a purchase is often two decisions: 229 € against
   * 12 × 20.75 € is capital against cashflow, and a comparison showing only
   * the first has answered half the question. Empty where the page offers
   * nothing — which is most of them.
   */
  instalments: InstalmentPlan[];
  /**
   * When a hand-entered price was last confirmed, or null for a live one.
   *
   * The comparison mixes prices read seconds ago with prices typed in weeks
   * ago, and they are not the same claim. Ranking them together is right — the
   * supplier with no website is often the cheapest — but presenting them
   * identically would not be.
   */
  recordedAt: string | null;
  /**
   * Where this figure came from.
   *
   * Three origins that a buyer must be able to tell apart, because they carry
   * different weight: `live` was read from the shop moments ago, `cached` was
   * read within the last few hours, `manual` is what the buyer typed for a
   * supplier that publishes nothing. Collapsing the last two — as this did at
   * first — labelled a cached scrape "ваша цена", which is simply untrue.
   */
  priceSource: 'live' | 'cached' | 'manual';
  /**
   * Whether this figure can be set against the others without a caveat.
   *
   * `known` means the supplier's VAT treatment is on file and the figure is
   * net of VAT. `assumed` means nobody has said, and the quoted number is
   * being used as-is — safe next to other assumed figures, which share
   * whatever basis they share. `uncertain` means this offer sits beside one
   * whose basis *is* known, so one may be gross and the other net and nothing
   * in the data says which. That last case must never be presented as a
   * straight price comparison.
   */
  vatCertainty: VatCertainty;
  vatState: VatState;
  /** Anything the buyer should know before trusting this figure. */
  warnings: CostWarning[];
  /**
   * The full unit-price working, kept so an order total can be built from it
   * without re-deriving anything.
   *
   * A hit prices one unit; an order line prices a quantity at a supplier who
   * charges delivery once. Carrying the working forward is what lets the
   * basket add those without a second, subtly different implementation of the
   * same arithmetic — which is the bug this whole module exists to remove.
   */
  cost: LineCost;
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

  // The size is part of the identity, not a detail of it.
  //
  // Grouped on the noun alone, "КАБЕЛ" held 3x1.5 at 0.42/m beside a 34 € drum
  // and reported the difference as +8000 % — a true number about two things
  // nobody would buy in place of each other, which makes the whole column
  // untrustworthy. Including the gauge splits those apart and, more usefully,
  // groups the *same* article across suppliers, which is the comparison the
  // buyer came for.
  const size = cleaned
    .toUpperCase()
    .split(/[\s,/]+/)
    .map((token) => token.replace(/^[([{"'«]+|[)\]}"'».,;:]+$/g, ''))
    .find((token) => /^\d+(?:[.,]\d+)?(?:[XХ]\d+(?:[.,]\d+)?)+/.test(token));

  const label = [head, code, size].filter(Boolean).join(' ');
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

/**
 * The terms to price this offer on.
 *
 * Where the offer carries the supplier's own terms, those win. Where it does
 * not — a search result from a host matching no configured shop — the discount
 * that came with the offer is still honoured and everything else is neutral,
 * which reproduces exactly what this function did before terms existed.
 */
function termsFor(offer: RankableOffer): SupplierTerms {
  if (offer.terms) return offer.terms;

  return {
    ...NEUTRAL_TERMS,
    shopId: offer.shopId,
    name: offer.shopName,
    currency: (offer.currency ?? 'EUR').toUpperCase(),
    discountPercent: offer.discountPercent,
  };
}

/**
 * Turns one offer into a ranked hit at the price this customer actually pays.
 *
 * The arithmetic lives in {@link effectiveLineCost} rather than here. It used
 * to be inline — `price × (1 − discount)` and a currency conversion — and that
 * was the whole pricing model: no VAT, no delivery, no minimum order. Keeping
 * one authoritative implementation is what lets the basket, the ranking and
 * anything built on them agree about a number the customer will check against
 * their own invoice.
 */
export function toHit(offer: RankableOffer, target: string, words: string[] = []): RankedHit {
  const terms = termsFor(offer);
  const cost = effectiveLineCost(
    { listPrice: offer.price, currency: offer.currency, quantity: 1 },
    terms,
    target,
  );

  const group = groupOf(offer.title);

  return {
    groupKey: group.key,
    groupLabel: group.label,
    isMine: offer.isMine !== false,
    matched: namesMatch(offer.title, words),
    shopId: offer.shopId,
    shopName: offer.shopName,
    host: offer.host,
    name: offer.title,
    url: offer.url,
    listedPrice: cost.listPrice,
    listedCurrency: cost.listCurrency,
    discountPercent: cost.discountPercent,
    effectivePrice: cost.effectiveUnitPrice,
    effectiveCurrency: cost.effectiveCurrency,
    inStock: offer.inStock ?? null,
    instalments: offer.instalments ?? [],
    recordedAt: offer.recordedAt ?? null,
    priceSource: offer.priceSource ?? 'live',
    vatCertainty: cost.vatCertainty,
    vatState: cost.vatState,
    warnings: cost.warnings,
    cost,
  };
}

/**
 * Is this a thing the shop sells, or part of its page?
 *
 * A shop's search page carries more than results: a banner offering a trade
 * account, a "compare selected" box, a newsletter tile. Whatever selector
 * reads the results reads those too, and they arrive looking like offers.
 * `homefinishing.bg` returned "Станете партньор" — its become-a-partner link —
 * at the top of every single search, whatever was typed.
 *
 * Two things are true of that tile and of no real listing: it carries no
 * price, and it has nothing to do with what was asked. Either alone is
 * innocent. A product whose price failed to parse still deserves its place —
 * the shop stocks it, the link works, and dropping it would misreport
 * coverage, which is why {@link rank} keeps those at the end. And a result
 * that matches nothing is just the shop's search being generous, which is
 * worth showing when it has a price to show.
 *
 * Both together mean nobody can buy it, and nothing about it answers the
 * question. That is furniture.
 */
function isListing(hit: RankedHit): boolean {
  return hit.listedPrice !== null || hit.matched;
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
  const hits = offers.map((offer) => toHit(offer, target, words)).filter(isListing);

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
