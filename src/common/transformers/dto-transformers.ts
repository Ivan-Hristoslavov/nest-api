import { TransformFnParams } from 'class-transformer';

/**
 * Reusable `@Transform` callbacks for DTOs.
 *
 * `TransformFnParams.value` is typed `any`, so each helper narrows explicitly
 * and returns `unknown`: the class-validator decorator on the same property is
 * what rejects the value if the narrowing did not apply.
 */

/** Trims surrounding whitespace from string input, leaves anything else alone. */
export const trimString = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : (value as unknown);

/** Trims and upper-cases string input (currency codes, country codes, ...). */
export const trimUpperCase = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : (value as unknown);

/** Trims and upper-cases, used for enum query params such as sort direction. */
export const upperCase = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.toUpperCase() : (value as unknown);

/**
 * Parses the `'true'` / `'false'` strings that arrive in query parameters into
 * real booleans. Anything unrecognised is passed through untouched so
 * `@IsBoolean()` produces a proper validation error instead of a silent `false`.
 */
export const toOptionalBoolean = ({ value }: TransformFnParams): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value as unknown;
};
