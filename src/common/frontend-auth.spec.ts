import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/**
 * The rule that a customer request can never carry an operator key.
 *
 * This is a test of `public/auth.js`, which is browser code, and it is here
 * rather than nowhere because the bug it guards against was a production
 * incident with no test that could have caught it. Both credentials shared one
 * localStorage slot; `authHeaders()` attached whatever was in it to every
 * request; and an operator pasting their key turned eight customer endpoints
 * into a wall of "this is an operator key" refusals. The server was right every
 * time — the interface was asking questions it had no standing to ask.
 *
 * The repair was structural: two slots, and two header builders that each read
 * only their own. That is a property worth pinning down, because the failure
 * mode is silent, it looks like a backend fault, and the obvious "just check a
 * flag" fix regresses the moment somebody adds a customer view and forgets.
 *
 * Run in a `vm` sandbox with a stub browser rather than under jsdom: the file
 * touches `localStorage`, `fetch` and two functions from `app.js`, all of which
 * are three lines to fake and none of which is what is being tested. A DOM
 * dependency for this would be cost without cover.
 */

interface AuthModule {
  getApiKey: () => string;
  setApiKey: (value: string) => void;
  getOperatorKey: () => string;
  setOperatorKey: (value: string) => void;
  clearAllCredentials: () => void;
  getSession: () => { token: string } | null;
  setSession: (session: unknown) => void;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  operatorHeaders: (extra?: Record<string, string>) => Record<string, string>;
  hasCustomerCredentials: () => boolean;
  operatorKnown: () => Promise<boolean>;
  usingOperatorKey: boolean;
}

/** A fresh browser, with nothing remembered. */
function load(options: { operatorProbeAnswers?: boolean } = {}): {
  auth: AuthModule;
  store: Map<string, string>;
  fetches: Array<{ url: string; headers: Record<string, string> }>;
} {
  const store = new Map<string, string>();
  const fetches: Array<{ url: string; headers: Record<string, string> }> = [];

  const localStorage = {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => void store.set(name, value),
    removeItem: (name: string) => void store.delete(name),
  };

  const sandbox: Record<string, unknown> = {
    window: { localStorage },
    ENDPOINTS: { billingUsers: '/api/v1/billing/users' },
    // Supplied by app.js in the browser; irrelevant here beyond not throwing.
    renderApiKeyBadge: () => undefined,
    showOperatorEntries: () => undefined,
    fetch: (url: string, init: { headers: Record<string, string> }) => {
      fetches.push({ url, headers: init.headers });
      return Promise.resolve({ ok: options.operatorProbeAnswers ?? false });
    },
  };

  const context = createContext(sandbox);
  runInContext(readFileSync(join(__dirname, '../../public/auth.js'), 'utf8'), context);

  // The file's declarations land in the sandbox's global lexical scope, which
  // is reachable by evaluating their names rather than by reading properties.
  const auth = runInContext(
    `({
      getApiKey, setApiKey, getOperatorKey, setOperatorKey, clearAllCredentials,
      getSession, setSession, authHeaders, operatorHeaders,
      hasCustomerCredentials, operatorKnown,
      get usingOperatorKey() { return usingOperatorKey; },
    })`,
    context,
  ) as AuthModule;

  return { auth, store, fetches };
}

const CUSTOMER = 'sk_live_customer_key';
const OPERATOR = 'op_live_operator_key';

describe('customer context', () => {
  it('sends the customer key to customer endpoints', () => {
    const { auth } = load();
    auth.setApiKey(CUSTOMER);

    expect(auth.authHeaders()['x-api-key']).toBe(CUSTOMER);
  });

  it('prefers a session over a stored key', () => {
    const { auth } = load();
    auth.setApiKey(CUSTOMER);
    auth.setSession({ token: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const headers = auth.authHeaders();
    expect(headers.Authorization).toBe('Bearer tok');
    // Not both: two credentials on one request leaves the server to choose,
    // and which one it chose is not a thing the interface should discover.
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('reports customer credentials only when there are some', () => {
    const { auth } = load();
    expect(auth.hasCustomerCredentials()).toBe(false);

    auth.setApiKey(CUSTOMER);
    expect(auth.hasCustomerCredentials()).toBe(true);
  });
});

describe('operator context', () => {
  it('sends the operator key to operator endpoints', () => {
    const { auth } = load();
    auth.setOperatorKey(OPERATOR);

    expect(auth.operatorHeaders()['x-api-key']).toBe(OPERATOR);
  });

  it('never sends the operator key to a customer endpoint', () => {
    const { auth } = load();
    auth.setOperatorKey(OPERATOR);

    // The whole incident, in one assertion. `authHeaders` does not read the
    // slot an operator key lives in, so there is nothing for it to attach.
    expect(auth.authHeaders()['x-api-key']).toBeUndefined();
    expect(Object.values(auth.authHeaders())).not.toContain(OPERATOR);
  });

  it('withholds the customer key while the credential is known to be an operator’s', () => {
    // The window a browser upgrading from the single shared slot passes
    // through: the operator key is still filed under the customer slot,
    // because `operatorKnown` has not finished moving it yet. Reading the slot
    // alone would attach it to a customer request — the original bug surviving
    // inside its own fix — so the settled answer is consulted too.
    const { auth } = load();
    auth.setApiKey(OPERATOR);
    auth.setOperatorKey(OPERATOR);
    // Put it back in the customer slot, which is exactly the un-migrated state.
    auth.setApiKey(OPERATOR);

    expect(auth.usingOperatorKey).toBe(true);
    expect(auth.authHeaders()['x-api-key']).toBeUndefined();
  });

  it('does not count an operator key as customer credentials', () => {
    const { auth } = load();
    auth.setOperatorKey(OPERATOR);

    // This is what stops the customer views fetching at all. An operator has
    // no account, so there is genuinely nothing for them to show.
    expect(auth.hasCustomerCredentials()).toBe(false);
    expect(auth.usingOperatorKey).toBe(true);
  });

  it('never sends a customer key to an operator endpoint', () => {
    const { auth } = load();
    auth.setApiKey(CUSTOMER);

    expect(auth.operatorHeaders()['x-api-key']).toBeUndefined();
  });

  it('does not answer an operator request from a customer session', () => {
    const { auth } = load();
    auth.setSession({ token: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() });

    // An operator signed in to their own trial account must not have the panel
    // quietly answered from that account.
    expect(auth.operatorHeaders().Authorization).toBeUndefined();
  });
});

describe('switching between the two', () => {
  it('drops the customer key when an operator key is stored', () => {
    const { auth } = load();
    auth.setApiKey(CUSTOMER);
    auth.setOperatorKey(OPERATOR);

    expect(auth.getApiKey()).toBe('');
    expect(auth.getOperatorKey()).toBe(OPERATOR);
  });

  it('drops the operator key when a customer signs in', () => {
    const { auth } = load();
    auth.setOperatorKey(OPERATOR);

    auth.setSession({ token: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() });

    // The requirement in one test: a customer login after an admin session
    // must not inherit operator credentials.
    expect(auth.getOperatorKey()).toBe('');
    expect(auth.usingOperatorKey).toBe(false);
    expect(auth.operatorHeaders()['x-api-key']).toBeUndefined();
    expect(auth.authHeaders().Authorization).toBe('Bearer tok');
  });

  it('clears both slots on "remove key"', () => {
    const { auth } = load();
    auth.setApiKey(CUSTOMER);
    auth.setOperatorKey(OPERATOR);

    auth.clearAllCredentials();

    expect(auth.getApiKey()).toBe('');
    expect(auth.getOperatorKey()).toBe('');
    expect(auth.usingOperatorKey).toBe(false);
    expect(auth.authHeaders()['x-api-key']).toBeUndefined();
    expect(auth.operatorHeaders()['x-api-key']).toBeUndefined();
  });

  it('leaves the operator key alone when a customer session ends', () => {
    const { auth } = load();
    auth.setOperatorKey(OPERATOR);
    // Signing in cleared it, as the test above asserts. Signing out again
    // must not resurrect it, and must not remove a key that is not there.
    auth.setSession({ token: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    auth.setSession(null);

    expect(auth.getSession()).toBeNull();
    expect(auth.getOperatorKey()).toBe('');
  });

  it('treats an expired session as no session', () => {
    const { auth } = load();
    auth.setSession({ token: 'tok', expiresAt: new Date(Date.now() - 1000).toISOString() });

    expect(auth.getSession()).toBeNull();
    expect(auth.hasCustomerCredentials()).toBe(false);
  });
});

describe('a browser from before the two slots existed', () => {
  it('moves an operator key out of the customer slot', async () => {
    // `/billing/users` answers 200 only for an operator, so it identifies the
    // key without granting anything.
    const { auth, fetches } = load({ operatorProbeAnswers: true });
    auth.setApiKey(OPERATOR);

    await auth.operatorKnown();

    expect(auth.getOperatorKey()).toBe(OPERATOR);
    expect(auth.getApiKey()).toBe('');
    expect(auth.usingOperatorKey).toBe(true);
    // And the probe used the key it was testing, not a header builder that
    // would have refused to send it.
    expect(fetches[0].headers['x-api-key']).toBe(OPERATOR);
  });

  it('leaves a customer key where it is', async () => {
    const { auth } = load({ operatorProbeAnswers: false });
    auth.setApiKey(CUSTOMER);

    await auth.operatorKnown();

    expect(auth.getApiKey()).toBe(CUSTOMER);
    expect(auth.getOperatorKey()).toBe('');
    expect(auth.usingOperatorKey).toBe(false);
  });

  it('asks nothing when the browser holds no key at all', async () => {
    const { auth, fetches } = load();

    await expect(auth.operatorKnown()).resolves.toBe(false);
    expect(fetches).toHaveLength(0);
  });
});
