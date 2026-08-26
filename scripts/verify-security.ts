#!/usr/bin/env node
/**
 * Level 16 — public security verification.
 *
 * Drives the real running application over HTTP. Headers are asserted on live
 * responses rather than by reading `next.config.ts`, because a header that is
 * configured but not actually emitted protects nobody.
 *
 * The CSP assertions matter most. A policy that looks strict in a config file
 * and silently breaks hydration is worse than an honest permissive one, so this
 * loads the real page AND streams a real chat with CSP active.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-security.ts
 */

import { log, newRequestId } from '../src/lib/log.ts';
import { enforceSameOrigin, rejectPreflight } from '../src/lib/security-headers.ts';
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

const BASE_URL = (process.env.EVAL_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Level 16 — public security ===\n');

  // =========================================================================
  console.log('-- Same-origin enforcement (in-process) --------------------------');

  const noOrigin = new Request('http://localhost:3000/api/chat', { method: 'POST' });
  check(enforceSameOrigin(noOrigin) === null, 'a request with no Origin is allowed (curl, scripts, same-origin GET)');

  const sameOrigin = new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
  });
  check(enforceSameOrigin(sameOrigin) === null, 'a matching Origin is allowed');

  const foreign = new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  });
  const refused = enforceSameOrigin(foreign);
  check(refused?.status === 403, 'a foreign Origin is refused with 403', `HTTP ${refused?.status}`);

  if (refused) {
    const body = (await refused.json()) as { error?: string };
    check(
      !(body.error ?? '').includes('localhost') && !(body.error ?? '').includes('evil.example'),
      'the refusal names neither the expected nor the offending origin',
      JSON.stringify(body.error),
    );
  }

  const nullOrigin = new Request('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { origin: 'null' },
  });
  check(enforceSameOrigin(nullOrigin) === null, 'an opaque "null" Origin is treated as no Origin');

  const preflight = rejectPreflight();
  check(preflight.status === 405, 'preflight is refused with 405', `HTTP ${preflight.status}`);
  check(
    preflight.headers.get('access-control-allow-origin') === null,
    'and emits no Access-Control-Allow-Origin',
  );

  // =========================================================================
  console.log('\n-- Structured logging (in-process) --------------------------------');

  const captured: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.error = (line: string) => captured.push(line);
  console.warn = (line: string) => captured.push(line);
  console.log = (line: string) => captured.push(line);

  const id = newRequestId();
  log.error('test.event', {
    requestId: id,
    accessToken: 'super-secret-token-value',
    password: 'hunter2',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abc',
    systemPrompt: 'You are AARIZ AI',
    safe: 'ordinary value',
    error: new Error('a failure message'),
  });

  console.error = originalError;
  console.warn = originalWarn;
  console.log = originalLog;

  check(captured.length === 1, 'the logger emits exactly one line', `${captured.length}`);

  let parsed: Record<string, unknown> = {};
  let parseOk = true;
  try {
    parsed = JSON.parse(captured[0] ?? '{}') as Record<string, unknown>;
  } catch {
    parseOk = false;
  }
  check(parseOk, 'the line is valid JSON');
  check(typeof parsed.ts === 'string', 'it carries a timestamp', String(parsed.ts));
  check(parsed.level === 'error', 'it carries a level', String(parsed.level));
  check(parsed.event === 'test.event', 'it carries an event name', String(parsed.event));
  check(parsed.requestId === id, 'it carries the request id', String(parsed.requestId));
  check(parsed.safe === 'ordinary value', 'ordinary fields survive');

  const raw = captured[0] ?? '';
  for (const [label, secret] of [
    ['access token', 'super-secret-token-value'],
    ['password', 'hunter2'],
    ['service-role key', 'sb_secret_abc'],
    ['system prompt', 'You are AARIZ AI'],
  ] as const) {
    check(!raw.includes(secret), `the ${label} is redacted, not logged`);
  }
  check(raw.includes('a failure message'), 'an Error message is kept (it is the useful part)');
  check(!raw.includes('at '), 'but no stack frames are emitted');

  // =========================================================================
  let serverUp = true;
  try {
    const ping = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(5_000) });
    if (!ping.ok) throw new Error(String(ping.status));
  } catch {
    serverUp = false;
  }

  if (!serverUp) {
    block('the application is not running', `${BASE_URL} — start it with "npm run start" or "npm run dev"`);
    summary();
    return;
  }

  console.log('\n-- Security headers on a live response ----------------------------');
  const page = await fetch(`${BASE_URL}/`);
  const header = (name: string): string => page.headers.get(name) ?? '';

  const expected: [string, (v: string) => boolean, string][] = [
    ['content-security-policy', (v) => v.length > 0, 'present'],
    ['x-frame-options', (v) => v.toUpperCase() === 'DENY', 'DENY'],
    ['x-content-type-options', (v) => v.toLowerCase() === 'nosniff', 'nosniff'],
    ['referrer-policy', (v) => v.includes('strict-origin'), 'strict-origin-when-cross-origin'],
    ['permissions-policy', (v) => v.includes('camera=()'), 'camera/mic/geo disabled'],
    ['strict-transport-security', (v) => v.includes('max-age='), 'max-age set'],
    ['cross-origin-opener-policy', (v) => v === 'same-origin', 'same-origin'],
    ['cross-origin-resource-policy', (v) => v === 'same-origin', 'same-origin'],
  ];
  for (const [name, predicate, description] of expected) {
    check(predicate(header(name)), `${name}: ${description}`, header(name).slice(0, 60));
  }

  check(page.headers.get('x-powered-by') === null, 'X-Powered-By is NOT sent', page.headers.get('x-powered-by') ?? 'absent');

  console.log('\n-- CSP directives -------------------------------------------------');
  const csp = header('content-security-policy');
  for (const [directive, label] of [
    ["frame-ancestors 'none'", 'nothing may frame the application (Level 17 will relax this)'],
    ["object-src 'none'", 'no plugins'],
    ["base-uri 'self'", 'base tag cannot be hijacked'],
    ["form-action 'self'", 'forms cannot post off-origin'],
    ["default-src 'self'", 'default is same-origin'],
  ] as const) {
    check(csp.includes(directive), `CSP: ${label}`, directive);
  }
  check(
    !csp.includes('11434') && !/supabase\.co/.test(csp),
    'the CSP discloses no infrastructure addresses',
  );

  console.log('\n-- API responses also carry the headers ---------------------------');
  const apiResponse = await fetch(`${BASE_URL}/api/auth/session`);
  check((apiResponse.headers.get('content-security-policy') ?? '').length > 0, 'API responses carry CSP');
  check(apiResponse.headers.get('x-content-type-options') === 'nosniff', 'API responses carry nosniff');
  check(apiResponse.headers.get('x-powered-by') === null, 'API responses do not advertise the framework');
  await apiResponse.arrayBuffer();

  console.log('\n-- CORS over real HTTP --------------------------------------------');
  const crossOriginResponse = await fetch(`${BASE_URL}/api/conversations`, {
    headers: { origin: 'https://evil.example' },
  });
  check(crossOriginResponse.status === 403, 'a foreign Origin is refused over HTTP', `HTTP ${crossOriginResponse.status}`);
  check(
    crossOriginResponse.headers.get('access-control-allow-origin') === null,
    'no Access-Control-Allow-Origin is ever emitted',
  );
  await crossOriginResponse.arrayBuffer();

  const optionsResponse = await fetch(`${BASE_URL}/api/chat`, { method: 'OPTIONS' });
  check(optionsResponse.status === 405, 'OPTIONS preflight is refused over HTTP', `HTTP ${optionsResponse.status}`);
  await optionsResponse.arrayBuffer();

  console.log('\n-- The app still works with CSP enforced --------------------------');
  const html = await page.text();
  check(html.includes('<!DOCTYPE html>') || html.includes('<!doctype html>'), 'the page renders');
  check(html.includes('AARIZ'), 'and contains the application shell', 'branding present');

  const chatResponse = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello briefly.' }] }),
  });

  let deltas = 0;
  if (chatResponse.ok && chatResponse.body) {
    const reader = chatResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          if ((JSON.parse(line) as { type: string }).type === 'delta') deltas++;
        } catch {
          /* ignore */
        }
      }
    }
  }
  check(chatResponse.status === 200, 'chat still answers with CSP active', `HTTP ${chatResponse.status}`);
  check(deltas > 0, 'and still streams — CSP did not break the response', `${deltas} deltas`);

  console.log('\n-- Error pages leak nothing ---------------------------------------');
  const missing = await fetch(`${BASE_URL}/this-path-does-not-exist-${Date.now()}`);
  const missingHtml = await missing.text();
  check(missing.status === 404, 'an unknown path returns 404', `HTTP ${missing.status}`);
  check(
    !/at\s+\w+\s+\(/.test(missingHtml) && !missingHtml.includes('.ts:'),
    'the 404 page contains no stack trace',
  );

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
  for (const [label, secret] of [
    ['service-role key', serviceKey],
    ['anon key', anonKey],
    ['Ollama port', '11434'],
  ] as const) {
    check(
      secret.length > 0 && !missingHtml.includes(secret),
      `the 404 page does not contain the ${label}`,
    );
  }
  check(!missingHtml.includes('You are AARIZ AI'), 'and does not contain the system prompt');

  console.log('\n-- Ollama remains unreachable through the app ---------------------');
  let reachable = 0;
  for (const path of ['/api/ollama', '/api/proxy', '/api/generate', '/api/models', '/api/tags']) {
    const response = await fetch(`${BASE_URL}${path}`);
    if (response.status !== 404) reachable++;
    await response.arrayBuffer();
  }
  check(reachable === 0, 'no Ollama proxy or admin route exists', `${reachable} reachable`);
}

main()
  .then(summary)
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
