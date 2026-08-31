import { offersCredit, readInstalments } from './instalments';

/**
 * What a shop will let you pay monthly.
 *
 * A price is one number; a purchase is often two decisions. The strings below
 * are the forms these storefronts actually print — a buyer looking at
 * "Купи с на 12 вноски по 8.76 €" is being offered something the comparison
 * was silent about.
 */
describe('reading a financing offer', () => {
  it('reads the sentence form a Bulgarian shop prints', () => {
    expect(readInstalments('Купи с TBI Bank на 12 вноски по 8.76 €')).toEqual([
      { months: 12, monthly: 8.76, currency: 'EUR', provider: 'TBI Bank' },
    ]);
  });

  it('reads a decimal comma and lev', () => {
    expect(readInstalments('на 24 вноски по 19,50 лв.')).toEqual([
      { months: 24, monthly: 19.5, currency: 'BGN', provider: null },
    ]);
  });

  it('reads the arithmetic form', () => {
    expect(readInstalments('12 x 9.31 €')).toEqual([
      { months: 12, monthly: 9.31, currency: 'EUR', provider: null },
    ]);
  });

  it('reads the per-month form', () => {
    expect(readInstalments('само 8,76 €/месец за 12 месеца')).toEqual([
      { months: 12, monthly: 8.76, currency: 'EUR', provider: null },
    ]);
  });

  it('names the lender when the page does', () => {
    const providers: Array<[string, string]> = [
      ['Купи с UniCredit Consumer Financing на 6 вноски по 30 €', 'UniCredit'],
      ['БНП Париба · на 6 вноски по 30 €', 'BNP Paribas'],
      ['на 6 вноски по 30 € с ТБИ Банк', 'TBI Bank'],
      ['Klarna — 6 x 30 €', 'Klarna'],
    ];

    for (const [text, expected] of providers) {
      expect([text, readInstalments(text)[0]?.provider]).toEqual([text, expected]);
    }
  });

  it('does not attribute a plan to a bank listed in the footer', () => {
    // Two hundred characters away, in a list of everyone the shop works with.
    // Reading that as the lender for this plan would put a name on a claim
    // nobody made.
    const page =
      'на 6 вноски по 30 € ' +
      'Описание Полирмашина за професионална употреба с регулируеми обороти и меко '.repeat(3) +
      'Партньори: UniCredit, TBI Bank, Klarna';
    expect(readInstalments(page)[0].provider).toBeNull();
  });

  it('lists every plan a page offers, shortest first', () => {
    const page = 'на 12 вноски по 8.76 € или на 6 вноски по 16.50 €';
    expect(readInstalments(page).map((plan) => plan.months)).toEqual([6, 12]);
  });

  it('collapses the same plan printed twice, keeping the named one', () => {
    // Shops print the figure in a banner and again in the payment box, and
    // only one of the two sits beside the lender.
    const page = '12 x 8.76 € ... Купи с TBI Bank на 12 вноски по 8.76 €';
    const plans = readInstalments(page);

    expect(plans).toHaveLength(1);
    expect(plans[0].provider).toBe('TBI Bank');
  });

  it('refuses numbers that are not a payment plan', () => {
    // A part code beside a price, and a single "instalment" which is just the
    // price again. Both look like the pattern and neither is financing.
    expect(readInstalments('XPA12-75 · 95.00 €')).toEqual([]);
    expect(readInstalments('на 1 вноска по 95.00 €')).toEqual([]);
    expect(readInstalments('120 x 2.00 €')).toEqual([]);
  });

  it('says nothing about a page that offers no financing', () => {
    expect(readInstalments('Полирмашина STATUS XPA12-75, 750 W — 95.00 €')).toEqual([]);
    expect(readInstalments(null)).toEqual([]);
  });
});

describe('whether a shop finances at all', () => {
  it('recognises the offer even with no figure on the page', () => {
    // Plenty of shops advertise the option and put the arithmetic behind a
    // click. That is still worth telling a buyer.
    for (const text of ['Купи на изплащане', 'Лизинг', 'Разсрочено плащане', 'Плати на части']) {
      expect([text, offersCredit(text)]).toEqual([text, true]);
    }
  });

  it('is false for a page that only states a price', () => {
    expect(offersCredit('Полирмашина STATUS XPA12-75 — 95.00 €')).toBe(false);
  });
});

describe('attributing a lender to the right plan', () => {
  it('does not lend one plan the bank named on the plan above it', () => {
    // mashini.bg, verbatim as the server renders it: the first offer carries
    // TBI's logo and the second carries nothing, because its logo arrives with
    // JavaScript. A fixed radius reached backwards and put TBI on both.
    const page =
      'Купи с https://cdn.tbibank.support/logo/tbi-bank-white.svg на 12 вноски по 8.76 € ' +
      'Купи с на 12 вноски по 9.31 €';

    const plans = readInstalments(page);

    expect(plans).toHaveLength(2);
    expect(plans.find((plan) => plan.monthly === 8.76)?.provider).toBe('TBI Bank');
    expect(plans.find((plan) => plan.monthly === 9.31)?.provider).toBeNull();
  });

  it('still names a lender written after its own figure', () => {
    expect(readInstalments('на 10 вноски по 12.00 € с TBI Bank')[0].provider).toBe('TBI Bank');
  });
});
