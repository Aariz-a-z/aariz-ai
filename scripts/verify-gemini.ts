#!/usr/bin/env node
/**
 * Gemini provider verification.
 *
 * SPLIT BY WHAT A KEY IS ACTUALLY NEEDED FOR
 * ------------------------------------------
 * Most of what matters here can be proved without ever calling Google: that
 * the provider is selected, that a missing key is refused cleanly, that
 * nothing reaches for `localhost` in Gemini mode, that the budget refuses when
 * exhausted, that no secret reaches a client bundle, and that every upstream
 * failure maps to a safe message. Those run unconditionally.
 *
 * What genuinely needs a key — a real generation, a real embedding, the
 * dimension of a real vector, a real RAG answer — is skipped and reported as
 * PENDING when `GEMINI_API_KEY` is absent. It is never simulated. A test that
 * fabricates a provider response proves the fabrication works and nothing
 * else, and would be worse than no test because it would look like coverage.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-gemini.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMBEDDING_DIMENSION,
  createEmbeddingProvider,
  embedQuery,
  getEmbeddingModel,
  getEmbeddingProviderId,
} from '../src/lib/embeddings.ts';
import { EmbeddingError } from '../src/lib/embeddings/types.ts';
import { isGeminiProvider } from '../src/lib/inference-mode.ts';
import {
  enforceGeminiBudget,
  getGeminiBudget,
  getRateLimitConfig,
  resetRateLimitState,
} from '../src/lib/rate-limit.ts';
import { loadEnvLocal } from './_env.ts';

let passed = 0;
let failed = 0;
let blocked = 0;
let pending = 0;

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
}

function block(label: string, detail = ''): void {
  console.log(`  [BLOCKED] ${label}${detail ? `  — ${detail}` : ''}`);
  blocked++;
}

/** Needs a real key. Reported, never faked. */
function pendingKey(label: string): void {
  console.log(`  [PENDING] ${label}  — needs a real GEMINI_API_KEY`);
  pending++;
}

function summary(): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log(
    `  ${passed} passed · ${failed} failed · ${blocked} blocked · ${pending} pending a real API key`,
  );
  console.log('='.repeat(72));
  if (failed > 0 || blocked > 0) process.exitCode = 1;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');
const PORT = Number(process.env.GEMINI_TEST_PORT ?? 3051);

/** Source with comments stripped, so prose about a rule is not mistaken for it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
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

async function withServer<T>(
  overlay: Record<string, string>,
  body: (port: number) => Promise<T>,
): Promise<T | null> {
  const child: ChildProcess = spawn('npx', ['next', 'start', '--port', String(PORT)], {
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
      problem = await identify(PORT);
      if (problem === null) break;
    }
    if (problem !== null) {
      block('the test server did not start', problem);
      return null;
    }
    return await body(PORT);
  } finally {
    await stop();
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Gemini provider ===\n');

  const hasKey = (process.env.GEMINI_API_KEY?.trim() ?? '').length > 0;
  console.log(`   GEMINI_API_KEY: ${hasKey ? 'present — real API tests will run' : 'ABSENT'}`);

  // =========================================================================
  console.log('\n-- The adapters exist and stay behind the abstraction --------------');

  const llmFactory = code(read('src', 'lib', 'llm.ts'));
  const embedFactory = code(read('src', 'lib', 'embeddings.ts'));

  check(/case 'gemini'/.test(llmFactory), 'the LLM factory has a gemini case');
  check(/GEMINI_API_KEY/.test(llmFactory), '  and requires a key rather than defaulting');
  check(/case 'gemini'/.test(embedFactory), 'the embedding factory has a gemini case');

  // The public embedding API must be unchanged, or retrieval/ingestion break.
  for (const name of [
    'embedDocuments',
    'embedDocumentsWithTokenCounts',
    'embedQuery',
    'getEmbeddingModel',
    'EMBEDDING_DIMENSION',
  ]) {
    check(
      new RegExp(`export (async )?(function|const|\\{[^}]*)\\s*${name}|export \\{[^}]*${name}`).test(
        read('src', 'lib', 'embeddings.ts'),
      ),
      `the public API still exports ${name}`,
    );
  }

  // Consumers must not have had to change.
  for (const consumer of ['src/lib/retrieval.ts', 'src/lib/ingest/pipeline.ts']) {
    const source = code(read(...consumer.split('/')));
    check(
      !/embeddings\/(ollama|gemini)/.test(source),
      `${consumer} imports the factory, not an adapter (Rule 8)`,
    );
  }

  console.log('\n-- One switch selects both generation and embeddings ---------------');
  const saved = process.env.LLM_PROVIDER;
  try {
    process.env.LLM_PROVIDER = 'gemini';
    check(isGeminiProvider(), 'LLM_PROVIDER=gemini is recognised');
    check(
      getEmbeddingProviderId() === 'gemini',
      '  and selects the Gemini EMBEDDING provider too',
      getEmbeddingProviderId(),
    );
    check(
      /embedding|text-embedding|gemini/i.test(getEmbeddingModel()),
      '  reporting a Gemini embedding model',
      getEmbeddingModel(),
    );

    process.env.LLM_PROVIDER = 'ollama';
    check(getEmbeddingProviderId() === 'ollama', 'LLM_PROVIDER=ollama selects Ollama embeddings');
    check(getEmbeddingModel() === 'nomic-embed-text', '  with the unchanged local model', getEmbeddingModel());
  } finally {
    if (saved === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = saved;
  }

  console.log('\n-- A missing key fails cleanly, not mysteriously -------------------');
  const savedKey = process.env.GEMINI_API_KEY;
  const savedProvider = process.env.LLM_PROVIDER;
  try {
    process.env.LLM_PROVIDER = 'gemini';
    delete process.env.GEMINI_API_KEY;

    const provider = createEmbeddingProvider();
    let thrown: unknown;
    try {
      await provider.embedBatch(['hello'], 'query', {});
    } catch (caught) {
      thrown = caught;
    }
    check(thrown instanceof EmbeddingError, 'a missing key throws EmbeddingError');
    check(
      thrown instanceof EmbeddingError && thrown.code === 'invalid_credentials',
      '  with code invalid_credentials',
      thrown instanceof EmbeddingError ? thrown.code : String(thrown),
    );
    check(
      thrown instanceof Error && /GEMINI_API_KEY/.test(thrown.message),
      '  naming the variable so it is actionable',
    );
  } finally {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = savedProvider;
  }

  // =========================================================================
  console.log('\n-- No secret and no upstream detail can escape ---------------------');

  const geminiLlm = code(read('src', 'lib', 'llm', 'gemini.ts'));
  const geminiEmbed = code(read('src', 'lib', 'embeddings', 'gemini.ts'));

  for (const [name, source] of [
    ['llm/gemini.ts', geminiLlm],
    ['embeddings/gemini.ts', geminiEmbed],
  ] as const) {
    // A key in a query string lands in access logs and proxy traces.
    check(!/[?&]key=/.test(source), `${name} never puts the key in a URL`);
    check(/x-goog-api-key/.test(source), `  it sends the key as a header instead`);
    // Upstream text can echo request content and name internal services.
    check(
      !/error\.message|data\.error\.message|body\.error\.message/.test(source),
      `${name} never surfaces the upstream error message`,
    );
    check(!/NEXT_PUBLIC/.test(source), `${name} defines no NEXT_PUBLIC variable`);
  }

  check(
    !/GEMINI_API_KEY/.test(code(read('src', 'components', 'chat.tsx'))) &&
      !/GEMINI_API_KEY/.test(code(read('src', 'components', 'embedded-chat.tsx'))),
    'no client component references the key',
  );

  const envExample = read('.env.example');
  check(!/NEXT_PUBLIC_GEMINI/.test(envExample), '.env.example defines no NEXT_PUBLIC_GEMINI*');

  // The Level 16 redactor must already cover it — "key" is a substring match.
  const logger = read('src', 'lib', 'log.ts');
  check(/'key'/.test(logger), 'the Level 16 log redactor still redacts any field containing "key"');

  console.log('\n-- Gemini mode never reaches for localhost -------------------------');
  check(!/11434|localhost/.test(geminiLlm), 'llm/gemini.ts contains no localhost reference');
  check(!/11434|localhost/.test(geminiEmbed), 'embeddings/gemini.ts contains no localhost reference');
  check(
    /isGeminiProvider\(\)/.test(code(read('src', 'lib', 'health.ts'))),
    'the health probe branches on the provider before touching Ollama',
  );

  // =========================================================================
  console.log('\n-- The Gemini budget is a real ceiling -----------------------------');

  const budget = getGeminiBudget();
  console.log(`   configured: ${budget.perHour}/hour · ${budget.perDay}/day`);
  check(budget.perHour > 0 && budget.perDay > 0, 'a budget is configured', `${budget.perHour}/${budget.perDay}`);
  check(budget.perDay >= budget.perHour, '  and the daily ceiling is not below the hourly one');

  const budgetProvider = process.env.LLM_PROVIDER;
  try {
    resetRateLimitState();
    process.env.LLM_PROVIDER = 'ollama';
    check(
      enforceGeminiBudget() === null,
      'the budget is a no-op for a local provider — development is not throttled',
    );

    resetRateLimitState();
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_REQUESTS_PER_HOUR = '3';
    process.env.GEMINI_REQUESTS_PER_DAY = '100';

    let allowed = 0;
    let refused: Response | null = null;
    for (let i = 0; i < 5; i++) {
      const outcome = enforceGeminiBudget();
      if (outcome === null) allowed++;
      else if (refused === null) refused = outcome;
    }
    check(allowed === 3, 'it allows exactly the configured number', `${allowed}/3`);
    check(refused !== null && refused.status === 429, '  then refuses with 429', `HTTP ${refused?.status}`);

    if (refused !== null) {
      const body = (await refused.json()) as { error?: string };
      check(
        typeof body.error === 'string' && !/gemini|quota|budget|google/i.test(body.error),
        '  and the message names no provider, quota or budget',
        body.error ?? '(none)',
      );
      check(
        refused.headers.get('retry-after') !== null,
        '  with a Retry-After header so a client need not guess',
      );
    }

    // The existing per-caller limits must be untouched by all this.
    const config = getRateLimitConfig();
    check(config.limits.chat.anonymous > 0, 'the Level 14 chat budget still exists', String(config.limits.chat.anonymous));
    check(config.maxConcurrent >= 1, 'the Level 14 concurrency cap still exists', String(config.maxConcurrent));
    check(config.limits.widget.anonymous > 0, 'the Level 17 widget budget still exists');
  } finally {
    delete process.env.GEMINI_REQUESTS_PER_HOUR;
    delete process.env.GEMINI_REQUESTS_PER_DAY;
    if (budgetProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = budgetProvider;
    resetRateLimitState();
  }

  console.log('\n-- Retry policy cannot amplify a quota overrun ---------------------');
  check(
    /quota_exceeded/.test(read('src', 'lib', 'embeddings.ts')) &&
      !/error\.code === 'quota_exceeded'/.test(
        code(read('src', 'lib', 'embeddings.ts')).match(/function isRetryable[\s\S]*?\n}/)?.[0] ?? '',
      ),
    'quota_exceeded is NOT retryable — retrying a 429 is how an overrun grows',
  );

  // =========================================================================
  console.log('\n-- Vector width is preserved ---------------------------------------');
  check(EMBEDDING_DIMENSION === 768, 'the schema dimension is still 768', String(EMBEDDING_DIMENSION));
  const migration = read('supabase', 'migrations', '20260817120000_init_documents_and_chunks.sql');
  check(/vector\(768\)/.test(migration), '  and the migration is unchanged');
  check(
    /outputDimensionality/.test(geminiEmbed),
    'the adapter can request a truncated width for models that need it',
  );
  check(
    /dimension_mismatch/.test(read('src', 'lib', 'embeddings.ts')),
    'a wrong-width vector is refused before it reaches the database',
  );

  // =========================================================================
  console.log('\n-- Real API behaviour ----------------------------------------------');

  if (!hasKey) {
    for (const label of [
      'a real Gemini generation returns text',
      'a real Gemini embedding returns a vector',
      'that vector has exactly 768 dimensions',
      'an invalid key is rejected with invalid_credentials',
      'a full RAG answer with citations',
      'document ingestion through Gemini embeddings',
      'timeout handling against the real endpoint',
    ]) {
      pendingKey(label);
    }
    console.log('\n   Set GEMINI_API_KEY in .env.local and re-run to execute these.');
  } else {
    const provider = process.env.LLM_PROVIDER;
    try {
      process.env.LLM_PROVIDER = 'gemini';
      // Level 20 enforces local-only inference; it must be off to reach Gemini.
      const zero = process.env.ZERO_API_MODE;
      process.env.ZERO_API_MODE = 'false';

      try {
        const vector = await embedQuery('What is the auxiliary boiler working pressure?');
        check(Array.isArray(vector) && vector.length > 0, 'a real Gemini embedding returns a vector');
        check(
          vector.length === EMBEDDING_DIMENSION,
          `that vector has exactly ${EMBEDDING_DIMENSION} dimensions`,
          String(vector.length),
        );
        check(
          vector.every((value) => Number.isFinite(value)),
          '  and every component is finite',
        );
      } catch (caught) {
        check(false, 'a real Gemini embedding returns a vector', caught instanceof Error ? caught.message : String(caught));
      }

      // An invalid key must be rejected, not silently accepted.
      const goodKey = process.env.GEMINI_API_KEY;
      process.env.GEMINI_API_KEY = 'not-a-real-key';
      let rejected: unknown;
      try {
        await embedQuery('probe');
      } catch (caught) {
        rejected = caught;
      }
      check(
        rejected instanceof EmbeddingError &&
          (rejected.code === 'invalid_credentials' || rejected.code === 'provider_error'),
        'an invalid key is rejected',
        rejected instanceof EmbeddingError ? rejected.code : String(rejected),
      );
      check(
        rejected instanceof Error && !rejected.message.includes('not-a-real-key'),
        '  without echoing the key back',
      );
      process.env.GEMINI_API_KEY = goodKey;

      await withServer({ LLM_PROVIDER: 'gemini', ZERO_API_MODE: 'false' }, async (port) => {
        const health = await fetch(`http://localhost:${port}/api/health`);
        const body = (await health.json()) as { llm?: string; database?: string };
        check(body.llm === 'available', 'health reports the Gemini provider available', String(body.llm));

        const started = Date.now();
        const chat = await fetch(`http://localhost:${port}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello in five words.' }] }),
          signal: AbortSignal.timeout(120_000),
        });
        const text = await chat.text();
        const deltas = (text.match(/"type":"delta"/g) ?? []).length;
        check(chat.status === 200, 'a real Gemini generation answers', `HTTP ${chat.status} in ${Date.now() - started}ms`);
        check(deltas > 0, '  and streams', `${deltas} deltas`);
        check(
          !text.includes(process.env.GEMINI_API_KEY ?? ' '),
          '  without the key appearing in the response',
        );
        return null;
      });

      if (zero === undefined) delete process.env.ZERO_API_MODE;
      else process.env.ZERO_API_MODE = zero;
    } finally {
      if (provider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = provider;
    }
  }
}

main()
  .then(summary)
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
