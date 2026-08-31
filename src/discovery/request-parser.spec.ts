import { parseLine, parseRequest } from './request-parser';

/**
 * A buyer does not fill in a form. They paste a line out of an email or a
 * column out of a spreadsheet, and every way they might have written it has to
 * arrive as the same order.
 */
describe('reading a purchase request', () => {
  describe('one line', () => {
    it('takes a quantity written after a comma', () => {
      expect(parseLine('СВТ 3x2.5, 100')).toEqual({
        query: 'СВТ 3x2.5',
        quantity: 100,
        unit: null,
      });
    });

    it('takes a quantity with the unit they counted in', () => {
      expect(parseLine('кабел СВТ 3х2.5, 100м')).toMatchObject({
        query: 'кабел СВТ 3х2.5',
        quantity: 100,
        unit: 'м',
      });
    });

    it('takes a count written as pieces', () => {
      expect(parseLine('LED лампа 9W, 10бр')).toMatchObject({
        query: 'LED лампа 9W',
        quantity: 10,
      });
      expect(parseLine('LED лампа 9W 10 бр.')).toMatchObject({
        query: 'LED лампа 9W',
        quantity: 10,
      });
    });

    it('takes a count written in front', () => {
      expect(parseLine('10 x LED лампа 9W')).toMatchObject({ query: 'LED лампа 9W', quantity: 10 });
      expect(parseLine('20 х кабел 2м')).toMatchObject({ quantity: 20 });
    });

    it('does not read a specification as a quantity', () => {
      // The expensive mistake in the other direction: nine lamps instead of a
      // nine-watt lamp, and the buyer is quoted for the wrong thing entirely.
      expect(parseLine('LED лампа 9W')).toEqual({ query: 'LED лампа 9W', quantity: 1, unit: null });
      expect(parseLine('СВТ 3x2.5')).toEqual({ query: 'СВТ 3x2.5', quantity: 1, unit: null });
      expect(parseLine('автоматичен предпазител 16A')).toMatchObject({ quantity: 1 });
      expect(parseLine('кабел 100м')).toMatchObject({ query: 'кабел 100м', quantity: 1 });
    });

    it('leaves a bare article alone', () => {
      expect(parseLine('крушка')).toEqual({ query: 'крушка', quantity: 1, unit: null });
    });
  });

  describe('a whole request', () => {
    it('reads a list somebody pasted', () => {
      const request = parseRequest('СВТ 3x2.5, 100м\nСВТ 3x1.5, 50м\nLED лампа 9W, 10бр');

      expect(request).toHaveLength(3);
      expect(request.map((line) => line.query)).toEqual(['СВТ 3x2.5', 'СВТ 3x1.5', 'LED лампа 9W']);
      expect(request.map((line) => line.quantity)).toEqual([100, 50, 10]);
    });

    it('treats a semicolon as a line break typed sideways', () => {
      expect(parseRequest('кабел 3x1.5; лампа 9W').map((line) => line.query)).toEqual([
        'кабел 3x1.5',
        'лампа 9W',
      ]);
    });

    it('ignores blank lines and stray separators', () => {
      expect(parseRequest('\n\nкабел 3x1.5\n\n   \n')).toHaveLength(1);
    });

    it('reads a single article as a request of one', () => {
      expect(parseRequest('СВТ 3x2.5 100м')).toEqual([
        { query: 'СВТ 3x2.5 100м', quantity: 1, unit: null },
      ]);
    });

    it('will not accept a request longer than an order', () => {
      const long = Array.from({ length: 200 }, (_, index) => `артикул ${index}`).join('\n');
      expect(parseRequest(long).length).toBeLessThanOrEqual(60);
    });
  });
});
