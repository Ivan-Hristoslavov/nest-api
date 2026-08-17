import { ValueTransformer } from 'typeorm';

/**
 * `node-postgres` returns `numeric`/`decimal` columns as strings to avoid the
 * precision loss of IEEE-754 doubles. Money in this API never exceeds
 * 10 integral digits with 2 decimals, which is comfortably inside the safe
 * integer range, so we convert to `number` at the entity boundary and keep the
 * rest of the codebase free of string-vs-number arithmetic bugs.
 */
export class NumericColumnTransformer implements ValueTransformer {
  to(value: number | null | undefined): number | null {
    return value === undefined || value === null ? null : value;
  }

  from(value: string | null | undefined): number | null {
    if (value === undefined || value === null) return null;
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
}

export const numericTransformer = new NumericColumnTransformer();
