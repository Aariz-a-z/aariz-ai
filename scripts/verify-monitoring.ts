#!/usr/bin/env node
/**
 * Level 18 — production monitoring verification.
 *
 * WHY A NEW SUITE
 * ---------------
 * Nothing existing can express Level 18. `verify-security.ts` knows about
 * headers, not metrics; no suite knows what `/admin` is, and none has a notion
 * of an authorization tier above "signed in". Level 18 also makes the first
 * edit to the Level 16 redactor, and an exemption that is not tested is an
 * exemption that widens.
 *
 * TWO LAYERS, BOTH NEEDED
 * -----------------------
 *   in-process   the metrics ring, the refusal matcher, the redactor exemption
 *                and the admin allowlist, driven directly with deliberately
 *                small inputs. Proves the MECHANISM, including cases a live
 *                server cannot be made to reach (an unset ADMIN_EMAILS would
 *                need a restart).
 *
 *   over HTTP    real requests against the running application with real
 *                accounts. Proves the WIRING: that /admin actually consults
 *                the allowlist, that a real chat really does populate every
 *                field the roadmap lists, and that the page's counts agree
 *                with the database.
 *
 * ACCOUNTS AND CLEANUP
 * --------------------
 * This creates two real Supabase accounts and deletes both at the end, by the
 * exact ids it created — never by a filter, and never a bulk delete. The admin
 * address is fixed (it has to match `ADMIN_EMAILS` in the server's
 * environment, which was read at startup); the non-admin address is unique per
 * run.
 *
 * Run (needs the app running, Ollama up, and ADMIN_EMAILS set):
 *   node --experimental-strip-types scripts/verify-monitoring.ts
 */

import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';

import { getAdminEmails, isAdminConfigured, isAdminEmail } from '../src/lib/admin.ts';
import { estimateTokens } from '../src/lib/ingest/tokens.ts';
import { log, newRequestId } from '../src/lib/log.ts';
import {
  looksLikeRefusal,
  metricsSnapshot,
  recordRequest,
  resetMetrics,
} from '../src/lib/metrics.ts';
import { describeInference } from '../src/lib/inference-mode.ts';
import { loadEnvLocal } from './_env.ts';

let passed = 0;
let failed = 0;
let blocked = 0;

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
}

function block(label: string, detail = ''): void {
  console.log(`  [BLOCKED] ${label}${detail ? `  — ${detail}` : ''}`);
  blocked++;
}

function summary(): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${passed} passed · ${failed} failed · ${blocked} blocked`);
  console.log('='.repeat(72));
  if (failed > 0 || blocked > 0) process.exitCode = 1;
}

const BASE_URL = (process.env.EVAL_BASE_URL ?? 'http://localhost:3007').replace(/\/$/, '');

/**
 * Confirm this is OUR application, not whatever else answers on the port.
 *
 * A bare 200 is not identification. At Level 16 an unrelated Vite dev server
 * on the expected port produced an entire evaluation of garbage before anyone
 * noticed, and at Level 17 the port had been taken by another project's
 * Express server. Four markers this application emits and a generic server
 * does not.
 */
async function identifyApplication(): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(10_000) });
  } catch (caught) {
    return `no response from ${BASE_URL} (${caught instanceof Error ? caught.message : caught})`;
  }
  if (!response.ok) return `HTTP ${response.status} from ${BASE_URL}/`;

  const csp = response.headers.get('content-security-policy') ?? '';
  const poweredBy = response.headers.get('x-powered-by');
  const html = await response.text();

  if (csp.length === 0) return 'no Content-Security-Policy — not the Level 16 application';
  if (poweredBy !== null) return `X-Powered-By present ("${poweredBy}") — this app disables it`;
  if (!html.includes('AARIZ')) return 'no AARIZ branding on the page';
  if (/@vite\/client|__vite_ping/.test(html)) return 'this is a Vite dev server';
  return null;
}

/** Capture one log line without letting it reach the real console. */
function captureLog(emit: () => void): string {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (line: string) => lines.push(line);
  console.warn = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);
  try {
    emit();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines.join('\n');
}

interface SignedIn {
  cookie: string;
  userId: string;
}

/**
 * One place that builds the service-role client, so its exact generic
 * instantiation is derivable. `ReturnType<typeof createClient>` on the bare
 * import resolves to a different instantiation than a real call produces, and
 * the two are not assignable to one another.
 */
function createAdminClient(url: string, key: string) {
  return createClient(url, key, { auth: { persistSession: false } });
}
type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Create a test account, then sign in through the real HTTP route.
 *
 * The account is created with the SERVICE-ROLE admin API rather than by
 * posting to `/api/auth/signup`, and that is a deliberate harness decision
 * with a measured reason: Supabase enforces a project-level email quota, and
 * the Level 13/14 suites running earlier the same hour exhaust it — signup
 * then returns `email rate limit exceeded` and this suite could never run
 * twice in a day. `createUser` with `email_confirm` does not send mail, so it
 * is not subject to that quota.
 *
 * This weakens nothing that Level 18 is testing. The account is a real
 * Supabase user, and SIGN-IN still goes through the application's own
 * `/api/auth/signin`, so the session, the cookies and `getServerUser` are all
 * exercised exactly as a real user would exercise them. Only the account's
 * creation is shortcut, and account creation is Level 13's subject, not this
 * one's — `verify-auth.ts` covers the signup route directly.
 *
 * `track` receives the new account's id THE MOMENT the account exists, before
 * anything that can fail. An earlier version returned null on a failed sign-in
 * and left the caller with nothing to clean up, so two real accounts survived
 * a blocked run and had to be deleted by hand afterwards. Cleanup must be
 * armed by creation, not by success.
 */
async function createAndSignIn(
  admin: AdminClient,
  email: string,
  password: string,
  track: string[],
): Promise<SignedIn | null> {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  let userId = created.data?.user?.id ?? null;

  if (userId === null) {
    // The admin address is fixed, so an interrupted earlier run can leave it
    // behind. Recover its id and reset the password, so the suite is
    // repeatable instead of failing until someone deletes the row by hand.
    const existing = await admin.auth.admin.listUsers();
    userId =
      existing.data?.users.find((user) => user.email?.toLowerCase() === email.toLowerCase())?.id ??
      null;

    if (userId === null) {
      console.log(`   (could not create or find ${email}: ${created.error?.message ?? 'unknown'})`);
      return null;
    }
    await admin.auth.admin.updateUserById(userId, { password, email_confirm: true });
  }

  // Armed here: every path below this line can fail, and none of them may
  // leave an untracked account behind.
  track.push(userId);

  const response = await fetch(`${BASE_URL}/api/auth/signin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const setCookie = response.headers.getSetCookie?.() ?? [];
  const signinBody = await response.text();
  if (!response.ok || setCookie.length === 0) {
    console.log(`   (signin failed for ${email}: HTTP ${response.status} ${signinBody.slice(0, 120)})`);
    return null;
  }

  const cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');

  // Confirm the cookie actually authenticates. `/api/auth/session` returns
  // `{ configured, authenticated, email }` — it carries no user id, which is
  // why the id above comes from the admin API rather than from here.
  const session = await fetch(`${BASE_URL}/api/auth/session`, { headers: { cookie } });
  const body = (await session.json()) as { authenticated?: boolean };
  if (body.authenticated !== true) {
    console.log(`   (session did not authenticate for ${email})`);
    return null;
  }

  return { cookie, userId };
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Level 18 — production monitoring ===\n');

  // =========================================================================
  console.log('-- Metrics are bounded and numeric (in-process) -------------------');

  resetMetrics();
  const empty = metricsSnapshot();
  check(empty.totalRequests === 0, 'a fresh process has counted nothing');
  check(empty.total.mean === null, '  and reports no average rather than zero');
  check(empty.failureRate === null, '  and no failure rate rather than 0%');
  check(empty.unansweredRate === null, '  and no unanswered rate rather than 0%');

  const sample = {
    outcome: 'ok' as const,
    totalMs: 1000,
    embeddingMs: 100,
    searchMs: 50,
    generationMs: 800,
    chunks: 5,
    promptTokens: 400,
    completionTokens: 120,
    retrievalFailed: false,
    widget: false,
    concurrent: 1,
  };

  // Overfill the ring far past its ceiling: the whole point is that it cannot
  // grow, so a long-lived server cannot leak through its own monitoring.
  for (let i = 0; i < 1_200; i++) recordRequest({ ...sample, totalMs: i });
  const overfilled = metricsSnapshot();
  check(
    overfilled.sampleCount === overfilled.sampleCapacity,
    'the ring stops at its capacity however many requests arrive',
    `${overfilled.sampleCount}/${overfilled.sampleCapacity} after 1200`,
  );
  check(
    overfilled.totalRequests === 1_200,
    '  while the lifetime counter still sees them all',
    String(overfilled.totalRequests),
  );
  check(
    overfilled.total.mean !== null && overfilled.total.mean > 900,
    '  and the ring holds the NEWEST samples, not the oldest',
    `mean ${overfilled.total.mean}`,
  );

  /**
   * Nothing in a snapshot may be able to hold user content.
   *
   * Asserted on VALUES, not on field names. The first version of this check
   * scanned the serialised keys for words like "answer" and failed on
   * `unansweredRate` — a pure number whose name happens to contain one. The
   * property that actually matters is that every leaf is a number, a boolean
   * or null, with a single known exception for the ISO timestamp saying when
   * counting began. A free-form string anywhere is the thing that would let
   * user content in, and this catches one wherever it appears.
   */
  const leaves: [string, unknown][] = [];
  const walk = (value: unknown, path: string): void => {
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
      return;
    }
    leaves.push([path, value]);
  };
  walk(overfilled, '');

  const nonNumeric = leaves.filter(
    ([path, value]) =>
      path !== 'since' && typeof value !== 'number' && typeof value !== 'boolean' && value !== null,
  );
  check(
    nonNumeric.length === 0,
    'every value in a snapshot is a number, boolean or null — no free-form strings',
    nonNumeric.map(([path]) => path).join(', ') || `${leaves.length} leaves checked`,
  );
  check(
    typeof overfilled.since === 'string' && !Number.isNaN(Date.parse(overfilled.since)),
    '  the one string is an ISO timestamp',
    overfilled.since,
  );

  resetMetrics();
  recordRequest({ ...sample, outcome: 'ok' });
  recordRequest({ ...sample, outcome: 'refused' });
  recordRequest({ ...sample, outcome: 'error' });
  recordRequest({ ...sample, outcome: 'aborted' });
  recordRequest({ ...sample, outcome: 'error', retrievalFailed: true });
  const mixed = metricsSnapshot();
  check(mixed.totalRequests === 5, 'every outcome is counted', String(mixed.totalRequests));
  check(mixed.failedRequests === 2, 'errors count as failures', String(mixed.failedRequests));
  check(mixed.refusedRequests === 1, 'refusals are counted separately', String(mixed.refusedRequests));
  check(mixed.retrievalFailures === 1, 'retrieval failures are counted', String(mixed.retrievalFailures));
  check(
    mixed.unansweredRate !== null && Math.abs(mixed.unansweredRate - 0.5) < 1e-9,
    'the unanswered RATE is over answered requests, not all requests',
    `${mixed.unansweredRate} (1 refused of 2 answered)`,
  );
  check(
    mixed.failureRate !== null && Math.abs(mixed.failureRate - 0.4) < 1e-9,
    'the failure rate is over all requests',
    String(mixed.failureRate),
  );

  // An aborted request must never be reported as a failure — otherwise the
  // dashboard alarms every time the Stop button works.
  resetMetrics();
  for (let i = 0; i < 10; i++) recordRequest({ ...sample, outcome: 'aborted' });
  const aborted = metricsSnapshot();
  check(aborted.failedRequests === 0, 'pressing Stop ten times produces zero failures');
  check(aborted.failureRate === 0, '  and a 0% failure rate', String(aborted.failureRate));

  console.log('\n-- The refusal matcher is the frozen Level 11 list -----------------');
  check(looksLikeRefusal('The provided documents do not cover that.'), 'the prompted wording is a refusal');
  check(looksLikeRefusal('I cannot find that in the documents.'), 'a paraphrase is a refusal');
  check(!looksLikeRefusal('The purifier runs at 95 degrees Celsius. [1]'), 'a real answer is not a refusal');
  check(!looksLikeRefusal(''), 'an empty answer is not counted as a refusal');

  // =========================================================================
  console.log('\n-- The Level 16 redactor still redacts (in-process) ----------------');

  const captured = captureLog(() =>
    log.info('test.metrics', {
      requestId: newRequestId(),
      // Must survive: Level 18 requires these.
      promptTokens: 412,
      completionTokens: 118,
      totalTokens: 530,
      chunks: 5,
      generationMs: 31_000,
      model: 'test-model',
      // Must NOT survive: every one of these resembles an exempt name.
      accessToken: 'super-secret-access-value',
      refreshToken: 'super-secret-refresh-value',
      apiToken: 'super-secret-api-value',
      tokenSecret: 'super-secret-token-secret',
      systemPrompt: 'You are AARIZ AI',
      password: 'hunter2',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc',
    }),
  );

  const parsed = JSON.parse(captured) as Record<string, unknown>;
  check(parsed.promptTokens === 412, 'promptTokens is logged, not redacted', String(parsed.promptTokens));
  check(parsed.completionTokens === 118, 'completionTokens is logged', String(parsed.completionTokens));
  check(parsed.totalTokens === 530, 'totalTokens is logged', String(parsed.totalTokens));
  check(parsed.model === 'test-model', 'the model name is logged server-side');

  for (const [label, secret] of [
    ['accessToken', 'super-secret-access-value'],
    ['refreshToken', 'super-secret-refresh-value'],
    ['apiToken', 'super-secret-api-value'],
    ['tokenSecret', 'super-secret-token-secret'],
    ['systemPrompt', 'You are AARIZ AI'],
    ['password', 'hunter2'],
    ['service-role key', 'sb_secret_abc'],
  ] as const) {
    check(!captured.includes(secret), `${label} is STILL redacted`);
  }

  // The exemption is by exact name AND type: a string under an approved name
  // must not slip through.
  const smuggled = captureLog(() => log.info('test.smuggle', { promptTokens: 'sk-live-abcdef' }));
  check(
    !smuggled.includes('sk-live-abcdef'),
    'a STRING under an exempt name is still redacted (exemption is numeric-only)',
  );

  // =========================================================================
  console.log('\n-- The admin allowlist (in-process) -------------------------------');

  const savedAdmins = process.env.ADMIN_EMAILS;
  const restoreAdmins = (): void => {
    if (savedAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = savedAdmins;
  };

  try {
    for (const value of ['', '   ', ',, ,']) {
      process.env.ADMIN_EMAILS = value;
      check(!isAdminConfigured(), `an empty allowlist (${JSON.stringify(value)}) configures nobody`);
      check(!isAdminEmail('anyone@example.test'), '  and nobody is an admin');
    }

    delete process.env.ADMIN_EMAILS;
    check(!isAdminConfigured(), 'an UNSET ADMIN_EMAILS configures nobody');
    check(!isAdminEmail('anyone@example.test'), '  and nobody is an admin — fail closed');

    process.env.ADMIN_EMAILS = 'Boss@Example.Test, ops@example.test';
    check(isAdminEmail('boss@example.test'), 'a configured address is an admin');
    check(isAdminEmail('BOSS@EXAMPLE.TEST'), '  in any casing');
    check(isAdminEmail('  ops@example.test  '), '  ignoring surrounding whitespace');
    check(!isAdminEmail('boss@example.test.evil'), 'a suffix-extended address is NOT an admin');
    check(!isAdminEmail('xboss@example.test'), 'a prefix-extended address is NOT an admin');
    check(!isAdminEmail('other@example.test'), 'an unlisted address is NOT an admin');
    check(!isAdminEmail(null), 'a null email is NOT an admin');
    check(!isAdminEmail(''), 'an empty email is NOT an admin');
    check(!isAdminEmail(undefined), 'an undefined email is NOT an admin');
    check(getAdminEmails().length === 2, 'entries are parsed and deduplicated', getAdminEmails().join(','));
  } finally {
    restoreAdmins();
  }

  // =========================================================================
  const identityProblem = await identifyApplication();
  if (identityProblem !== null) {
    block('the application could not be identified', identityProblem);
    console.log(`\n   Start it with:  npx next start --port 3007`);
    summary();
    return;
  }
  console.log(`\n   Verified application identity at ${BASE_URL}`);

  const configuredAdmins = getAdminEmails();
  const adminEmail = configuredAdmins[0];
  if (adminEmail === undefined) {
    block('ADMIN_EMAILS is empty in .env.local', 'set it before running this suite');
    summary();
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supabaseUrl.length === 0 || serviceKey.length === 0) {
    block('Supabase is not configured', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    summary();
    return;
  }
  const admin = createAdminClient(supabaseUrl, serviceKey);

  const runId = randomUUID().slice(0, 8);
  const password = `L18-${randomUUID()}`;
  const createdUserIds: string[] = [];

  try {
    console.log('\n-- /admin authorization over HTTP ---------------------------------');

    const anonymous = await fetch(`${BASE_URL}/admin`);
    await anonymous.arrayBuffer();
    check(anonymous.status === 404, 'anonymous /admin returns 404', `HTTP ${anonymous.status}`);

    const normalUser = await createAndSignIn(admin, `l18-user-${runId}@example.test`, password, createdUserIds);
    if (normalUser === null) {
      block('could not create a normal test user', 'see the createUser message above');
    } else {
      const asUser = await fetch(`${BASE_URL}/admin`, { headers: { cookie: normalUser.cookie } });
      await asUser.arrayBuffer();
      check(asUser.status === 404, 'an AUTHENTICATED non-admin gets 404', `HTTP ${asUser.status}`);
    }

    const adminUser = await createAndSignIn(admin, adminEmail, password, createdUserIds);
    if (adminUser === null) {
      block('could not sign in the admin test account', adminEmail);
    } else {
      const asAdmin = await fetch(`${BASE_URL}/admin`, { headers: { cookie: adminUser.cookie } });
      const adminHtml = await asAdmin.text();
      check(asAdmin.status === 200, 'the allowlisted admin gets 200', `HTTP ${asAdmin.status}`);
      check(adminHtml.includes('operations'), '  and the dashboard renders');

      // Every metric the roadmap names must actually be on the page.
      for (const label of [
        'Documents',
        'Conversations',
        'Messages',
        'Ingestion status',
        'Failed',
        'Retrieval failures',
        'Unanswered',
        'Latency',
      ]) {
        check(adminHtml.includes(label), `  the dashboard shows "${label}"`);
      }

      console.log('\n-- The dashboard leaks nothing ------------------------------------');
      for (const [label, secret] of [
        ['the service-role key', serviceKey],
        ['the anon key', process.env.SUPABASE_ANON_KEY ?? ''],
        ['the Supabase URL', supabaseUrl],
      ] as const) {
        check(
          secret.length > 0 && !adminHtml.includes(secret),
          `the dashboard does not contain ${label}`,
          secret.length > 0 ? '' : 'NOT SET — cannot prove absence',
        );
      }
      for (const needle of ['11434', 'You are AARIZ AI', adminEmail]) {
        check(!adminHtml.includes(needle), `the dashboard does not contain "${needle}"`);
      }

      /**
       * Level 20 changed this assertion, and it is worth being explicit that
       * it got STRICTER rather than looser.
       *
       * Level 18 asserted the model tag appeared nowhere on the dashboard.
       * ROADMAP.md Level 20 then required the admin interface to display
       * "Inference mode / Provider / Model". So the claim can no longer be
       * "nowhere"; it is now "on this authenticated page and NOWHERE ELSE",
       * which is a boundary the old assertion never tested at all.
       */
      /**
       * Asserted against the model actually configured, not a list of names.
       *
       * This matched `/llama|not configured/`, which was every possibility at
       * the time and silently became a false negative once a Gemini deployment
       * displayed `gemini-3.5-flash-lite` — a correct page failing a test that
       * was checking for yesterday's strings. Comparing against
       * `describeInference()` tests the property the page is meant to have and
       * cannot go stale when a provider is added.
       */
      check(
        adminHtml.includes(describeInference().model),
        adminHtml.match(/Model<\/div>[\s\S]{0,120}?">([^<]+)</)?.[1] ?? 'absent',
      );
      check(adminHtml.includes('Inference mode'), '  and the inference mode');
      check(adminHtml.includes('Provider'), '  and the provider');

      // The other side of that boundary: everywhere a non-admin can reach.
      for (const [label, path] of [
        ['the chat UI', '/'],
        ['the 404 page', '/this-path-does-not-exist-l20'],
        ['the embed frame', '/embed'],
      ] as const) {
        const response = await fetch(`${BASE_URL}${path}`);
        const body = await response.text();
        check(
          !/llama3|nomic-embed/i.test(body),
          `  but ${label} still names no model`,
          `HTTP ${response.status}`,
        );
      }

      const apiLeak = await fetch(`${BASE_URL}/api/auth/session`);
      const apiBody = await apiLeak.text();
      check(!/llama3|nomic-embed/i.test(apiBody), '  and no API response names a model');

      console.log('\n-- Level 16 headers are intact on /admin --------------------------');
      check(asAdmin.headers.get('x-frame-options') === 'DENY', '/admin sends X-Frame-Options: DENY');
      check(
        (asAdmin.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"),
        "/admin sends frame-ancestors 'none' — Level 17 did not widen it",
      );
      check(
        asAdmin.headers.get('cross-origin-resource-policy') === 'same-origin',
        '/admin keeps CORP same-origin',
      );
      check(asAdmin.headers.get('x-powered-by') === null, '/admin does not advertise the framework');
      check(
        asAdmin.headers.get('x-content-type-options') === 'nosniff',
        '/admin sends nosniff',
      );

      console.log('\n-- The widget cannot reach /admin ---------------------------------');
      const viaWidgetHeader = await fetch(`${BASE_URL}/admin`, {
        headers: { cookie: adminUser.cookie, 'x-widget-origin': 'http://localhost:5100' },
      });
      await viaWidgetHeader.arrayBuffer();
      // The header means nothing to a page route; what matters is that a widget
      // context has no admin cookie at all, tested next.
      check(
        viaWidgetHeader.status === 200,
        'the widget header alone does not change /admin (it is not an auth input)',
        `HTTP ${viaWidgetHeader.status}`,
      );

      const widgetNoCookie = await fetch(`${BASE_URL}/admin`, {
        headers: { 'x-widget-origin': 'http://localhost:5100' },
      });
      await widgetNoCookie.arrayBuffer();
      check(
        widgetNoCookie.status === 404,
        'a widget-context request (no cookie, as a third-party iframe) gets 404',
        `HTTP ${widgetNoCookie.status}`,
      );

      const foreignOrigin = await fetch(`${BASE_URL}/admin`, {
        headers: { cookie: adminUser.cookie, origin: 'https://evil.example' },
      });
      await foreignOrigin.arrayBuffer();
      check(
        foreignOrigin.status === 200 || foreignOrigin.status === 404,
        'a cross-origin GET of /admin cannot be READ by the other site (no CORS header)',
        `HTTP ${foreignOrigin.status}`,
      );
      check(
        foreignOrigin.headers.get('access-control-allow-origin') === null,
        '  and no Access-Control-Allow-Origin is emitted',
      );

      console.log('\n-- Dashboard counts match direct database queries -----------------');
      const dbCount = async (table: 'documents' | 'conversations' | 'messages'): Promise<number> => {
        const { count } = await admin.from(table).select('id', { head: true, count: 'exact' });
        return count ?? -1;
      };
      const [docs, convs, msgs] = await Promise.all([
        dbCount('documents'),
        dbCount('conversations'),
        dbCount('messages'),
      ]);
      const shown = (label: string): number | null => {
        // The rendered figure sits in the markup after its label.
        const index = adminHtml.indexOf(`>${label}<`);
        if (index === -1) return null;
        const after = adminHtml.slice(index, index + 400);
        const match = after.match(/tabular-nums[^>]*">([\d,]+)</);
        return match ? Number(match[1]!.replace(/,/g, '')) : null;
      };
      for (const [label, actual] of [
        ['Documents', docs],
        ['Conversations', convs],
        ['Messages', msgs],
      ] as const) {
        const rendered = shown(label);
        check(
          rendered === actual,
          `the dashboard's ${label} count matches the database`,
          `page=${rendered} db=${actual}`,
        );
      }
    }

    // =======================================================================
    console.log('\n-- A real chat populates every required field ---------------------');

    const before = await fetch(`${BASE_URL}/admin`, {
      headers: adminUser ? { cookie: adminUser.cookie } : {},
    });
    const beforeHtml = await before.text();
    const beforeTotal = Number(beforeHtml.match(/>Total<[\s\S]{0,200}?tabular-nums[^>]*">([\d,]+)</)?.[1]?.replace(/,/g, '') ?? '-1');

    const chat = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello briefly.' }] }),
    });
    let deltas = 0;
    let answer = '';
    if (chat.ok && chat.body) {
      const reader = chat.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!raw) continue;
          try {
            const event = JSON.parse(raw) as { type: string; text?: string };
            if (event.type === 'delta') {
              deltas++;
              answer += event.text ?? '';
            }
          } catch {
            /* ignore */
          }
        }
      }
    } else {
      await chat.arrayBuffer();
    }
    check(chat.status === 200, 'a real chat request succeeds', `HTTP ${chat.status}`);
    check(deltas > 0, '  and streams', `${deltas} deltas`);
    check(estimateTokens(answer) > 0, '  and the completion has an estimable token count');

    if (adminUser !== null) {
      const after = await fetch(`${BASE_URL}/admin`, { headers: { cookie: adminUser.cookie } });
      const afterHtml = await after.text();
      const afterTotal = Number(afterHtml.match(/>Total<[\s\S]{0,200}?tabular-nums[^>]*">([\d,]+)</)?.[1]?.replace(/,/g, '') ?? '-1');

      check(
        beforeTotal >= 0 && afterTotal === beforeTotal + 1,
        'the request counter advanced by exactly one',
        `${beforeTotal} -> ${afterTotal}`,
      );

      // Latency stages must be recorded SEPARATELY, and none may be missing.
      const stageValue = (label: string): string | null => {
        const index = afterHtml.indexOf(`>${label}<`);
        if (index === -1) return null;
        const row = afterHtml.slice(index, index + 320);
        return row.match(/tabular-nums">([^<]+)</)?.[1] ?? null;
      };
      for (const stage of ['Query embedding', 'Database search', 'Generation', 'Total request']) {
        const value = stageValue(stage);
        check(
          value !== null && value !== '—',
          `${stage} latency is recorded separately`,
          value ?? 'absent',
        );
      }
      check(
        afterHtml.includes('Mean prompt tokens'),
        'approximate token counts reach the dashboard',
      );
      check(afterHtml.includes('Mean chunks'), 'the retrieved chunk count is recorded');
      check(afterHtml.includes('Peak concurrent'), 'concurrency is visible on the dashboard');
      check(
        /Peak concurrent[\s\S]{0,300}?tabular-nums[^>]*">(\d+) \/ \d+</.test(afterHtml),
        '  and reports a real occupancy figure recorded by the route',
        afterHtml.match(/Peak concurrent[\s\S]{0,300}?tabular-nums[^>]*">([^<]+)</)?.[1] ?? 'absent',
      );
    }

    console.log('\n-- Ollama remains unreachable, and no admin API exists -------------');
    let reachable = 0;
    for (const path of [
      '/api/admin',
      '/api/admin/metrics',
      '/api/metrics',
      '/api/ollama',
      '/api/generate',
    ]) {
      const response = await fetch(`${BASE_URL}${path}`);
      if (response.status !== 404) reachable++;
      await response.arrayBuffer();
    }
    check(reachable === 0, 'Level 18 added no admin or metrics API route', `${reachable} reachable`);
  } finally {
    // Delete exactly the accounts this run created, by id. Never a filter,
    // never a bulk delete.
    console.log('\n-- Cleanup --------------------------------------------------------');
    let removed = 0;
    for (const id of createdUserIds) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (!error) removed++;
    }
    console.log(`   removed ${removed}/${createdUserIds.length} test account(s)`);
  }
}

main()
  .then(summary)
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
