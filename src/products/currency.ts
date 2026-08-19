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

/**
 * Rates against the euro for everything outside the pegged pair.
 *
 * Empty until an operator supplies them through `FX_RATES_PER_EUR`, and
 * deliberately so: a comparison between a dollar price and a euro price is
 * either done at a rate somebody chose and can defend, or not done at all.
 * Inventing one produces a ranking that looks authoritative and is wrong by
 * however much the guess was off.
 *
 * Stated as "units of the currency per one euro" — the form a bank quotes and
 * the form an operator can check against one.
 */
const ratesPerEur = new Map<string, number>();

/** Replaces the rate table. Called once at boot from configuration. */
export function setRatesPerEur(rates: Record<string, number>): void {
  ratesPerEur.clear();
  for (const [code, rate] of Object.entries(rates)) {
    if (Number.isFinite(rate) && rate > 0) ratesPerEur.set(code.toUpperCase(), rate);
  }
}

/** The currencies that can currently be compared, for reporting. */
export function convertibleCurrencies(): string[] {
  return ['EUR', 'BGN', ...ratesPerEur.keys()].filter(
    (code, index, all) => all.indexOf(code) === index,
  );
}

/** Parses `USD:1.08,GBP:0.85` into a rate table. */
export function parseRates(raw: string | undefined): Record<string, number> {
  if (!raw) return {};

  const rates: Record<string, number> = {};

  for (const entry of raw.split(',')) {
    const [code, value] = entry.split(':').map((part) => part?.trim());
    const rate = Number(value);
    if (!code || !Number.isFinite(rate) || rate <= 0) continue;
    rates[code.toUpperCase()] = rate;
  }

  return rates;
}

/** How many units of `code` make one euro, or null when nothing says. */
function perEur(code: string): number | null {
  if (code === 'EUR') return 1;
  if (code === 'BGN') return BGN_PER_EUR;
  return ratesPerEur.get(code) ?? null;
}

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

/** True when both sides have a rate — the peg, or one an operator supplied. */
export function isConvertible(from: string, to: string): boolean {
  const source = from.toUpperCase();
  const target = to.toUpperCase();
  if (source === target) return true;
  return perEur(source) !== null && perEur(target) !== null;
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

  // The peg is exact and stays exact: dividing by the legal rate rather than
  // routing through a table that might one day hold a market quote for BGN.
  if (source === 'BGN' && target === 'EUR') return round(amount / BGN_PER_EUR);
  if (source === 'EUR' && target === 'BGN') return round(amount * BGN_PER_EUR);

  const sourceRate = perEur(source);
  const targetRate = perEur(target);

  if (sourceRate === null || targetRate === null) {
    throw new CurrencyMismatchError(source, target);
  }

  return round((amount / sourceRate) * targetRate);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
