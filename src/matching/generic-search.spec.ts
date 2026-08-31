import { interpret } from './interpretation';
import { matchNames } from './deterministic-matcher';
import { attributeMap } from './product-model';
import { facetsOf } from './matching.service';
import { expandQuery, fallbackFor } from './query-expansion';
import { relate } from './relate';

/**
 * The point of the whole exercise: a buyer types what they mean, in their own
 * trade's words, and finds the article however their supplier chose to write
 * it — without anybody having written a rule about their trade.
 *
 * These are test cases, not domain logic. Nothing in `src/matching` branches
 * on any of the industries below; if adding a domain here required adding a
 * branch there, the architecture would have failed.
 */

const query = (text: string) => interpret(text);

describe('reading a product out of any industry', () => {
  it('reads memory and storage from an IT listing', () => {
    const product = query('Lenovo laptop 16GB 512 SSD');

    expect(product.brand).toBe('lenovo');
    expect(product.productType?.canonical).toBe('laptop');
    expect(attributeMap(product).storage.value).toBe('512 GB');
  });

  it('reads a bore and a length from a plumbing listing', () => {
    const product = query('PVC-U pipe DN50 x 4000 mm');
    const lengths = product.attributes.filter((a) => a.kind === 'length');

    expect(product.productType?.canonical).toBe('pipe');
    expect(lengths.map((a) => a.quantity!.base).sort((a, b) => a - b)).toEqual([0.05, 4]);
  });

  it('reads a format, a grammage and a pack size from an office listing', () => {
    const product = query('Copy paper A4 80 g/m², 500 sheets');
    const map = attributeMap(product);

    expect(product.productType?.canonical).toBe('paper');
    expect(map.paper_format.value).toBe('A4');
    expect(map.grammage.normalizedValue).toBe(80);
    expect(map.package_quantity.value).toBe('500 pcs');
  });

  it('reads a volume and a pack size from a catering listing', () => {
    const map = attributeMap(query('Disposable cups 0.25L x 100'));

    expect(map.volume.normalizedValue).toBe(0.25);
    expect(map.package_quantity.value).toBe('100 pcs');
  });

  it('reads a thread as a fitting and as two lengths', () => {
    const map = attributeMap(query('steel bolt M8 x 50 galvanized'));

    expect(map.thread.value).toBe('M8X50');
    expect(map.diameter.normalizedValue).toBe(0.008);
    expect(map.length.normalizedValue).toBe(0.05);
    expect(map.material.value).toBe('steel');
  });

  it('reads a platform code and a fitting position from an automotive listing', () => {
    const product = query('BMW F30 brake pads front');

    expect(product.brand).toBe('bmw');
    expect(product.identifiers.designators).toContain('F30');
    expect(product.productType?.canonical).toBe('brake_pad');
    expect(attributeMap(product).position.value).toBe('front');
  });

  it('separates what the buyer wants from what the article is', () => {
    // Section 14: "20 x USB cable 2m" is a two-metre cable, twenty times.
    const product = query('20 x USB cable 2m');

    expect(product.requestedQuantity).toBe(20);
    expect(attributeMap(product).length.value).toBe('2 m');
  });

  it('does not read a measurement out of a part number', () => {
    // "H05V-K" is a cable type. Read as five volts, the code is eaten with it.
    expect(query('кабел H05V-K 1x1.5').identifiers.modelCodes).toEqual(['H05V-K']);
  });
});

describe('finding the article across the words a supplier chose', () => {
  const cases: Array<[string, string, string]> = [
    ['IT', 'laptop lenovo 16gb 512gb', 'Lenovo ThinkPad 16G RAM 512G NVMe'],
    ['plumbing', 'PVC pipe 50mm 4m', 'PVC-U pipe DN50 x 4000 mm'],
    ['office', 'A4 copy paper 80gsm 500 sheets', 'Copy paper A4 80 g/m², 500 sheets'],
    ['hospitality', 'coffee cups 250ml 100 pieces', 'Disposable cups 0.25L x 100'],
    ['electronics', 'USB C charger 65W', 'PD GaN charger Type-C 65 Watt'],
    ['electrical', 'LED крушка Philips 12W E27 4000K', 'PHILIPS LED BULB 12W E27 4000K'],
  ];

  it.each(cases)('%s: "%s" finds "%s"', (_domain, asked, listed) => {
    const verdict = matchNames(asked, listed);

    expect(verdict.blocked).toBe(false);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.7);
    expect(['same_product', 'compatible']).toContain(verdict.relation);
  });

  it('survives a different word order', () => {
    expect(matchNames('PVC pipe 50mm 4m', '4000mm PVC-U 50mm pipe').blocked).toBe(false);
  });

  it('survives a query typed in a different script', () => {
    expect(matchNames('лед крушка 12W Е27', 'LED bulb 12W E27').confidence).toBeGreaterThanOrEqual(
      0.7,
    );
  });

  it('survives a typo in a brand, by offering the correction rather than applying it', () => {
    // The search still runs as typed: a wholesale catalogue is full of strings
    // that look like typos and are article codes.
    const verdict = matchNames('iphnoe 15 128gb', 'Apple iPhone 15 128GB');
    expect(verdict.blocked).toBe(false);
  });
});

describe('the matches that must not happen, in any industry', () => {
  const conflicts: Array<[string, string, string]> = [
    ['storage', 'SSD 128GB', 'SSD 256GB'],
    ['bore', 'PVC pipe 50mm', 'PVC pipe 75mm'],
    ['power', 'charger 65W USB-C', 'charger 45W USB-C'],
    ['grammage', 'A4 paper 80gsm', 'A4 paper 120gsm'],
    ['volume', 'cups 250ml', 'cups 400ml'],
    ['brand', 'Philips LED 12W E27', 'Osram LED 12W E27'],
  ];

  it.each(conflicts)('refuses a %s difference', (_what, asked, listed) => {
    const verdict = matchNames(asked, listed);

    expect(verdict.blocked).toBe(true);
    expect(verdict.relation).toBe('conflict');
    expect(verdict.conflicts.length).toBeGreaterThan(0);
    // Never worth a model: arithmetic already answered.
    expect(verdict.needsAi).toBe(false);
  });

  it('refuses a part that fits the wrong end of the car', () => {
    expect(matchNames('BMW F30 brake pads front', 'BMW F30 brake pads rear').blocked).toBe(true);
  });
});

describe('missing is not conflicting', () => {
  it('keeps a terser listing in the running and says what is unknown', () => {
    const verdict = matchNames('laptop 16GB 512GB', 'Laptop 16GB RAM');

    expect(verdict.blocked).toBe(false);
    expect(verdict.missingAttributes.some((entry) => entry.query === '512 GB')).toBe(true);
    expect(verdict.conflicts).toHaveLength(0);
  });

  it('does not invent a disagreement about a bore nobody stated', () => {
    const verdict = matchNames('PVC pipe 50mm 4m', 'PVC-U pipe 4 m');
    expect(verdict.blocked).toBe(false);
  });
});

describe('variants and families', () => {
  it('calls two capacities of one phone a family rather than a match', () => {
    const verdict = matchNames('iPhone 15 128GB', 'iPhone 15 256GB');
    expect(verdict.blocked).toBe(true);
  });

  it('treats a colour the buyer asked for as something that can clash', () => {
    // Section 13: do not assume colour is always irrelevant, and do not assume
    // it is always identity. The buyer stating it is what makes it matter.
    const verdict = matchNames('office chair black', 'office chair white');

    expect(verdict.relation).toBe('same_type');
    expect(verdict.blocked).toBe(false);
    expect(verdict.confidence).toBeLessThan(0.7);
  });

  it('does not hold a colour against a listing the buyer never mentioned one to', () => {
    expect(matchNames('office chair', 'office chair white').blocked).toBe(false);
  });
});

describe('packaging', () => {
  it('reads a pack size without letting it identify the article', () => {
    const verdict = matchNames('cups 250ml', 'cups 250ml x 100');

    expect(verdict.blocked).toBe(false);
    expect(verdict.missingAttributes.some((entry) => entry.key === 'package_quantity')).toBe(true);
  });
});

describe('compatible parts', () => {
  it('recognises an aftermarket part made to fit what was asked for', () => {
    const verdict = relate(
      interpret('BMW F30 brake pads front'),
      interpret('Brembo brake pad set BMW F30 front axle'),
    );

    expect(verdict.relation).toBe('compatible');
    expect(verdict.blocked).toBe(false);
  });
});

describe('widening a query for a supplier that answered nothing', () => {
  it("always keeps the buyer's own words first", () => {
    const variants = expandQuery('PVC pipe 50mm 4m', query('PVC pipe 50mm 4m'));

    expect(variants[0]).toEqual({
      query: 'PVC pipe 50mm 4m',
      kind: 'original',
      reason: 'as the buyer typed it',
    });
  });

  it('offers the shelf when the exact question found nothing', () => {
    const variants = expandQuery('PVC pipe 50mm 4m', query('PVC pipe 50mm 4m'));
    expect(variants.map((variant) => variant.kind)).toContain('broad');
    expect(fallbackFor(variants)?.kind).not.toBe('original');
  });

  it('prefers a code, which is the narrowest question a shop can answer', () => {
    const asked = 'кабел H05V-K 1x1.5';
    expect(fallbackFor(expandQuery(asked, query(asked)))).toMatchObject({
      kind: 'identifier',
      query: 'H05V-K',
    });
  });

  it('never proposes more than a handful', () => {
    const asked = 'Philips LED крушка 12W E27 4000K';
    expect(expandQuery(asked, query(asked)).length).toBeLessThanOrEqual(4);
  });

  it('has nothing to widen when the query is already a bare noun', () => {
    // "лампа" is as broad as a question gets. A wider one would be no question.
    expect(expandQuery('лампа', query('лампа'))).toHaveLength(1);
  });
});

describe('the filters a search offers', () => {
  const shelf = [
    'PVC-U pipe DN50 x 4000 mm',
    'PVC-U pipe DN75 x 4000 mm',
    'PVC-U pipe DN110 x 2000 mm',
  ];

  it('offers what the results actually vary in, not a list written in advance', () => {
    const candidates = shelf.map((name, index) => ({
      id: String(index),
      name,
      supplier: 'Склад',
    }));

    const interpreted = new Map(candidates.map((c) => [c.id, interpret(c.name)]));
    const verdicts = new Map(candidates.map((c) => [c.id, matchNames('PVC pipe', c.name)]));

    const facets = facetsOf(candidates, interpreted, verdicts);
    const keys = facets.map((facet) => facet.key);

    // Nobody declared that pipes have a bore. These are the attributes these
    // three listings turned out to state more than one value for.
    expect(keys).toContain('length');
    expect(facets.find((facet) => facet.key === 'length')!.values.length).toBeGreaterThan(1);
  });

  it('offers nothing when every result says the same thing', () => {
    const candidates = [
      { id: '0', name: 'PVC-U pipe DN50 x 4000 mm', supplier: 'A' },
      { id: '1', name: 'PVC-U pipe DN50 x 4000 mm', supplier: 'B' },
    ];

    const interpreted = new Map(candidates.map((c) => [c.id, interpret(c.name)]));
    const verdicts = new Map(candidates.map((c) => [c.id, matchNames('PVC pipe', c.name)]));

    expect(facetsOf(candidates, interpreted, verdicts)).toHaveLength(0);
  });
});
