/*
 * Applied before first paint.
 *
 * Loaded as a blocking <script> in <head> on purpose: reading the stored
 * choice after render is what causes the white flash people notice on
 * dark-themed sites.
 */
(function () {
  try {
    const stored = localStorage.getItem('stoclify.theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'dark' || (stored === null && prefersDark)) {
      document.documentElement.classList.add('dark');
    }
  } catch (error) {
    /* private mode — fall back to the light default */
  }
})();
