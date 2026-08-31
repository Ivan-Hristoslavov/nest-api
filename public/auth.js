/**
 * Who this browser is acting as, and what it is therefore allowed to send.
 *
 * Its own file because it is the security boundary of the interface, and a
 * boundary buried three thousand lines into a general-purpose script is one
 * nobody audits. Everything about credentials lives here and nowhere else:
 * the two storage slots, the two header builders, the session, and the single
 * question every customer view asks before it fetches.
 *
 * A classic script like the rest of the front end, loaded before `app.js`, so
 * the functions below are global by the time anything calls them. It depends
 * on `ENDPOINTS`, `renderApiKeyBadge` and `showOperatorEntries` from `app.js`
 * — all resolved at call time, never at load time.
 */

/*
 * Two credentials, two boxes, and no way to reach for the wrong one.
 *
 * These are different identities, not two spellings of one. A customer key
 * names an account and can read that account's data. An operator key names
 * nobody: it opens the panel that reads *across* accounts, and by design it
 * has no account of its own, so every customer endpoint refuses it.
 *
 * They used to share a single slot. Everything still worked for a customer,
 * and for an operator the whole interface broke at once — every customer view
 * fired its requests with the operator key and got a wall of "this is an
 * operator key" refusals from /products, /shops, /billing/me, /discovery/*
 * and /purchase-decisions/*. The backend was right every time; the interface
 * was asking a question it had no business asking.
 *
 * A flag saying "we are in operator mode" was the obvious repair and the
 * wrong one — it was consulted in exactly one place, so every customer
 * feature added afterwards silently reintroduced the bug. What follows makes
 * that structurally impossible instead: the credentials live in separate
 * slots, and the two header builders each read only their own. A customer
 * request cannot pick up an operator key, because the function that builds
 * its headers never looks in that box.
 *
 * Neither is ever written into the markup or a URL — a key in a query string
 * ends up in server logs, browser history and Referer headers.
 */
const KEY_STORAGE = 'stoclify.apiKey';
const OPERATOR_KEY_STORAGE = 'stoclify.operatorKey';
/** Remembers that a stored customer key has already been shown not to be an
 *  operator's, so the probe runs once per key rather than once per load. */
const MIGRATION_STORAGE = 'stoclify.keyChecked';

/** Whether an operator key is present. Storage answers this, not the server. */
let usingOperatorKey = false;

/**
 * Settles what is in this browser before anything asks a question with it.
 *
 * Only does real work once, and only for a browser that predates the split:
 * an operator key sitting in the customer slot is moved across. After that it
 * is answering from storage, because which box a key is in *is* the answer.
 */
let operatorProbe = null;

function operatorKnown() {
  if (!operatorProbe) operatorProbe = migrateLegacyOperatorKey();
  return operatorProbe;
}

function readStorage(name) {
  try {
    return window.localStorage.getItem(name) || '';
  } catch (error) {
    return '';
  }
}

function writeStorage(name, value) {
  try {
    if (value) window.localStorage.setItem(name, value);
    else window.localStorage.removeItem(name);
  } catch (error) {
    /* private browsing — the session simply stays unauthenticated */
  }
}

/** The customer key. Never an operator's — see {@link setOperatorKey}. */
function getApiKey() {
  return readStorage(KEY_STORAGE);
}

/** The operator key, read only by {@link operatorHeaders}. */
function getOperatorKey() {
  return readStorage(OPERATOR_KEY_STORAGE);
}

function setApiKey(value) {
  writeStorage(KEY_STORAGE, value);
  renderApiKeyBadge();
}

/**
 * Stores an operator key, and takes any customer key away with it.
 *
 * Both directions clear the other slot, because holding both at once is not a
 * state the interface has an answer for: it would have to decide, per request,
 * which identity the person meant, and the honest version of that decision is
 * to make them say so by pasting the key they want.
 */
function setOperatorKey(value) {
  writeStorage(OPERATOR_KEY_STORAGE, value);
  if (value) writeStorage(KEY_STORAGE, '');
  usingOperatorKey = Boolean(value);
  operatorProbe = Promise.resolve(usingOperatorKey);
  showOperatorEntries(usingOperatorKey);
  renderApiKeyBadge();
}

/** Forgets both, for sign-out and for "remove this key". */
function clearAllCredentials() {
  writeStorage(KEY_STORAGE, '');
  writeStorage(OPERATOR_KEY_STORAGE, '');
  writeStorage(MIGRATION_STORAGE, '');
  usingOperatorKey = false;
  operatorProbe = Promise.resolve(false);
  showOperatorEntries(false);
  renderApiKeyBadge();
}

/**
 * Whether this browser can ask a customer question at all.
 *
 * The gate every customer view checks before it fetches. An operator holds no
 * customer credential, so the answer is no, and the view says so instead of
 * firing a request that the server will refuse — which is the difference
 * between an interface that knows what it is and one that finds out from a
 * wall of 400s.
 */
function hasCustomerCredentials() {
  return Boolean(getSession() || getApiKey());
}

/**
 * Moves an operator key left in the customer slot by an older version.
 *
 * The one place the server is still asked, and only for a browser that has a
 * customer-slot key from before the split. `/billing/users` answers 200 for an
 * operator and refuses everyone else, so it identifies the key without
 * granting anything.
 */
async function migrateLegacyOperatorKey() {
  if (getOperatorKey()) {
    usingOperatorKey = true;
    showOperatorEntries(true);
    return true;
  }

  const legacy = getApiKey();
  if (!legacy) {
    usingOperatorKey = false;
    showOperatorEntries(false);
    return false;
  }

  /*
   * Asked once per key, not once per page load.
   *
   * The probe is a request whose answer cannot change while the same key sits
   * in the same slot: a customer key does not become an operator key. Re-asking
   * on every load spent a round trip to be told the same thing, and — because
   * the honest answer for a customer key is 403 — put a red line in the console
   * of every customer, on every page, for a check that was working correctly.
   *
   * Keyed by the credential itself, so pasting a different key asks again.
   */
  const settled = readStorage(MIGRATION_STORAGE);
  if (settled === fingerprint(legacy)) {
    usingOperatorKey = false;
    showOperatorEntries(false);
    return false;
  }

  try {
    const response = await fetch(ENDPOINTS.billingUsers, {
      headers: { Accept: 'application/json', 'x-api-key': legacy },
    });

    if (response.ok) {
      setOperatorKey(legacy);
      return true;
    }
    // A definite "not an operator" from the server. Remember it, so this
    // browser stops asking. An error is deliberately not remembered: being
    // offline is not an answer about the key.
    writeStorage(MIGRATION_STORAGE, fingerprint(legacy));
  } catch (error) {
    /* Offline: leave it where it is and treat it as a customer key. */
  }

  usingOperatorKey = false;
  showOperatorEntries(false);
  return false;
}

/**
 * A short, non-reversible tag for a key.
 *
 * Enough to notice the credential changed, and useless to anybody reading
 * localStorage — storing the key a second time to answer "is this the same
 * key" would double the number of places it can leak from.
 */
function fingerprint(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return String(hash);
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
  // Signing in as a customer ends any operator identity in this browser.
  //
  // Without this an operator who signs in to a customer account keeps an
  // operator key in storage, `usingOperatorKey` stays true, and every customer
  // view they open is refused by the gate in `switchView` — signed in, and
  // shown nothing. The session is an unambiguous statement about who is at the
  // keyboard, so it settles the question.
  if (session) setOperatorKey('');

  try {
    if (session) window.localStorage.setItem(SESSION_STORAGE, JSON.stringify(session));
    else window.localStorage.removeItem(SESSION_STORAGE);
  } catch (error) {
    /* private browsing — the tab stays signed in, the next one will not */
  }
}

/**
 * Headers for a request made **as a customer**.
 *
 * Reads the session and the customer key, and nothing else. It cannot attach
 * an operator key because it never looks in that slot — which is the whole
 * point, and the reason this is a separate function rather than a flag checked
 * at each call site. Sixty call sites means sixty chances to forget the flag;
 * there is nothing here to forget.
 *
 * A session wins where both exist. Somebody who has just signed in means to
 * act as that account, whatever key is left in this browser from before.
 */
function authHeaders(extra) {
  const headers = Object.assign({ Accept: 'application/json' }, extra || {});

  // A session is always a customer's — an operator key cannot produce one —
  // so it is safe before anything else has been settled.
  const session = getSession();
  if (session) {
    headers.Authorization = 'Bearer ' + session.token;
    return headers;
  }

  // The slot the key is in is *usually* the answer, and there is one moment
  // when it is not: a browser upgrading from the single shared slot still has
  // an operator key filed under the customer one until `operatorKnown` has
  // finished moving it. Reading the slot alone during that window would attach
  // it to a customer request — the original bug, surviving inside its own fix.
  //
  // `usingOperatorKey` is the settled answer to "whose credential is this",
  // independent of where it is currently filed, so it is checked as well. The
  // cost of being wrong in this direction is an anonymous request that gets a
  // clean 401; the cost of being wrong in the other is the incident.
  if (usingOperatorKey) return headers;

  const key = getApiKey();
  if (key) headers['x-api-key'] = key;
  return headers;
}

/**
 * Headers for a request made **as the operator**.
 *
 * The mirror image, and just as narrow: the operator key only, never the
 * session and never the customer key. An operator reading the panel while
 * signed in to their own trial account must not have the panel quietly
 * answered from that account — the two questions have different answers, and
 * the one it would silently give is the wrong one.
 */
function operatorHeaders(extra) {
  const headers = Object.assign({ Accept: 'application/json' }, extra || {});

  const key = getOperatorKey();
  if (key) headers['x-api-key'] = key;
  return headers;
}
