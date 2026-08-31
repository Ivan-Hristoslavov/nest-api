import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every request in the interface asks with the right identity.
 *
 * The companion to `frontend-auth.spec.ts`. That one proves the two header
 * builders cannot leak into each other; this one proves the call sites use the
 * right one, which is the half a unit test of the auth module cannot see.
 *
 * It reads `app.js` as text on purpose. The alternative is executing eight
 * thousand lines of browser code to observe which header each fetch attached,
 * which needs a DOM, a server and a fixture per screen — and would still only
 * cover the paths the fixtures happened to reach. The property here is
 * syntactic and worth checking syntactically: an operator endpoint named on
 * the same statement as `authHeaders(` is the bug, whatever it does at runtime.
 */

const APP = readFileSync(join(__dirname, '../../public/app.js'), 'utf8');
const AUTH = readFileSync(join(__dirname, '../../public/auth.js'), 'utf8');

/**
 * Endpoint keys that answer only to an operator key.
 *
 * `billingUsers` and `scraperStatus` are here despite their names: the first
 * lists every account, the second reports the sweep across all of them. Both
 * are `AdminGuard`-only, and both were sent customer headers before the split.
 */
const OPERATOR_ONLY = [
  'adminOverview',
  'adminDecisions',
  'adminDecisionAnalytics',
  'adminShops',
  'adminEvents',
  'adminOutreach',
  'adminOutreachPreview',
  'adminScrape',
  'adminScrapeRun',
  'adminAlerts',
  'billingUsers',
  'scraperStatus',
];

/**
 * The lines of a `fetch(...)` call, joined.
 *
 * A fetch and its headers are routinely five lines apart in this file, so a
 * line-by-line scan would miss almost every case. Statements are cut at `);`
 * closing a fetch, which is coarse but errs towards reading *more* context —
 * the direction that produces false alarms rather than false silence.
 */
function fetchStatements(source: string): string[] {
  const statements: string[] = [];
  const pattern = /fetch\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    // Enough to reach the headers of the longest call in the file.
    statements.push(source.slice(match.index, match.index + 400));
  }

  return statements;
}

describe('every fetch asks with the right identity', () => {
  const statements = fetchStatements(APP);

  it('finds the calls it is meant to be checking', () => {
    // A guard on the guard: if `fetch(` ever stops being how requests are
    // made here, this file would quietly pass while checking nothing.
    expect(statements.length).toBeGreaterThan(30);
  });

  it.each(OPERATOR_ONLY)('sends operator credentials to %s', (endpoint) => {
    const calls = statements.filter((statement) => statement.includes(`ENDPOINTS.${endpoint}`));

    expect(calls.length).toBeGreaterThan(0);

    for (const call of calls) {
      // Either the operator header builder, or an explicit `x-api-key` naming
      // a key the caller already holds. The second is the key-entry dialog
      // identifying a pasted key: it is not in a slot yet, so no builder could
      // supply it, and probing with the candidate is the only way to find out
      // which kind it is. What it must never be is a *stored* credential.
      const usesOperatorBuilder = call.includes('operatorHeaders(');
      const probesWithACandidate = /'x-api-key':\s*(candidate|legacy|key)\b/.test(call);

      expect(usesOperatorBuilder || probesWithACandidate).toBe(true);

      // `authHeaders(` would attach a customer session or key to an endpoint
      // that only an operator key opens — the mirror of the original bug, and
      // a way for a signed-in customer's session to reach the admin surface.
      expect(call).not.toMatch(/[^r]authHeaders\(/);
    }
  });

  it('never sends operator credentials to a customer endpoint', () => {
    const customerEndpoints = [
      'products',
      'shops',
      'discoveryShops',
      'discoveryAvailable',
      'discoveryBasket',
      'discoverySearch',
      'discoveryCompare',
      'billingMe',
      'purchaseDecisions',
      'purchaseDecisionsSummary',
      'orders',
    ];

    for (const endpoint of customerEndpoints) {
      const calls = statements.filter(
        (statement) =>
          statement.includes(`ENDPOINTS.${endpoint}`) &&
          // `purchaseDecisions` is a prefix of `purchaseDecisionsSummary`, and
          // `adminDecisions` contains neither — but `shops` is a substring of
          // `adminShops`, so the admin ones are excluded explicitly.
          !statement.includes('ENDPOINTS.admin'),
      );

      for (const call of calls) {
        expect(call).not.toContain('operatorHeaders(');
      }
    }
  });
});

describe('the credential boundary', () => {
  it('keeps the two storage slots apart', () => {
    expect(AUTH).toContain("const KEY_STORAGE = 'stoclify.apiKey'");
    expect(AUTH).toContain("const OPERATOR_KEY_STORAGE = 'stoclify.operatorKey'");
  });

  it('builds customer headers without ever reading the operator slot', () => {
    const body = AUTH.slice(AUTH.indexOf('function authHeaders('));
    const customerHeaders = body.slice(0, body.indexOf('\n}\n') + 3);

    // The structural claim the whole fix rests on. `authHeaders` cannot attach
    // an operator key because it does not know where one is kept.
    expect(customerHeaders).not.toContain('getOperatorKey');
    expect(customerHeaders).not.toContain('OPERATOR_KEY_STORAGE');
  });

  it('builds operator headers without ever reading the session or customer key', () => {
    const body = AUTH.slice(AUTH.indexOf('function operatorHeaders('));
    const operatorHeaders = body.slice(0, body.indexOf('\n}\n') + 3);

    expect(operatorHeaders).not.toContain('getSession');
    expect(operatorHeaders).not.toContain('getApiKey');
  });

  it('defines the credential rules in one file and not in app.js', () => {
    // app.js may *call* these; it must not define a second copy that drifts.
    expect(APP).not.toMatch(/function (authHeaders|operatorHeaders|getApiKey|getOperatorKey)\(/);
    expect(APP).not.toContain("localStorage.getItem('stoclify.");
  });
});
