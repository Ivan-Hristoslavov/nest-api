/*
 * Stoclify — the whole interface.
 *
 * Split out of index.html so the page can carry a Content-Security-Policy that
 * forbids inline script, which is what stops an injected tag from reading the
 * session token out of localStorage. Loaded with `defer`, so it runs after the
 * document is parsed and every element it looks up exists.
 */
'use strict';

/**
 * One string, in the reader's language.
 *
 * Defined here rather than imported so this file keeps working on its own:
 * without i18n.js the page stays Bulgarian, which is what the markup says
 * anyway. Only needed for strings assembled in JavaScript — everything written
 * in the HTML is handled by the pass i18n.js makes over the document.
 */
function translate(text) {
  return window.PG_I18N ? window.PG_I18N.t(text) : text;
}

/**
 * Whether anybody is actually signed in.
 *
 * Asked in several places — the demo search, the demo supplier list, the
 * guards on the buttons that write — and they must all agree, or the
 * interface ends up half in demo and half in a real account.
 */
function isIdentified() {
  // One definition, shared with the credential layer. An operator key does not
  // count: it names nobody, so there is no account for a customer view to show.
  return hasCustomerCredentials();
}

/**
 * Stops a visitor walking into a request that cannot succeed.
 *
 * The demo deliberately looks like the real thing, which is the point and
 * also the risk: somebody browsing it will press "Add a product", and until
 * now that fired a request, got a 401 and reported a failure — making the
 * product look broken at the exact moment it was being evaluated. There is
 * nothing broken; they simply have no account yet, so say that and offer one.
 *
 * @returns true when the caller should stop.
 */
function requireAccount() {
  if (isIdentified()) return false;

  $('#signup-form').classList.remove('hidden');
  $('#signup-done').classList.add('hidden');
  $('#signup-status').classList.add('hidden');
  openModal('signup-modal');
  return true;
}

/** Fills `{n}`-style holes in a translated pattern. */
function formatMessage(pattern, values) {
  return translate(pattern).replace(/\{(\w+)\}/g, function (whole, name) {
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
  });
}

/**
 * A counted phrase, in whichever form the language wants.
 *
 * Pasting a number in front of a fixed noun is the standard way this goes
 * wrong: "1 warehouses". `Intl.PluralRules` knows which form each language
 * needs, and the Bulgarian patterns double as the dictionary keys.
 */
function pluralMessage(count, patterns) {
  const rules = new Intl.PluralRules(document.documentElement.lang || 'bg');
  return formatMessage(patterns[rules.select(count)] || patterns.other, { n: count });
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const API_BASE = '/api/v1';

/** Endpoints this UI talks to. Kept in one place so a rename is one edit. */
const ENDPOINTS = {
  products: API_BASE + '/products',
  analyticsOverview: API_BASE + '/analytics/overview',
  scraperTrigger: API_BASE + '/scraper/trigger',
  // Sweeps this account's own listings. The unscoped '/scraper/run' walks
  // every tenant's queue and is operator-only for that reason.
  scraperRun: API_BASE + '/scraper/run/mine',
  scraperRefresh: API_BASE + '/scraper/competitors',
  discoverySearch: API_BASE + '/discovery/search',
  discoveryShops: API_BASE + '/discovery/shops',
  discoveryDetect: API_BASE + '/discovery/detect',
  discoveryAvailable: API_BASE + '/discovery/available',
  discoveryBasket: API_BASE + '/discovery/basket',
  purchaseDecisions: API_BASE + '/purchase-decisions',
  purchaseDecisionsSummary: API_BASE + '/purchase-decisions/summary',
  discoveryCompare: API_BASE + '/discovery/compare',
  discoveryCompareStream: API_BASE + '/discovery/compare/stream',
  discoverySearches: API_BASE + '/discovery/searches',
  shops: API_BASE + '/shops',
  billingUsers: API_BASE + '/billing/users',
  billingCheckout: API_BASE + '/billing/checkout',
  billingPlans: API_BASE + '/billing/plans',
  authRegister: API_BASE + '/auth/register',
  billingMe: API_BASE + '/billing/me',
  authSignIn: API_BASE + '/auth/sign-in',
  authSession: API_BASE + '/auth/session',
  authTotpVerify: API_BASE + '/auth/totp/verify',
  authTotpSetup: API_BASE + '/auth/totp/setup',
  authTotpEnable: API_BASE + '/auth/totp/enable',
  authTotpDisable: API_BASE + '/auth/totp/disable',
  authSessions: API_BASE + '/auth/sessions',
  authSignOutEverywhere: API_BASE + '/auth/sign-out-everywhere',
  authSignOut: API_BASE + '/auth/sign-out',
  stats: API_BASE + '/stats',
  billingRotateKey: API_BASE + '/billing/users/api-key',
  billingMailHealth: API_BASE + '/billing/mail/health',
  matchingHealth: API_BASE + '/matching/health',
  // Operator panel only — carries the last sweep's per-listing results across
  // every account. The customer-facing view is '/scraper/status/mine'.
  scraperStatus: API_BASE + '/scraper/status',
  adminOverview: API_BASE + '/admin/overview',
  adminDecisions: API_BASE + '/admin/purchase-decisions',
  adminDecisionAnalytics: API_BASE + '/admin/purchase-decisions/analytics',
  adminShops: API_BASE + '/admin/shops',
  adminEvents: API_BASE + '/admin/events',
  adminOutreach: API_BASE + '/admin/outreach',
  adminOutreachPreview: API_BASE + '/admin/outreach/preview',
  adminScrape: API_BASE + '/admin/scrape',
  adminScrapeRun: API_BASE + '/admin/scrape/run',
  adminAlerts: API_BASE + '/admin/alerts',
  adminSearchQuality: API_BASE + '/admin/search/quality',
  adminSearchDebug: API_BASE + '/admin/search/debug',
};

/**
 * What is on sale, asked once.
 *
 * Two separate parts of the page need this — the plan buttons and the offer of
 * more comparisons — and each used to fetch it for itself, so every visit
 * opened the same request twice. The promise is kept rather than the answer,
 * so callers that arrive while the first request is still in flight wait for
 * it instead of starting a second.
 *
 * A server that cannot be reached is reported as "not selling" rather than as
 * an error: this runs on a page somebody may only be reading.
 */
let billingPlansPromise = null;

/**
 * The signed-in account, fetched once per page load.
 *
 * `/billing/me` was being asked five times to render one screen — the plan bar
 * asks, `renderAccount` asks through it, and the Money Screen asks for the
 * subscription price. Same answer every time, five round trips, and on a cold
 * Supabase connection each one costs ~150ms.
 *
 * Cleared by `forgetAccount()` whenever the identity changes, so a sign-in or
 * a pasted key is never answered from the previous account's cache.
 */
let accountPromise = null;

function accountOnce(options) {
  if (!accountPromise || (options && options.force)) {
    accountPromise = fetch(ENDPOINTS.billingMe, { headers: authHeaders() })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }

  return accountPromise;
}

/** Called on every credential change: a cached account outliving its session
 *  would show the previous customer's plan to the next one. */
function forgetAccount() {
  accountPromise = null;
  moneyScreenCache = null;
}

function billingPlans() {
  if (!billingPlansPromise) {
    billingPlansPromise = fetch(ENDPOINTS.billingPlans, {
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((payload) => payload || { enabled: false, plans: [], topUpUrl: null, prices: {} });
  }

  return billingPlansPromise;
}

/**
 * Paints the pricing cards from the server's prices.
 *
 * The markup ships with the current figures written in, so the page is right
 * with JavaScript off and right before this resolves — but the server has the
 * only definition, and this is what makes the card and the "Абонамент" line
 * inside the account incapable of disagreeing. They now read the same number
 * from the same place.
 *
 * Silent when the call fails: the markup's own figure is the correct one until
 * somebody changes the price, and blanking a pricing page because a fetch
 * failed would be a worse answer than a slightly stale one.
 */
async function paintPlanPrices() {
  const nodes = $$('[data-plan-price]');
  if (!nodes.length) return;

  const payload = await billingPlans();
  const prices = (payload && payload.prices) || {};
  // A symbol for the currencies a price is actually quoted in, and the code
  // itself for anything else — an unrecognised currency should read oddly
  // rather than silently claim to be euros.
  const symbols = { EUR: '€', BGN: 'лв.', USD: '$' };
  const currency = (payload && payload.currency) || 'EUR';
  const symbol = symbols[currency] || currency + ' ';

  nodes.forEach(function (node) {
    const price = prices[node.dataset.planPrice];
    if (typeof price !== 'number') return;
    node.textContent = symbol + price;
  });
}


/**
 * The language the page is currently being read in.
 *
 * Sent with registration and with every sign-in request, because it is the
 * only moment the server hears about it: `<html lang>` lives in the browser,
 * and every email this account ever gets is written from what we store now.
 * Reading it off the element rather than from the i18n module keeps this
 * working whether that module has finished booting or not.
 */
function currentLocale() {
  return (document.documentElement.lang || 'bg').slice(0, 5);
}

/*
 * Credentials live in `auth.js`.
 *
 * Moved out because this is the interface's security boundary: two identities
 * that must never be confused, and a set of rules short enough to read in one
 * sitting if they are not buried in eight thousand lines of rendering. What it
 * defines and this file uses: `getApiKey`, `setApiKey`, `getOperatorKey`,
 * `setOperatorKey`, `clearAllCredentials`, `getSession`, `setSession`,
 * `authHeaders` (customer), `operatorHeaders` (operator),
 * `hasCustomerCredentials`, `operatorKnown` and `usingOperatorKey`.
 *
 * The rule it exists to enforce, in one line: `authHeaders` cannot send an
 * operator key, because it never reads the slot one is kept in.
 */


/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.prototype.slice.call(document.querySelectorAll(selector));

// Pinned to the currency, not to the country: the amounts are euros whoever
// is reading. Only the presentation follows the language — "4,12 €" for a
// Bulgarian reader, "€4.12" for an English one.
const euro = new Intl.NumberFormat(document.documentElement.lang || 'bg-BG', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
});

const relativeTime = new Intl.RelativeTimeFormat(document.documentElement.lang || 'bg', {
  numeric: 'auto',
});

function formatRelative(isoString) {
  if (!isoString) return '—';
  const then = typeof isoString === 'number' ? isoString : new Date(isoString).getTime();
  if (Number.isNaN(then)) return '—';

  const diffMinutes = Math.round((then - Date.now()) / 60000);
  const absolute = Math.abs(diffMinutes);

  if (absolute < 60) return relativeTime.format(diffMinutes, 'minute');
  if (absolute < 60 * 24) return relativeTime.format(Math.round(diffMinutes / 60), 'hour');
  return relativeTime.format(Math.round(diffMinutes / 1440), 'day');
}

/** Bulgarian counts one thing differently from many. "1 страници" reads as a bug. */
function plural(count, one, many) {
  // Translated on the way out, so every "3 оферти" built with this comes out
  // in the reader's language rather than only the ones rewritten by hand.
  return translate(Number(count) === 1 ? one : many);
}

/** "90" → "1 ч 30 мин". Minutes past a day read as noise in a table cell. */
function formatInterval(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 60) return value + ' мин';

  const hours = Math.floor(value / 60);
  const rest = value % 60;
  if (hours < 24) return hours + ' ч' + (rest ? ' ' + rest + ' мин' : '');

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return days + ' дни' + (restHours ? ' ' + restHours + ' ч' : '');
}

/** Escapes text before it goes anywhere near innerHTML. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;

function toast(message, tone) {
  const element = $('#toast');
  const palette = {
    success: 'border-emerald-500/40 text-emerald-500',
    error: 'border-red-500/40 text-red-500',
    info: 'border-white/10 text-slate-200',
  };

  element.className =
    'pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border bg-ink-800 px-4 py-3 text-[12.5px] font-medium shadow-2xl transition-all duration-300 opacity-100 translate-y-0 ' +
    (palette[tone] || palette.info);
  element.textContent = message;

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () {
    element.style.opacity = '0';
    element.style.transform = 'translate(-50%, 12px)';
    window.setTimeout(function () {
      element.style.opacity = '';
      element.style.transform = '';
      element.className =
        'pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 translate-y-3 rounded-xl border border-white/10 bg-ink-800 px-4 py-3 text-[12.5px] font-medium text-slate-200 opacity-0 shadow-2xl transition-all duration-300';
    }, 320);
  }, 3600);
}

/* ------------------------------------------------------------------ *
 * View switching
 * ------------------------------------------------------------------ */

const VIEWS = [
  'landing',
  'catalogue',
  'dashboard',
  'savings',
  'operator',
  'terms',
  'privacy',
  'gdpr',
];
let currentView = '';

function switchView(name, options) {
  if (VIEWS.indexOf(name) === -1) name = 'landing';
  if (name === currentView && !(options && options.force)) return;

  currentView = name;

  VIEWS.forEach(function (view) {
    const section = document.getElementById('view-' + view);
    if (!section) return;
    const active = view === name;
    section.hidden = !active;
    if (active) {
      section.classList.remove('fade-up');
      // Reflow so the animation restarts on every switch.
      void section.offsetWidth;
      section.classList.add('fade-up');
    }
  });

  $$('.nav-link').forEach(function (button) {
    const active = button.dataset.view === name;
    // The logo and the solid call-to-action are navigation too, but they
    // must never take the pill background — on the logo it renders as a
    // grey box clipping the mark.
    const stylable =
    !button.hasAttribute('data-logo') &&
    !button.dataset.plan &&
    !button.hasAttribute('data-plan-trial');
    button.classList.toggle('tab-active', active && stylable);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  if (window.location.hash !== '#' + name) {
    window.history.replaceState(null, '', '#' + name);
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (name === 'operator') {
    void loadOperatorPanel();
    return;
  }

  // The customer views, and the reason they are gated rather than simply
  // hopeful.
  //
  // An operator holds no customer credential, so every request these make is
  // one the server will refuse — correctly, and by design. The interface used
  // to make them anyway and paper over the wall of refusals, which is how a
  // working system came to look broken the moment somebody pasted an operator
  // key: eight endpoints answering "this is an operator key" at once.
  //
  // Asked here, once, rather than inside each loader, because the next
  // customer view added must not have to remember.
  if (usingOperatorKey) {
    showOperatorOnlyNotice(name);
    return;
  }

  if (name === 'dashboard') {
    loadProducts();
    // The first thing on the dashboard, so it is asked for first (§3.1).
    void renderMoneyScreen();
  }
  if (name === 'catalogue') void loadShops();
  if (name === 'savings') void loadSavings();
  if (name === 'dashboard' || name === 'catalogue' || name === 'savings') void refreshPlanBar();
}

/**
 * Says why a customer screen is empty for an operator, instead of showing a
 * row of failed requests.
 *
 * An operator key is not a lesser customer key — it belongs to no account, so
 * there is genuinely nothing for these screens to show. The honest answer is a
 * sentence and a way back to the panel, which is the screen this person
 * actually wanted.
 */
function showOperatorOnlyNotice(view) {
  const targets = {
    dashboard: '#products-table-body',
    catalogue: '#shops-list',
    savings: '#savings-summary',
  };

  const holder = $(targets[view]);
  if (!holder) return;

  const notice =
    'Влезли сте с операторски ключ. Той няма клиентски акаунт, затова тук няма какво да се покаже. ' +
    'Отворете панела, или поставете клиентски ключ.';

  const html =
    '<p class="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 text-[12.5px] text-amber-300">' +
    translate(notice) +
    '</p>';

  // The products table is a <tbody>, so a bare <p> would be dropped by the
  // parser. Wrapped in a full-width cell it lands where it was meant to.
  holder.innerHTML =
    holder.tagName === 'TBODY'
      ? '<tr><td colspan="99" class="px-3.5 py-6">' + html + '</td></tr>'
      : html;

  const roi = $('#savings-roi');
  const history = $('#savings-history');
  if (view === 'savings') {
    if (roi) roi.innerHTML = '';
    if (history) history.innerHTML = '';
  }
}

/*
 * Delegated, not bound per element.
 *
 * This used to be `$$('.nav-link').forEach(addEventListener)`, which runs once
 * at load and therefore only ever reaches the buttons already in the markup.
 * Most of this interface is built as HTML strings long afterwards, so every
 * `.nav-link` rendered by JavaScript — the onboarding checklist's "Price it",
 * "How this is calculated", the "all →" links — looked like a button, had a
 * cursor and a hover state, and did nothing at all when clicked.
 *
 * One listener on the document covers both, and covers whatever gets rendered
 * next without anyone having to remember to re-bind.
 */
document.addEventListener('click', function (event) {
  const button = event.target.closest('.nav-link[data-view]');
  if (!button) return;

  switchView(button.dataset.view);
  if (button.dataset.view === 'catalogue' && window.resizeSearchBox) window.resizeSearchBox();

  // `switchView` scrolls to the top, and returns early when the view is
  // already open — so the section scroll is queued after it either way.
  const section = button.dataset.scroll && document.getElementById(button.dataset.scroll);
  if (section) {
    window.setTimeout(function () {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }
});

window.addEventListener('hashchange', function () {
  switchView(window.location.hash.replace('#', ''));
});

/*
 * A reload lands here, and must not become a second search.
 *
 * The id in the address bar names a comparison the server already has. Asking
 * for it costs one indexed read; running the search again would cost a dozen
 * requests to other people's servers and would return different prices — so
 * the reader would lose the answer they were reading by the act of looking at
 * it again.
 */
window.addEventListener('DOMContentLoaded', function () {
  const saved = new URLSearchParams(window.location.search).get('s');
  if (!saved || !isIdentified()) return;

  switchView('catalogue');
  void openSavedSearch(saved);
});

window.addEventListener('DOMContentLoaded', function () {
  void renderSearchHistory();
});

/* ------------------------------------------------------------------ *
 * API key badge
 * ------------------------------------------------------------------ */

function renderApiKeyBadge() {
  const key = getApiKey();
  const label = $('#api-key-label');
  const button = $('#api-key-button');

  if (key) {
    label.textContent = key.slice(0, 12) + '…';
    button.classList.remove('text-slate-400');
    button.classList.add('text-accent-300', 'border-accent-500/30');
  } else {
    label.textContent = 'Няма ключ';
    button.classList.add('text-slate-400');
    button.classList.remove('text-accent-300', 'border-accent-500/30');
  }
}


/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

const THEME_STORAGE = 'stoclify.theme';
const themeToggle = $('#theme-toggle');

function syncThemeControl() {
  themeToggle.setAttribute(
    'aria-checked',
    document.documentElement.classList.contains('dark') ? 'true' : 'false',
  );
}

themeToggle.addEventListener('click', function () {
  const dark = document.documentElement.classList.toggle('dark');
  try {
    window.localStorage.setItem(THEME_STORAGE, dark ? 'dark' : 'light');
  } catch (error) {
    /* private mode — the choice simply does not persist */
  }
  syncThemeControl();
});

// Follow the OS only while the visitor has expressed no preference here.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (event) {
  let stored = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE);
  } catch (error) {
    /* ignore */
  }
  if (stored !== null) return;

  document.documentElement.classList.toggle('dark', event.matches);
  syncThemeControl();
});

syncThemeControl();

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

function openModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const field = modal.querySelector('input, select, textarea');
  if (field) window.setTimeout(() => field.focus(), 40);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

$$('[data-close-modal]').forEach(function (button) {
  button.addEventListener('click', () => closeModal(button.dataset.closeModal));
});

['key-modal', 'signup-modal', 'signin-modal', 'supplier-modal', 'product-modal', 'edit-product-modal', 'shop-modal', 'detect-modal', 'outreach-modal', 'palette-modal'].forEach(function (id) {
  // Clicking the backdrop closes; clicking the panel must not.
  document.getElementById(id).addEventListener('click', function (event) {
    if (event.target === this) closeModal(id);
  });
});

document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;

  // A pending confirmation must be *answered*, not merely hidden —
  // leaving the promise unresolved would hang the action forever.
  if (!document.getElementById('confirm-modal').classList.contains('hidden')) {
    settleConfirm(false);
    return;
  }

  ['key-modal', 'signup-modal', 'signin-modal', 'supplier-modal', 'product-modal', 'edit-product-modal', 'shop-modal', 'detect-modal', 'outreach-modal', 'palette-modal'].forEach(closeModal);
});

/* ------------------------------------------------------------------ *
 * Confirmation dialog
 * ------------------------------------------------------------------ */

let confirmResolve = null;
let confirmTimer = null;

/**
 * Asks before something irreversible.
 *
 * `countdownSeconds` holds the confirm button disabled for a moment. The
 * point is not to be annoying — it is that deleting a product destroys
 * its whole price history, and the muscle memory of clicking through
 * dialogs is exactly what makes that happen by accident.
 *
 * Returns a promise resolving true only on an explicit confirmation.
 */
function confirmDialog(title, message, confirmLabel, options) {
  const settings = options || {};

  $('#confirm-title').textContent = title;
  $('#confirm-message').innerHTML = message;
  $('#confirm-accept-label').textContent = confirmLabel || 'Потвърди';

  const note = $('#confirm-note');
  if (settings.note) {
    note.textContent = settings.note;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  const accept = $('#confirm-accept');
  const seconds = settings.countdownSeconds || 0;
  let remaining = seconds;

  window.clearInterval(confirmTimer);

  if (remaining > 0) {
    accept.disabled = true;
    $('#confirm-accept-label').textContent =
      (confirmLabel || 'Потвърди') + ' (' + remaining + ')';

    confirmTimer = window.setInterval(function () {
      remaining -= 1;
      if (remaining > 0) {
        $('#confirm-accept-label').textContent =
          (confirmLabel || 'Потвърди') + ' (' + remaining + ')';
        return;
      }
      window.clearInterval(confirmTimer);
      accept.disabled = false;
      $('#confirm-accept-label').textContent = confirmLabel || 'Потвърди';
    }, 1000);
  } else {
    accept.disabled = false;
  }

  openModal('confirm-modal');
  // Focus lands on Cancel, so a stray Enter cancels rather than destroys.
  window.setTimeout(() => $('#confirm-cancel').focus(), 60);

  return new Promise(function (resolve) {
    confirmResolve = resolve;
  });
}

function settleConfirm(result) {
  window.clearInterval(confirmTimer);
  closeModal('confirm-modal');

  if (confirmResolve) {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve(result);
  }
}

$('#confirm-accept').addEventListener('click', () => settleConfirm(true));
$('#confirm-cancel').addEventListener('click', () => settleConfirm(false));

document.getElementById('confirm-modal').addEventListener('click', function (event) {
  if (event.target === this) settleConfirm(false);
});

/* ------------------------------------------------------------------ *
 * API key modal
 * ------------------------------------------------------------------ */

$('#api-key-button').addEventListener('click', function () {
  $('#key-input').value = getApiKey();
  $('#key-status').classList.add('hidden');
  openModal('key-modal');
});

$('#key-toggle').addEventListener('click', function () {
  const field = $('#key-input');
  const icon = this.querySelector('i');
  const hidden = field.type === 'password';
  field.type = hidden ? 'text' : 'password';
  icon.className = hidden ? 'fa-solid fa-eye-slash text-[12.5px]' : 'fa-solid fa-eye text-[12.5px]';
});

function showKeyStatus(message, tone) {
  const element = $('#key-status');
  const palette = { success: 'text-emerald-400', error: 'text-red-400', info: 'text-slate-400' };
  element.className = 'mt-2.5 text-[11.5px] ' + (palette[tone] || palette.info);
  element.textContent = message;
  element.classList.remove('hidden');
}

$('#key-form').addEventListener('submit', async function (event) {
  event.preventDefault();

  const candidate = $('#key-input').value.trim();
  if (!candidate) {
    showKeyStatus('Въведете ключ или натиснете „Изтрий".', 'error');
    return;
  }

  $('#key-save-spinner').classList.remove('hidden');
  $('#key-save-icon').classList.add('hidden');
  showKeyStatus('Проверка срещу API-то…', 'info');

  try {
    // Verified against a real endpoint rather than just stored: a key that
    // is wrong should say so here, not fail silently on every later call.
    const response = await fetch(ENDPOINTS.products + '?limit=1', {
      headers: { Accept: 'application/json', 'x-api-key': candidate },
    });

    if (response.status === 401) {
      showKeyStatus('Ключът е невалиден. Проверете го и опитайте пак.', 'error');
      return;
    }
    if (response.status === 403) {
      showKeyStatus('Ключът е валиден, но абонаментът е изтекъл.', 'error');
      return;
    }

    // An operator key has no account, so the customer endpoint refuses it by
    // design — a correct answer, not a broken one. Left to fall through it
    // landed in the catch below and reported "the API did not answer", which
    // is the opposite of what happened: the API answered precisely. Ask the
    // endpoint that *is* the operator's instead, and say which key this is.
    if (response.status === 400) {
      const asOperator = await fetch(ENDPOINTS.billingUsers, {
        headers: { Accept: 'application/json', 'x-api-key': candidate },
      });

      if (!asOperator.ok) {
        showKeyStatus('Ключът е невалиден. Проверете го и опитайте пак.', 'error');
        return;
      }

      // Into the operator slot, which is a different box from the customer
      // one. This is the moment the two identities are told apart, and doing
      // it here — once, where the server has just said which this is — is what
      // keeps every later request from having to guess.
      setOperatorKey(candidate);
      forgetAccount();
      renderAccount();
      showKeyStatus('Операторски ключ — валиден и запазен в този браузър.', 'success');
      toast('Операторският ключ е активен.', 'success');
      window.setTimeout(() => closeModal('key-modal'), 700);
      // No loadProducts(): an operator key has no products, and asking would
      // earn the same 400 the branch above just explained.
      return;
    }

    if (!response.ok) throw new Error('HTTP ' + response.status);

    // A customer key. Any operator key in this browser goes, for the same
    // reason the reverse is true: holding both leaves every request needing a
    // decision nobody made.
    setOperatorKey('');
    setApiKey(candidate);
    forgetAccount();
    renderAccount();
    showKeyStatus('Ключът е валиден и запазен в този браузър.', 'success');
    toast('API ключът е активен.', 'success');
    window.setTimeout(() => closeModal('key-modal'), 700);
    loadProducts();
  } catch (error) {
    // The key may still be right while the server is down; store it and
    // say exactly that rather than blaming the key. As a customer key: the
    // operator slot is only ever filled by a server that confirmed it, so an
    // unreachable server must never put one there.
    setApiKey(candidate);
    showKeyStatus(failureText(error, 'API-то не отговори — ключът е запазен'), 'info');
  } finally {
    $('#key-save-spinner').classList.add('hidden');
    $('#key-save-icon').classList.remove('hidden');
  }
});

$('#key-remove').addEventListener('click', function () {
  // Both slots. "Remove the key" means this browser holds no credential, and
  // leaving an operator key behind because the dialog was showing a customer
  // one would be the surprise version of that.
  clearAllCredentials();
  forgetAccount();
  renderAccount();
  $('#key-input').value = '';
  showKeyStatus('Ключът е премахнат от този браузър.', 'info');
  loadProducts();
});

/* ------------------------------------------------------------------ *
 * SECTION 3 — dashboard
 * ------------------------------------------------------------------ */

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

/**
 * The sample catalogue behind the demo dashboard.
 *
 * Rewritten from tactical gear to electrical wholesale, which is what the rest
 * of the product talks about: the hero panel prices cable and bulbs, the sample
 * search answers "лед крушка", and the dashboard was showing plate carriers and
 * airsoft replicas. One sample world rather than three, so a visitor moving
 * between the screens sees the same suppliers and the same articles.
 *
 * It also makes the demo translatable at a sane cost. The old set carried
 * thirty-six product and supplier names across nine categories; this one reuses
 * the four suppliers from `DEMO_SHOPS` and a handful of articles, so a new
 * language is a few dozen dictionary entries rather than a catalogue.
 *
 * Every price is invented. The screens that show these say so.
 */
const DEMO_PRODUCTS = [
  {
    id: 'demo-1',
    name: 'Кабел СВТ 3x2.5 мм²',
    sku: 'KBL-SVT-3X25',
    brand: 'Булкабел',
    manufacturer: 'Булкабел АД',
    model: 'СВТ 3x2.5',
    category: 'Кабели',
    gtin: '3800111000012',
    attributes: { Сечение: '3x2.5 мм²', Жила: 'медни', Изолация: 'ПВЦ', Цвят: 'бял' },
    notes: 'Цената е на метър. Местният склад дава ценоразпис по имейл.',
    marketPrice: 5.4,
    targetPrice: 4.2,
    suppliers: [
      { name: 'Електро Склад', host: 'electro-sklad.example', price: 4.68, previousPrice: 4.68, inStock: true, status: 'active', currency: 'EUR', isPrimary: true, sellerName: 'Електро Склад ЕООД', location: 'София, България', lastStrategy: 'json-ld', updatedAt: minutesAgo(12) },
      { name: 'Кабел Про', host: 'kabel-pro.example', price: 4.73, previousPrice: 4.9, inStock: true, status: 'active', currency: 'EUR', location: 'Пловдив, България', lastStrategy: 'selector', updatedAt: minutesAgo(31) },
      { name: 'Техно Депо', host: 'tehno-depo.example', price: 5.12, previousPrice: 5.12, inStock: true, status: 'active', currency: 'EUR', location: 'Варна, България', lastStrategy: 'microdata', updatedAt: minutesAgo(58) },
      { name: 'Местен склад', host: 'mesten-sklad.example', price: 4.55, previousPrice: 4.55, inStock: true, status: 'active', currency: 'EUR', location: 'Русе, България', lastStrategy: 'manual', updatedAt: minutesAgo(240) },
    ],
  },
  {
    id: 'demo-2',
    name: 'LED крушка E27 12W 4000K',
    sku: 'LED-E27-12W-840',
    brand: 'Lumex',
    manufacturer: 'Lumex Lighting',
    model: 'LX-A60-12W-840',
    category: 'Осветление',
    gtin: '3800111000029',
    attributes: { Мощност: '12W', Фасунга: 'E27', 'Цветна температура': '4000K', Поток: '1055 lm' },
    marketPrice: 3.2,
    targetPrice: 2.2,
    suppliers: [
      { name: 'Светлина Трейд', host: 'svetlina.example', price: 2.29, previousPrice: 2.29, inStock: true, status: 'active', currency: 'EUR', isPrimary: true, sellerName: 'Светлина Трейд ООД', location: 'София, България', lastStrategy: 'json-ld', updatedAt: minutesAgo(8) },
      { name: 'Електро Склад', host: 'electro-sklad.example', price: 2.63, previousPrice: 2.51, inStock: true, status: 'active', currency: 'EUR', location: 'София, България', lastStrategy: 'selector', updatedAt: minutesAgo(22) },
      { name: 'Техно Депо', host: 'tehno-depo.example', price: 2.45, previousPrice: 2.45, inStock: true, status: 'active', currency: 'EUR', location: 'Варна, България', lastStrategy: 'microdata', updatedAt: minutesAgo(45) },
    ],
  },
  {
    id: 'demo-3',
    name: 'Контактор 25A 230V 2NO',
    sku: 'KNT-25A-230-2NO',
    brand: 'Elmatic',
    manufacturer: 'Elmatic Industrial',
    model: 'EM-C25-230',
    category: 'Апаратура',
    gtin: '3800111000036',
    attributes: { Ток: '25A', Напрежение: '230V', Контакти: '2NO', Монтаж: 'DIN шина' },
    notes: 'Поскъпна с 6% в Техно Депо вчера — алармата се задейства.',
    marketPrice: 16.9,
    targetPrice: 11.5,
    suppliers: [
      { name: 'Кабел Про', host: 'kabel-pro.example', price: 11.4, previousPrice: 11.4, inStock: true, status: 'active', currency: 'EUR', isPrimary: true, sellerName: 'Кабел Про ЕООД', location: 'Пловдив, България', lastStrategy: 'json-ld', updatedAt: minutesAgo(17) },
      { name: 'Електро Склад', host: 'electro-sklad.example', price: 12.1, previousPrice: 12.1, inStock: true, status: 'active', currency: 'EUR', location: 'София, България', lastStrategy: 'selector', updatedAt: minutesAgo(36) },
      { name: 'Техно Депо', host: 'tehno-depo.example', price: 13.2, previousPrice: 12.45, inStock: true, status: 'active', currency: 'EUR', location: 'Варна, България', lastStrategy: 'microdata', updatedAt: minutesAgo(64) },
    ],
  },
  {
    id: 'demo-4',
    name: 'ПВЦ тръба ф20, 3 м',
    sku: 'PVC-TR-20-3M',
    brand: 'Пластимо',
    manufacturer: 'Пластимо ЕООД',
    model: 'PT-20',
    category: 'Тръби и канали',
    gtin: '3800111000043',
    attributes: { Диаметър: 'ф20', Дължина: '3 м', Материал: 'ПВЦ', Клас: 'твърда' },
    marketPrice: 1.4,
    targetPrice: 0.95,
    suppliers: [
      { name: 'Местен склад', host: 'mesten-sklad.example', price: 0.94, previousPrice: 0.94, inStock: true, status: 'active', currency: 'EUR', isPrimary: true, sellerName: 'Местен склад', location: 'Русе, България', lastStrategy: 'manual', updatedAt: minutesAgo(180) },
      { name: 'Електро Склад', host: 'electro-sklad.example', price: 0.97, previousPrice: 0.97, inStock: true, status: 'active', currency: 'EUR', location: 'София, България', lastStrategy: 'json-ld', updatedAt: minutesAgo(27) },
      { name: 'Техно Депо', host: 'tehno-depo.example', price: 1.02, previousPrice: 1.02, inStock: true, status: 'active', currency: 'EUR', location: 'Варна, България', lastStrategy: 'selector', updatedAt: minutesAgo(52) },
    ],
  },
  {
    id: 'demo-5',
    name: 'Автоматичен прекъсвач C16 1P',
    sku: 'AVT-C16-1P',
    brand: 'Elmatic',
    manufacturer: 'Elmatic Industrial',
    model: 'EM-B1-C16',
    category: 'Апаратура',
    gtin: '3800111000050',
    attributes: { Ток: '16A', Характеристика: 'C', Полюси: '1P', 'Изключвателна способност': '6kA' },
    marketPrice: 4.6,
    targetPrice: 3.0,
    suppliers: [
      { name: 'Електро Склад', host: 'electro-sklad.example', price: 3.12, previousPrice: 3.12, inStock: true, status: 'active', currency: 'EUR', isPrimary: true, sellerName: 'Електро Склад ЕООД', location: 'София, България', lastStrategy: 'json-ld', updatedAt: minutesAgo(19) },
      { name: 'Кабел Про', host: 'kabel-pro.example', price: 3.35, previousPrice: 3.35, inStock: false, status: 'active', currency: 'EUR', location: 'Пловдив, България', lastStrategy: 'selector', updatedAt: minutesAgo(41) },
      { name: 'Техно Депо', host: 'tehno-depo.example', price: 3.28, previousPrice: 3.4, inStock: true, status: 'active', currency: 'EUR', location: 'Варна, България', lastStrategy: 'microdata', updatedAt: minutesAgo(70) },
    ],
  },
  {
    id: 'demo-6',
    name: 'LED прожектор 50W IP65',
    sku: 'LED-PRJ-50W-IP65',
    brand: 'Lumex',
    manufacturer: 'Lumex Lighting',
    model: 'LX-FL-50',
    category: 'Осветление',
    gtin: '3800111000067',
    attributes: { Мощност: '50W', Защита: 'IP65', 'Цветна температура': '6500K', Поток: '4250 lm' },
    marketPrice: 21.5,
    targetPrice: 14.0,
    suppliers: [
      { name: 'Светлина Трейд', host: 'svetlina.example', price: 14.9, previousPrice: 15.6, inStock: true, status: 'active', currency: 'EUR', isPrimary: true, sellerName: 'Светлина Трейд ООД', location: 'София, България', lastStrategy: 'json-ld', updatedAt: minutesAgo(14) },
      { name: 'Техно Депо', host: 'tehno-depo.example', price: 16.2, previousPrice: 16.2, inStock: true, status: 'active', currency: 'EUR', location: 'Варна, България', lastStrategy: 'selector', updatedAt: minutesAgo(48) },
    ],
  },
  {
    id: 'demo-7',
    name: 'Кабелен канал 40x25 мм, 2 м',
    sku: 'KAN-40X25-2M',
    brand: 'Пластимо',
    manufacturer: 'Пластимо ЕООД',
    model: 'PK-4025',
    category: 'Тръби и канали',
    gtin: '3800111000074',
    attributes: { Размер: '40x25 мм', Дължина: '2 м', Материал: 'ПВЦ', Цвят: 'бял' },
    marketPrice: 2.9,
    targetPrice: 1.9,
    suppliers: [
      { name: 'Местен склад', host: 'mesten-sklad.example', price: 1.86, previousPrice: 1.86, inStock: true, status: 'active', currency: 'EUR', isPrimary: true, sellerName: 'Местен склад', location: 'Русе, България', lastStrategy: 'manual', updatedAt: minutesAgo(300) },
      { name: 'Кабел Про', host: 'kabel-pro.example', price: 2.04, previousPrice: 2.04, inStock: true, status: 'active', currency: 'EUR', location: 'Пловдив, България', lastStrategy: 'json-ld', updatedAt: minutesAgo(33) },
      { name: 'Електро Склад', host: 'electro-sklad.example', price: 2.18, previousPrice: 2.18, inStock: true, status: 'active', currency: 'EUR', location: 'София, България', lastStrategy: 'selector', updatedAt: minutesAgo(61) },
    ],
  },
  {
    id: 'demo-8',
    name: 'Разклонителна кутия 100x100 IP54',
    sku: 'RK-100X100-IP54',
    brand: 'Пластимо',
    manufacturer: 'Пластимо ЕООД',
    model: 'PR-100',
    category: 'Тръби и канали',
    gtin: '3800111000081',
    attributes: { Размер: '100x100 мм', Защита: 'IP54', Материал: 'ПВЦ', Монтаж: 'открит' },
    marketPrice: 3.8,
    targetPrice: 2.4,
    suppliers: [
      { name: 'Електро Склад', host: 'electro-sklad.example', price: 2.42, previousPrice: 2.42, inStock: true, status: 'active', currency: 'EUR', isPrimary: true, sellerName: 'Електро Склад ЕООД', location: 'София, България', lastStrategy: 'json-ld', updatedAt: minutesAgo(25) },
      { name: 'Техно Депо', host: 'tehno-depo.example', price: 2.61, previousPrice: 2.55, inStock: true, status: 'active', currency: 'EUR', location: 'Варна, България', lastStrategy: 'microdata', updatedAt: minutesAgo(55) },
    ],
  },
];

let products = DEMO_PRODUCTS.slice();

/** How many products this account actually has, as the API reported. */
let trackedCount = 0;
let revealed = false;
let activeFilters = { savings: false, problems: false, supplier: '', brand: '', category: '' };
const expandedRows = new Set();

const STATUS_BADGE = {
  active: { label: 'Активен', className: 'bg-emerald-500/12 text-emerald-400 ring-emerald-500/25', icon: 'fa-circle-check' },
  warning: { label: 'Забавен', className: 'bg-amber-500/12 text-amber-400 ring-amber-500/25', icon: 'fa-triangle-exclamation' },
  error: { label: 'Грешка', className: 'bg-red-500/12 text-red-400 ring-red-500/25', icon: 'fa-circle-xmark' },
};

/**
 * Everything the comparison view needs, derived once per product.
 * Only in-stock listings can win: the cheapest price at a warehouse that
 * cannot ship it is not a price you can actually buy at.
 */
function analyse(product) {
  const suppliers = product.suppliers || [];
  const priced = suppliers.filter((s) => typeof s.price === 'number');
  const buyable = priced.filter((s) => s.inStock !== false);
  const pool = buyable.length > 0 ? buyable : priced;

  const newest =
    suppliers.reduce(function (latest, supplier) {
      const time = new Date(supplier.updatedAt).getTime();
      return Number.isNaN(time) ? latest : Math.max(latest, time);
    }, 0) || null;

  // Counted once here so the chip, the tooltip and the CSV cannot drift
  // apart into three slightly different answers to the same question.
  const tally = {
    total: suppliers.length,
    priced: priced.length,
    inStock: suppliers.filter((s) => s.inStock === true).length,
    outOfStock: suppliers.filter((s) => s.inStock === false).length,
    unknown: suppliers.filter((s) => s.inStock !== true && s.inStock !== false).length,
    paused: suppliers.filter((s) => s.isActive === false).length,
    failing: suppliers.filter((s) => s.status === 'error').length,
    stale: suppliers.filter((s) => s.status === 'warning').length,
  };

  const currencies = Array.from(
    new Set(suppliers.map((s) => s.currency).filter(Boolean)),
  ).sort();

  const status = suppliers.some((s) => s.status === 'error')
    ? 'error'
    : suppliers.some((s) => s.status === 'warning')
      ? 'warning'
      : 'active';

  // `count` is the number of warehouses, never the number of *priced*
  // warehouses. Conflating the two made a product with five listings and
  // no scrape yet report "0 склада" — and hid the list that would have
  // let you fix it.
  if (pool.length === 0) {
    return {
      best: null,
      worst: null,
      median: null,
      spread: 0,
      spreadPercent: null,
      margin: null,
      trend: null,
      belowTarget: false,
      status: suppliers.length === 0 ? 'warning' : status,
      updatedAt: newest ? new Date(newest).toISOString() : null,
      count: suppliers.length,
      tally: tally,
      currencies: currencies,
      sorted: [],
    };
  }

  const sorted = pool.slice().sort((a, b) => a.price - b.price);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1].price + sorted[middle].price) / 2
      : sorted[middle].price;

  // Movement of the cheapest offer since its previous observed price —
  // the number that decides whether to buy today or wait.
  const trend =
    typeof best.previousPrice === 'number' && best.previousPrice > 0
      ? ((best.price - best.previousPrice) / best.previousPrice) * 100
      : null;

  return {
    best: best,
    worst: worst,
    median: median,
    spread: worst.price - best.price,
    spreadPercent: best.price > 0 ? ((worst.price - best.price) / best.price) * 100 : null,
    margin: product.marketPrice
      ? ((product.marketPrice - best.price) / product.marketPrice) * 100
      : null,
    trend: trend,
    belowTarget: product.targetPrice != null && best.price <= product.targetPrice,
    status: status,
    updatedAt: newest ? new Date(newest).toISOString() : null,
    count: suppliers.length,
    tally: tally,
    currencies: currencies,
    sorted: sorted,
  };
}

function matchesQuery(product, query) {
  if (!query) return true;
  const haystack = [
    product.name,
    product.sku || '',
    product.brand || '',
    product.manufacturer || '',
    product.model || '',
    product.category || '',
    product.gtin || '',
    Object.values(product.attributes || {}).join(' '),
    product.suppliers.map((s) => s.name + ' ' + s.host + ' ' + (s.location || '')).join(' '),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.indexOf(query) !== -1;
}

function visibleProducts() {
  const query = $('#table-search').value.trim().toLowerCase();

  return products.filter(function (product) {
    if (!matchesQuery(product, query)) return false;

    if (activeFilters.supplier) {
      const has = product.suppliers.some((s) => s.host === activeFilters.supplier);
      if (!has) return false;
    }

    if (activeFilters.brand && (product.brand || '') !== activeFilters.brand) return false;
    if (activeFilters.category && (product.category || '') !== activeFilters.category) {
      return false;
    }

    const view = analyse(product);
    if (activeFilters.savings && !(view.spread > 0.01)) return false;
    if (activeFilters.problems && view.status === 'active') return false;

    return true;
  });
}

function addSupplierButton(product) {
  return (
    '<button type="button" data-add-supplier="' +
    escapeHtml(product.id) +
    '" class="inline-flex items-center gap-2 rounded-xl border border-dashed border-white/15 px-3.5 py-2.5 text-[12.5px] font-medium text-slate-400 transition hover:border-accent-500/50 hover:text-accent-300">' +
    '<i class="fa-solid fa-plus text-[11px]"></i>Добави склад</button>'
  );
}

/** A small square action button. Icon-only, so the row stays readable. */
function iconButton(action, id, icon, title, extraClass) {
  return (
    '<button type="button" data-action="' +
    action +
    '" data-id="' +
    escapeHtml(id) +
    '" title="' +
    escapeHtml(title) +
    '" aria-label="' +
    escapeHtml(title) +
    '" class="grid h-8 w-8 place-items-center rounded-lg text-[11px] text-slate-500 transition hover:bg-white/5 hover:text-slate-200 ' +
    (extraClass || '') +
    '"><i class="fa-solid ' +
    icon +
    '"></i></button>'
  );
}

/* --- Cell building blocks ------------------------------------------ */

/** Six fixed tints, picked by a hash of the brand — the same brand keeps
    the same colour across renders, which is what makes it scannable. */
const AVATAR_TONES = [
  'bg-sky-500/12 text-sky-400 ring-sky-500/25',
  'bg-violet-500/12 text-violet-400 ring-violet-500/25',
  'bg-amber-500/12 text-amber-400 ring-amber-500/25',
  'bg-emerald-500/12 text-emerald-400 ring-emerald-500/25',
  'bg-rose-500/12 text-rose-400 ring-rose-500/25',
  'bg-indigo-500/12 text-indigo-400 ring-indigo-500/25',
];

function toneFor(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function initialsFor(text) {
  const words = String(text || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Product image when the shop gave us one, brand initials when it did not. */
function productThumb(product) {
  const label = product.brand || product.name || '';

  if (product.imageUrl) {
    return (
      '<img src="' +
      escapeHtml(product.imageUrl) +
      '" alt="" loading="lazy" class="h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-white/10" />'
    );
  }

  return (
    '<span class="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[11.5px] font-bold ring-1 ' +
    toneFor(label) +
    '">' +
    escapeHtml(initialsFor(translate(label))) +
    '</span>'
  );
}

/**
 * A cell with nothing in it.
 *
 * Every column used to spell "no data" its own way — right-aligned in the
 * numeric ones, left-aligned in the text ones, and blurred along with the
 * prices in two of them, which put a fuzzy dash on screen. One centred,
 * unblurred mark reads as a row of aligned placeholders instead of noise;
 * an em dash is not a wholesale price and has nothing to hide.
 */
function emptyMark(note) {
  return (
    '<span class="block text-center text-[12.5px] text-slate-600">—</span>' +
    (note
      ? '<span class="mt-0.5 block truncate text-center text-[11px] text-slate-600">' +
        escapeHtml(note) +
        '</span>'
      : '')
  );
}

function chipHtml(icon, text, extraClass, hoverAttributes) {
  return (
    '<span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ' +
    (extraClass || 'bg-white/5 text-slate-400') +
    '"' +
    (hoverAttributes || '') +
    '>' +
    (icon ? '<i class="fa-solid ' + icon + ' text-[9px] opacity-70"></i>' : '') +
    escapeHtml(text) +
    '</span>'
  );
}

/** What a single warehouse is currently doing, as one word and one colour. */
function supplierState(supplier) {
  if (supplier.isActive === false) return { key: 'paused', label: 'спрян', tone: 'text-slate-600' };
  if (supplier.status === 'error') return { key: 'error', label: 'грешка', tone: 'text-red-400' };
  if (typeof supplier.price !== 'number') {
    return { key: 'pending', label: 'без цена', tone: 'text-slate-500' };
  }
  if (supplier.inStock === false) {
    return { key: 'out', label: 'изчерпан', tone: 'text-amber-400' };
  }
  if (supplier.status === 'warning') return { key: 'stale', label: 'забавен', tone: 'text-amber-300' };
  return { key: 'ok', label: 'наличен', tone: 'text-emerald-400' };
}

/**
 * The warehouse count, as a chip you can read without expanding the row:
 * how many warehouses, and a dot per warehouse coloured by its state.
 * Hovering (or tapping) it opens the full list.
 */
function warehouseChipHtml(product, view) {
  const suppliers = product.suppliers || [];
  const shown = suppliers.slice(0, 8);

  const dots = shown
    .map(function (supplier) {
      return '<span class="wh-dot ' + supplierState(supplier).tone + '"></span>';
    })
    .join('');

  const overflow = suppliers.length - shown.length;
  const tally = view.tally;

  const summary =
    tally.total === 0
      ? 'няма складове'
      : tally.total +
        ' склада, ' +
        tally.inStock +
        ' налични, ' +
        tally.outOfStock +
        ' изчерпани, ' +
        (tally.total - tally.priced) +
        ' без цена';

  return (
    '<span class="wh-chip" tabindex="0" role="button" data-hover="warehouses" data-hover-id="' +
    escapeHtml(product.id) +
    '" aria-label="' +
    escapeHtml(summary) +
    '">' +
    '<i class="fa-solid fa-warehouse text-[9.5px] text-slate-500"></i>' +
    '<span class="num text-[10px] font-semibold text-slate-300">' +
    tally.total +
    '</span>' +
    '<span class="text-[10px] text-slate-500">' + translate('склада') + '</span>' +
    (dots ? '<span class="wh-dots">' + dots + '</span>' : '') +
    (overflow > 0 ? '<span class="text-[10px] text-slate-500">+' + overflow + '</span>' : '') +
    '</span>'
  );
}

/**
 * Cheapest to dearest on one bar, with our own selling price pinned on the
 * same scale. Two shops 20 % apart and two shops 2 % apart both read as
 * "you save X €" in a number; only the bar shows which is which.
 */
function rangeCellHtml(product, view) {
  if (!view.best || !view.worst || view.sorted.length < 2) {
    return emptyMark(view.count === 0 ? 'няма складове' : 'само един с цена');
  }

  const span = view.worst.price - view.best.price;
  const position = function (value) {
    if (span <= 0) return 50;
    return Math.min(100, Math.max(0, ((value - view.best.price) / span) * 100));
  };

  const marketPin =
    product.marketPrice != null &&
    product.marketPrice >= view.best.price &&
    product.marketPrice <= view.worst.price
      ? '<span class="range-pin" style="left:' +
        position(product.marketPrice).toFixed(1) +
        '%" title="Вашата цена"></span>'
      : '';

  return (
    '<span class="flex items-baseline gap-2">' +
    '<span class="num text-[12.5px] font-semibold ' +
    (view.spread > 0.01 ? 'text-emerald-400' : 'text-slate-600') +
    '"><span class="masked">' +
    (view.spread > 0.01 ? euro.format(view.spread) : '—') +
    '</span></span>' +
    (view.spreadPercent !== null && view.spreadPercent > 0.05
      ? '<span class="num text-[11px] text-slate-500">' + view.spreadPercent.toFixed(1) + '%</span>'
      : '') +
    '</span>' +
    '<span class="mt-1.5 block"><span class="range-track block">' +
    marketPin +
    '</span>' +
    '<span class="num mt-1 flex justify-between text-[10px] text-slate-500">' +
    '<span class="masked">' +
    euro.format(view.best.price) +
    '</span><span class="masked">' +
    euro.format(view.worst.price) +
    '</span></span></span>'
  );
}

/** Movement of the cheapest offer since the previous observation. */
function trendHtml(view) {
  if (view.trend === null || Math.abs(view.trend) < 0.05) return '';

  const falling = view.trend < 0;
  return (
    '<span class="num mt-0.5 block text-[11px] ' +
    (falling ? 'text-emerald-400' : 'text-red-400') +
    '"><i class="fa-solid ' +
    (falling ? 'fa-arrow-trend-down' : 'fa-arrow-trend-up') +
    ' mr-1 text-[9px]"></i><span class="masked">' +
    (falling ? '' : '+') +
    view.trend.toFixed(1) +
    '%</span></span>'
  );
}

/* --- Hover card ----------------------------------------------------- */

const hoverCard = $('#hover-card');
let hoverAnchor = null;
let hoverPinned = false;

function hoverRow(label, value, valueClass) {
  return (
    '<div class="flex items-baseline justify-between gap-3 py-0.5">' +
    '<span class="spec-key text-[11px]">' +
    escapeHtml(label) +
    '</span><span class="text-right text-[11.5px] ' +
    (valueClass || 'text-slate-200') +
    '">' +
    value +
    '</span></div>'
  );
}

/** Every warehouse for one product, with the numbers that decide a purchase. */
function warehouseCardHtml(product, view) {
  const tally = view.tally;

  const badges = [
    { count: tally.inStock, label: 'налични', tone: 'bg-emerald-500/12 text-emerald-400' },
    { count: tally.outOfStock, label: 'изчерпани', tone: 'bg-amber-500/12 text-amber-400' },
    { count: tally.total - tally.priced, label: 'без цена', tone: 'bg-white/5 text-slate-400' },
    { count: tally.failing, label: 'с грешка', tone: 'bg-red-500/12 text-red-400' },
    { count: tally.paused, label: 'спрени', tone: 'bg-white/5 text-slate-500' },
  ]
    .filter((item) => item.count > 0)
    .map(
      (item) =>
        '<span class="rounded-md px-1.5 py-0.5 text-[10px] font-medium ' +
        item.tone +
        '">' +
        item.count +
        ' ' +
        item.label +
        '</span>',
    )
    .join('');

  const ordered = (product.suppliers || []).slice().sort(function (a, b) {
    if (typeof a.price !== 'number') return 1;
    if (typeof b.price !== 'number') return -1;
    return a.price - b.price;
  });

  const rows = ordered
    .map(function (supplier) {
      const state = supplierState(supplier);
      const isBest =
        view.best && supplier.host === view.best.host && supplier.price === view.best.price;
      const premium =
        view.best && typeof supplier.price === 'number' && view.best.price > 0
          ? ((supplier.price - view.best.price) / view.best.price) * 100
          : null;

      return (
        '<div class="flex items-center gap-2.5 border-t border-white/5 py-1.5 first:border-0">' +
        '<span class="wh-dot ' + state.tone + '"></span>' +
        '<span class="min-w-0 flex-1"><span class="block truncate text-[11.5px] font-medium text-slate-200">' +
        escapeHtml(supplier.name) +
        (isBest
          ? '<span class="ml-1.5 rounded bg-emerald-500/15 px-1 py-px align-middle text-[9.5px] font-bold uppercase text-emerald-400">най-евтин</span>'
          : '') +
        '</span><span class="block truncate font-mono text-[10px] text-slate-500">' +
        escapeHtml(supplier.host) +
        (supplier.location ? ' · ' + escapeHtml(supplier.location) : '') +
        '</span></span>' +
        '<span class="shrink-0 text-right"><span class="num block text-[11.5px] font-semibold ' +
        (isBest ? 'text-emerald-400' : 'text-slate-200') +
        '"><span class="masked">' +
        (typeof supplier.price === 'number' ? euro.format(supplier.price) : '—') +
        '</span></span>' +
        '<span class="num block text-[10px] ' +
        state.tone +
        '">' +
        (premium !== null && premium > 0.05
          ? '<span class="masked">+' + premium.toFixed(1) + '%</span> · '
          : '') +
        escapeHtml(state.label) +
        '</span></span>' +
        '<span class="w-16 shrink-0 text-right text-[10px] text-slate-500">' +
        escapeHtml(formatRelative(supplier.updatedAt)) +
        '</span>' +
        '</div>'
      );
    })
    .join('');

  const footer = view.best
    ? '<div class="border-t border-white/8 px-3.5 py-2.5">' +
      hoverRow(
        'Диапазон',
        '<span class="num masked">' +
          euro.format(view.best.price) +
          ' – ' +
          euro.format(view.worst.price) +
          '</span>',
      ) +
      hoverRow('Медиана', '<span class="num masked">' + euro.format(view.median) + '</span>') +
      (product.targetPrice != null
        ? hoverRow(
            'Праг за аларма',
            '<span class="num">' + euro.format(product.targetPrice) + '</span>',
            view.belowTarget ? 'text-emerald-400' : 'text-slate-400',
          )
        : '') +
      (view.currencies.length > 1
        ? hoverRow(
            'Валути',
            escapeHtml(view.currencies.join(', ')) +
              ' <span class="text-slate-500">(преизчислени в EUR)</span>',
          )
        : '') +
      '</div>'
    : '';

  return (
    '<div class="px-3.5 pb-2 pt-3">' +
    '<p class="text-[11.5px] font-semibold text-slate-200">' +
    escapeHtml(product.name) +
    '</p>' +
    (badges ? '<div class="mt-1.5 flex flex-wrap gap-1">' + badges + '</div>' : '') +
    '</div>' +
    (rows
      ? '<div class="max-h-72 overflow-y-auto border-t border-white/8 px-3.5 py-1">' + rows + '</div>'
      : '<p class="border-t border-white/8 px-3.5 py-2.5 text-[11.5px] text-slate-500">' +
        'Няма свързани складове. Отворете реда и добавете поне един.</p>') +
    footer
  );
}

/** Who makes it, what it is called, and whatever specs we know. */
function specCardHtml(product) {
  const attributes = product.attributes || {};
  const specs = Object.keys(attributes)
    .map((key) => hoverRow(key, escapeHtml(attributes[key])))
    .join('');

  const identity =
    hoverRow('Марка', escapeHtml(product.brand || '—')) +
    (product.manufacturer ? hoverRow('Производител', escapeHtml(product.manufacturer)) : '') +
    (product.model
      ? hoverRow('Модел', '<span class="font-mono text-[11px]">' + escapeHtml(product.model) + '</span>')
      : '') +
    (product.category ? hoverRow('Категория', escapeHtml(product.category)) : '') +
    (product.sku
      ? hoverRow('Вашият SKU', '<span class="font-mono text-[11px]">' + escapeHtml(product.sku) + '</span>')
      : '') +
    (product.gtin
      ? hoverRow(
          'Баркод (GTIN)',
          '<span class="font-mono text-[11px]">' + escapeHtml(product.gtin) + '</span>',
        )
      : '');

  return (
    '<div class="flex items-start gap-3 px-3.5 pb-3 pt-3">' +
    productThumb(product) +
    '<span class="min-w-0"><span class="block text-[11.5px] font-semibold text-slate-200">' +
    escapeHtml(product.brand || product.name) +
    '</span><span class="block truncate text-[11px] text-slate-500">' +
    escapeHtml(product.manufacturer || product.category || '') +
    '</span></span></div>' +
    '<div class="border-t border-white/8 px-3.5 py-2">' +
    identity +
    '</div>' +
    (specs
      ? '<div class="border-t border-white/8 px-3.5 py-2"><p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Спецификация</p>' +
        specs +
        '</div>'
      : '') +
    (product.notes
      ? '<div class="border-t border-white/8 px-3.5 py-2.5 text-[11px] leading-relaxed text-slate-400">' +
        '<i class="fa-solid fa-note-sticky mr-1.5 text-[10px] text-slate-500"></i>' +
        escapeHtml(product.notes) +
        '</div>'
      : '')
  );
}

/**
 * What the alert threshold actually does, and where the alert ends up.
 *
 * Stated from the server's behaviour rather than from intent: a threshold
 * that silently goes nowhere because no channel is configured is the one
 * thing a user must not have to discover the hard way.
 */
function alertsCardHtml() {
  const rows = [
    ['Под прага', 'цена в склад пада под вашия праг', 'критична'],
    ['Спад / скок', 'промяна над 5% спрямо предишната цена', 'предупреждение / инфо'],
    ['Исторически минимум', 'нова най-ниска цена за артикула', 'предупреждение'],
    ['Изчерпан', 'складът обяви артикула за изчерпан', 'инфо'],
    ['Счупен склад', 'складът се проваля многократно и е спрян', 'предупреждение'],
  ]
    .map(function (row) {
      return (
        '<div class="flex items-baseline justify-between gap-3 border-t border-white/5 py-1.5 first:border-0">' +
        '<span class="min-w-0"><span class="block text-[11.5px] font-medium text-slate-200">' +
        escapeHtml(row[0]) +
        '</span><span class="block text-[11px] text-slate-500">' +
        escapeHtml(row[1]) +
        '</span></span>' +
        '<span class="shrink-0 text-[10px] text-slate-500">' +
        escapeHtml(row[2]) +
        '</span></div>'
      );
    })
    .join('');

  return (
    '<div class="px-3.5 pb-2 pt-3">' +
    '<p class="text-[11.5px] font-semibold text-slate-200">Праг за аларма</p>' +
    '<p class="mt-1 text-[11.5px] leading-relaxed text-slate-400">' +
    'Вашата долна граница за този артикул. Щом някой склад падне под нея, системата вдига ' +
    'аларма — прагът не спира и не купува нищо, само ви казва.' +
    '</p></div>' +
    '<div class="border-t border-white/8 px-3.5 py-2">' +
    '<p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Кога се вдига аларма</p>' +
    rows +
    '</div>' +
    '<div class="border-t border-white/8 px-3.5 py-2.5">' +
    '<p class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Къде отива</p>' +
    '<p class="text-[11px] leading-relaxed text-slate-400">' +
    'В Slack, ако е зададен <code class="font-mono text-[11px] text-slate-300">ALERT_SLACK_WEBHOOK_URL</code>, ' +
    'и/или на ваш webhook през <code class="font-mono text-[11px] text-slate-300">ALERT_WEBHOOK_URL</code> ' +
    '(подписан с HMAC-SHA256). <span class="text-amber-400">Ако няма зададен канал, алармата ' +
    'се записва, но не се изпраща никъде</span> — вижда се само на ' +
    '<code class="font-mono text-[11px] text-slate-300">GET /api/v1/alerts</code>. Имейл известяване няма.' +
    '</p>' +
    '<p class="mt-2 text-[11px] text-slate-500">' +
    'Една и съща аларма за един и същи склад се повтаря най-често на 60 минути.' +
    '</p></div>'
  );
}

function hideHoverCard() {
  hoverPinned = false;
  hoverAnchor = null;
  hoverCard.dataset.open = 'false';
  hoverCard.dataset.pinned = 'false';
  hoverCard.hidden = true;
}

function showHoverCard(anchor) {
  const kind = anchor.dataset.hover;
  let html;

  if (kind === 'alerts') {
    // Explains a concept, not a row — no product to look up.
    html = alertsCardHtml();
  } else if (kind === 'offer') {
    const hit = catalogueHits.find((item) => item.offerId === anchor.dataset.hoverId);
    if (!hit) return;
    html = offerCardHtml(hit);
  } else {
    const product = products.find((item) => item.id === anchor.dataset.hoverId);
    if (!product) return;
    html = kind === 'specs' ? specCardHtml(product) : warehouseCardHtml(product, analyse(product));
  }

  hoverAnchor = anchor;
  hoverCard.innerHTML = html;
  hoverCard.hidden = false;

  // Measured after it is in the layout, then flipped above the anchor or
  // pulled back from the edge — near the right-hand columns a card that
  // only ever opens down-and-right is a card half off the screen.
  const anchorBox = anchor.getBoundingClientRect();
  const cardBox = hoverCard.getBoundingClientRect();
  const margin = 12;

  let left = anchorBox.left;
  if (left + cardBox.width > window.innerWidth - margin) {
    left = window.innerWidth - cardBox.width - margin;
  }
  left = Math.max(margin, left);

  let top = anchorBox.bottom + 8;
  if (top + cardBox.height > window.innerHeight - margin) {
    top = anchorBox.top - cardBox.height - 8;
  }
  top = Math.max(margin, top);

  hoverCard.style.left = left + 'px';
  hoverCard.style.top = top + 'px';
  window.requestAnimationFrame(function () {
    hoverCard.dataset.open = 'true';
  });
}

document.addEventListener('pointerover', function (event) {
  if (hoverPinned) return;
  const trigger = event.target.closest('[data-hover]');
  if (trigger === hoverAnchor) return;
  if (trigger) showHoverCard(trigger);
  else if (hoverAnchor && !event.target.closest('#hover-card')) hideHoverCard();
});

// Touch has no hover: a tap pins the card open instead of expanding the row.
document.addEventListener('click', function (event) {
  const trigger = event.target.closest('[data-hover]');
  if (!trigger) {
    if (!event.target.closest('#hover-card')) hideHoverCard();
    return;
  }

  event.stopPropagation();
  if (hoverPinned && trigger === hoverAnchor) {
    hideHoverCard();
    return;
  }
  showHoverCard(trigger);
  hoverPinned = true;
  hoverCard.dataset.pinned = 'true';
});

document.addEventListener('focusin', function (event) {
  const trigger = event.target.closest('[data-hover]');
  if (trigger) {
    // Tabbing to another chip must win over a card pinned by an earlier tap.
    hoverPinned = false;
    hoverCard.dataset.pinned = 'false';
    showHoverCard(trigger);
  } else if (!event.target.closest('#hover-card')) {
    hideHoverCard();
  }
});

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && hoverAnchor) hideHoverCard();
});

// Any scroll moves the anchor out from under the card, so the card goes.
window.addEventListener('scroll', hideHoverCard, true);
window.addEventListener('resize', hideHoverCard);

function supplierRowsHtml(product, view) {
  // The empty state used to return early, *before* the add button — so the
  // one moment you most need it, it was missing.
  if (view.count === 0) {
    return (
      '<div class="px-4 py-3.5"><p class="mb-3 text-[12.5px] text-slate-500">' +
      'Няма свързани складове. Добавете поне един, за да започне следенето.</p>' +
      addSupplierButton(product) +
      '</div>'
    );
  }

  const ordered = product.suppliers.slice().sort(function (a, b) {
    if (typeof a.price !== 'number') return 1;
    if (typeof b.price !== 'number') return -1;
    return a.price - b.price;
  });

  const items = ordered
    .map(function (supplier) {
      const isBest = view.best && supplier.host === view.best.host && supplier.price === view.best.price;
      const premium =
        view.best && typeof supplier.price === 'number' && view.best.price > 0
          ? ((supplier.price - view.best.price) / view.best.price) * 100
          : null;

      const detail = [
        supplier.sellerName && supplier.sellerName !== supplier.name ? supplier.sellerName : '',
        supplier.location || '',
        supplier.currency && supplier.currency !== 'EUR'
          ? 'котира в ' + supplier.currency
          : '',
        supplier.lastStrategy ? 'разчетена: ' + supplier.lastStrategy : '',
        supplier.failureCount ? supplier.failureCount + ' поредни неуспеха' : '',
      ].filter(Boolean);

      return (
        '<div class="flex items-center gap-3 rounded-xl border px-3.5 py-3 ' +
        (isBest ? 'border-emerald-500/35 bg-emerald-500/[0.06]' : 'border-white/8 bg-ink-850') +
        '">' +
        '<span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg ' +
        (isBest ? 'bg-emerald-500/15' : 'bg-white/5') +
        '"><i class="fa-solid fa-warehouse text-[11.5px] ' +
        (isBest ? 'text-emerald-400' : 'text-slate-500') +
        '"></i></span>' +
        '<span class="min-w-0 flex-1">' +
        (supplier.url
          ? '<a href="' +
            escapeHtml(supplier.url) +
            '" target="_blank" rel="noopener noreferrer" class="group/link block truncate text-[12.5px] font-medium text-slate-200 hover:text-accent-500 hover:underline" title="Отвори страницата в магазина">'
          : '<span class="block truncate text-[12.5px] font-medium text-slate-200">') +
        escapeHtml(supplier.name) +
        (supplier.url
          ? '<i class="fa-solid fa-arrow-up-right-from-square ml-1.5 text-[9px] opacity-0 transition group-hover/link:opacity-100"></i>'
          : '') +
        (isBest
          ? '<span class="ml-2 rounded-md bg-emerald-500/15 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-emerald-400">най-евтин</span>'
          : '') +
        (supplier.url ? '</a>' : '</span>') +
        '<span class="block truncate font-mono text-[11px] text-slate-500">' +
        escapeHtml(supplier.host) +
        '</span>' +
        // Everything the scrape learned about this listing, on one line:
        // who is selling, from where, in what currency, and how the price
        // was read. When a number looks wrong, this is where you look.
        (detail.length
          ? '<span class="mt-0.5 block truncate text-[11px] text-slate-500">' +
            escapeHtml(detail.join(' · ')) +
            '</span>'
          : '') +
        (supplier.lastError
          ? '<span class="mt-0.5 block truncate text-[11px] text-red-400" title="' +
            escapeHtml(supplier.lastError) +
            '"><i class="fa-solid fa-triangle-exclamation mr-1 text-[9px]"></i>' +
            escapeHtml(supplier.lastError) +
            '</span>'
          : '') +
        '</span>' +
        '<span class="shrink-0 text-right"><span class="num block text-[13px] font-semibold ' +
        (isBest ? 'text-emerald-400' : 'text-slate-200') +
        '"><span class="masked">' +
        (typeof supplier.price === 'number' ? euro.format(supplier.price) : '—') +
        '</span></span>' +
        (premium !== null && premium > 0.01
          ? '<span class="num block text-[11px] text-slate-500"><span class="masked">+' +
            premium.toFixed(1) +
            '%</span></span>'
          : '') +
        '</span>' +
        '<span class="w-24 shrink-0 text-right text-[11px] ' +
        (supplier.isActive === false
          ? 'text-slate-600'
          : supplier.inStock === false
            ? 'text-amber-400'
            : 'text-slate-500') +
        '">' +
        (supplier.isActive === false
          ? 'спрян'
          : supplier.inStock === false
            ? 'изчерпан'
            : 'наличен') +
        '</span>' +
        '<span class="w-24 shrink-0 text-right text-[11px] text-slate-500">' +
        escapeHtml(formatRelative(supplier.updatedAt)) +
        '</span>' +
        (supplier.id
          ? '<span class="flex shrink-0 items-center gap-1">' +
            iconButton('refresh-supplier', supplier.id, 'fa-rotate', 'Провери сега') +
            iconButton('edit-supplier', supplier.id, 'fa-pen', 'Редактирай') +
            (supplier.isPrimary
              ? '<span class="grid h-8 w-8 place-items-center text-[11px] text-accent-400" title="Основен склад"><i class="fa-solid fa-star"></i></span>'
              : iconButton('promote-supplier', supplier.id, 'fa-star', 'Направи основен')) +
            iconButton('delete-supplier', supplier.id, 'fa-trash', 'Изтрий', 'hover:text-red-400') +
            '</span>'
          : '') +
        '</div>'
      );
    })
    .join('');

  return (
    '<div class="space-y-2 px-4 py-2.5">' +
    specStripHtml(product) +
    items +
    '<div class="pt-1">' +
    addSupplierButton(product) +
    '</div></div>'
  );
}

/**
 * Identity and specification, laid out above the warehouse list. The same
 * facts the brand chip shows on hover — repeated here because an expanded
 * row is what gets read aloud on a call, and nobody hovers on a call.
 */
function specStripHtml(product) {
  const facts = [
    ['Производител', product.manufacturer],
    ['Модел', product.model],
    ['Категория', product.category],
    ['Баркод', product.gtin],
  ].filter((pair) => Boolean(pair[1]));

  const attributes = product.attributes || {};
  Object.keys(attributes).forEach(function (key) {
    facts.push([key, attributes[key]]);
  });

  if (facts.length === 0 && !product.notes) return '';

  const cells = facts
    .map(function (pair) {
      return (
        '<div><dt class="spec-key text-[10px] uppercase tracking-wide">' +
        escapeHtml(pair[0]) +
        '</dt><dd class="mt-0.5 text-[11.5px] text-slate-200">' +
        escapeHtml(pair[1]) +
        '</dd></div>'
      );
    })
    .join('');

  return (
    '<div class="mb-3 rounded-xl border border-white/8 bg-ink-900 px-3.5 py-3">' +
    (cells
      ? '<dl class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">' +
        cells +
        '</dl>'
      : '') +
    (product.notes
      ? '<p class="' +
        (cells ? 'mt-3 border-t border-white/8 pt-3 ' : '') +
        'text-[11.5px] leading-relaxed text-slate-400">' +
        '<i class="fa-solid fa-note-sticky mr-1.5 text-[10px] text-slate-500"></i>' +
        escapeHtml(product.notes) +
        '</p>'
      : '') +
    '</div>'
  );
}

function renderTable() {
  const list = visibleProducts();
  const body = $('#products-body');

  // The card is anchored to a node that is about to be replaced.
  hideHoverCard();

  body.innerHTML = list
    .map(function (product) {
      const view = analyse(product);
      const badge = STATUS_BADGE[view.status] || STATUS_BADGE.active;
      const open = expandedRows.has(product.id);
      const marginTone =
        view.margin === null
          ? 'text-slate-500'
          : view.margin >= 40
            ? 'text-emerald-400'
            : view.margin >= 25
              ? 'text-slate-200'
              : 'text-amber-400';

      // Model and SKU sit on one line under the name. Category, barcode
      // and manufacturer are deliberately *not* repeated here — they are
      // in the brand hover card, in the expanded row and in the filters,
      // and a third copy in the row only made every cell two lines tall.
      const identity = [product.model && translate(product.model), product.sku]
        .filter(Boolean)
        .join(' · ');

      return (
        '<tr data-row="' +
        escapeHtml(product.id) +
        '" class="cursor-pointer border-b border-white/[0.06] transition hover:bg-white/[0.025]">' +
        /* Product: thumbnail, name, identity line, warehouse chip. */
        '<td class="px-4 py-2.5"><div class="flex items-start gap-3">' +
        '<i class="fa-solid fa-chevron-right mt-2.5 shrink-0 text-[11px] text-slate-600 transition ' +
        (open ? 'rotate-90 text-accent-400' : '') +
        '"></i>' +
        productThumb(product) +
        // `text-slate-200` resolves through --text-primary, so the name is
        // dark on the light theme and light on the dark one. Tailwind's
        // literal `text-white` was white-on-white in light mode.
        '<span class="min-w-0 flex-1"><span class="clamp-2 block font-medium leading-snug text-slate-200" title="' +
        escapeHtml(product.name) +
        '">' +
        escapeHtml(product.name) +
        '</span>' +
        '<span class="mt-1 flex min-w-0 items-center gap-2">' +
        (product.brand
          ? '<span class="inline-flex shrink-0 cursor-help items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ' +
            toneFor(product.brand) +
            '" tabindex="0" role="button" data-hover="specs" data-hover-id="' +
            escapeHtml(product.id) +
            '" aria-label="Данни за ' +
            escapeHtml(product.brand) +
            '">' +
            escapeHtml(product.brand) +
            '<i class="fa-solid fa-circle-info text-[9px] opacity-60"></i></span>'
          : '') +
        (identity
          ? '<span class="truncate font-mono text-[11px] text-slate-500" title="' +
            escapeHtml(identity) +
            '">' +
            escapeHtml(identity) +
            '</span>'
          : '') +
        '</span>' +
        '<span class="mt-1.5 flex items-center gap-1.5">' +
        warehouseChipHtml(product, view) +
        (product.isActive === false
          ? chipHtml('fa-pause', 'спряно', 'bg-white/5 text-slate-500')
          : '') +
        '</span></span></div></td>' +
        /* Our own price, and the alert threshold under it. */
        '<td class="px-3 py-2.5 text-right">' +
        (product.marketPrice
          ? '<span class="num block text-slate-200">' + euro.format(product.marketPrice) + '</span>'
          : emptyMark()) +
        (product.targetPrice != null
          ? '<span class="num mt-0.5 block whitespace-nowrap text-[11px] ' +
            (view.belowTarget ? 'text-emerald-400' : 'text-slate-500') +
            '">' +
            translate('праг') +
            ' ' +
            euro.format(product.targetPrice) +
            '</span>'
          : '') +
        '</td>' +
        '<td class="px-3 py-2.5 text-right">' +
        (view.best
          ? '<span class="num block font-semibold text-accent-300"><span class="masked">' +
            euro.format(view.best.price) +
            '</span></span>' +
            trendHtml(view)
          : emptyMark()) +
        '</td>' +
        '<td class="px-3 py-2.5">' +
        rangeCellHtml(product, view) +
        '</td>' +
        '<td class="px-3 py-2.5">' +
        (view.margin === null
          ? emptyMark()
          : '<span class="num block text-right font-semibold ' +
            marginTone +
            '"><span class="masked">' +
            view.margin.toFixed(1) +
            '%</span></span>') +
        '</td>' +
        '<td class="px-3 py-2.5">' +
        (!view.best
          ? emptyMark()
          : view.best.url
          ? '<a href="' +
            escapeHtml(view.best.url) +
            '" target="_blank" rel="noopener noreferrer" data-external class="flex items-center gap-1.5 text-[11.5px] text-slate-400 transition hover:text-accent-500 hover:underline"><span class="truncate">' +
            escapeHtml(view.best.host) +
            '</span><i class="fa-solid fa-arrow-up-right-from-square shrink-0 text-[9px]"></i></a>'
          : '<span class="block truncate text-[11.5px] text-slate-400">' +
            escapeHtml(view.best.host) +
            '</span>') +
        (view.best && view.best.location
          ? '<span class="mt-0.5 block truncate text-[11px] text-slate-500" title="' +
            escapeHtml(view.best.location) +
            '"><i class="fa-solid fa-location-dot mr-1 text-[9px]"></i>' +
            escapeHtml(view.best.location) +
            '</span>'
          : '') +
        '</td>' +
        /* Status and freshness together: two columns that each carried one
           short line, side by side, are one column with two lines. */
        '<td class="px-3 py-2.5"><span class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ' +
        badge.className +
        '"><i class="fa-solid ' +
        badge.icon +
        ' text-[10px]"></i>' +
        translate(badge.label) +
        '</span>' +
        '<span class="mt-1 block truncate text-[11px] text-slate-500">' +
        escapeHtml(formatRelative(view.updatedAt)) +
        '</span>' +
        (view.tally.failing > 0
          ? '<span class="block text-[11px] text-red-400">' +
            view.tally.failing +
            ' с грешка</span>'
          : '') +
        '</td>' +
        '<td class="px-2 py-2.5"><span class="flex items-center justify-end">' +
        iconButton('refresh-product', product.id, 'fa-rotate', 'Провери всички складове') +
        iconButton('edit-product', product.id, 'fa-pen', 'Редактирай продукта') +
        iconButton('delete-product', product.id, 'fa-trash', 'Изтрий продукта', 'hover:text-red-400') +
        '</span></td></tr>' +
        (open
          ? '<tr class="border-b border-white/[0.06] bg-ink-950/40"><td colspan="8">' +
            supplierRowsHtml(product, view) +
            '</td></tr>'
          : '')
      );
    })
    .join('');

  $('#table-empty').classList.toggle('hidden', list.length > 0);

  if (list.length === 0) {
    // "Nothing tracked yet" and "nothing matches this filter" are
    // different problems with different next steps, and a single message
    // sends half the readers looking for a filter they never set.
    const nothingTracked = products.length === 0;

    $('#table-empty-text').textContent = nothingTracked
      ? 'Още не следите нищо. Добавете артикул и ще проверяваме цената му всеки час.'
      : 'Няма артикули, отговарящи на търсенето.';
    $('#table-empty-action').classList.toggle('hidden', !nothingTracked);
  }
  $('#table-count').textContent = formatMessage('{shown} от {total} артикула', {
    shown: list.length,
    total: products.length,
  });

  body.querySelectorAll('[data-row]').forEach(function (row) {
    row.addEventListener('click', function (event) {
      if (event.target.closest('[data-add-supplier]')) return;
      if (event.target.closest('[data-action]')) return;
      // The row is an ancestor of the hover triggers, so this handler runs
      // before the document-level one can stop the event: tapping the
      // warehouse chip has to be checked for here, not there.
      if (event.target.closest('[data-hover]')) return;
      // A link is a link: opening the shop must not also collapse the row.
      if (event.target.closest('a')) return;
      const id = row.dataset.row;
      if (expandedRows.has(id)) expandedRows.delete(id);
      else expandedRows.add(id);
      renderTable();
    });
  });

  body.querySelectorAll('[data-action]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      handleAction(button.dataset.action, button.dataset.id);
    });
  });

  body.querySelectorAll('[data-add-supplier]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      openSupplierModal(button.dataset.addSupplier);
    });
  });

  renderStats();
}

function renderStats() {
  const analyses = products.map(analyse);
  const margins = analyses.map((v) => v.margin).filter((value) => value !== null);
  const totalSavings = analyses.reduce((sum, v) => sum + v.spread, 0);

  const average = margins.length
    ? margins.reduce((sum, value) => sum + value, 0) / margins.length
    : 0;

  const newest = analyses.reduce(function (latest, view) {
    const time = view.updatedAt ? new Date(view.updatedAt).getTime() : 0;
    return Math.max(latest, time);
  }, 0);

  const hosts = new Set();
  const brands = new Set();
  const categories = new Set();
  products.forEach(function (product) {
    product.suppliers.forEach((s) => hosts.add(s.host));
    if (product.brand) brands.add(product.brand);
    if (product.category) categories.add(product.category);
  });

  const note = [pluralMessage(hosts.size, { one: 'в {n} склад', other: 'в {n} склада' })];
  if (brands.size) {
    note.push(pluralMessage(brands.size, { one: '{n} марка', other: '{n} марки' }));
  }
  if (categories.size) {
    note.push(pluralMessage(categories.size, { one: '{n} категория', other: '{n} категории' }));
  }

  $('#stat-total').textContent = products.length;
  $('#stat-total-note').textContent = note.join(' · ');
  $('#stat-margin').textContent = margins.length ? average.toFixed(1) + '%' : '—';
  $('#stat-risen').textContent = euro.format(totalSavings);
  $('#stat-checked').textContent = newest
    ? formatRelative(new Date(newest).toISOString())
    : '—';
}

function rebuildSupplierFilter() {
  const hosts = new Set();
  products.forEach((product) => product.suppliers.forEach((s) => hosts.add(s.host)));

  const select = $('#filter-supplier');
  const previous = select.value;

  select.innerHTML =
    '<option value="">' +
    translate('Всички складове') +
    ' (' +
    hosts.size +
    ')</option>' +
    Array.from(hosts)
      .sort()
      .map((host) => '<option value="' + escapeHtml(host) + '">' + escapeHtml(host) + '</option>')
      .join('');

  select.value = hosts.has(previous) ? previous : '';
  activeFilters.supplier = select.value;

  rebuildFacetFilter('#filter-brand', 'brand', 'Всички марки');
  rebuildFacetFilter('#filter-category', 'category', 'Всички категории');

  // Categories already in use are offered while typing, so the catalogue
  // does not end up with "Телевизори", "телевизори" and "ТВ".
  const categories = Array.from(
    new Set(products.map((product) => product.category).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b, 'bg'));

  $('#category-suggestions').innerHTML = categories
    .map((value) => '<option value="' + escapeHtml(value) + '"></option>')
    .join('');
}

/**
 * Fills a filter from the catalogue itself, counting products per value.
 * A selection that no longer exists after a reload falls back to "all"
 * rather than silently hiding every row.
 */
function rebuildFacetFilter(selector, field, allLabel) {
  const counts = new Map();
  products.forEach(function (product) {
    const value = product[field];
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });

  const select = $(selector);
  const previous = select.value;

  select.innerHTML =
    '<option value="">' +
    translate(allLabel) +
    ' (' +
    counts.size +
    ')</option>' +
    Array.from(counts.keys())
      .sort((a, b) => translate(a).localeCompare(translate(b), document.documentElement.lang || 'bg'))
      .map(
        (value) =>
          // The option's *value* stays the raw one, because that is what the
          // filter compares against the product rows; only the label a person
          // reads is translated. Swapping both would filter a Romanian label
          // against a Bulgarian field and match nothing.
          '<option value="' +
          escapeHtml(value) +
          '">' +
          escapeHtml(translate(value)) +
          ' (' +
          counts.get(value) +
          ')</option>',
      )
      .join('');

  select.value = counts.has(previous) ? previous : '';
  activeFilters[field] = select.value;
}

/**
 * Maps the API's product shape onto the comparison shape. Falls back to
 * the demo catalog on any failure, and always says which it is showing —
 * a dashboard that presents fictional numbers as real is worse than one
 * that admits it has no data.
 */
async function loadProducts() {
  const icon = $('#refresh-icon');
  icon.classList.add('fa-spin');

  try {
    const response = await fetch(ENDPOINTS.products + '?limit=100&includeCompetitors=true', {
      headers: authHeaders(),
    });

    if (!response.ok) throw new Error('HTTP ' + response.status);

    const page = await response.json();
    const items = Array.isArray(page.data) ? page.data : [];

    if (items.length === 0) {
      // A signed-in account with nothing tracked gets an empty table and
      // says so. It used to get the demo catalogue, which is a screen
      // full of realistic products that are not yours — a customer's
      // first impression of their own account was somebody else's data.
      products = [];
      trackedCount = 0;
      $('#data-source-label').textContent = 'вашият акаунт — още няма следени артикули';
    } else {
      products = items.map(function (product) {
        const listings = product.competitors || [];

        return {
          id: product.id,
          name: product.name,
          sku: product.sku,
          brand: product.brand,
          manufacturer: product.manufacturer,
          model: product.model,
          category: product.category,
          gtin: product.gtin,
          imageUrl: product.imageUrl,
          attributes: product.attributes,
          notes: product.notes,
          // What the buyer pays today — set against the best price found,
          // this is what says an article is costing money on every reorder.
          marketPrice: product.ourPrice == null ? null : Number(product.ourPrice),
          targetPrice: product.targetPrice == null ? null : Number(product.targetPrice),
          checkIntervalMinutes: product.checkIntervalMinutes,
          isActive: product.isActive,
          suppliers: listings.map(function (competitor) {
            return {
              id: competitor.id,
              isPrimary: competitor.isPrimary,
              isActive: competitor.isActive,
              url: competitor.url,
              priceSelector: competitor.priceSelector,
              currency: competitor.currency,
              name: competitor.name,
              host: competitor.host,
              sellerName: competitor.sellerName,
              location: competitor.location,
              imageUrl: competitor.imageUrl,
              attributes: competitor.attributes,
              lastStrategy: competitor.lastStrategy,
              lastError: competitor.lastError,
              failureCount: competitor.failureCount,
              price: competitor.currentPrice == null ? null : Number(competitor.currentPrice),
              previousPrice:
                competitor.previousPrice == null ? null : Number(competitor.previousPrice),
              inStock: competitor.inStock,
              status:
                competitor.scrapeStatus === 'success'
                  ? 'active'
                  : competitor.scrapeStatus === 'failed'
                    ? 'error'
                    : 'warning',
              updatedAt: competitor.lastCheckedAt || competitor.updatedAt,
            };
          }),
        };
      });

      trackedCount = page.meta && typeof page.meta.total === 'number' ? page.meta.total : items.length;
      $('#data-source-label').textContent = 'на живо от API-то';
    }
  } catch (error) {
    // Demo rows are for the visitor who has not signed in and is looking
    // around. For anyone authenticated they would be a lie about their
    // own catalogue, so a failure shows an empty table and the reason.
    const identified = Boolean(getSession() || getApiKey());
    products = identified ? [] : DEMO_PRODUCTS.slice();
    trackedCount = 0;
    $('#data-source-label').textContent = identified
      ? 'API-то не отговори — опитайте пак'
      : 'демонстрационни данни — влезте, за да видите вашите';
  } finally {
    icon.classList.remove('fa-spin');
    rebuildSupplierFilter();
    renderTable();
  }
}

/* --- Filters ------------------------------------------------------- */

$('#table-search').addEventListener('input', renderTable);
/**
 * "Обнови" used to re-read the database and nothing else, so pressing it
 * after a price changed in a shop showed the same numbers as before —
 * the button looked broken while doing exactly what it was told.
 *
 * It now runs a sweep first and then reloads. The sweep only visits
 * listings that are *due* under their own check interval, so the toast
 * reports what was actually re-checked instead of implying everything
 * was: "0 проверени" is a real and correct answer minutes after the
 * previous run.
 */
$('#refresh-data').addEventListener('click', async function () {
  const icon = $('#refresh-icon');
  icon.classList.add('fa-spin');

  try {
    const response = await fetch(ENDPOINTS.scraperRun, {
      method: 'POST',
      headers: authHeaders(),
    });

    if (response.ok) {
      const run = await response.json();

      if (!run.processed) {
        toast('Няма складове за проверка сега — всички са проверени наскоро.', 'info');
      } else {
        toast(
          'Проверени ' +
            run.processed +
            ' склада · ' +
            run.changed +
            ' с нова цена · ' +
            run.failed +
            ' неуспешни.',
          run.failed > 0 ? 'info' : 'success',
        );
      }
    }
  } catch (error) {
    // No key, or the API is down. The reload below says so on its own.
  } finally {
    icon.classList.remove('fa-spin');
    await loadProducts();
  }
});

$('#filter-supplier').addEventListener('change', function () {
  activeFilters.supplier = this.value;
  renderTable();
});

$('#filter-brand').addEventListener('change', function () {
  activeFilters.brand = this.value;
  renderTable();
});

$('#filter-category').addEventListener('change', function () {
  activeFilters.category = this.value;
  renderTable();
});

$$('.filter-chip').forEach(function (chip) {
  chip.addEventListener('click', function () {
    const name = chip.dataset.filter;
    activeFilters[name] = !activeFilters[name];

    chip.classList.toggle('border-accent-500/50', activeFilters[name]);
    chip.classList.toggle('bg-accent-500/10', activeFilters[name]);
    chip.classList.toggle('text-slate-200', activeFilters[name]);
    chip.classList.toggle('border-white/10', !activeFilters[name]);
    chip.classList.toggle('text-slate-400', !activeFilters[name]);

    renderTable();
  });
});

$('#expand-all').addEventListener('click', function () {
  const list = visibleProducts();
  const allOpen = list.every((product) => expandedRows.has(product.id));

  if (allOpen) expandedRows.clear();
  else list.forEach((product) => expandedRows.add(product.id));

  $('#expand-label').textContent = allOpen ? 'Разгъни всички' : 'Свий всички';
  renderTable();
});

/**
 * The reveal state survives a reload.
 *
 * It defaults to hidden — wholesale prices should not appear on a screen
 * nobody asked to expose — but re-blurring them on every refresh made the
 * button something you press a dozen times a day. The choice is per
 * browser, which is the same scope as the blur it controls.
 */
const REVEAL_STORAGE = 'stoclify.reveal';

function applyReveal(next, persist) {
  revealed = next;
  document.body.classList.toggle('revealed', revealed);
  $('#reveal-icon').className = revealed
    ? 'fa-solid fa-eye-slash text-[11.5px]'
    : 'fa-solid fa-eye text-[11.5px]';
  // Written in JavaScript rather than in the markup, so the pass i18n.js makes
  // over the document never sees it — hence the explicit lookup. This was the
  // one showing "Скрий цени на едро" next to "Monitoring dashboard".
  $('#reveal-label').textContent = translate(
    revealed ? 'Скрий цени на едро' : 'Покажи цени на едро',
  );

  if (!persist) return;
  try {
    if (revealed) window.localStorage.setItem(REVEAL_STORAGE, '1');
    else window.localStorage.removeItem(REVEAL_STORAGE);
  } catch (error) {
    /* private mode — the toggle still works for this session */
  }
}

$('#toggle-reveal').addEventListener('click', function () {
  applyReveal(!revealed, true);
});

(function restoreReveal() {
  try {
    applyReveal(window.localStorage.getItem(REVEAL_STORAGE) === '1', false);
  } catch (error) {
    applyReveal(false, false);
  }
})();

/* ------------------------------------------------------------------ *
 * SECTION — suppliers and live comparison
 *
 * One question, asked live: "who sells this cheapest for me". Every
 * configured shop's own search is queried at the moment you ask, and the
 * answers are ranked by what you actually pay — listed price less your
 * negotiated discount, in one currency.
 *
 * Nothing is crawled and nothing is stored. One request per shop per
 * question, never one per article, which is why a supplier with eight
 * thousand items costs the same to serve as one with eighty.
 * ------------------------------------------------------------------ */

let shops = [];
/** Everything /discovery/shops knows about YOUR shops: searchable, reason. */
let liveProviders = [];
/** Shops we ship a verified configuration for, that are not yours yet. */
let availableShops = [];

/** Same shop under two spellings: bg.elmarkstore.eu is elmarkstore.eu. */
function sameShopHost(a, b) {
  const clean = (host) => String(host || '').toLowerCase().replace(/^www\./, '');
  const left = clean(a);
  const right = clean(b);
  return left === right || left.endsWith('.' + right) || right.endsWith('.' + left);
}

/** The live-search verdict for one shop row. */
function liveStatusFor(shop) {
  if (shop.searchUrlTemplate) return { searchable: true, reason: null };
  const known = liveProviders.find((provider) => sameShopHost(provider.host, shop.host));
  if (known && known.searchable) return { searchable: true, reason: null };
  return {
    searchable: false,
    reason:
      (known && known.reason) ||
      shop.searchBlockedReason ||
      'живото търсене не е настроено',
  };
}

/**
 * True when no amount of configuration will make this shop searchable.
 *
 * A shop whose robots.txt forbids its search path has decided the matter
 * — tmt-elkom.com publishes `Disallow: /search?`. Offering "Настрой
 * търсене" there walks the user into a dialog that cannot succeed, and
 * the refusal then reads as our bug rather than their rule. Their
 * *product* pages stay open, so the honest advice is to track by link.
 */
function isHardBlocked(status) {
  return !status.searchable && /robots\.txt|не приема заявка|JavaScript/i.test(status.reason || '');
}

async function loadShops() {
  const list = $('#shops-list');

  // A visitor has no suppliers and no key, so every one of these three
  // requests is a guaranteed 401. Show what the panel is *for* instead of
  // reporting the failure of a request that was never going to work.
  if (!isIdentified()) {
    shops = DEMO_SHOPS.map(function (shop) {
      return {
        id: 'demo-' + shop.host,
        name: shop.name,
        host: shop.host,
        discountPercent: shop.discount,
        isActive: true,
        // `searchUrlTemplate` is what `liveStatusFor` actually reads. Without
        // it every demo supplier renders as "живото търсене не е настроено",
        // which is the opposite of the point being made.
        searchUrlTemplate: 'https://' + shop.host + '/search?q={q}',
        searchMethod: 'live',
        searchSummary: 'търсачка на магазина',
        lastError: null,
      };
    });
    $('#shops-empty').classList.add('hidden');
    $('#shops-head').classList.remove('hidden');
    $('#shops-head').classList.add('grid');
    list.innerHTML = shops.map(shopRowHtml).join('');
    return;
  }

  try {
    // Both lists at once: a shop row cannot say whether it is searchable
    // without the providers list, and fetching it separately made the
    // two screens disagree about the same shop.
    const [shopsResponse, providersResponse, availableResponse] = await Promise.all([
      fetch(ENDPOINTS.shops, { headers: authHeaders() }),
      fetch(ENDPOINTS.discoveryShops, { headers: authHeaders() }).catch(() => null),
      fetch(ENDPOINTS.discoveryAvailable, { headers: authHeaders() }).catch(() => null),
    ]);

    if (!shopsResponse.ok) throw new Error('HTTP ' + shopsResponse.status);
    shops = await shopsResponse.json();
    liveProviders =
      providersResponse && providersResponse.ok ? await providersResponse.json() : [];
    availableShops =
      availableResponse && availableResponse.ok ? await availableResponse.json() : [];
  } catch (error) {
    shops = [];
    list.innerHTML =
      '<p class="px-4 py-6 text-[12.5px] text-slate-500">' +
      translate('Няма връзка с API-то. Опитайте пак след малко.') +
      '</p>';
    $('#shops-empty').classList.add('hidden');
    return;
  }

  $('#shops-empty').classList.toggle('hidden', shops.length > 0);
  // The heading only earns its place once there is something under it.
  $('#shops-head').classList.toggle('hidden', shops.length === 0);
  $('#shops-head').classList.toggle('grid', shops.length > 0);
  list.innerHTML = shops.map(shopRowHtml).join('');
  renderProvidersStrip();
  bindShopRows();
  renderShopsSummary(shops);
}

/**
 * What the closed row says.
 *
 * The two facts worth knowing without opening anything: how many suppliers a
 * search asks, and whether any of them cannot be asked. A supplier whose
 * search broke is the reason results look thin, and finding that out by
 * opening a drawer is finding it out too late.
 */
function renderShopsSummary(shops) {
  const summary = $('#shops-summary');
  const warning = $('#shops-warning');
  if (!summary) return;

  const searched = shops.filter((shop) => shop.isActive !== false);

  summary.textContent = searched.length
    ? pluralMessage(searched.length, {
        one: '{n} доставчик в търсенето',
        other: '{n} доставчика в търсенето',
      })
    : translate('Още няма твои доставчици');

  if (!warning) return;

  const broken = shops.filter((shop) => shop.lastError).length;
  warning.hidden = broken === 0;
  if (broken > 0) {
    warning.textContent = pluralMessage(broken, {
      one: '{n} не отговаря',
      other: '{n} не отговарят',
    });
  }
}

/**
 * The retailers searched besides your own suppliers.
 *
 * Named rather than left implicit: a result from eMAG in a list you
 * thought covered only your three suppliers looks like a bug.
 */
function renderProvidersStrip() {
  const strip = $('#providers-strip');

  if (!availableShops.length) {
    strip.classList.add('hidden');
    return;
  }

  // Offered, not included. These are shops we already know how to search
  // correctly — adding one takes a click and no configuration — but none
  // of them takes part in a search until it is on your list. The strip
  // used to read "Търсим на живо и в: eMAG", which was true and wrong:
  // nobody wants a retailer they hold no account with setting the
  // benchmark their suppliers are judged against.
  strip.classList.remove('hidden');
  strip.innerHTML =
    '<i class="fa-solid fa-circle-plus mr-1.5 text-[10px] text-slate-500"></i>' +
    '<span class="mr-1.5">Готови за добавяне (не се търсят, докато не ги добавите):</span>' +
    availableShops
      .map(function (provider) {
        return (
          '<button type="button" data-add-known="' +
          escapeHtml(provider.host) +
          '" class="mr-1.5 mt-1 inline-block rounded-md border border-white/10 bg-ink-850 px-2 py-0.5 text-[11px] text-slate-300 transition hover:border-accent-500/40 hover:text-accent-300">' +
          escapeHtml(provider.name) +
          '</button>'
        );
      })
      .join('') ;

  $$('[data-add-known]').forEach(function (button) {
    button.addEventListener('click', async function () {
      button.disabled = true;
      try {
        const response = await fetch(ENDPOINTS.shops, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ host: button.dataset.addKnown }),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        toast('Добавен — търси се на живо.', 'success');
        await loadShops();
      } catch (error) {
        button.disabled = false;
        toast(failureText(error, 'Неуспешно'), 'error');
      }
    });
  });
}

/**
 * One supplier row.
 *
 * A grid with declared column widths, not a wrapping flex line. Flex
 * sized the right-hand controls from their own content, so a row whose
 * button read "Настрой търсене" pushed its discount field left of a row
 * reading "Пренастрой" — five rows, five different alignments. Columns
 * that mean the same thing have to line up, or the eye cannot scan down
 * one.
 */
function shopRowHtml(shop) {
  const live = liveStatusFor(shop);
  const off = shop.isActive === false;

  // What route this shop's products are found by, as the probe decided.
  // Three states, not two: a shop searched through its sitemap is not
  // "без търсене" — it works, it is merely slower, and calling it broken
  // sends the user hunting for a fault that is not there.
  const METHOD_CHIP = {
    live: {
      cls: 'bg-emerald-500/12 text-emerald-400',
      icon: 'fa-bolt',
      label: 'търсачка на магазина',
    },
    sitemap: {
      cls: 'bg-sky-500/12 text-sky-400',
      icon: 'fa-sitemap',
      label: 'по картата на сайта',
    },
    manual: {
      cls: 'bg-violet-500/12 text-violet-300',
      icon: 'fa-pen-to-square',
      label: 'ваши цени',
    },
    none: {
      cls: 'bg-white/[0.06] text-slate-400',
      icon: 'fa-link',
      label: 'само по линк',
    },
  };

  const method = METHOD_CHIP[shop.searchMethod] || METHOD_CHIP.none;

  const liveChip = off
    ? '<span class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-slate-500">' +
      '<i class="fa-solid fa-pause text-[9px]"></i>спрян</span>'
    : '<span class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ' +
      method.cls +
      '" title="' +
      escapeHtml(shop.searchSummary || '') +
      '"><i class="fa-solid ' +
      method.icon +
      ' text-[9px]"></i>' +
      method.label +
      '</span>';

  // Only the reason that still applies. A shop that is switched off is
  // not searched for that reason, and repeating why it also lacks a
  // configuration is noise the user cannot act on until it is back on.
  const note = off
    ? ''
    : shop.searchSummary
      ? '<span class="mt-1 block truncate text-[11px] text-slate-500" title="' +
        escapeHtml(shop.searchSummary) +
        '">' +
        escapeHtml(shop.searchSummary) +
        '</span>'
      : !live.searchable
        ? '<span class="mt-1 block truncate text-[11px] text-slate-500" title="' +
          escapeHtml(live.reason) +
          '">' +
          escapeHtml(live.reason) +
          '</span>'
        : '';

  const error =
    !off && shop.lastError
      ? '<span class="mt-1 flex items-start gap-1.5 text-[11px] text-amber-400/90" title="' +
        escapeHtml(shop.lastError) +
        '"><i class="fa-solid fa-triangle-exclamation mt-0.5 shrink-0 text-[9px]"></i>' +
        '<span class="min-w-0 truncate">последно търсене: ' +
        escapeHtml(shop.lastError) +
        '</span></span>'
      : '';

  // One action, and it is the same one whatever state the row is in:
  // work out again how this shop can be searched. A storefront that has
  // moved platform may have gained a usable search, or lost one.
  const action = off
    ? '<span class="text-[11.5px] text-slate-600">—</span>'
    : '<button type="button" data-reprobe="' +
      escapeHtml(shop.id) +
      '" class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 py-2 text-[11.5px] font-medium text-slate-300 transition hover:border-accent-500/40 hover:text-accent-300" ' +
      'title="Проверява наново дали търсачката на магазина работи, и ако не — дали има карта на сайта.">' +
      '<i class="fa-solid fa-arrows-rotate text-[11px]"></i>Провери наново</button>';

  return (
    '<div class="grid grid-cols-[minmax(0,1fr)_7.5rem_11.5rem_5.5rem] items-center gap-3 px-4 py-2.5' +
    (off ? ' opacity-55' : '') +
    '" data-shop="' +
    escapeHtml(shop.id) +
    '">' +
    /* 1 — identity and status */
    '<span class="min-w-0">' +
    '<span class="flex min-w-0 items-center gap-2">' +
    '<span class="truncate font-medium text-slate-200">' +
    escapeHtml(shop.name) +
    '</span>' +
    liveChip +
    '</span>' +
    '<span class="mt-0.5 block truncate font-mono text-[11px] text-slate-500">' +
    escapeHtml(shop.host) +
    '</span>' +
    note +
    error +
    '</span>' +
    /* 2 — the discount, which decides which shop the search calls cheapest */
    '<label class="flex items-center justify-end gap-1.5 text-[11.5px] text-slate-500">' +
    '<input type="number" min="0" max="100" step="0.5" value="' +
    Number(shop.discountPercent) +
    '" data-discount="' +
    escapeHtml(shop.id) +
    '" aria-label="Отстъпка при ' +
    escapeHtml(shop.name) +
    '" class="num w-16 rounded-lg border border-white/10 bg-ink-850 px-2 py-1.5 text-right text-[12.5px] text-slate-200 outline-none focus:border-accent-500/60" />%</label>' +
    /* 3 — the one action this row offers */
    '<span class="min-w-0">' +
    action +
    '</span>' +
    /* 4 — include in search, and remove */
    '<span class="flex items-center justify-end gap-1">' +
    '<button type="button" role="switch" aria-checked="' +
    (off ? 'false' : 'true') +
    '" data-toggle-shop="' +
    escapeHtml(shop.id) +
    '" title="' +
    (off ? 'Включи в търсенето' : 'Изключи от търсенето') +
    '" class="relative h-5 w-9 shrink-0 rounded-full transition ' +
    (off ? 'bg-white/10' : 'bg-accent-500/70') +
    '">' +
    '<span class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ' +
    (off ? 'left-0.5' : 'left-4') +
    '"></span></button>' +
    iconButton('delete-shop', shop.id, 'fa-trash', 'Премахни доставчика', 'hover:text-red-400') +
    '</span></div>'
  );
}

function bindShopRows() {
  $$('[data-detect]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (requireAccount()) return;
      openDetectModal(button.dataset.detect);
    });
  });

  $$('[data-reprobe]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (requireAccount()) return;
      reprobeShop(button.dataset.reprobe, button);
    });
  });

  // Switching a shop off keeps its discount and its selectors. It is the
  // supplier you are between contracts with, not one you are finished
  // with — deleting would make you configure it again in March.
  $$('[data-toggle-shop]').forEach(function (button) {
    button.addEventListener('click', async function () {
      const shop = shops.find((item) => item.id === button.dataset.toggleShop);
      if (!shop) return;

      const next = shop.isActive === false;
      button.disabled = true;

      try {
        const response = await fetch(ENDPOINTS.shops + '/' + shop.id, {
          method: 'PATCH',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ isActive: next }),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);

        toast(
          next
            ? shop.name + ' влиза в търсенето.'
            : shop.name + ' е изключен — няма да се търси там.',
          'success',
        );
        await loadShops();
      } catch (error) {
        button.disabled = false;
        toast(failureText(error, 'Не се смени'), 'error');
      }
    });
  });

  $$('[data-discount]').forEach(function (input) {
    input.addEventListener('change', async function () {
      const value = Math.min(Math.max(Number(input.value) || 0, 0), 100);
      input.value = value;

      try {
        const response = await fetch(ENDPOINTS.shops + '/' + input.dataset.discount, {
          method: 'PATCH',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ discountPercent: value }),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        toast('Отстъпката е записана. Търсенето вече смята с нея.', 'success');
        await loadShops();
      } catch (error) {
        toast(failureText(error, 'Отстъпката не се запази'), 'error');
      }
    });
  });

  $$('[data-action="delete-shop"]').forEach(function (button) {
    button.addEventListener('click', async function () {
      if (requireAccount()) return;

      const shop = shops.find((item) => item.id === button.dataset.id);
      if (!shop) return;

      const confirmed = await confirmDialog(
        'Премахване на доставчик',
        'Ще премахна „' +
          escapeHtml(shop.name) +
          '" от търсенето. Следените продукти оттам остават — те се пазят отделно.',
        'Премахни',
      );
      if (!confirmed) return;

      try {
        const response = await fetch(ENDPOINTS.shops + '/' + shop.id, {
          method: 'DELETE',
          headers: authHeaders(),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        toast('Доставчикът е премахнат.', 'success');
        await loadShops();
      } catch (error) {
        toast(failureText(error, 'Неуспешно'), 'error');
      }
    });
  });
}

/**
 * Works out again how a shop can be searched.
 *
 * Takes real seconds — it reads the shop's sitemap and may try several
 * search paths — so the button says so rather than appearing to hang.
 */
async function reprobeShop(shopId, button) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML =
    '<i class="fa-solid fa-circle-notch fa-spin text-[11px]"></i>Проверявам…';

  try {
    const response = await fetch(ENDPOINTS.shops + '/' + shopId + '/probe', {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const shop = await response.json();
    toast(shop.searchSummary || 'Готово.', shop.searchMethod === 'none' ? 'info' : 'success');
    await loadShops();
  } catch (error) {
    button.disabled = false;
    button.innerHTML = original;
    toast(failureText(error, 'Проверката не успя'), 'error');
  }
}

/* --- Teaching the system to search a new shop ---------------------- */

let detectTargetId = null;
let detected = null;

function openDetectModal(shopId) {
  const shop = shops.find((item) => item.id === shopId);
  if (!shop) return;

  detectTargetId = shopId;
  detected = null;

  $('#detect-shop-name').textContent = shop.name;
  $('#detect-form').reset();
  $('#detect-result').classList.add('hidden');
  $('#detect-status').classList.add('hidden');
  $('#detect-save').disabled = true;
  openModal('detect-modal');
}

function showDetectStatus(message, tone) {
  const element = $('#detect-status');
  const palette = {
    success: 'text-emerald-400',
    error: 'text-red-400',
    info: 'text-slate-400',
  };
  element.className = 'text-[11.5px] leading-relaxed ' + (palette[tone] || palette.info);
  element.textContent = message;
  element.classList.remove('hidden');
}

/**
 * Shows the guess back before it is saved.
 *
 * A detector that silently configures a shop is a detector nobody can
 * tell has gone wrong: the shop simply returns nonsense for months. The
 * sample rows make the guess falsifiable in two seconds.
 */
function renderDetectResult(result) {
  const box = $('#detect-result');
  const percent = Math.round(result.confidence * 100);

  const tone =
    percent >= 70
      ? { border: 'border-emerald-500/30', bg: 'bg-emerald-500/[0.07]', text: 'text-emerald-400', icon: 'fa-circle-check' }
      : { border: 'border-amber-500/30', bg: 'bg-amber-500/[0.07]', text: 'text-amber-400', icon: 'fa-triangle-exclamation' };

  const rows = result.samples
    .map(function (sample) {
      return (
        '<li class="flex items-baseline justify-between gap-3 border-t border-white/8 py-1.5">' +
        '<span class="min-w-0 flex-1 truncate text-[11.5px] text-slate-300" title="' +
        escapeHtml(sample.title) +
        '">' +
        escapeHtml(sample.title || '(без име)') +
        '</span>' +
        (sample.price === null
          ? '<span class="shrink-0 text-[11px] text-amber-400">без цена</span>'
          : '<span class="num shrink-0 text-[11.5px] font-semibold text-slate-200">' +
            Number(sample.price).toFixed(2) +
            '</span>') +
        '</li>'
      );
    })
    .join('');

  box.className = 'rounded-xl border ' + tone.border + ' ' + tone.bg + ' px-3.5 py-2.5';
  box.innerHTML =
    '<p class="text-[12.5px] font-semibold ' +
    tone.text +
    '"><i class="fa-solid ' +
    tone.icon +
    ' mr-1.5"></i>Разпознах ' +
    result.samples.length +
    ' ' +
    plural(result.samples.length, 'резултат', 'резултата') +
    ' (' +
    percent +
    '% пълни)</p>' +
    (percent >= 70
      ? '<p class="mt-1 text-[11.5px] text-slate-400">Проверете имената и цените — ако отговарят на видяното в сайта, запазете.</p>'
      : '<p class="mt-1 text-[11.5px] text-slate-400">Част от редовете са непълни. Запазването пак работи, но проверете внимателно.</p>') +
    '<ul class="mt-2">' +
    rows +
    '</ul>' +
    '<p class="mt-2.5 break-all font-mono text-[10px] text-slate-500">' +
    escapeHtml(result.urlTemplate) +
    '</p>';
  box.classList.remove('hidden');
}

$('#detect-form').addEventListener('submit', async function (event) {
  event.preventDefault();

  const searchUrl = $('#detect-url').value.trim();
  const sampleQuery = $('#detect-query').value.trim();

  if (!searchUrl || !sampleQuery) {
    showDetectStatus('Попълнете и адреса, и думата, която сте търсили.', 'error');
    return;
  }

  const button = $('#detect-run');
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML =
    '<i class="fa-solid fa-circle-notch fa-spin text-[12.5px]"></i>Разпознавам…';
  $('#detect-status').classList.add('hidden');

  try {
    const response = await fetch(ENDPOINTS.discoveryDetect, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ searchUrl: searchUrl, sampleQuery: sampleQuery }),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      // The server speaks in sentences meant for this box.
      throw new Error(body.message || 'HTTP ' + response.status);
    }

    detected = body;
    renderDetectResult(body);
    $('#detect-save').disabled = false;
  } catch (error) {
    detected = null;
    $('#detect-result').classList.add('hidden');
    $('#detect-save').disabled = true;
    showDetectStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
});

$('#detect-save').addEventListener('click', async function () {
  if (!detected || !detectTargetId) return;

  const button = $('#detect-save');
  button.disabled = true;

  try {
    const response = await fetch(ENDPOINTS.shops + '/' + detectTargetId, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        searchUrlTemplate: detected.urlTemplate,
        searchResultSelector: detected.linkSelector || undefined,
        searchTileSelector: detected.tileSelector || undefined,
        searchTitleSelector: detected.titleSelector || undefined,
        searchPriceSelector: detected.priceSelector || undefined,
        searchConfidence: detected.confidence,
      }),
    });

    if (!response.ok) {
      throw new Error((await response.text()).slice(0, 200) || 'HTTP ' + response.status);
    }

    closeModal('detect-modal');
    toast('Готово — магазинът вече се търси на живо.', 'success');
    await loadShops();
  } catch (error) {
    button.disabled = false;
    showDetectStatus(failureText(error, 'Не се запази'), 'error');
  }
});

/* --- Add supplier --------------------------------------------------- */

$('#add-shop').addEventListener('click', function () {
  if (requireAccount()) return;
  $('#shop-form').reset();
  $('#shop-no-website').checked = false;
  $('#shop-status').classList.add('hidden');
  openModal('shop-modal');
});

$('#shop-form').addEventListener('submit', async function (event) {
  event.preventDefault();

  const host = $('#shop-host')
    .value.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');

  if (!host || host.indexOf('.') === -1) {
    const status = $('#shop-status');
    status.className = 'text-[11.5px] text-red-500';
    status.textContent = 'Въведете домейн, например tmt-elkom.com';
    status.classList.remove('hidden');
    return;
  }

  closeModal('shop-modal');

  // Two steps, deliberately, because they take very different times.
  //
  // Registering the shop is instant; working out how to search it means
  // reading a robots.txt and possibly a megabyte of sitemap, which took
  // twenty seconds on a real supplier. Done as one call the screen sat
  // there showing a single toast and nothing else, and the shop only
  // appeared after a manual refresh — the user could not tell whether
  // anything had happened.
  try {
    const response = await fetch(ENDPOINTS.shops + '?probe=false', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        host: host,
        hasWebsite: !$('#shop-no-website').checked,
      }),
    });

    if (!response.ok) {
      throw new Error((await response.text()).slice(0, 200) || 'HTTP ' + response.status);
    }

    const shop = await response.json();

    // On screen immediately, so the answer to "did that work" is yes.
    await loadShops();

    if (shop.hasWebsite === false) {
      toast(shop.searchSummary || 'Добавен. Качете ценоразписа му.', 'success');
      return;
    }

    await probeNewShop(shop);
  } catch (error) {
    toast(failureText(error, 'Неуспешно'), 'error');
  }
});

/**
 * Works out how a freshly added shop can be searched, in view.
 *
 * The row is already on screen; this marks it as being checked and
 * replaces that with the verdict. Reading a supplier's sitemap is tens
 * of seconds, and silence for that long reads as a broken screen.
 */
async function probeNewShop(shop) {
  const row = document.querySelector('[data-shop="' + shop.id + '"]');
  const button = row ? row.querySelector('[data-reprobe]') : null;

  if (button) {
    button.disabled = true;
    button.innerHTML =
      '<i class="fa-solid fa-circle-notch fa-spin text-[11px]"></i>Проверявам…';
  }

  toast('Добавен. Проверявам как може да се търси в него…', 'info');

  try {
    const response = await fetch(ENDPOINTS.shops + '/' + shop.id + '/probe', {
      method: 'POST',
      headers: authHeaders(),
    });

    if (!response.ok) throw new Error('HTTP ' + response.status);

    const probed = await response.json();
    toast(probed.searchSummary || 'Готово.', probed.searchMethod === 'none' ? 'info' : 'success');
  } catch (error) {
    // The shop is added either way; only the verdict is missing, and the
    // row's own button can be used to try again.
    toast(failureText(error, 'Добавен, но проверката не мина'), 'info');
  } finally {
    await loadShops();
  }
}

/* --- The comparison ------------------------------------------------- */

/**
 * Pulls the specification out of a wholesaler's product name.
 *
 * "ЛАМПА LED 7W,Е27,6400K,600Lm,WELLUX,LB-A55-7W" is not prose — it is a
 * spec sheet with commas. Read as one long string it is unusable; split
 * into power, socket, colour temperature and output it becomes the thing
 * you are actually choosing between.
 *
 * Folded through homoglyphs first: shops write the socket as Cyrillic
 * "Е27" about half the time.
 */
function parseSpecs(name) {
  const latin = String(name || '').replace(/[аеорсухкмтвн]/gi, function (letter) {
    const from = 'аеорсухкмтвнАЕОРСУХКМТВН';
    const to = 'aeopcyxkmtbhAEOPCYXKMTBH';
    const index = from.indexOf(letter);
    return index === -1 ? letter : to[index];
  });

  const watt = /(\d+(?:[.,]\d+)?)\s*W\b/i.exec(latin);
  const socket = /\b(E27|E14|GU10|GU5[.,]3|G9|G4|B22|MR16|T8|T5)\b/i.exec(latin);
  const kelvin = /(\d{4})\s*K\b/i.exec(latin);
  const lumens = /(\d+)\s*(?:lm|lumena|лумена)\b/i.exec(latin);

  return {
    watt: watt ? watt[1].replace(',', '.') + 'W' : null,
    socket: socket ? socket[1].toUpperCase() : null,
    kelvin: kelvin ? Number(kelvin[1]) : null,
    lumens: lumens ? Number(lumens[1]) : null,
  };
}

/** Warm to cold, as the light actually looks. */
function kelvinTone(kelvin) {
  if (kelvin === null) return null;
  if (kelvin <= 3000) return { label: 'топла', swatch: '#f6c177', text: 'text-amber-400' };
  if (kelvin <= 4500) return { label: 'неутрална', swatch: '#f3ead3', text: 'text-slate-300' };
  return { label: 'студена', swatch: '#bcd8ff', text: 'text-sky-400' };
}

function specChipsHtml(specs) {
  const chips = [];

  if (specs.watt) {
    chips.push(
      '<span class="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">' +
        '<i class="fa-solid fa-bolt text-[9px] opacity-60"></i>' +
        escapeHtml(specs.watt) +
        '</span>',
    );
  }

  if (specs.socket) {
    chips.push(
      '<span class="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-300">' +
        escapeHtml(specs.socket) +
        '</span>',
    );
  }

  const tone = kelvinTone(specs.kelvin);
  if (tone) {
    chips.push(
      '<span class="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] ' +
        tone.text +
        '"><span class="inline-block h-2 w-2 rounded-full" style="background:' +
        tone.swatch +
        '"></span>' +
        specs.kelvin +
        'K</span>',
    );
  }

  if (specs.lumens) {
    chips.push(
      '<span class="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">' +
        specs.lumens +
        ' lm</span>',
    );
  }

  return chips.join('');
}


/** The full record behind one row, for the hover card. */
let catalogueHits = [];

function offerCardHtml(hit) {
  const specs = parseSpecs(hit.name);
  const tone = kelvinTone(specs.kelvin);

  const rows =
    hoverRow('Доставчик', escapeHtml(hit.shopName)) +
    (specs.watt ? hoverRow('Мощност', escapeHtml(specs.watt)) : '') +
    (specs.socket
      ? hoverRow('Цокъл', '<span class="font-mono">' + escapeHtml(specs.socket) + '</span>')
      : '') +
    (tone
      ? hoverRow(
          'Светлина',
          '<span class="inline-flex items-center gap-1.5"><span class="inline-block h-2.5 w-2.5 rounded-full" style="background:' +
            tone.swatch +
            '"></span>' +
            specs.kelvin +
            'K · ' +
            tone.label +
            '</span>',
        )
      : '') +
    (specs.lumens ? hoverRow('Светлинен поток', specs.lumens + ' lm') : '') +
    (specs.watt && specs.lumens
      ? hoverRow(
          'Ефективност',
          Math.round(specs.lumens / Number.parseFloat(specs.watt)) + ' lm/W',
        )
      : '');

  const pricing =
    hoverRow(
      'Цена по етикет',
      '<span class="num">' +
        (hit.listedPrice === null ? '—' : hit.listedPrice.toFixed(2)) +
        ' ' +
        escapeHtml(hit.listedCurrency) +
        '</span>',
    ) +
    (hit.discountPercent > 0
      ? hoverRow('Вашата отстъпка', '−' + hit.discountPercent + '%', 'text-accent-300')
      : '') +
    hoverRow(
      'Вие плащате',
      '<span class="num font-semibold">' +
        (hit.effectivePrice === null
          ? '—'
          : hit.effectivePrice.toFixed(2) + ' ' + escapeHtml(hit.effectiveCurrency)) +
        '</span>',
      'text-emerald-400',
    ) +
    hoverRow(
      'Наличност',
      hit.inStock === false ? 'изчерпан' : hit.inStock === true ? 'наличен' : 'не е посочена',
      hit.inStock === false ? 'text-amber-400' : 'text-slate-200',
    ) +
    hoverRow('Прочетено', 'сега, от сайта на магазина', 'text-emerald-400');

  return (
    '<div class="px-3.5 pb-2 pt-3">' +
    '<p class="text-[11.5px] font-semibold leading-snug text-slate-200">' +
    escapeHtml(hit.name) +
    '</p></div>' +
    '<div class="border-t border-white/8 px-3.5 py-2">' +
    rows +
    '</div>' +
    '<div class="border-t border-white/8 px-3.5 py-2">' +
    pricing +
    '</div>' +
    '<p class="border-t border-white/8 px-3.5 py-2.5 font-mono text-[11px] text-slate-500">' +
    escapeHtml(hit.host) +
    '</p>'
  );
}

/**
 * Which shops answered, which found nothing, which refused.
 *
 * "Found at 4 of 6" and "not stocked anywhere" are different answers, and
 * a table of results cannot tell them apart. A shop that failed is named
 * with its reason — otherwise its absence reads as "they don't sell it".
 */
function renderShopOutcomes(result) {
  const box = $('#live-results');
  const carrying = result.shops.filter((shop) => shop.ok && shop.count > 0);
  const empty = result.shops.filter((shop) => shop.ok && shop.count === 0);
  const refused = result.shops.filter((shop) => !shop.ok);

  box.innerHTML =
    '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-2.5 shadow-panel">' +
    '<div class="flex flex-wrap items-baseline justify-between gap-2">' +
    '<p class="text-[12.5px] font-medium ' +
    (carrying.length ? 'text-slate-200' : 'text-slate-400') +
    '">' +
    (carrying.length
      ? formatMessage('Намерено в {found} от {total} магазина', {
          found: carrying.length,
          total: result.shops.length,
        })
      : 'Не се намери в нито един магазин') +
    '</p>' +
    '<p class="text-[11px] text-slate-500"><i class="fa-solid fa-bolt mr-1 text-[9px] text-accent-400"></i>' +
    formatMessage('попитани на живо за {seconds} сек', {
      seconds: (result.durationMs / 1000).toFixed(1),
    }) +
    '</p>' +
    '</div>' +
    (carrying.length
      ? '<div class="mt-2.5 flex flex-wrap gap-1.5">' +
        carrying
          .map(function (shop) {
            return (
              '<span class="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/12 px-2 py-1 text-[11px] font-medium text-emerald-400">' +
              '<i class="fa-solid fa-store text-[9px]"></i>' +
              escapeHtml(shop.name) +
              '<span class="text-emerald-400/70">' +
              shop.count +
              '</span></span>'
            );
          })
          .join('') +
        '</div>'
      : '') +
    (empty.length
      ? '<p class="mt-2 text-[11px] text-slate-500">Няма го в: ' +
        escapeHtml(empty.map((shop) => shop.name).join(', ')) +
        '</p>'
      : '') +
    (refused.length
      ? '<p class="mt-1.5 text-[11px] text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1 text-[9px]"></i>' +
        'Не отговориха: ' +
        escapeHtml(
          refused
            .map((shop) => shop.name + ' (' + (shop.error || 'неуспешно') + ')')
            .join(', '),
        ) +
        '</p>'
      : '') +
    '</div>';
}

/**
 * How sure we are this row is the article that was searched for.
 *
 * The number is the point, but so is the sentence behind it: a buyer who
 * cannot see *why* two names were called the same product has been asked
 * to trust a black box with their order. The reason line is the machine
 * showing its work — brand, wattage, socket, one line each.
 */
const MATCH_BANDS = {
  certain: { className: 'bg-emerald-500/12 text-emerald-400', label: 'съвпада' },
  high: { className: 'bg-sky-500/12 text-sky-300', label: 'съвпада' },
  possible: { className: 'bg-amber-500/12 text-amber-400', label: 'вероятно' },
  weak: { className: 'bg-white/[0.06] text-slate-400', label: 'слабо' },
};

/**
 * A shop this buyer holds no terms with.
 *
 * Never hidden and never dressed as a supplier. It may well be the only place
 * that stocks the thing — but its price is a shelf price, there is no
 * negotiated discount behind it, and there is no account to order on yet.
 */
function newSupplierBadgeHtml(hit) {
  if (hit.isMine !== false) return '';

  return (
    '<span class="rounded-md bg-sky-500/12 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300" ' +
    'title="' + escapeHtml(translate('Магазин извън твоите доставчици — цена по каталог, без договорена отстъпка.')) + '">' +
    translate('нов магазин') +
    '</span>'
  );
}

function matchBadgeHtml(hit) {
  const match = hit.match;

  if (!match) {
    // Older payload, or matching switched off: fall back to what the
    // shop's own search engine implied.
    return hit.matched
      ? ''
      : '<span class="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400/90" ' +
          'title="Търсачката на магазина върна това по подобие — името не съдържа търсеното.">по подобие</span>';
  }

  const band = MATCH_BANDS[match.band] || MATCH_BANDS.weak;
  const percent = Math.round(match.confidence * 100);

  // The relation, where the payload carries one. "Друг вариант" and "различен"
  // are two answers a percentage cannot tell apart, and they lead to opposite
  // decisions: one is worth a click, the other is worth skipping.
  const label = RELATION_LABELS[match.relation] || band.label;

  // The tooltip is the explanation in full: what agreed, what neither side
  // could confirm, and what ruled it out. Section 24 asks for exactly this,
  // and it is what a buyer disputing a match needs to read.
  const line = (entry) =>
    (entry.status === 'conflict' ? '✕ ' : entry.status === 'missing' ? '? ' : '✓ ') +
    entry.label +
    (entry.right || entry.left ? ': ' + (entry.left || '—') + ' / ' + (entry.right || '—') : '');

  const detail = (match.reasons || []).slice(0, 8).map(line).join('\n');
  const title = match.explanation + (detail ? '\n\n' + detail : '');

  // A conflict is never a shade of agreement, whatever the confidence says.
  const className =
    match.relation === 'conflict'
      ? 'bg-rose-500/12 text-rose-300'
      : match.relation === 'compatible'
        ? 'bg-indigo-500/12 text-indigo-300'
        : match.relation === 'same_family'
          ? 'bg-amber-500/12 text-amber-400'
          : band.className;

  const conflicts = (match.conflicts || []).length;
  const missing = (match.missingAttributes || []).length;

  return (
    '<span class="rounded-md px-1.5 py-0.5 text-[10px] font-semibold ' +
    className +
    '" title="' +
    escapeHtml(title) +
    '">' +
    translate(label) +
    ' ' +
    percent +
    '%' +
    (conflicts ? ' · ✕' + conflicts : missing ? ' · ?' + missing : '') +
    (match.method === 'ai' ? ' · AI' : '') +
    '</span>'
  );
}

/**
 * What matching did, and what it cost.
 *
 * Shown because the honest version of "AI-powered" is a number: on a
 * catalogue with specifications in the names, almost every row is
 * settled by arithmetic and the model sees a handful.
 */
/**
 * The answer, in a sentence.
 *
 * Everything else on this screen is evidence; this is the conclusion —
 * who to buy from and what choosing them is worth. Derived entirely from
 * the rows above rather than written by a model, because a sentence that
 * sounds authoritative and disagrees with the table underneath it is
 * worse than no sentence.
 */
function verdictHtml(best, priced, dearest) {
  if (!best) return '';

  const saving = dearest - best.effectivePrice;
  const percent = best.match ? Math.round(best.match.confidence * 100) : null;
  const breakdown = best.match && best.match.breakdown;

  // The answer, before the evidence.
  //
  // This screen used to open with a table and a one-line note above it, and
  // the reader had to work out which row was the answer. The answer is one
  // offer at one supplier for one price, so it is said first, at a size that
  // says it is the answer, and everything else on the page is the working.
  return (
    '<div class="border-b border-white/8 bg-emerald-500/[0.05] px-4 py-3.5">' +
    '<div class="flex flex-wrap items-start gap-x-6 gap-y-4">' +
    '<div class="min-w-0 flex-1">' +
    '<p class="text-[11px] font-semibold uppercase tracking-wide text-emerald-500">' +
    '<i class="fa-solid fa-trophy mr-1.5 text-[10px]"></i>Най-добра оферта</p>' +
    '<p class="mt-1.5 text-[14px] font-semibold leading-snug text-slate-100">' +
    escapeHtml(best.name) +
    '</p>' +
    '<p class="mt-1 text-[11.5px] text-slate-500">' +
    escapeHtml(best.shopName) +
    ' · ' +
    escapeHtml(best.host) +
    '</p>' +
    '</div>' +
    '<div class="shrink-0 text-right">' +
    '<p class="num text-[26px] font-bold leading-none text-emerald-400">' +
    best.effectivePrice.toFixed(2) +
    ' <span class="text-[14px] font-semibold">' + escapeHtml(best.effectiveCurrency) + '</span></p>' +
    (best.discountPercent > 0
      ? '<p class="mt-1 text-[11px] text-slate-500">' +
        escapeHtml(formatMessage('след −{percent}%', { percent: best.discountPercent })) +
        '</p>'
      : '') +
    (saving >= 0.01
      ? '<p class="mt-1 text-[11px] text-emerald-500/90">' +
        escapeHtml(
          formatMessage('с {amount} под най-скъпата', {
            amount: saving.toFixed(2) + ' ' + best.effectiveCurrency,
          }),
        ) +
        '</p>'
      : '') +
    '</div>' +
    '</div>' +
    '<div class="mt-4 flex flex-wrap items-center gap-3">' +
    (best.url
      ? '<a href="' + escapeHtml(best.url) + '" target="_blank" rel="noopener" ' +
        'class="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-3.5 py-2 text-[12.5px] font-semibold text-ink-950 transition hover:bg-emerald-400">' +
        'Виж офертата<i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i></a>'
      : '') +
    (percent !== null
      ? '<span class="text-[11.5px] text-slate-400">' +
        escapeHtml(formatMessage('{percent}% съвпадение', { percent: percent })) +
        '</span>'
      : '') +
    // The explanation exists and is not in the way. A buyer disputing a match
    // needs every line of it; a buyer placing an order needs none of them.
    (breakdown
      ? '<details class="w-full">' +
        '<summary class="cursor-pointer list-none text-[11.5px] text-slate-500 transition hover:text-slate-300">' +
        '<i class="fa-solid fa-circle-info mr-1.5 text-[10px]"></i>Защо съвпада' +
        '</summary>' +
        breakdownHtml(breakdown) +
        '</details>'
      : '') +
    '</div>' +
    '</div>'
  );
}

/**
 * The verdict taken apart, for the reader who opened it.
 *
 * Deliberately behind a disclosure and deliberately complete: every dimension
 * that was weighed, what it compared, and whether it agreed. A percentage
 * nobody can take apart is a percentage nobody should act on.
 */
function breakdownHtml(breakdown) {
  const mark = { match: '✓', missing: '?', conflict: '✕' };
  const tone = {
    match: 'text-emerald-400',
    missing: 'text-slate-500',
    conflict: 'text-rose-400',
  };

  const rows = (breakdown.components || [])
    .filter(function (component) {
      // A dimension nobody stated on either side explains nothing.
      return component.value > 0 || component.status === 'conflict';
    })
    .map(function (component) {
      return (
        '<li class="flex items-baseline gap-2 py-0.5">' +
        '<span class="' + tone[component.status] + '">' + mark[component.status] + '</span>' +
        '<span class="text-slate-300">' + escapeHtml(translate(component.label)) + '</span>' +
        '<span class="text-slate-500">' + escapeHtml(component.detail) + '</span>' +
        '</li>'
      );
    })
    .join('');

  return (
    '<div class="mt-2 rounded-xl bg-ink-950/60 px-3.5 py-3">' +
    '<p class="text-[11.5px] text-slate-300">' + escapeHtml(translate(breakdown.headline)) + '</p>' +
    (rows ? '<ul class="mt-2 text-[11.5px]">' + rows + '</ul>' : '') +
    '</div>'
  );
}

function matchingSummaryHtml(matching) {
  if (!matching) return '';

  const parts = [];

  if (matching.decidedDeterministically > 0) {
    // "8 по спецификация" read as "8 matched" on a search where all
    // eight were rejected. It is a count of decisions, so it says so.
    parts.push('решени по спецификация: ' + matching.decidedDeterministically);
  }
  if (matching.aiCacheHits > 0) parts.push(matching.aiCacheHits + ' от запомнени');
  if (matching.aiCallsMade > 0 && matching.aiModel) {
    parts.push('AI: ' + escapeHtml(matching.aiModel));
  }
  // The meter is shown exactly when it moved — the search that spent a
  // comparison is the honest place to say so, not a settings page read
  // at the end of the month.
  if (matching.aiQuota && matching.aiCallsMade > 0) {
    parts.push(
      'изразходвани ' +
        matching.aiQuota.used +
        ' от ' +
        matching.aiQuota.limit +
        ' AI сравнения' +
        ' този месец',
    );
  }
  if (matching.aiSkippedReason === 'quota' && matching.aiQuota) {
    parts.push(
      'AI сравненията свършиха (' +
        matching.aiQuota.limit +
        ') — сравнявам по баркод и спецификация' +
        (topUpUrl ? ' · <a href="' + escapeHtml(topUpUrl) + '" target="_blank" rel="noopener" class="font-semibold text-accent-500 hover:underline">купи още</a>' : ''),
    );
  } else if (matching.aiSkippedReason === 'quota') {
    parts.push('AI лимитът за месеца е изчерпан');
  }

  if (parts.length === 0) return '';

  return (
    '<span class="text-[11px] text-slate-500" title="Моделът се пита само за офертите, които спецификациите не решават.">' +
    '<i class="fa-solid fa-wand-magic-sparkles mr-1 text-[10px] text-accent-500/70"></i>' +
    parts.join(' · ') +
    '</span>'
  );
}

/**
 * The filters this search can offer, which is never the same list twice.
 *
 * A laptop search offers memory, storage and a screen size. A pipe search
 * offers a bore, a length and a material. Neither list is written down
 * anywhere: the server counts what the candidates on *this* page turned out to
 * state, and an attribute earns a chip by having more than one value among
 * them — which is exactly the condition under which a filter is any use.
 */
let catalogueFilters = {};

function renderFacets(matching) {
  const facets = (matching && matching.facets) || [];
  if (!facets.length) return '';

  const chips = facets
    .map(function (facet) {
      const values = facet.values
        .slice(0, 8)
        .map(function (entry) {
          const active = catalogueFilters[facet.key] === entry.value;
          return (
            '<button type="button" data-facet="' +
            escapeHtml(facet.key) +
            '" data-value="' +
            escapeHtml(entry.value) +
            '" class="rounded-md px-2 py-1 text-[11px] ring-1 transition ' +
            (active
              ? 'bg-accent-500/15 text-accent-300 ring-accent-500/40'
              : 'bg-ink-900 text-slate-300 ring-white/8 hover:ring-white/20') +
            '">' +
            escapeHtml(entry.value) +
            '<span class="ml-1 text-slate-500">' +
            entry.count +
            '</span></button>'
          );
        })
        .join('');

      return (
        '<div class="flex flex-wrap items-center gap-1.5">' +
        '<span class="mr-1 text-[11px] uppercase tracking-wide text-slate-500">' +
        escapeHtml(attributeLabel(facet.key, facet.label)) +
        '</span>' +
        values +
        '</div>'
      );
    })
    .join('');

  const active = Object.keys(catalogueFilters).length;

  return (
    '<div id="catalogue-facets" class="mb-3 space-y-2 rounded-xl border border-white/8 bg-ink-900 px-4 py-2.5 shadow-panel">' +
    '<div class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">' +
    '<i class="fa-solid fa-sliders text-[10px]"></i>Стесни по характеристика' +
    (active
      ? '<button type="button" id="clear-facets" class="ml-auto rounded-md px-2 py-0.5 text-[11px] font-normal normal-case text-accent-400 hover:underline">изчисти</button>'
      : '') +
    '</div>' +
    chips +
    '</div>'
  );
}

/**
 * The next step when your own suppliers do not stock it.
 *
 * The whole point of having two scopes, and the reason neither of them needs
 * to be a decision the buyer makes up front. They ask the working question,
 * and if the answer is "nobody you deal with", the other question is one
 * button away rather than a second search they have to construct.
 */
function widenHtml(query) {
  if (searchScope() !== 'my_suppliers') return '';

  return (
    '<div class="mt-4">' +
    '<button type="button" id="search-everywhere" ' +
    'class="inline-flex items-center gap-2 rounded-xl bg-accent-500 px-4 py-2.5 text-[12.5px] font-semibold text-ink-950 transition hover:bg-accent-400">' +
    '<i class="fa-solid fa-globe text-[11.5px]"></i>' + translate('Потърси навсякъде') +
    '</button>' +
    '<p class="mt-2 text-[11.5px] text-slate-600">' +
    escapeHtml(translate('Магазини, с които още нямаш договорени условия — цените са по каталог.')) +
    '</p></div>'
  );
}

/** Wires that button, once it is on the page. */
function bindWiden() {
  const button = document.getElementById('search-everywhere');
  if (!button) return;

  button.addEventListener('click', function () {
    setSearchScope('global');
    $('#catalogue-search').click();
  });
}

/** True when a hit satisfies every filter the reader has switched on. */
function passesFilters(hit) {
  const keys = Object.keys(catalogueFilters);
  if (!keys.length) return true;

  const attributes = (hit.match && hit.match.attributes) || {};
  return keys.every(function (key) {
    return attributes[key] === catalogueFilters[key];
  });
}

/** Wires the filter chips, once the results they describe are on the page. */
function bindFacets(hits, query, matching, verdict) {
  const box = document.getElementById('catalogue-facets');
  if (!box) return;

  box.querySelectorAll('button[data-facet]').forEach(function (button) {
    button.addEventListener('click', function () {
      const key = button.getAttribute('data-facet');
      const value = button.getAttribute('data-value');

      // A second click on the same value clears it. Filters are a way of
      // asking a narrower question, not a state to be trapped in.
      if (catalogueFilters[key] === value) delete catalogueFilters[key];
      else catalogueFilters[key] = value;

      renderCatalogueResults(hits, query, matching, verdict);
    });
  });

  const clear = document.getElementById('clear-facets');
  if (clear) {
    clear.addEventListener('click', function () {
      catalogueFilters = {};
      renderCatalogueResults(hits, query, matching, verdict);
    });
  }
}


/**
 * What this shop will let you pay monthly.
 *
 * A price is one number and a purchase is often two decisions — 229 € against
 * 12 × 20.75 € is capital against cashflow, and the buyer could already see
 * the second on the shop's own page while the comparison stayed silent about
 * it.
 *
 * The shortest plan is shown, because it is the one with the least interest
 * buried in it and the one a buyer reads as "what would this cost me a month".
 * The rest, and the lender, ride along in the tooltip: a name is what makes
 * the offer checkable, and a buyer with an account at one bank and none at
 * another is not choosing between equal offers.
 */
function instalmentChipHtml(hit) {
  const plans = (hit && hit.instalments) || [];
  if (!plans.length) return '';

  const first = plans[0];
  const described = plans
    .map(function (plan) {
      return (
        plan.months +
        ' × ' +
        plan.monthly.toFixed(2) +
        ' ' +
        plan.currency +
        (plan.provider ? ' · ' + plan.provider : '')
      );
    })
    .join('\n');

  return (
    '<span class="mt-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300" ' +
    'title="' +
    escapeHtml(translate('На изплащане, както го обявява магазинът:') + '\n' + described) +
    '">' +
    '<i class="fa-solid fa-credit-card text-[9px]"></i>' +
    escapeHtml(
      first.months + ' × ' + first.monthly.toFixed(2) + ' ' + first.currency,
    ) +
    (first.provider
      ? '<span class="text-sky-300/70">· ' + escapeHtml(first.provider) + '</span>'
      : '') +
    '</span>'
  );
}



/**
 * Questions asked before, so one can be reopened rather than re-run.
 *
 * Drawn from the search rows alone — the server projects the status and the
 * counts onto them precisely so this list costs one query and reads no saved
 * document. Opening a row reads exactly one.
 */
async function renderSearchHistory() {
  const box = $('#search-history');
  if (!box || !isIdentified()) return;

  try {
    const searches = await fetch(ENDPOINTS.discoverySearches + '?limit=8', {
      headers: authHeaders(),
    }).then(okJson);

    if (!searches.length) {
      box.innerHTML = '';
      return;
    }

    box.innerHTML =
      '<div class="rounded-xl border border-white/8 bg-ink-900 px-3.5 py-2.5 shadow-panel">' +
      '<p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">' +
      escapeHtml(translate('Предишни търсения')) +
      '</p><div class="flex flex-wrap gap-1.5">' +
      searches.map(historyChipHtml).join('') +
      '</div></div>';

    box.querySelectorAll('[data-open-search]').forEach(function (button) {
      button.addEventListener('click', function () {
        void openSavedSearch(button.getAttribute('data-open-search'));
      });
    });

    box.querySelectorAll('[data-forget-search]').forEach(function (button) {
      button.addEventListener('click', async function (event) {
        // The row is a button too. Without this the click opens the search on
        // its way to deleting it, and the reader watches results load into a
        // screen they were clearing.
        event.stopPropagation();
        await forgetSavedSearch(button.getAttribute('data-forget-search'), button);
      });
    });
  } catch (error) {
    // History is a convenience. Failing to draw it must not disturb the search
    // box above it, which is what the reader actually came for.
    box.innerHTML = '';
  }
}

/**
 * One article, once, with what it last cost.
 *
 * The list is a reminder, so it carries the two things a reminder is for: what
 * was asked, and what came back. A price is shown only where the last run
 * actually found one — a search that matched nothing shows that it matched
 * nothing, because a figure invented for the sake of a filled column is the
 * mistake the whole matcher exists to prevent.
 */
function historyChipHtml(entry) {
  const when = entry.lastRunAt ? formatRelative(entry.lastRunAt) : '';
  const found = typeof entry.bestPrice === 'number';

  const title =
    when +
    (entry.runCount > 1 ? ' · ' + entry.runCount + ' ' + translate('търсения') : '') +
    (found ? ' · ' + entry.offerCount + ' ' + plural(entry.offerCount, 'оферта', 'оферти') : '');

  return (
    '<span class="group/hist inline-flex items-center overflow-hidden rounded-lg border border-white/8 bg-ink-850 transition hover:border-white/20">' +
    '<button type="button" data-open-search="' + escapeHtml(entry.id) + '" ' +
    'title="' + escapeHtml(title) + '" ' +
    'class="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11.5px] text-slate-300 transition hover:text-slate-200">' +
    (entry.scope === 'global'
      ? '<i class="fa-solid fa-globe text-[9px] text-slate-500"></i>'
      : '<i class="fa-solid fa-store text-[9px] text-slate-500"></i>') +
    escapeHtml(entry.query) +
    (found
      ? '<span class="num font-semibold ' +
        (entry.fresh ? 'text-emerald-400' : 'text-slate-400') +
        '">' +
        escapeHtml(entry.bestPrice.toFixed(2) + ' ' + (entry.bestCurrency || '')) +
        '</span>'
      : '<span class="text-[10.5px] text-slate-600">' +
        escapeHtml(translate('няма намерено')) +
        '</span>') +
    '</button>' +
    '<button type="button" data-forget-search="' + escapeHtml(entry.id) + '" ' +
    'title="' + escapeHtml(translate('Премахни от историята')) + '" ' +
    'aria-label="' + escapeHtml(translate('Премахни от историята')) + '" ' +
    'class="px-1.5 py-1 text-[10px] text-slate-600 transition hover:bg-red-500/10 hover:text-red-400">' +
    '<i class="fa-solid fa-xmark"></i></button>' +
    '</span>'
  );
}

/**
 * Removes an article from the history.
 *
 * The row goes at once rather than after a round trip: the reader asked for it
 * to be gone, and a chip that lingers for half a second reads as a click that
 * missed. If the request fails the list is redrawn, which puts it back.
 */
async function forgetSavedSearch(searchId, button) {
  if (!searchId) return;

  const chip = button.closest('.group\\/hist') || button.parentElement;
  if (chip) chip.remove();

  try {
    const response = await fetch(
      ENDPOINTS.discoverySearches + '/' + encodeURIComponent(searchId),
      { method: 'DELETE', headers: authHeaders() },
    );
    if (!response.ok) throw new Error('HTTP ' + response.status);

    // The open results may belong to the search just deleted, in which case
    // the id in the address bar now names nothing and a reload would land on
    // an error.
    const showing = new URLSearchParams(window.location.search).get('s');
    if (showing === searchId) forgetSearch();
  } catch (error) {
    toast(translate('Не успяхме да премахнем търсенето.'), 'error');
    void renderSearchHistory();
  }
}

/* --- Searches that survive a reload -------------------------------- *
 *
 * A comparison costs a dozen requests to other people's servers, and it used
 * to live only in this file's memory. Pressing F5 threw it away, and the only
 * route back to the prices somebody had just been reading was to run all of it
 * again — expensive, rude to the shops, and frequently a *different* answer,
 * because shops move.
 *
 * So the server writes each search down and hands back an id, and that id goes
 * in the address bar. A reload reads it, asks for the saved answer, and shows
 * the same prices with the date they were obtained. No supplier is contacted.
 */

/** The search this page is showing, so a reload can find its way back. */
function rememberSearch(searchId) {
  if (!searchId) return;

  const url = new URL(window.location.href);
  if (url.searchParams.get('s') === searchId) return;

  url.searchParams.set('s', searchId);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

/** Drops the id when the reader starts something new. */
function forgetSearch() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('s')) return;

  url.searchParams.delete('s');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

/**
 * Shows a saved answer, without asking a single shop.
 *
 * This is what a browser refresh and a click in the history both do. The
 * payload is the comparison exactly as it was returned, so the same renderer
 * draws the same screen — the same offers, prices, availability and per-shop
 * outcomes, including the shops that failed. Those are not retried: a shop
 * that was down when the search ran is part of what the snapshot records.
 */
async function openSavedSearch(searchId) {
  const results = $('#catalogue-results');
  const live = $('#live-results');
  if (!results) return false;

  live.innerHTML = '';
  results.innerHTML =
    '<p class="text-[12.5px] text-slate-500">' + translate('Зареждам запазените резултати…') + '</p>';

  try {
    const saved = await fetch(ENDPOINTS.discoverySearches + '/' + encodeURIComponent(searchId), {
      headers: authHeaders(),
    }).then(okJson);

    const payload = saved.payload || {};
    const box = $('#catalogue-query');
    if (box && !box.value) box.value = saved.query;
    setSearchScope(saved.scope);

    renderShopOutcomes(payload);
    renderCatalogueResults(payload.hits || [], saved.query, payload.matching, {
      ...payload,
      searchId: saved.id,
      fetchedAt: saved.fetchedAt,
      fresh: saved.fresh,
      restored: true,
    });

    rememberSearch(saved.id);
    return true;
  } catch (error) {
    // A saved search that will not open is not a reason to show nothing: the
    // reader can still type the question again.
    results.innerHTML = failureHtml(error, translate('Запазеното търсене не се зареди'));
    forgetSearch();
    return false;
  }
}

/**
 * When the answer was obtained, and whether to trust it yet.
 *
 * Shown on every restored search and on none of the live ones — a comparison
 * that finished two seconds ago does not need a date on it. Past the freshness
 * window the same line turns into a warning, because the prices below it are
 * the ones that were true then, which is exactly what they are for and exactly
 * what makes them dangerous to read as current.
 */
function provenanceHtml(verdict) {
  if (!verdict || !verdict.restored || !verdict.fetchedAt) return '';

  const when = new Date(verdict.fetchedAt);
  const stale = verdict.fresh === false;
  const absolute = when.toLocaleString(currentLocale(), {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    '<div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-[11.5px] ' +
    (stale
      ? 'border-amber-500/25 bg-amber-500/[0.06] text-amber-400'
      : 'border-white/8 bg-ink-900 text-slate-400') +
    '">' +
    '<i class="fa-solid ' + (stale ? 'fa-clock-rotate-left' : 'fa-bookmark') + ' text-[10px]"></i>' +
    '<span>' +
    escapeHtml(formatMessage('Резултатите са от {when}.', { when: absolute })) +
    (stale
      ? ' <span class="opacity-80">' +
        escapeHtml(translate('Цените и наличностите може вече да не са актуални.')) +
        '</span>'
      : '') +
    '</span>' +
    '<button type="button" data-refresh-search="' + escapeHtml(verdict.searchId || '') + '" ' +
    'class="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-ink-850 px-2.5 py-1 text-[11.5px] font-medium text-slate-300 transition hover:border-white/20 hover:text-slate-200">' +
    '<i class="fa-solid fa-rotate text-[10px]"></i>' + escapeHtml(translate('Обнови резултатите')) +
    '</button>' +
    '</div>'
  );
}

/**
 * Asks the suppliers again, and keeps what we already have if that fails.
 *
 * The old snapshot is never removed — the server writes a new one beside it —
 * so a refresh that cannot reach the shops leaves the reader exactly where
 * they were, with a line saying why. Two clicks are one search: the server
 * joins the second request to the run already in progress.
 */
function bindRefreshSearch() {
  const button = document.querySelector('[data-refresh-search]');
  if (!button) return;

  button.addEventListener('click', async function () {
    const searchId = button.getAttribute('data-refresh-search');
    if (!searchId || button.disabled) return;

    button.disabled = true;
    button.classList.add('opacity-60');

    try {
      const fresh = await fetch(
        ENDPOINTS.discoverySearches + '/' + encodeURIComponent(searchId) + '/refresh',
        { method: 'POST', headers: authHeaders() },
      ).then(okJson);

      renderShopOutcomes(fresh);
      renderCatalogueResults(fresh.hits || [], fresh.query, fresh.matching, fresh);
      rememberSearch(fresh.searchId || searchId);
      toast(translate('Резултатите са обновени.'), 'success');
    } catch (error) {
      // Deliberately not destructive. What is on screen is the last answer the
      // shops actually gave, and it stays there.
      toast(
        translate('Не успяхме да обновим резултатите. Показваме последно запазените.'),
        'error',
      );
      button.disabled = false;
      button.classList.remove('opacity-60');
    }
  });
}

function renderCatalogueResults(allHits, query, matching, verdict) {
  const results = $('#catalogue-results');
  catalogueHits = allHits;

  // The server's verdict outranks the list length, and outranks anything a
  // shop's search engine returned.
  //
  // Belt and braces on purpose. The backend now sends only validated rows, so
  // an empty list already produces the right screen — but this function used
  // to be handed every candidate a supplier coughed up and rendered them as
  // priced offers under a note saying nothing matched. One explicit refusal
  // here means no future payload change can bring that screen back.
  const status = verdict && verdict.status;
  if (status === 'NO_MATCH') allHits = [];

  /*
   * Which rows the price arithmetic is allowed to see.
   *
   * The crown, the "from" figure and the per-group spread are claims about
   * *this article*, and they were being computed over every row on the page.
   * A cheaper price on a different article is not a saving — it is the one
   * mistake this feature exists to prevent — and the day an 8.94 € screen
   * protector outranked a 114.99 € polisher, the arithmetic was correct and
   * the answer was nonsense.
   *
   * So the server says which rows are offers, and only those are priced.
   * Alternatives stay on the page and stay out of the sums.
   */
  const offerUrls = new Set(
    ((verdict && verdict.offers) || []).map(function (offer) { return offer.url; }),
  );
  const isOffer = function (hit) {
    return offerUrls.size ? offerUrls.has(hit.url) : Boolean(hit.match) && hit.match.relation === 'same_product';
  };

  // Filtering happens here rather than on the server: the results are already
  // in the browser, and a round trip to hide four rows would be a round trip
  // the buyer waits for.
  const hits = allHits.filter(passesFilters);

  // Filtered down to nothing. Said plainly, with the filters still on screen —
  // an empty table under six switched-on chips reads as a broken search.
  if (allHits.length && !hits.length) {
    results.innerHTML =
      renderFacets(matching) +
      '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-6 text-center text-[12.5px] text-slate-500 shadow-panel">' +
      'Никоя оферта не отговаря на избраните характеристики.</div>';
    bindFacets(allHits, query, matching, verdict);
    return;
  }

  if (!allHits.length) {
    const widen = widenHtml(query);

    results.innerHTML =
      '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-7 text-center shadow-panel">' +
      '<i class="fa-solid fa-inbox mb-3 block text-[17px] text-slate-700"></i>' +
      '<p class="text-[13px] font-medium text-slate-300">' +
      escapeHtml(
        widen
          ? formatMessage('Не намерихме „{query}" при твоите доставчици.', { query: query })
          : formatMessage('Нищо за „{query}".', { query: query }),
      ) +
      '</p>' +
      (widen ||
        '<p class="mx-auto mt-2 max-w-md text-[12.5px] text-slate-500">' +
          escapeHtml(translate('Пробвайте с модел или артикулен номер вместо описание.')) +
          '</p>') +
      '</div>';

    bindWiden();
    bindRefreshSearch();
    return;
  }

  // Two different questions, and answering them with one number was the bug.
  //
  //  * **Trusted** decides the *price* claims: the crown, the "from" figure,
  //    the per-group spread. A cheaper price on a different article is not a
  //    saving, so anything the matcher is unsure of stays out of the
  //    arithmetic.
  //
  //  * **Excluded** decides what is *shown at all*, and only a stated
  //    difference earns that. Folding everything under 70 % away meant a
  //    search for a cable the buyer described in their own words produced a
  //    screen saying nobody stocked it, with the right answer collapsed
  //    underneath. A possible match is still an answer.
  const MATCH_FLOOR = 0.7;
  const isWeak = (hit) => Boolean(hit.match) && hit.match.confidence < MATCH_FLOOR;

  const isExcluded = function (hit) {
    if (!hit.match) return false;
    if (hit.match.relation) {
      return hit.match.relation === 'conflict' || hit.match.relation === 'unrelated';
    }
    // An older payload with no relation on it: the floor is all there is.
    return hit.match.confidence < MATCH_FLOOR;
  };

  // Sold-out rows are shown, and they do not get to set the price.
  //
  // The "from 95 €" line, the per-group spread and the crown are claims about
  // what this article costs *today*. A shop that has run out keeps the row and
  // the number on its page, often the lowest number on screen because it was
  // being cleared — so letting it into the arithmetic quotes a price nobody
  // can pay. Only a stated refusal is excluded: silence about stock is the
  // normal state of an article that is perfectly available.
  const priced = hits.filter(
    (hit) =>
      hit.effectivePrice !== null && !isWeak(hit) && isOffer(hit) && hit.inStock !== false,
  );
  const cheapest = priced.length
    ? Math.min(...priced.map((hit) => hit.effectivePrice))
    : 0;
  const dearest = priced.length ? Math.max(...priced.map((hit) => hit.effectivePrice)) : 0;

  // The crown goes to the cheapest row we believe is the right article,
  // wherever it now sits: the list is ordered by confidence first.
  const chosen = verdict && verdict.bestOffer;
  const best =
    (chosen && priced.find(function (hit) { return hit.url === chosen.url; })) ||
    priced.reduce(
      (winner, hit) => (winner === null || hit.effectivePrice < winner.effectivePrice ? hit : winner),
      null,
    );

  const suppliers = new Set(hits.map((hit) => hit.host));
  // Counted over offers, because that is what the sentence claims to count.
  const offerRows = hits.filter(isOffer);
  const offerCount = offerRows.length;
  const offerSuppliers = new Set(offerRows.map((hit) => hit.host));
  const showSupplier = true;

  // Per-group extremes: the cheapest cable is not comparable with the
  // cheapest reel, so each group is coloured against its own range.
  const groupStats = new Map();
  hits.forEach(function (hit) {
    if (hit.effectivePrice === null || isWeak(hit) || !isOffer(hit) || hit.inStock === false) return;
    const stat = groupStats.get(hit.groupKey);
    if (!stat) {
      groupStats.set(hit.groupKey, {
        min: hit.effectivePrice,
        max: hit.effectivePrice,
        count: 1,
      });
      return;
    }
    stat.min = Math.min(stat.min, hit.effectivePrice);
    stat.max = Math.max(stat.max, hit.effectivePrice);
    stat.count += 1;
  });

  const groupCount = new Set(hits.map((hit) => hit.groupKey)).size;
  const singleGroup = groupCount <= 1;
  const anyDiscount = hits.some((hit) => hit.discountPercent > 0);

  const columnCount = 4 + (showSupplier ? 1 : 0) + (anyDiscount ? 1 : 0) + 1;
  let lastGroup = null;

  // A group of one is not a group. Nine offers under nine headings, each
  // heading repeating the row beneath it, is more text and less meaning
  // than no grouping at all.
  const comparable = new Set(
    [...groupStats.entries()].filter(([, stat]) => stat.count > 1).map(([key]) => key),
  );

  const strong = hits.filter((hit) => !isExcluded(hit));
  const weak = hits.filter(isExcluded);

  // Eight kitchens returned for "лед крушка" is not eight results. When
  // nothing clears the bar, the honest answer is "nothing matched" with
  // the shop's guesses folded away — listing them like results makes the
  // tool look broken when it was the shop's search engine being generous.
  /*
   * Nothing the matcher would stand behind — which is not the same as nothing.
   *
   * This used to answer with a panel saying "никой доставчик няма" and fold
   * every row away behind a button. A search that had just reported "намерено
   * в 1 от 6 магазина · 11 резултата" then showed none of them, and the two
   * halves of the screen contradicted each other in front of the reader.
   *
   * A shop's own search returning eleven things is information. It is not a
   * confirmed match and it must not be dressed as one, but hiding it is the
   * software telling somebody that what they can plainly see does not exist.
   * So the rows are shown, with a line above them saying exactly what they are.
   */
  const nothingConfirmed = strong.length === 0;

  const unconfirmedNote = nothingConfirmed
    ? '<div class="border-b border-white/8 bg-amber-500/[0.06] px-4 py-3 text-[11.5px] leading-relaxed text-amber-400">' +
      '<i class="fa-solid fa-circle-info mr-1.5 text-[10px]"></i>' +
      escapeHtml(
        formatMessage('Нищо не съвпада точно с „{query}".', { query: query }),
      ) +
      ' <span class="text-amber-400/70">' +
      escapeHtml(
        pluralMessage(hits.length, {
          one: 'Отдолу е {n} резултатът, който търсачките на магазините върнаха.',
          other: 'Отдолу са {n} резултата, които търсачките на магазините върнаха.',
        }),
      ) +
      '</span>' +
      widenHtml(query) +
      '</div>'
    : '';

  const ordered = [
    ...strong.filter((hit) => !isWeak(hit) && comparable.has(hit.groupKey)),
    ...strong.filter((hit) => !isWeak(hit) && !comparable.has(hit.groupKey)),
    ...strong.filter(isWeak),
    ...weak,
  ];

  let singlesHeaderDone = false;
  // Two running headings, because a row can be unsure *and* a row can be ruled
  // out, and they are shown in different halves of the table.
  let lastUnsureRelation = null;
  let lastExcludedRelation = null;

  const rows = ordered
    .map(function (hit, index) {
      const stat = groupStats.get(hit.groupKey) || { min: cheapest, max: dearest, count: 1 };
      let header = '';

      const groupHeader = (label, note, spread, currency) =>
        '<tr><td colspan="' +
        columnCount +
        '" class="border-y border-white/8 bg-ink-950/60 px-4 py-2">' +
        '<span class="flex flex-wrap items-baseline gap-x-2 gap-y-1">' +
        '<span class="text-[11px] font-semibold uppercase tracking-wide text-accent-500">' +
        escapeHtml(label) +
        '</span>' +
        (note ? '<span class="text-[11px] text-slate-500">' + escapeHtml(note) + '</span>' : '') +
        // The reason to read the group at all: what choosing well is worth
        // here. Under a cent it is noise and saying it would be padding.
        (spread && spread >= 0.01
          ? '<span class="ml-auto rounded-md bg-emerald-500/12 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">' +
            translate('разлика до') +
            ' ' +
            spread.toFixed(2) +
            ' ' +
            escapeHtml(currency || '') +
            '</span>'
          : '') +
        '</span></td></tr>';

      if (isExcluded(hit)) {
        // Checked first: a doubtful row often shares a group with the
        // real ones, and falling into the group branch would file it
        // under a heading that says these are comparable.
        //
        // Which heading depends on *why* it is doubtful, and those are not
        // degrees of one thing. A 256 GB drive where 128 was asked for is a
        // different article; a brake pad by another maker for the same car is
        // a purchase worth considering; a listing the shop merely guessed at
        // is neither. One heading for all three told the buyer nothing.
        const relation = (hit.match && hit.match.relation) || 'possible';
        if (relation !== lastExcludedRelation) {
          lastExcludedRelation = relation;
          header = groupHeader(
            WEAK_GROUP_HEADINGS[relation] || WEAK_GROUP_HEADINGS.possible,
            WEAK_GROUP_NOTES[relation] || WEAK_GROUP_NOTES.possible,
            0,
            '',
          );
        }
      } else if (comparable.has(hit.groupKey) && !isWeak(hit)) {
        if (hit.groupKey !== lastGroup) {
          lastGroup = hit.groupKey;
          header = groupHeader(
            hit.groupLabel,
            stat.count +
              ' ' +
              plural(stat.count, 'оферта', 'оферти') +
              ' · ' +
              stat.min.toFixed(2) +
              ' – ' +
              stat.max.toFixed(2) +
              ' ' +
              hit.effectiveCurrency,
            stat.max - stat.min,
            hit.effectiveCurrency,
          );
        }
      } else if (isWeak(hit)) {
        // Shown, and shown as what it is: a listing worth a look that the
        // matcher would not put a price claim behind.
        const relation = (hit.match && hit.match.relation) || 'possible';
        if (relation !== lastUnsureRelation) {
          lastUnsureRelation = relation;
          header = groupHeader(
            WEAK_GROUP_HEADINGS[relation] || WEAK_GROUP_HEADINGS.possible,
            WEAK_GROUP_NOTES[relation] || WEAK_GROUP_NOTES.possible,
            0,
            '',
          );
        }
      } else if (!singlesHeaderDone && comparable.size > 0) {
        singlesHeaderDone = true;
        header = groupHeader(
          'Единични резултати',
          'по една оферта — няма с какво да се сравнят',
          0,
          '',
        );
      }

      const specs = specChipsHtml(parseSpecs(hit.name));

      // Measured against the cheapest *of this kind of article*, which is
      // the only comparison that means anything: a cable drum being
      // dearer than a metre of cable is not a finding.
      const delta =
        hit.effectivePrice !== null && stat.min > 0 && !isWeak(hit)
          ? hit.effectivePrice - stat.min
          : null;
      const over = delta !== null && stat.min > 0 ? (delta / stat.min) * 100 : null;
      // A group of one has no winner: nothing was beaten. Calling the
      // only offer "най-евтин" is a badge every row earns, which is the
      // same as no badge at all.
      const isBest = delta !== null && delta < 0.005 && stat.count > 1;

      // Severity by how much is actually being left on the table. A
      // uniform colour told the reader nothing they could act on.
      const deltaTone =
        over === null
          ? 'text-slate-500'
          : over < 10
            ? 'text-slate-400'
            : over < 30
              ? 'text-amber-400'
              : 'text-red-400';

      return (
        header +
        '<tr class="group border-b border-white/[0.06] transition hover:bg-white/[0.03]" ' +
        'data-hover="offer" data-hover-id="' +
        index +
        '" tabindex="0">' +
        '<td class="py-3 pl-5 pr-3">' +
        '<span class="flex items-start gap-3">' +
        (hit === best
          ? '<span class="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-[10px] font-bold text-emerald-400" title="Най-евтиният за вас">' +
            '<i class="fa-solid fa-crown text-[9px]"></i></span>'
          : '<span class="num mt-0.5 w-5 shrink-0 text-center text-[11px] text-slate-600">' +
            (index + 1) +
            '</span>') +
        '<span class="min-w-0 flex-1">' +
        (hit.url
          ? '<a href="' +
            escapeHtml(hit.url) +
            '" target="_blank" rel="noopener noreferrer" class="block text-[12.5px] font-medium leading-snug text-slate-200 transition [overflow-wrap:anywhere] group-hover:text-accent-500" title="' +
            escapeHtml(hit.name) +
            '">' +
            escapeHtml(hit.name) +
            '</a>'
          : '<span class="block text-[12.5px] font-medium leading-snug text-slate-200 [overflow-wrap:anywhere]" title="' +
            escapeHtml(hit.name) +
            '">' +
            escapeHtml(hit.name) +
            '</span>') +
        (specs || hit.match || !hit.matched || hit.recordedAt
          ? '<span class="mt-1 flex flex-wrap items-center gap-1">' +
            matchBadgeHtml(hit) +
            newSupplierBadgeHtml(hit) +
            // A price typed in three weeks ago and one read three seconds
            // ago rank together, which is right — but they are not the
            // same claim, and only this says so.
            (hit.priceSource === 'manual'
              ? '<span class="rounded-md bg-violet-500/12 px-1.5 py-0.5 text-[10px] text-violet-300" ' +
                'title="Цена, която вие сте въвели. Нищо не я презарежда — проверете я, ако е стара.">' +
                'ваша цена · ' +
                escapeHtml(formatRelative(hit.recordedAt)) +
                '</span>'
              : hit.recordedAt
                ? '<span class="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-400" ' +
                  'title="Прочетено от магазина по-рано и запазено. Отметнете „Питай наново“ за цена към момента.">' +
                  'прочетено ' +
                  escapeHtml(formatRelative(hit.recordedAt)) +
                  '</span>'
                : '') +
            specs +
            instalmentChipHtml(hit) +
            '</span>'
          : '') +
        '</span></span></td>' +
        (showSupplier
          ? '<td class="px-3 py-3 text-[11.5px] text-slate-400">' +
            // A supplier without a page is a name, not a link. This cell used
            // to write the anchor either way, and an empty href is not an
            // inert link — the browser resolves it against the current page,
            // so every offer that arrived without a URL sent the buyer back to
            // the address they were already on.
            (hit.url
              ? '<a href="' +
                escapeHtml(hit.url) +
                '" target="_blank" rel="noopener noreferrer" class="block truncate font-medium text-slate-300 transition hover:text-accent-500 hover:underline" title="Отвори в ' +
                escapeHtml(hit.host) +
                '">' +
                escapeHtml(hit.shopName) +
                '</a>'
              : '<span class="block truncate font-medium text-slate-300" title="' +
                escapeHtml(hit.shopName) +
                '">' +
                escapeHtml(hit.shopName) +
                '</span>') +
            '<span class="block truncate font-mono text-[10px] text-slate-500">' +
            escapeHtml(hit.host) +
            '</span>' +
            (hit.discountPercent > 0
              ? '<span class="mt-0.5 inline-block rounded bg-accent-500/12 px-1 py-0.5 text-[10px] font-semibold text-accent-300">−' +
                hit.discountPercent +
                '%</span>'
              : '') +
            '</td>'
          : '') +
        (anyDiscount
          ? '<td class="num px-3 py-3 text-right text-[11.5px] ' +
            (hit.discountPercent > 0 ? 'text-slate-500 line-through' : 'text-slate-600') +
            '">' +
            (hit.listedPrice === null ? '—' : hit.listedPrice.toFixed(2)) +
            '</td>'
          : '') +
        '<td class="px-3 py-3">' +
        '<span class="flex items-baseline justify-end gap-1.5">' +
        '<span class="num text-[14px] font-semibold ' +
        (isBest ? 'text-emerald-400' : 'text-slate-200') +
        '">' +
        (hit.effectivePrice === null ? '—' : hit.effectivePrice.toFixed(2)) +
        '</span>' +
        '<span class="text-[10px] text-slate-600">' +
        escapeHtml(hit.effectiveCurrency) +
        '</span></span>' +
        (hit.discountPercent > 0 && hit.listedPrice !== null
          ? '<span class="mt-0.5 block text-right text-[10px] text-accent-300/80">' +
            translate('след') +
            ' −' +
            hit.discountPercent +
            '%</span>'
          : '') +
        '</td>' +
        /* The decision column. Percentage alone is thin when the order is
           a hundred metres: what is spent is the per-unit difference
           times the quantity, so both are shown. */
        '<td class="px-3 py-3 text-right">' +
        (isBest
          ? '<span class="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">' +
            '<i class="fa-solid fa-check text-[9px]"></i>най-евтин</span>'
          : delta === null || stat.count < 2
            ? '<span class="text-[11px] text-slate-600">—</span>'
            : '<span class="num block text-[11.5px] font-semibold ' +
              deltaTone +
              '">+' +
              delta.toFixed(2) +
              '</span>' +
              '<span class="num block text-[10px] text-slate-500">+' +
              over.toFixed(0) +
              '%</span>') +
        '</td>' +
        '<td class="py-3 pl-3 pr-5">' +
        (hit.inStock === false
          ? '<span class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-400"><i class="fa-solid fa-circle-minus text-[9px]"></i>изчерпан</span>'
          : hit.inStock === true
            ? '<span class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-400"><i class="fa-solid fa-circle-check text-[9px]"></i>наличен</span>'
            : '<span class="text-[11px] text-slate-600">—</span>') +
        '</td></tr>'
      );
    })
    .join('');

  /* Written out whole, one string per layout, because Tailwind finds classes
     by reading this file as text. Built up as `'w-[' + percent + ']'` the name
     never appears in the source, so no rule was ever generated and the
     colgroup did nothing: the table fell back to sizing by content, which is
     why article names truncated to "LED лампа E27 12W 40…" while availability,
     which never holds more than "наличен", sprawled across the right.

     Everything a row knows is already printed on it, so there is nothing to
     add in that space. It goes to the two columns that carry words. */
  /*
   * Widths that fit the words the columns actually contain.
   *
   * Availability had nine per cent, which is not enough for the badge that
   * goes in it — "изчерпан" with its icon overflowed, and the wrapper's
   * `overflow-hidden` sliced the label down the middle. The article column had
   * forty-six and spent it truncating titles anyway, because a product name in
   * this trade is sixty characters before the size.
   *
   * So the widest column gives up what the narrowest one was short of. Nothing
   * scrolls sideways: the table still totals a hundred per cent, and the names
   * wrap onto a second line rather than losing their ends.
   */
  const columns = anyDiscount
    ? '<col class="w-[34%]" /><col class="w-[16%]" /><col class="w-[9%]" />' +
      '<col class="w-[13%]" /><col class="w-[11%]" /><col class="w-[17%]" />'
    : '<col class="w-[40%]" /><col class="w-[18%]" />' +
      '<col class="w-[14%]" /><col class="w-[11%]" /><col class="w-[17%]" />';

  const range =
    singleGroup && priced.length > 1
      ? ' · ' + translate('от') + ' <strong class="num text-emerald-400">' +
        cheapest.toFixed(2) +
        '</strong> ' + translate('до') + ' <strong class="num text-slate-300">' +
        dearest.toFixed(2) +
        ' ' +
        escapeHtml(priced[0].effectiveCurrency) +
        '</strong>'
      : '';

  const comparableGroups = [...groupStats.values()].filter((stat) => stat.count > 1);
  const bestSaving = comparableGroups.reduce(
    (most, stat) => Math.max(most, stat.max - stat.min),
    0,
  );

  const spread =
    singleGroup && priced.length > 1 && cheapest > 0
      ? '<span class="rounded-md bg-emerald-500/12 px-2 py-1 text-[11px] font-semibold text-emerald-400">' +
        escapeHtml(
          formatMessage('спестявате до {amount} на бройка', {
            amount: (dearest - cheapest).toFixed(2) + ' ' + priced[0].effectiveCurrency,
          }),
        ) +
        '</span>'
      : bestSaving > 0
        ? '<span class="rounded-md bg-emerald-500/12 px-2 py-1 text-[11px] font-semibold text-emerald-400">' +
          escapeHtml(
            formatMessage('спестявате до {amount}', {
              amount: bestSaving.toFixed(2) + ' ' + priced[0].effectiveCurrency,
            }),
          ) +
          '</span>'
        : '';

  // When a shop's search guesses at everything, say so once at the top
  // rather than leaving the user to wonder why "СВТ" returned downlights.
  // One note, not two saying the same thing. When nothing was confirmed, that
  // is the more precise complaint and it wins.
  const anyMatched = hits.some((hit) => hit.matched);
  const guessNote =
    unconfirmedNote ||
    (anyMatched
      ? ''
      : '<div class="border-b border-white/8 bg-amber-500/[0.06] px-4 py-2.5 text-[11.5px] text-amber-400">' +
        '<i class="fa-solid fa-circle-info mr-1.5 text-[10px]"></i>' +
        'Никой магазин не намери точно „' +
        escapeHtml(query) +
        '". Показаното е това, което техните търсачки върнаха по подобие.</div>');

  results.innerHTML =
    provenanceHtml(verdict) +
    renderFacets(matching) +
    '<div class="overflow-hidden rounded-xl border border-white/8 bg-ink-900 shadow-panel">' +
    guessNote +
    '<div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-2.5">' +
    '<p class="text-[12.5px] text-slate-400">' +
    escapeHtml(
      // Matches, never retrieved rows. This said `hits.length` and therefore
      // announced "Намерихме 8 оферти" about eight things nobody could buy.
      pluralMessage(offerCount, {
        one: 'Намерихме {n} оферта',
        other: 'Намерихме {n} оферти',
      }),
    ) +
    ' ' +
    escapeHtml(
      pluralMessage(offerSuppliers.size, { one: 'от {n} магазин', other: 'от {n} магазина' }),
    ) +
    range +
    '</p>' +
    spread +
    '</div>' +
    verdictHtml(best, priced, dearest) +
    '<table class="w-full table-fixed text-left"><colgroup>' +
    columns +
    '</colgroup>' +
    '<thead><tr class="border-b border-white/8 text-[10px] uppercase tracking-wide text-slate-500 [&>th]:whitespace-nowrap">' +
    '<th class="py-2.5 pl-5 pr-3 font-semibold">Артикул</th>' +
    '<th class="px-3 py-2.5 font-semibold">Магазин</th>' +
    (anyDiscount ? '<th class="px-3 py-2.5 text-right font-semibold">Етикет</th>' : '') +
    '<th class="px-3 py-2.5 text-right font-semibold">Вие плащате</th>' +
    '<th class="px-3 py-2.5 text-right font-semibold">Надплащате</th>' +
    '<th class="py-2.5 pl-3 pr-5 font-semibold">Наличност</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table>' +
    // What the search cost and how it was decided. Kept, because it is true
    // and an operator asks for it; folded away, because a buyer placing an
    // order has no use for a model's name.
    detailsHtml(matching) +
    '</div>';

  bindFacets(allHits, query, matching, verdict);
  bindWiden();
  bindRefreshSearch();
}

/**
 * The search, explained to whoever asks.
 *
 * Everything that used to sit in the results header — how many pairs
 * arithmetic settled, which model was consulted, what it cost, where the
 * seconds went. None of it is a buyer's question, and putting it beside the
 * price made the screen read like a console.
 */
function detailsHtml(matching) {
  if (!matching) return '';

  const summary = matchingSummaryHtml(matching);
  const timings = matching.timings;

  const timing = timings
    ? '<p class="mt-1.5 text-[11px] text-slate-600">' +
      'доставчици ' + Math.round(timings.retrieval) + ' ms · ' +
      'разчитане ' + Math.round(timings.parse) + ' ms · ' +
      'съпоставяне ' + Math.round(timings.matching) + ' ms' +
      (timings.ai > 0 ? ' · AI ' + Math.round(timings.ai) + ' ms' : ' · без AI') +
      '</p>'
    : '';

  if (!summary && !timing) return '';

  return (
    '<details class="border-t border-white/8 px-4 py-2.5">' +
    '<summary class="cursor-pointer list-none text-[11px] text-slate-600 transition hover:text-slate-400">' +
    'Как е намерено' +
    '</summary>' +
    '<div class="pt-2">' + summary + timing + '</div>' +
    '</details>'
  );
}

/**
 * "iphnoe 15" — offered, never applied.
 *
 * The search still runs on what was typed: a wholesale catalogue is full
 * of strings that look like typos and are article codes, and silently
 * correcting one hides the thing somebody was looking for.
 */
function renderDidYouMean(matching, query) {
  const suggestion = matching && matching.understood && matching.understood.didYouMean;
  if (!suggestion || suggestion === query.toLowerCase()) return;

  const box = document.createElement('div');
  box.className = 'mt-3 text-[11.5px] text-slate-400';
  box.innerHTML =
    'Имахте предвид <button type="button" class="font-semibold text-accent-500 underline underline-offset-2">' +
    escapeHtml(suggestion) +
    '</button>?';

  box.querySelector('button').addEventListener('click', function () {
    $('#catalogue-query').value = suggestion;
    void searchCatalogue();
  });

  $('#catalogue-results').prepend(box);
}

/**
 * The search, narrated.
 *
 * The old version showed one spinner for up to eight seconds, which is
 * indistinguishable from a hang and hides the most persuasive thing this
 * product does. The work is genuinely staged — the query is understood
 * instantly, suppliers answer one at a time, matching runs last — so the
 * stages are shown as they land, with real numbers rather than a
 * pretence of progress.
 */
function renderUnderstood(understood, shops) {
  const chips = [];

  // What kind of thing, first: it is what the reader checks before anything
  // else, and it is now whatever noun they typed rather than one of eight
  // categories somebody compiled in advance.
  if (understood.productType || understood.category) {
    chips.push(['Вид', understood.productType || understood.category]);
  }
  if (understood.brand) chips.push(['Марка', understood.brand]);

  // The attributes are dynamic. A laptop query shows memory and storage, a
  // pipe query shows a bore and a length, and neither of them is listed
  // anywhere in this file — the payload carries its own labels, and the map
  // below is only a Bulgarian name for the keys we happen to know.
  const attributes = understood.attributes || {};
  Object.keys(attributes).forEach(function (key) {
    const attribute = attributes[key];
    if (!attribute || attribute.role === 'descriptive') return;
    chips.push([attributeLabel(key, attribute.label), attribute.value]);
  });

  // Older payloads, and anything the engine could not name.
  if (chips.length <= 2) {
    (understood.measurements || []).forEach(function (m) {
      chips.push([attributeLabel(m.unit), m.value + m.unit]);
    });
    Object.keys(understood.specs || {}).forEach(function (key) {
      chips.push([attributeLabel(key), understood.specs[key]]);
    });
  }

  ((understood.identifiers || {}).modelCodes || []).slice(0, 2).forEach(function (code) {
    chips.push(['Модел', code]);
  });

  // How many they want is not what the article is, and showing it apart from
  // the specification is how the reader learns we know the difference.
  const wanted =
    understood.requestedQuantity && understood.requestedQuantity > 1
      ? '<span class="ml-auto font-normal normal-case text-slate-500">× ' +
        escapeHtml(String(understood.requestedQuantity)) +
        '</span>'
      : '<span class="ml-auto font-normal normal-case text-slate-500">' +
        shops + ' ' + plural(shops, 'доставчик', 'доставчици') + '</span>';

  return (
    '<div class="overflow-hidden rounded-xl border border-accent-500/25 bg-accent-500/[0.05]">' +
    '<div class="flex items-center gap-2 border-b border-accent-500/15 px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wide text-accent-600 dark:text-accent-400">' +
    '<i class="fa-solid fa-wand-magic-sparkles text-[11px]"></i>Разчетох заявката' +
    wanted +
    '</div>' +
    '<div class="px-4 py-2.5">' +
    (chips.length
      ? '<div class="flex flex-wrap gap-1.5">' +
        chips
          .map(
            ([label, value], index) =>
              // Staggered so the attributes appear one after another — the
              // reading is instant, and showing it instantly makes it look
              // like a static label rather than something worked out.
              '<span class="chip-in rounded-md bg-ink-900 px-2 py-1 text-[11px] text-slate-300 ring-1 ring-white/8" style="animation-delay:' +
              index * 70 +
              'ms">' +
              '<span class="text-slate-500">' + escapeHtml(label) + ':</span> ' +
              escapeHtml(String(value)) +
              '</span>',
          )
          .join('') +
        '</div>'
      : '<p class="text-[11.5px] text-slate-400">Търся по описание — добавете мощност, размер или модел за по-точно сравнение.</p>') +
    '<div id="stream-shops" class="mt-3 space-y-1"></div>' +
    '<div id="stream-stage" class="mt-3"></div>' +
    '</div></div>'
  );
}

/**
 * The line that says what is happening now.
 *
 * Given its own renderer because the AI step is the one people are
 * curious about and it is over in a second or two — long enough to be
 * missed if it looks like every other line, which is why it gets a
 * pulsing mark, its own colour and the model's name.
 */
function renderStage(stage) {
  const box = document.getElementById('stream-stage');
  if (!box) return;

  if (stage.kind === 'ai') {
    box.innerHTML =
      '<div class="flex items-center gap-2.5 rounded-xl border border-accent-500/30 bg-accent-500/10 px-3 py-2.5">' +
      '<span class="relative flex h-2 w-2">' +
      '<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500 opacity-75"></span>' +
      '<span class="relative inline-flex h-2 w-2 rounded-full bg-accent-500"></span>' +
      '</span>' +
      '<span class="text-[11.5px] text-slate-200">' +
      '<strong class="font-semibold">AI проверява</strong> ' +
      stage.count + ' ' + plural(stage.count, 'резултат', 'резултата') +
      ', които спецификациите не решават' +
      '</span>' +
      '<span class="ml-auto font-mono text-[11px] text-slate-500">' + escapeHtml(stage.model || '') + '</span>' +
      '</div>';
    return;
  }

  box.innerHTML =
    '<div class="flex items-center gap-2.5 text-[11.5px] text-slate-400">' +
    '<i class="fa-solid fa-circle-notch fa-spin text-[11px] text-slate-500"></i>' +
    escapeHtml(stage.text) +
    '</div>';
}

/**
 * Bulgarian names for the attribute keys we happen to recognise.
 *
 * A fallback, not a registry. Every attribute in the payload carries its own
 * label, and one this map has never heard of renders under the name the
 * engine gave it rather than disappearing — which is what lets a trade nobody
 * has written a row for still get a readable search.
 */
const ATTRIBUTE_LABELS = {
  ram: 'Памет (RAM)', storage: 'Диск', capacity: 'Обем', battery: 'Батерия',
  length: 'Дължина', width: 'Ширина', height: 'Височина', depth: 'Дълбочина',
  diameter: 'Диаметър', thickness: 'Дебелина', cross_section: 'Сечение',
  dimensions: 'Размери', screen: 'Екран', power: 'Мощност', voltage: 'Напрежение',
  current: 'Ток', colour_temperature: 'Цветна температура', luminous_flux: 'Светлинен поток',
  frequency: 'Честота', refresh_rate: 'Опресняване', cpu: 'Процесор', pressure: 'Налягане',
  torque: 'Въртящ момент', rotation: 'Обороти', weight: 'Тегло', grammage: 'Грамаж',
  temperature_rating: 'Температура', package_quantity: 'Опаковка', warranty: 'Гаранция',
  model_year: 'Година', socket: 'Фасунга', connector: 'Конектор', protection: 'Защита',
  thread: 'Резба', paper_format: 'Формат', resolution: 'Резолюция', efficiency: 'Клас',
  breaker_curve: 'Характеристика', standard: 'Стандарт', colour: 'Цвят', material: 'Материал',
  position: 'Позиция', brand: 'Марка', type: 'Вид', family: 'Серия', model: 'Модел',
  curve: 'Характеристика', data: 'Памет', volume: 'Обем', mass: 'Тегло', count: 'Брой',
  W: 'Мощност', K: 'Цвят', V: 'Напрежение', A: 'Ток', GB: 'Памет', TB: 'Памет',
  IN: 'Размер', M: 'Дължина', MM2: 'Сечение', HZ: 'Честота', LM: 'Поток',
};

/**
 * The name for an attribute key, whichever way it arrived.
 *
 * A listing stating two lengths sends them as `length` and `length_2`, and
 * looking the second one up verbatim found nothing and printed the engine's
 * English fallback next to the Bulgarian first one.
 */
function attributeLabel(key, fallback) {
  return (
    ATTRIBUTE_LABELS[key] ||
    ATTRIBUTE_LABELS[String(key).replace(/_\d+$/, '')] ||
    fallback ||
    key
  );
}

/**
 * What each relation is called on a badge.
 *
 * The distinction a percentage could never carry: the same article, another
 * size of the same article, something that merely fits, and something ruled
 * out on a specification the buyer stated.
 */
const WEAK_GROUP_HEADINGS = {
  same_family: 'Друг вариант на същия артикул',
  same_type: 'Подобни артикули',
  compatible: 'Съвместими',
  conflict: 'Различна спецификация',
  possible: 'Може да не е същият артикул',
  unrelated: 'Върнато по подобие от магазина',
};

const WEAK_GROUP_NOTES = {
  same_family: 'същата серия, друга големина или цвят',
  same_type: 'същият вид, друг производител',
  compatible: 'не е същият артикул, но пасва на търсеното',
  conflict: 'нещо, което поискахте, е различно',
  possible: 'показани, но извън сравнението на цените',
  unrelated: 'търсачката на магазина беше щедра',
};

const RELATION_LABELS = {
  same_product: 'съвпада',
  same_family: 'друг вариант',
  same_type: 'подобен',
  compatible: 'съвместим',
  possible: 'вероятно',
  conflict: 'различен',
  unrelated: 'слабо',
};

/* ------------------------------------------------------------------ *
 * The search, for somebody who has not signed up yet
 *
 * The landing page invites a visitor to "see it search", and the search is
 * scoped to an account: it asks *your* suppliers and ranks by *your*
 * negotiated discount. An anonymous caller has no suppliers, so the endpoint
 * answered 401 and the second button on the front page led to a screen with
 * three error messages on it. That is the worst possible first click.
 *
 * So a visitor gets a scripted search over a sample catalogue instead. It is
 * replayed through `handleSearchEvent`, the same function the real stream
 * feeds, which matters more than it looks: a second renderer would drift from
 * the first within a month, and this way the demo cannot show a layout the
 * product does not actually produce. The staging is kept too — the query is
 * read, suppliers answer one by one, matching runs last — because that
 * sequence is the most persuasive thing here and a demo that skips to the
 * answer throws it away.
 *
 * Every price below is invented, and the panel says so.
 * ------------------------------------------------------------------ */

const DEMO_SHOPS = [
  { host: 'electro-sklad.example', name: 'Електро Склад', discount: 12 },
  { host: 'kabel-pro.example', name: 'Кабел Про', discount: 8 },
  { host: 'tehno-depo.example', name: 'Техно Депо', discount: 0 },
  { host: 'svetlina.example', name: 'Светлина Трейд', discount: 5 },
];

/**
 * What the sample catalogue contains.
 *
 * Two articles, because two is enough to show the thing that matters: the
 * same article named four different ways, ranked by what you pay rather than
 * what the label says. `keywords` are matched after the same homoglyph and
 * borrowed-term folding the real matcher uses, so "лед" finds the LED bulb.
 */
const DEMO_CATALOGUE = [
  {
    // Every language the interface offers, because a Greek visitor types
    // "λάμπα" and a Romanian one "bec" — and being told the sample catalogue
    // has nothing is the demo failing at the one thing it exists for.
    keywords: ['крушка', 'лампа', 'led', 'лед', 'e27', 'bulb', 'lamp', 'bec', 'λάμπα', 'λαμπα', 'λαμπτήρας'],
    groupKey: 'bulb-12w',
    groupLabel: 'LED крушка E27 12W 4000K',
    understood: {
      // Shaped exactly like the real payload, dynamic attributes and all, so
      // the demo cannot show a reading the product does not actually produce.
      productType: 'крушка',
      category: 'bulb',
      attributes: {
        socket: { value: 'E27', role: 'identity', label: 'Socket' },
        power: { value: '12 W', role: 'identity', label: 'Power' },
        colour_temperature: { value: '4000 K', role: 'identity', label: 'Colour temperature' },
      },
      measurements: [
        { unit: 'W', value: 12 },
        { unit: 'K', value: 4000 },
      ],
      specs: { socket: 'E27' },
    },
    offers: [
      {
        shop: 'svetlina.example', price: 2.29,
        title: 'LED лампа E27 12W 4000K неутрална светлина',
        band: 'certain', confidence: 0.97,
        explanation: 'Мощност, фасунга и цветна температура съвпадат.',
        reasons: [
          { agrees: true, label: 'Мощност', left: '12W', right: '12W' },
          { agrees: true, label: 'Фасунга', left: 'E27', right: 'E27' },
          { agrees: true, label: 'Цветна температура', left: '4000K', right: '4000K' },
        ],
      },
      {
        shop: 'electro-sklad.example', price: 2.63,
        title: 'Крушка LED 12W E27 840 матирана',
        band: 'high', confidence: 0.91,
        explanation: '„840“ е записът на производителя за 4000K.',
        reasons: [
          { agrees: true, label: 'Мощност', left: '12W', right: '12W' },
          { agrees: true, label: 'Фасунга', left: 'E27', right: 'E27' },
          { agrees: true, label: 'Цветна температура', left: '4000K', right: '840' },
        ],
      },
      {
        shop: 'tehno-depo.example', price: 2.45,
        title: 'LED bulb E27 12W neutralweiss',
        band: 'high', confidence: 0.89,
        explanation: '„neutralweiss“ означава 4000K.',
        reasons: [
          { agrees: true, label: 'Мощност', left: '12W', right: '12W' },
          { agrees: true, label: 'Цветна температура', left: '4000K', right: 'neutralweiss' },
        ],
      },
      {
        shop: 'kabel-pro.example', price: 6.90,
        title: 'Стойка за лампа Philips E27',
        band: 'weak', relation: 'same_type', confidence: 0.42,
        explanation: 'Аксесоар, не самата лампа.',
        reasons: [{ agrees: false, label: 'Вид: стойка, не крушка' }],
      },
    ],
  },
  {
    keywords: ['кабел', 'свт', 'cable', 'провод', 'жило', 'cablu', 'myym', 'καλώδιο', 'καλωδιο', 'nym'],
    groupKey: 'cable-3x25',
    groupLabel: 'Кабел СВТ 3x2.5 мм²',
    understood: {
      productType: 'кабел',
      category: 'cable',
      attributes: {
        cross_section: { value: '3X2.5', role: 'identity', label: 'Cross-section' },
      },
      measurements: [{ unit: 'MM2', value: 2.5 }],
      specs: { cross_section: '3x2.5' },
    },
    offers: [
      {
        shop: 'electro-sklad.example', price: 4.68,
        title: 'Кабел СВТ 3x2.5 мм² бял',
        band: 'certain', confidence: 0.96,
        explanation: 'Сечението и броят жила съвпадат.',
        reasons: [{ agrees: true, label: 'Сечение', left: '3x2.5', right: '3x2.5' }],
      },
      {
        shop: 'kabel-pro.example', price: 4.73,
        title: 'ПВВ-МБ1 3х2,5 (СВТ) кабел',
        band: 'high', confidence: 0.9,
        explanation: 'Същото сечение, друго търговско име.',
        reasons: [{ agrees: true, label: 'Сечение', left: '3x2.5', right: '3х2,5' }],
      },
      {
        shop: 'tehno-depo.example', price: 4.6,
        title: 'Кабел СВТ 3x2.5 — руло 100 м',
        band: 'possible', confidence: 0.78,
        explanation: 'Руло, не метър — цената не е сравнима директно.',
        reasons: [{ agrees: false, label: 'Количество: руло 100 м' }],
      },
      {
        shop: 'svetlina.example', price: 5.12,
        title: 'Кабел СВТ 3x1.5 мм²',
        band: 'weak', relation: 'conflict', confidence: 0.35,
        explanation: 'Различно сечение — 3x1.5 не е 3x2.5.',
        reasons: [{ agrees: false, label: 'Сечение', left: '3x2.5', right: '3x1.5' }],
      },
    ],
  },
];

/** Folds the query the way the real matcher does before comparing keywords. */
function demoNormalise(text) {
  const aliases = { лед: 'led', олед: 'oled', тв: 'tv' };
  return String(text || '')
    .toLowerCase()
    // Greek accents and the final sigma are the same letters to a buyer:
    // "λάμπα" and "λαμπα" must both find the lamp.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ς/g, 'σ')
    .replace(/[\p{L}]+/gu, (word) => aliases[word] || word);
}

function demoEntryFor(query) {
  const folded = demoNormalise(query);
  // Both sides folded, so an accented keyword in the list still matches a
  // query typed without accents, and the other way round.
  return (
    DEMO_CATALOGUE.find((entry) =>
      entry.keywords.some((word) => folded.indexOf(demoNormalise(word)) !== -1),
    ) || null
  );
}

/** Turns one scripted offer into the shape `renderCatalogueResults` expects. */
function demoHit(entry, offer) {
  const shop = DEMO_SHOPS.find((candidate) => candidate.host === offer.shop);
  const effective = Number((offer.price * (1 - shop.discount / 100)).toFixed(2));

  return {
    host: shop.host,
    shopName: shop.name,
    // `name`, not `title`, and `listedPrice`, not `price`: these are the
    // field names the real payload uses, and the demo is fed to the real
    // renderer. Getting them wrong is silent — the row simply comes out
    // blank — so they are worth stating rather than guessing.
    name: offer.title,
    url: '',
    listedPrice: offer.price,
    listedCurrency: 'EUR',
    effectivePrice: effective,
    effectiveCurrency: 'EUR',
    discountPercent: shop.discount,
    inStock: true,
    matched: true,
    priceSource: 'live',
    recordedAt: null,
    groupKey: entry.groupKey,
    groupLabel: entry.groupLabel,
    match: {
      band: offer.band,
      // The relation the real engine would have reached: the demo feeds the
      // real renderer, and a badge that reads "съвпада" for everything would
      // hide the distinction the product is being demonstrated for.
      relation: offer.relation || (offer.confidence >= 0.85 ? 'same_product' : 'possible'),
      group: offer.confidence >= 0.85 ? 'strong' : 'possible',
      confidence: offer.confidence,
      explanation: offer.explanation,
      reasons: offer.reasons,
      matchedAttributes: [],
      missingAttributes: [],
      conflicts: [],
      attributes: {},
    },
  };
}

const pause = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Replays a search for a visitor with no account.
 *
 * Paced rather than instant, for the same reason the real one streams: the
 * staging is the demonstration. The delays are short enough not to feel like
 * a hang and long enough for each step to be read.
 */
async function runDemoSearch(query, signal) {
  const entry = demoEntryFor(query);
  const results = $('#catalogue-results');

  // The demo is staged with timers rather than requests, so there is no socket
  // to close — but stop must still stop it. Checked between stages, which is
  // exactly where the real search checks its own signal.
  const stopped = function () {
    if (!signal || !signal.aborted) return false;
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };

  if (!entry) {
    $('#live-results').innerHTML = '';
    results.innerHTML =
      '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-6 text-center shadow-panel">' +
      '<i class="fa-solid fa-flask mb-3 block text-[17px] text-slate-700"></i>' +
      '<p class="text-[12.5px] text-slate-400">' +
      translate('Примерният каталог съдържа само крушки и кабели.') +
      '</p><p class="mt-1.5 text-[11.5px] text-slate-500">' +
      translate('Влезте, за да търсите при вашите доставчици — там е целият им асортимент.') +
      '</p>' +
      '<button type="button" data-signup class="mt-4 inline-flex items-center gap-2 rounded-xl bg-accent-500 px-3.5 py-2.5 text-[12.5px] font-semibold text-white shadow-glow transition hover:bg-accent-600">' +
      translate('Започни 7 дни безплатно') +
      '</button></div>';
    return;
  }

  stopped();
  handleSearchEvent({ type: 'understood', understood: entry.understood, shops: DEMO_SHOPS.length }, query);

  for (const shop of DEMO_SHOPS) {
    await pause(260 + Math.random() * 220);
    stopped();
    const count = entry.offers.filter((offer) => offer.shop === shop.host).length;
    handleSearchEvent(
      { type: 'shop', name: shop.name, ok: true, count: count, durationMs: 700 + Math.random() * 900 },
      query,
    );
  }

  await pause(320);
  stopped();
  handleSearchEvent({ type: 'matching', candidates: entry.offers.length }, query);

  await pause(520);
  stopped();
  handleSearchEvent({ type: 'ai', comparisons: 2, model: 'claude' }, query);

  await pause(240);
  stopped();
  handleSearchEvent(
    {
      type: 'result',
      hits: entry.offers.map((offer) => demoHit(entry, offer)),
      matching: { used: true, comparisons: 2 },
      durationMs: 3400,
      shops: DEMO_SHOPS.map((shop) => ({
        name: shop.name,
        ok: true,
        count: entry.offers.filter((offer) => offer.shop === shop.host).length,
      })),
    },
    query,
  );

  demoNotice($('#catalogue-results'));
}

/** Says plainly that what is on screen is invented. */
function demoNotice(container) {
  const note = document.createElement('p');
  note.className = 'mt-3 text-center text-[11.5px] text-slate-500';
  note.textContent = translate(
    'Примерни данни и измислени доставчици. Влезте, за да питате вашите.',
  );
  container.appendChild(note);
}

/* --- Buttons that wait -------------------------------------------- *
 *
 * A search takes seconds, and for those seconds the button that started it
 * used to look exactly like a button that had not been pressed. So people
 * pressed it again. Every press opened another fan-out to every supplier —
 * four more requests, four more rate-limiter queues — and the answers came
 * back interleaved, so the screen showed whichever search finished last
 * rather than the one the reader was waiting for.
 *
 * A button that starts something you cannot stop is a button that will be
 * pressed twice. So it becomes the way to stop it:
 *
 *     Търси  →  Спри  →  Търси
 *
 * The second press aborts the work in flight — genuinely, through an
 * AbortController the workers are handed — and puts the button back. Nothing
 * queues, nothing overlaps, and the screen never shows the wrong search.
 */

/** What is running, keyed by the button that started it. */
const running = new WeakMap();

/**
 * Makes one button start-and-stop.
 *
 * @param button   the control that was pressed
 * @param worker   receives an AbortSignal; may be async
 * @param busyText what the button says while the work runs
 */
function startable(button, worker, busyText) {
  if (!button) return Promise.resolve();

  const inFlight = running.get(button);

  // Pressed while running: that is the stop, not a second start.
  if (inFlight) {
    inFlight.abort();
    return Promise.resolve();
  }

  const controller = new AbortController();
  running.set(button, controller);

  const label = button.querySelector('[data-label]');
  const idle = label ? label.textContent : '';
  if (label) label.textContent = translate(busyText || 'Спри');

  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');

  const release = function () {
    running.delete(button);
    if (label) label.textContent = idle;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
  };

  return Promise.resolve()
    .then(() => worker(controller.signal))
    .catch(function (error) {
      // A stop is not a failure. The reader asked for it.
      if (!wasAborted(error)) throw error;
    })
    .finally(release);
}

/** True when this button is mid-flight. */
function isRunning(button) {
  return Boolean(button && running.get(button));
}

/** Whether a rejection is somebody having pressed stop. */
function wasAborted(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 20);
}

/** Where the next search will look. */
function searchScope() {
  const chosen = document.querySelector('input[name="catalogue-scope"]:checked');
  return chosen ? chosen.value : 'my_suppliers';
}

/** Moves the scope, for the button that widens a search that found nothing. */
function setSearchScope(scope) {
  const radio = document.querySelector(
    'input[name="catalogue-scope"][value="' + scope + '"]',
  );
  if (radio) radio.checked = true;
}

async function searchCatalogue(signal) {
  const raw = $('#catalogue-query').value;
  const query = raw.trim();
  const results = $('#catalogue-results');
  const live = $('#live-results');

  if (query.length < 2) {
    results.innerHTML = '<p class="text-[12.5px] text-amber-400">Въведете поне 2 знака.</p>';
    return;
  }

  results.innerHTML = '';
  live.innerHTML = '';
  $('#basket-results').innerHTML = '';
  aiShownUntil = 0;
  // The address bar points at the previous answer until this one has been
  // written down. Leaving it there would make a reload mid-search restore the
  // search before this one, which is a confusing way to lose your place.
  forgetSearch();

  // One article or a whole order — the same box, the same button, and the
  // difference worked out here rather than asked of the buyer. It used to be
  // two inputs behind a toggle, and a person pricing three cables had to
  // decide which of them their question belonged in before they could ask it.
  if (parseBasketLines(raw).length > 1) {
    await priceBasket(raw, signal);
    return;
  }

  $('#catalogue-spinner').classList.remove('hidden');

  // Nobody signed in means no suppliers to ask, so there is nothing for the
  // real endpoint to answer. The visitor came from a button that promised to
  // show them a search; they get one.
  if (!isIdentified()) {
    try {
      await runDemoSearch(query, signal);
    } catch (error) {
      if (!wasAborted(error)) throw error;
      live.innerHTML = '';
      results.innerHTML = '<p class="text-[12.5px] text-slate-500">Търсенето е спряно.</p>';
    } finally {
      $('#catalogue-spinner').classList.add('hidden');
    }
    return;
  }

  live.innerHTML =
    '<div class="flex items-center gap-2.5 rounded-xl border border-accent-500/25 bg-accent-500/[0.05] px-4 py-2.5 text-[12.5px] text-slate-300">' +
    '<i class="fa-solid fa-circle-notch fa-spin text-[11.5px] text-accent-400"></i>Разчитам заявката…</div>';

  try {
    const url =
      ENDPOINTS.discoveryCompareStream +
      '?q=' + encodeURIComponent(query) +
      '&scope=' + encodeURIComponent(searchScope()) +
      ($('#catalogue-instock').checked ? '&inStockOnly=true' : '');

    // fetch, not EventSource: the latter cannot send the auth header, and
    // this endpoint is scoped to an account like every other.
    const response = await fetch(url, {
      headers: authHeaders({ Accept: 'text/event-stream' }),
      // Pressing stop closes the connection rather than leaving the suppliers
      // being asked on behalf of somebody who has moved on.
      signal: signal,
    });

    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });

      // Server-sent events are separated by a blank line; anything after
      // the last one is a partial event and stays in the buffer.
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch (error) {
          continue;
        }

        if (handleSearchEvent(event, query)) finished = true;
      }
    }
  } catch (error) {
    live.innerHTML = '';

    // A stop is not a failure, and saying "търсенето не успя" to somebody who
    // pressed стоп is the software arguing with them.
    if (wasAborted(error)) {
      results.innerHTML =
        '<p class="text-[12.5px] text-slate-500">Търсенето е спряно.</p>';
    } else {
      results.innerHTML = failureHtml(error, 'Търсенето не успя');
    }
  } finally {
    $('#catalogue-spinner').classList.add('hidden');
  }
}

/**
 * A failed request, said in words rather than in status codes.
 *
 * "HTTP 401" is a fact about a protocol, not about anything the reader did or
 * can fix. An expired session is the overwhelmingly common cause and has an
 * obvious remedy, so it gets its own sentence and a button.
 */
/**
 * The same translation from status code to sentence, for a toast.
 *
 * "Неуспешно: HTTP 401" tells a buyer nothing they can act on. Which of the
 * handful of things actually went wrong is knowable, and each one has a
 * different next step, so each one gets said.
 */
function failureText(error, prefix) {
  const status = Number(String(error && error.message).replace(/\D+/g, ''));

  if (status === 401 || status === 403) return translate('Сесията е изтекла. Влезте отново.');
  if (status === 429) return translate('Твърде много заявки. Изчакайте минута.');
  if (status === 404) return translate('Това вече не съществува. Опреснете страницата.');
  if (status >= 500) return translate('Проблем при нас. Опитайте пак след малко.');

  // A message from the server rather than a status line: those are written
  // for the person reading them and are better than anything generic here.
  //
  // Translated too. The API answers in Bulgarian — it has no idea which
  // language the browser is in — and because the dictionary is keyed by the
  // Bulgarian string, the same lookup that handles the page handles the
  // server's sentences, with the Bulgarian showing through for any that have
  // not been translated yet.
  const detail = String((error && error.message) || '');
  const useful = detail && !/^HTTP \d+$/.test(detail) ? ' — ' + translate(detail) : '';

  return translate(prefix) + useful;
}

function failureHtml(error, prefix) {
  const status = Number(String(error && error.message).replace(/\D+/g, ''));

  if (status === 401 || status === 403) {
    return (
      '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-8 text-center shadow-panel">' +
      '<p class="text-[12.5px] text-slate-300">' +
      translate('Сесията е изтекла. Влезте отново, за да продължите.') +
      '</p>' +
      '<button type="button" data-signin class="mt-4 inline-flex items-center gap-2 rounded-xl bg-accent-500 px-3.5 py-2.5 text-[12.5px] font-semibold text-white shadow-glow transition hover:bg-accent-600">' +
      translate('Вход') +
      '</button></div>'
    );
  }

  if (status === 429) {
    return (
      '<p class="text-[12.5px] text-amber-400">' +
      translate('Твърде много заявки. Изчакайте минута и опитайте пак.') +
      '</p>'
    );
  }

  return (
    '<p class="text-[12.5px] text-red-400">' +
    escapeHtml(translate(prefix)) +
    '. ' +
    translate('Опитайте пак след малко.') +
    '</p>'
  );
}

/** Until when the AI stage stays on screen, so it is not missed. */
let aiShownUntil = 0;

/** @returns true when the stream is finished. */
function handleSearchEvent(event, query) {
  const live = $('#live-results');

  if (event.type === 'understood') {
    live.innerHTML = renderUnderstood(event.understood, event.shops);
    renderDidYouMean({ understood: event.understood }, query);
    return false;
  }

  if (event.type === 'shop') {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 text-[11.5px]';
    row.innerHTML = event.ok
      ? '<i class="fa-solid fa-check text-[10px] text-emerald-400"></i>' +
        '<span class="text-slate-300">' + escapeHtml(event.name) + '</span>' +
        '<span class="text-slate-500">' + event.count + ' ' + plural(event.count, 'резултат', 'резултата') + '</span>' +
        '<span class="ml-auto num text-slate-600">' + (event.durationMs / 1000).toFixed(1) + ' сек</span>'
      : '<i class="fa-solid fa-xmark text-[10px] text-red-400"></i>' +
        '<span class="text-slate-400">' + escapeHtml(event.name) + '</span>' +
        '<span class="text-slate-600">не отговори</span>';

    const box = document.getElementById('stream-shops');
    if (box) box.appendChild(row);
    return false;
  }

  if (event.type === 'matching') {
    renderStage({
      kind: 'matching',
      text:
        'Сравнявам ' + event.candidates + ' ' + plural(event.candidates, 'резултат', 'резултата') + ' по спецификация…',
    });
    return false;
  }

  if (event.type === 'ai') {
    renderStage({ kind: 'ai', count: event.comparisons, model: event.model });
    // Held on screen briefly even when the answer is already cached: the
    // step people are most curious about must not flash past unread.
    aiShownUntil = Date.now() + 900;
    return false;
  }

  if (event.type === 'result') {
    const wait = Math.max(0, aiShownUntil - Date.now());
    if (wait > 0) {
      const payload = event;
      window.setTimeout(function () {
        renderShopOutcomes(payload);
        renderCatalogueResults(payload.hits, query, payload.matching, payload);
        rememberSearch(payload.searchId);
        void renderSearchHistory();
        void refreshPlanBar();
      }, wait);
      return false;
    }

    renderShopOutcomes(event);
    renderCatalogueResults(event.hits, query, event.matching, event);
    rememberSearch(event.searchId);
    void renderSearchHistory();
    // The search may have just spent from the allowance.
    void refreshPlanBar();
    return false;
  }

  if (event.type === 'error') {
    $('#catalogue-results').innerHTML =
      '<p class="text-[12.5px] text-red-400">' + escapeHtml(event.message) + '</p>';
    return true;
  }

  return event.type === 'done';
}

/* --- Pricing a whole order ---------------------------------------- */

/** "СВТ 3x2.5, 100" -> { query, quantity }. Quantity optional. */
function parseBasketLines(text) {
  return String(text || '')
    .split('\n')
    .map(function (line) {
      const trimmed = line.trim();
      if (!trimmed) return null;

      // The quantity is whatever trails the last comma, when it is a
      // number. A product name may itself contain commas — "ЛАМПА LED
      // 7W,Е27,6400K" — so splitting on the first would eat the article.
      const match = /^(.*?)[,;]\s*([\d.,]+)\s*$/.exec(trimmed);
      if (match && match[1].trim().length >= 2) {
        const quantity = Number(match[2].replace(',', '.'));
        if (Number.isFinite(quantity) && quantity > 0) {
          return { query: match[1].trim(), quantity: quantity };
        }
      }

      return { query: trimmed, quantity: 1 };
    })
    .filter(Boolean)
    .slice(0, 60);
}

async function priceBasket(text, signal) {
  const raw = typeof text === 'string' ? text : $('#catalogue-query').value;
  const lines = parseBasketLines(raw);
  const box = $('#basket-results');

  if (!lines.length) {
    box.innerHTML = '<p class="text-[12.5px] text-amber-400">Напишете поне един артикул.</p>';
    return;
  }

  if (!isIdentified()) {
    box.innerHTML = demoBasketHtml(lines);
    return;
  }

  $('#catalogue-spinner').classList.remove('hidden');
  box.innerHTML =
    '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-8 text-center shadow-panel">' +
    '<i class="fa-solid fa-circle-notch fa-spin mb-3 block text-xl text-accent-400"></i>' +
    '<p class="text-[12.5px] text-slate-400">Питам доставчиците за ' +
    lines.length + ' ' + plural(lines.length, 'артикул', 'артикула') + '…</p>' +
    '<p class="mt-1 text-[11.5px] text-slate-600">Всеки артикул е отделен въпрос към всеки магазин.</p>' +
    '</div>';

  try {
    const response = await fetch(ENDPOINTS.discoveryBasket, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      signal: signal,
      // The raw text, not a parsed list. One parser, on the server, tested —
      // rather than two that agree until the day somebody types a dash.
      body: JSON.stringify(
        Object.assign(
          { text: raw },
          // Omitted rather than sent as null: the endpoint rejects unknown and
          // out-of-range values, and "no limit" is the absence of the field.
          basketMaxSuppliers ? { maxSuppliers: basketMaxSuppliers } : {},
        ),
      ),
    });

    if (!response.ok) throw new Error('HTTP ' + response.status);
    renderBasket(await response.json());
  } catch (error) {
    box.innerHTML = wasAborted(error)
      ? '<p class="text-[12.5px] text-slate-500">Остойностяването е спряно.</p>'
      : failureHtml(error, 'Остойностяването не успя');
  } finally {
    $('#catalogue-spinner').classList.add('hidden');
  }
}

/**
 * The order, priced, for somebody with no suppliers yet.
 *
 * Deliberately not a fake of `renderBasket` — inventing a full supplier
 * breakdown would be a lot of fiction to maintain, and the one number that
 * sells this is the comparison at the top: everything from one supplier
 * against the order split across the cheapest. So that is what it shows,
 * built from the lines the visitor actually typed, and it says it is a
 * sample.
 */
function demoBasketHtml(lines) {
  const count = lines.reduce((total, line) => total + line.quantity, 0);
  // A plausible average line price, so the figures move with what was typed
  // rather than sitting at a constant nobody believes.
  const single = Number((count * 3.9).toFixed(2));
  const split = Number((single * 0.883).toFixed(2));

  return (
    '<div class="grid gap-3 sm:grid-cols-2">' +
    '<div class="rounded-xl border border-white/8 bg-ink-850 px-3.5 py-2.5">' +
    '<p class="text-[11px] uppercase tracking-wide text-slate-500">' +
    translate('Всичко от един доставчик') +
    '</p><p class="num mt-1 text-[17px] font-bold text-slate-200">' +
    single.toFixed(2) +
    ' <span class="text-[12.5px] font-normal text-slate-500">EUR</span></p>' +
    '<p class="mt-0.5 text-[11.5px] text-slate-400">' +
    translate('Електро Склад') +
    '</p></div>' +
    '<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3.5 py-2.5">' +
    '<p class="text-[11px] uppercase tracking-wide text-emerald-400/80">' +
    translate('Разделена по най-евтиния') +
    '</p><p class="num mt-1 text-[17px] font-bold text-emerald-400">' +
    split.toFixed(2) +
    ' <span class="text-[12.5px] font-normal text-emerald-400/70">EUR</span></p>' +
    '<p class="mt-0.5 text-[11.5px] text-slate-400">' +
    translate('Електро Склад') +
    ', ' +
    translate('Кабел Про') +
    '</p></div></div>' +
    '<p class="mt-3 rounded-xl border border-white/8 bg-ink-900 px-3.5 py-3 text-[11.5px] text-slate-400">' +
    translate('Примерна сметка. Влезте, за да остойностите поръчката при вашите доставчици и с вашите отстъпки.') +
    '</p>' +
    '<button type="button" data-signup class="mt-3 inline-flex items-center gap-2 rounded-xl bg-accent-500 px-3.5 py-2.5 text-[12.5px] font-semibold text-white shadow-glow transition hover:bg-accent-600">' +
    translate('Започни 7 дни безплатно') +
    '</button>'
  );
}

/**
 * The plan, as the buyer reads it.
 *
 * Leads with what to do rather than with what things cost. The older
 * per-supplier and per-line tables stay below it — they answer "what does this
 * cost at each supplier", which is a real question, just not the first one.
 */
function planHtml(plan, currency) {
  if (!plan || !plan.best) {
    return (
      '<div class="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-2.5">' +
      '<p class="text-[12.5px] font-semibold text-amber-300">Няма изпълнима поръчка</p>' +
      '<p class="mt-1 text-[11.5px] text-slate-400">' +
      escapeHtml(
        (plan && plan.explanation && plan.explanation.tradeOffs[0]) ||
          'Нито една комбинация от вашите доставчици не може да изпълни тази поръчка.',
      ) +
      '</p>' +
      rejectedHtml(plan) +
      '</div>'
    );
  }

  const best = plan.best;
  const money = (value) =>
    value === null || value === undefined ? '—' : Number(value).toFixed(2);

  // Widths follow the money, not the line count: what is being split is spend.
  const segments = best.suppliers
    .map(function (supplier) {
      const share = best.total > 0 ? (supplier.total / best.total) * 100 : 0;
      return (
        '<div class="flex items-center justify-center overflow-hidden border-r-2 border-ink-950 px-1 text-[11px] font-semibold text-slate-300 last:border-r-0" ' +
        'style="width:' +
        share.toFixed(2) +
        '%" title="' +
        escapeHtml(supplier.name + ' · ' + money(supplier.total) + ' ' + currency) +
        '"><span class="truncate">' +
        escapeHtml(supplier.name) +
        '</span></div>'
      );
    })
    .join('');

  const savingsBox =
    plan.savings !== null && plan.savings > 0
      ? '<div class="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3.5 py-3">' +
        '<div class="flex flex-wrap items-baseline justify-between gap-2">' +
        '<span class="text-[11px] font-semibold uppercase tracking-wide text-emerald-400/80">Спестявате</span>' +
        '<span class="num text-[17px] font-bold text-emerald-400">' +
        money(plan.savings) +
        ' <span class="text-[12.5px] font-normal text-emerald-400/70">' +
        escapeHtml(currency) +
        '</span></span></div>' +
        '<p class="mt-1 text-[11.5px] text-slate-400">срещу ' +
        money(plan.baseline ? plan.baseline.total : null) +
        ' ' +
        escapeHtml(currency) +
        ' от един доставчик' +
        (plan.savingsPercent !== null ? ' · ' + plan.savingsPercent + '%' : '') +
        '</p></div>'
      : plan.savings === null
        ? '<p class="mt-4 rounded-lg bg-ink-850 px-3 py-2 text-[11.5px] text-slate-400">' +
          'Никой доставчик не може да изпълни цялата поръчка сам, така че няма с какво да сравним спестяването.' +
          '</p>'
        : '';

  const suppliers = best.suppliers
    .map(function (supplier) {
      const lines = supplier.lines
        .map(function (line) {
          const stale =
            line.priceSource !== 'live' && line.recordedAt
              ? '<span class="ml-1.5 text-[10px] text-violet-300">· ' +
                escapeHtml(formatRelative(line.recordedAt)) +
                '</span>'
              : '';

          return (
            '<div class="flex items-baseline justify-between gap-3 border-b border-white/[0.05] px-3.5 py-1.5 last:border-b-0">' +
            '<span class="min-w-0 flex-1 truncate text-[11.5px] text-slate-300">' +
            escapeHtml(line.query) +
            '<span class="ml-1.5 text-[11px] text-slate-600">×' +
            line.quantity +
            '</span>' +
            stale +
            '</span>' +
            '<span class="num shrink-0 text-[11.5px] text-slate-200">' +
            money(line.lineTotal) +
            '</span></div>'
          );
        })
        .join('');

      const conditions = []
        .concat(
          supplier.shippingWaived
            ? ['доставката отпада']
            : supplier.shipping > 0
              ? ['доставка ' + money(supplier.shipping) + ' ' + currency]
              : [],
        )
        .concat(supplier.handlingFee > 0 ? ['такса ' + money(supplier.handlingFee)] : [])
        .concat(
          supplier.minOrderValue > 0
            ? ['минимумът от ' + money(supplier.minOrderValue) + ' е покрит']
            : [],
        );

      return (
        '<details class="overflow-hidden rounded-xl border border-white/8 bg-ink-900" open>' +
        '<summary class="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-3.5 py-3">' +
        '<span class="text-[12.5px] font-semibold text-slate-200">' +
        escapeHtml(supplier.name) +
        '<span class="ml-2 text-[11.5px] font-normal text-slate-500">' +
        supplier.linesCovered +
        (supplier.linesCovered === 1 ? ' ред' : ' реда') +
        '</span></span>' +
        '<span class="num text-[13px] font-semibold text-slate-200">' +
        money(supplier.total) +
        ' <span class="text-[11px] font-normal text-slate-500">' +
        escapeHtml(currency) +
        '</span></span></summary>' +
        (conditions.length
          ? '<p class="border-b border-white/[0.05] px-3.5 pb-2 text-[11px] text-slate-500">' +
            escapeHtml(conditions.join(' · ')) +
            '</p>'
          : '') +
        lines +
        '</details>'
      );
    })
    .join('');

  const why = plan.explanation && plan.explanation.whyChosen.length
    ? '<details class="mt-4 overflow-hidden rounded-xl border border-white/8">' +
      '<summary class="cursor-pointer px-3.5 py-2.5 text-[11.5px] font-medium text-slate-400 hover:text-slate-200">Защо това разпределение</summary>' +
      '<div class="border-t border-white/8 px-3.5 py-3">' +
      plan.explanation.whyChosen
        .map(
          (sentence) =>
            '<p class="mb-1.5 text-[11.5px] leading-relaxed text-slate-300 last:mb-0">' +
            escapeHtml(sentence) +
            '</p>',
        )
        .join('') +
      (plan.explanation.tradeOffs.length
        ? '<div class="mt-3 border-t border-white/[0.06] pt-3">' +
          plan.explanation.tradeOffs
            .map(
              (sentence) =>
                '<p class="mb-1 text-[11.5px] leading-relaxed text-slate-500 last:mb-0">' +
                escapeHtml(sentence) +
                '</p>',
            )
            .join('') +
          '</div>'
        : '') +
      '</div></details>'
    : '';

  const alternatives = plan.alternatives && plan.alternatives.length
    ? '<div class="mt-4 overflow-hidden rounded-xl border border-white/8">' +
      '<p class="border-b border-white/8 bg-ink-950/50 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Други варианти</p>' +
      plan.alternatives
        .map(function (alternative) {
          const difference = alternative.total - best.total;
          return (
            '<div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/[0.05] px-3.5 py-2.5 last:border-b-0">' +
            '<span class="text-[11.5px] text-slate-300">' +
            escapeHtml(alternative.label) +
            '<span class="ml-2 text-[11px] text-slate-600">' +
            escapeHtml(alternative.suppliers.map((s) => s.name).join(' + ')) +
            '</span></span>' +
            '<span class="num text-[11.5px] text-slate-400">' +
            money(alternative.total) +
            '<span class="ml-2 text-[11px] ' +
            (difference > 0 ? 'text-slate-600' : 'text-emerald-400') +
            '">' +
            (difference > 0 ? '+' : '') +
            money(difference) +
            '</span></span></div>'
          );
        })
        .join('') +
      '</div>'
    : '';

  const unassigned = plan.unassigned && plan.unassigned.length
    ? '<p class="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11.5px] text-amber-300">' +
      escapeHtml(
        plan.unassigned.length === 1
          ? '1 артикул не беше намерен при никой доставчик: ' + plan.unassigned[0].query
          : plan.unassigned.length +
              ' артикула не бяха намерени при никой доставчик: ' +
              plan.unassigned.map((entry) => entry.query).slice(0, 3).join(', ') +
              (plan.unassigned.length > 3 ? '…' : ''),
      ) +
      '</p>'
    : '';

  return (
    '<div class="rounded-xl border border-white/8 bg-ink-900 p-3.5">' +
    '<p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Откъде да купите</p>' +
    '<div class="mt-3 flex h-10 overflow-hidden rounded-lg bg-ink-850">' +
    segments +
    '</div>' +
    '<div class="mt-4 space-y-1 text-[12.5px]">' +
    '<div class="flex justify-between text-slate-400"><span>Стока</span>' +
    '<span class="num text-slate-300">' +
    money(best.productSubtotal) +
    '</span></div>' +
    (best.shipping > 0
      ? '<div class="flex justify-between text-slate-400"><span>Доставка (' +
        best.suppliersUsed +
        ')</span><span class="num text-slate-300">' +
        money(best.shipping) +
        '</span></div>'
      : '') +
    (best.handlingFee > 0
      ? '<div class="flex justify-between text-slate-400"><span>Такси</span>' +
        '<span class="num text-slate-300">' +
        money(best.handlingFee) +
        '</span></div>'
      : '') +
    '<div class="flex justify-between border-t border-white/8 pt-2 text-[13px] font-semibold text-slate-200">' +
    '<span>Общо</span><span class="num">' +
    money(best.total) +
    ' <span class="text-[11.5px] font-normal text-slate-500">' +
    escapeHtml(currency) +
    '</span></span></div></div>' +
    savingsBox +
    unassigned +
    '</div>' +
    '<div class="mt-4 space-y-3">' +
    suppliers +
    '</div>' +
    why +
    alternatives +
    // The workings, and then the offer to keep them. In that order: a buyer
    // decides whether to trust the number before deciding whether to act on
    // it, and putting the button first asks for the second answer before the
    // first one has been given.
    calculationHtml(lastDecisionDraft && lastDecisionDraft.snapshot) +
    '<div id="keep-plan-holder">' + keepPlanHtml() + '</div>' +
    rejectedHtml(plan)
  );
}

/** Suppliers who could not take part, and why — never silently absent. */
function rejectedHtml(plan) {
  if (!plan || !plan.rejectedSuppliers || !plan.rejectedSuppliers.length) return '';

  return (
    '<div class="mt-4 space-y-1.5">' +
    plan.rejectedSuppliers
      .map(
        (entry) =>
          '<p class="text-[11.5px] text-slate-500">▲ ' + escapeHtml(entry.message) + '</p>',
      )
      .join('') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * MONEY SCREEN  —  STOCLIFY-DESIGN-SPEC.md §3
 *
 * The dashboard's first number, and the rule behind it: it must be a number
 * the product PRODUCED, not one the customer ENTERED. "Articles tracked" is
 * work the customer did; savings is the answer to the only question that
 * decides whether the subscription is renewed.
 *
 * Every figure here comes from stored purchase decisions — immutable
 * snapshots of comparisons the buyer actually chose. Nothing is estimated,
 * nothing is extrapolated, and an account with no decisions gets the checklist
 * from §3.6 rather than a row of zeroes.
 * ------------------------------------------------------------------ */

/** Cached for the session: the dashboard and the savings screen ask the same
 *  two questions, and asking twice per view switch is two round trips to
 *  render the same numbers. */
let moneyScreenCache = null;

async function renderMoneyScreen(options) {
  const holder = $('[data-money-screen]');
  if (!holder) return;

  if (!isIdentified()) {
    holder.hidden = true;
    return;
  }

  holder.hidden = false;

  // A skeleton in the shape of the answer, not a spinner (§12.14). The card is
  // tall and the number inside it is the largest thing on the page, so an
  // unreserved space here moves the whole dashboard when it lands.
  if (!moneyScreenCache || (options && options.force)) {
    holder.innerHTML = moneyScreenSkeleton();
  }

  try {
    if (!moneyScreenCache || (options && options.force)) {
      const [summary, page, account, supplierList] = await Promise.all([
        fetch(ENDPOINTS.purchaseDecisionsSummary, { headers: authHeaders() }).then(okJson),
        fetch(ENDPOINTS.purchaseDecisions + '?limit=8', { headers: authHeaders() }).then(okJson),
        accountOnce(),
        // Asked for rather than read off the `shops` global: that is only
        // populated once the catalogue view has been opened, so a customer
        // landing straight on the dashboard was told to add their first
        // supplier while already having several.
        fetch(ENDPOINTS.shops, { headers: authHeaders() })
          .then((response) => (response.ok ? response.json() : []))
          .catch(() => []),
      ]);

      moneyScreenCache = { summary, page, account, supplierList };
    }

    const { summary, page, account, supplierList } = moneyScreenCache;

    holder.innerHTML =
      summary.allTime.decisions === 0
        ? moneyScreenEmptyHtml(supplierList)
        : moneyScreenHtml(summary, page, account);
  } catch (error) {
    // A dashboard that cannot reach the API says so once, quietly, rather than
    // rendering zeroes that read as "you have saved nothing".
    holder.innerHTML =
      '<div class="card">' +
      '<p class="text-sm text-content-muted">' +
      escapeHtml(failureText(error, translate('Спестяванията не се заредиха'))) +
      '</p></div>';
  }
}

function moneyScreenSkeleton() {
  return (
    '<div class="card" aria-busy="true" aria-live="polite">' +
    '<div class="skeleton skeleton--text" style="width:140px"></div>' +
    '<div class="skeleton skeleton--metric" style="width:220px;height:44px;margin:16px 0"></div>' +
    '<div class="skeleton skeleton--text" style="width:180px"></div>' +
    '</div>' +
    '<div class="mt-4 grid gap-3 sm:grid-cols-3">' +
    '<div class="skeleton skeleton--card"></div>' +
    '<div class="skeleton skeleton--card"></div>' +
    '<div class="skeleton skeleton--card"></div>' +
    '</div>'
  );
}

/**
 * The card that carries the whole argument for the subscription.
 *
 * Realized and potential are kept apart here exactly as they are in the
 * database. The headline is what the account has actually been shown to save;
 * a forecast is never printed in the position where a fact belongs.
 */
function moneyScreenHtml(summary, page, account) {
  const currency = summary.currency;
  const month = summary.month;

  // The honest headline. Where a purchase was confirmed we can say "saved";
  // everywhere else the only truthful word is "avoidable".
  const proven = month.realized > 0;
  const headline = proven ? month.realized : month.potential;
  const headlineLabel = proven
    ? translate('Спестени този месец')
    : translate('Възможни спестявания този месец');

  const roi =
    account && typeof account.planPrice === 'number' && account.planPrice > 0 && headline > 0
      ? translate('Абонаментът ви струва') +
        ' ' +
        money2(account.planPrice) +
        ' ' +
        escapeHtml(account.planCurrency || currency) +
        ' · ' +
        translate('възвръщаемост') +
        ' ' +
        (headline / account.planPrice).toFixed(1) +
        '×'
      : '';

  const tile = (value, label, meta, tone) =>
    '<div class="card card--compact">' +
    '<p class="num text-[17px] font-semibold tracking-num ' +
    (tone === 'caution' ? 'text-caution-text' : 'text-content-primary') +
    '">' +
    escapeHtml(value) +
    '</p>' +
    '<p class="mt-1 text-sm text-content-muted">' +
    escapeHtml(label) +
    '</p>' +
    (meta ? '<p class="mt-0.5 text-xs text-content-faint">' + escapeHtml(meta) + '</p>' : '') +
    '</div>';

  return (
    // The one positive-background element on the page (§3.4).
    '<div class="card card--positive shadow-glow">' +
    '<p class="section-label">' +
    escapeHtml(headlineLabel) +
    '</p>' +
    '<div class="mt-3 flex flex-wrap items-end justify-between gap-3">' +
    '<div>' +
    '<p class="num text-[19px] font-bold tracking-num text-positive-text">' +
    money2(headline) +
    ' <span class="text-md font-normal">' +
    escapeHtml(currency) +
    '</span></p>' +
    '<p class="mt-1 text-sm text-content-muted">' +
    escapeHtml(
      translate('от') +
        ' ' +
        month.decisions +
        ' ' +
        plural(month.decisions, 'оптимизирана поръчка', 'оптимизирани поръчки'),
    ) +
    (proven
      ? ''
      : ' · ' +
        '<span class="text-caution-text">' +
        escapeHtml(translate('още няма потвърдена покупка')) +
        '</span>') +
    '</p>' +
    '</div>' +
    '<button type="button" data-view="savings" class="nav-link btn btn--secondary btn--sm">' +
    escapeHtml(translate('Как е сметнато')) +
    '</button>' +
    '</div>' +
    (roi ? '<p class="mt-4 border-t border-positive-border/40 pt-3 text-sm text-content-muted">' + roi + '</p>' : '') +
    '</div>' +
    // Three tiles. At most one may be caution at a time (§3.3).
    '<div class="mt-4 grid gap-3 sm:grid-cols-3">' +
    tile(
      summary.averageSavingsPercent === null
        ? '—'
        : summary.averageSavingsPercent.toFixed(1) + '%',
      translate('средно спестяване на поръчка'),
      translate('спрямо най-добрия единичен доставчик'),
    ) +
    tile(
      String(summary.allTime.decisions),
      translate('оптимизирани поръчки'),
      summary.splitDecisions +
        ' ' +
        translate('разделени') +
        ' · ' +
        summary.singleSupplierDecisions +
        ' ' +
        translate('при един доставчик'),
    ) +
    tile(
      money2(summary.allTime.realized + summary.allTime.potential) + ' ' + currency,
      translate('спестени общо'),
      money2(summary.allTime.realized) +
        ' ' +
        translate('доказани') +
        ' · ' +
        money2(summary.allTime.potential) +
        ' ' +
        translate('възможни'),
    ) +
    '</div>' +
    recentDecisionsHtml(page, currency)
  );
}

/** The last few decisions, as the dashboard's closing section (§3.2). */
function recentDecisionsHtml(page, currency) {
  if (!page.items.length) return '';

  const rows = page.items
    .slice(0, 5)
    .map(function (decision) {
      const proven = decision.savingsKind === 'realized';
      const saving = proven ? decision.realizedSavings : decision.savings;

      return (
        '<div class="flex flex-wrap items-baseline justify-between gap-3 border-b border-subtle px-4 py-3 last:border-b-0">' +
        '<span class="text-sm text-content-secondary">#' +
        decision.number +
        ' <span class="ml-2 text-xs text-content-faint">' +
        escapeHtml(formatRelative(decision.createdAt)) +
        ' · ' +
        decision.lineCount +
        ' ' +
        plural(decision.lineCount, 'ред', 'реда') +
        '</span></span>' +
        '<span class="flex items-baseline gap-3">' +
        '<span class="num text-sm text-content-muted">' +
        money2(decision.optimisedTotal) +
        ' ' +
        escapeHtml(currency) +
        '</span>' +
        '<span class="num text-sm font-semibold ' +
        (proven ? 'text-positive-text' : 'text-content-secondary') +
        '">' +
        (saving === null ? '—' : '−' + money2(saving)) +
        '</span></span></div>'
      );
    })
    .join('');

  return (
    '<div class="mt-4">' +
    '<div class="mb-3 flex items-baseline justify-between">' +
    '<p class="section-label">' +
    escapeHtml(translate('Последни решения')) +
    '</p>' +
    '<button type="button" data-view="savings" class="nav-link card__action text-sm">' +
    escapeHtml(translate('всички')) +
    ' →</button>' +
    '</div>' +
    '<div class="card card--flush">' +
    rows +
    '</div></div>'
  );
}

/**
 * The empty state, which is the most important screen in onboarding (§3.6).
 *
 * Not a row of zeroes. A zero next to "saved this month" reads as "this
 * product has saved you nothing", when the truth is that it has not been asked
 * yet. The checklist says what to do next, and the closing line turns the first
 * use into a *check* rather than a demo — take your last invoice and compare
 * our answer against what you actually paid.
 */
function moneyScreenEmptyHtml(supplierList) {
  const supplierCount = Array.isArray(supplierList) ? supplierList.length : 0;

  const step = (state, label, action) => {
    const glyph = state === 'done' ? '✓' : state === 'next' ? '▸' : '○';
    const tone =
      state === 'done'
        ? 'text-positive-text'
        : state === 'next'
          ? 'text-content-primary'
          : 'text-content-faint';

    return (
      '<div class="flex items-center gap-3 py-2">' +
      '<span class="' + tone + ' w-4 text-center text-sm">' + glyph + '</span>' +
      '<span class="flex-1 text-base ' + tone + '">' + escapeHtml(label) + '</span>' +
      (action || '') +
      '</div>'
    );
  };

  const cta = (label, view) =>
    '<button type="button" data-view="' + view + '" class="nav-link btn btn--primary btn--sm">' +
    escapeHtml(label) +
    ' →</button>';

  return (
    '<div class="card">' +
    '<h2 class="text-lg font-semibold text-content-primary">' +
    escapeHtml(translate('Още не знаем колко ви спестяваме.')) +
    '</h2>' +
    '<p class="mt-1 text-sm text-content-muted">' +
    escapeHtml(translate('Три стъпки и ще знаем — обикновено 5 минути.')) +
    '</p>' +
    '<div class="mt-3.5 divide-y divide-border-subtle">' +
    step('done', translate('Акаунтът е готов')) +
    step(
      supplierCount >= 1 ? 'done' : 'next',
      translate('Добавете първия си доставчик'),
      supplierCount >= 1 ? '' : cta(translate('Добави'), 'catalogue'),
    ) +
    step(
      supplierCount >= 2 ? 'done' : supplierCount >= 1 ? 'next' : 'todo',
      translate('Добавете още един — с един няма какво да сравняваме'),
      supplierCount === 1 ? cta(translate('Добави'), 'catalogue') : '',
    ) +
    step(
      'todo',
      translate('Остойностете една истинска поръчка'),
      supplierCount >= 2 ? cta(translate('Остойности'), 'catalogue') : '',
    ) +
    '</div>' +
    '<p class="mt-3.5 border-t border-subtle pt-4 text-sm leading-relaxed text-content-muted">' +
    escapeHtml(
      translate(
        'Съвет: вземете последната си фактура. Ще сравним нашия отговор с това, което сте платили — така ще видите точно колко струваме.',
      ),
    ) +
    '</p>' +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * SECTION — savings
 *
 * What the product has been worth, built only from decisions the buyer chose
 * to keep. Nothing here is an estimate of what might have been saved on a
 * comparison somebody ran and walked away from.
 *
 * Potential and realized are shown side by side and never summed. They are
 * different claims — one is what the optimiser said a chosen plan would avoid,
 * the other is what was avoided on a purchase the buyer confirmed happened —
 * and adding them counts the same saving twice, first as a forecast and then
 * as a fact. That sum is how an ROI figure stops surviving contact with
 * somebody's own accounts, which is the one place it will certainly be taken.
 * ------------------------------------------------------------------ */

async function loadSavings() {
  const summaryBox = $('#savings-summary');
  const historyBox = $('#savings-history');
  const roiBox = $('#savings-roi');
  if (!summaryBox) return;

  if (!isIdentified()) {
    summaryBox.innerHTML =
      '<p class="rounded-xl border border-white/8 bg-ink-900 px-3.5 py-3 text-[12.5px] text-slate-400">' +
      translate('Влезте, за да видите спестяванията по вашите решения.') +
      '</p>';
    historyBox.innerHTML = '';
    roiBox.innerHTML = '';
    return;
  }

  const spinner = $('#savings-spinner');
  if (spinner) spinner.classList.remove('hidden');

  try {
    const [summary, page, account] = await Promise.all([
      fetch(ENDPOINTS.purchaseDecisionsSummary, { headers: authHeaders() }).then(okJson),
      fetch(ENDPOINTS.purchaseDecisions + '?limit=25', { headers: authHeaders() }).then(okJson),
      // The plan, for the subscription side of the ROI panel. Allowed to fail
      // on its own: an operator key has no account row, and the savings are
      // still worth showing without a price to set them against.
      accountOnce(),
    ]);

    summaryBox.innerHTML = savingsSummaryHtml(summary);
    roiBox.innerHTML = roiHtml(summary, account);
    historyBox.innerHTML = savingsHistoryHtml(page, summary.currency);
  } catch (error) {
    summaryBox.innerHTML = failureHtml(error, 'Спестяванията не се заредиха');
    historyBox.innerHTML = '';
    roiBox.innerHTML = '';
  } finally {
    if (spinner) spinner.classList.add('hidden');
  }
}

function okJson(response) {
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function savingsSummaryHtml(summary) {
  const currency = summary.currency;
  const withUnit = (value) => money2(value) + ' ' + currency;

  const proven = summary.allTime.realized;
  const possible = summary.allTime.potential;

  /*
   * Two numbers first, five after.
   *
   * This was seven tiles of equal weight, and on a new account all seven read
   * "0.00" — a wall of zeroes that answers no question anybody arrived with.
   * The page exists to answer one: how much has this saved me. That has
   * exactly two halves, and the whole difficulty of the page is that they are
   * easy to confuse — money confirmed against money still on the table — so
   * they are the two things given room, side by side, with the periods
   * demoted to the notes underneath where they belong.
   */
  const headline = (label, value, note, tone) =>
    '<div class="rounded-xl border ' +
    (tone === 'good'
      ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
      : 'border-white/8 bg-ink-900') +
    ' px-4 py-3.5">' +
    '<p class="text-[11px] font-medium uppercase tracking-wide ' +
    (tone === 'good' ? 'text-emerald-400/80' : 'text-slate-500') +
    '">' + escapeHtml(label) + '</p>' +
    '<p class="num mt-1 text-[22px] font-bold ' +
    (tone === 'good' ? 'text-emerald-400' : 'text-slate-200') +
    '">' + escapeHtml(value) + '</p>' +
    '<p class="mt-1 text-[11.5px] text-slate-500">' + escapeHtml(note) + '</p></div>';

  const small = (label, value, note) =>
    '<div class="rounded-lg border border-white/8 bg-ink-900 px-3 py-2">' +
    '<p class="text-[10px] uppercase tracking-wide text-slate-600">' + escapeHtml(label) + '</p>' +
    '<p class="num mt-0.5 text-[14px] font-semibold text-slate-200">' + escapeHtml(value) + '</p>' +
    '<p class="mt-0.5 text-[10.5px] text-slate-600">' + escapeHtml(note) + '</p></div>';

  const period =
    formatMessage('{month} този месец · {year} тази година', {
      month: withUnit(summary.month.potential + summary.month.realized),
      year: withUnit(summary.year.potential + summary.year.realized),
    });

  return (
    '<div class="grid gap-3 sm:grid-cols-2">' +
    headline(
      'Доказано спестено',
      withUnit(proven),
      proven > 0 ? period : translate('още няма потвърдена поръчка'),
      'good',
    ) +
    headline(
      'Възможно спестяване',
      withUnit(possible),
      translate('чака потвърждение на поръчките'),
    ) +
    '</div>' +
    '<div class="mt-3 grid gap-2 sm:grid-cols-3">' +
    small(
      'Оптимизирани поръчки',
      String(summary.allTime.decisions),
      summary.splitDecisions + ' разделени · ' + summary.singleSupplierDecisions + ' при един',
    ) +
    small(
      'Средно спестяване',
      summary.averageSavingsPercent === null ? '—' : summary.averageSavingsPercent.toFixed(1) + '%',
      'спрямо най-добрия единичен доставчик',
    ) +
    small(
      'Средна заявка',
      summary.averageBasketLines === null ? '—' : summary.averageBasketLines.toFixed(1),
      'реда на решение',
    ) +
    '</div>' +
    '<p class="mt-3 text-[11px] leading-relaxed text-slate-500">' +
    escapeHtml(
      translate(
        'Едно решение брои или като доказано, или като възможно — никога и двете. ' +
          'Става доказано, когато всеки доставчик в плана има потвърдена поръчка.',
      ),
    ) +
    '</p>'
  );
}

/**
 * The subscription against what it returned.
 *
 * Shown only when the account's own price is known, and built from the
 * realized figure when there is one. A "value created" line resting on a
 * forecast is a claim the customer can disprove with their own ledger, and one
 * disproved claim costs more than the whole panel is worth — so when nothing
 * has been confirmed yet, this says so instead of quietly using the forecast.
 *
 * The subscription figure and its currency both come from `/billing/me`, so
 * this panel and the pricing page are rendering the same number from the same
 * definition and cannot drift apart.
 */
function roiHtml(summary, account) {
  const price = currentPlanPrice(account);
  if (price === null || price <= 0) return '';

  // The subscription's currency, not the savings' — they are two different
  // amounts and only one of them is priced by us. They agree today, and the
  // label should still name the right one if that ever stops being true.
  const planCurrency = account.planCurrency || summary.currency;
  const realized = summary.year.realized;
  const potential = summary.year.potential;

  if (realized <= 0 && potential <= 0) return '';

  const proven = realized > 0;
  const measured = proven ? realized : potential;

  return (
    '<div class="rounded-xl border border-white/8 bg-ink-900 p-3.5">' +
    '<p class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Какво ви върна Stoclify</p>' +
    '<div class="mt-3 grid gap-3 sm:grid-cols-3">' +
    '<div><p class="text-[11.5px] text-slate-500">Абонамент</p>' +
    '<p class="num mt-0.5 text-xl font-semibold text-slate-300">' +
    money2(price) + ' <span class="text-[11.5px] font-normal text-slate-500">' + escapeHtml(planCurrency) + '</span></p></div>' +
    '<div><p class="text-[11.5px] text-slate-500">' +
    (proven ? 'Доказано спестено' : 'Възможно спестяване') +
    '</p><p class="num mt-0.5 text-xl font-semibold ' +
    (proven ? 'text-emerald-400' : 'text-slate-300') +
    '">' + money2(measured) + '</p></div>' +
    '<div><p class="text-[11.5px] text-slate-500">Разлика</p>' +
    '<p class="num mt-0.5 text-xl font-semibold ' +
    (measured - price >= 0 ? 'text-emerald-400' : 'text-slate-400') +
    '">' + money2(measured - price) + '</p></div>' +
    '</div>' +
    '<p class="mt-3 text-[11px] text-slate-500">' +
    escapeHtml(
      proven
        ? 'Спрямо потвърдени покупки тази година.'
        : 'Никоя поръчка не е отбелязана като потвърдена, затова това е възможно, а не доказано спестяване. ' +
          'Отбележете поръчките си като потвърдени, за да стане доказано.',
    ) +
    '</p></div>'
  );
}

/**
 * The signed-in account's monthly price, straight from the server.
 *
 * There is deliberately no table of prices in this file any more. There used
 * to be one, and it was a second copy of a number that also lived in the
 * pricing page's markup — two places to change, one of them to forget, and the
 * figure it produced sat directly under "you paid X, we saved you Y". A
 * subscription figure that disagrees with the pricing page discredits the
 * saving beside it.
 *
 * `/billing/me` reports `planPrice` from the one server-side definition. Zero
 * (the free plan) and null (a plan this deploy prices nothing for) both mean
 * "there is no subscription to measure against", so both return null and the
 * ROI panel is simply not drawn — rather than dividing by nothing or printing
 * a price nobody is charged.
 */
function currentPlanPrice(account) {
  if (!account || typeof account.planPrice !== 'number') return null;
  return account.planPrice > 0 ? account.planPrice : null;
}

function savingsHistoryHtml(page, currency) {
  if (!page.items.length) {
    return (
      '<p class="rounded-xl border border-white/8 bg-ink-900 px-3.5 py-3 text-[12.5px] text-slate-400">' +
      translate('Още нямате запазени решения. Остойностете поръчка в „Търсене" и изберете плана, който ви устройва.') +
      '</p>'
    );
  }

  const rows = page.items
    .map(function (decision) {
      const proven = decision.savingsKind === 'realized';
      const saving = proven ? decision.realizedSavings : decision.savings;

      return (
        /*
         * The row has to look like it opens.
         *
         * It always did open — and nobody could tell. A `<summary>` set to
         * `display: grid` loses the browser's own disclosure triangle, so the
         * only remaining hint was the cursor, which you have to already be
         * hovering to see. A row of numbers that silently hides the entire
         * calculation behind it is worse than one that hides nothing.
         *
         * So: a chevron that turns when it opens, a hover tint, and the words
         * for what is underneath.
         */
        '<details class="savings-row border-b border-white/[0.05] last:border-b-0">' +
        '<summary class="grid cursor-pointer grid-cols-[14px_1fr_auto] items-baseline gap-2 px-3.5 py-2.5 transition hover:bg-white/[0.03] sm:grid-cols-[14px_1.3fr_1fr_1fr_1fr_1fr]">' +
        '<i class="disclosure fa-solid fa-chevron-right self-center text-[9px] text-slate-600"></i>' +
        '<span class="text-[11.5px] text-slate-400">' +
        escapeHtml(formatAbsolute(decision.createdAt)) +
        '</span>' +
        '<span class="text-[11.5px] text-slate-300">#' + decision.number +
        '<span class="ml-1.5 text-[11px] text-slate-600">' + decision.lineCount + ' ' +
        plural(decision.lineCount, 'ред', 'реда') + '</span></span>' +
        '<span class="num hidden text-[11.5px] text-slate-500 sm:block">' +
        money2(decision.baselineTotal) + '</span>' +
        '<span class="num hidden text-[11.5px] text-slate-300 sm:block">' +
        money2(decision.optimisedTotal) + '</span>' +
        '<span class="num text-right text-[11.5px] font-semibold ' +
        (proven ? 'text-emerald-400' : 'text-slate-300') + '">' +
        money2(saving) +
        '<span class="ml-1.5 text-[10px] font-normal ' +
        (proven ? 'text-emerald-400/70' : 'text-slate-600') + '">' +
        (proven ? 'доказано' : 'възможно') +
        '</span></span></summary>' +
        '<div class="bg-ink-950/40 px-3.5 py-3" data-decision="' + escapeHtml(decision.id) + '">' +
        '<p class="text-[11.5px] text-slate-500">' +
        translate('Зареждам подробностите…') +
        '</p></div></details>'
      );
    })
    .join('');

  return (
    '<p class="mb-2 text-[11.5px] text-slate-500">' +
    '<i class="fa-solid fa-chevron-right mr-1.5 text-[9px] text-slate-600"></i>' +
    escapeHtml(translate('Отворете ред, за да видите сметката: базата, избрания план и разликата ред по ред.')) +
    '</p>' +
    '<div class="overflow-hidden rounded-xl border border-white/8">' +
    '<div class="hidden grid-cols-[14px_1.3fr_1fr_1fr_1fr_1fr] gap-2 border-b border-white/8 bg-ink-950/50 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 sm:grid">' +
    '<span></span><span>Дата</span><span>Решение</span><span>База</span><span>Избрано</span>' +
    '<span class="text-right">Спестено</span></div>' +
    rows +
    '</div>' +
    (page.total > page.items.length
      ? '<p class="mt-2 text-[11px] text-slate-600">' +
        escapeHtml('Показани са последните ' + page.items.length + ' от ' + page.total + '.') +
        '</p>'
      : '')
  );
}

/**
 * Loads one decision's workings the first time its row is opened.
 *
 * Lazily, because a snapshot is a large document and twenty-five of them
 * fetched to draw a list nobody has expanded is a slow screen paid for by
 * nothing. Once loaded it stays: the record does not change, so there is never
 * a reason to fetch it twice.
 */
document.addEventListener('toggle', function (event) {
  const details = event.target;
  if (!details || details.tagName !== 'DETAILS' || !details.open) return;

  const holder = details.querySelector('[data-decision]');
  if (!holder || holder.dataset.loaded) return;

  holder.dataset.loaded = 'yes';

  void fetch(ENDPOINTS.purchaseDecisions + '/' + holder.dataset.decision, {
    headers: authHeaders(),
  })
    .then(okJson)
    .then(function (decision) {
      holder.innerHTML = calculationHtml(decision.snapshot);
      // Opened by default here: the reader has already asked for this row, and
      // making them open a second disclosure to see what they asked for is a
      // click that answers nothing.
      const panel = holder.querySelector('details');
      if (panel) panel.open = true;
    })
    .catch(function (error) {
      holder.dataset.loaded = '';
      holder.innerHTML = failureHtml(error, 'Решението не се зареди');
    });
}, true);

const savingsRefresh = $('#savings-refresh');
if (savingsRefresh) savingsRefresh.addEventListener('click', function () { void loadSavings(); });

/* --- Keeping a plan, and showing your work ------------------------- *
 *
 * Two features that are really one. A buyer will not trust a saving they
 * cannot check, and they will not keep a record they cannot read — so the
 * panel that explains the arithmetic and the button that files it away are
 * built from the same object.
 *
 * That object is the sealed draft the basket returns. It is the whole
 * decision: supplier terms, every price with where and when it was read,
 * every match with what settled it, the plan and everything it beat. Held
 * here until the buyer either keeps it or prices something else.
 */

/** The draft from the last comparison, or null before one has been run. */
let lastDecisionDraft = null;

/** The decision id, once this comparison has been kept. */
let savedDecisionId = null;

const money2 = (value) =>
  value === null || value === undefined ? '—' : Number(value).toFixed(2);

/**
 * "How is this calculated?"
 *
 * Progressive disclosure, and the ordering is the argument. The headline
 * comparison first, because that is the claim. Then the supplier terms, which
 * are the reason two suppliers with the same shelf price are not the same
 * price. Then the lines, where each figure carries where it came from and how
 * old it was. Then the alternatives, which is the part that shows the answer
 * was chosen rather than merely produced.
 *
 * Everything is read from the snapshot, never from today's data. That is the
 * whole point: open this in November and it still shows August's discount
 * beside August's price, because that is what the decision was made on.
 */
function calculationHtml(snapshot) {
  if (!snapshot) return '';

  const currency = snapshot.currency;
  const optimisation = snapshot.optimisation;
  const baseline = optimisation.baseline;

  const row = (label, value, tone) =>
    '<div class="flex items-baseline justify-between gap-3 py-1">' +
    '<span class="text-[11.5px] ' + (tone || 'text-slate-400') + '">' +
    escapeHtml(label) +
    '</span><span class="num text-[11.5px] text-slate-200">' +
    value +
    '</span></div>';

  // --- The claim, and what it is measured against ---
  const comparison =
    '<div class="grid gap-3 sm:grid-cols-2">' +
    '<div class="rounded-xl border border-white/8 bg-ink-850 px-3.5 py-3">' +
    '<p class="text-[11px] uppercase tracking-wide text-slate-500">Един доставчик</p>' +
    '<p class="num mt-1 text-xl font-bold text-slate-300">' +
    (baseline ? money2(baseline.total) : '—') +
    ' <span class="text-[11.5px] font-normal text-slate-500">' + escapeHtml(currency) + '</span></p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">' +
    escapeHtml(
      baseline
        ? baseline.suppliers.map((supplier) => supplier.name).join(', ')
        : 'Никой доставчик не можеше да изпълни цялата поръчка сам',
    ) +
    '</p></div>' +
    '<div class="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-3">' +
    '<p class="text-[11px] uppercase tracking-wide text-emerald-400/80">Избраният план</p>' +
    '<p class="num mt-1 text-xl font-bold text-emerald-400">' +
    money2(optimisation.optimised.total) +
    ' <span class="text-[11.5px] font-normal text-emerald-400/70">' + escapeHtml(currency) + '</span></p>' +
    '<p class="mt-0.5 text-[11px] text-slate-400">' +
    escapeHtml(optimisation.optimised.suppliers.map((supplier) => supplier.name).join(' + ')) +
    '</p></div></div>' +
    (optimisation.savings === null
      ? '<p class="mt-3 rounded-lg bg-ink-850 px-3 py-2 text-[11.5px] text-slate-400">' +
        'Няма база за сравнение: нито един доставчик не можеше да поеме цялата поръчка, ' +
        'а сравняването на разделена поръчка с непълна е сравнение на две различни покупки.' +
        '</p>'
      : '');

  // --- Why two suppliers with the same shelf price are not the same price ---
  const suppliers = snapshot.suppliers
    .map(function (supplier) {
      const conditions = []
        .concat(supplier.discountPercent > 0 ? ['отстъпка ' + supplier.discountPercent + '%'] : [])
        .concat(
          supplier.vatState === 'inclusive'
            ? ['цените с ДДС ' + supplier.vatRate + '%']
            : supplier.vatState === 'exclusive'
              ? ['цените без ДДС']
              : ['ДДС не е посочен'],
        )
        .concat(supplier.shippingCost > 0 ? ['доставка ' + money2(supplier.shippingCost)] : ['без доставка'])
        .concat(
          supplier.freeShippingOver !== null
            ? ['безплатна над ' + money2(supplier.freeShippingOver)]
            : [],
        )
        .concat(supplier.handlingFee > 0 ? ['такса ' + money2(supplier.handlingFee)] : [])
        .concat(supplier.minOrderValue > 0 ? ['минимум ' + money2(supplier.minOrderValue)] : []);

      return (
        '<div class="border-b border-white/[0.05] px-3.5 py-2.5 last:border-b-0">' +
        '<p class="text-[11.5px] font-medium text-slate-300">' +
        escapeHtml(supplier.name) +
        '</p><p class="mt-0.5 text-[11px] text-slate-500">' +
        escapeHtml(conditions.join(' · ')) +
        '</p></div>'
      );
    })
    .join('');

  // --- Every line, with where its price came from and what matched it ---
  const lines = snapshot.lines
    .map(function (line) {
      const checked =
        line.price.source === 'live'
          ? 'проверена в момента на решението'
          : line.price.recordedAt
            ? 'проверена ' + formatAbsolute(line.price.recordedAt)
            : 'без отбелязана дата';

      const source =
        line.price.source === 'manual'
          ? 'ваша цена'
          : line.price.source === 'cached'
            ? 'от кеша'
            : 'на живо';

      const discount =
        line.discountPercent > 0
          ? ' · от ' + money2(line.listPrice) + ' с ' + line.discountPercent + '% отстъпка'
          : '';

      return (
        '<details class="border-b border-white/[0.05] last:border-b-0">' +
        '<summary class="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 px-3.5 py-2">' +
        '<span class="min-w-0 flex-1 truncate text-[11.5px] text-slate-300">' +
        escapeHtml(line.query) +
        '<span class="ml-1.5 text-[11px] text-slate-600">×' + line.quantity + '</span></span>' +
        '<span class="num shrink-0 text-[11.5px] text-slate-200">' +
        money2(line.lineTotal) +
        '</span></summary>' +
        '<div class="bg-ink-950/40 px-3.5 py-2.5">' +
        '<p class="text-[11px] text-slate-400">' +
        escapeHtml(line.supplierName) +
        ' — ' +
        escapeHtml(line.matchedName || line.query) +
        '</p>' +
        (line.url
          ? '<p class="mt-1 truncate text-[11px]"><a class="text-accent-400 hover:text-accent-300" ' +
            'target="_blank" rel="noopener noreferrer nofollow" href="' +
            escapeHtml(line.url) +
            '">' +
            escapeHtml(line.url) +
            '</a></p>'
          : '') +
        '<p class="mt-1 text-[11px] text-slate-500">' +
        escapeHtml(
          money2(line.unitPrice) + ' ' + currency + '/бр' + discount + ' · ' + source + ', ' + checked,
        ) +
        '</p>' +
        '<p class="mt-1 text-[11px] text-slate-500">' +
        escapeHtml(
          'Съвпадение: ' +
            Math.round(line.match.confidence * 100) + '% · ' +
            matchMethodLabel(line.match.method) +
            (line.match.aiUsed && line.match.model ? ' (' + line.match.model + ')' : '') +
            (line.match.explanation ? ' — ' + line.match.explanation : ''),
        ) +
        '</p>' +
        (line.match.attributes && line.match.attributes.length
          ? '<div class="mt-1.5 flex flex-wrap gap-1">' +
            line.match.attributes
              .map(
                (attribute) =>
                  '<span class="rounded px-1.5 py-0.5 text-[10px] ' +
                  (attribute.agrees
                    ? 'bg-emerald-500/10 text-emerald-300/90'
                    : 'bg-amber-500/10 text-amber-300/90') +
                  '">' +
                  escapeHtml(attribute.label + ': ' + attribute.left + ' / ' + attribute.right) +
                  '</span>',
              )
              .join('') +
            '</div>'
          : '') +
        '</div></details>'
      );
    })
    .join('');

  const alternatives = optimisation.alternatives.length
    ? optimisation.alternatives
        .map(
          (alternative) =>
            '<div class="flex items-baseline justify-between gap-3 border-b border-white/[0.05] px-3.5 py-2 last:border-b-0">' +
            '<span class="text-[11.5px] text-slate-400">' +
            escapeHtml(alternative.label + ' — ' + alternative.suppliers.map((s) => s.name).join(' + ')) +
            '</span><span class="num text-[11.5px] text-slate-400">' +
            money2(alternative.total) +
            '</span></div>',
        )
        .join('')
    : '<p class="px-3.5 py-2 text-[11.5px] text-slate-500">Нямаше друг изпълним вариант.</p>';

  const section = (title, body) =>
    '<p class="mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">' +
    escapeHtml(title) +
    '</p><div class="mt-1.5 overflow-hidden rounded-xl border border-white/8">' + body + '</div>';

  return (
    '<details class="mt-4 overflow-hidden rounded-xl border border-white/8">' +
    '<summary class="cursor-pointer px-3.5 py-2.5 text-[11.5px] font-medium text-slate-300 hover:text-slate-100">' +
    'Как е сметнато това?' +
    '</summary>' +
    '<div class="border-t border-white/8 px-3.5 py-2.5">' +
    comparison +
    '<div class="mt-4 rounded-xl border border-white/8 px-3.5 py-2">' +
    row('Стока', money2(optimisation.optimised.productSubtotal)) +
    row(
      'Доставка (' + optimisation.optimised.suppliersUsed + ')',
      money2(optimisation.optimised.shipping),
    ) +
    (optimisation.optimised.handlingFee > 0
      ? row('Такси', money2(optimisation.optimised.handlingFee))
      : '') +
    '<div class="mt-1 flex items-baseline justify-between border-t border-white/8 pt-2">' +
    '<span class="text-[12.5px] font-semibold text-slate-200">Общо</span>' +
    '<span class="num text-[12.5px] font-semibold text-slate-200">' +
    money2(optimisation.optimised.total) +
    ' ' + escapeHtml(currency) + '</span></div></div>' +
    section('Условия на доставчиците, както бяха тогава', suppliers) +
    section('Редовете и откъде идва всяка цена', lines) +
    section('Какво друго беше възможно', alternatives) +
    '<p class="mt-3 text-[11px] leading-relaxed text-slate-600">' +
    escapeHtml(
      'Изчислено на ' +
        formatAbsolute(snapshot.decidedAt) +
        ' за ' +
        (snapshot.durationMs / 1000).toFixed(1) +
        ' с. Разгледани ' +
        optimisation.diagnostics.combinationsEvaluated +
        ' комбинации от ' +
        optimisation.diagnostics.supplierCount +
        ' доставчика' +
        (optimisation.diagnostics.boundedSearch
          ? '. Търсенето беше ограничено — резултатът е най-добрият от опитаните, не задължително най-добрият изобщо.'
          : '.'),
    ) +
    '</p></div></details>'
  );
}

/** What settled a match, in words rather than in the enum's. */
function matchMethodLabel(method) {
  const labels = {
    gtin: 'по баркод',
    sku: 'по артикулен номер',
    model: 'по моделен код',
    attributes: 'по характеристики',
    text: 'по име',
    ai: 'с модел',
    conflict: 'разминаване',
    none: 'без метод',
  };

  return labels[method] || method;
}

/** A date somebody can quote — "28 авг. 2026, 14:31" — rather than "преди 3 дни". */
function formatAbsolute(value) {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  // Absolute rather than relative, deliberately. "Preди 30 дни" is the wrong
  // sentence under an old decision: the buyer needs the moment the price was
  // true, not how long ago that was from wherever they are standing now.
  return date.toLocaleString('bg-BG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The offer to keep this plan.
 *
 * Only offered when there is a plan worth keeping, and it says plainly what
 * pressing it does. Nothing has been stored up to this point — a comparison
 * run to see what an order would cost is not a decision, and filing every one
 * of those away would put plans nobody chose into the savings history.
 */
function keepPlanHtml() {
  if (!lastDecisionDraft) return '';

  if (savedDecisionId) {
    return (
      '<div class="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-3">' +
      '<i class="fa-solid fa-circle-check text-[11.5px] text-emerald-400"></i>' +
      '<span class="text-[11.5px] text-emerald-300">Решението е запазено. Цените в него остават такива, каквито са днес.</span>' +
      '<button type="button" data-view="savings" class="nav-link ml-auto text-[11.5px] font-medium text-emerald-300 underline-offset-2 hover:underline">Виж в „Спестявания"</button>' +
      '</div>'
    );
  }

  return (
    '<div class="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-ink-900 px-3.5 py-3">' +
    '<button type="button" id="keep-plan" class="inline-flex items-center gap-2 rounded-xl bg-accent-500 px-3.5 py-2 text-[12.5px] font-semibold text-ink-950 transition hover:bg-accent-400">' +
    '<i id="keep-plan-spinner" class="fa-solid fa-circle-notch fa-spin hidden text-[11.5px]"></i>' +
    'Използвай този план' +
    '</button>' +
    '<span class="text-[11.5px] text-slate-500">Запазва решението с днешните цени и условия, за да може да бъде проверено и след месеци.</span>' +
    '</div>'
  );
}

/**
 * Files the plan away.
 *
 * Posts the draft back exactly as it arrived. The server checks its own
 * signature before storing anything, so nothing here can change what gets
 * recorded — which is what makes a saving from this record worth quoting.
 */
async function keepPlan() {
  if (!lastDecisionDraft || savedDecisionId) return;

  const button = $('#keep-plan');
  const spinner = $('#keep-plan-spinner');
  if (spinner) spinner.classList.remove('hidden');
  if (button) button.disabled = true;

  try {
    const response = await fetch(ENDPOINTS.purchaseDecisions, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(lastDecisionDraft),
    });

    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new Error((problem && problem.message) || 'HTTP ' + response.status);
    }

    const decision = await response.json();
    savedDecisionId = decision.id;
    // The dashboard's headline just changed. Drop the cache so the next visit
    // reads the new figure rather than the one from before this decision.
    moneyScreenCache = null;

    const holder = $('#keep-plan-holder');
    if (holder) holder.innerHTML = keepPlanHtml();
  } catch (error) {
    const holder = $('#keep-plan-holder');
    if (holder) {
      holder.innerHTML =
        '<p class="mt-4 rounded-xl border border-red-500/25 bg-red-500/[0.06] px-3.5 py-3 text-[11.5px] text-red-300">' +
        escapeHtml(error.message || 'Решението не беше запазено.') +
        '</p>';
    }
  } finally {
    if (spinner) spinner.classList.add('hidden');
    if (button) button.disabled = false;
  }
}

// Delegated, because the button is written into the page after every
// comparison and a listener bound to one instance dies with it.
document.addEventListener('click', function (event) {
  if (event.target.closest('#keep-plan')) void keepPlan();
});

function renderBasket(result) {
  const box = $('#basket-results');

  /**
   * The one constraint worth offering, asked next to the thing it changes.
   *
   * Three deliveries to accept and three invoices to reconcile is often worth
   * more than the €5 the third supplier saves — so this stayed. It moved out
   * of the way of the question: on an empty screen it was a setting nobody
   * could have an opinion about, and beside a plan it is a decision.
   */
  const cap =
    '<label class="ml-auto flex items-center gap-2 text-[11.5px] text-slate-500">' +
    'Максимум доставчици' +
    '<select id="basket-cap" class="rounded-lg border border-white/12 bg-ink-850 px-2 py-1 text-[11.5px] text-slate-200">' +
    ['', '1', '2', '3', '4']
      .map(
        (value) =>
          '<option value="' + value + '"' +
          (String(basketMaxSuppliers || '') === value ? ' selected' : '') +
          '>' + (value || 'без ограничение') + '</option>',
      )
      .join('') +
    '</select></label>';

  // A fresh comparison is a fresh decision. Holding the previous draft would
  // let the buyer file away a plan they are no longer looking at, which is the
  // one way this record could come to disagree with what was on the screen.
  lastDecisionDraft = result.decision || null;
  savedDecisionId = null;
  const money = (value) =>
    value === null || value === undefined ? '—' : Number(value).toFixed(2);

  // The plan leads: it is the only figure here that accounts for delivery,
  // minimum orders and handling together, and the only one that will never
  // recommend an order a supplier would refuse. The per-supplier and per-line
  // tables stay below it — "what does this cost at each supplier" is a real
  // question, just not the first one.
  const plan = planHtml(result.plan, result.currency);

  const complete = result.suppliers.filter(
    (supplier) => supplier.linesCovered === supplier.linesTotal,
  );

  const headline =
    '<div class="mb-3 flex flex-wrap items-center gap-3">' +
    '<p class="text-[12.5px] text-slate-400">' +
    escapeHtml(
      formatMessage('{n} артикула в заявката', { n: result.lines.length }),
    ) +
    '</p>' + cap + '</div>' +
    '<div class="grid gap-3 sm:grid-cols-2">' +
    '<div class="rounded-xl border border-white/8 bg-ink-850 px-3.5 py-2.5">' +
    '<p class="text-[11px] uppercase tracking-wide text-slate-500">Всичко от един доставчик</p>' +
    (complete.length
      ? '<p class="num mt-1 text-[17px] font-bold text-slate-200">' +
        money(complete[0].total) +
        ' <span class="text-[12.5px] font-normal text-slate-500">' +
        escapeHtml(result.currency) +
        '</span></p>' +
        '<p class="mt-0.5 text-[11.5px] text-slate-400">' +
        escapeHtml(complete[0].name) +
        '</p>'
      : '<p class="mt-1 text-[12.5px] text-amber-400">Никой не покрива цялата заявка</p>') +
    '</div>' +
    '<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-3.5 py-2.5">' +
    '<p class="text-[11px] uppercase tracking-wide text-emerald-400/80">Разделена по най-евтиния</p>' +
    '<p class="num mt-1 text-[17px] font-bold text-emerald-400">' +
    money(result.split.total) +
    ' <span class="text-[12.5px] font-normal text-emerald-400/70">' +
    escapeHtml(result.currency) +
    '</span></p>' +
    '<p class="mt-0.5 text-[11.5px] text-slate-400">' +
    escapeHtml(result.split.suppliers.join(', ') || '—') +
    '</p>' +
    '</div></div>' +
    (result.saving !== null && result.saving > 0
      ? '<p class="mt-3 rounded-lg bg-emerald-500/12 px-3 py-2 text-[12.5px] font-semibold text-emerald-400">' +
        'Разделянето спестява ' +
        money(result.saving) +
        ' ' +
        escapeHtml(result.currency) +
        ' на тази поръчка.</p>'
      : '');

  const suppliers = result.suppliers
    .map(function (supplier) {
      const partial = supplier.linesCovered < supplier.linesTotal;

      return (
        '<tr class="border-b border-white/[0.06]">' +
        '<td class="py-2.5 pl-4 pr-3 text-[12.5px] text-slate-200">' +
        escapeHtml(supplier.name) +
        '</td>' +
        '<td class="px-3 py-2.5 text-[11.5px] ' +
        (partial ? 'text-amber-400' : 'text-slate-500') +
        '">' +
        supplier.linesCovered +
        ' от ' +
        supplier.linesTotal +
        (partial
          ? '<span class="block truncate text-[11px] text-slate-500" title="' +
            escapeHtml(supplier.missing.join(', ')) +
            '">липсва: ' +
            escapeHtml(supplier.missing.slice(0, 2).join(', ')) +
            (supplier.missing.length > 2 ? '…' : '') +
            '</span>'
          : '') +
        '</td>' +
        '<td class="num py-2.5 pl-3 pr-4 text-right text-[12.5px] font-semibold ' +
        (partial ? 'text-slate-500' : 'text-slate-200') +
        '">' +
        money(supplier.total) +
        '</td></tr>'
      );
    })
    .join('');

  const rows = result.lines
    .map(function (line) {
      const best = line.cheapest;

      return (
        '<tr class="border-b border-white/[0.06]">' +
        '<td class="py-2 pl-4 pr-3 text-[11.5px] text-slate-300">' +
        escapeHtml(line.query) +
        '<span class="ml-1.5 text-[11px] text-slate-600">×' +
        line.quantity +
        '</span></td>' +
        (best
          ? '<td class="px-3 py-2 text-[11.5px] text-slate-400">' +
            escapeHtml(best.shopName) +
            (best.recordedAt
              ? '<span class="ml-1.5 text-[10px] text-violet-300" title="Ваша цена или запазен отговор — не е четена в момента.">· ' +
                escapeHtml(formatRelative(best.recordedAt)) +
                '</span>'
              : '') +
            '</td>' +
            '<td class="num py-2 pl-3 pr-4 text-right text-[11.5px] text-slate-200">' +
            money(best.effectivePrice * line.quantity) +
            '</td>'
          : '<td class="px-3 py-2 text-[11.5px] text-amber-400">никой не го предлага</td>' +
            '<td class="py-2 pl-3 pr-4 text-right text-[11.5px] text-slate-600">—</td>') +
        '</tr>'
      );
    })
    .join('');

  box.innerHTML =
    plan +
    '<details class="mt-3.5"><summary class="cursor-pointer text-[11.5px] font-medium text-slate-500 hover:text-slate-300">Пълната сметка при всеки доставчик</summary>' +
    '<div class="mt-3">' +
    headline +
    '<div class="mt-3.5 overflow-hidden rounded-xl border border-white/8">' +
    '<p class="border-b border-white/8 bg-ink-950/50 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Цялата поръчка при всеки доставчик</p>' +
    '<table class="w-full text-left"><tbody>' +
    suppliers +
    '</tbody></table></div>' +
    '<div class="mt-4 overflow-hidden rounded-xl border border-white/8">' +
    '<p class="border-b border-white/8 bg-ink-950/50 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Ред по ред, най-евтиното</p>' +
    '<table class="w-full text-left"><tbody>' +
    rows +
    '</tbody></table></div>' +
    '</div></details>' +
    '<p class="mt-3 text-[11px] text-slate-600">Изчислено за ' +
    (result.durationMs / 1000).toFixed(1) +
    ' сек.</p>';

  // Re-plans on change rather than waiting for a button: the suppliers have
  // already been asked, so trying two or three values costs nothing.
  const select = document.getElementById('basket-cap');
  if (select) {
    select.addEventListener('change', function () {
      basketMaxSuppliers = Number(select.value) || null;

      // Through the same button, so a cap changed twice in a second cannot
      // put two pricings of the same order in flight against each other.
      void startable($('#catalogue-search'), (signal) => priceBasket(undefined, signal), 'Спри');
    });
  }
}

/**
 * How many suppliers the buyer is willing to split across.
 *
 * A real constraint rather than a tuning knob — three deliveries to accept and
 * three invoices to reconcile is often worth more than the €5 the third
 * supplier saves — so it stayed. It moved out of the way of the question,
 * though: it is asked *after* a plan exists, next to the plan it changes,
 * where it means something. On an empty screen it was a setting nobody could
 * have an opinion about yet.
 */
let basketMaxSuppliers = null;

$('#table-empty-action').addEventListener('click', function () {
  $('#add-product').click();
});

/**
 * The box grows with what is pasted into it, and says how many articles it
 * read — which is the whole of the multi-product interface.
 */
(function wireSearchBox() {
  const box = $('#catalogue-query');
  const count = $('#catalogue-lines');
  if (!box) return;

  const resize = function () {
    // Counted, not measured.
    //
    // Measuring was the obvious way and it was wrong twice over: a textarea
    // reports nonsense while its section is still hidden, and inside a flex
    // column it reports the height of the space it was given rather than of
    // the text in it. Both failures looked the same — a single line of text
    // floating at the top of a box four lines tall.
    //
    // The box only ever holds short lines, so the number of them is the whole
    // answer, and it needs no layout at all.
    const written = box.value.split('\n').length;
    box.rows = Math.min(8, Math.max(1, written));

    if (!count) return;
    const lines = parseBasketLines(box.value).length;
    count.textContent = lines > 1 ? lines + ' ' + plural(lines, 'артикул', 'артикула') : '';
  };

  box.addEventListener('input', resize);
  window.resizeSearchBox = resize;
  resize();
})();

$('#catalogue-search').addEventListener('click', function () {
  void startable(this, searchCatalogue, 'Спри');
});
$('#catalogue-query').addEventListener('keydown', function (event) {
  // Enter searches; Shift+Enter is a new article. The box takes a list, and a
  // list needs a way to write the second line.
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();

  // Enter while a search is running does nothing. Stopping is a deliberate
  // act with its own button, and losing a search to a stray keypress is not
  // something anybody asked for.
  if (isRunning($('#catalogue-search'))) return;

  $('#catalogue-search').click();
});

/* ------------------------------------------------------------------ *
 * SECTION — buying a plan
 *
 * The pricing buttons used to show a toast claiming a trial had started
 * and then change screen. Nothing was bought, no trial existed, and
 * nobody could pay us. They now open Stripe Checkout.
 *
 * No card data touches this page: Stripe collects it and tells the
 * server over a webhook, which is what creates the account and emails
 * the key.
 * ------------------------------------------------------------------ */

async function startCheckout(plan, button) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML =
    '<i class="fa-solid fa-circle-notch fa-spin text-[12.5px]"></i> Отварям плащането…';

  try {
    const response = await fetch(ENDPOINTS.billingCheckout, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ plan: plan }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || 'HTTP ' + response.status);

    // Same tab: Stripe returns the buyer here afterwards, and a popup
    // would be eaten by the blocker on a good share of browsers.
    window.location.href = body.url;
  } catch (error) {
    button.disabled = false;
    button.innerHTML = original;
    toast(failureText(error, 'Плащането не се отвори'), 'error');
  }
}

/**
 * Wires the pricing buttons to whichever of the two is true.
 *
 * Checkout is optional — this deployment may take payment by invoice, or
 * simply not be selling yet. Asking the server rather than assuming means
 * a button never opens a checkout that cannot complete, and never sits
 * there looking clickable while the answer is "write to us".
 */
(async function wirePricingButtons() {
  const buttons = $$('[data-checkout]');
  if (!buttons.length) return;

  const available = await billingPlans();

  buttons.forEach(function (button) {
    const plan = button.dataset.checkout;
    const buyable = available.enabled && available.plans.indexOf(plan) !== -1;

    if (buyable) {
      button.addEventListener('click', () => startCheckout(plan, button));
      return;
    }

    button.textContent = translate('Свържете се с нас');
    button.addEventListener('click', function () {
      // Not a toast: "write to us" without an address in view is a dead
      // end. The contact section carries the address.
      const contact = document.getElementById('contact');
      if (contact) contact.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('Пишете ни и ще активираме акаунта ви ръчно.', 'info');
    });
  });
})();

/* ------------------------------------------------------------------ *
 * Company particulars
 *
 * One place. The legal pages, the footer and every "write to us" button
 * read from here, so filling this block in fills the whole site — and
 * leaving it unfilled is visible on every page rather than hidden in one.
 * ------------------------------------------------------------------ */

const COMPANY = {
  name: '[ФИРМА]',
  eik: '[ЕИК]',
  address: '[АДРЕС]',
  email: '[ИМЕЙЛ]',
  mailProvider: '[ДОСТАВЧИК НА ПОЩА]',
  effectiveDate: '[ДАТА]',
};

(function fillCompany() {
  $$('[data-company]').forEach(function (element) {
    const value = COMPANY[element.dataset.company];
    if (value) element.textContent = value;
  });

  // A mailto: with a placeholder address opens an empty draft to nowhere,
  // so the link only becomes a link once there is an address to send to.
  const looksLikeEmail = COMPANY.email.indexOf('@') !== -1;

  $$('[data-contact-email]').forEach(function (element) {
    if (looksLikeEmail) {
      element.setAttribute('href', 'mailto:' + COMPANY.email);
      const label = element.querySelector('[data-contact-email-label]');
      if (label) label.textContent = COMPANY.email;
      return;
    }

    element.removeAttribute('href');
    element.classList.add('cursor-not-allowed', 'opacity-60');
    element.setAttribute('title', 'Имейлът за контакт още не е попълнен.');
  });
})();

/* ------------------------------------------------------------------ *
 * Public counters
 *
 * The landing page prints only what this returns. When the database is
 * empty the strip stays hidden: four zeroes persuade nobody, and the
 * numbers that used to be here were typed rather than counted.
 * ------------------------------------------------------------------ */

(async function loadPublicStats() {
  const strip = $('#live-stats');
  if (!strip) return;

  let stats;
  try {
    const response = await fetch(ENDPOINTS.stats, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;
    stats = await response.json();
  } catch (error) {
    return; // A marketing page must survive its own API being down.
  }

  const hasAnything = stats.shops > 0 || stats.products > 0;
  if (!hasAnything) return;

  // Liveness is a different question from volume, so it is answered before the
  // thresholds below. The badge only claims that something checked a price and
  // says when; that is true of a catalogue too small to print counters for, and
  // gating it on their size left the page silent about a check it had just run.
  if (stats.lastCheckAt) {
    // Composed from two pieces, so it cannot be looked up whole: the label goes
    // through the dictionary and the relative time is built by `timeAgo`.
    $('#hero-live-text').textContent =
      translate('Последна проверка') + ' ' + timeAgo(stats.lastCheckAt);
    $('#hero-live').hidden = false;
  }

  // Shown only once they argue for the product rather than against it.
  //
  // "8 следени артикула" is a true number that says "nobody uses this", and a
  // visitor reads it as exactly that. The honest options are to earn a bigger
  // number or to say something else; inflating it is not one, because the whole
  // product is a promise about the accuracy of numbers on a screen — and the
  // first person to sign up and find eight articles has learnt what our figures
  // are worth.
  //
  // Below the threshold the strip stays hidden and the page makes its case with
  // what it does rather than with how much of it has been done so far.
  const MEANINGFUL = { shops: 20, products: 250, movements: 1000 };

  const worthShowing =
    stats.shops >= MEANINGFUL.shops &&
    stats.products >= MEANINGFUL.products &&
    stats.priceMovements >= MEANINGFUL.movements;

  if (!worthShowing) {
    strip.hidden = true;
    return;
  }

  $('#live-shops').textContent = formatCount(stats.shops);
  $('#live-products').textContent = formatCount(stats.products);
  $('#live-movements').textContent = formatCount(stats.priceMovements);
  $('#live-success').textContent =
    stats.successRate === null ? '—' : stats.successRate.toFixed(1) + '%';
  strip.hidden = false;
})();

function formatCount(value) {
  // Grouping separators differ by language: 10 000 in Bulgarian, 10,000 in
  // English. Reading the chosen language off <html> keeps the two in step
  // without app.js having to know the i18n module exists.
  return new Intl.NumberFormat(document.documentElement.lang || 'bg-BG').format(value || 0);
}

/**
 * "3 minutes ago", in the reader's language.
 *
 * Built with `Intl.RelativeTimeFormat` rather than by pasting words together,
 * because every language disagrees about how: Bulgarian puts "преди" in front,
 * English puts "ago" behind, and both inflect the unit differently at one.
 * Handing that to the platform is the only version that stays correct when a
 * fourth language is added.
 */
function timeAgo(iso) {
  const language = document.documentElement.lang || 'bg';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));

  if (minutes < 1) return translate('току-що');

  const relative = new Intl.RelativeTimeFormat(language, { numeric: 'always' });

  if (minutes < 60) return relative.format(-minutes, 'minute');

  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, 'hour');

  return relative.format(-Math.round(hours / 24), 'day');
}

/* ------------------------------------------------------------------ *
 * Signing in
 *
 * A link in the mailbox instead of a password. The link lands back on
 * this page as `#signin=<token>`, which is traded for a session before
 * anything else runs — so a person following a link from their phone at
 * 7am arrives already signed in rather than at a key prompt.
 * ------------------------------------------------------------------ */

let account = null;

function renderAccount() {
  const session = getSession();
  const signedIn = Boolean(session);
  // A key pasted by hand is also somebody working, not browsing.
  const identified = signedIn || Boolean(getApiKey());

  // Who you are is written to the `hidden` attribute and nowhere else.
  //
  // These elements also carry a breakpoint pair — `hidden md:flex`, `hidden
  // sm:flex` — which is what keeps the desktop bar off a phone, where the
  // mobile tab row below does the same job. Toggling the `hidden` class for
  // signed-in/signed-out state stripped that floor away as a side effect: the
  // guest nav came back as a plain block on a 375px screen, the buttons stacked
  // over the logo, and the header scrolled sideways. The two questions look
  // alike and are not the same one, so they no longer share a mechanism.
  $$('[data-nav="guest"]').forEach(function (nav) {
    nav.hidden = identified;
  });
  $$('[data-nav="app"]').forEach(function (nav) {
    nav.hidden = !identified;
  });
  $$('[data-guest-only]').forEach(function (element) {
    element.hidden = identified;
  });
  $$('[data-app-only]').forEach(function (element) {
    element.hidden = !identified;
  });

  void refreshPlanBar();

  $('#signin-button').hidden = signedIn;
  $('#account-button').hidden = !signedIn;

  if (signedIn) {
    const label = (account && account.email) || session.email || 'акаунт';
    $('#account-label').textContent = label.split('@')[0];
  }

  // The key badge is for people driving the API by hand. Once there is a
  // session it is noise, and worse, it implies the key is what is being
  // used when it is not.
  // `sm:grid`, not `sm:flex`: the key icon is centred with `place-items-center`,
  // which needs a grid. The old line added a flex class the button was never
  // written for.
  $('#api-key-button').hidden = signedIn;
}

function showSignInStatus(message, tone) {
  const element = $('#signin-status');
  element.textContent = message;
  element.className =
    'mt-3 text-[11.5px] ' +
    (tone === 'error' ? 'text-red-400' : tone === 'success' ? 'text-emerald-400' : 'text-slate-400');
  element.classList.remove('hidden');
}

function openSignIn() {
  // Refreshed on open rather than on a timer: this dialog is the only place
  // any of it is visible, and it is opened rarely.
  void refreshPlanBar().then(() => refreshSecurityPanel());

  const signedIn = Boolean(getSession());

  $('#signin-form').classList.toggle('hidden', signedIn);
  $('#signin-sent').classList.add('hidden');
  $('#signin-account').classList.toggle('hidden', !signedIn);
  $('#signin-status').classList.add('hidden');

  if (signedIn) void renderAccountPanel();
  openModal('signin-modal');
}

$('#signin-button').addEventListener('click', openSignIn);
$('#account-button').addEventListener('click', openSignIn);

$('#signin-form').addEventListener('submit', async function (event) {
  event.preventDefault();

  const email = $('#signin-email').value.trim();
  if (!email || email.indexOf('@') === -1) {
    showSignInStatus('Въведете имейла, с който сте се регистрирали.', 'error');
    return;
  }

  $('#signin-spinner').classList.remove('hidden');

  try {
    const response = await fetch(ENDPOINTS.authSignIn, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, locale: currentLocale() }),
    });

    if (response.status === 429) {
      showSignInStatus(translate('Твърде много опити. Опитайте пак след малко.'), 'error');
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);

    // Deliberately the same screen whether or not the address is known:
    // this page must not become a way to find out who is a customer.
    $('#signin-form').classList.add('hidden');
    $('#signin-sent').classList.remove('hidden');
  } catch (error) {
    showSignInStatus(failureText(error, 'Не се получи'), 'error');
  } finally {
    $('#signin-spinner').classList.add('hidden');
  }
});

$('#signout-button').addEventListener('click', async function () {
  try {
    await fetch(ENDPOINTS.authSignOut, { method: 'POST', headers: authHeaders() });
  } catch (error) {
    // The session dies locally regardless: a network failure must not
    // leave somebody unable to sign out of a shared computer.
  }

  // The session and the customer key both go. The operator key is not touched:
  // it is a different identity and was not what was signed out of — removing
  // it here would log an operator out of the panel because they signed out of
  // a customer account they happened to also hold.
  setSession(null);
  setApiKey('');
  account = null;
  forgetAccount();
  renderAccount();
  closeModal('signin-modal');
  toast('Излязохте от този браузър.', 'info');
  loadProducts();
});

/**
 * Asks for the second factor and finishes signing in.
 *
 * A prompt rather than a dialog of its own: this is the rarest screen in the
 * product — only accounts that switched two-factor on ever see it — and a
 * bespoke modal for it would be a lot of markup nobody looks at. The challenge
 * lasts five minutes, so a mistyped code can simply be asked for again.
 */
async function promptForSecondFactor(challenge) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = window.prompt(
      translate('Въведете кода от приложението за удостоверяване (или код за възстановяване):'),
    );

    if (!code) {
      toast(translate('Входът е прекратен.'), 'info');
      renderAccount();
      return;
    }

    try {
      const response = await fetch(ENDPOINTS.authTotpVerify, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ challenge: challenge, code: code.trim() }),
      });

      const payload = await response.json().catch(() => ({}));

      if (response.ok) {
        setSession(payload);
        account = payload;
        forgetAccount();
        renderAccount();

        if (payload.apiKey) {
          setApiKey(payload.apiKey);
          renderApiKeyBadge();
          showIssuedKey(payload.apiKey);
        } else {
          toast(translate('Влязохте като') + ' ' + payload.email, 'success');
        }

        void refreshPlanBar();
        return;
      }

      toast(translate(payload.message || 'Кодът не е верен.'), 'error');
    } catch (error) {
      toast(failureText(error, 'Входът не успя'), 'error');
      renderAccount();
      return;
    }
  }

  toast(translate('Твърде много опити. Поискайте нова връзка за вход.'), 'error');
  renderAccount();
}

/** Trades `#signin=<token>` for a session, once, at load. */
(async function consumeSignInLink() {
  const match = /[#&]signin=([^&]+)/.exec(window.location.hash);
  if (!match) {
    renderAccount();
    return;
  }

  const token = decodeURIComponent(match[1]);
  // Cleared before the request so a refresh cannot replay a spent link
  // and land on "тази връзка вече е използвана".
  window.history.replaceState(null, '', window.location.pathname);

  try {
    const response = await fetch(ENDPOINTS.authSession, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      toast(payload.message || 'Връзката не е валидна.', 'error');
      renderAccount();
      return;
    }

    // An account with a second factor is not signed in yet: what came back is
    // a challenge, and the six digits finish the job. Handled here rather than
    // left to fail, because a link that silently stores a null token is a
    // customer who can never get in.
    if (payload.twoFactorRequired) {
      await promptForSecondFactor(payload.challenge);
      return;
    }

    setSession(payload);
    account = payload;
    forgetAccount();
    renderAccount();

    if (payload.apiKey) {
      // This exchange opened the account, so this is the one moment the
      // key exists in readable form. Stored for this browser and shown
      // once; afterwards only its digest survives.
      setApiKey(payload.apiKey);
      renderApiKeyBadge();
      showIssuedKey(payload.apiKey);
    } else {
      toast('Влязохте като ' + payload.email, 'success');
    }

    switchView('dashboard');
  } catch (error) {
    toast(failureText(error, 'Входът не успя'), 'error');
    renderAccount();
  }
})();

/**
 * The one screen that will ever display the key.
 *
 * Not a toast: a toast disappears, and this cannot be recovered — only
 * replaced, which breaks whatever was already using it.
 */
function showIssuedKey(apiKey) {
  $('#signin-form').classList.add('hidden');
  $('#signin-sent').classList.add('hidden');
  $('#signin-account').classList.remove('hidden');

  $('#account-email').textContent = (account && account.email) || '';
  $('#account-plan').textContent = 'Акаунтът е отворен и потвърден.';

  $('#account-usage').innerHTML =
    '<p class="text-[12.5px] leading-relaxed text-slate-300">Ето вашия API ключ — виждате го само сега.</p>' +
    '<div class="mt-2 flex items-center gap-2 rounded-xl border border-accent-500/30 bg-ink-900 p-3">' +
    '<code id="issued-key" class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11.5px] text-accent-400">' +
    escapeHtml(apiKey) +
    '</code>' +
    '<button type="button" id="issued-copy" class="shrink-0 rounded-lg border border-white/10 bg-ink-850 px-3 py-2 text-[11.5px] font-medium text-slate-300 transition hover:border-white/25 hover:text-slate-100">' +
    '<i class="fa-solid fa-copy text-[11.5px]"></i> Копирай</button></div>' +
    '<p class="mt-2 text-[11.5px] leading-relaxed text-slate-500">Изпратихме копие и на имейла ви. Ключът е за програми — в браузъра оставате влезли и без него.</p>';

  $('#issued-copy').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(apiKey);
      toast('Ключът е копиран.', 'success');
    } catch (error) {
      toast('Копирането не стана — маркирайте ключа и копирайте ръчно.', 'error');
    }
  });

  openModal('signin-modal');
}

/**
 * Fills the bar that says whose account this is and what is left of it.
 *
 * Reads /billing/me rather than trusting the session payload: the plan
 * and the allowances move — a purchase, a month rolling over, a search
 * that just spent three comparisons — and a figure that only refreshes
 * on sign-in is wrong for most of the time somebody is looking at it.
 */
/** The demo banner is the exact inverse of being signed in. */
function refreshDemoBanner() {
  const demo = !isIdentified();
  $$('[data-demo-banner]').forEach(function (banner) {
    banner.hidden = !demo;
  });
}

async function refreshPlanBar() {
  const bars = $$('[data-plan-bar]');
  refreshDemoBanner();
  if (bars.length === 0) return;

  const identified = isIdentified();

  if (!identified) {
    bars.forEach((bar) => (bar.hidden = true));
    return;
  }

  // `isIdentified` above already excluded the operator — it reads the customer
  // slot only — so by here there is a customer credential and /billing/me is a
  // question worth asking. The probe is still awaited once, to settle a browser
  // whose key predates the split before anything is asked with it.
  await operatorKnown();

  if (usingOperatorKey || !isIdentified()) {
    bars.forEach((bar) => (bar.hidden = true));
    return;
  }

  try {
    account = await accountOnce();
    if (!account) throw new Error('no account');
  } catch (error) {
    // An operator key has no account row, and a dead session has none
    // either. Neither is worth an error message here.
    bars.forEach((bar) => (bar.hidden = true));
    return;
  }

  // Nothing to say, so nothing shown. Without this the bar appeared as a
  // full-width empty box with a lone "Account" button floating in it —
  // whenever the account payload came back without the fields it fills.
  if (!account || !account.email) {
    bars.forEach((bar) => (bar.hidden = true));
    return;
  }

  // Counted from what the API returned, not from the table: the table
  // may be holding demo rows for a visitor, and an empty account was
  // reading "9 / 100" because of them.
  const tracked = trackedCount;

  bars.forEach(function (bar) {
    bar.hidden = false;
    bar.querySelector('[data-plan-email]').textContent = account.email;
    bar.querySelector('[data-plan-name]').textContent = PLAN_NAMES[account.plan] || account.plan;
    bar.querySelector('[data-plan-products]').innerHTML = meterHtml(
      'Следени артикули',
      Math.min(tracked, account.productLimit),
      account.productLimit,
    );
    bar.querySelector('[data-plan-ai]').innerHTML = meterHtml(
      'AI сравнения / месец',
      account.aiMatchesUsed,
      account.aiMatchesLimit,
      { topUp: true },
    );
    renderTrialPill(bar.querySelector('[data-plan-trial]'), account);
  });
}

/**
 * The trial countdown, or nothing.
 *
 * Urgent only at the end. A badge that shouts from day one is wallpaper
 * by day three, and the day that actually matters — the last two, when
 * articles are about to stop being watched — has nothing left to say.
 */
function renderTrialPill(pill, account) {
  if (!pill) return;

  const daysLeft = account.trialDaysLeft;

  if (daysLeft === null || daysLeft === undefined) {
    pill.hidden = true;
    return;
  }

  const urgent = daysLeft <= 2;

  pill.hidden = false;
  pill.textContent =
    daysLeft <= 0
      ? 'Пробният период изтича днес'
      : 'Пробен · ' + daysLeft + (daysLeft === 1 ? ' ден' : ' дни');
  pill.title = urgent
    ? 'След това следим 10 артикула. Останалите спират, но не се изтриват.'
    : 'Пробен период ПРО. Натиснете за плановете.';
  pill.className =
    'nav-link rounded-md px-2 py-0.5 text-[11px] font-semibold transition ' +
    (urgent
      ? 'bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-300'
      : 'bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-200');
}

const PLAN_NAMES = { free: 'Безплатен', starter: 'Занаят', pro: 'Магазин', business: 'Верига' };

/** Where more comparisons are sold, once the server has said whether they are. */
let topUpUrl = null;

(async function loadTopUpOffer() {
  topUpUrl = (await billingPlans()).topUpUrl || null;
})();

$$('[data-plan-manage]').forEach(function (button) {
  button.addEventListener('click', openSignIn);
});

/** The account panel: who this is, and what is left of the month. */
async function renderAccountPanel() {
  const box = $('#account-usage');
  box.innerHTML = '<p class="text-[11.5px] text-slate-500">Зареждам…</p>';

  try {
    const response = await fetch(ENDPOINTS.billingMe, { headers: authHeaders() });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    account = await response.json();

    $('#account-email').textContent = account.email;
    $('#account-plan').textContent =
      'План ' + account.plan + ' · ' + account.productLimit + ' следени артикула';

    box.innerHTML =
      meterHtml(
        'AI сравнения този месец',
        account.aiMatchesUsed,
        account.aiMatchesLimit,
        { topUp: true },
      ) +
      (account.apiKeyPrefix
        ? '<p class="text-[11.5px] text-slate-500">API ключ: <span class="font-mono text-slate-400">' +
          escapeHtml(account.apiKeyPrefix) +
          '…</span> — за програми. Този вход е за хора.</p>'
        : '');
  } catch (error) {
    box.innerHTML =
      '<p class="text-[11.5px] text-red-400">Данните за акаунта не се заредиха.</p>';
  }
}

function meterHtml(label, used, limit, options) {
  const share = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = share >= 90 ? 'bg-red-500' : share >= 70 ? 'bg-amber-500' : 'bg-accent-500';
  const offerTopUp = options && options.topUp && topUpUrl && share >= 70;

  return (
    '<div>' +
    '<div class="flex items-baseline justify-between gap-3">' +
    '<span class="text-[11.5px] text-slate-400">' + escapeHtml(label) + '</span>' +
    '<span class="num text-[11.5px] font-semibold text-slate-300">' + used + ' / ' + limit + '</span>' +
    '</div>' +
    '<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">' +
    '<div class="h-full rounded-full ' + tone + '" style="width:' + share + '%"></div>' +
    '</div>' +
    // Offered only when it is nearly spent and only when it is actually
    // for sale. A permanent "buy more" next to a full meter is an advert.
    (offerTopUp
      ? '<a href="' + escapeHtml(topUpUrl) + '" target="_blank" rel="noopener" ' +
        'class="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent-500 hover:underline">' +
        '<i class="fa-solid fa-plus text-[9px]"></i>Купи още сравнения</a>'
      : '') +
    '</div>'
  );
}

/* ------------------------------------------------------------------ *
 * Free signup
 * ------------------------------------------------------------------ */

// Delegated rather than bound per element: several of these buttons are
// rendered long after boot — inside a failed search, inside the demo — and a
// one-off pass over the document at startup never sees them.
document.addEventListener('click', function (event) {
  if (event.target.closest('[data-signup]')) {
    // Reset to the form: the dialog may still be showing a key from a
    // previous account, and that key must not be attributed to this one.
    $('#signup-form').classList.remove('hidden');
    $('#signup-done').classList.add('hidden');
    $('#signup-status').classList.add('hidden');
    openModal('signup-modal');
    return;
  }

  if (event.target.closest('[data-signin]')) openSignIn();
});


function showSignupStatus(message, tone) {
  const element = $('#signup-status');
  element.textContent = message;
  element.className =
    'mt-3 text-[11.5px] ' +
    (tone === 'error'
      ? 'text-red-400'
      : tone === 'success'
        ? 'text-emerald-400'
        : 'text-slate-400');
  element.classList.remove('hidden');
}

$('#signup-form').addEventListener('submit', async function (event) {
  event.preventDefault();

  const email = $('#signup-email').value.trim();
  const name = $('#signup-name').value.trim();

  if (!email || email.indexOf('@') === -1) {
    showSignupStatus('Въведете имейл, на който да получите ключа.', 'error');
    return;
  }

  $('#signup-spinner').classList.remove('hidden');
  showSignupStatus(translate('Създаваме акаунта…'), 'info');

  try {
    const response = await fetch(ENDPOINTS.authRegister, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, locale: currentLocale(), ...(name ? { name } : {}) }),
    });

    const payload = await response.json().catch(() => ({}));

    if (response.status === 400) {
      // Worth spelling out: a throwaway address is something the person
      // can fix by using their real one.
      showSignupStatus(translate(payload.message || 'Този имейл не става.'), 'error');
      return;
    }
    if (response.status === 429) {
      showSignupStatus(translate('Твърде много опити. Опитайте пак след малко.'), 'error');
      return;
    }
    if (!response.ok) {
      throw new Error(payload.message || 'HTTP ' + response.status);
    }

    // No key here any more. It exists only once somebody opens the
    // mailbox, which is what stops accounts being farmed from addresses
    // nobody owns.
    $('#signup-form').classList.add('hidden');
    $('#signup-done').classList.remove('hidden');
  } catch (error) {
    showSignupStatus(failureText(error, 'Не се получи'), 'error');
  } finally {
    $('#signup-spinner').classList.add('hidden');
  }
});

/**
 * Says what happened after Stripe sends the buyer back.
 *
 * The account is created by the webhook, not by this redirect, so the
 * message points at the email rather than claiming access is ready —
 * the webhook usually lands first, but not always.
 */
(function reportCheckoutOutcome() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('checkout');
  if (!outcome) return;

  if (outcome === 'success') {
    toast('Плащането мина. Ключът ви пътува към пощата — проверете и папка Спам.', 'success');
  } else if (outcome === 'cancelled') {
    toast('Плащането е прекратено. Нищо не е таксувано.', 'info');
  }

  // Cleared so a refresh does not repeat the message.
  params.delete('checkout');
  params.delete('session');
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    window.location.pathname + (query ? '?' + query : '') + window.location.hash,
  );
})();

/* ------------------------------------------------------------------ *
 * SECTION — operator panel
 *
 * The customer list, behind an operator key. Two things live here that
 * exist nowhere else: seeing who has paid, and replacing the key of a
 * customer who has lost theirs.
 *
 * Key recovery has to be an operator action by construction. Presenting
 * the lost key is exactly what the customer cannot do, and letting a
 * customer key rotate an arbitrary account would turn "I know your email
 * address" into "I can revoke your access", since issuing a key kills
 * the previous one.
 * ------------------------------------------------------------------ */

const PLAN_LABELS = { free: 'Безплатен', starter: 'Старт', pro: 'ПРО', business: 'Бизнес' };
const STATUS_STYLE = {
  active: { label: 'активен', class: 'bg-emerald-500/12 text-emerald-400' },
  pending: { label: 'чака плащане', class: 'bg-white/[0.06] text-slate-400' },
  expired: { label: 'изтекъл', class: 'bg-amber-500/12 text-amber-400' },
  suspended: { label: 'спрян', class: 'bg-red-500/12 text-red-400' },
};

/**
 * Reveals the operator nav entry when the key in use is an operator key.
 *
 * Detected by asking: `/billing/users` answers 403 for a customer key.
 * Inferring it from the key's own prefix would be guessing at a rule the
 * server owns.
 */
/** The desktop pill and the mobile tab, moved together. Two elements that
 *  disagree about whether you are an operator is worse than neither. */
function showOperatorEntries(visible) {
  $('#nav-operator').hidden = !visible;

  const mobile = $('#nav-operator-mobile');
  if (mobile) mobile.hidden = !visible;
}

/*
 * `detectOperator` used to live here.
 *
 * It asked the server "is the key in the customer slot an operator's?" — a
 * question that only had to be asked because both kinds shared one slot. They
 * no longer do: which box a key is in *is* the answer, so the probe is gone
 * and `usingOperatorKey` is read from storage. The one remaining server call
 * is `migrateLegacyOperatorKey`, which runs once for a browser that still has
 * a key stored under the old arrangement.
 */

/**
 * The four things that are either working or not.
 *
 * Each has had an endpoint for a while and nothing ever showed them together,
 * so "is the service healthy" meant four separate requests and remembering
 * what normal looks like for each. A tile is green when the answer is the one
 * you want and amber when it is not — never red, because none of these being
 * off is an emergency on its own, and a screen that cries wolf gets ignored.
 *
 * Failures are reported as "unknown" rather than as "broken": an endpoint that
 * did not answer tells you about the request, not about the thing.
 */
async function loadOperatorHealth() {
  const strip = $('#operator-health');
  if (!strip) return;

  // Operator credentials: this strip lives on the operator panel, and two of
  // the four endpoints below are operator-only. `/health` is public and takes
  // the header harmlessly.
  const ask = async (url) => {
    try {
      const response = await fetch(url, { headers: operatorHeaders() });
      return response.ok ? await response.json() : null;
    } catch (error) {
      return null;
    }
  };

  const [health, mail, matching, scraper] = await Promise.all([
    ask('/health'),
    ask(ENDPOINTS.billingMailHealth),
    ask(ENDPOINTS.matchingHealth),
    ask(ENDPOINTS.scraperStatus),
  ]);

  const tile = (label, value, ok, detail) =>
    '<div class="bg-ink-900 px-3.5 py-2.5">' +
    '<div class="flex items-center gap-2">' +
    '<span class="h-1.5 w-1.5 shrink-0 rounded-full ' +
    (ok ? 'bg-emerald-400' : 'bg-amber-400') +
    '"></span>' +
    '<span class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">' +
    escapeHtml(label) +
    '</span></div>' +
    '<p class="mt-1.5 text-[12.5px] font-medium ' +
    (ok ? 'text-slate-200' : 'text-amber-300') +
    '">' +
    escapeHtml(value) +
    '</p>' +
    (detail
      ? '<p class="mt-0.5 truncate text-[11px] text-slate-500" title="' +
        escapeHtml(detail) +
        '">' +
        escapeHtml(detail) +
        '</p>'
      : '') +
    '</div>';

  strip.innerHTML =
    tile(
      'База',
      health ? (health.database.status === 'up' ? 'работи' : 'не отговаря') : 'неизвестно',
      Boolean(health && health.database.status === 'up'),
      health ? health.database.latencyMs + ' ms' : '',
    ) +
    tile(
      'Поща',
      mail ? (mail.ok ? 'работи' : 'не работи') : 'неизвестно',
      Boolean(mail && mail.ok),
      mail ? mail.detail : '',
    ) +
    tile(
      'AI съпоставяне',
      matching ? (matching.enabled ? 'включено' : 'изключено') : 'неизвестно',
      Boolean(matching && matching.enabled),
      matching && matching.model ? matching.model : 'без ключ — само по спецификации',
    ) +
    tile(
      'Обиколка',
      scraper && scraper.lastRunAt ? formatRelative(scraper.lastRunAt) : 'още не е минала',
      Boolean(scraper && scraper.lastRunAt),
      scraper && scraper.enabled ? 'по график' : 'спряна',
    );
}

/**
 * Opens the panel: the health strip, which every tab keeps overhead, and
 * whichever tab is current. The strip is deliberately outside the tabs —
 * "is anything on fire" is the question you carry in with you, whichever
 * screen you actually came for.
 */
async function loadOperatorPanel() {
  void loadOperatorHealth();

  // The range buttons carry their state in a class, and nothing has set it
  // until the panel opens for the first time.
  $$('[data-op-range]').forEach((button) =>
    button.classList.toggle('tab-active', Number(button.dataset.opRange) === operatorRange),
  );

  openOperatorTab(operatorTab, { force: true });
}

/** The customer list. Its own function since the panel grew tabs — before
 *  that it *was* the panel. */
/** Everyone, as last fetched. Filtering happens here rather than on the
 *  server: the whole customer list is small enough to hold, and a search
 *  that answers as you type beats one that waits for a round trip. */
let operatorCustomers = [];

async function loadOperatorCustomers() {
  const list = $('#operator-list');
  list.innerHTML =
    '<p class="px-4 py-8 text-center text-[12.5px] text-slate-500">Зареждам…</p>';

  try {
    const response = await fetch(ENDPOINTS.billingUsers, { headers: operatorHeaders() });

    if (response.status === 403) {
      list.innerHTML =
        '<p class="px-4 py-6 text-center text-[12.5px] text-slate-500">' +
        'Този екран иска операторски ключ, не клиентски.</p>';
      return;
    }

    if (!response.ok) throw new Error('HTTP ' + response.status);
    operatorCustomers = await response.json();
  } catch (error) {
    list.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-red-400">' +
      escapeHtml(failureText(error, 'Не се зареди')) +
      '</p>';
    return;
  }

  renderOperatorCustomers();
}

/** Draws the table from whatever survives the search box and the two
 *  dropdowns. Separate from the fetch so typing does not hit the network. */
function renderOperatorCustomers() {
  const list = $('#operator-list');
  const term = $('#operator-customer-search').value.trim().toLowerCase();
  const status = $('#operator-customer-status').value;
  const plan = $('#operator-customer-plan').value;

  const users = operatorCustomers.filter(function (user) {
    if (status && user.status !== status) return false;
    if (plan && user.plan !== plan) return false;
    if (!term) return true;

    return (
      (user.email || '').toLowerCase().includes(term) ||
      (user.name || '').toLowerCase().includes(term)
    );
  });

  const counter = $('#operator-customer-count');
  counter.textContent =
    users.length === operatorCustomers.length
      ? operatorCustomers.length + ' общо'
      : users.length + ' от ' + operatorCustomers.length;

  if (operatorCustomers.length && !users.length) {
    list.innerHTML =
      '<p class="px-4 py-7 text-center text-[12.5px] text-slate-500">' +
      'Никой не отговаря на този филтър.</p>';
    return;
  }

  if (!users.length) {
    list.innerHTML =
      '<div class="px-4 py-7 text-center text-[12.5px] text-slate-500">' +
      '<i class="fa-solid fa-users mb-3 block text-[17px] text-slate-700"></i>' +
      'Още няма клиенти. Акаунт се създава сам при първото успешно плащане.</div>';
    return;
  }

  const rows = users
    .map(function (user) {
      const status = STATUS_STYLE[user.status] || STATUS_STYLE.pending;

      return (
        '<tr class="border-b border-white/[0.06] transition hover:bg-white/[0.03]">' +
        '<td data-label="Клиент" class="py-3 pl-5 pr-3">' +
        '<span class="block truncate text-[12.5px] font-medium text-slate-200">' +
        escapeHtml(user.email) +
        '</span>' +
        (user.name
          ? '<span class="block truncate text-[11px] text-slate-500">' +
            escapeHtml(user.name) +
            '</span>'
          : '') +
        '</td>' +
        '<td data-label="Състояние" class="px-3 py-3">' +
        '<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ' +
        status.class +
        '">' +
        status.label +
        '</span></td>' +
        // Editable in place rather than behind a dialog: this is a table an
        // operator scans and corrects, and a modal per row is a modal too many.
        '<td data-label="План" class="px-3 py-3">' +
        '<select data-plan="' +
        escapeHtml(user.id) +
        '" class="rounded-lg border border-white/10 bg-ink-850 px-2 py-1 text-[11.5px] text-slate-300 transition hover:border-accent-500/40 focus:border-accent-500/60 focus:outline-none">' +
        ['free', 'starter', 'pro', 'business']
          .map(
            (value) =>
              '<option value="' +
              value +
              '"' +
              (user.plan === value ? ' selected' : '') +
              '>' +
              escapeHtml(PLAN_LABELS[value] || value) +
              '</option>',
          )
          .join('') +
        '</select></td>' +
        '<td data-label="Лимит" class="px-3 py-3 text-right">' +
        '<input type="number" min="0" max="100000" data-limit="' +
        escapeHtml(user.id) +
        '" value="' +
        user.productLimit +
        '" class="num w-20 rounded-lg border border-white/10 bg-ink-850 px-2 py-1 text-right text-[11.5px] text-slate-300 transition hover:border-accent-500/40 focus:border-accent-500/60 focus:outline-none" />' +
        '</td>' +
        // What they are actually spending, next to what they are allowed.
        // A limit on its own says what we sold; this says whether it fits.
        '<td data-label="AI" class="num px-3 py-3 text-right text-[11.5px]">' +
        '<span class="' +
        (user.aiMatchesUsed >= user.aiMatchesLimit ? 'text-amber-400' : 'text-slate-400') +
        '">' +
        user.aiMatchesUsed +
        ' / ' +
        user.aiMatchesLimit +
        '</span></td>' +
        '<td data-label="Език" class="px-3 py-3 text-[11px] text-slate-500">' +
        escapeHtml(user.locale ? user.locale.toUpperCase() : '—') +
        '</td>' +
        '<td data-label="Ключ" class="px-3 py-3">' +
        (user.apiKeyPrefix
          ? '<span class="font-mono text-[11px] text-slate-400">' +
            escapeHtml(user.apiKeyPrefix) +
            '…</span>'
          : '<span class="text-[11px] text-slate-600">няма ключ</span>') +
        '</td>' +
        '<td data-label="Ползван" class="px-3 py-3 text-[11px] text-slate-500">' +
        escapeHtml(
          user.apiKeyLastUsedAt ? formatRelative(user.apiKeyLastUsedAt) : 'не е ползван',
        ) +
        '</td>' +
        '<td class="py-3 pl-3 pr-5 text-right">' +
        '<span class="op-actions inline-flex items-center gap-1.5">' +
        '<button type="button" data-suspend="' +
        escapeHtml(user.id) +
        '" data-suspended="' +
        (user.status === 'suspended' ? '1' : '') +
        '" title="' +
        (user.status === 'suspended' ? 'Възстанови достъпа' : 'Спри достъпа') +
        '" class="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-ink-850 transition ' +
        (user.status === 'suspended'
          ? 'text-emerald-400 hover:border-emerald-500/40'
          : 'text-slate-400 hover:border-red-500/40 hover:text-red-400') +
        '"><i class="fa-solid fa-' +
        (user.status === 'suspended' ? 'play' : 'ban') +
        ' text-[10px]"></i></button>' +
        '<button type="button" data-reissue="' +
        escapeHtml(user.email) +
        '" class="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 py-1.5 text-[11.5px] font-medium text-slate-300 transition hover:border-amber-500/40 hover:text-amber-300">' +
        '<i class="fa-solid fa-key text-[10px]"></i><span class="whitespace-nowrap">Нов ключ</span></button>' +
        '</span></td></tr>'
      );
    })
    .join('');

  list.innerHTML =
    // The wrapper is what makes the buttons reachable between the card
    // breakpoint and the width the full table needs: without it the card
    // this sits in is `overflow-hidden` for its rounded corners, and the
    // last two columns were simply cut off the right edge.
    '<div class="overflow-x-auto md:overflow-x-auto">' +
    '<table class="op-table w-full text-left">' +
    '<thead><tr class="border-b border-white/8 text-[10px] uppercase tracking-wide text-slate-500 [&>th]:whitespace-nowrap">' +
    '<th class="py-2.5 pl-5 pr-3 font-semibold">Клиент</th>' +
    '<th class="px-3 py-2.5 font-semibold">Състояние</th>' +
    '<th class="px-3 py-2.5 font-semibold">План</th>' +
    '<th class="px-3 py-2.5 text-right font-semibold">Лимит</th>' +
    '<th class="px-3 py-2.5 text-right font-semibold">AI</th>' +
    '<th class="px-3 py-2.5 font-semibold">Език</th>' +
    '<th class="px-3 py-2.5 font-semibold">Ключ</th>' +
    '<th class="px-3 py-2.5 font-semibold">Ползван</th>' +
    '<th class="py-2.5 pl-3 pr-5"></th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table></div>';

  $$('[data-reissue]').forEach(function (button) {
    button.addEventListener('click', () => reissueKey(button.dataset.reissue));
  });
  $$('[data-suspend]').forEach(function (button) {
    button.addEventListener('click', () =>
      toggleSuspension(button.dataset.suspend, Boolean(button.dataset.suspended)),
    );
  });
  // Committed on change, not on a save button: a select that has already
  // moved and a number that has already been typed are the operator's answer,
  // and a row that needs confirming twice gets confirmed once and forgotten.
  $$('[data-plan]').forEach(function (select) {
    select.addEventListener('change', () =>
      patchUser(select.dataset.plan, { plan: select.value }, 'Планът не се смени'),
    );
  });
  $$('[data-limit]').forEach(function (input) {
    input.addEventListener('change', function () {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) return;
      void patchUser(input.dataset.limit, { productLimit: value }, 'Лимитът не се смени');
    });
  });
}

/** Sends one operator change and reloads the list from the server. */
async function patchUser(id, changes, failure) {
  try {
    const response = await fetch(ENDPOINTS.billingUsers + '/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: operatorHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(changes),
    });

    if (!response.ok) throw new Error('HTTP ' + response.status);

    await loadOperatorPanel();
    return true;
  } catch (error) {
    toast(failureText(error, failure), 'error');
    return false;
  }
}

/**
 * Stops or restores an account.
 *
 * Suspension is the one operator action with an immediate outward effect —
 * the customer's integration stops on the next request — so it asks first and
 * says so. Restoring does not, because nothing breaks by being allowed back.
 */
async function toggleSuspension(id, suspended) {
  if (suspended) {
    await patchUser(id, { status: 'active' }, 'Достъпът не беше възстановен');
    return;
  }

  const confirmed = await confirmDialog(
    'Спиране на достъп',
    'Ключът на този клиент спира да работи веднага. Ако има работеща интеграция, тя ще спре. Данните остават — това не е изтриване.',
    'Спри достъпа',
  );
  if (!confirmed) return;

  await patchUser(id, { status: 'suspended' }, 'Достъпът не беше спрян');
}

/**
 * Issues a replacement key and shows it once.
 *
 * Confirmed first, and the confirmation says the destructive part out
 * loud: this does not "recover" anything, it replaces. Whatever the
 * customer is running with the old key stops working the moment this
 * returns.
 */
async function reissueKey(email) {
  const confirmed = await confirmDialog(
    'Нов ключ за ' + email,
    'Старият ключ спира да работи веднага и не може да се върне. Ако клиентът има работеща интеграция, тя ще спре, докато не сложи новия ключ.',
    'Издай нов ключ',
  );
  if (!confirmed) return;

  try {
    const response = await fetch(ENDPOINTS.billingRotateKey, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: email }),
    });

    if (!response.ok) {
      throw new Error((await response.text()).slice(0, 200) || 'HTTP ' + response.status);
    }

    const issued = await response.json();

    // Shown in the page rather than a toast: this is the only moment the
    // plaintext exists anywhere, and a toast that fades after three
    // seconds is how it gets lost a second time.
    $('#operator-issued').innerHTML =
      '<div class="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-2.5">' +
      '<p class="text-[12.5px] font-semibold text-amber-400">' +
      '<i class="fa-solid fa-key mr-1.5"></i>Нов ключ за ' +
      escapeHtml(issued.email) +
      '</p>' +
      '<p class="mt-1.5 text-[11.5px] text-slate-400">Копирайте го сега — след като напуснете страницата, ' +
      'няма откъде да се прочете отново.</p>' +
      '<div class="mt-3 flex flex-wrap items-center gap-2">' +
      '<code class="min-w-0 flex-1 overflow-x-auto rounded-lg border border-white/10 bg-ink-950 px-3 py-2.5 font-mono text-[12.5px] text-emerald-400">' +
      escapeHtml(issued.apiKey) +
      '</code>' +
      '<button type="button" id="copy-issued-key" class="rounded-lg border border-white/10 bg-ink-850 px-3 py-2.5 text-[11.5px] font-medium text-slate-300 transition hover:border-accent-500/40">' +
      '<i class="fa-solid fa-copy mr-1.5 text-[11px]"></i>Копирай</button>' +
      '</div>' +
      (issued.replacedPreviousKey
        ? '<p class="mt-2.5 text-[11px] text-amber-400/80">Предишният ключ вече не работи.</p>'
        : '') +
      '</div>';

    $('#copy-issued-key').addEventListener('click', function () {
      void navigator.clipboard
        .writeText(issued.apiKey)
        .then(() => toast('Ключът е копиран.', 'success'))
        .catch(() => toast('Копирайте го на ръка.', 'info'));
    });

    await loadOperatorPanel();
  } catch (error) {
    toast(failureText(error, 'Ключът не се издаде'), 'error');
  }
}

/* ------------------------------------------------------------------ *
 * SECTION — operator panel: overview, payments, supplier sites
 *
 * Three screens that had no endpoint until now, because everything the
 * API exposes is filtered by owner and none of these questions has one:
 * how the business is growing, whether the money actually arrived, and
 * which supplier sites we are leaning on across every customer.
 *
 * Charts are inline SVG. The page ships no bundler, and pulling in a
 * charting library to draw thirty rectangles would cost more bytes than
 * the whole operator panel — while a strict Content-Security-Policy
 * forbids fetching one from a CDN anyway.
 * ------------------------------------------------------------------ */

/** Which tab is open. Kept so "Опресни" reloads what you are looking at
 *  rather than everything, and so a tab is fetched the first time it is
 *  opened instead of on every visit to the panel. */
let operatorTab = 'overview';
const operatorLoaded = {
  overview: false,
  scrape: false,
  alerts: false,
  customers: false,
  payments: false,
  shops: false,
};

const OPERATOR_LEDE = {
  overview: 'Как расте всичко и дали парите пристигат. Числата са за всички клиенти, не за акаунт.',
  scrape:
    'Дали обиколката минава и къде се спъва. Провалите са по сайт, защото сайтът е поправката, не обявата.',
  alerts:
    'Какво е тръгнало към клиентите и дали е стигнало. Потвърдените остават в списъка, избледнени.',
  search:
    'Защо търсенето отговори точно това. Числата отгоре са здравето му за деня; проследяването отдолу пуска един въпрос на живо и показва всеки етап — какво разчете, какво попита всеки доставчик, какво съвпадна, какво липсва и кое го отхвърли.',
  customers:
    'Кой е платил, на какъв план е и с кой ключ работи. Ключът не може да се прочете — пази се само отпечатък. Загубен ключ се заменя с нов, не се възстановява.',
  decisions:
    'Какво са решили клиентите и дали машината, която ги съветва, работи. Стойностите са формата на решението, не съдържанието му — какво купува един клиент не отговаря на нито един от тези въпроси.',
  payments:
    'Всяко събитие от Stripe, както е дошло. Тук се проверява оплакването „платих и не получих нищо“.',
  shops:
    'Сайтовете на доставчиците, по един ред на домейн, не по един на клиент. Счупен селектор на сайт, който трима клиенти ползват, е три оплаквания.',
};

/**
 * A bar per day.
 *
 * `peak` is at least 1, so a month with nothing in it draws a flat floor
 * rather than dividing by zero. `bad` shades the failed part of the same
 * bar instead of adding a second series: a day with four webhooks of which
 * one failed is one fact, and two bars side by side invite reading it as
 * five events.
 */
function dailyBars(points, accent) {
  const slot = 10;
  const height = 80;
  const width = Math.max(points.length, 1) * slot;
  const peak = Math.max(1, ...points.map((point) => point.value || 0));

  const bars = points
    .map(function (point, index) {
      const value = point.value || 0;
      const bad = Math.min(point.bad || 0, value);
      const full = value > 0 ? Math.max(2, Math.round((value / peak) * (height - 6))) : 0;
      const badHeight = value > 0 ? Math.round((bad / value) * full) : 0;
      const x = index * slot + 1.5;
      const label = point.day + ' — ' + value + (bad ? ' (' + bad + ' необработени)' : '');

      // An empty day still gets a hairline. Without it the axis disappears
      // wherever nothing happened, and a gap reads as missing data rather
      // than as a quiet Sunday.
      if (full === 0) {
        return (
          '<rect x="' + x + '" y="' + (height - 1) + '" width="7" height="1" rx="0.5" ' +
          'fill="currentColor" opacity="0.18"><title>' + escapeHtml(label) + '</title></rect>'
        );
      }

      return (
        '<g><title>' + escapeHtml(label) + '</title>' +
        '<rect x="' + x + '" y="' + (height - full) + '" width="7" height="' + full +
        '" rx="1.5" fill="' + accent + '" opacity="0.85"></rect>' +
        (badHeight > 0
          ? '<rect x="' + x + '" y="' + (height - badHeight) + '" width="7" height="' +
            badHeight + '" rx="1.5" fill="#f87171"></rect>'
          : '') +
        '</g>'
      );
    })
    .join('');

  return (
    '<svg viewBox="0 0 ' + width + ' ' + height + '" class="h-24 w-full text-slate-400" ' +
    'role="img" preserveAspectRatio="none">' + bars + '</svg>'
  );
}

/** A chart with its title, total and date range around it. */
function chartCard(title, note, total, points, accent) {
  const first = points.length ? points[0].day : '';
  const last = points.length ? points[points.length - 1].day : '';

  return (
    '<div class="rounded-xl border border-white/8 bg-ink-900 p-3.5 shadow-panel">' +
    '<div class="flex items-baseline justify-between gap-3">' +
    '<div><p class="text-[12.5px] font-semibold text-slate-200">' + escapeHtml(title) + '</p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">' + escapeHtml(note) + '</p></div>' +
    '<p class="num text-[17px] font-bold text-slate-200">' + total + '</p></div>' +
    '<div class="mt-4">' + dailyBars(points, accent) + '</div>' +
    '<div class="mt-2 flex justify-between text-[11px] text-slate-600">' +
    '<span>' + escapeHtml(first) + '</span><span>' + escapeHtml(last) + '</span></div>' +
    '</div>'
  );
}

/** One headline number. `tone` amber marks a figure that wants attention;
 *  everything else stays neutral, so the amber ones actually stand out. */
function headlineTile(label, value, note, tone) {
  return (
    '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-2.5 shadow-panel">' +
    '<p class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">' +
    escapeHtml(label) + '</p>' +
    '<p class="num mt-1.5 text-[19px] font-bold ' +
    (tone === 'amber' ? 'text-amber-300' : 'text-slate-200') + '">' + value + '</p>' +
    '<p class="mt-1 text-[11px] text-slate-500">' + escapeHtml(note) + '</p></div>'
  );
}

/** A horizontal bar per plan, so the mix is readable without a legend. */
function planBars(byPlan) {
  const entries = Object.keys(byPlan).map((plan) => ({ plan, count: byPlan[plan] }));
  const peak = Math.max(1, ...entries.map((entry) => entry.count));

  return (
    '<div class="rounded-xl border border-white/8 bg-ink-900 p-3.5 shadow-panel">' +
    '<p class="text-[12.5px] font-semibold text-slate-200">Разпределение по план</p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">Всеки план се показва, включително празните.</p>' +
    '<div class="mt-4 space-y-2.5">' +
    entries
      .map(function (entry) {
        const width = Math.round((entry.count / peak) * 100);
        return (
          '<div class="flex items-center gap-3">' +
          '<span class="w-20 shrink-0 text-[11.5px] text-slate-400">' +
          escapeHtml(PLAN_LABELS[entry.plan] || entry.plan) + '</span>' +
          '<span class="h-2 flex-1 overflow-hidden rounded-full bg-white/5">' +
          '<span class="block h-full rounded-full bg-accent-500/70" style="width:' +
          Math.max(entry.count ? 3 : 0, width) + '%"></span></span>' +
          '<span class="num w-8 shrink-0 text-right text-[11.5px] text-slate-300">' +
          entry.count + '</span></div>'
        );
      })
      .join('') +
    '</div></div>'
  );
}

async function loadOperatorOverview() {
  const headline = $('#operator-headline');
  const charts = $('#operator-charts');
  if (!headline || !charts) return;

  headline.innerHTML =
    '<p class="col-span-full px-1 py-6 text-[12.5px] text-slate-500">Зареждам…</p>';
  charts.innerHTML = '';

  let data;
  try {
    const response = await fetch(ENDPOINTS.adminOverview + '?days=' + operatorRange, {
      headers: operatorHeaders(),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    data = await response.json();
  } catch (error) {
    headline.innerHTML =
      '<p class="col-span-full px-1 py-6 text-[12.5px] text-red-400">' +
      escapeHtml(failureText(error, 'Прегледът не се зареди')) + '</p>';
    return;
  }

  const customers = data.customers;
  const events = data.events;
  const scrape = data.scrape;

  headline.innerHTML =
    headlineTile(
      'Клиенти',
      customers.total,
      customers.active + ' активни · ' + customers.newInWindow + ' нови за ' + data.days + ' дни',
    ) +
    headlineTile(
      'В проба',
      customers.onTrial,
      customers.pending + ' чакат плащане',
    ) +
    headlineTile(
      'Следени артикули',
      data.workload.products,
      data.workload.competitors + ' обявени цени при ' + data.workload.shops + ' доставчика',
    ) +
    headlineTile(
      'Необработени плащания',
      events.unprocessed,
      events.total + ' събития общо',
      events.unprocessed > 0 ? 'amber' : null,
    );

  // Badges live on the rail, so a problem on a screen you are not looking at
  // still reaches you. Sourced from the overview because it is the one call
  // that already knows all three numbers.
  paintOperatorBadges({
    payments: events.unprocessed,
    scrape: scrape.failed,
    alerts: 0,
  });
  stampUpdated();

  const signupTotal = data.signups.reduce((sum, point) => sum + point.count, 0);
  const billingTotal = data.billing.reduce((sum, point) => sum + point.received, 0);

  charts.innerHTML =
    chartCard(
      'Регистрации',
      'по дни, последните ' + data.days,
      signupTotal,
      data.signups.map((point) => ({ day: point.day, value: point.count })),
      '#2dd4bf',
    ) +
    chartCard(
      'Плащания от Stripe',
      'webhook-и по дни; червеното не е свършило работа',
      billingTotal,
      data.billing.map((point) => ({
        day: point.day,
        value: point.received,
        bad: point.unprocessed,
      })),
      '#818cf8',
    ) +
    planBars(customers.byPlan) +
    '<div class="rounded-xl border border-white/8 bg-ink-900 p-3.5 shadow-panel">' +
    '<p class="text-[12.5px] font-semibold text-slate-200">Състояние на обиколката</p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">Последната проверка на всяка следена обява.</p>' +
    '<div class="mt-4 grid grid-cols-3 gap-3 text-center">' +
    '<div><p class="num text-[17px] font-bold text-emerald-400">' + scrape.ok + '</p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">успешни</p></div>' +
    '<div><p class="num text-[17px] font-bold ' +
    (scrape.failed ? 'text-red-400' : 'text-slate-300') + '">' + scrape.failed + '</p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">с грешка</p></div>' +
    '<div><p class="num text-[17px] font-bold ' +
    (scrape.stale ? 'text-amber-300' : 'text-slate-300') + '">' + scrape.stale + '</p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">без проверка &gt;24ч</p></div>' +
    '</div></div>';
}

async function loadOperatorEvents() {
  const target = $('#operator-events');
  if (!target) return;

  const onlyUnprocessed = $('#operator-events-unprocessed').checked;
  target.innerHTML = '<p class="px-4 py-8 text-center text-[12.5px] text-slate-500">Зареждам…</p>';

  let events;
  try {
    const response = await fetch(
      ENDPOINTS.adminEvents + '?limit=100' + (onlyUnprocessed ? '&unprocessed=true' : ''),
      { headers: operatorHeaders() },
    );
    if (!response.ok) throw new Error('HTTP ' + response.status);
    events = await response.json();
  } catch (error) {
    target.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-red-400">' +
      escapeHtml(failureText(error, 'Плащанията не се заредиха')) + '</p>';
    return;
  }

  if (!events.length) {
    target.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-slate-500">' +
      (onlyUnprocessed
        ? 'Няма необработени събития. Всичко, което е дошло, е свършило работа.'
        : 'Няма получени събития. Докато Stripe не е свързан, тук е празно.') +
      '</p>';
    return;
  }

  target.innerHTML =
    '<div class="overflow-x-auto"><table class="op-table w-full text-left text-[12.5px]">' +
    '<thead><tr class="border-b border-white/8 text-[10px] uppercase tracking-wide text-slate-500">' +
    '<th class="px-4 py-3 font-semibold">Кога</th>' +
    '<th class="px-4 py-3 font-semibold">Събитие</th>' +
    '<th class="px-4 py-3 font-semibold">Имейл</th>' +
    '<th class="px-4 py-3 font-semibold">Състояние</th>' +
    '<th class="px-4 py-3 font-semibold">Данни</th></tr></thead><tbody>' +
    events
      .map(function (event) {
        // A note is written both when handling failed and when the event was
        // one we deliberately ignore, so it colours nothing on its own — it
        // is the explanation printed under whichever state applies.
        const state = event.processed
          ? '<span class="rounded-md bg-emerald-500/12 px-2 py-0.5 text-[11px] text-emerald-400">обработено</span>'
          : '<span class="rounded-md bg-amber-500/12 px-2 py-0.5 text-[11px] text-amber-400">необработено</span>';

        return (
          '<tr class="border-b border-white/5 align-top">' +
          '<td data-label="Кога" class="whitespace-nowrap px-4 py-3 text-slate-400">' +
          escapeHtml(formatRelative(event.receivedAt)) + '</td>' +
          '<td data-label="Събитие" class="px-4 py-3 font-mono text-[11.5px] text-slate-300">' +
          escapeHtml(event.eventType || '—') + '</td>' +
          '<td data-label="Имейл" class="px-4 py-3 text-slate-400">' + escapeHtml(event.email || '—') + '</td>' +
          '<td data-label="Състояние" class="px-4 py-3">' + state +
          (event.note
            ? '<p class="mt-1 max-w-xs text-[11px] ' +
              (event.processed ? 'text-slate-500' : 'text-amber-400/80') + '">' +
              escapeHtml(event.note) + '</p>'
            : '') +
          '</td>' +
          // Collapsed by default: the payload is the reason this screen
          // exists and also the reason it cannot be the default view — one
          // Stripe object is longer than the rest of the row put together.
          '<td data-label="Данни" class="px-4 py-3">' +
          '<details><summary class="cursor-pointer text-[11.5px] text-slate-500 hover:text-slate-300">покажи</summary>' +
          '<pre class="mt-2 max-h-64 max-w-xl overflow-auto rounded-lg bg-ink-950 p-3 text-[11px] leading-relaxed text-slate-400">' +
          escapeHtml(JSON.stringify(event.payload, null, 2)) + '</pre></details></td></tr>'
        );
      })
      .join('') +
    '</tbody></table></div>';
}

const OUTREACH_STATUS = {
  sent: { label: 'писано', class: 'bg-white/[0.06] text-slate-400' },
  replied: { label: 'отговориха', class: 'bg-amber-500/12 text-amber-400' },
  granted: { label: 'дадоха достъп', class: 'bg-emerald-500/12 text-emerald-400' },
  declined: { label: 'отказаха', class: 'bg-red-500/12 text-red-400' },
};

/** Host -> the letter we sent it, so the table can say so instead of
 *  offering to write again. */
let outreachByHost = {};

async function loadOperatorShops() {
  const target = $('#operator-shops');
  if (!target) return;

  target.innerHTML = '<p class="px-4 py-8 text-center text-[12.5px] text-slate-500">Зареждам…</p>';

  let shops;
  let outreach;
  try {
    // Together: the table is one thing and half of it is not worth drawing.
    const [shopsResponse, outreachResponse] = await Promise.all([
      fetch(ENDPOINTS.adminShops, { headers: operatorHeaders() }),
      fetch(ENDPOINTS.adminOutreach, { headers: operatorHeaders() }),
    ]);
    if (!shopsResponse.ok) throw new Error('HTTP ' + shopsResponse.status);
    if (!outreachResponse.ok) throw new Error('HTTP ' + outreachResponse.status);

    shops = await shopsResponse.json();
    outreach = await outreachResponse.json();
  } catch (error) {
    target.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-red-400">' +
      escapeHtml(failureText(error, 'Сайтовете не се заредиха')) + '</p>';
    return;
  }

  outreachByHost = {};
  outreach.forEach(function (record) {
    outreachByHost[record.host] = record;
  });

  paletteHosts = shops.map((shop) => shop.host);

  if (!shops.length) {
    target.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-slate-500">' +
      'Още никой клиент не е добавил доставчик.</p>';
    return;
  }

  target.innerHTML =
    '<div class="overflow-x-auto"><table class="op-table w-full text-left text-[12.5px]">' +
    '<thead><tr class="border-b border-white/8 text-[10px] uppercase tracking-wide text-slate-500">' +
    '<th class="px-4 py-3 font-semibold">Сайт</th>' +
    '<th class="px-4 py-3 font-semibold">Клиенти</th>' +
    '<th class="px-4 py-3 font-semibold">Търсене</th>' +
    '<th class="px-4 py-3 font-semibold">Последно</th>' +
    '<th class="px-4 py-3 font-semibold">Проблем</th>' +
    '<th class="px-4 py-3 font-semibold">API достъп</th></tr></thead><tbody>' +
    shops
      .map(function (shop) {
        const problem = shop.blockedReason || shop.lastError;
        const record = outreachByHost[shop.host];

        // A supplier with no website has no API to ask for — the prices come
        // in as a spreadsheet the customer uploads. Offering to write to them
        // about a feed would be asking for something that cannot exist.
        const outreachCell = !shop.hasWebsite
          ? '<span class="text-[11.5px] text-slate-600">няма сайт</span>'
          : record
            ? '<div class="flex flex-col gap-1.5">' +
              '<select data-outreach-status="' + escapeHtml(record.id) + '" ' +
              'class="rounded-lg border border-white/10 bg-ink-850 px-2 py-1 text-[11.5px] ' +
              escapeHtml((OUTREACH_STATUS[record.status] || OUTREACH_STATUS.sent).class) + '">' +
              Object.keys(OUTREACH_STATUS)
                .map(
                  (key) =>
                    '<option value="' + key + '"' + (key === record.status ? ' selected' : '') +
                    '>' + escapeHtml(OUTREACH_STATUS[key].label) + '</option>',
                )
                .join('') +
              '</select>' +
              '<span class="text-[11px] text-slate-600" title="' +
              escapeHtml(record.recipient) + '">' +
              escapeHtml(formatRelative(record.sentAt)) + ' · ' + escapeHtml(record.locale) +
              '</span></div>'
            : '<button type="button" data-outreach-host="' + escapeHtml(shop.host) + '" ' +
              'class="rounded-lg border border-white/10 bg-ink-850 px-3 py-1.5 text-[11.5px] font-medium text-slate-300 transition hover:border-accent-500/40 hover:text-accent-300">' +
              '<i class="fa-solid fa-handshake mr-1.5 text-[11px]"></i>Поискай</button>';

        return (
          '<tr class="border-b border-white/5">' +
          // Most suppliers are named after their domain, and printing
          // "homefinishing.bg" over "homefinishing.bg" is a wasted line in
          // every row. The host goes underneath only when it adds something.
          '<td data-label="Сайт" class="px-4 py-3"><p class="font-medium text-slate-200">' +
          escapeHtml(shop.name || shop.host) + '</p>' +
          (shop.name && shop.name !== shop.host
            ? '<p class="font-mono text-[11px] text-slate-500">' + escapeHtml(shop.host) + '</p>'
            : '') +
          '</td>' +
          '<td data-label="Клиенти" class="num px-4 py-3 text-slate-300">' + shop.owners +
          (shop.active < shop.owners
            ? '<span class="ml-1 text-[11px] text-slate-500">(' + shop.active + ' вкл.)</span>'
            : '') + '</td>' +
          '<td data-label="Търсене" class="px-4 py-3 text-slate-400">' +
          (shop.hasWebsite
            ? escapeHtml(shop.searchMethod)
            : '<span class="text-slate-500">ръчен ценоразпис · ' + shop.manualPrices + ' цени</span>') +
          '</td>' +
          '<td data-label="Последно" class="whitespace-nowrap px-4 py-3 text-slate-400">' +
          escapeHtml(shop.lastSearchedAt ? formatRelative(shop.lastSearchedAt) : '—') + '</td>' +
          '<td data-label="Проблем" class="px-4 py-3">' +
          (problem
            ? '<span class="text-[11.5px] text-amber-400/90" title="' + escapeHtml(problem) + '">' +
              escapeHtml(problem.length > 60 ? problem.slice(0, 60) + '…' : problem) + '</span>'
            : '<span class="text-slate-600">—</span>') +
          '</td>' +
          '<td data-label="API достъп" class="px-4 py-3">' + outreachCell + '</td></tr>'
        );
      })
      .join('') +
    '</tbody></table></div>';

  $$('[data-outreach-host]').forEach(function (button) {
    button.addEventListener('click', () => void openOutreach(button.dataset.outreachHost));
  });

  $$('[data-outreach-status]').forEach(function (select) {
    select.addEventListener('change', () =>
      void recordOutreachOutcome(select.dataset.outreachStatus, select.value),
    );
  });
}

/* --- Asking a supplier for a feed ----------------------------------- *
 *
 * The only letter this system sends to somebody who never signed up for
 * it. So it is composed on the server, shown in full, and sent only when
 * a person has read it and pressed the button — never as a side effect
 * of clicking a row.
 * ------------------------------------------------------------------- */

let outreachHost = null;

function showOutreachStatus(message, tone) {
  const element = $('#outreach-status');
  element.textContent = message;
  element.className =
    'text-[11.5px] ' +
    (tone === 'error' ? 'text-red-400' : tone === 'success' ? 'text-emerald-400' : 'text-slate-400');
  element.classList.remove('hidden');
}

/** Fetches the draft and fills the form. Called again when the language
 *  changes, which is why the warning about losing edits is on the label. */
async function loadOutreachDraft(host, locale) {
  showOutreachStatus('Съставям писмото…', 'info');

  try {
    const response = await fetch(ENDPOINTS.adminOutreachPreview, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, operatorHeaders()),
      body: JSON.stringify(locale ? { host, locale } : { host }),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const draft = await response.json();

    $('#outreach-locale').value = draft.locale;
    $('#outreach-locale-reason').textContent = draft.localeReason;
    $('#outreach-subject').value = draft.subject;
    $('#outreach-body').value = draft.body;
    $('#outreach-context').textContent =
      draft.buyers > 1
        ? host + ' — ' + draft.buyers + ' клиенти следят този сайт.'
        : draft.buyers === 1
          ? host + ' — един клиент следи този сайт.'
          : host;

    // Shown, never filled in. The address a customer gave us was for sending
    // *their* orders to this supplier; using it for our own approach is a
    // different purpose, and it should be a decision, not a default.
    $('#outreach-hint').textContent = draft.knownOrderEmail
      ? 'Клиент е посочил ' + draft.knownOrderEmail + ' за поръчки. Той е за друга цел — попълни адрес сам.'
      : 'Вземи адреса от страницата за контакти на сайта.';

    $('#outreach-status').classList.add('hidden');
  } catch (error) {
    showOutreachStatus(failureText(error, 'Черновата не се състави'), 'error');
  }
}

async function openOutreach(host) {
  outreachHost = host;
  $('#outreach-recipient').value = '';
  $('#outreach-status').classList.add('hidden');
  openModal('outreach-modal');
  await loadOutreachDraft(host, null);
}

$('#outreach-locale').addEventListener('change', function () {
  if (outreachHost) void loadOutreachDraft(outreachHost, this.value);
});

$('#outreach-form').addEventListener('submit', async function (event) {
  event.preventDefault();
  if (!outreachHost) return;

  $('#outreach-send-spinner').classList.remove('hidden');
  $('#outreach-send-icon').classList.add('hidden');
  showOutreachStatus('Изпращам…', 'info');

  try {
    const response = await fetch(ENDPOINTS.adminOutreach, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, operatorHeaders()),
      body: JSON.stringify({
        host: outreachHost,
        recipient: $('#outreach-recipient').value.trim(),
        locale: $('#outreach-locale').value,
        subject: $('#outreach-subject').value.trim(),
        body: $('#outreach-body').value,
      }),
    });

    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      showOutreachStatus(
        (problem && problem.message) || 'Писмото не тръгна (HTTP ' + response.status + ').',
        'error',
      );
      return;
    }

    toast('Писмото тръгна към ' + outreachHost + '.', 'success');
    closeModal('outreach-modal');
    await loadOperatorShops();
  } catch (error) {
    showOutreachStatus(failureText(error, 'Писмото не тръгна'), 'error');
  } finally {
    $('#outreach-send-spinner').classList.add('hidden');
    $('#outreach-send-icon').classList.remove('hidden');
  }
});

/** Records what came back. Saved on change, like the customer rows: a
 *  choice already made is the answer, and a confirmation on top of it is
 *  a click nobody reads twice. */
async function recordOutreachOutcome(id, status) {
  try {
    const response = await fetch(ENDPOINTS.adminOutreach + '/' + id, {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, operatorHeaders()),
      body: JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    await loadOperatorShops();
  } catch (error) {
    toast(failureText(error, 'Промяната не се записа'), 'error');
  }
}

/* --- Sections, ranges, and keeping the screen current ---------------- */

const OPERATOR_TABS = [
  'overview',
  'scrape',
  'alerts',
  'search',
  'customers',
  'decisions',
  'payments',
  'shops',
];

/** How often the panel re-reads itself when live mode is on. Thirty seconds:
 *  long enough that a row is not moving under the pointer, short enough that
 *  a webhook arriving during a support call shows up while still on it. */
const LIVE_INTERVAL_MS = 30000;

let operatorRange = 30;
let liveTimer = null;

/** Counts worth a badge on the rail, so a problem on a screen you are not
 *  looking at still reaches you. Refreshed with the overview. */
function paintOperatorBadges(counts) {
  $$('[data-op-badge]').forEach(function (badge) {
    const value = counts[badge.dataset.opBadge] || 0;
    badge.textContent = value > 99 ? '99+' : String(value);
    badge.hidden = value === 0;
  });
}

function stampUpdated() {
  const element = $('#operator-updated');
  if (!element) return;

  const now = new Date();
  element.textContent =
    'обновено ' +
    now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0') +
    ':' + String(now.getSeconds()).padStart(2, '0');
}

function setLive(on) {
  const button = $('#operator-live');
  const dot = $('#operator-live-dot');

  button.setAttribute('aria-pressed', on ? 'true' : 'false');
  dot.classList.toggle('op-live-on', on);
  button.classList.toggle('border-emerald-500/30', on);
  button.classList.toggle('text-emerald-300', on);

  if (liveTimer) {
    window.clearInterval(liveTimer);
    liveTimer = null;
  }

  // Only while the panel is actually on screen. A timer left running behind
  // another view is a request every thirty seconds for a screen nobody is
  // reading, and the first thing to blame when the log looks busy.
  if (on) {
    liveTimer = window.setInterval(function () {
      if ($('#view-operator').hidden) return;
      void loadOperatorHealth();
      void loadOperatorTab(operatorTab, { quiet: true });
    }, LIVE_INTERVAL_MS);
  }
}

$('#operator-live').addEventListener('click', function () {
  setLive(this.getAttribute('aria-pressed') !== 'true');
});

$$('[data-op-range]').forEach(function (button) {
  button.addEventListener('click', function () {
    operatorRange = Number(button.dataset.opRange);
    $$('[data-op-range]').forEach((other) =>
      other.classList.toggle('tab-active', other === button),
    );
    void loadOperatorOverview();
  });
});

/** Loads one section. `quiet` skips the spinner, so a live refresh does not
 *  blank a table the operator is reading. */
function loadOperatorTab(name, options) {
  const quiet = Boolean(options && options.quiet);

  if (name === 'overview') return loadOperatorOverview();
  if (name === 'scrape') return loadOperatorScrape(quiet);
  if (name === 'alerts') return loadOperatorAlerts(quiet);
  if (name === 'search') return loadOperatorSearchQuality();
  if (name === 'customers') return loadOperatorCustomers();
  if (name === 'decisions') return loadOperatorDecisions();
  if (name === 'payments') return loadOperatorEvents();
  if (name === 'shops') return loadOperatorShops();

  return Promise.resolve();
}

/**
 * How search is behaving, in numbers.
 *
 * The honest version of "is the new engine better": how often a query
 * produces a strong match, how often it produces nothing at all, how much of
 * the work arithmetic settles without paying a model, and how often a
 * supplier has to be asked a second, wider question.
 */
async function loadOperatorSearchQuality() {
  const box = $('#operator-search-quality');
  if (!box) return;

  try {
    const response = await fetch(ENDPOINTS.adminSearchQuality, { headers: operatorHeaders() });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const stats = await response.json();

    if (!stats.samples) {
      box.innerHTML =
        '<div class="sm:col-span-2 xl:col-span-4 rounded-xl border border-white/8 bg-ink-900 px-4 py-8 text-center text-[12.5px] text-slate-500 shadow-panel">' +
        'Още няма търсения в прозореца. Числата се пълнят от живия трафик и се нулират при разгръщане.</div>';
      return;
    }

    const percent = (value) => Math.round(value * 100) + '%';

    const tiles = [
      ['Силни съвпадения', percent(stats.strongMatchRate), 'търсения с поне един сигурен резултат'],
      ['Без резултат', percent(stats.zeroResultRate), 'търсения, върнали нищо'],
      ['Решено без модел', percent(stats.deterministicRate), 'сравнения, отговорени с аритметика'],
      ['Разширена заявка', percent(stats.queryWideningRate), 'търсения с втори, по-широк въпрос'],
      ['Покритие на доставчици', percent(stats.supplierCoverage), 'запитани магазини, които отговориха'],
      ['Конфликти', percent(stats.conflictRate), 'кандидати, отхвърлени по спецификация'],
      ['Средна увереност', Math.round(stats.averageConfidence * 100) + '%', 'на най-добрия резултат'],
      ['Време', stats.durationMs.average + ' ms', 'средно, при ' + stats.durationMs.p95 + ' ms за 95-и процентил'],
    ];

    box.innerHTML = tiles
      .map(
        ([label, value, note]) =>
          '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-2.5 shadow-panel">' +
          '<p class="text-[11px] uppercase tracking-wide text-slate-500">' + escapeHtml(label) + '</p>' +
          '<p class="mt-1 num text-[17px] font-bold text-slate-200">' + escapeHtml(value) + '</p>' +
          '<p class="mt-1 text-[11px] text-slate-500">' + escapeHtml(note) + '</p>' +
          '</div>',
      )
      .join('');
  } catch (error) {
    box.innerHTML = failureHtml(error, 'Показателите за търсене не се заредиха');
  }
}

/**
 * One search, traced end to end.
 *
 * Every stage in the order it happened: what was typed, what the engine read
 * out of it, what each supplier was asked and answered, and then for every
 * candidate the relation, the confidence, what agreed, what neither side
 * mentioned and what ruled it out. This is what turns "search is broken" into
 * a specific, fixable sentence.
 */
async function runSearchTrace(signal) {
  const box = $('#operator-search-trace');
  const query = $('#operator-search-query').value.trim();
  if (!box || query.length < 2) return;

  const owner = $('#operator-search-owner').value.trim();
  const ai = $('#operator-search-ai').checked;

  box.innerHTML =
    '<div class="rounded-xl border border-white/8 bg-ink-900 px-4 py-8 text-center text-[12.5px] text-slate-500 shadow-panel">' +
    '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Пита доставчиците на живо…</div>';

  try {
    const url =
      ENDPOINTS.adminSearchDebug +
      '?q=' + encodeURIComponent(query) +
      (owner ? '&ownerId=' + encodeURIComponent(owner) : '') +
      (ai ? '&ai=true' : '');

    const response = await fetch(url, { headers: operatorHeaders(), signal: signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    box.innerHTML = renderSearchTrace(await response.json());
  } catch (error) {
    box.innerHTML = wasAborted(error)
      ? '<p class="text-[12.5px] text-slate-500">Проследяването е спряно.</p>'
      : failureHtml(error, 'Проследяването не успя');
  }
}

function renderSearchTrace(trace) {
  if (!trace) return '';

  const stage = (title, body) =>
    '<div class="overflow-hidden rounded-xl border border-white/8 bg-ink-900 shadow-panel">' +
    '<div class="border-b border-white/8 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-accent-400">' +
    escapeHtml(title) +
    '</div><div class="px-4 py-2.5 text-[11.5px] text-slate-300">' + body + '</div></div>';

  const chip = (label, value) =>
    '<span class="rounded-md bg-ink-950 px-2 py-1 text-[11px] text-slate-300 ring-1 ring-white/8">' +
    '<span class="text-slate-500">' + escapeHtml(label) + ':</span> ' + escapeHtml(String(value)) +
    '</span>';

  const understood = trace.understood || {};
  const attributes = understood.attributes || {};

  const readChips = [
    understood.productType ? chip('Вид', understood.productType) : '',
    understood.brand ? chip('Марка', understood.brand) : '',
    understood.requestedQuantity ? chip('Количество', understood.requestedQuantity) : '',
  ]
    .concat(
      Object.keys(attributes).map((key) =>
        chip(attributeLabel(key, attributes[key].label), attributes[key].value),
      ),
    )
    .join('');

  const variants = (trace.variants || [])
    .map(
      (variant) =>
        '<li class="flex flex-wrap items-baseline gap-2 py-1">' +
        '<code class="rounded bg-ink-950 px-1.5 py-0.5 text-[11.5px] text-slate-200">' +
        escapeHtml(variant.query) + '</code>' +
        '<span class="text-[11px] uppercase tracking-wide text-slate-600">' + escapeHtml(variant.kind) + '</span>' +
        '<span class="text-[11px] text-slate-500">' + escapeHtml(variant.reason) + '</span></li>',
    )
    .join('');

  const shops = (trace.shops || [])
    .map(
      (shop) =>
        '<tr class="border-t border-white/5">' +
        '<td class="py-2 pr-3 text-slate-200">' + escapeHtml(shop.name) + '</td>' +
        '<td class="py-2 pr-3"><code class="text-[11px] text-slate-400">' + escapeHtml(shop.usedQuery) + '</code></td>' +
        '<td class="py-2 pr-3 num text-right">' + shop.products.length + '</td>' +
        '<td class="py-2 pr-3 num text-right text-slate-500">' + shop.durationMs + ' ms</td>' +
        '<td class="py-2 text-[11px] ' + (shop.ok ? 'text-emerald-400' : 'text-rose-400') + '">' +
        escapeHtml(shop.ok ? 'отговори' : shop.error || 'отказа') + '</td></tr>',
    )
    .join('');

  const attributeLines = (entries, mark) =>
    (entries || [])
      .map(
        (entry) =>
          '<li>' + mark + ' ' + escapeHtml(attributeLabel(entry.key, entry.label)) +
          ': ' + escapeHtml(entry.query || '—') + ' / ' + escapeHtml(entry.candidate || '—') + '</li>',
      )
      .join('');

  const candidates = (trace.candidates || [])
    .map(
      (candidate) =>
        '<div class="border-t border-white/5 py-3">' +
        '<div class="flex flex-wrap items-baseline gap-2">' +
        '<span class="font-medium text-slate-200">' + escapeHtml(candidate.name) + '</span>' +
        '<span class="rounded-md bg-ink-950 px-1.5 py-0.5 text-[11px] text-slate-400 ring-1 ring-white/8">' +
        escapeHtml(candidate.shop) + '</span>' +
        '<span class="rounded-md px-1.5 py-0.5 text-[11px] font-semibold ' +
        (candidate.group === 'strong'
          ? 'bg-emerald-500/12 text-emerald-400'
          : candidate.group === 'excluded'
            ? 'bg-rose-500/12 text-rose-300'
            : 'bg-amber-500/12 text-amber-400') +
        '">' + escapeHtml(candidate.relation) + ' ' + Math.round(candidate.confidence * 100) + '%</span>' +
        '<span class="text-[11px] uppercase tracking-wide text-slate-600">' + escapeHtml(candidate.method) + '</span>' +
        '<span class="ml-auto num text-slate-400">' +
        (candidate.effectivePrice === null ? '—' : candidate.effectivePrice.toFixed(2) + ' ' + escapeHtml(candidate.currency)) +
        '</span></div>' +
        '<p class="mt-1 text-[11.5px] text-slate-400">' + escapeHtml(candidate.explanation) + '</p>' +
        '<ul class="mt-1.5 space-y-0.5 text-[11px] text-slate-500">' +
        attributeLines(candidate.conflicts, '✕') +
        attributeLines(candidate.matched, '✓') +
        attributeLines(candidate.missing, '?') +
        '</ul></div>',
    )
    .join('');

  const matching = trace.matching || {};

  return [
    stage(
      'Заявка, както е написана',
      '<code class="rounded bg-ink-950 px-2 py-1 text-[12.5px] text-slate-200">' +
        escapeHtml(trace.query) + '</code>',
    ),
    stage('Какво разчете двигателят', '<div class="flex flex-wrap gap-1.5">' + readChips + '</div>'),
    stage('Заявки към доставчиците', '<ul class="space-y-0.5">' + variants + '</ul>'),
    stage(
      'Какво отговори всеки доставчик',
      '<div class="overflow-x-auto"><table class="w-full text-left text-[11.5px]">' +
        '<thead><tr class="text-[10px] uppercase tracking-wide text-slate-600">' +
        '<th class="pb-1 pr-3">Магазин</th><th class="pb-1 pr-3">Попитан за</th>' +
        '<th class="pb-1 pr-3 text-right">Резултати</th><th class="pb-1 pr-3 text-right">Време</th>' +
        '<th class="pb-1">Изход</th></tr></thead><tbody>' + shops + '</tbody></table></div>',
    ),
    stage(
      'Съпоставяне',
      '<p class="mb-2 text-[11.5px] text-slate-500">' +
        matching.candidates + ' кандидата · ' + matching.decidedDeterministically +
        ' решени с аритметика · ' + matching.aiCallsMade + ' заявки към модел' +
        (matching.aiModel ? ' (' + escapeHtml(matching.aiModel) + ')' : '') + '</p>' +
        (candidates || '<p class="text-slate-500">Никой кандидат не стигна до съпоставяне.</p>'),
    ),
    stage(
      'Време',
      trace.timings
        ? '<div class="grid gap-1 sm:grid-cols-2">' +
          [
            ['Разчитане на заявката', trace.timings.parse],
            ['Питане на доставчиците', trace.timings.retrieval],
            ['Подреждане', trace.timings.ranking],
            ['Съпоставяне по спецификация', trace.timings.matching],
            ['Модел', trace.timings.ai],
          ]
            .map(
              ([label, value]) =>
                '<div class="flex items-baseline justify-between gap-3">' +
                '<span class="text-slate-400">' + escapeHtml(label) + '</span>' +
                '<span class="num text-slate-300">' + Math.round(value) + ' ms</span></div>',
            )
            .join('') +
          '</div><p class="mt-2 text-[11.5px] text-slate-500">Общо ' + trace.durationMs + ' ms' +
          (trace.timings.widened ? ' · заявката е разширена веднъж' : '') +
          (trace.timings.ai === 0 ? ' · без модел' : '') + '</p>'
        : trace.durationMs + ' ms',
    ),
  ].join('');
}

/** Opens one tab, fetching it the first time it is asked for. */
function openOperatorTab(name, options) {
  const force = Boolean(options && options.force);
  if (OPERATOR_TABS.indexOf(name) === -1) name = 'overview';
  operatorTab = name;

  $$('[data-op-tab]').forEach(function (button) {
    const active = button.dataset.opTab === name;
    button.classList.toggle('tab-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');

    // On a phone the rail scrolls, and a section opened from the palette or
    // from a badge could be off the right edge — highlighted, and invisible.
    if (active && button.scrollIntoView) {
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });

  $$('[data-op-panel]').forEach(function (panel) {
    panel.hidden = panel.dataset.opPanel !== name;
  });

  const lede = $('#operator-lede');
  if (lede) lede.textContent = OPERATOR_LEDE[name] || '';

  if (!force && operatorLoaded[name]) return;
  operatorLoaded[name] = true;

  void loadOperatorTab(name);
}

$$('[data-op-tab]').forEach(function (button) {
  button.addEventListener('click', () => openOperatorTab(button.dataset.opTab));
});

const searchRun = $('#operator-search-run');
if (searchRun) {
  searchRun.addEventListener('click', function () {
    void startable(this, runSearchTrace, 'Спри');
  });

  $('#operator-search-query').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !isRunning(searchRun)) searchRun.click();
  });
}

$('#operator-events-unprocessed').addEventListener('change', () => void loadOperatorEvents());
$('#operator-alerts-undelivered').addEventListener('change', () => void loadOperatorAlerts());

['#operator-customer-search', '#operator-customer-status', '#operator-customer-plan'].forEach(
  function (selector) {
    $(selector).addEventListener('input', renderOperatorCustomers);
  },
);

/* --- Purchase decisions ---------------------------------------------- *
 *
 * The operator's view of what customers decided. The shape of each decision
 * rather than its contents: enough to answer "is the optimiser working" and
 * "is this customer getting value", and nothing that says what anybody buys.
 * The API declines to send the snapshot here for the same reason.
 */

async function loadOperatorDecisions() {
  const analyticsBox = $('#operator-decisions-analytics');
  const listBox = $('#operator-decisions');
  if (!listBox) return;

  listBox.innerHTML =
    '<p class="px-4 py-8 text-center text-[12.5px] text-slate-500">Зареждам…</p>';

  try {
    const [analytics, page] = await Promise.all([
      fetch(ENDPOINTS.adminDecisionAnalytics + '?days=' + operatorRange, {
        headers: operatorHeaders(),
      }).then(okJson),
      fetch(ENDPOINTS.adminDecisions + '?limit=50', { headers: operatorHeaders() }).then(okJson),
    ]);

    analyticsBox.innerHTML = decisionAnalyticsHtml(analytics);
    listBox.innerHTML = operatorDecisionsHtml(page);
  } catch (error) {
    analyticsBox.innerHTML = '';
    listBox.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-red-400">' +
      escapeHtml(failureText(error, 'Решенията не се заредиха')) +
      '</p>';
  }
}

function decisionAnalyticsHtml(analytics) {
  const tile = (label, value, note) =>
    '<div class="rounded-xl border border-white/8 bg-ink-900 px-3.5 py-2.5">' +
    '<p class="text-[11px] uppercase tracking-wide text-slate-500">' + escapeHtml(label) + '</p>' +
    '<p class="num mt-1 text-[17px] font-bold text-slate-200">' + escapeHtml(value) + '</p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">' + escapeHtml(note) + '</p></div>';

  const percent = (share) => (share * 100).toFixed(0) + '%';

  return (
    tile(
      'Решения',
      String(analytics.decisions),
      analytics.customers + ' ' + plural(analytics.customers, 'клиент', 'клиента') +
        ' за ' + analytics.days + ' дни',
    ) +
    tile(
      'Със спестяване',
      percent(analytics.shareWithSavings),
      analytics.averageSavingsPercent === null
        ? 'няма средно'
        : 'средно ' + analytics.averageSavingsPercent.toFixed(1) + '%',
    ) +
    tile(
      'Разделени поръчки',
      percent(analytics.shareSplit),
      percent(analytics.shareSingleSupplier) + ' при един доставчик',
    ) +
    tile(
      'Стигнали до поръчка',
      String(analytics.decisionsWithOrders),
      analytics.ordersPlaced + ' ' + plural(analytics.ordersPlaced, 'поръчка', 'поръчки'),
    ) +
    tile(
      'Възможно спестяване',
      money2(analytics.potentialSavings),
      'решения без потвърдена покупка',
    ) +
    tile('Доказано спестено', money2(analytics.realizedSavings), 'по потвърдени поръчки') +
    tile(
      'Средна заявка',
      analytics.averageBasketLines === null ? '—' : analytics.averageBasketLines.toFixed(1),
      'реда · ' +
        (analytics.averageSuppliersUsed === null
          ? '—'
          : analytics.averageSuppliersUsed.toFixed(1) + ' доставчика'),
    ) +
    tile(
      'Оптимизация',
      analytics.averageDurationMs === null
        ? '—'
        : (analytics.averageDurationMs / 1000).toFixed(1) + ' с',
      // Worth a glance rather than an alarm: a capped search still returns the
      // best of what it tried, and says so on the decision itself.
      'ограничено търсене при ' + percent(analytics.shareBoundedSearch),
    )
  );
}

function operatorDecisionsHtml(page) {
  if (!page.items.length) {
    return (
      '<p class="rounded-xl border border-white/8 bg-ink-900 px-4 py-6 text-center text-[12.5px] text-slate-500">' +
      'Още никой не е запазил решение.</p>'
    );
  }

  const rows = page.items
    .map(function (decision) {
      const proven = decision.savingsKind === 'realized';
      const saving = proven ? decision.realizedSavings : decision.savings;

      // Flags rather than columns: they are exceptions, and a column of
      // mostly-empty cells makes the table harder to scan than the four or
      // five rows a week that actually carry one.
      const flags = []
        .concat(decision.boundedSearch ? ['ограничено търсене'] : [])
        .concat(
          decision.unassignedLines > 0
            ? [decision.unassignedLines + ' ' + plural(decision.unassignedLines, 'ред без доставчик', 'реда без доставчик')]
            : [],
        )
        .concat(decision.baselineTotal === null ? ['без база за сравнение'] : []);

      return (
        '<tr class="border-b border-white/[0.05] last:border-b-0">' +
        '<td class="px-3 py-2 text-[11.5px] text-slate-500">' +
        escapeHtml(formatAbsolute(decision.createdAt)) +
        '</td>' +
        '<td class="px-3 py-2 text-[11.5px] text-slate-300">' +
        escapeHtml(decision.customerEmail || decision.ownerId) +
        '<span class="ml-1.5 text-[11px] text-slate-600">#' + decision.number + '</span>' +
        (flags.length
          ? '<p class="mt-0.5 text-[10px] text-amber-300/70">' +
            escapeHtml(flags.join(' · ')) + '</p>'
          : '') +
        '</td>' +
        '<td class="px-3 py-2 text-right text-[11.5px] text-slate-400">' +
        decision.lineCount + ' / ' + decision.suppliersUsed +
        '</td>' +
        '<td class="num px-3 py-2 text-right text-[11.5px] text-slate-500">' +
        money2(decision.baselineTotal) + '</td>' +
        '<td class="num px-3 py-2 text-right text-[11.5px] text-slate-300">' +
        money2(decision.optimisedTotal) + '</td>' +
        '<td class="num px-3 py-2 text-right text-[11.5px] font-semibold ' +
        (proven ? 'text-emerald-400' : 'text-slate-300') + '">' +
        money2(saving) +
        '<span class="ml-1 text-[10px] font-normal ' +
        (proven ? 'text-emerald-400/70' : 'text-slate-600') + '">' +
        (proven ? 'док.' : 'възм.') + '</span></td>' +
        '<td class="px-3 py-2 text-right text-[11.5px] text-slate-400">' +
        (decision.ordersLinked
          ? decision.ordersConfirmed + ' / ' + decision.ordersLinked
          : '—') +
        '</td>' +
        '<td class="num px-3 py-2 text-right text-[11px] text-slate-600">' +
        (decision.durationMs / 1000).toFixed(1) + ' с' +
        (decision.combinationsEvaluated !== null
          ? '<span class="ml-1 text-[10px]">· ' + decision.combinationsEvaluated + ' комб.</span>'
          : '') +
        '</td></tr>'
      );
    })
    .join('');

  return (
    '<div class="overflow-x-auto rounded-xl border border-white/8">' +
    '<table class="w-full min-w-[860px] border-collapse">' +
    '<thead><tr class="border-b border-white/8 bg-ink-950/50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">' +
    '<th class="px-3 py-2 text-left">Дата</th>' +
    '<th class="px-3 py-2 text-left">Клиент</th>' +
    '<th class="px-3 py-2 text-right">Реда / дост.</th>' +
    '<th class="px-3 py-2 text-right">База</th>' +
    '<th class="px-3 py-2 text-right">Избрано</th>' +
    '<th class="px-3 py-2 text-right">Спестено</th>' +
    '<th class="px-3 py-2 text-right">Поръчки</th>' +
    '<th class="px-3 py-2 text-right">Оптимизация</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    (page.total > page.items.length
      ? '<p class="mt-2 text-[11px] text-slate-600">' +
        escapeHtml('Показани са последните ' + page.items.length + ' от ' + page.total + '.') +
        '</p>'
      : '')
  );
}

/* --- The sweep ------------------------------------------------------- */

async function loadOperatorScrape(quiet) {
  const target = $('#operator-scrape');
  if (!target) return;

  if (!quiet) {
    target.innerHTML = '<p class="px-4 py-8 text-center text-[12.5px] text-slate-500">Зареждам…</p>';
  }

  let report;
  try {
    const response = await fetch(ENDPOINTS.adminScrape, { headers: operatorHeaders() });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    report = await response.json();
  } catch (error) {
    target.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-red-400">' +
      escapeHtml(failureText(error, 'Обиколката не се зареди')) + '</p>';
    return;
  }

  const status = report.status;
  const last = status.lastRun;

  const fact = (label, value, tone) =>
    '<div><p class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">' +
    escapeHtml(label) + '</p><p class="num mt-1 text-[13px] font-medium ' +
    (tone === 'amber' ? 'text-amber-300' : tone === 'good' ? 'text-emerald-400' : 'text-slate-200') +
    '">' + escapeHtml(String(value)) + '</p></div>';

  target.innerHTML =
    '<div class="rounded-xl border border-white/8 bg-ink-900 p-3.5 shadow-panel">' +
    '<div class="flex flex-wrap items-start justify-between gap-3">' +
    '<div><p class="text-[12.5px] font-semibold text-slate-200">Планирана обиколка</p>' +
    '<p class="mt-0.5 text-[11px] text-slate-500">' +
    (status.enabled ? 'по график ' : 'спряна · графикът беше ') +
    '<code class="font-mono text-slate-400">' + escapeHtml(status.cron) + '</code>' +
    ' · четец <code class="font-mono text-slate-400">' + escapeHtml(status.driver) + '</code></p></div>' +
    '<button type="button" id="operator-sweep" ' +
    'class="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-ink-850 px-3.5 py-2.5 text-[12.5px] font-medium text-slate-300 transition hover:border-accent-500/40">' +
    '<i class="fa-solid fa-play text-[11px]"></i>Пусни сега</button></div>' +
    '<div class="mt-3.5 grid grid-cols-2 gap-3 sm:grid-cols-4">' +
    fact('Изпълнява се', status.running ? 'да' : 'не', status.running ? 'good' : null) +
    fact('Чакат ред', status.dueNow, status.dueNow > 0 ? 'amber' : null) +
    fact('Последна', status.lastRunAt ? formatRelative(status.lastRunAt) : 'още не е минала',
      status.lastRunAt ? null : 'amber') +
    fact('Робот', status.respectRobots ? 'спазва robots.txt' : 'пренебрегва robots.txt',
      status.respectRobots ? null : 'amber') +
    '</div>' +
    (last
      ? '<div class="mt-3.5 border-t border-white/8 pt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">' +
        fact('Проверени', last.processed) +
        fact('Успешни', last.succeeded, 'good') +
        fact('Провалени', last.failed, last.failed > 0 ? 'amber' : null) +
        fact('Сменена цена', last.changed) +
        '</div>'
      : '') +
    '</div>' +

    // Failures first and grouped: a retailer that changed its markup breaks
    // every listing on it at once, so the host is the fix, not the listing.
    '<div class="mt-4 overflow-hidden rounded-xl border border-white/8 bg-ink-900 shadow-panel">' +
    '<p class="border-b border-white/8 px-4 py-2.5 text-[12.5px] font-semibold text-slate-200">' +
    'Провали по сайт</p>' +
    (report.failures.length
      ? '<div class="overflow-x-auto"><table class="op-table w-full text-left text-[12.5px]"><tbody>' +
        report.failures
          .map(
            (failure) =>
              '<tr class="border-b border-white/5"><td data-label="Сайт" class="px-4 py-3 font-mono text-[11.5px] text-slate-300">' +
              escapeHtml(failure.host) + '</td>' +
              '<td data-label="Обхват" class="num px-4 py-3 text-slate-400">' + failure.listings + ' обяви · ' +
              failure.attempts + ' опита</td>' +
              '<td data-label="Грешка" class="px-4 py-3 text-[11.5px] text-amber-400/90">' +
              escapeHtml(failure.lastError || '—') + '</td>' +
              '<td data-label="Последно" class="whitespace-nowrap px-4 py-3 text-[11.5px] text-slate-500">' +
              escapeHtml(failure.lastCheckedAt ? formatRelative(failure.lastCheckedAt) : '—') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>'
      : '<p class="px-4 py-8 text-center text-[12.5px] text-slate-500">' +
        'Нито една включена обява не е в грешка.</p>') +
    '</div>' +

    '<div class="mt-4 overflow-hidden rounded-xl border border-white/8 bg-ink-900 shadow-panel">' +
    '<p class="border-b border-white/8 px-4 py-2.5 text-[12.5px] font-semibold text-slate-200">' +
    'Без проверка над 24 часа <span class="ml-1 font-normal text-slate-500">' +
    report.stale.length + '</span></p>' +
    (report.stale.length
      ? '<div class="max-h-96 overflow-auto"><table class="op-table w-full text-left text-[12.5px]"><tbody>' +
        report.stale
          .map(
            (listing) =>
              '<tr class="border-b border-white/5">' +
              '<td data-label="Артикул" class="px-4 py-2.5 text-slate-300">' + escapeHtml(listing.product) + '</td>' +
              '<td data-label="Обява" class="px-4 py-2.5 text-slate-500">' + escapeHtml(listing.competitor) + '</td>' +
              '<td data-label="Сайт" class="px-4 py-2.5 font-mono text-[11.5px] text-slate-500">' +
              escapeHtml(listing.host) + '</td>' +
              '<td data-label="Последно" class="whitespace-nowrap px-4 py-2.5 text-[11.5px] text-slate-500">' +
              escapeHtml(listing.lastUpdated ? formatRelative(listing.lastUpdated) : 'никога') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>'
      : '<p class="px-4 py-8 text-center text-[12.5px] text-slate-500">Всичко е проверявано скоро.</p>') +
    '</div>';

  $('#operator-sweep').addEventListener('click', runOperatorSweep);
}

async function runOperatorSweep() {
  const button = $('#operator-sweep');
  button.disabled = true;
  button.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-[11px]"></i>Обикалям…';

  try {
    const response = await fetch(ENDPOINTS.adminScrapeRun, {
      method: 'POST',
      headers: operatorHeaders(),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const run = await response.json();
    toast(
      run.processed
        ? 'Обиколката мина: ' + run.succeeded + ' от ' + run.processed + ' успешни.'
        : 'Нищо не чакаше ред.',
      'success',
    );
  } catch (error) {
    toast(failureText(error, 'Обиколката не тръгна'), 'error');
  }

  await loadOperatorScrape(true);
}

/* --- Alerts ---------------------------------------------------------- */

const ALERT_SEVERITY = {
  info: 'text-slate-400',
  warning: 'text-amber-400',
  critical: 'text-red-400',
};

const DELIVERY_STYLE = {
  delivered: { label: 'доставено', class: 'bg-emerald-500/12 text-emerald-400' },
  pending: { label: 'чака', class: 'bg-white/[0.06] text-slate-400' },
  failed: { label: 'провалено', class: 'bg-red-500/12 text-red-400' },
  skipped: { label: 'без канал', class: 'bg-amber-500/12 text-amber-400' },
};

async function loadOperatorAlerts(quiet) {
  const target = $('#operator-alerts');
  if (!target) return;

  const undeliveredOnly = $('#operator-alerts-undelivered').checked;

  if (!quiet) {
    target.innerHTML = '<p class="px-4 py-8 text-center text-[12.5px] text-slate-500">Зареждам…</p>';
  }

  let alerts;
  try {
    const response = await fetch(
      ENDPOINTS.adminAlerts + '?limit=150' + (undeliveredOnly ? '&undelivered=true' : ''),
      { headers: operatorHeaders() },
    );
    if (!response.ok) throw new Error('HTTP ' + response.status);
    alerts = await response.json();
  } catch (error) {
    target.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-red-400">' +
      escapeHtml(failureText(error, 'Известията не се заредиха')) + '</p>';
    return;
  }

  if (!alerts.length) {
    target.innerHTML =
      '<p class="px-4 py-6 text-center text-[12.5px] text-slate-500">' +
      (undeliveredOnly ? 'Всяко известие е стигнало до канал.' : 'Още няма известия.') + '</p>';
    return;
  }

  target.innerHTML =
    '<div class="max-h-[70vh] overflow-auto"><table class="op-table w-full text-left text-[12.5px]">' +
    '<thead class="sticky top-0 bg-ink-900"><tr class="border-b border-white/8 text-[10px] uppercase tracking-wide text-slate-500">' +
    '<th class="px-4 py-3 font-semibold">Кога</th>' +
    '<th class="px-4 py-3 font-semibold">Какво</th>' +
    '<th class="px-4 py-3 font-semibold">Клиент</th>' +
    '<th class="px-4 py-3 font-semibold">Доставка</th></tr></thead><tbody>' +
    alerts
      .map(function (alert) {
        const delivery = DELIVERY_STYLE[alert.deliveryStatus] || DELIVERY_STYLE.pending;

        return (
          // Acknowledged alerts stay in the list, dimmed. Removing them would
          // make the feed disagree with the count beside it, and "I saw this"
          // is not the same as "this did not happen".
          '<tr class="border-b border-white/5 align-top' +
          (alert.acknowledged ? ' opacity-50' : '') + '">' +
          '<td data-label="Кога" class="whitespace-nowrap px-4 py-3 text-slate-500">' +
          escapeHtml(formatRelative(alert.createdAt)) + '</td>' +
          '<td data-label="Какво" class="px-4 py-3"><p class="' +
          (ALERT_SEVERITY[alert.severity] || ALERT_SEVERITY.info) +
          ' text-[11.5px] font-medium uppercase tracking-wide">' +
          escapeHtml(alert.type.replace(/_/g, ' ')) + '</p>' +
          '<p class="mt-0.5 max-w-xl text-slate-300">' + escapeHtml(alert.message) + '</p></td>' +
          '<td data-label="Клиент" class="px-4 py-3 text-slate-400">' + escapeHtml(alert.owner || '—') +
          '<p class="text-[11px] text-slate-600">' + escapeHtml(alert.product) + '</p></td>' +
          '<td data-label="Доставка" class="px-4 py-3">' +
          '<span class="rounded-md px-2 py-0.5 text-[11px] ' + delivery.class + '">' +
          delivery.label + '</span>' +
          (alert.deliveryError
            ? '<p class="mt-1 max-w-xs text-[11px] text-slate-600">' +
              escapeHtml(alert.deliveryError) + '</p>'
            : '') +
          '</td></tr>'
        );
      })
      .join('') +
    '</tbody></table></div>';
}

/* --- Command palette -------------------------------------------------- *
 *
 * Everything on this screen is two clicks away; the palette makes it one
 * keystroke away, and more importantly makes *customers* reachable by
 * typing their email rather than by finding them in a table.
 * --------------------------------------------------------------------- */

const PALETTE_SECTIONS = [
  { tab: 'overview', label: 'Преглед', hint: 'числа и графики', icon: 'fa-chart-simple' },
  { tab: 'scrape', label: 'Обиколка', hint: 'провали и закъснели проверки', icon: 'fa-tower-broadcast' },
  { tab: 'alerts', label: 'Известия', hint: 'какво е пратено на клиентите', icon: 'fa-bell' },
  { tab: 'customers', label: 'Клиенти', hint: 'планове, лимити, ключове', icon: 'fa-users' },
  { tab: 'payments', label: 'Плащания', hint: 'webhook-и от Stripe', icon: 'fa-receipt' },
  { tab: 'shops', label: 'Сайтове', hint: 'доставчици и заявки за API', icon: 'fa-store' },
];

let paletteItems = [];
let paletteCursor = 0;

function paletteCandidates(term) {
  const lower = term.trim().toLowerCase();
  const items = [];

  PALETTE_SECTIONS.forEach(function (section) {
    if (!lower || section.label.toLowerCase().includes(lower) || section.hint.includes(lower)) {
      items.push({
        icon: section.icon,
        label: section.label,
        hint: section.hint,
        run: () => openOperatorTab(section.tab),
      });
    }
  });

  items.push({
    icon: 'fa-play',
    label: 'Пусни обиколка сега',
    hint: 'проверява обявите, които чакат ред',
    run: async () => {
      openOperatorTab('scrape');
      await loadOperatorScrape(true);
      const button = $('#operator-sweep');
      if (button) button.click();
    },
  });

  if (lower) {
    operatorCustomers
      .filter(
        (user) =>
          (user.email || '').toLowerCase().includes(lower) ||
          (user.name || '').toLowerCase().includes(lower),
      )
      .slice(0, 6)
      .forEach(function (user) {
        items.push({
          icon: 'fa-user',
          label: user.email,
          hint: 'клиент · ' + (PLAN_LABELS[user.plan] || user.plan),
          run: function () {
            $('#operator-customer-search').value = user.email;
            $('#operator-customer-status').value = '';
            $('#operator-customer-plan').value = '';
            openOperatorTab('customers');
            renderOperatorCustomers();
          },
        });
      });

    Object.keys(outreachByHost)
      .concat(paletteHosts)
      .filter((host, index, all) => all.indexOf(host) === index)
      .filter((host) => host.toLowerCase().includes(lower))
      .slice(0, 6)
      .forEach(function (host) {
        items.push({
          icon: 'fa-store',
          label: host,
          hint: 'сайт на доставчик',
          run: () => openOperatorTab('shops'),
        });
      });
  }

  // Filtering to nothing is a real answer, and an empty list says it better
  // than a list of everything would.
  return items.slice(0, 12);
}

/** Hosts seen in the sites table, so the palette can find them before that
 *  tab has ever been opened. Filled by loadOperatorShops. */
let paletteHosts = [];

function renderPalette() {
  const container = $('#palette-results');

  if (!paletteItems.length) {
    container.innerHTML =
      '<p class="px-3 py-8 text-center text-[12.5px] text-slate-500">Нищо не съвпада.</p>';
    return;
  }

  container.innerHTML = paletteItems
    .map(
      (item, index) =>
        '<button type="button" data-palette-index="' + index + '" ' +
        'class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ' +
        (index === paletteCursor ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]') + '">' +
        '<i class="fa-solid ' + item.icon + ' w-4 text-[11.5px] text-slate-500"></i>' +
        '<span class="min-w-0 flex-1"><span class="block truncate text-[12.5px] text-slate-200">' +
        escapeHtml(item.label) + '</span>' +
        '<span class="block truncate text-[11px] text-slate-500">' +
        escapeHtml(item.hint) + '</span></span></button>',
    )
    .join('');

  $$('[data-palette-index]').forEach(function (button) {
    button.addEventListener('click', () => runPalette(Number(button.dataset.paletteIndex)));
  });
}

function runPalette(index) {
  const item = paletteItems[index];
  if (!item) return;

  closeModal('palette-modal');
  void item.run();
}

function refreshPalette() {
  paletteItems = paletteCandidates($('#palette-input').value);
  paletteCursor = 0;
  renderPalette();
}

function openPalette() {
  if ($('#view-operator').hidden) return;

  $('#palette-input').value = '';
  refreshPalette();
  openModal('palette-modal');
  $('#palette-input').focus();
}

$('#operator-palette-open').addEventListener('click', openPalette);
$('#palette-input').addEventListener('input', refreshPalette);

$('#palette-input').addEventListener('keydown', function (event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    paletteCursor = (paletteCursor + step + paletteItems.length) % paletteItems.length;
    renderPalette();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    runPalette(paletteCursor);
  }
});

document.addEventListener('keydown', function (event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
  }
});

$('#operator-refresh').addEventListener('click', () => void loadOperatorPanel());

/* --- Add supplier -------------------------------------------------- */

let supplierTargetId = null;

function openSupplierModal(productId) {
  const product = products.find((item) => item.id === productId);
  supplierTargetId = productId;
  editingSupplier = null;

  $('#supplier-modal-title').textContent = 'Добави склад';
  $('#supplier-modal-product').textContent = product ? product.name : '';
  $('#supplier-status').classList.add('hidden');
  $('#supplier-form').reset();
  openModal('supplier-modal');
}

$('#supplier-form').addEventListener('submit', async function (event) {
  event.preventDefault();

  const name = $('#supplier-name').value.trim();
  const url = $('#supplier-url').value.trim();
  const status = $('#supplier-status');

  function showSupplierStatus(message, tone) {
    const palette = { success: 'text-emerald-400', error: 'text-red-400', info: 'text-slate-400' };
    status.className = 'text-[11.5px] ' + (palette[tone] || palette.info);
    status.textContent = message;
    status.classList.remove('hidden');
  }

  if (!name || !url) {
    showSupplierStatus('Попълнете име и линк.', 'error');
    return;
  }

  $('#supplier-spinner').classList.remove('hidden');
  $('#supplier-icon').classList.add('hidden');

  const editing = editingSupplier !== null;
  const endpoint = editing
    ? ENDPOINTS.products +
      '/' +
      editingSupplier.productId +
      '/competitors/' +
      editingSupplier.supplierId
    : ENDPOINTS.products + '/' + supplierTargetId + '/competitors';

  try {
    const response = await fetch(endpoint, {
      method: editing ? 'PATCH' : 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: name,
        url: url,
        currency: $('#supplier-currency').value,
        priceSelector: $('#supplier-selector').value.trim() || undefined,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error('HTTP ' + response.status + ' ' + detail.slice(0, 140));
    }

    showSupplierStatus(
      editing ? 'Складът е обновен.' : 'Складът е добавен. Първата проверка тръгва при следващия sweep.',
      'success',
    );
    toast(editing ? 'Складът е обновен.' : 'Складът е добавен.', 'success');
    window.setTimeout(function () {
      closeModal('supplier-modal');
      loadProducts();
    }, 800);
  } catch (error) {
    showSupplierStatus(failureText(error, editing ? 'Не бе обновен' : 'Не бе добавен'), 'error');
  } finally {
    $('#supplier-spinner').classList.add('hidden');
    $('#supplier-icon').classList.remove('hidden');
  }
});

/* --- New product across several stores ----------------------------- */

/** Retailers the scraper already knows how to read without configuration. */
const KNOWN_HOSTS = {
  'emag.bg': 'eMAG',
  'technomarket.bg': 'Технómarket',
  'technopolis.bg': 'Технополис',
  'vario.bg': 'Vario',
  'ozone.bg': 'Ozone',
  'ardes.bg': 'Ardes',
};

function hostOf(url) {
  try {
    return new URL(url.trim()).host.replace(/^www\./, '');
  } catch (error) {
    return null;
  }
}

/* --- Adding a product: find it, then choose where to watch it ------- *
 *
 * The old flow asked for a name, an SKU, a brand, a model, a category, a
 * manufacturer, an EAN, a price and a threshold — and then for a product URL
 * per shop, pasted by hand. Everything above the URLs is knowable from the
 * URLs, and the URLs are knowable from the name, so the reader was being asked
 * to do the system's work, and to do it before anything could check it.
 *
 * What replaces it inverts that: they give the name, the search engine that
 * already exists finds and matches the article, and they confirm. Nothing new
 * is searched and nothing new is monitored — this drives the same streamed
 * comparison the search screen runs, and lands on the same product and
 * competitor rows the form always wrote.
 */

/** Everything the flow has learned so far. Cleared each time it opens. */
let trackState = {
  step: 1,
  query: '',
  scope: 'my_suppliers',
  understood: null,
  offers: [],
  chosen: new Set(),
};

/** Moves between the steps and keeps the header and the buttons in step. */
function trackStep(step) {
  trackState.step = step;

  document.querySelectorAll('#product-modal [data-step]').forEach(function (section) {
    section.classList.toggle('hidden', Number(section.dataset.step) !== step);
  });

  document.querySelectorAll('#track-steps [data-step-label]').forEach(function (label) {
    const at = Number(label.dataset.stepLabel);
    label.className =
      at === step ? 'text-slate-300' : at < step ? 'text-emerald-400' : 'text-slate-600';
    if (at === step) label.setAttribute('aria-current', 'step');
    else label.removeAttribute('aria-current');
  });

  $('#track-back').classList.toggle('hidden', step === 1);
  $('#track-next-label').textContent =
    step === 1
      ? translate('Намери продукта')
      : step === 2
        ? translate('Продължи')
        : translate('Започни следенето');

  $('#track-next').disabled = step === 2 && trackState.chosen.size === 0;
}

function trackBusy(busy) {
  $('#track-spinner').classList.toggle('hidden', !busy);
  $('#track-next').disabled = busy;
}

/**
 * One real stage of the search.
 *
 * Every line here corresponds to something that actually happened — the query
 * was read, a named shop answered with a count. Nothing is invented to fill a
 * bar, because a progress indicator that runs ahead of the work is a way of
 * lying at exactly the moment somebody is deciding whether to trust the answer.
 */
function trackProgress(text, done) {
  const box = $('#track-progress');
  box.classList.remove('hidden');

  const row = document.createElement('div');
  row.className =
    'flex items-center gap-2 text-[11.5px] ' + (done ? 'text-slate-400' : 'text-slate-500');
  row.innerHTML =
    (done
      ? '<i class="fa-solid fa-check text-[9px] text-emerald-400"></i>'
      : '<i class="fa-solid fa-circle-notch fa-spin text-[9px] text-accent-400"></i>') +
    '<span>' +
    escapeHtml(text) +
    '</span>';
  box.appendChild(row);
}

/**
 * Runs the search, reporting as each shop answers.
 *
 * The same streamed comparison the search screen uses — one engine, not two —
 * so query understanding, expansion, matching, the confidence thresholds and
 * the shop pool are all whatever that engine already does.
 */
async function trackFind() {
  const query = $('#track-query').value.trim();
  const scope =
    (document.querySelector('input[name="track-scope"]:checked') || {}).value || 'my_suppliers';

  if (query.length < 2) {
    $('#track-error').textContent = translate('Въведете поне 2 знака.');
    $('#track-error').classList.remove('hidden');
    return;
  }

  trackState.query = query;
  trackState.scope = scope;
  trackState.offers = [];
  trackState.chosen = new Set();
  $('#track-error').classList.add('hidden');
  $('#track-progress').innerHTML = '';
  trackBusy(true);

  try {
    const url =
      ENDPOINTS.discoveryCompareStream +
      '?q=' +
      encodeURIComponent(query) +
      '&scope=' +
      encodeURIComponent(scope);

    const response = await fetch(url, { headers: authHeaders({ Accept: 'text/event-stream' }) });
    if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;

    while (!result) {
      const chunk = await reader.read();
      if (chunk.done) break;

      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;

        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch (error) {
          continue;
        }

        if (event.type === 'understood') {
          trackState.understood = event.understood;
          trackProgress(formatMessage('Разпознаваме „{q}“', { q: query }), true);
        }
        if (event.type === 'shop') {
          trackProgress(
            event.name + ' · ' + event.count + ' ' + plural(event.count, 'резултат', 'резултата'),
            true,
          );
        }
        if (event.type === 'result') result = event;
        if (event.type === 'error') throw new Error(event.message);
      }
    }

    if (!result) throw new Error(translate('Търсенето не върна отговор.'));

    /*
     * Two piles, exactly as the server drew them.
     *
     * `matches` are the same article at 0.85 or better; `alternatives` are the
     * neighbouring ones — a different pack, a different battery, a different
     * capacity. Only the first pile is pre-ticked. Watching the wrong variant
     * is worse than watching nothing, and it is the kind of mistake nobody
     * notices until they order from the price it reported.
     */
    trackState.offers = [
      ...(result.matches || []).map((hit) => ({ ...hit, tier: 'match' })),
      ...(result.alternatives || []).map((hit) => ({ ...hit, tier: 'alternative' })),
    ];
    trackState.offers.forEach(function (offer) {
      if (offer.tier === 'match') trackState.chosen.add(offer.url);
    });

    renderTrackUnderstood(result);
    renderTrackOffers();
    trackStep(2);
  } catch (error) {
    $('#track-error').textContent = translate('Търсенето не успя: ') + (error.message || '');
    $('#track-error').classList.remove('hidden');
  } finally {
    trackBusy(false);
  }
}

/** What the query was read as, in the reader's own terms. */
function renderTrackUnderstood(result) {
  const understood = (result.matching && result.matching.understood) || trackState.understood || {};
  trackState.understood = understood;

  const ids = understood.identifiers || {};
  const facts = [
    understood.brand && ['Марка', understood.brand],
    understood.productType && ['Вид', understood.productType],
    (ids.modelCodes || [])[0] && ['Модел', (ids.modelCodes || [])[0]],
    (ids.gtins || [])[0] && ['EAN', (ids.gtins || [])[0]],
  ].filter(Boolean);

  $('#track-understood').innerHTML =
    '<div class="rounded-lg border border-white/8 bg-ink-850 px-3 py-2.5">' +
    '<p class="text-[12.5px] font-medium text-slate-200">' +
    escapeHtml(trackState.query) +
    '</p>' +
    (facts.length
      ? '<div class="mt-1.5 flex flex-wrap gap-1.5">' +
        facts
          .map(
            (fact) =>
              '<span class="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] text-slate-400">' +
              escapeHtml(fact[0]) +
              ': <span class="text-slate-300">' +
              escapeHtml(fact[1]) +
              '</span></span>',
          )
          .join('') +
        '</div>'
      : // Said plainly rather than left blank. A reader who typed something we
        // could not read should know that before they judge the matches.
        '<p class="mt-1 text-[11.5px] text-slate-500">' +
        escapeHtml(translate('Не разпознахме марка или модел — ще следим по име.')) +
        '</p>') +
    '</div>';
}

function renderTrackOffers() {
  const box = $('#track-matches');
  const exact = trackState.offers.filter((offer) => offer.tier === 'match');
  const maybe = trackState.offers.filter((offer) => offer.tier === 'alternative');

  if (!trackState.offers.length) {
    box.innerHTML =
      '<div class="rounded-lg border border-white/8 bg-ink-850 px-3 py-6 text-center">' +
      '<p class="text-[12.5px] text-slate-300">' +
      escapeHtml(
        formatMessage('Не намерихме „{q}“ в наличните магазини.', { q: trackState.query }),
      ) +
      '</p><p class="mt-1 text-[11.5px] text-slate-500">' +
      escapeHtml(
        translate('Добавете магазин по линк отдолу, или се върнете и опитайте с модел или артикулен номер.'),
      ) +
      '</p></div>';
    return;
  }

  box.innerHTML =
    (exact.length
      ? '<div class="flex items-center justify-between gap-2">' +
        '<p class="text-[12px] text-slate-400">' +
        escapeHtml(
          pluralMessage(exact.length, {
            one: 'Намерихме {n} точно съвпадение',
            other: 'Намерихме {n} точни съвпадения',
          }),
        ) +
        '</p><button type="button" id="track-select-all" ' +
        'class="rounded-md px-2 py-0.5 text-[11.5px] text-accent-400 transition hover:underline">' +
        escapeHtml(translate('Избери всички')) +
        '</button></div>' +
        exact.map(trackOfferHtml).join('')
      : '') +
    (maybe.length
      ? '<p class="mt-3 text-[12px] text-amber-400">' +
        '<i class="fa-solid fa-triangle-exclamation mr-1.5 text-[10px]"></i>' +
        escapeHtml(
          pluralMessage(maybe.length, {
            one: '{n} възможно съвпадение',
            other: '{n} възможни съвпадения',
          }),
        ) +
        '</p><p class="mb-1.5 text-[11px] text-slate-500">' +
        escapeHtml(
          translate('Различна комплектация или вариант. Проверете, преди да ги следите.'),
        ) +
        '</p>' +
        maybe.map(trackOfferHtml).join('')
      : '');

  box.querySelectorAll('[data-track-url]').forEach(function (input) {
    input.addEventListener('change', function () {
      if (input.checked) trackState.chosen.add(input.dataset.trackUrl);
      else trackState.chosen.delete(input.dataset.trackUrl);
      $('#track-next').disabled = trackState.chosen.size === 0;
    });
  });

  const all = document.getElementById('track-select-all');
  if (all) {
    all.addEventListener('click', function () {
      trackState.offers
        .filter((offer) => offer.tier === 'match')
        .forEach((offer) => trackState.chosen.add(offer.url));
      renderTrackOffers();
      $('#track-next').disabled = trackState.chosen.size === 0;
    });
  }
}

/**
 * One shop's offer, and why it is thought to be the same article.
 *
 * The reasons are the matcher's own agreements — a brand that agreed, a model
 * code that agreed — rather than a sentence composed here, so the card cannot
 * claim agreement the verdict did not find.
 */
function trackOfferHtml(offer) {
  const confidence = offer.match ? Math.round(offer.match.confidence * 100) : null;
  const chosen = trackState.chosen.has(offer.url);
  const agreed = ((offer.match && offer.match.matchedAttributes) || [])
    .filter((entry) => entry.status === 'match')
    .slice(0, 4);

  return (
    '<label class="mt-1.5 flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition ' +
    (chosen
      ? 'border-accent-500/40 bg-accent-500/[0.06]'
      : 'border-white/8 bg-ink-850 hover:border-white/20') +
    '">' +
    '<input type="checkbox" data-track-url="' +
    escapeHtml(offer.url) +
    '"' +
    (chosen ? ' checked' : '') +
    ' class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-white/20 bg-ink-800 accent-accent-500" />' +
    '<span class="min-w-0 flex-1">' +
    '<span class="flex flex-wrap items-baseline gap-x-2">' +
    '<span class="text-[12.5px] font-medium text-slate-200">' +
    escapeHtml(offer.shopName) +
    '</span>' +
    (confidence !== null
      ? '<span class="text-[11px] ' +
        (confidence >= 85 ? 'text-emerald-400' : 'text-amber-400') +
        '">' +
        confidence +
        '% ' +
        escapeHtml(translate('съвпадение')) +
        '</span>'
      : '') +
    (offer.isMine === false
      ? '<span class="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-500">' +
        escapeHtml(translate('нов магазин')) +
        '</span>'
      : '') +
    '<span class="num ml-auto text-[13px] font-semibold text-slate-200">' +
    (typeof offer.effectivePrice === 'number'
      ? escapeHtml(offer.effectivePrice.toFixed(2) + ' ' + (offer.effectiveCurrency || ''))
      : '<span class="text-[11.5px] font-normal text-slate-600">' +
        escapeHtml(translate('без цена')) +
        '</span>') +
    '</span></span>' +
    '<span class="mt-0.5 block truncate text-[11.5px] text-slate-400" title="' +
    escapeHtml(offer.name) +
    '">' +
    escapeHtml(offer.name) +
    '</span>' +
    (offer.inStock === false
      ? '<span class="mt-1 inline-flex items-center gap-1 text-[10.5px] text-amber-400">' +
        '<i class="fa-solid fa-circle-minus text-[8px]"></i>' +
        escapeHtml(translate('изчерпан')) +
        '</span>'
      : '') +
    (agreed.length
      ? '<span class="mt-1 flex flex-wrap gap-1">' +
        agreed
          .map(
            (entry) =>
              '<span class="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400/90">✓ ' +
              escapeHtml(entry.label || entry.key) +
              '</span>',
          )
          .join('') +
        '</span>'
      : '') +
    '</span></label>'
  );
}

/**
 * A shop the search could not reach, added by its address.
 *
 * The fallback that keeps the manual path alive without making it the road
 * everybody walks — for a shop that forbids crawling, publishes no catalogue,
 * or that the matcher simply missed. The page is read by the same extractor
 * that will be checking it afterwards, so what is confirmed here is what the
 * monitor will see.
 */
async function trackManualAdd() {
  const input = $('#track-manual-url');
  const url = input.value.trim();
  const note = $('#track-manual-result');

  const say = function (tone, text) {
    note.className = 'mt-1.5 text-[11.5px] ' + tone;
    note.textContent = text;
    note.classList.remove('hidden');
  };

  if (!/^https?:\/\//i.test(url)) {
    say('text-amber-400', translate('Поставете пълен адрес, започващ с https://'));
    return;
  }

  $('#track-manual-spinner').classList.remove('hidden');
  $('#track-manual-icon').classList.add('hidden');

  try {
    const seen = await fetch(ENDPOINTS.discoveryPreview, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url: url }),
    }).then(okJson);

    trackState.offers.push({
      tier: 'match',
      url: seen.url,
      shopName: seen.host,
      host: seen.host,
      name: seen.title || seen.url,
      effectivePrice: seen.price,
      effectiveCurrency: seen.currency || 'EUR',
      inStock: seen.inStock,
      isMine: false,
      // No verdict, because nobody matched anything: the reader supplied the
      // address. Showing a confidence for it would be inventing one.
      match: null,
    });
    trackState.chosen.add(seen.url);

    input.value = '';
    say(
      seen.ok ? 'text-emerald-400' : 'text-amber-400',
      seen.ok
        ? formatMessage('Намерихме: {title}', { title: seen.title || seen.host })
        : formatMessage('Добавен, но страницата не се прочете: {error}', {
            error: seen.error || '',
          }),
    );

    renderTrackOffers();
    $('#track-next').disabled = trackState.chosen.size === 0;
  } catch (error) {
    say('text-red-400', translate('Адресът не се прочете.'));
  } finally {
    $('#track-manual-spinner').classList.add('hidden');
    $('#track-manual-icon').classList.remove('hidden');
  }
}

/** The last step, prefilled from what was read rather than asked for. */
function renderTrackSettings() {
  const chosen = trackState.offers.filter((offer) => trackState.chosen.has(offer.url));
  const priced = chosen.filter((offer) => typeof offer.effectivePrice === 'number');
  const lowest = priced.length
    ? Math.min.apply(null, priced.map((offer) => offer.effectivePrice))
    : null;

  const understood = trackState.understood || {};
  const ids = understood.identifiers || {};

  $('#track-chosen').innerHTML =
    '<p class="text-[12.5px] text-slate-300">' +
    escapeHtml(
      pluralMessage(chosen.length, { one: 'Избран {n} магазин', other: 'Избрани {n} магазина' }),
    ) +
    '</p>' +
    (lowest !== null
      ? '<p class="mt-0.5 text-[11.5px] text-slate-500">' +
        escapeHtml(translate('Най-ниска намерена цена')) +
        ': <span class="num font-semibold text-emerald-400">' +
        escapeHtml(lowest.toFixed(2) + ' ' + (priced[0].effectiveCurrency || '')) +
        '</span></p>'
      : '');

  /*
   * Prefilled, never invented.
   *
   * Blank wherever nothing was recognised. A brand guessed to fill a field is
   * a brand the matcher will later compare on, and a wrong one there is worse
   * than an empty one — it would quietly rule out the right article.
   */
  if (!$('#track-name').value) $('#track-name').value = trackState.query;
  if (!$('#track-brand').value) $('#track-brand').value = understood.brand || '';
  if (!$('#track-model').value) $('#track-model').value = (ids.modelCodes || [])[0] || '';
  if (!$('#track-category').value) $('#track-category').value = understood.productType || '';
  if (!$('#track-gtin').value) $('#track-gtin').value = (ids.gtins || [])[0] || '';

  if (!$('#track-target').value && lowest !== null) {
    $('#track-target').value = (Math.round(lowest * 0.97 * 100) / 100).toFixed(2);
  }
}

/** Hands the confirmed shops to the monitoring that already exists. */
async function trackStart() {
  const chosen = trackState.offers.filter((offer) => trackState.chosen.has(offer.url));
  if (!chosen.length) return;

  const status = $('#track-status');
  status.className = 'mt-2.5 text-[11.5px] text-slate-400';
  status.textContent = translate('Създаваме…');
  status.classList.remove('hidden');
  trackBusy(true);

  try {
    const product = await fetch(ENDPOINTS.products + '/track', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: $('#track-name').value.trim() || trackState.query,
        sku: $('#track-sku').value.trim() || undefined,
        brand: $('#track-brand').value.trim() || undefined,
        model: $('#track-model').value.trim() || undefined,
        category: $('#track-category').value.trim() || undefined,
        gtin: $('#track-gtin').value.trim() || undefined,
        ourPrice: Number($('#track-our-price').value) || undefined,
        targetPrice: Number($('#track-target').value) || undefined,
        currency: 'EUR',
        stores: chosen.map((offer) => ({
          url: offer.url,
          name: offer.shopName,
          price: typeof offer.effectivePrice === 'number' ? offer.effectivePrice : undefined,
          currency: offer.effectiveCurrency || 'EUR',
          inStock: typeof offer.inStock === 'boolean' ? offer.inStock : undefined,
        })),
      }),
    }).then(okJson);

    // The first check runs at once, so the comparison holds real numbers
    // before the reader has to wonder whether anything happened.
    status.textContent = translate('Създаден. Стартираме първата проверка…');
    await fetch(ENDPOINTS.scraperTrigger + '/' + product.id, {
      method: 'POST',
      headers: authHeaders(),
    }).catch(() => null);

    toast(translate('Продуктът се следи.'), 'success');
    closeModal('product-modal');
    loadProducts();
  } catch (error) {
    status.className = 'mt-2.5 text-[11.5px] text-red-400';
    status.textContent = translate('Неуспешно: ') + (error.message || '');
  } finally {
    trackBusy(false);
  }
}

$('#add-product').addEventListener('click', function () {
  if (requireAccount()) return;

  trackState = {
    step: 1,
    query: '',
    scope: 'my_suppliers',
    understood: null,
    offers: [],
    chosen: new Set(),
  };

  [
    'track-query', 'track-manual-url', 'track-our-price', 'track-target', 'track-name',
    'track-sku', 'track-brand', 'track-model', 'track-category', 'track-gtin',
  ].forEach(function (id) {
    const field = document.getElementById(id);
    if (field) field.value = '';
  });

  ['track-error', 'track-status', 'track-manual-result'].forEach(function (id) {
    const box = document.getElementById(id);
    if (box) box.classList.add('hidden');
  });

  $('#track-progress').innerHTML = '';
  $('#track-progress').classList.add('hidden');
  $('#track-matches').innerHTML = '';
  $('#track-understood').innerHTML = '';

  trackStep(1);
  openModal('product-modal');
  window.setTimeout(function () {
    $('#track-query').focus();
  }, 50);
});

$('#track-next').addEventListener('click', function () {
  if (trackState.step === 1) return void trackFind();
  if (trackState.step === 2) {
    renderTrackSettings();
    return trackStep(3);
  }
  void trackStart();
});

$('#track-back').addEventListener('click', function () {
  trackStep(Math.max(1, trackState.step - 1));
});

$('#track-query').addEventListener('keydown', function (event) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('#track-next').click();
});

$('#track-manual-add').addEventListener('click', function () {
  void trackManualAdd();
});


/* --- Row and warehouse actions -------------------------------------- */

function findProduct(id) {
  return products.find((product) => product.id === id) || null;
}

function findSupplier(id) {
  for (const product of products) {
    const supplier = product.suppliers.find((item) => item.id === id);
    if (supplier) return { product: product, supplier: supplier };
  }
  return null;
}

/** Wraps a mutating call: toast on success, toast on failure, reload once. */
async function mutate(description, request) {
  try {
    const response = await request();

    if (!response.ok) {
      const detail = await response.text();
      throw new Error('HTTP ' + response.status + ' ' + detail.slice(0, 140));
    }

    toast(description + ' — готово.', 'success');
    await loadProducts();
    return true;
  } catch (error) {
    toast(description + ' не успя: ' + error.message, 'error');
    return false;
  }
}

async function handleAction(action, id) {
  // Every row action either writes or calls the API, and a visitor can do
  // neither. One guard here rather than one per action: this is the single
  // dispatch every edit, delete and re-check button goes through, so nothing
  // can be added later that quietly slips past it.
  if (requireAccount()) return;

  if (action === 'refresh-product') {
    toast('Проверявам всички складове…', 'info');
    await mutate('Проверката', () =>
      fetch(ENDPOINTS.scraperTrigger + '/' + id, { method: 'POST', headers: authHeaders() }),
    );
    return;
  }

  if (action === 'delete-product') {
    const product = findProduct(id);
    const view = product ? analyse(product) : { count: 0 };
    const confirmed = await confirmDialog(
      'Изтриване на продукт',
      'Ще бъде изтрит <strong class="text-slate-200">' +
        escapeHtml(product ? product.name : '') +
        '</strong>, заедно с <strong class="text-slate-200">' +
        view.count +
        ' склада</strong> и цялата ценова история към тях.',
      'Изтрий продукта',
      {
        countdownSeconds: 3,
        note: 'Действието е необратимо — историята на цените не може да се възстанови.',
      },
    );
    if (!confirmed) return;

    await mutate('Изтриването', () =>
      fetch(ENDPOINTS.products + '/' + id, { method: 'DELETE', headers: authHeaders() }),
    );
    return;
  }

  if (action === 'edit-product') {
    openProductEditor(findProduct(id));
    return;
  }

  if (action === 'refresh-supplier') {
    toast('Проверявам склада…', 'info');
    await mutate('Проверката', () =>
      fetch(ENDPOINTS.scraperRefresh + '/' + id + '/refresh', {
        method: 'POST',
        headers: authHeaders(),
      }),
    );
    return;
  }

  const found = findSupplier(id);
  if (!found) return;

  if (action === 'promote-supplier') {
    await mutate('Смяната на основен склад', () =>
      fetch(
        ENDPOINTS.products + '/' + found.product.id + '/competitors/' + id + '/promote',
        { method: 'PATCH', headers: authHeaders() },
      ),
    );
    return;
  }

  if (action === 'delete-supplier') {
    if (found.supplier.isPrimary) {
      toast('Основният склад не може да се трие. Направете друг основен първо.', 'error');
      return;
    }

    const confirmed = await confirmDialog(
      'Изтриване на склад',
      '<strong class="text-slate-200">' +
        escapeHtml(found.supplier.name) +
        '</strong> ще бъде премахнат от „' +
        escapeHtml(found.product.name) +
        '", заедно с историята му на цени. Другите складове остават.',
      'Изтрий склада',
    );
    if (!confirmed) return;

    await mutate('Изтриването', () =>
      fetch(ENDPOINTS.products + '/' + found.product.id + '/competitors/' + id, {
        method: 'DELETE',
        headers: authHeaders(),
      }),
    );
    return;
  }

  if (action === 'edit-supplier') {
    openSupplierEditor(found.product, found.supplier);
  }
}

/* --- Editors -------------------------------------------------------- */

let editingProductId = null;

function openProductEditor(product) {
  if (!product) return;

  editingProductId = product.id;
  $('#edit-product-name').value = product.name || '';
  $('#edit-product-sku').value = product.sku || '';
  $('#edit-product-brand').value = product.brand || '';
  $('#edit-product-manufacturer').value = product.manufacturer || '';
  $('#edit-product-model').value = product.model || '';
  $('#edit-product-category').value = product.category || '';
  $('#edit-product-gtin').value = product.gtin || '';
  $('#edit-product-interval').value = product.checkIntervalMinutes || 60;
  $('#edit-product-our-price').value = product.marketPrice == null ? '' : product.marketPrice;
  $('#edit-product-target').value = product.targetPrice == null ? '' : product.targetPrice;
  $('#edit-product-active').checked = product.isActive !== false;
  $('#edit-product-status').classList.add('hidden');

  openModal('edit-product-modal');
}

$('#edit-product-form').addEventListener('submit', async function (event) {
  event.preventDefault();

  const status = $('#edit-product-status');
  function show(message, tone) {
    const palette = { success: 'text-emerald-500', error: 'text-red-500', info: 'text-slate-400' };
    status.className = 'text-[11.5px] ' + (palette[tone] || palette.info);
    status.textContent = message;
    status.classList.remove('hidden');
  }

  const name = $('#edit-product-name').value.trim();
  if (!name) {
    show('Името не може да е празно.', 'error');
    return;
  }

  // Only fields the user can actually see are sent. Posting the whole
  // object back would overwrite prices the scraper wrote in the meantime.
  const payload = {
    name: name,
    sku: $('#edit-product-sku').value.trim() || undefined,
    brand: $('#edit-product-brand').value.trim() || undefined,
    manufacturer: $('#edit-product-manufacturer').value.trim() || undefined,
    model: $('#edit-product-model').value.trim() || undefined,
    category: $('#edit-product-category').value.trim() || undefined,
    gtin: $('#edit-product-gtin').value.trim() || undefined,
    checkIntervalMinutes: Number($('#edit-product-interval').value) || undefined,
    ourPrice: $('#edit-product-our-price').value === ''
      ? undefined
      : Number($('#edit-product-our-price').value),
    targetPrice: $('#edit-product-target').value === ''
      ? undefined
      : Number($('#edit-product-target').value),
    isActive: $('#edit-product-active').checked,
  };

  $('#edit-product-spinner').classList.remove('hidden');

  try {
    const response = await fetch(ENDPOINTS.products + '/' + editingProductId, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ' ' + (await response.text()).slice(0, 140));
    }

    toast('Продуктът е обновен.', 'success');
    closeModal('edit-product-modal');
    await loadProducts();
  } catch (error) {
    show('Неуспешно: ' + error.message, 'error');
  } finally {
    $('#edit-product-spinner').classList.add('hidden');
  }
});

let editingSupplier = null;

/**
 * Reuses the add-warehouse dialog in edit mode: the fields are identical,
 * and a second near-copy of the same form is a second thing to keep in sync.
 */
function openSupplierEditor(product, supplier) {
  editingSupplier = { productId: product.id, supplierId: supplier.id };
  supplierTargetId = product.id;

  $('#supplier-modal-title').textContent = 'Редакция на склад';
  $('#supplier-modal-product').textContent = product.name;
  $('#supplier-name').value = supplier.name || '';
  $('#supplier-url').value = supplier.url || '';
  $('#supplier-currency').value = supplier.currency || 'EUR';
  $('#supplier-selector').value = supplier.priceSelector || '';
  $('#supplier-status').classList.add('hidden');

  openModal('supplier-modal');
}

/* --- CSV export ---------------------------------------------------- */

$('#export-csv').addEventListener('click', function () {
  if (requireAccount()) return;
  const header = [
    'Продукт',
    'SKU',
    'Марка',
    'Производител',
    'Модел',
    'Категория',
    'Баркод (GTIN)',
    'Пазарна цена (EUR)',
    'Праг за аларма (EUR)',
    'Склад',
    'Домейн',
    'Локация',
    'Валута на офертата',
    'Цена на едро (EUR)',
    'Предишна цена (EUR)',
    'Най-евтин',
    'Наличност',
    'Разлика спрямо най-евтин (%)',
    'Последно обновяване',
  ];

  // Excel opens semicolon-separated files correctly in Bulgarian locales,
  // where the comma is the decimal separator.
  const separator = ';';

  function cell(value) {
    const text = String(value == null ? '' : value);
    return /[";\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function decimal(value) {
    return value == null ? '' : value.toFixed(2).replace('.', ',');
  }

  const lines = [header.map(cell).join(separator)];

  // One row per warehouse, so the file can be pivoted in Excel — a single
  // row per product would throw away exactly the comparison you exported it for.
  visibleProducts().forEach(function (product) {
    const view = analyse(product);

    product.suppliers.forEach(function (supplier) {
      const isBest = view.best && supplier.host === view.best.host && supplier.price === view.best.price;
      const premium =
        view.best && typeof supplier.price === 'number' && view.best.price > 0
          ? ((supplier.price - view.best.price) / view.best.price) * 100
          : null;

      lines.push(
        [
          cell(product.name),
          cell(product.sku || ''),
          cell(product.brand || ''),
          cell(product.manufacturer || ''),
          cell(product.model || ''),
          cell(product.category || ''),
          cell(product.gtin || ''),
          cell(decimal(product.marketPrice)),
          cell(decimal(product.targetPrice)),
          cell(supplier.name),
          cell(supplier.host),
          cell(supplier.location || ''),
          cell(supplier.currency || ''),
          cell(decimal(supplier.price)),
          cell(decimal(supplier.previousPrice)),
          cell(isBest ? 'да' : ''),
          cell(supplierState(supplier).label),
          cell(premium === null ? '' : premium.toFixed(1).replace('.', ',')),
          cell(new Date(supplier.updatedAt).toLocaleString('bg-BG')),
        ].join(separator),
      );
    });
  });

  // The BOM makes Excel read the file as UTF-8 instead of mangling Cyrillic.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);

  link.href = url;
  link.download = 'stoclify-sravnenie-' + stamp + '.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  toast('Свалени ' + (lines.length - 1) + ' реда в CSV.', 'success');
});

/* --- Copy API link ------------------------------------------------- */

$('#copy-api-link').addEventListener('click', async function () {
  // The key is deliberately not put in the URL — it belongs in a header.
  const link = window.location.origin + ENDPOINTS.products + '?limit=100';

  try {
    await navigator.clipboard.writeText(link);
  } catch (error) {
    const helper = document.createElement('textarea');
    helper.value = link;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    document.execCommand('copy');
    document.body.removeChild(helper);
  }

  $('#copy-icon').className = 'fa-solid fa-check text-[11.5px]';
  $('#copy-label').textContent = 'Копирано';

  window.setTimeout(function () {
    $('#copy-icon').className = 'fa-solid fa-link text-[11.5px]';
    $('#copy-label').textContent = 'Копирай API линк';
  }, 2000);

  toast('Линкът е копиран. Ключът се подава през хедъра x-api-key.', 'success');
});


/* ------------------------------------------------------------------ *
 * Security: the second factor, and the devices that are signed in
 *
 * Both were reachable only with curl until this existed. A protection
 * a customer cannot switch on protects nobody, and "sign out
 * everywhere" as the only answer to a laptop left in an office is a
 * blunt instrument.
 * ------------------------------------------------------------------ */

/** The secret and codes from `setup`, held until enrolment is confirmed. */
let pendingEnrolment = null;

function showTotpState(state) {
  ['off', 'enrol', 'on'].forEach(function (name) {
    const panel = $('#totp-' + name);
    if (panel) panel.classList.toggle('hidden', name !== state);
  });
}

function showTotpStatus(message, tone) {
  const element = $('#totp-status');
  element.textContent = message;
  element.className =
    'mt-2 text-[11.5px] ' + (tone === 'error' ? 'text-red-400' : 'text-slate-400');
  element.classList.remove('hidden');
}

/** Reflects whatever the account says, and lists the devices. */
async function refreshSecurityPanel() {
  if (!isIdentified()) return;

  showTotpState(account && account.totpEnabled ? 'on' : 'off');
  await renderSessions();
}

async function renderSessions() {
  const list = $('#sessions-list');
  if (!list) return;

  try {
    const response = await fetch(ENDPOINTS.authSessions, { headers: authHeaders() });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const sessions = await response.json();

    if (!sessions.length) {
      list.innerHTML =
        '<p class="text-[11.5px] text-slate-500">' + translate('Няма други активни входове.') + '</p>';
      return;
    }

    list.innerHTML = sessions
      .map(function (session) {
        return (
          '<div class="flex items-center gap-3 rounded-lg border border-white/8 bg-ink-900 px-3 py-2">' +
          '<i class="fa-solid ' +
          (isPhone(session.userAgent) ? 'fa-mobile-screen' : 'fa-laptop') +
          ' text-[11.5px] text-slate-500"></i>' +
          '<div class="min-w-0 flex-1">' +
          '<p class="truncate text-[11.5px] text-slate-300">' +
          escapeHtml(describeDevice(session.userAgent)) +
          (session.current
            ? '<span class="ml-1.5 rounded bg-accent-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent-600 dark:text-accent-300">' +
              translate('този браузър') +
              '</span>'
            : '') +
          '</p>' +
          '<p class="text-[11px] text-slate-500">' +
          escapeHtml(
            session.lastUsedAt
              ? translate('Последно ползван') + ' ' + formatRelative(session.lastUsedAt)
              : translate('Още не е ползван'),
          ) +
          '</p></div>' +
          (session.current
            ? ''
            : '<button type="button" data-revoke="' +
              escapeHtml(session.id) +
              '" title="' +
              escapeHtml(translate('Прекрати този вход')) +
              '" class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-white/5 hover:text-red-400">' +
              '<i class="fa-solid fa-xmark text-[11px]"></i></button>') +
          '</div>'
        );
      })
      .join('');

    $$('[data-revoke]').forEach(function (button) {
      button.addEventListener('click', async function () {
        await mutate('Прекратяването', () =>
          fetch(ENDPOINTS.authSessions + '/' + button.dataset.revoke, {
            method: 'DELETE',
            headers: authHeaders(),
          }),
        );
        void renderSessions();
      });
    });
  } catch (error) {
    list.innerHTML =
      '<p class="text-[11.5px] text-slate-500">' + escapeHtml(failureText(error, 'Не се зареди')) + '</p>';
  }
}

/** "Chrome on macOS" out of a user-agent string, or something honest. */
function describeDevice(userAgent) {
  if (!userAgent) return translate('Неизвестно устройство');

  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Safari\//.test(userAgent)
        ? 'Safari'
        : /Firefox\//.test(userAgent)
          ? 'Firefox'
          : translate('браузър');

  const platform = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Macintosh/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : '';

  return platform ? browser + ' · ' + platform : browser;
}

function isPhone(userAgent) {
  return /iPhone|iPad|Android/.test(userAgent || '');
}

$('#totp-setup').addEventListener('click', async function () {
  try {
    const response = await fetch(ENDPOINTS.authTotpSetup, {
      method: 'POST',
      headers: authHeaders(),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'HTTP ' + response.status);

    pendingEnrolment = payload;

    $('#totp-qr').src = payload.qrSvg;
    // Grouped in fours: this is read off a screen and typed into a phone by
    // hand when the camera will not focus.
    $('#totp-secret').textContent = payload.secret.replace(/(.{4})/g, '$1 ').trim();
    $('#totp-recovery').innerHTML = payload.recoveryCodes
      .map((code) => '<span class="select-all">' + escapeHtml(code) + '</span>')
      .join('');
    $('#totp-code').value = '';
    $('#totp-status').classList.add('hidden');

    showTotpState('enrol');
  } catch (error) {
    toast(failureText(error, 'Не се получи'), 'error');
  }
});

$('#totp-cancel').addEventListener('click', function () {
  // The secret stays on the row unconfirmed and is replaced by the next
  // attempt. Nothing is enforced until `enable` succeeds, so abandoning
  // half-way locks nobody out.
  pendingEnrolment = null;
  showTotpState('off');
});

$('#totp-confirm').addEventListener('click', async function () {
  const code = $('#totp-code').value.trim();

  if (code.length < 6) {
    showTotpStatus(translate('Въведете шестте цифри от приложението.'), 'error');
    return;
  }

  try {
    const response = await fetch(ENDPOINTS.authTotpEnable, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: code }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      showTotpStatus(translate(payload.message || 'Кодът не е верен.'), 'error');
      return;
    }

    pendingEnrolment = null;
    if (account) account.totpEnabled = true;
    showTotpState('on');
    toast(translate('Вторият фактор е включен.'), 'success');
  } catch (error) {
    showTotpStatus(failureText(error, 'Не се получи'), 'error');
  }
});

$('#totp-disable').addEventListener('click', async function () {
  const code = window.prompt(
    translate('Въведете код от приложението, за да изключите втория фактор:'),
  );
  if (!code) return;

  try {
    const response = await fetch(ENDPOINTS.authTotpDisable, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: code.trim() }),
    });

    if (!response.ok) {
      toast(translate('Кодът не е верен.'), 'error');
      return;
    }

    if (account) account.totpEnabled = false;
    showTotpState('off');
    toast(translate('Вторият фактор е изключен.'), 'info');
  } catch (error) {
    toast(failureText(error, 'Не се получи'), 'error');
  }
});

$('#signout-everywhere').addEventListener('click', async function () {
  const confirmed = await confirmDialog(
    translate('Изход от всички устройства'),
    translate(
      'Всички браузъри, включително този, ще бъдат отписани. API ключът ви не се променя.',
    ),
    translate('Отпиши всички'),
  );

  if (!confirmed) return;

  await fetch(ENDPOINTS.authSignOutEverywhere, { method: 'POST', headers: authHeaders() }).catch(
    () => undefined,
  );

  setSession(null);
  account = null;
  renderAccount();
  closeModal('signin-modal');
  toast(translate('Отписани сте от всички устройства.'), 'success');
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

// Visible build stamp: when the UI misbehaves, the first question is
// always whether the browser is running the current file.
// Read from the response rather than typed: a hand-written stamp is
// right until the first time somebody forgets, and this exists precisely
// to answer "is the browser running the current file".
$('#build-stamp').textContent = 'build ' + document.lastModified;

// The copyright year, from the clock rather than from a literal somebody has
// to remember to change every January.
$$('[data-year]').forEach(function (element) {
  element.textContent = String(new Date().getFullYear());
});

/**
 * The first render.
 *
 * Held until the dictionary has loaded, when there is one to wait for. Several
 * of these build their text by pasting a number into a phrase — "across 5
 * warehouses" — which no later pass over the document can fix, because the
 * finished sentence is not a key in any dictionary. Rendering after the
 * language is settled is the only version that comes out right the first time,
 * and it costs one small same-origin fetch on a page that has already loaded.
 */
async function boot() {
  refreshDemoBanner();

  /*
   * Settled before anything is asked, not alongside it.
   *
   * This await is the whole repair for a browser upgrading from the single
   * shared key slot. `operatorKnown` is what moves an operator key out of the
   * customer slot, and until it has, `authHeaders` will still find one there
   * and attach it to every customer request. Fired and not awaited — which is
   * what this used to do — the first view opens against un-migrated storage
   * and reproduces the original bug exactly: /products, /shops, /billing/me
   * and the rest all answering "this is an operator key" at once.
   *
   * It costs one same-origin request, and only for a browser that still has a
   * key stored under the old arrangement. Every other browser resolves it from
   * storage without touching the network.
   */
  await operatorKnown();

  renderApiKeyBadge();
  // Decides which navigation the header shows, so it runs before the first
  // view is opened rather than after the reader has seen the wrong one.
  renderAccount();
  rebuildSupplierFilter();
  renderTable();
  // After `$$` exists: this reads the pricing cards out of the document, and
  // called at the top of the file it ran inside the temporal dead zone of the
  // helper it uses.
  void paintPlanPrices();
  switchView(window.location.hash.replace('#', '') || 'landing', { force: true });
}

if (window.PG_I18N && window.PG_I18N.ready) {
  void window.PG_I18N.ready.then(boot, boot);
} else {
  void boot();
}
