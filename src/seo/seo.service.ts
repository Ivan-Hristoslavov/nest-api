import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppConfig } from '../config/configuration';

/**
 * What a crawler is told about this site.
 *
 * Every absolute URL here is built from `APP_PUBLIC_URL` rather than written
 * down, because a canonical link pointing at the wrong host is worse than none
 * at all: it tells the search engine that the page it just read is a duplicate
 * of somewhere else.
 */

/** The source language of the markup — served at the bare address. */
const SOURCE_LANGUAGE = 'bg';

/**
 * The languages `public/i18n.js` offers.
 *
 * Duplicated deliberately rather than imported: that file is browser
 * JavaScript with no module boundary, and a build step to share four strings
 * would cost more than it saves. `seo.service.spec.ts` fails if the two lists
 * drift apart.
 */
export const SEO_LANGUAGES = [SOURCE_LANGUAGE, 'en', 'ro', 'el'] as const;

@Injectable()
export class SeoService {
  private readonly origin: string;

  constructor(config: ConfigService) {
    this.origin = config.getOrThrow<AppConfig>('app').publicUrl;
  }

  /** The address of the page in one language. The source language has no parameter. */
  urlFor(language: string): string {
    return language === SOURCE_LANGUAGE
      ? `${this.origin}/`
      : `${this.origin}/?lang=${encodeURIComponent(language)}`;
  }

  /**
   * `robots.txt`.
   *
   * The API is disallowed because none of it is a page: a crawler that indexes
   * `/api/v1/products` finds a 401 and spends the site's crawl budget doing it.
   * The documentation is left crawlable — it is the one part of the API worth
   * finding in a search.
   */
  robots(): string {
    return [
      'User-agent: *',
      'Allow: /',
      'Disallow: /api/v1/',
      '',
      `Sitemap: ${this.origin}/sitemap.xml`,
      '',
    ].join('\n');
  }

  /**
   * `sitemap.xml`.
   *
   * One entry, with a language alternate per translation. That is honest about
   * what the site currently is: the views are hash fragments, and a fragment is
   * not a separate address to a search engine, so listing `#pricing` here would
   * be listing a URL that does not exist. When the views get real paths, they
   * get entries here.
   */
  sitemap(): string {
    const alternates = SEO_LANGUAGES.map(
      (language) =>
        `    <xhtml:link rel="alternate" hreflang="${language}" href="${escapeXml(this.urlFor(language))}"/>`,
    ).join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
      '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      '  <url>',
      `    <loc>${escapeXml(this.urlFor(SOURCE_LANGUAGE))}</loc>`,
      alternates,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(this.urlFor(SOURCE_LANGUAGE))}"/>`,
      '    <changefreq>weekly</changefreq>',
      '    <priority>1.0</priority>',
      '  </url>',
      '</urlset>',
      '',
    ].join('\n');
  }

  /**
   * The tags injected into `<head>` when `index.html` is served.
   *
   * `language` is whatever the visitor asked for in `?lang=`, so the canonical
   * of the Greek page is the Greek address rather than the Bulgarian one —
   * otherwise the translations are declared duplicates of the source and drop
   * out of the results they were made for.
   */
  headTags(language: string | null): string {
    const chosen =
      language && (SEO_LANGUAGES as readonly string[]).includes(language)
        ? language
        : SOURCE_LANGUAGE;

    const canonical = this.urlFor(chosen);

    const alternates = SEO_LANGUAGES.map(
      (code) =>
        `    <link rel="alternate" hreflang="${code}" href="${escapeHtml(this.urlFor(code))}" />`,
    );

    return [
      `    <link rel="canonical" href="${escapeHtml(canonical)}" />`,
      ...alternates,
      `    <link rel="alternate" hreflang="x-default" href="${escapeHtml(this.urlFor(SOURCE_LANGUAGE))}" />`,
      `    <meta property="og:url" content="${escapeHtml(canonical)}" />`,
      '    <script type="application/ld+json">',
      `      ${JSON.stringify(this.structuredData())}`,
      '    </script>',
    ].join('\n');
  }

  /**
   * Structured data.
   *
   * Two things only, both of which the site can stand behind: who publishes it
   * and what it is. No `AggregateRating`, no invented review count — a price
   * service caught inventing numbers about itself has nothing left to sell.
   */
  private structuredData(): Record<string, unknown> {
    return {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': `${this.origin}/#organization`,
          name: 'Stoclify',
          url: `${this.origin}/`,
          logo: `${this.origin}/og-image.png`,
        },
        {
          '@type': 'WebSite',
          '@id': `${this.origin}/#website`,
          url: `${this.origin}/`,
          name: 'Stoclify',
          publisher: { '@id': `${this.origin}/#organization` },
          inLanguage: [...SEO_LANGUAGES],
        },
        {
          '@type': 'SoftwareApplication',
          name: 'Stoclify',
          applicationCategory: 'BusinessApplication',
          operatingSystem: 'Web',
          url: `${this.origin}/`,
          publisher: { '@id': `${this.origin}/#organization` },
          // A free tier is a fact about the product, not a claim about a price.
          // The paid tiers are deliberately absent: they are configured per
          // deployment, and a stale price in structured data is a wrong price
          // shown in a search result.
          offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'BGN',
          },
        },
      ],
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, '&apos;');
}
