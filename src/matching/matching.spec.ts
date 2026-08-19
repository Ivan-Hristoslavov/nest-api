import { confidenceBand, matchNames } from './deterministic-matcher';
import { extractAttributes, suggestCorrection } from './attributes';
import { measurementsOf, normaliseProductName, similarity } from './normalisation';

/**
 * The matcher decides whether two suppliers are selling the same thing. Both
 * ways of being wrong cost the customer money: a missed match hides the
 * cheaper supplier, and a false match tells them a 256 GB phone is available
 * at the 128 GB price. These pin the second kind hardest — it is the one that
 * ends in a wrong order.
 */
describe('deterministic product matching', () => {
  describe('normalisation', () => {
    it('reads the same measurement however it is spelled', () => {
      expect(normaliseProductName('LED 12 watt E27')).toBe('led 12w e27');
      expect(normaliseProductName('LED 12W Е27')).toBe('led 12w e27');
      expect(normaliseProductName('LED 12 W e27')).toBe('led 12w e27');
      expect(normaliseProductName('LED 12вата Е27')).toBe('led 12w e27');
    });

    it('canonicalises colour temperature', () => {
      expect(measurementsOf('4000 Kelvin')).toEqual([{ value: 4000, unit: 'K' }]);
      expect(measurementsOf('4000K')).toEqual([{ value: 4000, unit: 'K' }]);
    });

    it('folds the Cyrillic letters that look Latin', () => {
      // Shops write Е27 in Cyrillic about half the time; buyers type it in Latin.
      expect(normaliseProductName('Е27')).toBe(normaliseProductName('E27'));
    });

    it('weighs the specification above the marketing words', () => {
      const specific = similarity('LED bulb 12W E27', 'LED bulb 12W E27 warm');
      const vague = similarity('LED bulb 12W E27', 'LED bulb 15W E14');
      expect(specific).toBeGreaterThan(vague);
    });
  });

  describe('the ladder', () => {
    it('matches on a checksum-valid barcode without looking further', () => {
      const verdict = matchNames(
        'Philips LED 12W E27 5410288888880',
        'CorePro крушка 5410288888880',
      );

      expect(verdict.method).toBe('gtin');
      expect(verdict.confidence).toBe(1);
      expect(verdict.needsAi).toBe(false);
    });

    it('ignores a 13-digit run that is not a barcode', () => {
      // Order numbers look exactly like EANs. Trusting one as a barcode is the
      // worst possible error, because a barcode skips every other check.
      const attributes = extractAttributes('Philips LED 1234567890123');
      expect(attributes.gtins).toHaveLength(0);
    });

    it('matches on a shared model code', () => {
      const verdict = matchNames('кабел H05V-K 1x1.5', 'Кабел H05V-K черен');
      expect(verdict.method).toBe('model');
      expect(verdict.needsAi).toBe(false);
    });

    it('matches on brand plus two agreeing specifications', () => {
      const verdict = matchNames('Philips LED 12W E27 4000K', 'PHILIPS LED BULB 12W E27 4000K');

      expect(verdict.confidence).toBeGreaterThanOrEqual(0.9);
      expect(verdict.blocked).toBe(false);
      expect(verdict.needsAi).toBe(false);
    });
  });

  describe('the matches that must not happen', () => {
    it('keeps 128 GB and 256 GB apart', () => {
      const verdict = matchNames('iPhone 15 128GB', 'iPhone 15 256GB');

      expect(verdict.blocked).toBe(true);
      expect(verdict.confidence).toBe(0);
      // Never worth a model: arithmetic already answered.
      expect(verdict.needsAi).toBe(false);
    });

    it('keeps a 55-inch television apart from a 65-inch one', () => {
      const verdict = matchNames('Samsung TV 55" 4K', 'Samsung TV 65" 4K');
      expect(verdict.blocked).toBe(true);
    });

    it('keeps two wattages apart even when every other word agrees', () => {
      const verdict = matchNames('Philips LED bulb 12W E27', 'Philips LED bulb 15W E27');
      expect(verdict.blocked).toBe(true);
    });

    it('keeps two cable cross-sections apart', () => {
      const verdict = matchNames('КАБЕЛ СВТ 3x1.5', 'КАБЕЛ СВТ 5x4');
      expect(verdict.blocked).toBe(true);
    });

    it('keeps two brands apart', () => {
      const verdict = matchNames('Philips LED 12W E27', 'Osram LED 12W E27');
      expect(verdict.blocked).toBe(true);
    });
  });

  describe('what only a model can settle', () => {
    it('does not reject a supplier who states less than the buyer asked', () => {
      // "840" encodes 4000K and 80 CRI. Nothing deterministic knows that, but
      // silence must not be read as disagreement.
      const verdict = matchNames('Philips LED 12W E27 4000K', 'Philips CorePro LED 12W 840 E27');

      expect(verdict.blocked).toBe(false);
      expect(verdict.confidence).toBeGreaterThan(0);
    });

    it('flags a plausible but unproven pair for a second opinion', () => {
      const verdict = matchNames('Philips LED 12W E27 4000K', 'LED E27 Philips 12W Neutral White');

      expect(verdict.blocked).toBe(false);
      expect(verdict.needsAi || verdict.confidence >= 0.9).toBe(true);
    });
  });

  describe('languages', () => {
    // Supplier catalogues are written in the supplier's language, and the
    // buyer types in theirs. The specification is written in digits in every
    // language, which is what makes matching across them possible at all.
    const listings = [
      'LED bulb 12W E27 4000K',
      'LED Lampe 12W E27 neutralweiss',
      'LED крушка 12W Е27 неутрална',
      'ampoule LED 12W E27 blanc neutre',
    ];

    it.each(listings)('does not rule out %s for a Bulgarian query', (listing) => {
      const verdict = matchNames('LED крушка 12W Е27 4000K', listing);

      expect(verdict.blocked).toBe(false);
      expect(verdict.confidence).toBeGreaterThanOrEqual(0.6);
    });

    it.each(listings)('does not rule out %s for an English query', (listing) => {
      const verdict = matchNames('LED bulb 12W E27 4000K', listing);
      expect(verdict.blocked).toBe(false);
    });

    it('still separates two wattages across languages', () => {
      const verdict = matchNames('LED крушка 12W Е27', 'LED Lampe 15W E27');
      expect(verdict.blocked).toBe(true);
    });
  });

  describe('spelling', () => {
    it('suggests the brand somebody meant', () => {
      expect(suggestCorrection('iphnoe 15')).toBe('iphone 15');
      expect(suggestCorrection('phlips led 12w')).toBe('philips led 12w');
    });

    it('leaves alone what it does not recognise', () => {
      // "СВТ" is a real cable type. A spell checker that helpfully turns it
      // into a word hides the article somebody was looking for.
      expect(suggestCorrection('кабел свт 3x1.5')).toBeNull();
      expect(suggestCorrection('philips led 12w e27')).toBeNull();
    });
  });

  describe('confidence bands', () => {
    it('labels the bands the interface promises', () => {
      expect(confidenceBand(0.96)).toBe('certain');
      expect(confidenceBand(0.88)).toBe('high');
      expect(confidenceBand(0.75)).toBe('possible');
      expect(confidenceBand(0.5)).toBe('weak');
    });
  });
});
