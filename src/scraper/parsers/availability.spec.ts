import { availabilityOf, readAvailability } from './availability';

/**
 * Whether a shop says it has the thing.
 *
 * The wording is the whole problem. Every storefront in this market invents
 * its own phrase for an empty shelf, and the parser used to read none of them
 * — it checked `schema.org` markup and stopped, so a shop writing "Изчерпан"
 * in a plain span looked identical to a shop with full stock.
 */
describe('reading availability off a page', () => {
  it('reads the ways a Bulgarian shop says it has run out', () => {
    const phrases = [
      'Изчерпан',
      'ИЗЧЕРПАНО',
      'Изчерпани количества',
      'Временно изчерпан',
      'Няма наличност',
      'Няма в наличност',
      'Без наличност',
      'Неналичен',
      'Не е наличен',
      'Разпродаден',
      'Продаден',
      'Очаква се доставка',
      'Наличност: 0',
      'По заявка',
      'Спрян от производство',
    ];

    for (const phrase of phrases) {
      expect([phrase, readAvailability(phrase)]).toEqual([phrase, false]);
    }
  });

  it('reads the ways a Bulgarian shop says it has stock', () => {
    for (const phrase of ['В наличност', 'Наличен', 'Налично', 'На склад', 'Има наличност']) {
      expect([phrase, readAvailability(phrase)]).toEqual([phrase, true]);
    }
  });

  it('does not read a negative as its own positive', () => {
    // The trap this ordering exists for: every one of these contains the word
    // that means the opposite. Checking the positives first reports a sold-out
    // article as available, in the languages the product is actually sold in.
    expect(readAvailability('Неналичен')).toBe(false);
    expect(readAvailability('не е наличен')).toBe(false);
    expect(readAvailability('stoc epuizat')).toBe(false);
    expect(readAvailability('nu este în stoc')).toBe(false);
    expect(readAvailability('μη διαθέσιμο')).toBe(false);
  });

  it('reads English, Romanian and Greek', () => {
    expect(readAvailability('Out of stock')).toBe(false);
    expect(readAvailability('Sold out')).toBe(false);
    expect(readAvailability('Currently unavailable')).toBe(false);
    expect(readAvailability('Discontinued')).toBe(false);
    expect(readAvailability('In stock')).toBe(true);
    expect(readAvailability('disponibil')).toBe(true);
    expect(readAvailability('διαθέσιμο')).toBe(true);
  });

  it('does not read the bare noun as a claim of stock', () => {
    // "наличност" alone is the word *availability*, not an assertion of it. It
    // turns up in table headers and in "проверете наличност", neither of which
    // says the shelf has anything on it.
    expect(readAvailability('Проверете наличност при доставчика')).toBeNull();
    expect(readAvailability('Наличност')).toBeNull();
  });

  it('says nothing when the page says nothing', () => {
    // The important half. Most shops label only what they have run out of, so
    // silence is the normal state of an article you can buy — and also the
    // normal state of a page we failed to read. Guessing `true` would quote
    // sold-out stock; guessing `false` would hide a shelf full of it.
    expect(readAvailability('Полирмашина STATUS XPA12-75, 750 W')).toBeNull();
    expect(readAvailability('')).toBeNull();
    expect(readAvailability(null)).toBeNull();
  });

  it('lets a refusal outrank an availability on the same page', () => {
    // A product page carries a "you may also like" rail, and those items have
    // stock labels of their own. Where both appear, the buyer needs the one
    // about the article they asked for, and the safe reading is the refusal.
    expect(readAvailability('Изчерпан · Подобни продукти: В наличност')).toBe(false);
  });

  it('reads across a line break or a non-breaking space', () => {
    expect(readAvailability('Няма наличност')).toBe(false);
    expect(readAvailability('Out of\n  stock')).toBe(false);
  });
});

describe('structured data outranks prose', () => {
  const page = '<html><body>В наличност</body></html>';

  it('believes the markup where the shop wrote some', () => {
    // A deliberate machine-readable claim beats whatever the template
    // happened to render around it.
    expect(availabilityOf(page, 'https://schema.org/OutOfStock', 'В наличност')).toBe(false);
    expect(availabilityOf(page, 'https://schema.org/InStock', 'Изчерпан')).toBe(true);
  });

  it('falls back to the words when the markup is silent', () => {
    expect(availabilityOf('<html></html>', null, 'Изчерпан')).toBe(false);
    expect(availabilityOf('<html></html>', null, 'В наличност')).toBe(true);
    expect(availabilityOf('<html></html>', null, 'Полирмашина 750W, 2 години гаранция')).toBeNull();
  });

  it('treats a pre-order as something you cannot buy today', () => {
    expect(availabilityOf(page, 'https://schema.org/PreOrder', '')).toBe(false);
    expect(availabilityOf(page, 'https://schema.org/BackOrder', '')).toBe(false);
  });
});
