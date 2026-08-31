import { BASE_UNIT, convert, formatQuantity, quantityOf, sameQuantity, unitFor } from './units';

/**
 * The conversion layer is the floor everything else stands on. If a metre and
 * a thousand millimetres are not the same length here, no amount of clever
 * matching above will make a plumber's query find a plumber's pipe.
 */
describe('unit conversion', () => {
  const base = (value: number, unit: string): number | undefined => quantityOf(value, unit)?.base;

  describe('length', () => {
    it('reduces every spelling of a length to one number', () => {
      expect(base(100, 'cm')).toBe(1);
      expect(base(1, 'm')).toBe(1);
      expect(base(1000, 'mm')).toBe(1);
      expect(base(1, 'метър')).toBe(1);
    });

    it('reads inches however the shop wrote them', () => {
      expect(base(27, 'inch')).toBeCloseTo(0.6858, 4);
      expect(base(27, '"')).toBeCloseTo(0.6858, 4);
      expect(base(27, 'цола')).toBeCloseTo(0.6858, 4);
      expect(base(27, 'zoll')).toBeCloseTo(0.6858, 4);
    });
  });

  describe('volume', () => {
    it('makes 250ml and 0.25L one measurement', () => {
      expect(base(250, 'ml')).toBe(0.25);
      expect(base(0.25, 'l')).toBe(0.25);
      expect(base(0.25, 'литра')).toBe(0.25);
    });
  });

  describe('mass', () => {
    it('makes 1000g and 1kg one measurement', () => {
      expect(base(1000, 'g')).toBe(1);
      expect(base(1, 'kg')).toBe(1);
      expect(base(1, 'кг')).toBe(1);
    });
  });

  describe('data', () => {
    it('quotes a terabyte the way the box does', () => {
      // 1000, not 1024: matching the number printed on the box matters more
      // here than matching the one the operating system reports.
      expect(base(1, 'TB')).toBe(1000);
      expect(base(512, 'GB')).toBe(512);
    });
  });

  describe('ambiguous spellings', () => {
    it('reads "g" as grams by default and as gigabytes when told', () => {
      expect(unitFor('g')?.kind).toBe('mass');
      expect(unitFor('g', 'data')?.canonical).toBe('GB');
      expect(quantityOf(16, 'g', 'data')?.base).toBe(16);
    });

    it('keeps colour temperature out of the thermostat', () => {
      // Physically one dimension, semantically two. 4000 K is what a lamp
      // looks like; 40 °C is what a room feels like.
      expect(unitFor('k')?.kind).toBe('colour_temperature');
      expect(unitFor('°c')?.kind).toBe('temperature');
      expect(sameQuantity(quantityOf(4000, 'k')!, quantityOf(4000, '°c')!)).toBe(false);
    });

    it('refuses spellings that are ordinary words', () => {
      // "500 in stock" read as five hundred inches is a worse mistake than
      // missing the listings that abbreviate inches that way.
      expect(unitFor('in')).toBeNull();
      expect(unitFor('s')).toBeNull();
    });
  });

  describe('comparison', () => {
    it('treats a rounding difference as agreement and a real one as not', () => {
      expect(sameQuantity(quantityOf(1, 'm')!, quantityOf(1000, 'mm')!)).toBe(true);
      expect(sameQuantity(quantityOf(50, 'mm')!, quantityOf(75, 'mm')!)).toBe(false);
      expect(sameQuantity(quantityOf(128, 'GB')!, quantityOf(256, 'GB')!)).toBe(false);
    });

    it('never compares across dimensions', () => {
      expect(sameQuantity(quantityOf(1, 'm')!, quantityOf(1, 'l')!)).toBe(false);
    });
  });

  it('converts back into whatever unit a reader wants', () => {
    expect(convert(quantityOf(4000, 'mm')!, 'm')?.value).toBe(4);
    expect(convert(quantityOf(0.25, 'l')!, 'ml')?.value).toBe(250);
    expect(convert(quantityOf(1, 'm')!, 'kg')).toBeNull();
  });

  it('writes a measurement the way a person would', () => {
    expect(formatQuantity(quantityOf(12, 'watt')!)).toBe('12 W');
    expect(formatQuantity(quantityOf(27, 'inch')!)).toBe('27"');
    expect(BASE_UNIT.length).toBe('m');
  });
});
