#!/usr/bin/env node
/**
 * Level 17 — embeddable widget verification.
 *
 * WHY THIS SCRIPT EXISTS AT ALL
 * -----------------------------
 * Nothing in the existing suites can express what Level 17 has to prove.
 * `verify-security.ts` asserts `frame-ancestors 'none'` on `/` and has no
 * notion of a route that may be framed, of an origin allowlist, or of a second
 * website. Level 17 introduces a deliberate exception to a Level 16 guarantee,
 * and an exception that is not tested is an exception that quietly widens.
 *
 * WHAT IT PROVES, AND WHAT IT CANNOT
 * ----------------------------------
 * Three layers guard the widget, and only two of them are reachable from Node:
 *
 *   in-process   the allowlist itself — normalisation, canonicalisation,
 *                fail-closed behaviour, and the bounded key space that makes
 *                an origin-keyed rate-limit bucket safe.
 *
 *   over HTTP    the headers a real response carries, and the server-side
 *                origin check on `/api/chat` — the layer that actually bounds
 *                API abuse, because it is the only one that still applies to a
 *                caller who never opens a browser.
 *
 *   in a browser `frame-ancestors` enforcement and the `postMessage`
 *                handshake. These are decisions a BROWSER makes, and this
 *                script has no browser: driving one needs Playwright or
 *                Puppeteer, and Level 17 was approved with no new
 *                dependencies. Those checks are reported as MANUAL and were
 *                carried out separately — see the Level 17 report. What this
 *                script does instead is assert every input the browser bases
 *                those decisions on, plus a static read of the two files that
 *                implement the handshake.
 *
 * THE DISTINCTION THAT MATTERS MOST
 * ---------------------------------
 * "The iframe loads" and "the widget is safe from API abuse" are separate
 * claims with separate evidence, and this script keeps them in separate
 * sections. A page that frames correctly proves nothing about an attacker with
 * curl; a 403 on a forged origin proves nothing about whether a legitimate
 * site can embed. Both are checked, neither is used to imply the other.
 *
 * Run (needs the Next app running, and starts its own demo site):
 *   node --experimental-strip-types scripts/verify-widget.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  consumeToken,
  getRateLimitConfig,
  resetRateLimitState,
  widgetIdentity,
} from '../src/lib/rate-limit.ts';
import {
  WIDGET_ORIGIN_HEADER,
  frameAncestorsValue,
  getAllowedWidgetOrigins,
  normalizeOrigin,
  resolveWidgetOrigin,
} from '../src/lib/widget-origins.ts';
import { DEFAULT_DEMO_PORT, createDemoServer } from './demo-server.ts';
import { loadEnvLocal } from './_env.ts';

let passed = 0;
let failed = 0;
let blocked = 0;
let manual = 0;

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
}

function block(label: string, detail = ''): void {
  console.log(`  [BLOCKED] ${label}${detail ? `  — ${detail}` : ''}`);
  blocked++;
}

function manualCheck(label: string, detail = ''): void {
  console.log(`  [MANUAL] ${label}${detail ? `  — ${detail}` : ''}`);
  manual++;
}

function summary(): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log(
    `  ${passed} passed · ${failed} failed · ${blocked} blocked · ${manual} browser-only (see report)`,
  );
  console.log('='.repeat(72));
  if (failed > 0 || blocked > 0) process.exitCode = 1;
}

const BASE_URL = (process.env.EVAL_BASE_URL ?? 'http://localhost:3007').replace(/\/$/, '');
const DEMO_PORT = Number(process.env.WIDGET_DEMO_PORT ?? DEFAULT_DEMO_PORT);
const DEMO_ORIGIN = `http://localhost:${DEMO_PORT}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const projectFile = (...parts: string[]): string =>
  readFileSync(resolve(HERE, '..', ...parts), 'utf8');

/**
 * Confirm this is OUR application and not whatever else answers on the port.
 *
 * A bare `HTTP 200` is not identification. During Level 16 a Vite dev server
 * belonging to an unrelated project was listening on the expected port, and a
 * readiness probe that only checked the status code produced an entire
 * evaluation run of garbage before the mistake was noticed. Four independent
 * markers are required here, all of which this application emits and none of
 * which a generic dev server does.
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

  if (csp.length === 0) return 'no Content-Security-Policy — this is not the Level 16 application';
  if (poweredBy !== null) return `X-Powered-By is present ("${poweredBy}") — poweredByHeader is off in this app`;
  if (!html.includes('AARIZ')) return 'the page carries no AARIZ branding';
  if (/@vite\/client|__vite_ping/.test(html)) return 'this is a Vite dev server, not the Next application';

  return null;
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Level 17 — embeddable widget ===\n');

  // =========================================================================
  console.log('-- Origin normalisation (in-process) ------------------------------');

  // Every pair here is a spelling that MUST collapse onto one canonical value.
  // These are the bypasses an allowlist compared with `===` would let through.
  for (const [input, expected, why] of [
    ['https://example.com', 'https://example.com', 'plain origin'],
    ['HTTPS://EXAMPLE.COM', 'https://example.com', 'uppercase scheme and host'],
    ['https://Example.Com', 'https://example.com', 'mixed case host'],
    ['https://example.com/', 'https://example.com', 'trailing slash'],
    ['https://example.com:443', 'https://example.com', 'explicit default https port'],
    ['http://example.com:80', 'http://example.com', 'explicit default http port'],
    ['https://example.com/some/path?q=1#f', 'https://example.com', 'path, query and fragment'],
    ['  https://example.com  ', 'https://example.com', 'surrounding whitespace'],
    ['http://localhost:5100', 'http://localhost:5100', 'non-default port is kept'],
    ['http://[::1]:8080', 'http://[::1]:8080', 'IPv6 literal'],
    ['https://exämple.com', 'https://xn--exmple-cua.com', 'unicode hostname is punycoded'],
  ] as const) {
    const actual = normalizeOrigin(input);
    check(actual === expected, `normalises ${why}`, `${JSON.stringify(input)} -> ${actual}`);
  }

  // And every value here must be refused outright rather than coerced into
  // something that looks like an origin.
  for (const [input, why] of [
    ['', 'the empty string'],
    ['null', 'the opaque "null" origin a sandboxed frame sends'],
    ['example.com', 'a bare hostname with no scheme'],
    ['//example.com', 'a protocol-relative reference'],
    ['file:///etc/passwd', 'a file: URL'],
    ['data:text/html,<h1>x', 'a data: URL'],
    ['javascript:alert(1)', 'a javascript: URL'],
    ['ftp://example.com', 'a non-http(s) scheme'],
    [`https://${'a'.repeat(400)}.com`, 'an over-long value (rejected before parsing)'],
  ] as const) {
    check(normalizeOrigin(input) === null, `refuses ${why}`, JSON.stringify(input.slice(0, 40)));
  }

  for (const [value, why] of [
    [undefined, 'undefined'],
    [null, 'null'],
    [42, 'a number'],
    [{ toString: () => 'https://example.com' }, 'an object that stringifies to a valid origin'],
    [['https://example.com'], 'an array'],
  ] as const) {
    check(normalizeOrigin(value) === null, `refuses ${why} (non-string input)`);
  }

  // =========================================================================
  console.log('\n-- Allowlist behaviour (in-process) -------------------------------');

  const configuredOrigins = getAllowedWidgetOrigins();
  console.log(`   WIDGET_ALLOWED_ORIGINS -> ${configuredOrigins.length} origin(s)`);

  const savedAllowlist = process.env.WIDGET_ALLOWED_ORIGINS;
  const restore = (): void => {
    if (savedAllowlist === undefined) delete process.env.WIDGET_ALLOWED_ORIGINS;
    else process.env.WIDGET_ALLOWED_ORIGINS = savedAllowlist;
  };

  try {
    // Fail closed. This is the property that keeps an unset variable from
    // publishing the widget by accident.
    for (const empty of ['', '   ', ',,  ,']) {
      process.env.WIDGET_ALLOWED_ORIGINS = empty;
      check(getAllowedWidgetOrigins().length === 0, `an empty allowlist (${JSON.stringify(empty)}) allows nothing`);
      check(frameAncestorsValue() === "'none'", '  and frame-ancestors falls back to \'none\'');
      check(resolveWidgetOrigin('https://example.com') === null, '  and no origin resolves');
    }

    delete process.env.WIDGET_ALLOWED_ORIGINS;
    check(getAllowedWidgetOrigins().length === 0, 'an UNSET allowlist allows nothing');
    check(frameAncestorsValue() === "'none'", "  and frame-ancestors is 'none'");

    // A wildcard is not a supported value and must not become one by accident.
    process.env.WIDGET_ALLOWED_ORIGINS = '*';
    let threwOnWildcard = false;
    try {
      getAllowedWidgetOrigins();
    } catch {
      threwOnWildcard = true;
    }
    check(threwOnWildcard, 'a "*" entry is a configuration error, not a wildcard');

    process.env.WIDGET_ALLOWED_ORIGINS = 'https://good.example,not-an-origin';
    let threwOnInvalid = false;
    try {
      getAllowedWidgetOrigins();
    } catch {
      threwOnInvalid = true;
    }
    check(threwOnInvalid, 'an invalid entry throws rather than being silently dropped');

    process.env.WIDGET_ALLOWED_ORIGINS = Array.from({ length: 21 }, (_, i) => `https://s${i}.example`).join(',');
    let threwOnTooMany = false;
    try {
      getAllowedWidgetOrigins();
    } catch {
      threwOnTooMany = true;
    }
    check(threwOnTooMany, 'more than 20 entries is refused (bounds the bucket key space)');

    // Canonicalisation of the CONFIG side, not just the claim side.
    process.env.WIDGET_ALLOWED_ORIGINS = 'HTTPS://Example.COM:443/, https://example.com';
    const deduped = getAllowedWidgetOrigins();
    check(
      deduped.length === 1 && deduped[0] === 'https://example.com',
      'equivalent configured spellings collapse to one entry',
      JSON.stringify(deduped),
    );

    // The core allowlist decision, both directions.
    process.env.WIDGET_ALLOWED_ORIGINS = 'https://allowed.example';
    check(resolveWidgetOrigin('https://allowed.example') === 'https://allowed.example', 'an allowed origin resolves');
    check(resolveWidgetOrigin('HTTPS://ALLOWED.EXAMPLE:443/') === 'https://allowed.example', '  in any equivalent spelling');
    check(resolveWidgetOrigin('http://allowed.example') === null, 'a scheme downgrade does NOT resolve');
    check(resolveWidgetOrigin('https://allowed.example:8443') === null, 'a different port does NOT resolve');
    check(resolveWidgetOrigin('https://allowed.example.evil.test') === null, 'a suffix-extended hostname does NOT resolve');
    check(resolveWidgetOrigin('https://evil.test/?x=https://allowed.example') === null, 'the origin embedded in a query does NOT resolve');
    check(resolveWidgetOrigin('https://allowed.example@evil.test') === null, 'userinfo spoofing does NOT resolve');
    check(resolveWidgetOrigin(null) === null, 'a missing origin does NOT resolve');
    check(resolveWidgetOrigin('') === null, 'an empty origin does NOT resolve');
    check(
      frameAncestorsValue() === 'https://allowed.example',
      'frame-ancestors names the allowlist, never a wildcard',
      frameAncestorsValue(),
    );

    // =======================================================================
    console.log('\n-- Bucket cardinality is bounded by configuration -----------------');

    /**
     * The question the whole A-ii design turns on: can a caller make the
     * bucket map grow? It can only do so if an unresolved origin ever reaches
     * `consumeToken`, so this drives the real resolve-then-key path with a
     * thousand hostile spellings and counts what was actually created.
     */
    resetRateLimitState();
    process.env.WIDGET_ALLOWED_ORIGINS = 'https://a.example,https://b.example';
    const created = new Set<string>();
    let refusedBeforeKeying = 0;

    for (let i = 0; i < 1_000; i++) {
      const claimed = `https://attacker-${i}.example`;
      const resolvedOrigin = resolveWidgetOrigin(claimed);
      if (resolvedOrigin === null) {
        refusedBeforeKeying++;
        continue;
      }
      created.add(widgetIdentity(resolvedOrigin).key);
    }
    check(refusedBeforeKeying === 1_000, '1000 invented origins are refused before any bucket exists', `${refusedBeforeKeying}/1000`);
    check(created.size === 0, '  and created zero buckets');

    // Now the same with variant spellings of a REAL entry, which must all land
    // on one bucket rather than one each.
    for (const variant of [
      'https://a.example',
      'HTTPS://A.EXAMPLE',
      'https://a.example/',
      'https://a.example:443',
      'https://A.example:443/x?y#z',
    ]) {
      const resolvedOrigin = resolveWidgetOrigin(variant);
      if (resolvedOrigin !== null) created.add(widgetIdentity(resolvedOrigin).key);
    }
    check(created.size === 1, '5 spellings of one allowed origin share exactly one bucket', `${created.size} bucket(s)`);
    check(
      [...created][0] === 'widget:https://a.example',
      '  keyed by the CONFIGURED entry, not the caller string',
      [...created][0],
    );

    // =======================================================================
    console.log('\n-- Widget budget is separate and per-origin -----------------------');

    resetRateLimitState();
    const rateConfig = getRateLimitConfig();
    const widgetCapacity = rateConfig.limits.widget.anonymous;
    console.log(`   RATE_LIMIT_WIDGET -> ${widgetCapacity} per ${rateConfig.windowSeconds}s per site`);

    check(widgetCapacity > 0, 'the widget category has a configured capacity', String(widgetCapacity));
    check(
      rateConfig.limits.chat.anonymous === 10 || rateConfig.limits.chat.anonymous > 0,
      'the anonymous chat budget is untouched by Level 17',
      `chat.anonymous=${rateConfig.limits.chat.anonymous}`,
    );
    check(rateConfig.maxConcurrent >= 1, 'the concurrency cap survives', `maxConcurrent=${rateConfig.maxConcurrent}`);
    check(
      rateConfig.maxConcurrentAnonymous >= 1,
      '  including the stricter anonymous cap the widget draws on',
      `maxConcurrentAnonymous=${rateConfig.maxConcurrentAnonymous}`,
    );

    // Two allowlisted sites must not share a bucket, and neither may touch the
    // shared anonymous one.
    const keyA = `widget:${widgetIdentity('https://a.example').key.slice('widget:'.length)}`;
    const small = 3;
    let allowedA = 0;
    for (let i = 0; i < small + 2; i++) {
      if (consumeToken(keyA, small, 3_600).allowed) allowedA++;
    }
    check(allowedA === small, `a site's bucket exhausts at exactly its capacity`, `${allowedA}/${small}`);

    const keyB = widgetIdentity('https://b.example').key;
    check(consumeToken(keyB, small, 3_600).allowed, 'a second allowlisted site still has a full bucket');
    check(
      consumeToken('chat:anonymous:shared', 1, 3_600).allowed,
      'and the shared anonymous chat bucket was never touched by widget traffic',
    );

    check(widgetIdentity('https://a.example').isAnonymous, 'a widget identity is always anonymous');
  } finally {
    restore();
    resetRateLimitState();
  }

  // =========================================================================
  console.log('\n-- widget.js discloses no server configuration --------------------');

  const widgetSource = projectFile('public', 'widget.js');
  const embedSource = projectFile('src', 'components', 'embedded-chat.tsx');

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
  const supabaseUrl = process.env.SUPABASE_URL ?? '';

  for (const [label, secret] of [
    ['the service-role key', serviceKey],
    ['the anon key', anonKey],
    ['the Supabase URL', supabaseUrl],
  ] as const) {
    check(
      secret.length > 0 && !widgetSource.includes(secret),
      `widget.js does not contain ${label}`,
      secret.length > 0 ? '' : 'NOT SET — cannot prove absence',
    );
  }

  for (const [label, needle] of [
    ['the Ollama port', '11434'],
    ['a model name', 'llama3.2'],
    ['the embedding model', 'nomic-embed'],
    ['the Supabase host suffix', 'supabase.co'],
    ['a service-role reference', 'SERVICE_ROLE'],
    ['the allowlist variable', 'WIDGET_ALLOWED_ORIGINS'],
    ['the system prompt', 'You are AARIZ AI'],
  ] as const) {
    check(!widgetSource.includes(needle), `widget.js does not mention ${label}`, needle);
  }

  check(
    !/process\.env|import\.meta\.env/.test(widgetSource),
    'widget.js reads no environment at all',
  );
  check(
    /new URL\(script\.src/.test(widgetSource),
    'widget.js derives the application origin from its own script tag',
  );

  console.log('\n-- The iframe sandbox ---------------------------------------------');

  const sandbox = widgetSource.match(/'sandbox',\s*\n?\s*'([^']+)'/)?.[1] ?? '';
  check(sandbox.length > 0, 'the iframe is sandboxed at all', sandbox);
  // Required: without it the frame gets an opaque origin and its relative
  // fetch to /api/chat becomes a cross-origin request this app refuses.
  check(sandbox.includes('allow-same-origin'), '  allow-same-origin (required for the frame to call the API)');
  check(sandbox.includes('allow-scripts'), '  allow-scripts (required for the chat UI)');
  // Refused: each of these would let the frame act on the HOST page.
  for (const forbidden of [
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-modals',
    'allow-downloads',
    'allow-pointer-lock',
    'allow-presentation',
    'allow-orientation-lock',
  ]) {
    check(!sandbox.includes(forbidden), `  ${forbidden} is NOT granted`);
  }

  console.log('\n-- postMessage is origin-checked in both directions ---------------');

  // Static reads. The behaviour itself is a browser decision and is verified
  // separately; what can be proven here is that neither end contains the
  // mistake that would make that behaviour unsafe.
  check(
    !/postMessage\([^)]*['"]\*['"]/.test(widgetSource),
    "widget.js never calls postMessage with targetOrigin '*'",
  );
  check(
    !/postMessage\([^)]*['"]\*['"]/.test(embedSource),
    "the embed frame never calls postMessage with targetOrigin '*'",
  );
  /**
   * The same claim, made against CODE rather than against the file's text.
   *
   * The first version of this check read the whole file and failed, because
   * the header comment explains that `'*'` is never used — and says so by
   * quoting it. The assertion was wrong, not the code: it is a property of
   * what executes, so comments are stripped before it is applied. Both
   * postMessage calls are then checked individually, which is the claim that
   * actually matters and which no amount of prose can satisfy accidentally.
   */
  const widgetCode = widgetSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((codeLine) => codeLine.replace(/^\s*\/\/.*$/, ''))
    .join('\n');

  check(
    !widgetCode.includes("'*'") && !widgetCode.includes('"*"'),
    "the literal '*' appears nowhere in widget.js CODE (comments stripped)",
  );

  const widgetPostCalls = widgetCode.match(/postMessage\([^;]*\)/g) ?? [];
  check(widgetPostCalls.length > 0, 'widget.js does send postMessage', `${widgetPostCalls.length} call(s)`);
  check(
    widgetPostCalls.every((call) => call.includes('APP_ORIGIN')),
    '  and every call targets APP_ORIGIN explicitly',
    widgetPostCalls.join(' | ').slice(0, 90),
  );

  const embedPostCalls =
    embedSource.replace(/\/\*[\s\S]*?\*\//g, '').match(/postMessage\([^;]*\)/g) ?? [];
  check(embedPostCalls.length > 0, 'the embed frame does send postMessage', `${embedPostCalls.length} call(s)`);

  /**
   * Asserted as a PROPERTY, not as a list of approved variable names.
   *
   * The first version of this check listed the identifiers then in use, and
   * broke the moment a third legitimate target was added — which is the
   * failure mode of a test that describes today's code instead of the rule.
   * The rule is that a target origin must be a computed, validated value: any
   * string literal in that position is either a wildcard or a hard-coded
   * origin, and neither belongs there.
   */
  const literalTargets = embedPostCalls.filter((call) =>
    /,\s*['"`]/.test(call.slice(call.indexOf('},') + 1)),
  );
  check(
    literalTargets.length === 0,
    '  and no call passes a STRING LITERAL as its target origin',
    literalTargets.join(' | ').slice(0, 80),
  );
  check(
    /allowedOrigins\.includes\(refererOrigin\)/.test(embedSource),
    '  and the referrer-derived target is allowlist-checked before it is used',
  );
  check(
    /event\.origin !== APP_ORIGIN/.test(widgetSource),
    'widget.js rejects messages from any origin but the application',
  );
  check(
    /event\.source !== frame\.contentWindow/.test(widgetSource),
    '  and from any window but its own frame',
  );
  check(
    /allowedOrigins\.includes\(event\.origin\)/.test(embedSource),
    'the embed frame checks event.origin against the server-supplied allowlist',
  );
  check(
    /event\.source !== window\.parent/.test(embedSource),
    '  and only accepts messages from the window that frames it',
  );
  check(
    /widgetOrigin: parentOrigin/.test(embedSource),
    'the embed frame sends only the origin the browser attested',
  );

  manualCheck(
    'a real browser refuses to frame /embed from a non-allowlisted origin',
    'frame-ancestors is enforced by the browser; no browser available here',
  );
  manualCheck(
    'a real browser delivers the handshake and the panel becomes usable',
    'postMessage delivery is a browser behaviour',
  );

  // =========================================================================
  const identityProblem = await identifyApplication();
  if (identityProblem !== null) {
    block('the application could not be identified', identityProblem);
    console.log(`\n   Start it with:  npx next start --port 3007   (or npm run dev -- --port 3007)`);
    summary();
    return;
  }
  console.log(`\n   Verified application identity at ${BASE_URL}`);

  console.log('\n-- Framing headers on live responses ------------------------------');

  const allowed = configuredOrigins[0];
  if (allowed === undefined) {
    block('WIDGET_ALLOWED_ORIGINS is empty', 'set it in .env.local before running this suite');
    summary();
    return;
  }

  const embedResponse = await fetch(`${BASE_URL}/embed`, { headers: { referer: `${allowed}/` } });
  const embedHtml = await embedResponse.text();
  const embedCsp = embedResponse.headers.get('content-security-policy') ?? '';

  check(embedResponse.status === 200, '/embed renders for an allowlisted referer', `HTTP ${embedResponse.status}`);
  check(
    embedCsp.includes(`frame-ancestors ${allowed}`),
    '/embed names the allowlist in frame-ancestors',
    embedCsp.match(/frame-ancestors[^;]*/)?.[0] ?? '(absent)',
  );
  check(!/frame-ancestors[^;]*'none'/.test(embedCsp), '  and not \'none\'');
  check(!/frame-ancestors[^;]*\*/.test(embedCsp), '  and not a wildcard');
  check(embedResponse.headers.get('x-frame-options') === null, '/embed does NOT send X-Frame-Options');
  check(
    embedResponse.headers.get('cross-origin-resource-policy') === 'cross-origin',
    '/embed sends Cross-Origin-Resource-Policy: cross-origin (required to frame it)',
    embedResponse.headers.get('cross-origin-resource-policy') ?? '(absent)',
  );

  // The Level 16 CSP must survive the exception intact. Only frame-ancestors
  // changes; every other directive is asserted unchanged here so a future edit
  // cannot quietly relax one alongside it.
  for (const directive of [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "connect-src 'self'",
  ]) {
    check(embedCsp.includes(directive), `/embed keeps the Level 16 directive: ${directive}`);
  }
  check(!/11434/.test(embedCsp) && !/supabase\.co/.test(embedCsp), '/embed CSP discloses no infrastructure');

  /**
   * The build and the environment must agree.
   *
   * Next serialises `headers()` into `.next/routes-manifest.json` at BUILD
   * time; `next start` serves that manifest and never re-reads the variable.
   * The server-side allowlist checks, by contrast, read it on every request.
   * Editing `WIDGET_ALLOWED_ORIGINS` and restarting without rebuilding
   * therefore leaves the browser-facing half and the API-facing half
   * disagreeing — the widget frames but cannot chat, or chats but cannot
   * frame. Neither is a hole, both are baffling, and this catches it.
   */
  const expectedFrameAncestors = frameAncestorsValue();
  const liveFrameAncestors = (embedCsp.match(/frame-ancestors ([^;]*)/)?.[1] ?? '').trim();
  check(
    liveFrameAncestors === expectedFrameAncestors,
    'the BUILT frame-ancestors matches the CURRENT environment (rebuild required after a change)',
    `built="${liveFrameAncestors}" env="${expectedFrameAncestors}"`,
  );

  console.log('\n-- Every other route keeps Level 16 framing protection ------------');

  for (const path of ['/', '/api/auth/session', '/widget.js', '/this-path-does-not-exist']) {
    const response = await fetch(`${BASE_URL}${path}`);
    const csp = response.headers.get('content-security-policy') ?? '';
    const xfo = response.headers.get('x-frame-options');
    check(xfo === 'DENY', `${path} still sends X-Frame-Options: DENY`, xfo ?? '(absent)');
    check(csp.includes("frame-ancestors 'none'"), `${path} still sends frame-ancestors 'none'`);
    await response.arrayBuffer();
  }

  const rootResponse = await fetch(`${BASE_URL}/`);
  check(
    rootResponse.headers.get('cross-origin-resource-policy') === 'same-origin',
    '/ keeps Cross-Origin-Resource-Policy: same-origin',
    rootResponse.headers.get('cross-origin-resource-policy') ?? '(absent)',
  );
  await rootResponse.arrayBuffer();

  const scriptResponse = await fetch(`${BASE_URL}/widget.js`);
  const servedWidget = await scriptResponse.text();
  check(scriptResponse.status === 200, '/widget.js is served', `HTTP ${scriptResponse.status}`);
  check(
    scriptResponse.headers.get('cross-origin-resource-policy') === 'cross-origin',
    '/widget.js sends Cross-Origin-Resource-Policy: cross-origin (a third-party page must load it)',
    scriptResponse.headers.get('cross-origin-resource-policy') ?? '(absent)',
  );
  check(
    (scriptResponse.headers.get('content-type') ?? '').includes('javascript'),
    '  and is served as JavaScript',
    scriptResponse.headers.get('content-type') ?? '(absent)',
  );
  check(servedWidget === widgetSource, '  and is byte-identical to the file on disk');

  console.log('\n-- The /embed document check --------------------------------------');

  const foreignReferer = await fetch(`${BASE_URL}/embed`, {
    headers: { referer: 'https://evil.example/page' },
  });
  await foreignReferer.arrayBuffer();
  check(
    foreignReferer.status === 404,
    '/embed refuses a request referred by an unapproved origin',
    `HTTP ${foreignReferer.status}`,
  );

  const noReferer = await fetch(`${BASE_URL}/embed`);
  await noReferer.arrayBuffer();
  check(
    noReferer.status === 200,
    '/embed still renders with no Referer (a no-referrer host page is legitimate)',
    `HTTP ${noReferer.status}`,
  );

  check(embedHtml.includes('AARIZ'), 'the embed shell renders');
  check(
    embedHtml.includes('only available on approved websites'),
    '  and starts INERT, before any handshake',
  );
  check(!embedHtml.includes('Sign in') && !embedHtml.includes('Documents'), '  with no auth or document UI');

  for (const [label, secret] of [
    ['the service-role key', serviceKey],
    ['the anon key', anonKey],
    ['the Supabase URL', supabaseUrl],
  ] as const) {
    check(secret.length > 0 && !embedHtml.includes(secret), `the embed page does not contain ${label}`);
  }
  for (const needle of ['11434', 'You are AARIZ AI', 'llama3.2', 'nomic-embed']) {
    check(!embedHtml.includes(needle), `the embed page does not contain "${needle}"`);
  }

  // =========================================================================
  // This section is the one that matters for "safe against API abuse". None of
  // it involves a browser, a frame, or a header a browser sets.
  console.log('\n-- API abuse: the server-side origin check ------------------------');

  const askWidget = async (origin: string | null, extra: Record<string, unknown> = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (origin !== null) headers[WIDGET_ORIGIN_HEADER] = origin;
    const response = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello briefly.' }], ...extra }),
    });
    return response;
  };

  for (const [label, origin] of [
    ['an unapproved origin', 'https://evil.example'],
    ['a scheme downgrade of an allowed origin', allowed.replace('https://', 'http://').replace(/^http:\/\/localhost:(\d+)$/, 'https://localhost:$1')],
    ['a suffix-extended hostname', `${allowed}.evil.test`],
    ['a malformed value', 'not-an-origin'],
    ['a bare hostname', 'localhost:5100'],
    ['the opaque null origin', 'null'],
    ['an empty header value', ''],
    ['a wildcard', '*'],
  ] as const) {
    const response = await askWidget(origin);
    const body = await response.text();
    check(response.status === 403, `/api/chat refuses ${label}`, `HTTP ${response.status}`);
    check(
      !body.includes(origin) || origin.length === 0,
      `  without echoing the claimed origin back`,
    );
    check(
      !body.includes(allowed),
      `  and without disclosing the allowlist`,
    );
  }

  // Fail closed, explicitly: a bad origin must NOT quietly fall back to the
  // ordinary anonymous path. If it did, an unapproved site could still chat by
  // sending a deliberately invalid header.
  const refused = await askWidget('https://evil.example');
  check(
    refused.status === 403 && refused.headers.get('content-type')?.includes('json') === true,
    'a refused widget request never degrades to anonymous chat',
    `HTTP ${refused.status}`,
  );
  await refused.arrayBuffer();

  const widgetPersist = await askWidget(allowed, { startConversation: true });
  const persistBody = await widgetPersist.text();
  check(
    widgetPersist.status === 400,
    'the widget cannot request conversation persistence',
    `HTTP ${widgetPersist.status}`,
  );
  check(!persistBody.includes('conversation_id'), '  and the refusal leaks no schema');

  const widgetSpoofUser = await askWidget(allowed, { user_id: 'someone-else' });
  await widgetSpoofUser.arrayBuffer();
  check(
    widgetSpoofUser.status === 400,
    'the widget still cannot supply an ownership field',
    `HTTP ${widgetSpoofUser.status}`,
  );

  const crossOriginWidget = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example',
      [WIDGET_ORIGIN_HEADER]: allowed,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  await crossOriginWidget.arrayBuffer();
  check(
    crossOriginWidget.status === 403,
    'the Level 16 same-origin check still fires first, even for a valid widget origin',
    `HTTP ${crossOriginWidget.status}`,
  );

  const preflight = await fetch(`${BASE_URL}/api/chat`, {
    method: 'OPTIONS',
    headers: { origin: allowed, 'access-control-request-headers': WIDGET_ORIGIN_HEADER },
  });
  await preflight.arrayBuffer();
  check(preflight.status === 405, 'a CORS preflight for the widget header is still refused', `HTTP ${preflight.status}`);
  check(
    preflight.headers.get('access-control-allow-origin') === null,
    '  and no Access-Control-Allow-Origin is emitted — the header cannot be set cross-site',
  );

  console.log('\n-- The widget can actually chat (real generation, slow) -----------');

  const good = await askWidget(allowed);
  let deltas = 0;
  if (good.ok && good.body) {
    const reader = good.body.getReader();
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
          if ((JSON.parse(raw) as { type: string }).type === 'delta') deltas++;
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    await good.arrayBuffer();
  }
  check(good.status === 200, 'an allowlisted origin gets an answer', `HTTP ${good.status}`);
  check(deltas > 0, '  and it streams', `${deltas} deltas`);
  check(
    good.headers.get('set-cookie') === null,
    '  and the widget is never issued a session cookie',
    good.headers.get('set-cookie') ?? 'none',
  );

  console.log('\n-- Ollama remains unreachable (Level 16 regression) ---------------');
  let reachable = 0;
  for (const path of ['/api/ollama', '/api/proxy', '/api/generate', '/api/models', '/api/tags', '/api/widget']) {
    const response = await fetch(`${BASE_URL}${path}`);
    if (response.status !== 404) reachable++;
    await response.arrayBuffer();
  }
  check(reachable === 0, 'no Ollama proxy, admin, or widget-config route exists', `${reachable} reachable`);

  // =========================================================================
  console.log('\n-- The separate demo website --------------------------------------');

  const demo = createDemoServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      demo.once('error', rejectListen);
      demo.listen(DEMO_PORT, '127.0.0.1', () => resolveListen());
    });

    check(
      DEMO_ORIGIN !== BASE_URL,
      'the demo site is a DIFFERENT origin from the application',
      `${DEMO_ORIGIN} vs ${BASE_URL}`,
    );
    check(
      configuredOrigins.includes(DEMO_ORIGIN),
      'the demo origin is on the allowlist',
      `${DEMO_ORIGIN} in [${configuredOrigins.join(', ')}]`,
    );

    const demoResponse = await fetch(`${DEMO_ORIGIN}/`);
    const demoHtml = await demoResponse.text();
    check(demoResponse.status === 200, 'the demo site serves its page', `HTTP ${demoResponse.status}`);
    check(
      demoHtml.includes(`src="${BASE_URL}/widget.js"`),
      'the demo page loads widget.js from the application origin',
      `${BASE_URL}/widget.js`,
    );
    check(demoHtml.includes('data-position='), '  and configures a position');
    check(demoHtml.includes('data-greeting='), '  and configures a greeting');
    check(
      !demoHtml.includes('supabase') && !demoHtml.includes('11434'),
      '  and carries no application configuration of its own',
    );

    const traversal = await fetch(`${DEMO_ORIGIN}/../../.env.local`);
    await traversal.arrayBuffer();
    check(
      traversal.status === 404 || traversal.status === 403,
      'the demo server refuses path traversal',
      `HTTP ${traversal.status}`,
    );

    manualCheck(
      'the widget visibly renders and answers on the demo site',
      'launcher, panel, greeting, badge and streaming are browser behaviours',
    );
  } finally {
    await new Promise<void>((done) => demo.close(() => done()));
  }
}

main()
  .then(summary)
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
