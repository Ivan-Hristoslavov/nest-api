import { ValueTransformer } from 'typeorm';

/**
 * `node-postgres` returns `numeric`/`decimal` columns as strings to avoid the
 * precision loss of IEEE-754 doubles. Money in this API never exceeds
 * 10 integral digits with 2 decimals, which is comfortably inside the safe
 * integer range, so we convert to `number` at the entity boundary and keep the
 * rest of the codebase free of string-vs-number arithmetic bugs.
 */
export class NumericColumnTransformer implements ValueTransformer {
  /**
   * Writing. `undefined` and `null` are kept apart, because to a database they
   * are opposites.
   *
   * `undefined` means *this column was not mentioned*. TypeORM answers that by
   * leaving the column out of the INSERT, so Postgres applies its `DEFAULT`.
   * `null` means *store nothing here*, which on a `NOT NULL` column is a
   * constraint violation.
   *
   * This used to collapse the two, and it broke adding a supplier outright:
   *
   *     null value in column "vat_rate" of relation "shops"
   *     violates not-null constraint
   *
   * `shops.vat_rate` is `NOT NULL DEFAULT 20` and nothing sets it on create —
   * it is a fact about the supplier that defaults until somebody fills it in.
   * The property was `undefined`, this returned `null`, and TypeORM wrote an
   * explicit NULL over a perfectly good default. The same held for
   * `shipping_cost`, `handling_fee` and `min_order_value`.
   *
   * The tell was in the failing statement itself: `vat_state` — same table,
   * same row, also unset, also with a default — came through as `DEFAULT`,
   * because it is a varchar and carries no transformer. Only the numeric
   * columns broke, and they broke together.
   *
   * The return type has to admit `undefined` for that to survive: typed
   * `number | null`, the compiler accepts a `return undefined` nowhere and the
   * bug is one careless edit away from returning.
   */
  to(value: number | null | undefined): number | null | undefined {
    if (value === undefined) return undefined;
    return value;
  }

  from(value: string | null | undefined): number | null {
    if (value === undefined || value === null) return null;
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
}

export const numericTransformer = new NumericColumnTransformer();
