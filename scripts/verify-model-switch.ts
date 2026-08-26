#!/usr/bin/env node
/**
 * Level 19 — model switching verification.
 *
 * ROADMAP.md Level 19: "I must be able to switch models without modifying the
 * RAG pipeline… The following must NOT require changes: UI, retrieval,
 * database, authentication, document ingestion, conversation system. Only the
 * model configuration should change."
 *
 * That is a claim about the SHAPE of the code as much as about its behaviour,
 * so this proves it two ways and neither alone would do.
 *
 *   static    Reads the source tree and asserts the boundary actually exists:
 *             exactly one module knows which provider is configured, nothing
 *             else imports the adapter, and no model name has leaked into the
 *             UI, the shared types, or the database schema. A passing runtime
 *             test cannot show this — a codebase riddled with `OLLAMA_MODEL`
 *             reads would still answer a question correctly.
 *
 *   dynamic   Starts the real application twice, with two DIFFERENT models,
 *             and drives the same question through both. This is what shows
 *             the switch is genuinely only configuration: the retrieved chunks
 *             must be identical, because the chat model has no business
 *             influencing retrieval, while the model recorded in the Level 18
 *             log must differ.
 *
 * WHY IT SPAWNS ITS OWN SERVERS
 * -----------------------------
 * `getLlmProvider()` reads `process.env` on every call, so a model switch is
 * runtime configuration: a restart, not a rebuild. Verified directly — a
 * server started with `OLLAMA_MODEL=llama3.2:1b` in its environment logged
 * `"model":"llama3.2:1b"` while `.env.local` still said `llama3.2:3b`, which
 * also establishes that process environment beats `.env.local` for a runtime
 * read. So the suite can vary the model by spawning servers and never has to
 * edit the developer's `.env.local`.
 *
 * `src/lib/llm.ts` cannot be imported here — it uses `@/` path aliases that
 * plain Node does not resolve, the same limitation `verify-rerank.ts`
 * documents — so the factory's error cases are exercised over HTTP against
 * short-lived servers rather than in process.
 *
 * Run (needs Ollama up and at least two chat models installed):
 *   node --experimental-strip-types scripts/verify-model-switch.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { ingestPath } from '../src/lib/ingest/pipeline.ts';
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
const readSource = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/** Ports for the short-lived servers this suite starts. Away from 3000/3001. */
const PORT_A = Number(process.env.MODEL_SWITCH_PORT_A ?? 3021);
const PORT_B = Number(process.env.MODEL_SWITCH_PORT_B ?? 3022);

// ---------------------------------------------------------------------------
// Server control
// ---------------------------------------------------------------------------

interface RunningServer {
  port: number;
  child: ChildProcess;
  /** Everything the server has written, for reading back Level 18 log lines. */
  output: () => string;
}

/**
 * Confirm a spawned server is OURS before trusting anything it says.
 *
 * The same discipline the Level 16/17/18 suites use, and for the same reason:
 * at Level 16 an unrelated Vite server on the expected port produced a whole
 * evaluation of garbage, and at Level 17 another project's Express server had
 * taken the port. A 200 identifies nothing.
 */
async function identify(port: number): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(5_000) });
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
  if (!response.ok) return `HTTP ${response.status}`;

  const csp = response.headers.get('content-security-policy') ?? '';
  const poweredBy = response.headers.get('x-powered-by');
  const html = await response.text();

  if (csp.length === 0) return 'no Content-Security-Policy';
  if (poweredBy !== null) return `X-Powered-By present ("${poweredBy}")`;
  if (!html.includes('AARIZ')) return 'no AARIZ branding';
  return null;
}

/**
 * Start the built application with an environment overlay, wait until it
 * identifies itself, and hand it to `body`. Always stopped afterwards.
 */
async function withServer<T>(
  port: number,
  overlay: Record<string, string | undefined>,
  body: (server: RunningServer) => Promise<T>,
): Promise<T | null> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overlay };
  // `undefined` in the overlay means "unset this", which spreading cannot do.
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete env[key];
  }

  let buffer = '';
  const child = spawn('npx', ['next', 'start', '--port', String(port)], {
    cwd: ROOT,
    env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));

  const server: RunningServer = { port, child, output: () => buffer };

  const stop = async (): Promise<void> => {
    if (child.pid === undefined || child.killed) return;
    // Windows: `next start` runs behind npx, so killing the shell alone leaves
    // the Node server holding the port. taskkill /T takes the whole tree.
    await new Promise<void>((done) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: true });
      killer.on('exit', () => done());
      killer.on('error', () => done());
    });
  };

  try {
    const deadline = Date.now() + 90_000;
    let problem: string | null = 'not started';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
      problem = await identify(port);
      if (problem === null) break;
    }
    if (problem !== null) {
      block(`server on ${port} never identified itself`, problem);
      return null;
    }
    return await body(server);
  } finally {
    await stop();
  }
}

interface ChatOutcome {
  status: number;
  deltas: number;
  answer: string;
  sources: { chunkId: string; similarity: number }[];
  error: string | null;
}

/** Drive one chat turn and collect what came back. */
async function ask(port: number, prompt: string, timeoutMs = 300_000): Promise<ChatOutcome> {
  const response = await fetch(`http://localhost:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const outcome: ChatOutcome = {
    status: response.status,
    deltas: 0,
    answer: '',
    sources: [],
    error: null,
  };

  if (!response.ok || response.body === null) {
    try {
      outcome.error = ((await response.json()) as { error?: string }).error ?? null;
    } catch {
      outcome.error = null;
    }
    return outcome;
  }

  const reader = response.body.getReader();
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
        const event = JSON.parse(raw) as {
          type: string;
          text?: string;
          sources?: { chunkId: string; similarity: number }[];
        };
        if (event.type === 'delta') {
          outcome.deltas++;
          outcome.answer += event.text ?? '';
        } else if (event.type === 'sources') {
          outcome.sources = (event.sources ?? []).map((source) => ({
            chunkId: source.chunkId,
            similarity: source.similarity,
          }));
        }
      } catch {
        /* ignore a partial line */
      }
    }
  }
  return outcome;
}

/** The model name the Level 18 log line reports for the most recent request. */
function loggedModel(output: string): string | null {
  const matches = [...output.matchAll(/"event":"chat\.completed"[^\n]*?"model":"([^"]*)"/g)];
  return matches.length === 0 ? null : (matches[matches.length - 1]?.[1] ?? null);
}

// ---------------------------------------------------------------------------
// The frozen fixture
// ---------------------------------------------------------------------------

/**
 * Written to a temp directory at run time rather than committed.
 *
 * The content is frozen here in the source, so it is reviewable and cannot
 * drift, but it leaves no fixture files behind and nothing for a later level
 * to accidentally depend on. Deliberately about a subject nothing else in the
 * project mentions, so a retrieved chunk can only have come from here.
 */
const FIXTURE = {
  'kelvin-lattice.md':
    '# Kelvin Lattice Calibration\n\n' +
    'The Kelvin lattice must be calibrated to a torsion index of 47.3 before any survey run. ' +
    'Calibration drifts by roughly 0.4 index points for every eight hours of continuous operation. ' +
    'A lattice reading below 44.0 is considered unsafe and the survey must be aborted.\n',
  'harrow-protocol.md':
    '# Harrow Protocol\n\n' +
    'The Harrow protocol governs shutdown of the auxiliary condenser. ' +
    'Operators must vent the condenser for eleven minutes before isolating the feed valve. ' +
    'Skipping the vent step risks a pressure lock that requires a full teardown to clear.\n',
};

const FIXTURE_QUESTION = 'What torsion index must the Kelvin lattice be calibrated to?';

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Level 19 — model switching ===\n');

  // =========================================================================
  console.log('-- The provider boundary exists in the source ---------------------');

  const llmFactory = readSource('src', 'lib', 'llm.ts');

  /**
   * Exactly one module may know which provider is configured. This is the
   * assertion that makes "only the model configuration changes" structural
   * rather than a habit.
   */
  const appFiles = [
    ['src/app/api/chat/route.ts', readSource('src', 'app', 'api', 'chat', 'route.ts')],
    ['src/lib/rag.ts', readSource('src', 'lib', 'rag.ts')],
    ['src/lib/retrieval.ts', readSource('src', 'lib', 'retrieval.ts')],
    ['src/lib/conversations.ts', readSource('src', 'lib', 'conversations.ts')],
    ['src/lib/conversation-context.ts', readSource('src', 'lib', 'conversation-context.ts')],
    ['src/lib/auth.ts', readSource('src', 'lib', 'auth.ts')],
    ['src/lib/documents.ts', readSource('src', 'lib', 'documents.ts')],
    ['src/lib/ingest/pipeline.ts', readSource('src', 'lib', 'ingest', 'pipeline.ts')],
    ['src/components/chat.tsx', readSource('src', 'components', 'chat.tsx')],
    ['src/components/embedded-chat.tsx', readSource('src', 'components', 'embedded-chat.tsx')],
    ['src/types/chat.ts', readSource('src', 'types', 'chat.ts')],
  ] as const;

  // Comments legitimately discuss the variables; only real reads matter.
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

  check(
    /process\.env\.LLM_PROVIDER/.test(llmFactory),
    'src/lib/llm.ts reads LLM_PROVIDER — it is the provider seam',
  );
  check(
    /process\.env\.OLLAMA_MODEL/.test(llmFactory),
    'src/lib/llm.ts reads OLLAMA_MODEL',
  );

  for (const [name, source] of appFiles) {
    const code = stripComments(source);
    check(
      !/process\.env\.(LLM_PROVIDER|OLLAMA_MODEL|OLLAMA_BASE_URL)/.test(code),
      `${name} reads no provider configuration`,
    );
  }

  for (const [name, source] of appFiles) {
    const code = stripComments(source);
    check(
      !/from ['"][^'"]*llm\/ollama['"]/.test(code),
      `${name} does not import the Ollama adapter (Rule 8)`,
    );
  }

  // A model name reaching the browser or the schema would make a switch a
  // user-visible or migration-requiring change.
  for (const [name, source] of [
    ['src/components/chat.tsx', readSource('src', 'components', 'chat.tsx')],
    ['src/components/embedded-chat.tsx', readSource('src', 'components', 'embedded-chat.tsx')],
    ['src/types/chat.ts', readSource('src', 'types', 'chat.ts')],
  ] as const) {
    const code = stripComments(source);
    /**
     * A MODEL TAG, not the runtime's name.
     *
     * This assertion originally matched /llama/, which also matches "Ollama" —
     * and the Level 23 demo notice legitimately says "Ollama-powered chat".
     * That made the check fail on correct code, because it was testing a proxy
     * for the property rather than the property.
     *
     * What Level 19 actually requires is that switching OLLAMA_MODEL needs no
     * UI change, so what the UI must never contain is a model TAG. It may name
     * the runtime: "Ollama" is the same string whether the model is 1b or 3b,
     * it is public in this repository, and it is not a credential, an address
     * or a version. Tags carry a version or a size and are the thing that
     * changes.
     */
    check(
      !/llama\s*3|llama-?\d|:\d+b|nomic-embed|gemini-\d|mistral-|qwen\d|phi-?\d/i.test(code),
      `${name} names no model TAG`,
    );
  }

  const migrations = [
    '20260817120000_init_documents_and_chunks.sql',
    '20260820120000_conversations_and_messages.sql',
    '20260821120000_authentication.sql',
    '20260822120000_document_ownership.sql',
  ];
  for (const file of migrations) {
    const sql = readSource('supabase', 'migrations', file);
    check(!/llama|gemini|ollama_model/i.test(sql), `migration ${file.slice(0, 24)}… names no model`);
  }

  check(
    /case 'gemini'/.test(llmFactory),
    'the factory has a gemini case — a future cloud provider is anticipated',
  );
  check(
    /not_implemented/.test(llmFactory),
    '  and it is honestly unimplemented rather than silently falling back',
  );

  // =========================================================================
  console.log('\n-- Two chat models are installed ----------------------------------');

  const ollamaBase = process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
  let installed: string[] = [];
  try {
    const tags = (await fetch(`${ollamaBase}/api/tags`, { signal: AbortSignal.timeout(5_000) }).then(
      (response) => response.json(),
    )) as { models?: { name: string; details?: { family?: string } }[] };
    installed = (tags.models ?? [])
      .filter((model) => model.details?.family !== 'nomic-bert')
      .map((model) => model.name);
  } catch {
    block('Ollama is not reachable', ollamaBase);
    summary();
    return;
  }

  const configured = process.env.OLLAMA_MODEL?.trim() ?? '';
  const modelA = installed.find((name) => name === configured) ?? installed[0];
  const modelB = installed.find((name) => name !== modelA);

  console.log(`   installed chat models: ${installed.join(', ')}`);
  if (modelA === undefined || modelB === undefined) {
    block('two different chat models are required', `found ${installed.length}`);
    summary();
    return;
  }
  check(modelA !== modelB, 'model A and model B are genuinely different', `${modelA} vs ${modelB}`);

  // =========================================================================
  console.log('\n-- Provider configuration edges (real servers) --------------------');

  /**
   * Gemini is now IMPLEMENTED, so this assertion changed — and it got stricter.
   *
   * It used to assert 501 `not_implemented`, which was correct while gemini
   * was an anticipated seam with no adapter behind it. There is an adapter
   * now, so 501 is the wrong expectation and the test was describing the old
   * world rather than a broken one.
   *
   * What Level 19 actually needs proving is unchanged: selecting a provider
   * SELECTS it, and never silently falls back to another. Without a key the
   * Gemini provider refuses with a configuration error — it does not quietly
   * answer from Ollama, which is the failure that would matter. `ZERO_API_MODE`
   * stays pinned off so the Level 20 check is not what is being measured.
   */
  await withServer(
    PORT_A,
    { LLM_PROVIDER: 'gemini', ZERO_API_MODE: 'false', GEMINI_API_KEY: undefined },
    async (server) => {
      const outcome = await ask(server.port, 'hello', 30_000);
      check(
        outcome.status === 500,
        'LLM_PROVIDER=gemini without a key is a configuration error',
        `HTTP ${outcome.status}`,
      );
      check(
        outcome.deltas === 0 && outcome.answer.length === 0,
        '  and it did NOT silently fall back to Ollama and answer',
        `${outcome.deltas} deltas`,
      );
      check(
        outcome.error !== null && !/GEMINI_API_KEY|gemini|google/i.test(outcome.error),
        '  with a public message naming no provider or variable',
        outcome.error ?? '(none)',
      );
      // The reason belongs in the log, not the response.
      check(
        /GEMINI_API_KEY is not set/.test(server.output()),
        '  while the server log states the actual reason',
      );
      return null;
    },
  );

  await withServer(PORT_A, { LLM_PROVIDER: 'wat-provider' }, async (server) => {
    const outcome = await ask(server.port, 'hello', 30_000);
    check(
      outcome.status === 500,
      'an unknown LLM_PROVIDER is a configuration error, not a fallback',
      `HTTP ${outcome.status}`,
    );
    check(
      outcome.error !== null && !/wat-provider/.test(outcome.error),
      '  and the public message does not echo the bad value',
      outcome.error ?? '(none)',
    );
    return null;
  });

  /**
   * A BLANK model, which is the same code path as an unset one.
   *
   * Truly unsetting it is not reachable from here and the reason is worth
   * recording: deleting the variable from the child's environment leaves
   * `.env.local` free to supply it at startup, and setting it to `''` is no
   * better — `@next/env` treats an empty string as absent and refills it from
   * the file. Whitespace survives both, and `getLlmProvider` trims before its
   * `if (!model)` guard, so this exercises exactly the branch an unset
   * variable would.
   */
  await withServer(PORT_A, { OLLAMA_MODEL: '   ' }, async (server) => {
    const outcome = await ask(server.port, 'hello', 30_000);
    check(
      outcome.status === 500,
      'a blank OLLAMA_MODEL errors rather than guessing a default',
      `HTTP ${outcome.status}`,
    );
    check(
      outcome.error !== null && !/llama/i.test(outcome.error),
      '  and the message names no model it might have fallen back to',
      outcome.error ?? '(none)',
    );
    return null;
  });

  // =========================================================================
  console.log('\n-- Seeding a frozen corpus ----------------------------------------');

  const supabaseUrl = process.env.SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supabaseUrl.length === 0 || serviceKey.length === 0) {
    block('Supabase is not configured', 'cannot seed the corpus');
    summary();
    return;
  }
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const fixtureDir = await mkdtemp(join(tmpdir(), 'aariz-l19-'));
  const documentIds: string[] = [];

  try {
    for (const [name, body] of Object.entries(FIXTURE)) {
      await writeFile(join(fixtureDir, name), body, 'utf8');
    }

    const ingested = await ingestPath(fixtureDir);
    for (const result of ingested) {
      if (result.documentId !== null) documentIds.push(result.documentId);
    }
    check(
      documentIds.length === Object.keys(FIXTURE).length,
      'the fixture corpus ingested',
      `${documentIds.length}/${Object.keys(FIXTURE).length} documents`,
    );
    if (documentIds.length === 0) {
      block('nothing ingested', ingested.map((r) => r.detail ?? r.outcome).join('; '));
      summary();
      return;
    }

    const countBefore = await db.from('documents').select('id', { head: true, count: 'exact' });
    const chunksBefore = await db.from('chunks').select('id', { head: true, count: 'exact' });

    // =======================================================================
    console.log('\n-- The switch itself: same question, two models -------------------');

    const runA = await withServer(PORT_A, { OLLAMA_MODEL: modelA }, async (server) => {
      const outcome = await ask(server.port, FIXTURE_QUESTION);
      return { outcome, model: loggedModel(server.output()) };
    });

    const runB = await withServer(PORT_B, { OLLAMA_MODEL: modelB }, async (server) => {
      const outcome = await ask(server.port, FIXTURE_QUESTION);
      return { outcome, model: loggedModel(server.output()) };
    });

    if (runA === null || runB === null) {
      block('one of the two model servers did not start');
    } else {
      check(runA.outcome.status === 200, `model A (${modelA}) answers`, `HTTP ${runA.outcome.status}`);
      check(runA.outcome.deltas > 0, '  and streams', `${runA.outcome.deltas} deltas`);
      check(runB.outcome.status === 200, `model B (${modelB}) answers`, `HTTP ${runB.outcome.status}`);
      check(runB.outcome.deltas > 0, '  and streams', `${runB.outcome.deltas} deltas`);

      check(
        runA.model === modelA,
        'the Level 18 log records model A',
        `${runA.model} (expected ${modelA})`,
      );
      check(
        runB.model === modelB,
        'the Level 18 log records model B',
        `${runB.model} (expected ${modelB})`,
      );
      check(
        runA.model !== runB.model,
        'the two runs really did use different models',
        `${runA.model} vs ${runB.model}`,
      );

      /**
       * The assertion Level 19 turns on.
       *
       * The chat model must have no influence whatsoever on retrieval: the
       * query embedding comes from a different model entirely, and the search
       * is pure SQL. Identical chunk ids in identical order, with identical
       * scores, is what "switching the model does not change the retrieval
       * pipeline" means concretely.
       */
      const idsA = runA.outcome.sources.map((source) => source.chunkId);
      const idsB = runB.outcome.sources.map((source) => source.chunkId);
      check(idsA.length > 0, 'retrieval returned chunks under model A', `${idsA.length}`);
      check(
        idsA.length === idsB.length && idsA.every((id, index) => id === idsB[index]),
        'RETRIEVAL IS IDENTICAL across the two models — same chunks, same order',
        `${idsA.length} vs ${idsB.length}`,
      );
      check(
        runA.outcome.sources.every(
          (source, index) =>
            Math.abs(source.similarity - (runB.outcome.sources[index]?.similarity ?? -1)) < 1e-9,
        ),
        '  and identical similarity scores',
      );
    }

    // =======================================================================
    console.log('\n-- Nothing else needed changing -----------------------------------');

    const countAfter = await db.from('documents').select('id', { head: true, count: 'exact' });
    const chunksAfter = await db.from('chunks').select('id', { head: true, count: 'exact' });
    check(
      countBefore.count === countAfter.count,
      'the document count is unchanged by switching models',
      `${countBefore.count} -> ${countAfter.count}`,
    );
    check(
      chunksBefore.count === chunksAfter.count,
      'the chunk count is unchanged — no re-embedding was required',
      `${chunksBefore.count} -> ${chunksAfter.count}`,
    );

    /**
     * A conversation started under one model and continued under another.
     *
     * This is the roadmap's "conversation system" requirement made concrete:
     * stored turns carry no model identity, so history written by model A is
     * read back and extended by model B with nothing migrated.
     */
    const crossModel = await withServer(PORT_A, { OLLAMA_MODEL: modelA }, async (server) => {
      const started = await fetch(`http://localhost:${server.port}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: FIXTURE_QUESTION }],
          startConversation: true,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      const cookie = (started.headers.getSetCookie?.() ?? [])
        .map((entry) => entry.split(';')[0])
        .join('; ');
      let conversationId: string | null = null;
      const text = await started.text();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { type: string; id?: string };
          if (event.type === 'conversation' && typeof event.id === 'string') conversationId = event.id;
        } catch {
          /* ignore */
        }
      }
      return { conversationId, cookie };
    });

    if (crossModel === null || crossModel.conversationId === null) {
      block('could not start a conversation under model A');
    } else {
      const continued = await withServer(PORT_B, { OLLAMA_MODEL: modelB }, async (server) => {
        const response = await fetch(`http://localhost:${server.port}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: crossModel.cookie },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'And what happens below 44.0?' }],
            conversationId: crossModel.conversationId,
          }),
          signal: AbortSignal.timeout(300_000),
        });
        const body = await response.text();
        return { status: response.status, deltas: (body.match(/"type":"delta"/g) ?? []).length };
      });

      if (continued === null) {
        block('the model B server did not start for the continuation');
      } else {
        check(
          continued.status === 200,
          'a conversation started under model A continues under model B',
          `HTTP ${continued.status}`,
        );
        check(continued.deltas > 0, '  and still streams', `${continued.deltas} deltas`);
      }

      // Remove exactly the conversation this suite created.
      await db.from('conversations').delete().eq('id', crossModel.conversationId);
    }
  } finally {
    console.log('\n-- Cleanup --------------------------------------------------------');
    let removed = 0;
    for (const id of documentIds) {
      const { error } = await db.from('documents').delete().eq('id', id);
      if (!error) removed++;
    }
    await rm(fixtureDir, { recursive: true, force: true });
    console.log(`   removed ${removed}/${documentIds.length} fixture document(s) and the temp directory`);

    const left = await db.from('documents').select('id', { head: true, count: 'exact' });
    console.log(`   documents remaining: ${left.count ?? 'unknown'}`);
  }
}

main()
  .then(summary)
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
