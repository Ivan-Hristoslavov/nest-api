import { numericTransformer } from './numeric-column.transformer';

/**
 * The difference between "no value" and "the value null".
 *
 * These look alike in JavaScript and are opposites to a database. `undefined`
 * means *this column was not mentioned*, and TypeORM answers it by leaving the
 * column out of the INSERT so Postgres applies its `DEFAULT`. `null` means
 * *store nothing here*, which for a `NOT NULL` column is a constraint
 * violation.
 *
 * This transformer used to collapse the two, and it broke adding a supplier:
 *
 *     null value in column "vat_rate" of relation "shops"
 *     violates not-null constraint
 *
 * `shops.vat_rate` is `NOT NULL DEFAULT 20`, and nothing sets it on create —
 * it is not something a buyer types, it is a fact about the supplier that
 * defaults until somebody fills it in. The property was therefore `undefined`,
 * the transformer turned it into `null`, and TypeORM dutifully wrote an
 * explicit NULL over the top of a perfectly good default.
 *
 * The tell was in the failing INSERT itself: `vat_state` — same table, same
 * row, also unset, also with a default — came through as `DEFAULT`, because it
 * is a varchar and carries no transformer. Only the numeric columns broke, and
 * they broke together.
 */
describe('numericTransformer.to (writing)', () => {
  it('leaves an unset value unset, so the column default applies', () => {
    // The whole bug, in one assertion. Returning null here puts an explicit
    // NULL into the INSERT and defeats every `DEFAULT` in the schema.
    expect(numericTransformer.to(undefined)).toBeUndefined();
  });

  it('still writes an explicit null when one is meant', () => {
    // `free_shipping_over` is nullable and null is a real answer there: this
    // supplier never gives free delivery. That must keep working.
    expect(numericTransformer.to(null)).toBeNull();
  });

  it('passes numbers through untouched', () => {
    expect(numericTransformer.to(0)).toBe(0);
    expect(numericTransformer.to(20)).toBe(20);
    expect(numericTransformer.to(12.5)).toBe(12.5);
    expect(numericTransformer.to(-3.25)).toBe(-3.25);
  });

  it('does not mistake zero for absent', () => {
    // `0` is falsy, and a `value || null` written in a hurry would turn a
    // supplier's 0% discount and 0 handling fee into nulls.
    expect(numericTransformer.to(0)).toBe(0);
    expect(numericTransformer.to(0)).not.toBeNull();
    expect(numericTransformer.to(0)).not.toBeUndefined();
  });
});

describe('numericTransformer.from (reading)', () => {
  it('parses the strings node-postgres returns for numeric columns', () => {
    // The reason this transformer exists: pg hands back `numeric` as a string
    // to avoid IEEE-754 precision loss, and the rest of the codebase does
    // arithmetic on these.
    expect(numericTransformer.from('19.00')).toBe(19);
    expect(numericTransformer.from('0.00')).toBe(0);
    expect(numericTransformer.from('1234.56')).toBe(1234.56);
  });

  it('reads a database null as null', () => {
    expect(numericTransformer.from(null)).toBeNull();
    expect(numericTransformer.from(undefined)).toBeNull();
  });

  it('reads unparseable text as null rather than as NaN', () => {
    // NaN would propagate silently through every total it touched. Null stops
    // at the first check that asks whether there is a figure at all.
    expect(numericTransformer.from('not a number')).toBeNull();
    expect(numericTransformer.from('')).toBeNull();
  });
});

/**
 * A stand-in for what TypeORM does with the result.
 *
 * The unit assertions above say what the transformer returns; this says why
 * that matters, by reproducing the one decision TypeORM makes with it — a
 * column whose transformed value is `undefined` is left out of the statement,
 * and anything else is written.
 */
describe('what the driver does with the result', () => {
  const columnIsWritten = (value: number | null | undefined): boolean =>
    numericTransformer.to(value) !== undefined;

  it('omits an unset column, letting Postgres apply DEFAULT', () => {
    expect(columnIsWritten(undefined)).toBe(false);
  });

  it('writes a column that was given a value, including zero and null', () => {
    expect(columnIsWritten(0)).toBe(true);
    expect(columnIsWritten(20)).toBe(true);
    expect(columnIsWritten(null)).toBe(true);
  });
});
