import { ValidationOptions, registerDecorator } from 'class-validator';

import { assertPublicHttpUrl } from '../../scraper/http/address-guard';

/**
 * A URL this service is willing to fetch on a customer's behalf.
 *
 * `@IsUrl()` is not that check. It accepts `http://127.0.0.1:3000/`,
 * `http://169.254.169.254/latest/meta-data/` and anything under a public
 * domain that happens to resolve inside — the first two because a literal
 * address is a perfectly well-formed URL, and the third because no validator
 * can know without asking DNS.
 *
 * This decorator answers what can be answered synchronously: the protocol and
 * the literal addresses. What a hostname resolves to is decided at connection
 * time by the agent's lookup, which sees redirects too. The point of doing it
 * here as well is the error message — somebody pasting an intranet address
 * gets told why, immediately, instead of watching a listing fail quietly for a
 * week.
 */
export function IsPublicHttpUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isPublicHttpUrl',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;

          try {
            assertPublicHttpUrl(value);
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(): string {
          return (
            '$property must be a public http(s) address. ' +
            'Addresses inside this server’s own network cannot be checked.'
          );
        },
      },
    });
  };
}

/**
 * The same, for a search template carrying a `{q}` placeholder.
 *
 * The placeholder is substituted before parsing: `https://shop.bg/s?q={q}` is
 * not a URL until something stands where the query goes.
 */
export function IsPublicHttpUrlTemplate(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isPublicHttpUrlTemplate',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;

          try {
            assertPublicHttpUrl(value.replace(/\{q\}/g, 'q'));
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(): string {
          return (
            '$property must be a public http(s) address with {q} where the query goes. ' +
            'Addresses inside this server’s own network cannot be searched.'
          );
        },
      },
    });
  };
}
