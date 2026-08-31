/**
 * What a shop will let you pay monthly, and who is lending.
 *
 * A price is one number and a purchase is often two decisions. A buyer looking
 * at 229 € and 12 × 20.75 € from TBI is choosing between capital and cashflow,
 * and a comparison that shows only the first has answered half their question
 * — the half they could already see on the shop's own page.
 *
 * Three things are worth reading and no more: how many instalments, how much
 * each one is, and who is behind it. The lender matters as much as the number:
 * a buyer with an account at one bank and none at another is not choosing
 * between equal offers, and "на изплащане" without a name is a claim they
 * cannot check.
 *
 * Everything here is read from the shop's own words. Nothing is calculated —
 * no interest rate is inferred, no total is derived from a monthly figure.
 * A financing total this system computed and got wrong is a number a customer
 * can disprove against their contract, and one of those costs more than the
 * whole feature is worth.
 */

/** One financing offer, as the shop states it. */
export interface InstalmentPlan {
  /** How many payments. */
  months: number;
  /** What each one costs, in `currency`. */
  monthly: number;
  currency: string;
  /** Who is lending, where the page names them. Null when it does not. */
  provider: string | null;
}

/**
 * Lenders these storefronts actually name, longest spelling first.
 *
 * A closed list on purpose. "Банка" appears on every page with a footer, and
 * treating any nearby capitalised word as the lender would attribute a loan to
 * whatever happened to sit beside the number.
 */
const PROVIDERS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /unicredit\s*(consumer\s*financing|bulbank)?/i, name: 'UniCredit' },
  { pattern: /бнп\s*париба|bnp\s*paribas|cetelem|сетелем/i, name: 'BNP Paribas' },
  { pattern: /tbi\s*(bank)?|тби\s*(банк)?/i, name: 'TBI Bank' },
  { pattern: /аксес\s*файнанс|access\s*finance/i, name: 'Аксес Файнанс' },
  { pattern: /пощенска\s*банка|eurobank|юробанк/i, name: 'Пощенска банка' },
  { pattern: /банка\s*дск|дск\s*банк|\bdsk[\s-]*bank/i, name: 'Банка ДСК' },
  { pattern: /klarna/i, name: 'Klarna' },
  { pattern: /paysera/i, name: 'Paysera' },
];

/** Currency as the page wrote it, reduced to a code. */
const CURRENCIES: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /€|eur/i, code: 'EUR' },
  { pattern: /лв\.?|bgn/i, code: 'BGN' },
  { pattern: /ron|lei/i, code: 'RON' },
];

/**
 * The shapes a monthly payment is written in.
 *
 * Two, because two is what these storefronts use: the sentence form that names
 * the count and the amount, and the arithmetic form that just multiplies. Both
 * capture the same three fields in the same order.
 */
const PATTERNS: RegExp[] = [
  // "на 12 вноски по 8.76 €" · "12 вноски х 8,76 лв"
  /(?:на\s+)?(?<![\d])(\d{1,2})\s*(?:месечни\s+)?вноск[иа]\s*(?:по|х|x|×)?\s*([\d]+(?:[.,]\d{1,2})?)\s*(€|eur|лв\.?|bgn|ron|lei)/giu,
  // "12 x 8.76 €" · "12 × 8,76 лв"
  /(?<![\d])(\d{1,2})\s*[x×]\s*([\d]+(?:[.,]\d{1,2})?)\s*(€|eur|лв\.?|bgn|ron|lei)/giu,
  // "8.76 €/месец за 12 месеца"
  /([\d]+(?:[.,]\d{1,2})?)\s*(€|eur|лв\.?|bgn|ron|lei)\s*(?:\/|на\s+)месец\D{0,20}?(?<![\d])(\d{1,2})\s*месец/giu,
];

/** Words that mean a page offers financing at all, even without a figure. */
const OFFERS_CREDIT =
  /на\s+изплащане|лизинг|разсрочено\s+плащане|плати\s+на\s+части|кредит\s+от|купи\s+с\s+кредит|in\s+instal?ments|rate\s+lunare/iu;

/**
 * Every financing plan the page states, best-documented first.
 *
 * @param text visible page text, markup already stripped.
 */
export function readInstalments(text: string | null | undefined): InstalmentPlan[] {
  if (!text) return [];

  const haystack = text.replace(/[    ]/g, ' ').replace(/\s+/g, ' ');

  // Every figure first, with where it sat, so attribution can be bounded by
  // its neighbours rather than by a fixed radius.
  const sightings: Array<{ months: number; monthly: number; currency: string; at: number }> = [];

  for (const [index, pattern] of PATTERNS.entries()) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(haystack)) !== null) {
      // The third shape states the amount before the count; the other two
      // state the count first.
      const months = Number(index === 2 ? match[3] : match[1]);
      const monthly = Number((index === 2 ? match[1] : match[2]).replace(',', '.'));
      const written = index === 2 ? match[2] : match[3];

      // A "plan" of one payment is a price, and nobody finances over five
      // years in this trade — a longer number is a part code that happened to
      // sit beside a currency.
      if (!Number.isFinite(months) || months < 2 || months > 60) continue;
      if (!Number.isFinite(monthly) || monthly <= 0) continue;

      sightings.push({
        months,
        monthly: Math.round(monthly * 100) / 100,
        currency: CURRENCIES.find((entry) => entry.pattern.test(written))?.code ?? 'EUR',
        at: match.index,
      });
    }
  }

  sightings.sort((a, b) => a.at - b.at);

  const found = new Map<string, InstalmentPlan>();

  for (const [position, sighting] of sightings.entries()) {
    /*
     * A lender may not be borrowed from the plan above it.
     *
     * mashini.bg prints two offers in a row and renders each bank as a logo.
     * Only the first logo is in the server's HTML — the second arrives with
     * JavaScript — so a fixed radius reached back over the first plan and
     * attributed its bank to both. Naming the wrong lender is worse than
     * naming none: the name is the part a buyer would act on, and it is the
     * part they cannot check until the contract.
     *
     * So the search stops at the previous figure. Between two plans, whatever
     * lies before the earlier one belongs to the earlier one.
     */
    const floor = position > 0 ? sightings[position - 1].at + 1 : 0;
    const plan: InstalmentPlan = {
      months: sighting.months,
      monthly: sighting.monthly,
      currency: sighting.currency,
      provider: providerNear(haystack, sighting.at, floor),
    };

    const key = `${plan.months}|${plan.monthly}|${plan.currency}`;
    const seen = found.get(key);

    // The same plan is often printed twice — once in a banner and once in the
    // payment box — and only one of the two sits near the lender's name.
    if (!seen || (seen.provider === null && plan.provider !== null)) found.set(key, plan);
  }

  return [...found.values()].sort((a, b) => a.months - b.months);
}

/** True when the page says it offers financing, whatever the figures say. */
export function offersCredit(text: string | null | undefined): boolean {
  if (!text) return false;
  return OFFERS_CREDIT.test(text) || readInstalments(text).length > 0;
}

/**
 * The lender named closest to a figure.
 *
 * Scoped to the sentence around the number rather than the whole page: a
 * footer listing four banks would otherwise attribute every plan to whichever
 * one the list happened to start with. `floor` stops the search reaching back
 * over an earlier plan and stealing its lender.
 */
function providerNear(haystack: string, at: number, floor = 0): string | null {
  const window = haystack.slice(Math.max(floor, at - 120), at + 120);

  for (const { pattern, name } of PROVIDERS) {
    if (pattern.test(window)) return name;
  }

  return null;
}
