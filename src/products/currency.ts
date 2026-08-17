/**
 * Currency normalisation for price comparison.
 *
 * The Bulgarian lev is pegged to the euro by law at 1.95583 BGN = 1 EUR — not a
 * market rate, a fixed one, so converting between the two is exact and needs no
 * rate feed. Bulgarian shops routinely quote one or the other, and the same
 * television costs "359 €" at one and "757 лв." at another.
 *
 * Comparing those two numbers directly makes the cheaper shop look twice as
 * expensive, which is the single most damaging thing a price-comparison tool
 * can get wrong. Anything outside this pegged pair is *not* converted: a made-up
 * USD rate would be a guess presented as a fact.
 */
export const BGN_PER_EUR = 1.95583;

export class CurrencyMismatchError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(
      `Не мога да сравня ${from} с ${to} без валутен курс. Задайте цената в ${to} или добавете курс.`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

/** True when the two currencies are the pegged pair (in either direction). */
export function isConvertible(from: string, to: string): boolean {
  const pair = new Set([from.toUpperCase(), to.toUpperCase()]);
  return pair.size === 1 || (pair.has('BGN') && pair.has('EUR'));
}

/**
 * Converts an amount between BGN and EUR.
 *
 * @throws CurrencyMismatchError for any pair that is not pegged — better a
 * clear failure than a confident wrong comparison.
 */
export function convert(amount: number, from: string, to: string): number {
  const source = from.toUpperCase();
  const target = to.toUpperCase();

  if (source === target) return amount;

  if (source === 'BGN' && target === 'EUR') {
    return round(amount / BGN_PER_EUR);
  }

  if (source === 'EUR' && target === 'BGN') {
    return round(amount * BGN_PER_EUR);
  }

  throw new CurrencyMismatchError(source, target);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
