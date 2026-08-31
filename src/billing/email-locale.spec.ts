import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SOURCE_LOCALE, normaliseLocale, translator } from './email-locale';

/**
 * A Romanian buyer was getting Bulgarian email. The site had spoken four
 * languages for a while; the one thing that reaches somebody outside it did
 * not, because nothing anywhere recorded what they read.
 */
describe('the language an email is written in', () => {
  describe('normalising what the browser reported', () => {
    it('accepts a plain code', () => {
      expect(normaliseLocale('ro')).toBe('ro');
    });

    it('accepts a regional tag, which is what `navigator.language` gives', () => {
      expect(normaliseLocale('bg-BG')).toBe('bg');
      expect(normaliseLocale('en-GB')).toBe('en');
    });

    it('does not care about case or stray spaces', () => {
      expect(normaliseLocale('  RO  ')).toBe('ro');
    });

    it('falls back to the source for a language we do not offer', () => {
      // A guess about what somebody reads is worse than the language the
      // product was written in.
      expect(normaliseLocale('de')).toBe(SOURCE_LOCALE);
      expect(normaliseLocale('zh-Hans')).toBe(SOURCE_LOCALE);
    });

    it('falls back for nothing at all', () => {
      expect(normaliseLocale(null)).toBe(SOURCE_LOCALE);
      expect(normaliseLocale(undefined)).toBe(SOURCE_LOCALE);
      expect(normaliseLocale('')).toBe(SOURCE_LOCALE);
    });
  });

  describe('translating', () => {
    it('writes to a Romanian reader in Romanian', () => {
      expect(translator('ro')('Вход в Stoclify')).toBe('Autentificare în Stoclify');
    });

    it('writes to an English reader in English', () => {
      expect(translator('en')('Вход в Stoclify')).toBe('Sign in to Stoclify');
    });

    it('writes to a Greek reader in Greek', () => {
      expect(translator('el')('Вход в Stoclify')).toBe('Σύνδεση στο Stoclify');
    });

    it('leaves the source language alone', () => {
      expect(translator('bg')('Вход в Stoclify')).toBe('Вход в Stoclify');
      expect(translator(null)('Вход в Stoclify')).toBe('Вход в Stoclify');
    });

    it('falls through to the source for a sentence nobody translated yet', () => {
      // Better than an empty space, and it means editing the Bulgarian makes a
      // stale translation stop matching rather than quietly shipping.
      expect(translator('ro')('Нещо, което никой не е превел')).toBe(
        'Нещо, което никой не е превел',
      );
    });

    it('substitutes placeholders after the lookup, so grammar can move them', () => {
      expect(
        translator('en')('Връзката важи {minutes} минути и се използва веднъж.', { minutes: 15 }),
      ).toBe('The link is valid for 15 minutes and works once.');
    });

    it('substitutes every occurrence of a placeholder', () => {
      expect(translator('bg')('{x} и пак {x}', { x: 'едно' })).toBe('едно и пак едно');
    });
  });

  describe('the dictionaries', () => {
    const languages = ['en', 'ro', 'el'];

    // Every string the three onboarding emails ask for. If one is missing the
    // email still sends — in Bulgarian, to somebody who does not read it.
    const required = [
      'Вход в Stoclify',
      'Влезте в таблото си',
      'Влез в таблото',
      'Потвърдете имейла си за Stoclify',
      'Остана едно натискане',
      'Потвърди и влез',
      'Готово — ето ключа ви за Stoclify',
      'Акаунтът ви е готов',
      'Вашият ключ',
      'Отвори таблото',
      'План',
      'Следени артикула',
      'AI сравнения',
      'Доставчици',
      'без ограничение',
    ];

    for (const language of languages) {
      it(`${language} covers every string the onboarding emails use`, () => {
        const path = join(process.cwd(), 'public', 'locales', `${language}.json`);
        const dictionary = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;

        const missing = required.filter((key) => !dictionary[key]);
        expect(missing).toEqual([]);
      });

      it(`${language} keeps the placeholders its Bulgarian original had`, () => {
        const path = join(process.cwd(), 'public', 'locales', `${language}.json`);
        const dictionary = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;

        const wrong: string[] = [];

        for (const [source, translated] of Object.entries(dictionary)) {
          const inSource = [...source.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
          if (inSource.length === 0) continue;

          const inTranslation = [...translated.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

          // A dropped placeholder is a number that never appears; an invented
          // one is a literal "{minutes}" in somebody's inbox.
          if (inSource.join() !== inTranslation.join()) wrong.push(source);
        }

        expect(wrong).toEqual([]);
      });
    }
  });
});
