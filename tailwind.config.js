/*
 * The design tokens, lifted out of the page.
 *
 * Every colour resolves through a CSS variable, so switching the theme is one
 * class on <html> rather than a second set of utility classes on every
 * element. `<alpha-value>` keeps Tailwind's /opacity modifiers working.
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
      colors: {
        ink: {
          950: token('bg-base'),
          900: token('bg-panel'),
          850: token('bg-raised'),
          800: token('bg-hover'),
          700: token('bg-active'),
          600: token('border-strong'),
          500: token('border-subtle'),
        },
        slate: {
          200: token('text-primary'),
          300: token('text-secondary'),
          400: token('text-muted'),
          500: token('text-faint'),
          600: token('text-ghost'),
          700: token('border-strong'),
        },
        accent: {
          300: token('accent-soft'),
          400: token('accent-light'),
          500: token('accent'),
          600: token('accent-deep'),
          700: token('accent-deepest'),
        },
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        glow: 'var(--shadow-glow)',
      },
    },
  },
};
