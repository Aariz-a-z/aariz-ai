#!/usr/bin/env node
/**
 * Level 14 — abuse protection verification.
 *
 * TWO LAYERS, AND WHY BOTH ARE NEEDED
 * -----------------------------------
 * The limiter's state lives in the process that owns it, so this script cannot
 * inspect the dev server's counters directly. It therefore proves the work in
 * two complementary ways:
 *
 *   in-process   the limiter module is imported here and driven directly, with
 *                deliberately tiny limits. This proves the MECHANISM: refill,
 *                recovery, per-key isolation, concurrency accounting, and that
 *                disabling it through configuration restores prior behaviour.
 *
 *   over HTTP    real requests against the running server, which proves the
 *                WIRING: that routes actually consult the limiter, that a
 *                throttled chat never opens a stream, that oversized bodies are
 *                refused before parsing, and that validation errors stay 400.
 *
 * Neither alone is sufficient. In-process tests could pass against routes that
 * never call the limiter; HTTP tests alone cannot exercise recovery windows or
 * concurrency deterministically.
 *
 * BUCKET ISOLATION
 * ----------------
 * HTTP scenarios send a unique `aariz_session` cookie so each gets its own
 * bucket. That is not a workaround: it is the documented weakness of keying
 * anonymous callers on a cookie when no trusted proxy supplies an address, and
 * exercising it here keeps the limitation honest rather than theoretical.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-limits.ts
 */

import { randomUUID } from 'node:crypto';

import {
  acquireSlot,
  checkBodySize,
  concurrencySnapshot,
  consumeToken,
  enforceRateLimit,
  getRateLimitConfig,
  resetRateLimitState,
  resolveIdentity,
  tooManyRequests,
} from '../src/lib/rate-limit.ts';
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

const BASE_URL = (process.env.EVAL_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** A request carrying its own anonymous session, so it gets its own bucket. */
function withSession(session: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('cookie', `aariz_session=${session}`);
  return { ...init, headers };
}

/** Consume a chat NDJSON stream, reporting whether any delta arrived. */
async function drainChat(response: Response): Promise<{ deltas: number; text: string }> {
  if (response.body === null) return { deltas: 0, text: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let deltas = 0;
  let text = '';
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
        const event = JSON.parse(line) as { type: string; text?: string };
        if (event.type === 'delta') {
          deltas++;
          text += event.text ?? '';
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { deltas, text };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  loadEnvLocal();

  console.log('\n=== Level 14 — abuse protection ===\n');

  const config = getRateLimitConfig();
  console.log('-- Effective configuration ---------------------------------------');
  console.log(`   enabled=${config.enabled} trustProxy=${config.trustProxy} window=${config.windowSeconds}s`);
  console.log(`   chat  anon=${config.limits.chat.anonymous} auth=${config.limits.chat.authenticated}`);
  console.log(`   upload anon=${config.limits.upload.anonymous} auth=${config.limits.upload.authenticated}`);
  console.log(`   auth=${config.limits.auth.anonymous}  read anon=${config.limits.read.anonymous} auth=${config.limits.read.authenticated}`);
  console.log(`   concurrency global=${config.maxConcurrent} anonymous=${config.maxConcurrentAnonymous}`);
  console.log(`   maxRequestBytes=${config.maxRequestBytes}  tokens anon=${config.generationTokens.anonymous} auth=${config.generationTokens.authenticated}`);

  check(config.enabled, 'rate limiting is enabled by default (no test bypass exists)');
  check(!config.trustProxy, 'RATE_LIMIT_TRUST_PROXY defaults to false');

  // =========================================================================
  console.log('\n-- Mechanism: token bucket (in-process) ---------------------------');
  resetRateLimitState();

  const CAP = 5;
  const WINDOW = 5;
  let allowed = 0;
  let firstDenial: ReturnType<typeof consumeToken> | null = null;
  for (let i = 0; i < CAP + 1; i++) {
    const decision = consumeToken('test:bucket', CAP, WINDOW);
    if (decision.allowed) allowed++;
    else if (firstDenial === null) firstDenial = decision;
  }
  check(allowed === CAP, `the first ${CAP} requests succeed`, `${allowed}`);
  check(firstDenial !== null, `request ${CAP + 1} is denied`);
  check(
    (firstDenial?.retryAfterSeconds ?? 0) >= 1,
    'the denial carries a positive retry-after',
    `${firstDenial?.retryAfterSeconds}s`,
  );

  // Per-key isolation: exhausting one caller must not touch another.
  const other = consumeToken('test:different-caller', CAP, WINDOW);
  check(other.allowed, 'a different key has its own budget (A cannot spend B\'s)');

  // Recovery: one token returns after window/capacity seconds.
  const perTokenMs = (WINDOW / CAP) * 1000;
  await sleep(perTokenMs + 250);
  const recovered = consumeToken('test:bucket', CAP, WINDOW);
  check(recovered.allowed, 'the bucket recovers after the refill interval', `waited ${Math.round(perTokenMs + 250)}ms`);

  // A zero capacity denies everything — the anonymous upload budget.
  const zero = consumeToken('test:zero', 0, WINDOW);
  check(!zero.allowed, 'a zero capacity denies every request (anonymous uploads)');

  // =========================================================================
  console.log('\n-- Mechanism: anonymous limits are stricter -----------------------');
  for (const category of ['chat', 'upload', 'read'] as const) {
    const anon = config.limits[category].anonymous;
    const auth = config.limits[category].authenticated;
    check(anon <= auth, `${category}: anonymous budget <= authenticated`, `${anon} <= ${auth}`);
  }
  check(
    config.maxConcurrentAnonymous <= config.maxConcurrent,
    'anonymous concurrency <= global concurrency',
    `${config.maxConcurrentAnonymous} <= ${config.maxConcurrent}`,
  );
  check(
    config.generationTokens.anonymous <= config.generationTokens.authenticated,
    'anonymous generation ceiling <= authenticated',
    `${config.generationTokens.anonymous} <= ${config.generationTokens.authenticated}`,
  );

  // =========================================================================
  console.log('\n-- Mechanism: identity is never taken from the client -------------');
  const spoofed = new Request('http://x/', {
    headers: {
      'x-forwarded-for': '9.9.9.9',
      'x-user-id': 'victim-user-id',
      cookie: 'aariz_session=abc',
    },
  });

  const asUser = resolveIdentity(spoofed, 'real-user-id', config);
  check(asUser.key === 'user:real-user-id', 'a verified user id keys the bucket', asUser.key);
  check(!asUser.isAnonymous, 'and is not treated as anonymous');

  const asAnon = resolveIdentity(spoofed, null, config);
  check(
    !asAnon.key.includes('9.9.9.9'),
    'X-Forwarded-For is NOT trusted while RATE_LIMIT_TRUST_PROXY=false',
    asAnon.key,
  );
  check(!asAnon.key.includes('victim-user-id'), 'a user id header grants no identity', asAnon.key);

  const trusting = { ...config, trustProxy: true };
  const trusted = resolveIdentity(spoofed, null, trusting);
  check(trusted.key === 'ip:9.9.9.9', 'with a trusted proxy the forwarded address is used', trusted.key);

  const noIdentity = resolveIdentity(new Request('http://x/'), null, config);
  check(
    noIdentity.key === 'anonymous:shared',
    'a caller with no verifiable identity shares one strict bucket',
    noIdentity.key,
  );

  // =========================================================================
  console.log('\n-- Mechanism: concurrency ----------------------------------------');
  resetRateLimitState();

  const slots = [];
  for (let i = 0; i < config.maxConcurrent; i++) {
    slots.push(acquireSlot(false, config));
  }
  check(slots.every((s) => s !== null), `${config.maxConcurrent} slots can be held`, `${slots.length}`);
  check(
    concurrencySnapshot().inFlight === config.maxConcurrent,
    'occupancy is accounted for',
    `${concurrencySnapshot().inFlight}`,
  );

  const overflow = acquireSlot(false, config);
  check(overflow === null, 'the next request is refused rather than queued');

  slots[0]?.release();
  const afterRelease = acquireSlot(false, config);
  check(afterRelease !== null, 'a released slot becomes available again');
  afterRelease?.release();
  for (const slot of slots.slice(1)) slot?.release();

  // Double release must not corrupt the count — the chat route can reach
  // release() from both the stream finally and cancel().
  const doubled = acquireSlot(false, config);
  doubled?.release();
  doubled?.release();
  check(concurrencySnapshot().inFlight === 0, 'releasing twice does not corrupt the count', `${concurrencySnapshot().inFlight}`);

  // =========================================================================
  console.log('\n-- Mechanism: 429 and 413 shape ----------------------------------');
  const throttleResponse = tooManyRequests('chat', 42);
  check(throttleResponse.status === 429, 'throttling yields 429', String(throttleResponse.status));
  check(throttleResponse.headers.get('retry-after') === '42', 'Retry-After header is set', throttleResponse.headers.get('retry-after') ?? '');
  check(throttleResponse.headers.get('cache-control') === 'no-store', 'the 429 is not cacheable');

  const throttleBody = (await throttleResponse.json()) as { error: string; retryAfterSeconds: number };
  check(throttleBody.retryAfterSeconds === 42, 'the body repeats the retry hint');
  check(throttleBody.error.length > 20, 'the message is a friendly sentence', JSON.stringify(throttleBody.error.slice(0, 60)));
  check(
    !/bucket|token|limit=|user:|sid:|ip:/i.test(throttleBody.error),
    'and leaks no internal detail (no bucket, key or counter)',
  );

  const big = new Request('http://x/', { method: 'POST', headers: { 'content-length': '99999999' } });
  const oversize = checkBodySize(big, config.maxRequestBytes);
  check(oversize?.status === 413, 'an oversized declared body yields 413', String(oversize?.status));

  const small = new Request('http://x/', { method: 'POST', headers: { 'content-length': '100' } });
  check(checkBodySize(small, config.maxRequestBytes) === null, 'a normal body passes');
  check(
    checkBodySize(new Request('http://x/', { method: 'POST' }), config.maxRequestBytes) === null,
    'a missing Content-Length is not rejected outright (one layer of several)',
  );

  // =========================================================================
  console.log('\n-- Mechanism: disabling through configuration ---------------------');
  const saved = process.env.RATE_LIMIT_ENABLED;
  try {
    process.env.RATE_LIMIT_ENABLED = 'false';
    const disabled = getRateLimitConfig();
    check(!disabled.enabled, 'RATE_LIMIT_ENABLED=false is read as disabled');

    resetRateLimitState();
    let denied = 0;
    for (let i = 0; i < 50; i++) {
      if (enforceRateLimit(new Request('http://x/'), 'chat', null, disabled) !== null) denied++;
    }
    check(denied === 0, '50 requests pass unthrottled when disabled', `${denied} denied`);

    const freeSlots = [];
    for (let i = 0; i < 20; i++) freeSlots.push(acquireSlot(true, disabled));
    check(freeSlots.every((s) => s !== null), 'concurrency is unbounded when disabled', `${freeSlots.length}`);
    for (const slot of freeSlots) slot?.release();
  } finally {
    if (saved === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = saved;
    resetRateLimitState();
  }

  // =========================================================================
  // HTTP — proves the routes actually consult the limiter.
  // =========================================================================
  let serverUp = true;
  try {
    const ping = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(5_000) });
    if (!ping.ok) throw new Error(String(ping.status));
  } catch {
    serverUp = false;
  }

  if (!serverUp) {
    block('the application is not running', `${BASE_URL} — start it with "npm run dev"`);
  } else {
    console.log('\n-- Wiring: throttling over real HTTP ------------------------------');

    // The auth budget is the smallest configured one, so it is the practical
    // way to demonstrate throttling end to end without thousands of requests.
    const authLimit = config.limits.auth.anonymous;
    const session = randomUUID();
    const attempt = (): Promise<Response> =>
      fetch(
        `${BASE_URL}/api/auth/signin`,
        withSession(session, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: `nobody-${session}@example.test`, password: 'not-a-real-password' }),
        }),
      );

    let successes = 0;
    let throttledAt = 0;
    let throttledResponse: Response | null = null;

    for (let i = 1; i <= authLimit + 3; i++) {
      const response = await attempt();
      if (response.status === 429) {
        throttledAt = i;
        throttledResponse = response;
        break;
      }
      successes++;
      await response.arrayBuffer();
    }

    check(
      successes === authLimit && throttledAt === authLimit + 1,
      `N requests succeed and N+1 is throttled (N=${authLimit})`,
      `${successes} passed, 429 at request ${throttledAt}`,
    );

    if (throttledResponse !== null) {
      const retryAfter = throttledResponse.headers.get('retry-after');
      check(retryAfter !== null && Number(retryAfter) >= 1, 'the HTTP 429 carries a valid Retry-After', retryAfter ?? 'absent');

      const body = (await throttledResponse.json()) as { error?: string; retryAfterSeconds?: number };
      check(typeof body.error === 'string' && body.error.length > 20, 'the HTTP 429 body is a friendly sentence');
      check(
        !/password|email|bucket|token|sid:|user:/i.test(body.error ?? ''),
        'and leaks nothing about credentials or internals',
        JSON.stringify((body.error ?? '').slice(0, 60)),
      );
    }

    // A separate caller must be unaffected by the exhausted bucket above.
    const otherSession = randomUUID();
    const otherResponse = await fetch(
      `${BASE_URL}/api/auth/signin`,
      withSession(otherSession, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone-else@example.test', password: 'not-a-real-password' }),
      }),
    );
    check(
      otherResponse.status !== 429,
      'a different caller is NOT throttled by the exhausted bucket',
      `HTTP ${otherResponse.status}`,
    );
    await otherResponse.arrayBuffer();

    // ---------------------------------------------------------------------
    console.log('\n-- Wiring: 413 before parsing, 400 still 400 ----------------------');

    const huge = 'x'.repeat(config.maxRequestBytes + 5_000);
    const oversized = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: huge }] }),
    });
    check(oversized.status === 413, 'an oversized chat body returns 413', `HTTP ${oversized.status}`);
    await oversized.arrayBuffer();

    const malformed = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    check(malformed.status === 400, 'malformed JSON is still 400, not 429', `HTTP ${malformed.status}`);
    await malformed.arrayBuffer();

    const badShape = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'hi' }] }),
    });
    check(badShape.status === 400, 'Level 3 validation errors remain 400', `HTTP ${badShape.status}`);
    await badShape.arrayBuffer();

    // ---------------------------------------------------------------------
    console.log('\n-- Wiring: concurrency returns 429, never a partial stream --------');
    console.log(`   firing ${config.maxConcurrent + 1} simultaneous chat requests (real generation, slow)`);

    const ask = (): Promise<Response> =>
      fetch(
        `${BASE_URL}/api/chat`,
        withSession(randomUUID(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello briefly.' }] }),
        }),
      );

    const responses = await Promise.all(
      Array.from({ length: config.maxConcurrent + 1 }, () => ask()),
    );
    const throttledChats = responses.filter((r) => r.status === 429);
    const okChats = responses.filter((r) => r.status === 200);

    check(
      throttledChats.length >= 1,
      'the request beyond the concurrency limit is refused',
      `${okChats.length} accepted, ${throttledChats.length} throttled`,
    );
    check(
      okChats.length <= config.maxConcurrent,
      'no more than the configured number ran concurrently',
      `${okChats.length} <= ${config.maxConcurrent}`,
    );

    const throttledChat = throttledChats[0];
    if (throttledChat) {
      check(
        (throttledChat.headers.get('content-type') ?? '').includes('application/json'),
        'a throttled chat responds as JSON, not as an NDJSON stream',
        throttledChat.headers.get('content-type') ?? '',
      );
      const drained = await drainChat(throttledChat);
      check(drained.deltas === 0, 'and produces NO partial stream', `${drained.deltas} deltas`);
    }
    for (const response of okChats) await drainChat(response);

    // ---------------------------------------------------------------------
    console.log('\n-- Wiring: Ollama is not reachable through the application --------');
    const ollamaUrl = process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
    const ollamaHost = new URL(ollamaUrl).host;

    let leaked = 0;
    for (const path of [
      '/api/auth/session',
      '/api/conversations',
      '/api/documents',
      '/api/chat',
    ]) {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: path === '/api/chat' ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' },
        ...(path === '/api/chat' ? { body: JSON.stringify({ messages: [] }) } : {}),
      });
      const text = await response.text();
      if (text.includes(ollamaHost) || text.includes('11434')) leaked++;
    }
    check(leaked === 0, 'no application route reveals the Ollama address', `${leaked} leak(s)`);

    for (const path of ['/api/ollama', '/api/proxy', '/api/generate', '/api/models']) {
      const response = await fetch(`${BASE_URL}${path}`);
      if (response.status !== 404) {
        check(false, `no proxy route exists at ${path}`, `HTTP ${response.status}`);
      }
      await response.arrayBuffer();
    }
    check(true, 'no application route proxies to Ollama', 'checked /api/ollama, /api/proxy, /api/generate, /api/models');
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${passed} passed · ${failed} failed · ${blocked} blocked`);
  console.log('='.repeat(72));
  if (failed > 0 || blocked > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
