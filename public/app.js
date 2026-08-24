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
  return Boolean(getSession() || getApiKey());
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
  scraperRun: API_BASE + '/scraper/run',
  scraperRefresh: API_BASE + '/scraper/competitors',
  discoverySearch: API_BASE + '/discovery/search',
  discoveryShops: API_BASE + '/discovery/shops',
  discoveryDetect: API_BASE + '/discovery/detect',
  discoveryAvailable: API_BASE + '/discovery/available',
  discoveryBasket: API_BASE + '/discovery/basket',
  discoveryCompare: API_BASE + '/discovery/compare',
  discoveryCompareStream: API_BASE + '/discovery/compare/stream',
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
  scraperStatus: API_BASE + '/scraper/status',
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

function billingPlans() {
  if (!billingPlansPromise) {
    billingPlansPromise = fetch(ENDPOINTS.billingPlans, {
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((payload) => payload || { enabled: false, plans: [], topUpUrl: null });
  }

  return billingPlansPromise;
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

/**
 * The API key is held in localStorage only. It is never written into the
 * markup and never put in a URL — a key in a query string ends up in
 * server logs, browser history and Referer headers.
 */
const KEY_STORAGE = 'stoclify.apiKey';

function getApiKey() {
  try {
    return window.localStorage.getItem(KEY_STORAGE) || '';
  } catch (error) {
    return '';
  }
}

function setApiKey(value) {
  try {
    if (value) window.localStorage.setItem(KEY_STORAGE, value);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch (error) {
    /* private browsing — the session simply stays unauthenticated */
  }
  renderApiKeyBadge();
  // The operator entry belongs to the key, not to the session: pasting a
  // customer key must take it away again.
  void detectOperator();
}

/** Every authenticated call goes through here, so the header is never forgotten. */
/**
 * Where a signed-in browser keeps its proof.
 *
 * Separate from the API key on purpose: the key is a machine credential
 * that belongs in a script and cannot be read back once issued, while
 * this is handed out again on every sign-in and can be dropped from one
 * device without breaking anybody's integration.
 */
const SESSION_STORAGE = 'stoclify.session';

function getSession() {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE);
    if (!raw) return null;

    const session = JSON.parse(raw);
    // A session that has run out is the same as none: dropping it here
    // means the interface asks for a sign-in instead of firing requests
    // that will all answer 401.
    if (!session.token || new Date(session.expiresAt).getTime() < Date.now()) {
      window.localStorage.removeItem(SESSION_STORAGE);
      return null;
    }

    return session;
  } catch (error) {
    return null;
  }
}

function setSession(session) {
  try {
    if (session) window.localStorage.setItem(SESSION_STORAGE, JSON.stringify(session));
    else window.localStorage.removeItem(SESSION_STORAGE);
  } catch (error) {
    /* private browsing — the tab stays signed in, the next one will not */
  }
}

function authHeaders(extra) {
  const headers = Object.assign({ Accept: 'application/json' }, extra || {});

  // A session wins where both exist. Somebody who has just signed in
  // means to act as that account, whatever key is left in this browser
  // from before.
  const session = getSession();
  if (session) {
    headers.Authorization = 'Bearer ' + session.token;
    return headers;
  }

  const key = getApiKey();
  if (key) headers['x-api-key'] = key;
  return headers;
}

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
    'pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border bg-ink-800 px-5 py-3 text-[13.5px] font-medium shadow-2xl transition-all duration-300 opacity-100 translate-y-0 ' +
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
        'pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 translate-y-3 rounded-xl border border-white/10 bg-ink-800 px-5 py-3 text-[13.5px] font-medium text-slate-200 opacity-0 shadow-2xl transition-all duration-300';
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

  if (name === 'dashboard') loadProducts();
  if (name === 'catalogue') void loadShops();
  if (name === 'dashboard' || name === 'catalogue') void refreshPlanBar();
  if (name === 'operator') void loadOperatorPanel();
}

$$('.nav-link').forEach(function (button) {
  button.addEventListener('click', function () {
    switchView(button.dataset.view);

    // `switchView` scrolls to the top, and returns early when the view is
    // already open — so the section scroll is queued after it either way.
    const section = button.dataset.scroll && document.getElementById(button.dataset.scroll);
    if (section) {
      window.setTimeout(function () {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
  });
});

window.addEventListener('hashchange', function () {
  switchView(window.location.hash.replace('#', ''));
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

['key-modal', 'signup-modal', 'signin-modal', 'supplier-modal', 'product-modal', 'edit-product-modal', 'shop-modal', 'detect-modal'].forEach(function (id) {
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

  ['key-modal', 'signup-modal', 'signin-modal', 'supplier-modal', 'product-modal', 'edit-product-modal', 'shop-modal', 'detect-modal'].forEach(closeModal);
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
  icon.className = hidden ? 'fa-solid fa-eye-slash text-[13px]' : 'fa-solid fa-eye text-[13px]';
});

function showKeyStatus(message, tone) {
  const element = $('#key-status');
  const palette = { success: 'text-emerald-400', error: 'text-red-400', info: 'text-slate-400' };
  element.className = 'mt-2.5 text-[12.5px] ' + (palette[tone] || palette.info);
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
    if (!response.ok) throw new Error('HTTP ' + response.status);

    setApiKey(candidate);
    renderAccount();
    showKeyStatus('Ключът е валиден и запазен в този браузър.', 'success');
    toast('API ключът е активен.', 'success');
    window.setTimeout(() => closeModal('key-modal'), 700);
    loadProducts();
  } catch (error) {
    // The key may still be right while the server is down; store it and
    // say exactly that rather than blaming the key.
    setApiKey(candidate);
    showKeyStatus(failureText(error, 'API-то не отговори — ключът е запазен'), 'info');
  } finally {
    $('#key-save-spinner').classList.add('hidden');
    $('#key-save-icon').classList.remove('hidden');
  }
});

$('#key-remove').addEventListener('click', function () {
  setApiKey('');
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
    '" class="inline-flex items-center gap-2 rounded-xl border border-dashed border-white/15 px-4 py-2.5 text-[13px] font-medium text-slate-400 transition hover:border-accent-500/50 hover:text-accent-300">' +
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
    '<span class="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[12px] font-bold ring-1 ' +
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
    '<span class="block text-center text-[13px] text-slate-600">—</span>' +
    (note
      ? '<span class="mt-0.5 block truncate text-center text-[11px] text-slate-600">' +
        escapeHtml(note) +
        '</span>'
      : '')
  );
}

function chipHtml(icon, text, extraClass, hoverAttributes) {
  return (
    '<span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ' +
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
    '<span class="num text-[10.5px] font-semibold text-slate-300">' +
    tally.total +
    '</span>' +
    '<span class="text-[10.5px] text-slate-500">' + translate('склада') + '</span>' +
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
    '<span class="num text-[13.5px] font-semibold ' +
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
    '<span class="num mt-1 flex justify-between text-[10.5px] text-slate-500">' +
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
    '<div class="flex items-baseline justify-between gap-4 py-0.5">' +
    '<span class="spec-key text-[11.5px]">' +
    escapeHtml(label) +
    '</span><span class="text-right text-[12px] ' +
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
        '<span class="rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ' +
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
        '<span class="min-w-0 flex-1"><span class="block truncate text-[12px] font-medium text-slate-200">' +
        escapeHtml(supplier.name) +
        (isBest
          ? '<span class="ml-1.5 rounded bg-emerald-500/15 px-1 py-px align-middle text-[9.5px] font-bold uppercase text-emerald-400">най-евтин</span>'
          : '') +
        '</span><span class="block truncate font-mono text-[10.5px] text-slate-500">' +
        escapeHtml(supplier.host) +
        (supplier.location ? ' · ' + escapeHtml(supplier.location) : '') +
        '</span></span>' +
        '<span class="shrink-0 text-right"><span class="num block text-[12.5px] font-semibold ' +
        (isBest ? 'text-emerald-400' : 'text-slate-200') +
        '"><span class="masked">' +
        (typeof supplier.price === 'number' ? euro.format(supplier.price) : '—') +
        '</span></span>' +
        '<span class="num block text-[10.5px] ' +
        state.tone +
        '">' +
        (premium !== null && premium > 0.05
          ? '<span class="masked">+' + premium.toFixed(1) + '%</span> · '
          : '') +
        escapeHtml(state.label) +
        '</span></span>' +
        '<span class="w-16 shrink-0 text-right text-[10.5px] text-slate-500">' +
        escapeHtml(formatRelative(supplier.updatedAt)) +
        '</span>' +
        '</div>'
      );
    })
    .join('');

  const footer = view.best
    ? '<div class="border-t border-white/8 px-4 py-2.5">' +
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
    '<div class="px-4 pb-2 pt-3">' +
    '<p class="text-[12.5px] font-semibold text-slate-200">' +
    escapeHtml(product.name) +
    '</p>' +
    (badges ? '<div class="mt-1.5 flex flex-wrap gap-1">' + badges + '</div>' : '') +
    '</div>' +
    (rows
      ? '<div class="max-h-72 overflow-y-auto border-t border-white/8 px-4 py-1">' + rows + '</div>'
      : '<p class="border-t border-white/8 px-4 py-4 text-[12px] text-slate-500">' +
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
      ? hoverRow('Модел', '<span class="font-mono text-[11.5px]">' + escapeHtml(product.model) + '</span>')
      : '') +
    (product.category ? hoverRow('Категория', escapeHtml(product.category)) : '') +
    (product.sku
      ? hoverRow('Вашият SKU', '<span class="font-mono text-[11.5px]">' + escapeHtml(product.sku) + '</span>')
      : '') +
    (product.gtin
      ? hoverRow(
          'Баркод (GTIN)',
          '<span class="font-mono text-[11.5px]">' + escapeHtml(product.gtin) + '</span>',
        )
      : '');

  return (
    '<div class="flex items-start gap-3 px-4 pb-3 pt-3">' +
    productThumb(product) +
    '<span class="min-w-0"><span class="block text-[12.5px] font-semibold text-slate-200">' +
    escapeHtml(product.brand || product.name) +
    '</span><span class="block truncate text-[11.5px] text-slate-500">' +
    escapeHtml(product.manufacturer || product.category || '') +
    '</span></span></div>' +
    '<div class="border-t border-white/8 px-4 py-2">' +
    identity +
    '</div>' +
    (specs
      ? '<div class="border-t border-white/8 px-4 py-2"><p class="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">Спецификация</p>' +
        specs +
        '</div>'
      : '') +
    (product.notes
      ? '<div class="border-t border-white/8 px-4 py-2.5 text-[11.5px] leading-relaxed text-slate-400">' +
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
        '<span class="min-w-0"><span class="block text-[12px] font-medium text-slate-200">' +
        escapeHtml(row[0]) +
        '</span><span class="block text-[11px] text-slate-500">' +
        escapeHtml(row[1]) +
        '</span></span>' +
        '<span class="shrink-0 text-[10.5px] text-slate-500">' +
        escapeHtml(row[2]) +
        '</span></div>'
      );
    })
    .join('');

  return (
    '<div class="px-4 pb-2 pt-3">' +
    '<p class="text-[12.5px] font-semibold text-slate-200">Праг за аларма</p>' +
    '<p class="mt-1 text-[12px] leading-relaxed text-slate-400">' +
    'Вашата долна граница за този артикул. Щом някой склад падне под нея, системата вдига ' +
    'аларма — прагът не спира и не купува нищо, само ви казва.' +
    '</p></div>' +
    '<div class="border-t border-white/8 px-4 py-2">' +
    '<p class="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">Кога се вдига аларма</p>' +
    rows +
    '</div>' +
    '<div class="border-t border-white/8 px-4 py-2.5">' +
    '<p class="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">Къде отива</p>' +
    '<p class="text-[11.5px] leading-relaxed text-slate-400">' +
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
      '<div class="px-5 py-5"><p class="mb-3 text-[13px] text-slate-500">' +
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
        '<div class="flex items-center gap-4 rounded-xl border px-4 py-3 ' +
        (isBest ? 'border-emerald-500/35 bg-emerald-500/[0.06]' : 'border-white/8 bg-ink-850') +
        '">' +
        '<span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg ' +
        (isBest ? 'bg-emerald-500/15' : 'bg-white/5') +
        '"><i class="fa-solid fa-warehouse text-[12px] ' +
        (isBest ? 'text-emerald-400' : 'text-slate-500') +
        '"></i></span>' +
        '<span class="min-w-0 flex-1">' +
        (supplier.url
          ? '<a href="' +
            escapeHtml(supplier.url) +
            '" target="_blank" rel="noopener noreferrer" class="group/link block truncate text-[13px] font-medium text-slate-200 hover:text-accent-500 hover:underline" title="Отвори страницата в магазина">'
          : '<span class="block truncate text-[13px] font-medium text-slate-200">') +
        escapeHtml(supplier.name) +
        (supplier.url
          ? '<i class="fa-solid fa-arrow-up-right-from-square ml-1.5 text-[9px] opacity-0 transition group-hover/link:opacity-100"></i>'
          : '') +
        (isBest
          ? '<span class="ml-2 rounded-md bg-emerald-500/15 px-1.5 py-0.5 align-middle text-[10px] font-bold uppercase tracking-wide text-emerald-400">най-евтин</span>'
          : '') +
        (supplier.url ? '</a>' : '</span>') +
        '<span class="block truncate font-mono text-[11.5px] text-slate-500">' +
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
        '<span class="shrink-0 text-right"><span class="num block text-[14px] font-semibold ' +
        (isBest ? 'text-emerald-400' : 'text-slate-200') +
        '"><span class="masked">' +
        (typeof supplier.price === 'number' ? euro.format(supplier.price) : '—') +
        '</span></span>' +
        (premium !== null && premium > 0.01
          ? '<span class="num block text-[11.5px] text-slate-500"><span class="masked">+' +
            premium.toFixed(1) +
            '%</span></span>'
          : '') +
        '</span>' +
        '<span class="w-24 shrink-0 text-right text-[11.5px] ' +
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
        '<span class="w-24 shrink-0 text-right text-[11.5px] text-slate-500">' +
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
    '<div class="space-y-2 px-5 py-4">' +
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
        '<div><dt class="spec-key text-[10.5px] uppercase tracking-wide">' +
        escapeHtml(pair[0]) +
        '</dt><dd class="mt-0.5 text-[12.5px] text-slate-200">' +
        escapeHtml(pair[1]) +
        '</dd></div>'
      );
    })
    .join('');

  return (
    '<div class="mb-3 rounded-xl border border-white/8 bg-ink-900 px-4 py-3">' +
    (cells
      ? '<dl class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">' +
        cells +
        '</dl>'
      : '') +
    (product.notes
      ? '<p class="' +
        (cells ? 'mt-3 border-t border-white/8 pt-3 ' : '') +
        'text-[12px] leading-relaxed text-slate-400">' +
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
        '<td class="px-5 py-4"><div class="flex items-start gap-3">' +
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
        '<td class="px-3 py-4 text-right">' +
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
        '<td class="px-3 py-4 text-right">' +
        (view.best
          ? '<span class="num block font-semibold text-accent-300"><span class="masked">' +
            euro.format(view.best.price) +
            '</span></span>' +
            trendHtml(view)
          : emptyMark()) +
        '</td>' +
        '<td class="px-3 py-4">' +
        rangeCellHtml(product, view) +
        '</td>' +
        '<td class="px-3 py-4">' +
        (view.margin === null
          ? emptyMark()
          : '<span class="num block text-right font-semibold ' +
            marginTone +
            '"><span class="masked">' +
            view.margin.toFixed(1) +
            '%</span></span>') +
        '</td>' +
        '<td class="px-3 py-4">' +
        (!view.best
          ? emptyMark()
          : view.best.url
          ? '<a href="' +
            escapeHtml(view.best.url) +
            '" target="_blank" rel="noopener noreferrer" data-external class="flex items-center gap-1.5 text-[12.5px] text-slate-400 transition hover:text-accent-500 hover:underline"><span class="truncate">' +
            escapeHtml(view.best.host) +
            '</span><i class="fa-solid fa-arrow-up-right-from-square shrink-0 text-[9px]"></i></a>'
          : '<span class="block truncate text-[12.5px] text-slate-400">' +
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
        '<td class="px-3 py-4"><span class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ' +
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
        '<td class="px-2 py-4"><span class="flex items-center justify-end">' +
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
    ? 'fa-solid fa-eye-slash text-[12px]'
    : 'fa-solid fa-eye text-[12px]';
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
      '<p class="px-5 py-6 text-[13px] text-slate-500">' +
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
          '" class="mr-1.5 mt-1 inline-block rounded-md border border-white/10 bg-ink-850 px-2 py-0.5 text-[11.5px] text-slate-300 transition hover:border-accent-500/40 hover:text-accent-300">' +
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
      ? '<span class="mt-1 block truncate text-[11.5px] text-slate-500" title="' +
        escapeHtml(shop.searchSummary) +
        '">' +
        escapeHtml(shop.searchSummary) +
        '</span>'
      : !live.searchable
        ? '<span class="mt-1 block truncate text-[11.5px] text-slate-500" title="' +
          escapeHtml(live.reason) +
          '">' +
          escapeHtml(live.reason) +
          '</span>'
        : '';

  const error =
    !off && shop.lastError
      ? '<span class="mt-1 flex items-start gap-1.5 text-[11.5px] text-amber-400/90" title="' +
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
    ? '<span class="text-[12px] text-slate-600">—</span>'
    : '<button type="button" data-reprobe="' +
      escapeHtml(shop.id) +
      '" class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 py-2 text-[12.5px] font-medium text-slate-300 transition hover:border-accent-500/40 hover:text-accent-300" ' +
      'title="Проверява наново дали търсачката на магазина работи, и ако не — дали има карта на сайта.">' +
      '<i class="fa-solid fa-arrows-rotate text-[11px]"></i>Провери наново</button>';

  return (
    '<div class="grid grid-cols-[minmax(0,1fr)_7.5rem_11.5rem_5.5rem] items-center gap-4 px-5 py-4' +
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
    '<span class="mt-0.5 block truncate font-mono text-[11.5px] text-slate-500">' +
    escapeHtml(shop.host) +
    '</span>' +
    note +
    error +
    '</span>' +
    /* 2 — the discount, which decides which shop the search calls cheapest */
    '<label class="flex items-center justify-end gap-1.5 text-[12px] text-slate-500">' +
    '<input type="number" min="0" max="100" step="0.5" value="' +
    Number(shop.discountPercent) +
    '" data-discount="' +
    escapeHtml(shop.id) +
    '" aria-label="Отстъпка при ' +
    escapeHtml(shop.name) +
    '" class="num w-16 rounded-lg border border-white/10 bg-ink-850 px-2 py-1.5 text-right text-[13px] text-slate-200 outline-none focus:border-accent-500/60" />%</label>' +
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
  element.className = 'text-[12.5px] leading-relaxed ' + (palette[tone] || palette.info);
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
        '<span class="min-w-0 flex-1 truncate text-[12px] text-slate-300" title="' +
        escapeHtml(sample.title) +
        '">' +
        escapeHtml(sample.title || '(без име)') +
        '</span>' +
        (sample.price === null
          ? '<span class="shrink-0 text-[11.5px] text-amber-400">без цена</span>'
          : '<span class="num shrink-0 text-[12px] font-semibold text-slate-200">' +
            Number(sample.price).toFixed(2) +
            '</span>') +
        '</li>'
      );
    })
    .join('');

  box.className = 'rounded-xl border ' + tone.border + ' ' + tone.bg + ' px-4 py-3.5';
  box.innerHTML =
    '<p class="text-[13px] font-semibold ' +
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
      ? '<p class="mt-1 text-[12px] text-slate-400">Проверете имената и цените — ако отговарят на видяното в сайта, запазете.</p>'
      : '<p class="mt-1 text-[12px] text-slate-400">Част от редовете са непълни. Запазването пак работи, но проверете внимателно.</p>') +
    '<ul class="mt-2">' +
    rows +
    '</ul>' +
    '<p class="mt-2.5 break-all font-mono text-[10.5px] text-slate-500">' +
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
    '<i class="fa-solid fa-circle-notch fa-spin text-[13px]"></i>Разпознавам…';
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
    status.className = 'text-[12.5px] text-red-500';
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
      '<span class="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10.5px] font-semibold text-slate-300">' +
        '<i class="fa-solid fa-bolt text-[8px] opacity-60"></i>' +
        escapeHtml(specs.watt) +
        '</span>',
    );
  }

  if (specs.socket) {
    chips.push(
      '<span class="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-slate-300">' +
        escapeHtml(specs.socket) +
        '</span>',
    );
  }

  const tone = kelvinTone(specs.kelvin);
  if (tone) {
    chips.push(
      '<span class="inline-flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10.5px] ' +
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
      '<span class="rounded-md bg-white/5 px-1.5 py-0.5 text-[10.5px] text-slate-400">' +
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
    '<div class="px-4 pb-2 pt-3">' +
    '<p class="text-[12.5px] font-semibold leading-snug text-slate-200">' +
    escapeHtml(hit.name) +
    '</p></div>' +
    '<div class="border-t border-white/8 px-4 py-2">' +
    rows +
    '</div>' +
    '<div class="border-t border-white/8 px-4 py-2">' +
    pricing +
    '</div>' +
    '<p class="border-t border-white/8 px-4 py-2.5 font-mono text-[11px] text-slate-500">' +
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
    '<div class="rounded-2xl border border-white/8 bg-ink-900 px-5 py-4 shadow-panel">' +
    '<div class="flex flex-wrap items-baseline justify-between gap-2">' +
    '<p class="text-[13px] font-medium ' +
    (carrying.length ? 'text-slate-200' : 'text-slate-400') +
    '">' +
    (carrying.length
      ? formatMessage('Намерено в {found} от {total} магазина', {
          found: carrying.length,
          total: result.shops.length,
        })
      : 'Не се намери в нито един магазин') +
    '</p>' +
    '<p class="text-[11.5px] text-slate-500"><i class="fa-solid fa-bolt mr-1 text-[9px] text-accent-400"></i>' +
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
              '<span class="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/12 px-2 py-1 text-[11.5px] font-medium text-emerald-400">' +
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
      ? '<p class="mt-2 text-[11.5px] text-slate-500">Няма го в: ' +
        escapeHtml(empty.map((shop) => shop.name).join(', ')) +
        '</p>'
      : '') +
    (refused.length
      ? '<p class="mt-1.5 text-[11.5px] text-amber-400"><i class="fa-solid fa-triangle-exclamation mr-1 text-[9px]"></i>' +
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

function matchBadgeHtml(hit) {
  const match = hit.match;

  if (!match) {
    // Older payload, or matching switched off: fall back to what the
    // shop's own search engine implied.
    return hit.matched
      ? ''
      : '<span class="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] text-amber-400/90" ' +
          'title="Търсачката на магазина върна това по подобие — името не съдържа търсеното.">по подобие</span>';
  }

  const band = MATCH_BANDS[match.band] || MATCH_BANDS.weak;
  const percent = Math.round(match.confidence * 100);

  const detail = (match.reasons || [])
    .slice(0, 6)
    .map((reason) =>
      reason.right
        ? (reason.agrees ? '✓ ' : '✕ ') + reason.label + ': ' + reason.left + ' / ' + reason.right
        : (reason.agrees ? '✓ ' : '✕ ') + reason.left,
    )
    .join('\n');

  const title = match.explanation + (detail ? '\n\n' + detail : '');

  return (
    '<span class="rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold ' +
    band.className +
    '" title="' +
    escapeHtml(title) +
    '">' +
    translate(band.label) +
    ' ' +
    percent +
    '%' +
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
  if (!best || priced.length < 2) return '';

  const saving = dearest - best.effectivePrice;

  return (
    '<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-white/8 bg-emerald-500/[0.05] px-5 py-3">' +
    '<span class="text-[13px] text-slate-300">Най-евтин: ' +
    '<strong class="font-semibold text-slate-100">' +
    escapeHtml(best.shopName) +
    '</strong> — <strong class="num font-semibold text-emerald-400">' +
    best.effectivePrice.toFixed(2) +
    ' ' +
    escapeHtml(best.effectiveCurrency) +
    '</strong></span>' +
    (saving >= 0.01
      ? '<span class="text-[12.5px] text-slate-500">' +
        escapeHtml(
          formatMessage('с {amount} под най-скъпата оферта за същия артикул', {
            amount: saving.toFixed(2) + ' ' + best.effectiveCurrency,
          }),
        ) +
        '</span>'
      : '') +
    (best.match
      ? '<span class="ml-auto text-[12px] text-slate-500">' +
        escapeHtml(
          formatMessage('съвпадение {percent}%', {
            percent: Math.round(best.match.confidence * 100),
          }),
        ) +
        '</span>'
      : '') +
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
        (matching.aiQuota.renews ? ' този месец' : ' (безплатен план)'),
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
    '<span class="text-[11.5px] text-slate-500" title="Моделът се пита само за офертите, които спецификациите не решават.">' +
    '<i class="fa-solid fa-wand-magic-sparkles mr-1 text-[10px] text-accent-500/70"></i>' +
    parts.join(' · ') +
    '</span>'
  );
}

function renderCatalogueResults(hits, query, matching) {
  const results = $('#catalogue-results');
  catalogueHits = hits;

  if (!hits.length) {
    results.innerHTML =
      '<div class="rounded-2xl border border-white/8 bg-ink-900 px-5 py-12 text-center text-[13.5px] text-slate-500 shadow-panel">' +
      '<i class="fa-solid fa-inbox mb-3 block text-2xl text-slate-700"></i>' +
      'Нищо за „' +
      escapeHtml(query) +
      '". Пробвайте с модел или артикулен номер вместо описание.</div>';
    return;
  }

  // Rows the matcher is not convinced by are listed but never counted.
  // A cheaper price on a different article is not a saving, and letting
  // one set the "from" figure — or wear the crown — turns the whole
  // comparison into an argument for buying the wrong thing.
  const MATCH_FLOOR = 0.7;
  const isWeak = (hit) => Boolean(hit.match) && hit.match.confidence < MATCH_FLOOR;

  const priced = hits.filter((hit) => hit.effectivePrice !== null && !isWeak(hit));
  const cheapest = priced.length
    ? Math.min(...priced.map((hit) => hit.effectivePrice))
    : 0;
  const dearest = priced.length ? Math.max(...priced.map((hit) => hit.effectivePrice)) : 0;

  // The crown goes to the cheapest row we believe is the right article,
  // wherever it now sits: the list is ordered by confidence first.
  const best = priced.reduce(
    (winner, hit) => (winner === null || hit.effectivePrice < winner.effectivePrice ? hit : winner),
    null,
  );

  const suppliers = new Set(hits.map((hit) => hit.host));
  const showSupplier = true;

  // Per-group extremes: the cheapest cable is not comparable with the
  // cheapest reel, so each group is coloured against its own range.
  const groupStats = new Map();
  hits.forEach(function (hit) {
    if (hit.effectivePrice === null || isWeak(hit)) return;
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

  const strong = hits.filter((hit) => !isWeak(hit));
  const weak = hits.filter(isWeak);

  // Eight kitchens returned for "лед крушка" is not eight results. When
  // nothing clears the bar, the honest answer is "nothing matched" with
  // the shop's guesses folded away — listing them like results makes the
  // tool look broken when it was the shop's search engine being generous.
  if (strong.length === 0) {
    results.innerHTML =
      '<div class="overflow-hidden rounded-2xl border border-white/8 bg-ink-900 shadow-panel">' +
      '<div class="px-5 py-10 text-center">' +
      '<i class="fa-solid fa-magnifying-glass mb-3 block text-2xl text-slate-700"></i>' +
      '<p class="text-[14px] font-medium text-slate-300">Никой доставчик няма „' +
      escapeHtml(query) +
      '"</p>' +
      '<p class="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-slate-500">' +
      'Магазините върнаха ' +
      weak.length +
      ' ' +
      plural(weak.length, 'резултат', 'резултата') +
      ', но нито един не е този артикул. Опитайте с модел, мощност или артикулен номер.' +
      '</p>' +
      '<button type="button" id="show-weak" class="mt-4 rounded-lg border border-white/10 bg-ink-850 px-4 py-2 text-[12.5px] font-medium text-slate-400 transition hover:text-slate-200">' +
      'Покажи какво върнаха магазините' +
      '</button>' +
      '</div>' +
      '<div id="weak-list" class="hidden divide-y divide-white/[0.06] border-t border-white/8"></div>' +
      '</div>';

    const list = document.getElementById('weak-list');
    list.innerHTML = weak
      .map(function (hit) {
        return (
          '<div class="flex items-center gap-3 px-5 py-2.5 text-[12.5px]">' +
          '<span class="min-w-0 flex-1 truncate text-slate-400">' + escapeHtml(hit.name) + '</span>' +
          '<span class="shrink-0 text-slate-600">' + escapeHtml(hit.shopName) + '</span>' +
          '<span class="num shrink-0 text-slate-500">' +
          (hit.effectivePrice === null ? '—' : hit.effectivePrice.toFixed(2) + ' ' + escapeHtml(hit.effectiveCurrency)) +
          '</span></div>'
        );
      })
      .join('');

    document.getElementById('show-weak').addEventListener('click', function () {
      list.classList.toggle('hidden');
      this.textContent = list.classList.contains('hidden')
        ? 'Покажи какво върнаха магазините'
        : 'Скрий';
    });

    return;
  }

  const ordered = [
    ...strong.filter((hit) => comparable.has(hit.groupKey)),
    ...strong.filter((hit) => !comparable.has(hit.groupKey)),
    ...weak,
  ];

  let singlesHeaderDone = false;
  let weakHeaderDone = false;

  const rows = ordered
    .map(function (hit, index) {
      const stat = groupStats.get(hit.groupKey) || { min: cheapest, max: dearest, count: 1 };
      let header = '';

      const groupHeader = (label, note, spread, currency) =>
        '<tr><td colspan="' +
        columnCount +
        '" class="border-y border-white/8 bg-ink-950/60 px-5 py-2">' +
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

      if (isWeak(hit)) {
        // Checked first: a doubtful row often shares a group with the
        // real ones, and falling into the group branch would file it
        // under a heading that says these are comparable.
        if (!weakHeaderDone) {
          weakHeaderDone = true;
          header = groupHeader(
            'Може да не е същият артикул',
            'показани, но извън сравнението на цените',
            0,
            '',
          );
        }
      } else if (comparable.has(hit.groupKey)) {
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
            '" target="_blank" rel="noopener noreferrer" class="block truncate text-[13px] font-medium text-slate-200 transition group-hover:text-accent-500" title="' +
            escapeHtml(hit.name) +
            '">' +
            escapeHtml(hit.name) +
            '</a>'
          : '<span class="block truncate text-[13px] font-medium text-slate-200" title="' +
            escapeHtml(hit.name) +
            '">' +
            escapeHtml(hit.name) +
            '</span>') +
        (specs || hit.match || !hit.matched || hit.recordedAt
          ? '<span class="mt-1 flex flex-wrap items-center gap-1">' +
            matchBadgeHtml(hit) +
            // A price typed in three weeks ago and one read three seconds
            // ago rank together, which is right — but they are not the
            // same claim, and only this says so.
            (hit.priceSource === 'manual'
              ? '<span class="rounded-md bg-violet-500/12 px-1.5 py-0.5 text-[10.5px] text-violet-300" ' +
                'title="Цена, която вие сте въвели. Нищо не я презарежда — проверете я, ако е стара.">' +
                'ваша цена · ' +
                escapeHtml(formatRelative(hit.recordedAt)) +
                '</span>'
              : hit.recordedAt
                ? '<span class="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] text-slate-400" ' +
                  'title="Прочетено от магазина по-рано и запазено. Отметнете „Питай наново“ за цена към момента.">' +
                  'прочетено ' +
                  escapeHtml(formatRelative(hit.recordedAt)) +
                  '</span>'
                : '') +
            specs +
            '</span>'
          : '') +
        '</span></span></td>' +
        (showSupplier
          ? '<td class="px-3 py-3 text-[12px] text-slate-400">' +
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
            '<span class="block truncate font-mono text-[10.5px] text-slate-500">' +
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
          ? '<td class="num px-3 py-3 text-right text-[12px] ' +
            (hit.discountPercent > 0 ? 'text-slate-500 line-through' : 'text-slate-600') +
            '">' +
            (hit.listedPrice === null ? '—' : hit.listedPrice.toFixed(2)) +
            '</td>'
          : '') +
        '<td class="px-3 py-3">' +
        '<span class="flex items-baseline justify-end gap-1.5">' +
        '<span class="num text-[16px] font-semibold ' +
        (isBest ? 'text-emerald-400' : 'text-slate-200') +
        '">' +
        (hit.effectivePrice === null ? '—' : hit.effectivePrice.toFixed(2)) +
        '</span>' +
        '<span class="text-[10.5px] text-slate-600">' +
        escapeHtml(hit.effectiveCurrency) +
        '</span></span>' +
        (hit.discountPercent > 0 && hit.listedPrice !== null
          ? '<span class="mt-0.5 block text-right text-[10.5px] text-accent-300/80">' +
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
            '<i class="fa-solid fa-check text-[8px]"></i>най-евтин</span>'
          : delta === null || stat.count < 2
            ? '<span class="text-[11px] text-slate-600">—</span>'
            : '<span class="num block text-[12.5px] font-semibold ' +
              deltaTone +
              '">+' +
              delta.toFixed(2) +
              '</span>' +
              '<span class="num block text-[10.5px] text-slate-500">+' +
              over.toFixed(0) +
              '%</span>') +
        '</td>' +
        '<td class="py-3 pl-3 pr-5">' +
        (hit.inStock === false
          ? '<span class="inline-flex items-center gap-1.5 rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-400"><i class="fa-solid fa-circle-minus text-[8px]"></i>изчерпан</span>'
          : hit.inStock === true
            ? '<span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-400"><i class="fa-solid fa-circle-check text-[8px]"></i>наличен</span>'
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
  const columns = anyDiscount
    ? '<col class="w-[40%]" /><col class="w-[18%]" /><col class="w-[9%]" />' +
      '<col class="w-[15%]" /><col class="w-[9%]" /><col class="w-[9%]" />'
    : '<col class="w-[46%]" /><col class="w-[20%]" />' +
      '<col class="w-[16%]" /><col class="w-[9%]" /><col class="w-[9%]" />';

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
      ? '<span class="rounded-md bg-emerald-500/12 px-2 py-1 text-[11.5px] font-semibold text-emerald-400">' +
        escapeHtml(
          formatMessage('спестявате до {amount} на бройка', {
            amount: (dearest - cheapest).toFixed(2) + ' ' + priced[0].effectiveCurrency,
          }),
        ) +
        '</span>'
      : bestSaving > 0
        ? '<span class="rounded-md bg-emerald-500/12 px-2 py-1 text-[11.5px] font-semibold text-emerald-400">' +
          escapeHtml(
            formatMessage('спестявате до {amount}', {
              amount: bestSaving.toFixed(2) + ' ' + priced[0].effectiveCurrency,
            }),
          ) +
          '</span>'
        : '';

  // When a shop's search guesses at everything, say so once at the top
  // rather than leaving the user to wonder why "СВТ" returned downlights.
  const anyMatched = hits.some((hit) => hit.matched);
  const guessNote = anyMatched
    ? ''
    : '<div class="border-b border-white/8 bg-amber-500/[0.06] px-5 py-2.5 text-[12px] text-amber-400">' +
      '<i class="fa-solid fa-circle-info mr-1.5 text-[10px]"></i>' +
      'Никой магазин не намери точно „' +
      escapeHtml(query) +
      '". Показаното е това, което техните търсачки върнаха по подобие.</div>';

  results.innerHTML =
    '<div class="overflow-hidden rounded-2xl border border-white/8 bg-ink-900 shadow-panel">' +
    guessNote +
    '<div class="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 px-5 py-3.5">' +
    '<p class="text-[12.5px] text-slate-500">' +
    '<strong class="text-slate-300">' +
    hits.length +
    '</strong> ' +
    escapeHtml(
      pluralMessage(suppliers.size, {
        one: 'оферти в {n} магазин',
        other: 'оферти в {n} магазина',
      }),
    ) +
    range +
    '</p>' +
    matchingSummaryHtml(matching) +
    spread +
    '</div>' +
    verdictHtml(best, priced, dearest) +
    '<div class="hidden">' +
    '</div>' +
    '<table class="w-full table-fixed text-left"><colgroup>' +
    columns +
    '</colgroup>' +
    '<thead><tr class="border-b border-white/8 text-[10.5px] uppercase tracking-wide text-slate-500 [&>th]:whitespace-nowrap">' +
    '<th class="py-2.5 pl-5 pr-3 font-semibold">Артикул</th>' +
    '<th class="px-3 py-2.5 font-semibold">Магазин</th>' +
    (anyDiscount ? '<th class="px-3 py-2.5 text-right font-semibold">Етикет</th>' : '') +
    '<th class="px-3 py-2.5 text-right font-semibold">Вие плащате</th>' +
    '<th class="px-3 py-2.5 text-right font-semibold">Надплащате</th>' +
    '<th class="py-2.5 pl-3 pr-5 font-semibold">Наличност</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table></div>';
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
  box.className = 'mt-3 text-[12.5px] text-slate-400';
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

  if (understood.brand) chips.push(['Марка', understood.brand]);
  if (understood.category) chips.push(['Вид', CATEGORY_LABELS[understood.category] || understood.category]);
  (understood.measurements || []).forEach(function (m) {
    chips.push([UNIT_LABELS[m.unit] || m.unit, m.value + m.unit]);
  });
  Object.keys(understood.specs || {}).forEach(function (key) {
    chips.push([SPEC_LABELS[key] || key, understood.specs[key]]);
  });

  return (
    '<div class="overflow-hidden rounded-2xl border border-accent-500/25 bg-accent-500/[0.05]">' +
    '<div class="flex items-center gap-2 border-b border-accent-500/15 px-5 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-accent-600 dark:text-accent-400">' +
    '<i class="fa-solid fa-wand-magic-sparkles text-[11px]"></i>Разчетох заявката' +
    '<span class="ml-auto font-normal normal-case text-slate-500">' + shops + ' ' + plural(shops, 'доставчик', 'доставчици') + '</span>' +
    '</div>' +
    '<div class="px-5 py-4">' +
    (chips.length
      ? '<div class="flex flex-wrap gap-1.5">' +
        chips
          .map(
            ([label, value], index) =>
              // Staggered so the attributes appear one after another —
              // the reading is instant, and showing it instantly makes it
              // look like a static label rather than something worked out.
              '<span class="chip-in rounded-md bg-ink-900 px-2 py-1 text-[11.5px] text-slate-300 ring-1 ring-white/8" style="animation-delay:' +
              index * 70 +
              'ms">' +
              '<span class="text-slate-500">' + escapeHtml(label) + ':</span> ' +
              escapeHtml(String(value)) +
              '</span>',
          )
          .join('') +
        '</div>'
      : '<p class="text-[12.5px] text-slate-400">Търся по описание — добавете мощност, размер или модел за по-точно сравнение.</p>') +
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
      '<span class="text-[12.5px] text-slate-200">' +
      '<strong class="font-semibold">AI проверява</strong> ' +
      stage.count + ' ' + plural(stage.count, 'оферта', 'оферти') +
      ', които спецификациите не решават' +
      '</span>' +
      '<span class="ml-auto font-mono text-[11px] text-slate-500">' + escapeHtml(stage.model || '') + '</span>' +
      '</div>';
    return;
  }

  box.innerHTML =
    '<div class="flex items-center gap-2.5 text-[12.5px] text-slate-400">' +
    '<i class="fa-solid fa-circle-notch fa-spin text-[11px] text-slate-500"></i>' +
    escapeHtml(stage.text) +
    '</div>';
}

const CATEGORY_LABELS = {
  'led-bulb': 'крушка',
  cable: 'кабел',
  laptop: 'лаптоп',
  phone: 'телефон',
  monitor: 'монитор',
  tv: 'телевизор',
  tool: 'инструмент',
  breaker: 'прекъсвач',
};
const UNIT_LABELS = {
  W: 'Мощност', K: 'Цвят', V: 'Напрежение', A: 'Ток', GB: 'Памет', TB: 'Памет',
  IN: 'Размер', M: 'Дължина', MM2: 'Сечение', HZ: 'Честота', LM: 'Поток',
};
const SPEC_LABELS = {
  socket: 'Фасунга', cross_section: 'Сечение', resolution: 'Резолюция',
  connector: 'Конектор', protection: 'Защита', curve: 'Характеристика',
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
      category: 'led-bulb',
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
        band: 'weak', confidence: 0.42,
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
      category: 'cable',
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
        band: 'weak', confidence: 0.35,
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
      confidence: offer.confidence,
      explanation: offer.explanation,
      reasons: offer.reasons,
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
async function runDemoSearch(query) {
  const entry = demoEntryFor(query);
  const results = $('#catalogue-results');

  if (!entry) {
    $('#live-results').innerHTML = '';
    results.innerHTML =
      '<div class="rounded-2xl border border-white/8 bg-ink-900 px-5 py-10 text-center shadow-panel">' +
      '<i class="fa-solid fa-flask mb-3 block text-2xl text-slate-700"></i>' +
      '<p class="text-[13.5px] text-slate-400">' +
      translate('Примерният каталог съдържа само крушки и кабели.') +
      '</p><p class="mt-1.5 text-[12.5px] text-slate-500">' +
      translate('Влезте, за да търсите при вашите доставчици — там е целият им асортимент.') +
      '</p>' +
      '<button type="button" data-signup class="mt-4 inline-flex items-center gap-2 rounded-xl bg-accent-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-glow transition hover:bg-accent-600">' +
      translate('Започни 7 дни безплатно') +
      '</button></div>';
    return;
  }

  handleSearchEvent({ type: 'understood', understood: entry.understood, shops: DEMO_SHOPS.length }, query);

  for (const shop of DEMO_SHOPS) {
    await pause(260 + Math.random() * 220);
    const count = entry.offers.filter((offer) => offer.shop === shop.host).length;
    handleSearchEvent(
      { type: 'shop', name: shop.name, ok: true, count: count, durationMs: 700 + Math.random() * 900 },
      query,
    );
  }

  await pause(320);
  handleSearchEvent({ type: 'matching', candidates: entry.offers.length }, query);

  await pause(520);
  handleSearchEvent({ type: 'ai', comparisons: 2, model: 'claude' }, query);

  await pause(240);
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
  note.className = 'mt-3 text-center text-[12px] text-slate-500';
  note.textContent = translate(
    'Примерни данни и измислени доставчици. Влезте, за да питате вашите.',
  );
  container.appendChild(note);
}

async function searchCatalogue() {
  const query = $('#catalogue-query').value.trim();
  const results = $('#catalogue-results');
  const live = $('#live-results');

  if (query.length < 2) {
    results.innerHTML = '<p class="text-[13px] text-amber-400">Въведете поне 2 знака.</p>';
    return;
  }

  $('#catalogue-spinner').classList.remove('hidden');
  results.innerHTML = '';
  aiShownUntil = 0;

  // Nobody signed in means no suppliers to ask, so there is nothing for the
  // real endpoint to answer. The visitor came from a button that promised to
  // show them a search; they get one.
  if (!isIdentified()) {
    try {
      await runDemoSearch(query);
    } finally {
      $('#catalogue-spinner').classList.add('hidden');
    }
    return;
  }

  live.innerHTML =
    '<div class="flex items-center gap-2.5 rounded-2xl border border-accent-500/25 bg-accent-500/[0.05] px-5 py-3.5 text-[13px] text-slate-300">' +
    '<i class="fa-solid fa-circle-notch fa-spin text-[12px] text-accent-400"></i>Разчитам заявката…</div>';

  try {
    const url =
      ENDPOINTS.discoveryCompareStream +
      '?q=' + encodeURIComponent(query) +
      ($('#catalogue-instock').checked ? '&inStockOnly=true' : '');

    // fetch, not EventSource: the latter cannot send the auth header, and
    // this endpoint is scoped to an account like every other.
    const response = await fetch(url, {
      headers: authHeaders({ Accept: 'text/event-stream' }),
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
    results.innerHTML = failureHtml(error, 'Търсенето не успя');
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
      '<div class="rounded-2xl border border-white/8 bg-ink-900 px-5 py-8 text-center shadow-panel">' +
      '<p class="text-[13.5px] text-slate-300">' +
      translate('Сесията е изтекла. Влезте отново, за да продължите.') +
      '</p>' +
      '<button type="button" data-signin class="mt-4 inline-flex items-center gap-2 rounded-xl bg-accent-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-glow transition hover:bg-accent-600">' +
      translate('Вход') +
      '</button></div>'
    );
  }

  if (status === 429) {
    return (
      '<p class="text-[13px] text-amber-400">' +
      translate('Твърде много заявки. Изчакайте минута и опитайте пак.') +
      '</p>'
    );
  }

  return (
    '<p class="text-[13px] text-red-400">' +
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
    row.className = 'flex items-center gap-2 text-[12.5px]';
    row.innerHTML = event.ok
      ? '<i class="fa-solid fa-check text-[10px] text-emerald-400"></i>' +
        '<span class="text-slate-300">' + escapeHtml(event.name) + '</span>' +
        '<span class="text-slate-500">' + event.count + ' ' + plural(event.count, 'оферта', 'оферти') + '</span>' +
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
        'Сравнявам ' + event.candidates + ' ' + plural(event.candidates, 'оферта', 'оферти') + ' по спецификация…',
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
        renderCatalogueResults(payload.hits, query, payload.matching);
        void refreshPlanBar();
      }, wait);
      return false;
    }

    renderShopOutcomes(event);
    renderCatalogueResults(event.hits, query, event.matching);
    // The search may have just spent from the allowance.
    void refreshPlanBar();
    return false;
  }

  if (event.type === 'error') {
    $('#catalogue-results').innerHTML =
      '<p class="text-[13px] text-red-400">' + escapeHtml(event.message) + '</p>';
    return true;
  }

  return event.type === 'done';
}

/* --- Pricing a whole order ---------------------------------------- */

$('#basket-toggle').addEventListener('click', function () {
  $('#basket-panel').classList.toggle('hidden');
});

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

async function priceBasket() {
  const lines = parseBasketLines($('#basket-lines').value);
  const box = $('#basket-results');

  if (!lines.length) {
    box.innerHTML =
      '<p class="text-[13px] text-amber-400">Напишете поне един артикул.</p>';
    return;
  }

  if (!isIdentified()) {
    box.innerHTML = demoBasketHtml(lines);
    return;
  }

  $('#basket-spinner').classList.remove('hidden');
  box.innerHTML =
    '<p class="text-[13px] text-slate-500">Питам доставчиците за ' +
    lines.length +
    ' ' +
    plural(lines.length, 'артикул', 'артикула') +
    '…</p>';

  try {
    const response = await fetch(ENDPOINTS.discoveryBasket, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ lines: lines, useCache: !$('#basket-fresh').checked }),
    });

    if (!response.ok) throw new Error('HTTP ' + response.status);
    renderBasket(await response.json());
  } catch (error) {
    box.innerHTML = failureHtml(error, 'Остойностяването не успя');
  } finally {
    $('#basket-spinner').classList.add('hidden');
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
    '<div class="rounded-xl border border-white/8 bg-ink-850 px-4 py-3.5">' +
    '<p class="text-[11.5px] uppercase tracking-wide text-slate-500">' +
    translate('Всичко от един доставчик') +
    '</p><p class="num mt-1 text-2xl font-bold text-slate-200">' +
    single.toFixed(2) +
    ' <span class="text-[13px] font-normal text-slate-500">EUR</span></p>' +
    '<p class="mt-0.5 text-[12px] text-slate-400">' +
    translate('Електро Склад') +
    '</p></div>' +
    '<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-4 py-3.5">' +
    '<p class="text-[11.5px] uppercase tracking-wide text-emerald-400/80">' +
    translate('Разделена по най-евтиния') +
    '</p><p class="num mt-1 text-2xl font-bold text-emerald-400">' +
    split.toFixed(2) +
    ' <span class="text-[13px] font-normal text-emerald-400/70">EUR</span></p>' +
    '<p class="mt-0.5 text-[12px] text-slate-400">' +
    translate('Електро Склад') +
    ', ' +
    translate('Кабел Про') +
    '</p></div></div>' +
    '<p class="mt-3 rounded-xl border border-white/8 bg-ink-900 px-4 py-3 text-[12.5px] text-slate-400">' +
    translate('Примерна сметка. Влезте, за да остойностите поръчката при вашите доставчици и с вашите отстъпки.') +
    '</p>' +
    '<button type="button" data-signup class="mt-3 inline-flex items-center gap-2 rounded-xl bg-accent-500 px-4 py-2.5 text-[13px] font-semibold text-white shadow-glow transition hover:bg-accent-600">' +
    translate('Започни 7 дни безплатно') +
    '</button>'
  );
}

function renderBasket(result) {
  const box = $('#basket-results');
  const money = (value) =>
    value === null || value === undefined ? '—' : Number(value).toFixed(2);

  // The headline is the comparison a spreadsheet cannot easily make:
  // one supplier for everything, against the order split line by line.
  const complete = result.suppliers.filter(
    (supplier) => supplier.linesCovered === supplier.linesTotal,
  );

  const headline =
    '<div class="grid gap-3 sm:grid-cols-2">' +
    '<div class="rounded-xl border border-white/8 bg-ink-850 px-4 py-3.5">' +
    '<p class="text-[11.5px] uppercase tracking-wide text-slate-500">Всичко от един доставчик</p>' +
    (complete.length
      ? '<p class="num mt-1 text-2xl font-bold text-slate-200">' +
        money(complete[0].total) +
        ' <span class="text-[13px] font-normal text-slate-500">' +
        escapeHtml(result.currency) +
        '</span></p>' +
        '<p class="mt-0.5 text-[12px] text-slate-400">' +
        escapeHtml(complete[0].name) +
        '</p>'
      : '<p class="mt-1 text-[13px] text-amber-400">Никой не покрива цялата заявка</p>') +
    '</div>' +
    '<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-4 py-3.5">' +
    '<p class="text-[11.5px] uppercase tracking-wide text-emerald-400/80">Разделена по най-евтиния</p>' +
    '<p class="num mt-1 text-2xl font-bold text-emerald-400">' +
    money(result.split.total) +
    ' <span class="text-[13px] font-normal text-emerald-400/70">' +
    escapeHtml(result.currency) +
    '</span></p>' +
    '<p class="mt-0.5 text-[12px] text-slate-400">' +
    escapeHtml(result.split.suppliers.join(', ') || '—') +
    '</p>' +
    '</div></div>' +
    (result.saving !== null && result.saving > 0
      ? '<p class="mt-3 rounded-lg bg-emerald-500/12 px-3 py-2 text-[13px] font-semibold text-emerald-400">' +
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
        '<td class="py-2.5 pl-4 pr-3 text-[13px] text-slate-200">' +
        escapeHtml(supplier.name) +
        '</td>' +
        '<td class="px-3 py-2.5 text-[12px] ' +
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
        '<td class="num py-2.5 pl-3 pr-4 text-right text-[13.5px] font-semibold ' +
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
        '<td class="py-2 pl-4 pr-3 text-[12.5px] text-slate-300">' +
        escapeHtml(line.query) +
        '<span class="ml-1.5 text-[11px] text-slate-600">×' +
        line.quantity +
        '</span></td>' +
        (best
          ? '<td class="px-3 py-2 text-[12px] text-slate-400">' +
            escapeHtml(best.shopName) +
            (best.recordedAt
              ? '<span class="ml-1.5 text-[10.5px] text-violet-300" title="Ваша цена или запазен отговор — не е четена в момента.">· ' +
                escapeHtml(formatRelative(best.recordedAt)) +
                '</span>'
              : '') +
            '</td>' +
            '<td class="num py-2 pl-3 pr-4 text-right text-[12.5px] text-slate-200">' +
            money(best.effectivePrice * line.quantity) +
            '</td>'
          : '<td class="px-3 py-2 text-[12px] text-amber-400">никой не го предлага</td>' +
            '<td class="py-2 pl-3 pr-4 text-right text-[12px] text-slate-600">—</td>') +
        '</tr>'
      );
    })
    .join('');

  box.innerHTML =
    headline +
    '<div class="mt-5 overflow-hidden rounded-xl border border-white/8">' +
    '<p class="border-b border-white/8 bg-ink-950/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Цялата поръчка при всеки доставчик</p>' +
    '<table class="w-full text-left"><tbody>' +
    suppliers +
    '</tbody></table></div>' +
    '<div class="mt-4 overflow-hidden rounded-xl border border-white/8">' +
    '<p class="border-b border-white/8 bg-ink-950/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Ред по ред, най-евтиното</p>' +
    '<table class="w-full text-left"><tbody>' +
    rows +
    '</tbody></table></div>' +
    '<p class="mt-3 text-[11.5px] text-slate-600">Изчислено за ' +
    (result.durationMs / 1000).toFixed(1) +
    ' сек.</p>';
}

$('#basket-run').addEventListener('click', priceBasket);

$('#table-empty-action').addEventListener('click', function () {
  $('#add-product').click();
});

$('#catalogue-search').addEventListener('click', searchCatalogue);
$('#catalogue-query').addEventListener('keydown', function (event) {
  if (event.key === 'Enter') searchCatalogue();
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
    '<i class="fa-solid fa-circle-notch fa-spin text-[13px]"></i> Отварям плащането…';

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
    'mt-3 text-[12.5px] ' +
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

  setSession(null);
  account = null;
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
    '<p class="text-[13px] leading-relaxed text-slate-300">Ето вашия API ключ — виждате го само сега.</p>' +
    '<div class="mt-2 flex items-center gap-2 rounded-xl border border-accent-500/30 bg-ink-900 p-3">' +
    '<code id="issued-key" class="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-accent-400">' +
    escapeHtml(apiKey) +
    '</code>' +
    '<button type="button" id="issued-copy" class="shrink-0 rounded-lg border border-white/10 bg-ink-850 px-3 py-2 text-[12.5px] font-medium text-slate-300 transition hover:border-white/25 hover:text-slate-100">' +
    '<i class="fa-solid fa-copy text-[12px]"></i> Копирай</button></div>' +
    '<p class="mt-2 text-[12px] leading-relaxed text-slate-500">Изпратихме копие и на имейла ви. Ключът е за програми — в браузъра оставате влезли и без него.</p>';

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

  try {
    const response = await fetch(ENDPOINTS.billingMe, { headers: authHeaders() });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    account = await response.json();
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
      account.aiMatchesRenew ? 'AI сравнения / месец' : 'AI сравнения (еднократно)',
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
    'nav-link rounded-md px-2 py-0.5 text-[11.5px] font-semibold transition ' +
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
  box.innerHTML = '<p class="text-[12.5px] text-slate-500">Зареждам…</p>';

  try {
    const response = await fetch(ENDPOINTS.billingMe, { headers: authHeaders() });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    account = await response.json();

    $('#account-email').textContent = account.email;
    $('#account-plan').textContent =
      'План ' + account.plan + ' · ' + account.productLimit + ' следени артикула';

    box.innerHTML =
      meterHtml(
        account.aiMatchesRenew ? 'AI сравнения този месец' : 'AI сравнения (еднократно)',
        account.aiMatchesUsed,
        account.aiMatchesLimit,
        { topUp: true },
      ) +
      (account.aiMatchesRenew
        ? ''
        : '<p class="text-[12px] leading-relaxed text-slate-500">Безплатният план дава ' +
          account.aiMatchesLimit +
          ' сравнения еднократно. Търсенето продължава и след това — по спецификации, без модел.</p>') +
      (account.apiKeyPrefix
        ? '<p class="text-[12px] text-slate-500">API ключ: <span class="font-mono text-slate-400">' +
          escapeHtml(account.apiKeyPrefix) +
          '…</span> — за програми. Този вход е за хора.</p>'
        : '');
  } catch (error) {
    box.innerHTML =
      '<p class="text-[12.5px] text-red-400">Данните за акаунта не се заредиха.</p>';
  }
}

function meterHtml(label, used, limit, options) {
  const share = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = share >= 90 ? 'bg-red-500' : share >= 70 ? 'bg-amber-500' : 'bg-accent-500';
  const offerTopUp = options && options.topUp && topUpUrl && share >= 70;

  return (
    '<div>' +
    '<div class="flex items-baseline justify-between gap-3">' +
    '<span class="text-[12.5px] text-slate-400">' + escapeHtml(label) + '</span>' +
    '<span class="num text-[12.5px] font-semibold text-slate-300">' + used + ' / ' + limit + '</span>' +
    '</div>' +
    '<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">' +
    '<div class="h-full rounded-full ' + tone + '" style="width:' + share + '%"></div>' +
    '</div>' +
    // Offered only when it is nearly spent and only when it is actually
    // for sale. A permanent "buy more" next to a full meter is an advert.
    (offerTopUp
      ? '<a href="' + escapeHtml(topUpUrl) + '" target="_blank" rel="noopener" ' +
        'class="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-accent-500 hover:underline">' +
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
    'mt-3 text-[12.5px] ' +
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
async function detectOperator() {
  if (!getApiKey()) return false;

  try {
    const response = await fetch(ENDPOINTS.billingUsers, { headers: authHeaders() });
    const isOperator = response.ok;
    $('#nav-operator').hidden = !isOperator;
    return isOperator;
  } catch (error) {
    $('#nav-operator').hidden = true;
    return false;
  }
}

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

  const ask = async (url) => {
    try {
      const response = await fetch(url, { headers: authHeaders() });
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
    '<div class="bg-ink-900 px-4 py-3.5">' +
    '<div class="flex items-center gap-2">' +
    '<span class="h-1.5 w-1.5 shrink-0 rounded-full ' +
    (ok ? 'bg-emerald-400' : 'bg-amber-400') +
    '"></span>' +
    '<span class="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">' +
    escapeHtml(label) +
    '</span></div>' +
    '<p class="mt-1.5 text-[13.5px] font-medium ' +
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

async function loadOperatorPanel() {
  void loadOperatorHealth();

  const list = $('#operator-list');
  list.innerHTML =
    '<p class="px-5 py-8 text-center text-[13px] text-slate-500">Зареждам…</p>';

  let users;
  try {
    const response = await fetch(ENDPOINTS.billingUsers, { headers: authHeaders() });

    if (response.status === 403) {
      list.innerHTML =
        '<p class="px-5 py-10 text-center text-[13px] text-slate-500">' +
        'Този екран иска операторски ключ — този от <code class="font-mono text-slate-400">API_KEY</code> в средата, ' +
        'не клиентски.</p>';
      return;
    }

    if (!response.ok) throw new Error('HTTP ' + response.status);
    users = await response.json();
  } catch (error) {
    list.innerHTML =
      '<p class="px-5 py-10 text-center text-[13px] text-red-400">' +
      escapeHtml(failureText(error, 'Не се зареди')) +
      '</p>';
    return;
  }

  if (!users.length) {
    list.innerHTML =
      '<div class="px-5 py-12 text-center text-[13.5px] text-slate-500">' +
      '<i class="fa-solid fa-users mb-3 block text-2xl text-slate-700"></i>' +
      'Още няма клиенти. Акаунт се създава сам при първото успешно плащане.</div>';
    return;
  }

  const rows = users
    .map(function (user) {
      const status = STATUS_STYLE[user.status] || STATUS_STYLE.pending;

      return (
        '<tr class="border-b border-white/[0.06] transition hover:bg-white/[0.03]">' +
        '<td class="py-3 pl-5 pr-3">' +
        '<span class="block truncate text-[13px] font-medium text-slate-200">' +
        escapeHtml(user.email) +
        '</span>' +
        (user.name
          ? '<span class="block truncate text-[11.5px] text-slate-500">' +
            escapeHtml(user.name) +
            '</span>'
          : '') +
        '</td>' +
        '<td class="px-3 py-3">' +
        '<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ' +
        status.class +
        '">' +
        status.label +
        '</span></td>' +
        // Editable in place rather than behind a dialog: this is a table an
        // operator scans and corrects, and a modal per row is a modal too many.
        '<td class="px-3 py-3">' +
        '<select data-plan="' +
        escapeHtml(user.id) +
        '" class="rounded-lg border border-white/10 bg-ink-850 px-2 py-1 text-[12.5px] text-slate-300 transition hover:border-accent-500/40 focus:border-accent-500/60 focus:outline-none">' +
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
        '<td class="px-3 py-3 text-right">' +
        '<input type="number" min="0" max="100000" data-limit="' +
        escapeHtml(user.id) +
        '" value="' +
        user.productLimit +
        '" class="num w-20 rounded-lg border border-white/10 bg-ink-850 px-2 py-1 text-right text-[12.5px] text-slate-300 transition hover:border-accent-500/40 focus:border-accent-500/60 focus:outline-none" />' +
        '</td>' +
        // What they are actually spending, next to what they are allowed.
        // A limit on its own says what we sold; this says whether it fits.
        '<td class="num px-3 py-3 text-right text-[12.5px]">' +
        '<span class="' +
        (user.aiMatchesUsed >= user.aiMatchesLimit ? 'text-amber-400' : 'text-slate-400') +
        '">' +
        user.aiMatchesUsed +
        ' / ' +
        user.aiMatchesLimit +
        '</span></td>' +
        '<td class="px-3 py-3 text-[11.5px] text-slate-500">' +
        escapeHtml(user.locale ? user.locale.toUpperCase() : '—') +
        '</td>' +
        '<td class="px-3 py-3">' +
        (user.apiKeyPrefix
          ? '<span class="font-mono text-[11.5px] text-slate-400">' +
            escapeHtml(user.apiKeyPrefix) +
            '…</span>'
          : '<span class="text-[11.5px] text-slate-600">няма ключ</span>') +
        '</td>' +
        '<td class="px-3 py-3 text-[11.5px] text-slate-500">' +
        escapeHtml(
          user.apiKeyLastUsedAt ? formatRelative(user.apiKeyLastUsedAt) : 'не е ползван',
        ) +
        '</td>' +
        '<td class="py-3 pl-3 pr-5 text-right">' +
        '<span class="inline-flex items-center gap-1.5">' +
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
        '" class="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-ink-850 px-3 py-1.5 text-[12px] font-medium text-slate-300 transition hover:border-amber-500/40 hover:text-amber-300">' +
        '<i class="fa-solid fa-key text-[10px]"></i>Нов ключ</button>' +
        '</span></td></tr>'
      );
    })
    .join('');

  list.innerHTML =
    '<table class="w-full text-left">' +
    '<thead><tr class="border-b border-white/8 text-[10.5px] uppercase tracking-wide text-slate-500 [&>th]:whitespace-nowrap">' +
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
    '</tbody></table>';

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
      headers: authHeaders({ 'Content-Type': 'application/json' }),
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
      '<div class="rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] px-5 py-4">' +
      '<p class="text-[13.5px] font-semibold text-amber-400">' +
      '<i class="fa-solid fa-key mr-1.5"></i>Нов ключ за ' +
      escapeHtml(issued.email) +
      '</p>' +
      '<p class="mt-1.5 text-[12.5px] text-slate-400">Копирайте го сега — след като напуснете страницата, ' +
      'няма откъде да се прочете отново.</p>' +
      '<div class="mt-3 flex flex-wrap items-center gap-2">' +
      '<code class="min-w-0 flex-1 overflow-x-auto rounded-lg border border-white/10 bg-ink-950 px-3 py-2.5 font-mono text-[13px] text-emerald-400">' +
      escapeHtml(issued.apiKey) +
      '</code>' +
      '<button type="button" id="copy-issued-key" class="rounded-lg border border-white/10 bg-ink-850 px-3 py-2.5 text-[12.5px] font-medium text-slate-300 transition hover:border-accent-500/40">' +
      '<i class="fa-solid fa-copy mr-1.5 text-[11px]"></i>Копирай</button>' +
      '</div>' +
      (issued.replacedPreviousKey
        ? '<p class="mt-2.5 text-[11.5px] text-amber-400/80">Предишният ключ вече не работи.</p>'
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
    status.className = 'text-[12.5px] ' + (palette[tone] || palette.info);
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

function knownRetailer(host) {
  if (!host) return null;
  const match = Object.keys(KNOWN_HOSTS).find(
    (known) => host === known || host.endsWith('.' + known),
  );
  return match ? KNOWN_HOSTS[match] : null;
}

/**
 * A link with no path — or only a language segment — points at a listing,
 * not at one product.
 */
function isListingUrl(url) {
  try {
    const path = new URL(url.trim()).pathname.replace(/\/+$/, '');
    return path === '' || /^\/(bg|en|ru|de)$/i.test(path);
  } catch (error) {
    return false;
  }
}

function parseUrls(raw) {
  return raw
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/** Live feedback on which pasted links the scraper already understands. */
function renderUrlPreview() {
  const container = $('#url-preview');
  const urls = parseUrls($('#product-urls').value);

  container.innerHTML = urls
    .map(function (url) {
      const host = hostOf(url);
      const retailer = knownRetailer(host);

      if (!host) {
        return (
          '<span class="inline-flex items-center gap-1.5 rounded-lg bg-red-500/12 px-2.5 py-1 text-[11.5px] font-medium text-red-300">' +
          '<i class="fa-solid fa-xmark text-[10px]"></i>невалиден линк</span>'
        );
      }

      // A home or category page carries a price per tile. Scraping one
      // returns an arbitrary product's price with total confidence, so
      // it is caught here rather than after it lands in a report.
      if (isListingUrl(url)) {
        return (
          '<span class="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/12 px-2.5 py-1 text-[11.5px] font-medium text-amber-300" title="Отворете конкретния продукт и копирайте неговия адрес">' +
          '<i class="fa-solid fa-triangle-exclamation text-[10px]"></i>' +
          escapeHtml(host) +
          ' — начална страница</span>'
        );
      }

      return (
        '<span class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-medium ' +
        (retailer
          ? 'bg-emerald-500/12 text-emerald-300'
          : 'bg-white/5 text-slate-400') +
        '"><i class="fa-solid ' +
        (retailer ? 'fa-circle-check' : 'fa-circle-question') +
        ' text-[10px]"></i>' +
        escapeHtml(retailer || host) +
        '</span>'
      );
    })
    .join('');
}

$('#product-urls').addEventListener('input', renderUrlPreview);

/* --- Find the product in the shops --------------------------------- *
 * Only shops with a server-rendered search page can be queried, so the
 * list comes from the API rather than being hard-coded — a shop that
 * moved its search behind JavaScript should disappear from the picker,
 * not sit there returning nothing.
 * ------------------------------------------------------------------- */

let discoveryShops = null;

async function loadDiscoveryShops() {
  if (discoveryShops) return discoveryShops;

  try {
    const response = await fetch(ENDPOINTS.discoveryShops, { headers: authHeaders() });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    discoveryShops = await response.json();
  } catch (error) {
    discoveryShops = [];
  }

  return discoveryShops;
}

/**
 * The shops this dialog can reach, from both sources.
 *
 * Live search only ever covers the handful of shops that permit it —
 * two, at the time of writing — and showing only those made the feature
 * look broken. The indexed catalogues are the ones that scale, so they
 * are listed first and counted in.
 */
async function renderDiscoveryShops() {
  const container = $('#discovery-shops');
  const live = await loadDiscoveryShops();

  // The catalogue list is loaded by the catalogue screen; fetch it here
  // too so the dialog works whichever screen you came from.
  if (!shops.length) await loadShops().catch(() => undefined);

  const indexed = shops.filter((shop) => shop.offerCount > 0);

  if ((!Array.isArray(live) || live.length === 0) && indexed.length === 0) {
    // Without a key the endpoints are unreachable; hide the box rather
    // than show an empty one that looks broken.
    $('#discovery-block').classList.add('hidden');
    return;
  }

  $('#discovery-block').classList.remove('hidden');

  const indexedChips = indexed
    .map(function (shop) {
      return (
        '<span class="inline-flex items-center gap-2 rounded-lg border border-accent-500/30 bg-accent-500/10 px-3 py-1.5 text-[12.5px] text-accent-300" title="Индексиран каталог — търси се локално">' +
        '<i class="fa-solid fa-database text-[10px]"></i>' +
        escapeHtml(shop.name) +
        '<span class="num text-[11px] text-accent-300/70">' +
        shop.offerCount +
        '</span></span>'
      );
    })
    .join('');

  container.innerHTML = indexedChips;
  // Live-searchable shops, appended after the indexed ones. A shop whose
  // robots.txt forbids its search page is offered disabled, with the
  // reason on it: letting it be ticked and then refusing after the
  // request reads as a bug in us rather than a rule of theirs.
  const liveChips = (Array.isArray(live) ? live : [])
    .map(function (shop) {
      const blocked = shop.searchable === false;

      return (
        '<label class="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] transition ' +
        (blocked
          ? 'cursor-not-allowed border-white/8 bg-ink-850/60 text-slate-600'
          : 'cursor-pointer border-white/10 bg-ink-850 text-slate-300 hover:border-accent-500/40') +
        '" title="' +
        escapeHtml(
          blocked
            ? (shop.reason || 'търсенето не е позволено') +
                ' — може да следите артикул оттам, като поставите линка му'
            : 'Търси се на живо при заявка',
        ) +
        '">' +
        '<input type="checkbox" ' +
        (blocked ? 'disabled' : 'checked') +
        ' value="' +
        escapeHtml(shop.host) +
        '" class="h-3.5 w-3.5 rounded border-white/20 bg-ink-800 accent-accent-500 disabled:opacity-40" />' +
        escapeHtml(shop.name) +
        (blocked
          ? '<i class="fa-solid fa-ban text-[10px] text-amber-500/70"></i>'
          : '<span class="font-mono text-[11px] text-slate-500">' +
            escapeHtml(shop.host) +
            '</span>') +
        '</label>'
      );
    })
    .join('');

  container.insertAdjacentHTML('beforeend', liveChips);

  const notes = [];

  const blocked = (Array.isArray(live) ? live : []).filter(
    (shop) => shop.searchable === false,
  );
  if (blocked.length) {
    notes.push(
      '<i class="fa-solid fa-ban mr-1.5 text-[10px] text-amber-500/70"></i>' +
        escapeHtml(blocked.map((shop) => shop.name).join(', ')) +
        ' не позволява търсене в своя robots.txt. Артикул оттам се следи нормално — ' +
        'намерете го в сайта им и поставете линка му по-долу.',
    );
  }

  // The honest explanation for a short list, and the one action that
  // lengthens it. A shop joins the search by being taught how to search
  // it — one paste of a search URL — not by being crawled.
  notes.push(
    '<i class="fa-solid fa-circle-info mr-1.5 text-[10px]"></i>' +
      'Търсим при магазините на живо, така че списъкът са тези, чиято търсачка сме научили. ' +
      'Добавете още в <button type="button" data-goto-catalogue class="font-semibold text-accent-400 underline">Търсене</button> — ' +
      'отнема едно поставяне на адрес.',
  );

  container.insertAdjacentHTML(
    'beforeend',
    notes
      .map(
        (note) =>
          '<p class="w-full text-[11.5px] leading-relaxed text-slate-500">' + note + '</p>',
      )
      .join(''),
  );

  container.querySelectorAll('[data-goto-catalogue]').forEach(function (button) {
    button.addEventListener('click', function () {
      closeModal('product-modal');
      switchView('catalogue');
    });
  });
}

/** Adds or removes one URL line, keeping whatever was typed by hand. */
function toggleUrlLine(url, include) {
  const field = $('#product-urls');
  const lines = field.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== url);

  if (include) lines.push(url);

  field.value = lines.join('\n');
  renderUrlPreview();
}

function renderDiscoveryResults(results) {
  const container = $('#discovery-results');

  if (!results.length) {
    container.innerHTML =
      '<p class="text-[12px] text-slate-500">Нищо не се намери. Пробвайте с модел вместо с описание.</p>';
    return;
  }

  // The question being asked is "кой го предлага", so that is the first
  // thing on screen: a shop per chip with its cheapest hit. The offers
  // themselves follow, for picking the right variant.
  const carrying = results.filter((shop) => shop.ok && shop.products.length > 0);
  const empty = results.filter((shop) => shop.ok && shop.products.length === 0);
  const refused = results.filter((shop) => !shop.ok);

  const cheapestOf = function (shop) {
    const prices = shop.products
      .map((item) => item.price)
      .filter((price) => typeof price === 'number');
    return prices.length ? Math.min.apply(null, prices) : null;
  };

  const summary =
    '<div class="rounded-lg border border-white/8 bg-ink-850 px-3 py-2.5">' +
    '<p class="text-[12.5px] font-medium ' +
    (carrying.length ? 'text-slate-200' : 'text-slate-400') +
    '">' +
    (carrying.length
      ? 'Предлага се в ' + carrying.length + ' от ' + results.length + ' търсени магазина'
      : 'Не се намери в нито един от търсените магазини') +
    '</p>' +
    (carrying.length
      ? '<div class="mt-2 flex flex-wrap gap-1.5">' +
        carrying
          .map(function (shop) {
            const cheapest = cheapestOf(shop);
            return (
              '<span class="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/12 px-2 py-1 text-[11.5px] font-medium text-emerald-400">' +
              '<i class="fa-solid fa-store text-[9px]"></i>' +
              escapeHtml(shop.name) +
              '<span class="text-emerald-400/70">' +
              shop.products.length +
              (shop.products.length === 1 ? ' оферта' : ' оферти') +
              '</span>' +
              (cheapest !== null
                ? '<span class="num text-slate-300">от ' + cheapest.toFixed(2) + '</span>'
                : '') +
              '</span>'
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
      ? '<p class="mt-1 text-[11px] text-amber-400">Не можа да се провери: ' +
        escapeHtml(
          refused.map((shop) => shop.name + ' (' + (shop.error || 'неуспешно') + ')').join(', '),
        ) +
        '</p>'
      : '') +
    '</div>';

  container.innerHTML =
    summary +
    carrying
    .map(function (shop) {
      const header =
        '<div class="flex items-baseline justify-between gap-2">' +
        '<span class="text-[12.5px] font-medium text-slate-300">' +
        escapeHtml(shop.name) +
        '</span><span class="text-[11px] text-slate-500">' +
        shop.products.length +
        ' намерени · ' +
        shop.durationMs +
        ' ms</span></div>';

      const items = shop.products
        .slice(0, 6)
        .map(function (item) {
          return (
            '<label class="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/5">' +
            '<input type="checkbox" data-discovered="' +
            escapeHtml(item.url) +
            '" class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-white/20 bg-ink-800 accent-accent-500" />' +
            '<span class="min-w-0 flex-1"><span class="block truncate text-[12px] text-slate-200" title="' +
            escapeHtml(item.title) +
            '">' +
            escapeHtml(item.title) +
            '</span><span class="block truncate font-mono text-[10.5px] text-slate-500">' +
            escapeHtml(item.url) +
            '</span></span>' +
            (typeof item.price === 'number'
              ? '<span class="num shrink-0 text-[12px] font-semibold text-slate-300">' +
                item.price.toFixed(2) +
                ' ' +
                escapeHtml(item.currency || '') +
                '</span>'
              : '') +
            '</label>'
          );
        })
        .join('');

      return (
        '<div class="rounded-lg border border-white/8 bg-ink-850 px-3 py-2">' +
        header +
        (items ? '<div class="mt-1.5 space-y-0.5">' + items + '</div>' : '') +
        '</div>'
      );
    })
    .join('');

  container.querySelectorAll('[data-discovered]').forEach(function (box) {
    box.addEventListener('change', function () {
      toggleUrlLine(box.dataset.discovered, box.checked);
    });
  });
}

$('#discovery-search').addEventListener('click', async function () {
  const query = $('#discovery-query').value.trim() || $('#product-name').value.trim();

  if (query.length < 2) {
    $('#discovery-results').innerHTML =
      '<p class="text-[12px] text-amber-400">Въведете поне 2 знака за търсене.</p>';
    return;
  }

  const hosts = Array.prototype.slice
    .call($('#discovery-shops').querySelectorAll('input:checked'))
    .map((box) => box.value);

  $('#discovery-spinner').classList.remove('hidden');
  $('#discovery-results').innerHTML =
    '<p class="text-[12px] text-slate-500">Търсене…</p>';

  // One source now: the shops themselves, asked at this moment. There
  // used to be a second — our own indexed copy of their catalogues — and
  // merging the two meant the dialog showed prices of two different ages
  // side by side without saying which was which.
  const live = await fetch(
    ENDPOINTS.discoverySearch +
      '?q=' +
      encodeURIComponent(query) +
      (hosts.length ? '&hosts=' + encodeURIComponent(hosts.join(',')) : ''),
    { headers: authHeaders() },
  )
    .then((response) => (response.ok ? response.json() : []))
    .catch(() => []);

  renderDiscoveryResults(Array.isArray(live) ? live : []);
  $('#discovery-spinner').classList.add('hidden');
});

$('#discovery-query').addEventListener('keydown', function (event) {
  // Enter inside the dialog would otherwise submit the whole form.
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('#discovery-search').click();
});

$('#add-product').addEventListener('click', function () {
  if (requireAccount()) return;
  $('#product-form').reset();
  $('#product-status').classList.add('hidden');
  $('#url-preview').innerHTML = '';
  $('#discovery-results').innerHTML = '';
  $('#discovery-query').value = '';
  openModal('product-modal');
  void renderDiscoveryShops();
});

function showProductStatus(message, tone) {
  const element = $('#product-status');
  const palette = { success: 'text-emerald-400', error: 'text-red-400', info: 'text-slate-400' };
  element.className = 'text-[12.5px] ' + (palette[tone] || palette.info);
  element.innerHTML = message;
  element.classList.remove('hidden');
}

$('#product-form').addEventListener('submit', async function (event) {
  event.preventDefault();

  const name = $('#product-name').value.trim();
  const urls = parseUrls($('#product-urls').value);

  if (!name) {
    showProductStatus('Въведете име на продукта.', 'error');
    return;
  }
  if (urls.length === 0 || urls.some((url) => !hostOf(url))) {
    showProductStatus('Поставете поне един валиден линк (http/https).', 'error');
    return;
  }

  const listings = urls.filter(isListingUrl);
  if (listings.length > 0) {
    showProductStatus(
      'Тези линкове сочат към начална страница, не към продукт: ' +
        escapeHtml(listings.map(hostOf).join(', ')) +
        '.<br>Отворете конкретния артикул в магазина и копирайте неговия адрес.',
      'error',
    );
    return;
  }

  $('#product-spinner').classList.remove('hidden');
  $('#product-icon').classList.add('hidden');
  showProductStatus('Създаване…', 'info');

  try {
    // The first link becomes the primary listing, because the API creates
    // a product and its primary competitor in one transaction.
    const created = await fetch(ENDPOINTS.products, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: name,
        sku: $('#product-sku').value.trim() || undefined,
        brand: $('#product-brand').value.trim() || undefined,
        manufacturer: $('#product-manufacturer').value.trim() || undefined,
        model: $('#product-model').value.trim() || undefined,
        category: $('#product-category').value.trim() || undefined,
        gtin: $('#product-gtin').value.trim() || undefined,
        targetUrl: urls[0],
        competitorUrl: urls[0],
        competitorName: knownRetailer(hostOf(urls[0])) || hostOf(urls[0]),
        currency: 'EUR',
        ourPrice: Number($('#product-our-price').value) || undefined,
        targetPrice: Number($('#product-target').value) || undefined,
      }),
    });

    if (!created.ok) {
      const detail = await created.text();
      throw new Error('HTTP ' + created.status + ' ' + detail.slice(0, 160));
    }

    const product = await created.json();

    // The remaining links are attached as extra warehouses. One failure
    // must not lose the others, so each is reported on its own.
    const extras = await Promise.all(
      urls.slice(1).map(async function (url) {
        try {
          const response = await fetch(ENDPOINTS.products + '/' + product.id + '/competitors', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              name: knownRetailer(hostOf(url)) || hostOf(url),
              url: url,
              currency: 'EUR',
            }),
          });
          return response.ok ? null : hostOf(url) + ' (HTTP ' + response.status + ')';
        } catch (error) {
          return hostOf(url) + ' (' + error.message + ')';
        }
      }),
    );

    const failed = extras.filter(Boolean);

    showProductStatus('Създаден. Стартиране на първата проверка…', 'info');

    // Scrape immediately, so the comparison is populated before the user
    // has to wonder whether anything happened.
    const triggered = await fetch(ENDPOINTS.scraperTrigger + '/' + product.id, {
      method: 'POST',
      headers: authHeaders(),
    });

    let summary = '';
    if (triggered.ok) {
      const results = await triggered.json();
      const ok = results.filter((result) => result.error === null);
      summary =
        ok.length +
        '/' +
        results.length +
        ' магазина прочетени успешно.' +
        (ok.length
          ? ' Най-ниска цена: ' +
            euro.format(Math.min.apply(null, ok.map((r) => r.currentPrice || Infinity))) +
            '.'
          : '');
    }

    showProductStatus(
      'Готово. ' +
        summary +
        (failed.length ? '<br>Не бяха добавени: ' + escapeHtml(failed.join(', ')) : ''),
      failed.length ? 'info' : 'success',
    );

    toast('Продуктът е добавен и проверен.', 'success');
    window.setTimeout(function () {
      closeModal('product-modal');
      loadProducts();
    }, 1600);
  } catch (error) {
    showProductStatus('Неуспешно: ' + escapeHtml(error.message), 'error');
  } finally {
    $('#product-spinner').classList.add('hidden');
    $('#product-icon').classList.remove('hidden');
  }
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
    status.className = 'text-[12.5px] ' + (palette[tone] || palette.info);
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

  $('#copy-icon').className = 'fa-solid fa-check text-[12px]';
  $('#copy-label').textContent = 'Копирано';

  window.setTimeout(function () {
    $('#copy-icon').className = 'fa-solid fa-link text-[12px]';
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
    'mt-2 text-[12.5px] ' + (tone === 'error' ? 'text-red-400' : 'text-slate-400');
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
        '<p class="text-[12.5px] text-slate-500">' + translate('Няма други активни входове.') + '</p>';
      return;
    }

    list.innerHTML = sessions
      .map(function (session) {
        return (
          '<div class="flex items-center gap-3 rounded-lg border border-white/8 bg-ink-900 px-3 py-2">' +
          '<i class="fa-solid ' +
          (isPhone(session.userAgent) ? 'fa-mobile-screen' : 'fa-laptop') +
          ' text-[12px] text-slate-500"></i>' +
          '<div class="min-w-0 flex-1">' +
          '<p class="truncate text-[12.5px] text-slate-300">' +
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
      '<p class="text-[12.5px] text-slate-500">' + escapeHtml(failureText(error, 'Не се зареди')) + '</p>';
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
function boot() {
  refreshDemoBanner();
  renderApiKeyBadge();
  // Decides which navigation the header shows, so it runs before the first
  // view is opened rather than after the reader has seen the wrong one.
  renderAccount();
  rebuildSupplierFilter();
  renderTable();
  void detectOperator();
  switchView(window.location.hash.replace('#', '') || 'landing', { force: true });
}

if (window.PG_I18N && window.PG_I18N.ready) {
  void window.PG_I18N.ready.then(boot, boot);
} else {
  boot();
}
