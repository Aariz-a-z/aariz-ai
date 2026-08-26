#!/usr/bin/env node
/**
 * Level 20 — offline / zero-API mode verification.
 *
 * ROADMAP.md Level 20 asks for `ZERO_API_MODE=true` under which everything is
 * local and there are "no paid AI API calls", and for the admin interface to
 * display the mode, provider and model so "it is obvious that the chatbot is
 * not consuming a cloud AI API".
 *
 * THE CLAIM THAT MATTERS IS THE REFUSAL, NOT THE BANNER
 * ----------------------------------------------------
 * A page saying "Inference mode: LOCAL" proves nothing on its own — it is a
 * string. What makes it true is that with the mode on, a cloud provider cannot
 * be selected at all. So this suite spends most of its effort on the
 * enforcement path: real servers, started with a cloud provider configured and
 * zero-API mode on, must refuse to answer.
 *
 * The display is checked by `verify-monitoring.ts`, which already holds an
 * authenticated admin session; duplicating that machinery here would mean a
 * second copy of the account lifecycle for one assertion.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-offline.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ZERO_API_MODE_ENV,
  describeInference,
  isLocalProvider,
  isZeroApiMode,
} from '../src/lib/inference-mode.ts';
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
const PORT = Number(process.env.OFFLINE_PORT ?? 3031);

/** Confirm a spawned server is ours before believing anything it reports. */
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
  body: (port: number, output: () => string) => Promise<T>,
): Promise<T | null> {
  const child: ChildProcess = spawn('npx', ['next', 'start', '--port', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, ...overlay },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Captured rather than discarded: the control below discriminates on the
  // REASON the server logged, which is the only place the two failure paths
  // differ — both are a deliberately indistinguishable 500 to the caller.
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));

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
      block(`server did not start with ${JSON.stringify(overlay)}`, problem);
      return null;
    }
    return await body(PORT, () => buffer);
  } finally {
    await stop();
  }
}

/** Ask one question and report only what the status was and what it said. */
async function ask(port: number): Promise<{ status: number; error: string | null }> {
  const response = await fetch(`http://localhost:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.ok) {
    await response.arrayBuffer();
    return { status: response.status, error: null };
  }
  let error: string | null = null;
  try {
    error = ((await response.json()) as { error?: string }).error ?? null;
  } catch {
    error = null;
  }
  return { status: response.status, error };
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Level 20 — offline / zero-API mode ===\n');

  // =========================================================================
  console.log('-- Mode parsing is strict (in-process) ----------------------------');

  const saved = process.env[ZERO_API_MODE_ENV];
  const restore = (): void => {
    if (saved === undefined) delete process.env[ZERO_API_MODE_ENV];
    else process.env[ZERO_API_MODE_ENV] = saved;
  };

  try {
    for (const [value, expected] of [
      ['true', true],
      ['TRUE', true],
      ['1', true],
      ['false', false],
      ['0', false],
    ] as const) {
      process.env[ZERO_API_MODE_ENV] = value;
      check(isZeroApiMode() === expected, `ZERO_API_MODE=${value} parses as ${expected}`);
    }

    delete process.env[ZERO_API_MODE_ENV];
    check(isZeroApiMode() === false, 'an unset ZERO_API_MODE defaults to false');

    // A typo must be an error, never a silent opt-out of a guarantee.
    for (const typo of ['ture', 'yes', 'on', 'enabled']) {
      process.env[ZERO_API_MODE_ENV] = typo;
      let threw = false;
      try {
        isZeroApiMode();
      } catch {
        threw = true;
      }
      check(threw, `ZERO_API_MODE=${typo} is a configuration error, not a quiet "off"`);
    }

    check(isLocalProvider('ollama'), 'ollama is a local provider');
    check(isLocalProvider('OLLAMA'), '  in any casing');
    check(!isLocalProvider('gemini'), 'gemini is NOT a local provider');
    check(!isLocalProvider('openai'), 'an unknown provider is NOT assumed local — deny by default');
    check(!isLocalProvider(''), 'an empty provider is NOT local');

    // =======================================================================
    console.log('\n-- The description the admin page renders -------------------------');

    restore();
    const description = describeInference();
    console.log(
      `   mode=${description.mode} provider=${description.provider} model=${description.model}`,
    );
    check(description.mode === 'LOCAL', 'the configured stack reports LOCAL', description.mode);
    check(description.provider === 'Ollama', 'the provider is named for a human', description.provider);
    check(
      description.model.length > 0 && description.model !== 'not configured',
      'the model is named',
      description.model,
    );
    check(description.allLocal, 'every inference component is local');
    check(
      /nomic|embed/i.test(description.embeddingModel),
      'embeddings are local too',
      description.embeddingModel,
    );
    check(
      description.reranking === 'disabled' || /local/.test(description.reranking),
      'reranking is local or disabled — never a cloud call',
      description.reranking,
    );

    // The description must follow the configuration, not a hard-coded string.
    process.env.LLM_PROVIDER = 'gemini';
    delete process.env[ZERO_API_MODE_ENV];
    const cloud = describeInference();
    check(cloud.mode === 'CLOUD', 'a cloud provider is reported as CLOUD, not LOCAL', cloud.mode);
    check(!cloud.allLocal, '  and not reported as all-local');
    process.env.LLM_PROVIDER = 'ollama';
    restore();
  } finally {
    restore();
    process.env.LLM_PROVIDER = 'ollama';
  }

  // =========================================================================
  console.log('\n-- Enforcement: the mode actually refuses a cloud provider ---------');

  await withServer({ ZERO_API_MODE: 'true', LLM_PROVIDER: 'gemini' }, async (port, output) => {
    const outcome = await ask(port);
    check(
      outcome.status === 500,
      'ZERO_API_MODE=true + LLM_PROVIDER=gemini refuses to answer',
      `HTTP ${outcome.status}`,
    );
    check(
      outcome.error !== null && !/api[_-]?key|endpoint|googleapis/i.test(outcome.error),
      '  and the public message names no credential or endpoint',
      outcome.error ?? '(none)',
    );
    check(
      /ZERO_API_MODE is enabled/.test(output()),
      '  and the LOG shows the refusal came from the zero-API check',
    );
    return null;
  });

  /**
   * The control, rewritten because Gemini is now implemented.
   *
   * It used to rely on gemini returning 501 `not_implemented` without the
   * mode, so that a 500 with the mode proved the zero-API check had fired.
   * There is a real adapter now: both paths return 500, and the status alone
   * no longer discriminates.
   *
   * So the control discriminates on the LOGGED reason instead, which is
   * stronger — it names the actual mechanism rather than inferring it from a
   * status code. Without the mode the failure must be the missing key; the
   * zero-API check must not appear at all.
   */
  await withServer({ ZERO_API_MODE: 'false', LLM_PROVIDER: 'gemini' }, async (port, output) => {
    const outcome = await ask(port);
    check(
      outcome.status === 500,
      'CONTROL: without the mode, gemini still fails — for a different reason',
      `HTTP ${outcome.status}`,
    );
    check(
      !/ZERO_API_MODE is enabled/.test(output()),
      '  and the zero-API check did NOT fire',
    );
    check(
      /GEMINI_API_KEY is not set/.test(output()),
      '  it failed on the missing key instead — so the 500 above WAS the mode',
    );
    return null;
  });

  await withServer({ ZERO_API_MODE: 'true' }, async (port) => {
    const outcome = await ask(port);
    check(
      outcome.status === 200,
      'ZERO_API_MODE=true still answers normally with the local provider',
      `HTTP ${outcome.status}`,
    );
    return null;
  });

  await withServer({ ZERO_API_MODE: 'ture' }, async (port) => {
    const outcome = await ask(port);
    check(
      outcome.status === 500,
      'a misspelled ZERO_API_MODE fails loudly rather than disabling the guarantee',
      `HTTP ${outcome.status}`,
    );
    return null;
  });

  // =========================================================================
  console.log('\n-- No cloud AI endpoint is reachable from the source ---------------');

  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const sources = [
    'src/lib/llm.ts',
    'src/lib/llm/ollama.ts',
    'src/lib/embeddings.ts',
    'src/lib/retrieval.ts',
    'src/lib/rerank/lexical.ts',
    'src/lib/rerank/llm.ts',
  ];
  for (const file of sources) {
    const code = readFileSync(join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    check(
      !/googleapis\.com|openai\.com|api\.anthropic\.com|generativelanguage/i.test(code),
      `${file} contacts no cloud AI endpoint`,
    );
  }
}

main()
  .then(summary)
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
