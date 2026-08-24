import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The language an email is written in.
 *
 * Bulgarian is the source, here as everywhere else: the strings in
 * `mail.service.ts` are written in it and stay that way. Every other language
 * is `public/locales/<code>.json`, keyed by the Bulgarian string — the same
 * files, in the same shape, that the interface has always used.
 *
 * Sharing them is the point. A second mechanism would mean adding a language
 * is two jobs, and somebody would do one of them: the site would speak Romanian
 * while its emails did not, which is exactly the bug this fixes.
 *
 * A missing key falls through to the Bulgarian. That is the documented
 * behaviour of the interface and it is the right one — a sentence nobody has
 * translated yet reads as the source rather than as an empty space, and
 * editing the Bulgarian makes its stale translation stop matching instead of
 * quietly shipping last month's wording.
 */

/** The language the strings are written in. */
export const SOURCE_LOCALE = 'bg';

/** What `public/i18n.js` offers. `seo.service.spec.ts` guards the two lists. */
const OFFERED = new Set([SOURCE_LOCALE, 'en', 'ro', 'el']);

/** Loaded once per language, on first use, and kept for the process. */
const loaded = new Map<string, Record<string, string>>();

function dictionaryFor(locale: string): Record<string, string> {
  const cached = loaded.get(locale);
  if (cached) return cached;

  let dictionary: Record<string, string> = {};

  try {
    const path = join(process.cwd(), 'public', 'locales', `${locale}.json`);
    dictionary = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    // A language with no file is a language nobody translated. Falling through
    // to the source beats failing to send the mail.
  }

  loaded.set(locale, dictionary);
  return dictionary;
}

/**
 * Normalises whatever the browser reported into a language we offer.
 *
 * `bg-BG`, `BG` and `bg` are the same language; anything unrecognised is the
 * source, because a guess about what somebody reads is worse than the language
 * the product was written in.
 */
export function normaliseLocale(value: string | null | undefined): string {
  if (!value) return SOURCE_LOCALE;

  const code = value.trim().slice(0, 2).toLowerCase();
  return OFFERED.has(code) ? code : SOURCE_LOCALE;
}

/**
 * A translator for one message.
 *
 * ```ts
 * const t = translator(user.locale);
 * t('Вход в Stoclify');
 * t('Остават {days} дни', { days: 3 });
 * ```
 *
 * Placeholders are named and substituted after the lookup, so a translator can
 * move them where their own grammar wants them.
 */
export function translator(locale: string | null | undefined): Translate {
  const code = normaliseLocale(locale);
  const dictionary = code === SOURCE_LOCALE ? null : dictionaryFor(code);

  return (source: string, values?: Record<string, string | number>): string => {
    const translated = dictionary?.[source] ?? source;

    if (!values) return translated;

    return Object.entries(values).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      translated,
    );
  };
}

export type Translate = (source: string, values?: Record<string, string | number>) => string;
