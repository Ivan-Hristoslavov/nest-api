/*
 * The design tokens, lifted out of the page.
 *
 * Every colour resolves through a CSS variable, so switching the theme is one
 * class on <html> rather than a second set of utility classes on every
 * element. `<alpha-value>` keeps Tailwind's /opacity modifiers working.
 *
 * Names are semantic (STOCLIFY-DESIGN-SPEC.md §13.3). The old mapping said
 * things like `slate: { 200: token('text-primary'), 700: token('border-strong') }`
 * — a scale whose numbers meant nothing, where `text-slate-200` was how you
 * wrote "primary text" and `slate-700` was a border. Unreadable, unsearchable,
 * and impossible to use correctly by accident.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  // Scanned for class names. `app.js` is in here because most of the interface
  // is built as HTML strings in JavaScript — leaving it out would strip half
  // the utilities out of the stylesheet.
  content: ['./public/**/*.html', './public/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },

      /*
       * The type scale (§12.2). Ten steps, each with a declared job, replacing
       * the ten arbitrary pixel values that were in the markup — `13px` 160
       * times, `12.5px` 47 times, half of them on half-pixels.
       *
       * Line height traves with the size, so `text-sm` is one decision rather
       * than two that can drift apart.
       */
      fontSize: {
        '2xs': ['11px', { lineHeight: '16px' }], // micro labels, table meta
        xs: ['12px', { lineHeight: '16px' }], // badges, captions
        sm: ['13px', { lineHeight: '20px' }], // table cells — the workhorse
        base: ['14px', { lineHeight: '20px' }], // body, forms — the default
        md: ['16px', { lineHeight: '24px' }], // lede, card title
        lg: ['20px', { lineHeight: '28px' }], // section title
        xl: ['24px', { lineHeight: '32px' }], // page title
        '2xl': ['32px', { lineHeight: '40px' }], // numbers in tiles
        '3xl': ['44px', { lineHeight: '48px' }], // the Money Screen sum
        '4xl': ['56px', { lineHeight: '60px' }], // landing hero ONLY
      },

      letterSpacing: {
        tight: 'var(--tracking-tight)',
        num: 'var(--tracking-num)',
        caps: 'var(--tracking-caps)',
      },

      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-xl)',
      },

      colors: {
        /* --- Semantic. New code uses only these. --- */
        surface: {
          canvas: token('surface-canvas'),
          panel: token('surface-panel'),
          raised: token('surface-raised'),
          hover: token('surface-hover'),
          active: token('surface-active'),
        },
        border: {
          subtle: token('border-subtle'),
          DEFAULT: token('border-default'),
          strong: token('border-strong'),
        },
        content: {
          primary: token('text-primary'),
          secondary: token('text-secondary'),
          muted: token('text-muted'),
          faint: token('text-faint'),
          ghost: token('text-ghost'),
        },
        accent: {
          DEFAULT: token('accent'),
          deep: token('accent-deep'),
          light: token('accent-light'),
          on: token('accent-on'),
          wash: token('accent-wash'),
          border: token('accent-border'),
          text: token('accent-text'),
          // Numeric aliases, so the ~200 existing `accent-500` / `accent-400`
          // utilities keep resolving while screens are migrated one at a time.
          300: token('accent-light'),
          400: token('accent-light'),
          500: token('accent'),
          600: token('accent-deep'),
          700: token('accent-deep'),
        },
        /* Money saved, and nothing else. Never a primary button. */
        positive: {
          DEFAULT: token('positive'),
          deep: token('positive-deep'),
          wash: token('positive-wash'),
          border: token('positive-border'),
          text: token('positive-text'),
        },
        /* Degraded supplier, stale price, unknown VAT, under the minimum. */
        caution: {
          DEFAULT: token('caution'),
          wash: token('caution-wash'),
          border: token('caution-border'),
          text: token('caution-text'),
        },
        /* Supplier down, payment failed, destructive. Never a price rise. */
        critical: {
          DEFAULT: token('critical'),
          wash: token('critical-wash'),
          border: token('critical-border'),
          text: token('critical-text'),
        },
        info: {
          DEFAULT: token('info'),
          wash: token('info-wash'),
          border: token('info-border'),
          text: token('info-text'),
        },

        /*
         * Deprecated aliases, kept for one migration cycle (§13.3).
         *
         * `app.js` builds most of the interface as HTML strings and carries
         * roughly 1 800 of these class names. Rewriting them all in one change
         * would be a diff nobody could review, against a product that is live
         * — so they keep resolving to the same colours they always did, and
         * screens move to the semantic names as they are rebuilt.
         *
         * Nothing new should use them.
         */
        ink: {
          950: token('surface-canvas'),
          900: token('surface-panel'),
          850: token('surface-raised'),
          800: token('surface-hover'),
          700: token('surface-active'),
          600: token('border-strong'),
          500: token('border-default'),
        },
        slate: {
          200: token('text-primary'),
          300: token('text-secondary'),
          400: token('text-muted'),
          500: token('text-faint'),
          600: token('text-ghost'),
          700: token('border-strong'),
        },
        /*
         * `emerald-*` used to be written inline wherever a saving appeared.
         * Pointed at the `positive` token it now means the one thing it should,
         * and an existing `text-emerald-400` renders as the savings colour
         * rather than as whichever green Tailwind shipped.
         */
        emerald: {
          300: token('positive-text'),
          400: token('positive'),
          500: token('positive'),
          600: token('positive-deep'),
        },
        amber: {
          300: token('caution-text'),
          400: token('caution'),
          500: token('caution'),
          600: token('caution'),
        },
        red: {
          300: token('critical-text'),
          400: token('critical'),
          500: token('critical'),
          600: token('critical'),
        },
        violet: {
          300: token('info-text'),
          400: token('info'),
          500: token('info'),
        },
      },

      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        focus: 'var(--shadow-focus)',
        panel: 'var(--shadow-panel)',
        glow: 'var(--shadow-glow)',
      },

      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
      },
      transitionDuration: {
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
        slow: 'var(--dur-slow)',
      },
    },
  },
};
