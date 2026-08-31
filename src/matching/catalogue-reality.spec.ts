import { interpret } from './interpretation';
import { matchNames } from './deterministic-matcher';
import { expandQuery, fallbackFor, respell } from './query-expansion';

/**
 * The failures a live catalogue produced, pinned so they cannot come back.
 *
 * Every case below was seen on real supplier titles, and each one ended the
 * same way: a search that returned nothing to a buyer whose suppliers stocked
 * the article. They are here rather than in the domain matrix because they are
 * not about domains — they are about the three ways a wholesale catalogue
 * writes a size.
 */
describe('a size, spelled the four ways the trade spells it', () => {
  it('reads one cross-section out of every spelling of it', () => {
    const spellings = ['Кабел 3x1.5', 'Кабел 3x1.5mm', 'Кабел СВТ 3x1.5 мм²', 'Кабел 3х1,5'];

    for (const spelling of spellings) {
      const section = interpret(spelling).attributes.find(
        (attribute) => attribute.key === 'cross_section',
      );

      // The value carries no unit. One shop writes "3x1.5", the next
      // "3x1.5mm", the third "3x1.5 мм²" — one cable, and keeping the unit in
      // the value made them three different articles.
      expect(section?.value).toBe('3X1.5');
    }
  });

  it('matches a cable however either side spelled the size', () => {
    const verdict = matchNames('кабел 3x1.5 мм2', 'Кабел СВТ 3x1.5 мм² бял');

    expect(verdict.blocked).toBe(false);
    expect(verdict.relation).toBe('same_product');
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('still keeps two different cross-sections apart', () => {
    for (const other of ['Кабел ПВВМБ 2x1mm', 'Кабел СВТ 2x2.5mm', 'Кабел 2x4mm']) {
      expect(matchNames('кабел 2x1.5', other).blocked).toBe(true);
    }
  });

  it('does not read a cross-section as two lengths', () => {
    // "2x2.5mm" is a cable's cores and section. Read as a 2 mm length and a
    // 2.5 mm one, it contradicted every listing that stated a real length and
    // filled the filters with sizes nobody could choose on.
    const lengths = interpret('Кабел СВТ 2x2.5mm').attributes.filter(
      (attribute) => attribute.kind === 'length',
    );

    expect(lengths.every((attribute) => attribute.role === 'descriptive')).toBe(true);
  });

  it('never lets a size spelled inside a group refuse a match', () => {
    // The candidate's "3x1.5mm" holds a 3 and a 1.5; the query states a real
    // 100 m drum. Those are not in disagreement — one of them is not a length.
    const verdict = matchNames('кабел 3x1.5 100m', 'Кабел СВТ 3x1.5mm 100 m');

    expect(verdict.blocked).toBe(false);
    expect(verdict.conflicts).toHaveLength(0);
  });

  it('reads "1x24W" as one panel of twenty-four watts, not as a size', () => {
    const panel = interpret('LED панел 1x24W IP54');

    expect(panel.attributes.find((a) => a.key === 'power')?.value).toBe('24W');
    expect(panel.attributes.find((a) => a.key === 'package_quantity')?.value).toBe('1pcs');
    expect(panel.attributes.some((a) => a.key === 'cross_section')).toBe(false);
  });
});

describe('what the buyer asked for, and whether it is satisfied', () => {
  it('matches a listing that answers the only thing the query stated', () => {
    // Counting agreements could never do this: the query states one thing, so
    // it could never reach two, and the right answer scored below the floor
    // while a chatty wrong one scored above it.
    const verdict = matchNames('кабел 3x1.5', 'Кабел NYM 3x1.5mm медни жила');

    expect(verdict.relation).toBe('same_product');
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('will not call it a match while something asked for is unanswered', () => {
    const verdict = matchNames('PVC pipe 50mm 4m', 'PVC-U pipe 4 m');

    expect(verdict.relation).not.toBe('same_product');
    expect(verdict.blocked).toBe(false);
    expect(verdict.missingAttributes.length).toBeGreaterThan(0);
  });

  it('ignores a brand the buyer never named', () => {
    // Somebody who types a specification and no manufacturer is asking for the
    // specification. Two makers who both meet it are both answers.
    const verdict = matchNames('кабел 3x1.5', 'Кабел СВТ 3x1.5 Булкабел');
    expect(verdict.relation).toBe('same_product');
  });
});

describe('asking a supplier the question it can answer', () => {
  it('offers the size spelled the way this market writes it', () => {
    // Cyrillic х, decimal comma. A shop's search is a LIKE over the title, and
    // the two strings share not one byte.
    expect(respell('кабел 3x1.5')).toBe('кабел 3х1,5');
    expect(respell('кабел 3х1,5')).toBe('кабел 3x1.5');
    expect(respell('laptop 16gb')).toBeNull();
  });

  it('reaches for the other spelling before it reaches for the shelf', () => {
    const variants = expandQuery('кабел 2x1.5', interpret('кабел 2x1.5'));

    expect(fallbackFor(variants)).toMatchObject({ kind: 'spelling', query: 'кабел 2х1,5' });
  });

  it('offers the size on its own, which shops index even when the name differs', () => {
    // "СВТ", "ПВВМБ" and "NYM" are one cable to somebody who asked for 3x1.5.
    const variants = expandQuery('кабел 3x1.5', interpret('кабел 3x1.5'));

    expect(variants.map((variant) => variant.query)).toContain('3x1.5');
  });

  it("still asks the buyer's own words first, and only a handful in all", () => {
    const variants = expandQuery('кабел 3x1.5', interpret('кабел 3x1.5'));

    expect(variants[0].kind).toBe('original');
    expect(variants.length).toBeLessThanOrEqual(4);
  });
});

describe('a product code is the strongest thing a query can carry', () => {
  it('finds the article whichever way the shop punctuated the code', () => {
    // "XPA12-75", "XPA12 75" and "XPA12/75" are one part number written by
    // three people, and punctuation carries no meaning in a part number.
    const spellings = ['STATUS XPA12 75', 'Status XPA12/75', 'STATUS XPA12-75 контактор'];

    for (const listing of spellings) {
      const verdict = matchNames('STATUS XPA12-75', listing);
      expect(verdict.blocked).toBe(false);
      expect(verdict.confidence).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('does not let a similar code pass as the same one', () => {
    const verdict = matchNames('STATUS XPA12-75', 'STATUS XPA12-95');
    expect(verdict.confidence).toBeLessThan(0.9);
  });

  it('reads a bare product code as an identifier rather than as words', () => {
    const product = interpret('STATUS XPA12-75');
    expect(product.identifiers.modelCodes).toContain('XPA12-75');
  });

  it('asks a supplier the code on its own when the full query found nothing', () => {
    // A shop's search is reliably good at one thing, and this is it.
    const asked = 'STATUS XPA12-75';
    expect(fallbackFor(expandQuery(asked, interpret(asked)))).toMatchObject({
      kind: 'identifier',
      query: 'XPA12-75',
    });
  });
});
