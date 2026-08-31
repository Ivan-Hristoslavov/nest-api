import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SEO_LANGUAGES, SeoService } from './seo.service';

function serviceAt(publicUrl: string): SeoService {
  const config = {
    getOrThrow: () => ({ publicUrl }),
  } as unknown as ConfigService;

  return new SeoService(config);
}

describe('SeoService', () => {
  const seo = serviceAt('https://stoclify.bg');

  describe('addresses', () => {
    it('serves the source language at the bare address', () => {
      expect(seo.urlFor('bg')).toBe('https://stoclify.bg/');
    });

    it('gives every other language a parameter of its own', () => {
      expect(seo.urlFor('en')).toBe('https://stoclify.bg/?lang=en');
      expect(seo.urlFor('el')).toBe('https://stoclify.bg/?lang=el');
    });
  });

  describe('robots.txt', () => {
    it('points at the sitemap on the configured origin', () => {
      expect(seo.robots()).toContain('Sitemap: https://stoclify.bg/sitemap.xml');
    });

    it('keeps crawlers out of the API, which has no pages in it', () => {
      expect(seo.robots()).toContain('Disallow: /api/v1/');
    });
  });

  describe('sitemap.xml', () => {
    const xml = seo.sitemap();

    it('declares every language as an alternate of the one page', () => {
      for (const language of SEO_LANGUAGES) {
        expect(xml).toContain(`hreflang="${language}"`);
      }
    });

    it('names a default for a visitor whose language is not on offer', () => {
      expect(xml).toContain('hreflang="x-default"');
    });

    it('escapes the ampersand in a query string, or the XML will not parse', () => {
      const withQuery = serviceAt('https://example.test').sitemap();
      expect(withQuery).not.toMatch(/&(?!amp;|apos;|lt;|gt;|quot;)/);
    });
  });

  describe('head tags', () => {
    it('makes a translated page canonical to itself, not to the source', () => {
      // Pointing the Greek page at the Bulgarian one declares it a duplicate,
      // and it drops out of exactly the results it was translated for.
      expect(seo.headTags('el')).toContain(
        '<link rel="canonical" href="https://stoclify.bg/?lang=el" />',
      );
    });

    it('falls back to the source language when none was asked for', () => {
      expect(seo.headTags(null)).toContain('<link rel="canonical" href="https://stoclify.bg/" />');
    });

    it('ignores a language it does not have rather than inventing an address', () => {
      expect(seo.headTags('zz')).toContain('<link rel="canonical" href="https://stoclify.bg/" />');
    });

    it('carries structured data a search engine can parse', () => {
      const tags = seo.headTags(null);
      const json = /<script type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/.exec(tags);

      expect(json).not.toBeNull();
      expect(() => JSON.parse(json![1])).not.toThrow();
      expect(JSON.parse(json![1])['@context']).toBe('https://schema.org');
    });

    it('has an alternate for every language and a default', () => {
      const tags = seo.headTags(null);
      for (const language of SEO_LANGUAGES) {
        expect(tags).toContain(`hreflang="${language}"`);
      }
      expect(tags).toContain('hreflang="x-default"');
    });
  });

  describe('the language list', () => {
    // The browser has its own copy in `public/i18n.js` and no module boundary
    // to share one across. This is the guard rail: add a language there and
    // forget it here, and the new pages are never offered to a search engine.
    it('matches the one the interface offers', () => {
      const source = readFileSync(join(process.cwd(), 'public', 'i18n.js'), 'utf8');
      const block = /var LANGUAGES = \[(.*?)\];/s.exec(source);

      expect(block).not.toBeNull();

      const offered = [...block![1].matchAll(/code: '([a-z]{2})'/g)].map((match) => match[1]);

      expect(offered.sort()).toEqual([...SEO_LANGUAGES].sort());
    });
  });

  describe('a deployment that has not set its domain yet', () => {
    it('still produces valid output, just pointed at localhost', () => {
      const local = serviceAt('http://localhost:3000');
      expect(local.urlFor('bg')).toBe('http://localhost:3000/');
      expect(local.robots()).toContain('Sitemap: http://localhost:3000/sitemap.xml');
    });
  });
});
