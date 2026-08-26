#!/usr/bin/env node
/**
 * Level 23 — deployment verification.
 *
 * ROADMAP.md Level 23 asks for `GET /api/health` with an exact shape, says "Do
 * not expose secrets", and lists six things that must be documented if the
 * production LLM is self-hosted.
 *
 * The health endpoint is checked over real HTTP, in both states that matter:
 * dependencies up, and a dependency down. The second is the one that is easy
 * to skip and the only one that proves the endpoint reports rather than
 * assumes — an endpoint hard-coded to `ok: true` passes every test that only
 * ever runs against a healthy machine. It is simulated by pointing a
 * short-lived server at an address nothing is listening on, which needs no
 * change to the running application and cannot disturb it.
 *
 * The six documentation requirements are checked against the prose, because
 * "document that" is the requirement — there is no code that could satisfy it.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-deployment.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

const BASE_URL = (process.env.EVAL_BASE_URL ?? 'http://localhost:3007').replace(/\/$/, '');
const DEGRADED_PORT = Number(process.env.DEPLOY_DEGRADED_PORT ?? 3041);

/** Must match INFERENCE_DISABLED_MESSAGE exactly; drift would be a bug. */
const HONEST_MESSAGE =
  'AI chat is currently unavailable on the public demo. ' +
  'Please run AARIZ AI locally to use Ollama-powered chat.';

interface HealthBody {
  ok?: unknown;
  llm?: unknown;
  database?: unknown;
  [key: string]: unknown;
}

async function identify(port: number): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(5_000) });
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  if (!response.ok) return `HTTP ${response.status}`;
  if ((response.headers.get('content-security-policy') ?? '').length === 0) return 'no CSP';
  if (response.headers.get('x-powered-by') !== null) return 'X-Powered-By present';
  if (!(await response.text()).includes('AARIZ')) return 'no AARIZ branding';
  return null;
}

/** Start the built app with an environment overlay, then always stop it. */
async function withServer<T>(
  overlay: Record<string, string>,
  body: (port: number) => Promise<T>,
): Promise<T | null> {
  const child: ChildProcess = spawn('npx', ['next', 'start', '--port', String(DEGRADED_PORT)], {
    cwd: ROOT,
    env: { ...process.env, ...overlay },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  child.stderr?.resume();

  const stop = (): Promise<void> =>
    new Promise((done) => {
      if (child.pid === undefined) return done();
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: true });
      killer.on('exit', () => done());
      killer.on('error', () => done());
    });

  try {
    const deadline = Date.now() + 90_000;
    let problem: string | null = 'not started';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
      problem = await identify(DEGRADED_PORT);
      if (problem === null) break;
    }
    if (problem !== null) {
      block('the degraded-mode server did not start', problem);
      return null;
    }
    return await body(DEGRADED_PORT);
  } finally {
    await stop();
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Level 23 — deployment ===\n');

  // =========================================================================
  console.log('-- The six self-hosting disclosures (documentation) ----------------');

  const doc = read('docs', 'DEPLOYMENT.md');

  for (const [requirement, pattern] of [
    ['the machine must remain online', /online and awake|must remain \*\*online/i],
    ['the endpoint must be securely reachable', /authenticated (tunnel|layer)|securely reachable|must not be done without an authenticated/i],
    ['bandwidth matters', /\*\*Bandwidth\*\* matters/i],
    ['hardware limits concurrency', /Hardware limits concurrency/i],
    ['electricity and internet are real costs', /\*\*Electricity\*\* is a real/i],
    ['there is no magical unlimited free GPU', /no magical unlimited free GPU/i],
  ] as const) {
    check(pattern.test(doc), `documented: ${requirement}`);
  }

  // The GPU claim in particular must be backed by the Level 21 measurement
  // rather than asserted, since it is the one most tempting to hand-wave.
  check(
    /0 MB in VRAM/i.test(doc) && /98\.6%/.test(doc),
    '  and the GPU claim cites the Level 21 measurement rather than asserting it',
  );

  console.log('\n-- Deployment documentation completeness ---------------------------');
  for (const [label, pattern] of [
    ['a health endpoint section', /## Health endpoint/],
    ['a production environment checklist', /## Production environment checklist/],
    ['an operational runbook', /## Operational runbook/],
    ['the rate-limit hazard', /development-generous/i],
    ['the read-the-body-not-the-status warning', /Alert on `ok: false`, not on the status code/],
  ] as const) {
    check(pattern.test(doc), `DEPLOYMENT.md has ${label}`);
  }

  // Level 15 flagged this as Level 23's to close.
  const envExample = read('.env.example');
  check(
    /^RAG_MAX_CONTEXT_CHARS=/m.test(envExample),
    'RAG_MAX_CONTEXT_CHARS is now documented in .env.example (gap closed)',
  );
  check(
    !/RAG_MAX_CONTEXT_CHARS.*missing from/.test(doc),
    '  and the known-gaps table no longer lists it',
  );

  console.log('\n-- The endpoint leaks nothing (source) -----------------------------');
  const healthLib = read('src', 'lib', 'health.ts');
  const healthRoute = read('src', 'app', 'api', 'health', 'route.ts');
  const code = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

  check(
    !/error\.message|\.message\b/.test(code(healthLib).replace(/catch\s*\{/g, '')),
    'health.ts never puts an upstream error message in its result',
  );
  check(
    !/SUPABASE_URL|SERVICE_ROLE|11434/.test(code(healthRoute)),
    'the route names no address or credential',
  );
  check(/CACHE_TTL_MS/.test(healthLib), 'probe results are cached, so the endpoint cannot amplify load');

  // =========================================================================
  let appUp = false;
  try {
    appUp = (await identify(Number(new URL(BASE_URL).port || 80))) === null;
  } catch {
    appUp = false;
  }

  if (!appUp) {
    block('the application is not identifiable', BASE_URL);
    summary();
    return;
  }

  console.log(`\n   Verified application identity at ${BASE_URL}`);
  console.log('\n-- GET /api/health, dependencies up --------------------------------');

  const response = await fetch(`${BASE_URL}/api/health`);
  const raw = await response.text();
  let body: HealthBody = {};
  try {
    body = JSON.parse(raw) as HealthBody;
  } catch {
    /* reported below */
  }

  check(response.status === 200, 'answers 200', `HTTP ${response.status}`);
  check(Object.keys(body).length > 0, 'returns JSON', raw.slice(0, 80));

  // The roadmap specifies the shape exactly. Extra fields are how a health
  // endpoint turns into an information disclosure over time.
  const keys = Object.keys(body).sort();
  check(
    keys.length === 3 && keys.join(',') === 'database,llm,ok',
    'returns exactly { ok, llm, database } and nothing more',
    keys.join(', '),
  );
  check(typeof body.ok === 'boolean', 'ok is a boolean', String(body.ok));
  check(
    body.llm === 'available' || body.llm === 'unavailable',
    'llm is available/unavailable',
    String(body.llm),
  );
  check(
    body.database === 'available' || body.database === 'unavailable',
    'database is available/unavailable',
    String(body.database),
  );
  check(body.ok === true, 'ok is true with both dependencies up', JSON.stringify(body));

  check(
    (response.headers.get('cache-control') ?? '').includes('no-store'),
    'the response is not cacheable by an intermediary',
    response.headers.get('cache-control') ?? '(absent)',
  );

  console.log('\n-- It leaks nothing over the wire ----------------------------------');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  for (const [label, secret] of [
    ['the service-role key', serviceKey],
    ['the anon key', anonKey],
    ['the Supabase URL', supabaseUrl],
  ] as const) {
    check(
      secret.length > 0 && !raw.includes(secret),
      `does not contain ${label}`,
      secret.length > 0 ? '' : 'NOT SET — cannot prove absence',
    );
  }
  for (const needle of ['11434', 'llama', 'nomic', 'localhost', 'ollama']) {
    check(!raw.toLowerCase().includes(needle), `does not contain "${needle}"`);
  }

  console.log('\n-- Level 16 protections still apply --------------------------------');
  check(
    (response.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"),
    'health carries the Level 16 CSP',
  );
  check(response.headers.get('x-powered-by') === null, 'health does not advertise the framework');

  const preflight = await fetch(`${BASE_URL}/api/health`, { method: 'OPTIONS' });
  await preflight.arrayBuffer();
  check(preflight.status === 405, 'preflight is refused', `HTTP ${preflight.status}`);
  check(
    preflight.headers.get('access-control-allow-origin') === null,
    '  and no Access-Control-Allow-Origin is emitted',
  );

  console.log('\n-- Repeated calls do not amplify onto upstreams ---------------------');
  const burstStart = performance.now();
  const burst = await Promise.all(
    Array.from({ length: 10 }, () => fetch(`${BASE_URL}/api/health`).then((r) => r.text())),
  );
  const burstMs = performance.now() - burstStart;
  check(burst.every((entry) => entry === raw || entry.includes('"ok"')), '10 rapid calls all answer');
  check(
    burstMs < 5_000,
    '  and return fast, so probes are cached rather than repeated',
    `${Math.round(burstMs)} ms for 10`,
  );

  // =========================================================================
  console.log('\n-- Degraded: the LLM is unreachable --------------------------------');
  console.log('   (a short-lived server pointed at a dead port; the running app is untouched)');

  await withServer({ LLM_PROVIDER: 'disabled' }, async (port) => {
    console.log('\n-- A3 demo mode: LLM_PROVIDER=disabled -----------------------------');

    const health = await fetch(`http://localhost:${port}/api/health`);
    const healthBody = (await health.json()) as HealthBody;
    check(healthBody.llm === 'unavailable', 'health reports llm: unavailable', String(healthBody.llm));
    check(
      healthBody.database === 'available',
      '  while the database still works — the demo is not simply broken',
      String(healthBody.database),
    );

    // The refusal must be immediate. A deployment that reaches for a
    // `localhost` it cannot have would burn the whole probe timeout instead.
    const started = performance.now();
    const chat = await fetch(`http://localhost:${port}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = performance.now() - started;
    const chatBody = (await chat.json()) as { error?: string };

    check(chat.status === 503, 'chat answers 503, not a hang or a crash', `HTTP ${chat.status}`);
    check(elapsed < 3_000, '  and refuses immediately', `${Math.round(elapsed)} ms`);
    check(
      chatBody.error === HONEST_MESSAGE,
      '  with the exact honest message',
      chatBody.error ?? '(none)',
    );
    /**
     * The message names no ADDRESS, VARIABLE or MODEL TAG.
     *
     * It does say "Ollama", deliberately: that is the wording the demo notice
     * is specified to use, and the runtime's name is public in this repository
     * and constant across every model. An earlier version of this check
     * rejected the word itself, which failed correct code.
     */
    check(
      !/localhost|11434|127\.0\.0\.1|LLM_PROVIDER|SUPABASE|llama\s*3|:\d+b/i.test(
        chatBody.error ?? '',
      ),
      '  which names no address, environment variable or model tag',
    );

    // Upload embeds before storing, so it depends on the same server.
    const form = new FormData();
    form.set('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    const upload = await fetch(`http://localhost:${port}/api/documents`, {
      method: 'POST',
      body: form,
    });
    const uploadBody = (await upload.json()) as { error?: string };
    check(upload.status === 503, 'upload also refuses — it needs embeddings too', `HTTP ${upload.status}`);
    check(uploadBody.error === HONEST_MESSAGE, '  with the same honest message');

    const page = await fetch(`http://localhost:${port}/`);
    const html = await page.text();
    check(html.includes(HONEST_MESSAGE), 'the UI states it plainly rather than failing on submit');
    check(
      !/llama\s*3|:\d+b|nomic-embed|11434|You are AARIZ AI/i.test(html),
      '  and still names no model tag, address or system prompt',
    );

    // Security must not have been traded away for deployability.
    check(
      (page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"),
      'the Level 16 CSP survives in demo mode',
    );
    check(page.headers.get('x-powered-by') === null, '  and X-Powered-By stays off');
    const adminAnon = await fetch(`http://localhost:${port}/admin`);
    await adminAnon.arrayBuffer();
    check(adminAnon.status === 404, '  and /admin is still 404 when signed out', `HTTP ${adminAnon.status}`);
    return null;
  });

  console.log('\n-- Degraded: the LLM is unreachable (configured, but down) ---------');

  await withServer({ OLLAMA_BASE_URL: 'http://127.0.0.1:1' }, async (port) => {
    const degraded = await fetch(`http://localhost:${port}/api/health`);
    const text = await degraded.text();
    let parsed: HealthBody = {};
    try {
      parsed = JSON.parse(text) as HealthBody;
    } catch {
      /* reported below */
    }

    check(
      parsed.llm === 'unavailable',
      'reports llm: unavailable when Ollama cannot be reached',
      String(parsed.llm),
    );
    check(parsed.ok === false, '  and ok becomes false', String(parsed.ok));
    check(
      parsed.database === 'available',
      '  while the database is still reported available (probes are independent)',
      String(parsed.database),
    );
    check(
      degraded.status === 200,
      '  and the HTTP status stays 200 — restarting the app would not fix Ollama',
      `HTTP ${degraded.status}`,
    );
    check(
      !text.includes('127.0.0.1') && !text.includes('ECONNREFUSED'),
      '  and the failure reason is not disclosed',
      text.slice(0, 80),
    );
    return null;
  });
}

main()
  .then(summary)
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
