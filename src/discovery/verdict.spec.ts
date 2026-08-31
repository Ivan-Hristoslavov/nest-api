import { matchNames } from '../matching/deterministic-matcher';
import { bestOffer, partitionByVerdict } from './verdict';

/**
 * The rows a supplier returned against the rows a buyer may be quoted.
 *
 * Every candidate below is a real title, taken from what emag.bg actually
 * served on 2026-08-31 for `STATUS XPA12-75` — a query it holds nothing for
 * and answers with a recommendation shelf. They arrive with prices, with
 * working product URLs, and with nothing whatever to do with the question.
 *
 * The regression these pin is not a scoring one. The matcher scored all eight
 * at zero from the first day; the search returned them anyway, and the
 * interface printed them under a heading saying nothing matched. What is
 * tested here is the decision that was missing: retrieval is not an offer.
 */

/** What eMAG served for the query, verbatim. */
const EMAG_SHELF = [
  'Шайба за инжектор Valeo V30-1443',
  'Задна стабилизираща щанга 38339 Nissan X-Trail (2001-2013)[T30] 56261-50J00',
  'Предпазител Febest 88570-102 TOYOTA FJ CRUISER GSJ1',
  'Заден лагер Peugeot 306 1993-2003 7B, N3, N5,7A,7C,7D,7E',
  '200W GaN3 зарядна станция 6 порта 1x 100W USB-C, 2 X 20W USB-C',
  '285W GaN3 зарядна станция 6 порта 2x 100W USB-C, 1 X 65W USB-C',
  'Маслен охладител, Ford Fiesta Tourneo Transit Focus Mk1 1.8',
  'Таблет Blackview Rugged Tab Active 10 Pro, 512GB, 12GB RAM',
];

/** The real listing, as kris06.bg writes it. */
const REAL = 'Полирмашина вибрационна Status HD XPA12-75, 750W, ф50мм/ф75мм';

const judge = (query: string, titles: string[]) =>
  partitionByVerdict(titles.map((name) => ({ name, match: matchNames(query, name) })));

describe('what a supplier returned versus what a buyer may be quoted', () => {
  it('returns NO_MATCH when a shop answers with a recommendation shelf', () => {
    const verdict = judge('STATUS XPA12-75', EMAG_SHELF);

    expect(verdict.status).toBe('NO_MATCH');
    expect(verdict.matches).toHaveLength(0);
    expect(verdict.alternatives).toHaveLength(0);
    expect(verdict.rejected).toHaveLength(EMAG_SHELF.length);
  });

  it('never lets a priced candidate become an offer on price alone', () => {
    // Each of the eight carries a real price and a real product URL. Neither
    // is evidence about the article, and this is the invariant the whole fix
    // rests on: raw candidates must not produce offers whatever they carry.
    const verdict = judge('STATUS XPA12-75', EMAG_SHELF);
    expect([...verdict.matches, ...verdict.alternatives]).toHaveLength(0);
  });

  it('finds the article when a supplier actually stocks it', () => {
    const verdict = judge('STATUS XPA12-75', [...EMAG_SHELF, REAL]);

    expect(verdict.status).toBe('MATCH');
    expect(verdict.matches.map((row) => row.name)).toEqual([REAL]);
    expect(verdict.rejected).toHaveLength(EMAG_SHELF.length);
  });

  it('reads the model code through the spelling the shop chose', () => {
    // One catalogue writes the hyphen, another a space, a third a slash. They
    // are one part number, and a buyer who typed one of the three is asking
    // about all of them.
    for (const spelling of ['STATUS XPA12-75', 'Status HD XPA12-75 750W']) {
      expect(judge('STATUS XPA12-75', [spelling]).status).toBe('MATCH');
    }
  });

  it('does not call a near model number a match', () => {
    // XPA12-65 is a different machine. It may be worth showing one day, and
    // it is never the answer to a question about the 75.
    const verdict = judge('STATUS XPA12-75', ['Полирмашина Status XPA12-65, 750W']);
    expect(verdict.matches).toHaveLength(0);
  });

  it('refuses a stated difference in a specification', () => {
    // The cases a buyer would notice on delivery and we would rather notice
    // first. Each is a conflict, and a conflict is not a low score.
    const pairs: Array<[string, string]> = [
      ['кабел СВТ 3x2.5', 'кабел СВТ 3x1.5'],
      ['предпазител 16A', 'предпазител 25A'],
      ['захранване 24V', 'захранване 12V'],
      ['луна GU10', 'луна E27'],
    ];

    for (const [query, candidate] of pairs) {
      expect(judge(query, [candidate]).status).toBe('NO_MATCH');
    }
  });

  it('matches a specification stated the same way on both sides', () => {
    expect(judge('кабел СВТ 3x2.5', ['Кабел СВТ 3х2.5 мм²']).status).toBe('MATCH');
  });

  it('rejects a row the matcher never judged', () => {
    // Absence of a verdict is not permission. A row that reached the response
    // without being matched used to be rendered like any other.
    const verdict = partitionByVerdict([{ name: 'unjudged', match: undefined }]);
    expect(verdict.status).toBe('NO_MATCH');
    expect(verdict.rejected).toHaveLength(1);
  });

  it('refuses a candidate that cannot show the part number', () => {
    // The failure this rung was written for. A screen protector shares a word
    // or two with the query and nothing that identifies an article; the old
    // ladder fell through to text similarity, reached 0.84, and cleared the
    // floor.
    for (const candidate of [
      'Защитно фолио от стъкло за iPad Pro 12.9 (2020), 9H твърдост',
      'Защитно фолио от стъкло за iPad 10.2 2019/2020/2021, Status Glass',
      'Защитно стъкло за таблет iPad 75',
    ]) {
      const verdict = judge('STATUS XPA12-75', [candidate]);
      expect(verdict.status).toBe('NO_MATCH');
      expect(verdict.rejected).toHaveLength(1);
      expect(verdict.rejected[0].match!.relation).toBe('unrelated');
    }
  });

  it('reads the part number through whatever punctuation a shop used', () => {
    for (const spelling of ['STATUS XPA12/75', 'STATUS XPA12 75', 'XPA1275 полирмашина']) {
      expect(judge('STATUS XPA12-75', [spelling]).status).toBe('MATCH');
    }
  });
});

describe('best offer', () => {
  const priced = (name: string, price: number, query = 'STATUS XPA12-75') => ({
    name,
    effectivePrice: price,
    match: matchNames(query, name),
  });

  it('cannot be won by something that is not the article', () => {
    // 8.94 € against 114.99 €, and the cheap one is a screen protector. The
    // arithmetic is right and the answer is wrong, which is why the arithmetic
    // is never shown both rows.
    const rows = [
      priced('Защитно фолио от стъкло за iPad Pro 12.9', 8.94),
      priced('Полирмашина вибрационна Status HD XPA12-75, 750W, ф50мм/ф75мм', 114.99),
    ];

    const verdict = partitionByVerdict(rows);
    const best = bestOffer(verdict.matches);

    expect(verdict.matches).toHaveLength(1);
    expect(best?.effectivePrice).toBe(114.99);
    expect(best?.name).toContain('XPA12-75');
  });

  it('picks the cheapest when three suppliers stock the same article', () => {
    const rows = [
      priced('Полирмашина Status HD XPA12-75, 750W', 118.2),
      priced('Status XPA12-75 полирмашина 750W', 114.99),
      priced('Полирмашина вибрационна STATUS XPA12/75', 117.05),
    ];

    const verdict = partitionByVerdict(rows);

    expect(verdict.status).toBe('MATCH');
    expect(verdict.matches).toHaveLength(3);
    expect(bestOffer(verdict.matches)?.effectivePrice).toBe(114.99);
  });

  it('has no offer to make when nothing matched', () => {
    const rows = EMAG_SHELF.map((name, index) => priced(name, index + 1));
    const verdict = partitionByVerdict(rows);

    expect(verdict.status).toBe('NO_MATCH');
    expect(verdict.matches).toHaveLength(0);
    expect(bestOffer(verdict.matches)).toBeNull();
  });
});
