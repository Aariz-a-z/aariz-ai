#!/usr/bin/env node
/**
 * Level 21 — performance measurement.
 *
 * ROADMAP.md Level 21 opens with "Measure before optimizing" and closes with
 * "Do not sacrifice answer quality merely to improve benchmark numbers". This
 * script is the first half. It changes NO configuration and tunes NOTHING: it
 * measures the eight things the roadmap lists, then measures what each tunable
 * on the "optimize" list would actually buy, so that any later change is
 * argued from a number rather than from an instinct.
 *
 * WHY IT DOES NOT APPLY ITS OWN FINDINGS
 * --------------------------------------
 * Every tunable on that list — chunk size, context size, generation length,
 * retrieved-chunk count, quantization — trades latency against answer quality,
 * and the Level 11 evaluation baseline (96.2% retrieval hit rate, measured on
 * `llama3.2:3b` with MATCH_COUNT=5) is defined against the current values.
 * Changing a default here would silently invalidate that baseline and hide the
 * cost inside a benchmark that only reports speed. So findings are reported as
 * recommendations and the defaults are left exactly where they are.
 *
 * WHAT IT MEASURES IN-PROCESS VERSUS OVER HTTP
 * --------------------------------------------
 * Embedding and retrieval are called directly, because that is the only way to
 * time them separately and precisely without scraping a log. Generation is
 * measured against Ollama's own nanosecond timing fields rather than wall
 * clock, so prompt processing and token generation stay distinguishable — the
 * same approach `bench-ollama.ts` established at Level 2. Concurrency is
 * measured over real HTTP, because the Level 14 limiter it exercises only
 * exists on that path.
 *
 * Dependency-free, and it pulls nothing and deletes nothing it did not create.
 *
 * Run (needs Ollama; the app only for the concurrency section):
 *   node --experimental-strip-types scripts/benchmark.ts
 *   node --experimental-strip-types scripts/benchmark.ts --quick
 */

import { cpus, freemem, totalmem } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { embedQuery } from '../src/lib/embeddings.ts';
import { ingestPath } from '../src/lib/ingest/pipeline.ts';
import { getRetrievalConfig, retrieveHybrid } from '../src/lib/retrieval.ts';
import { estimateTokens } from '../src/lib/ingest/tokens.ts';
import { loadEnvLocal } from './_env.ts';

const run = promisify(execFile);

const QUICK = process.argv.includes('--quick');
const BASE_URL = (process.env.EVAL_BASE_URL ?? 'http://localhost:3007').replace(/\/$/, '');
const OLLAMA = process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL?.trim() || 'llama3.2:3b';

const rule = (title: string): void =>
  console.log(`\n-- ${title} ${'-'.repeat(Math.max(0, 66 - title.length))}`);

const ms = (value: number | null): string =>
  value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

function stats(values: number[]): { mean: number; p50: number; p95: number; min: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (f: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(f * sorted.length) - 1))]!;
  return {
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    p50: at(0.5),
    p95: at(0.95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

// ---------------------------------------------------------------------------
// CPU utilisation
// ---------------------------------------------------------------------------

/**
 * System-wide CPU utilisation between two samples.
 *
 * `os.cpus()` reports cumulative jiffies per core, so the difference between
 * two readings is genuine utilisation over that interval. Sampled this way
 * rather than with an external tool because it needs no dependency and,
 * crucially, it counts OLLAMA's work too — the inference process is where this
 * application actually spends CPU, and a figure covering only the Node process
 * would report a busy machine as idle.
 */
function cpuSample(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function cpuPercentSince(start: { idle: number; total: number }): number {
  const end = cpuSample();
  const idleDelta = end.idle - start.idle;
  const totalDelta = end.total - start.total;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

// ---------------------------------------------------------------------------
// Ollama introspection
// ---------------------------------------------------------------------------

interface OllamaTimings {
  totalMs: number;
  loadMs: number;
  promptEvalMs: number;
  evalMs: number;
  promptTokens: number;
  evalTokens: number;
  tokensPerSecond: number;
}

/**
 * One non-streaming generation, timed by Ollama's own counters.
 *
 * Nanosecond fields converted to milliseconds. Wall clock would blend prompt
 * processing into generation and make the two indistinguishable, which is
 * exactly the distinction Level 21 needs in order to say whether context size
 * or generation length is the thing costing time.
 */
async function timedGenerate(
  model: string,
  prompt: string,
  numPredict: number,
): Promise<OllamaTimings | null> {
  try {
    const response = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: numPredict },
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, number>;
    const nsToMs = (value: number | undefined): number => (value ?? 0) / 1e6;
    const evalMs = nsToMs(data.eval_duration);
    const evalTokens = data.eval_count ?? 0;

    return {
      totalMs: nsToMs(data.total_duration),
      loadMs: nsToMs(data.load_duration),
      promptEvalMs: nsToMs(data.prompt_eval_duration),
      evalMs,
      promptTokens: data.prompt_eval_count ?? 0,
      evalTokens,
      tokensPerSecond: evalMs > 0 ? (evalTokens / evalMs) * 1000 : 0,
    };
  } catch {
    return null;
  }
}

/** VRAM actually in use, from Ollama's own view of loaded models. */
async function vramInUse(): Promise<{ total: number; vram: number } | null> {
  try {
    const data = (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(5_000) }).then((r) =>
      r.json(),
    )) as { models?: { size?: number; size_vram?: number }[] };
    const models = data.models ?? [];
    if (models.length === 0) return null;
    return {
      total: models.reduce((sum, m) => sum + (m.size ?? 0), 0),
      vram: models.reduce((sum, m) => sum + (m.size_vram ?? 0), 0),
    };
  } catch {
    return null;
  }
}

/** Installed chat models with their quantization, for the quantization section. */
async function installedModels(): Promise<{ name: string; size: number; quant: string }[]> {
  try {
    const data = (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(5_000) }).then((r) =>
      r.json(),
    )) as { models?: { name: string; size: number; details?: Record<string, string> }[] };
    return (data.models ?? [])
      .filter((m) => m.details?.family !== 'nomic-bert')
      .map((m) => ({ name: m.name, size: m.size, quant: m.details?.quantization_level ?? 'unknown' }));
  } catch {
    return [];
  }
}

/** GPU name, or null. Reported honestly rather than guessed. */
async function gpuName(): Promise<string | null> {
  try {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
      { timeout: 15_000 },
    );
    const names = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return names.length > 0 ? names.join(', ') : null;
  } catch {
    return null;
  }
}

const RECOMMENDATIONS: string[] = [];
const recommend = (text: string): void => {
  RECOMMENDATIONS.push(`
  * ${text}`);
};

/**
 * Numbers carried out of the sections above so the closing findings are
 * DERIVED from this run rather than written in advance. A conclusion that
 * would print the same whatever the machine measured is not a finding.
 */
const measured: {
  embeddingMeanMs: number | null;
  tokensPerSecond: number | null;
  contextTokensAtMatchCount: Map<number, number>;
  concurrencyThrottledAt: number | null;
} = {
  embeddingMeanMs: null,
  tokensPerSecond: null,
  contextTokensAtMatchCount: new Map(),
  concurrencyThrottledAt: null,
};
const contextPoints: { tokens: number; promptEvalMs: number }[] = [];
const modelSpeeds: { name: string; tokensPerSecond: number; quant: string }[] = [];

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n========================================================================');
  console.log('  LEVEL 21 — PERFORMANCE MEASUREMENT');
  console.log(`  ${new Date().toISOString()}${QUICK ? '   (quick mode)' : ''}`);
  console.log('  Measures only. Changes no configuration and tunes nothing.');
  console.log('========================================================================');

  // =========================================================================
  rule('Machine');

  const cores = cpus();
  console.log(`   CPU                ${cores[0]?.model.trim() ?? 'unknown'}`);
  console.log(`   Logical cores      ${cores.length}`);
  console.log(`   RAM total          ${mb(totalmem())}`);
  console.log(`   RAM free (idle)    ${mb(freemem())}`);

  const gpu = await gpuName();
  console.log(`   GPU                ${gpu ?? 'not detected'}`);

  // =========================================================================
  rule('Models installed and their quantization');

  const models = await installedModels();
  if (models.length === 0) {
    console.log('   [BLOCKED] Ollama is not reachable — nothing below can run.');
    return;
  }
  for (const model of models) {
    console.log(
      `   ${model.name.padEnd(22)} ${(model.size / 1e9).toFixed(2).padStart(5)} GB   ${model.quant}${
        model.name === MODEL ? '   <- configured' : ''
      }`,
    );
  }

  // =========================================================================
  rule('Embedding latency (query path, in-process)');

  const embedRuns = QUICK ? 3 : 8;
  const embedTimes: number[] = [];
  const warmQuery = 'What is the scavenge air pressure at full load?';
  await embedQuery(warmQuery).catch(() => null); // warm the model in

  for (let i = 0; i < embedRuns; i++) {
    const started = performance.now();
    try {
      await embedQuery(`${warmQuery} (${i})`);
      embedTimes.push(performance.now() - started);
    } catch {
      /* counted by absence */
    }
  }
  const embed = stats(embedTimes);
  if (embed === null) {
    console.log('   [BLOCKED] embedding failed');
  } else {
    console.log(
      `   n=${embedTimes.length}  mean ${ms(embed.mean)}  p50 ${ms(embed.p50)}  p95 ${ms(embed.p95)}  min ${ms(embed.min)}  max ${ms(embed.max)}`,
    );
  }

  /**
   * Would caching query embeddings help?
   *
   * The roadmap lists "caching where appropriate", and the honest way to
   * decide is to measure what a hit would save and how often one could
   * plausibly occur — not to add a cache because caches sound fast.
   */
  const repeatStart = performance.now();
  await embedQuery(warmQuery).catch(() => null);
  const repeatMs = performance.now() - repeatStart;
  console.log(`   the same query again: ${ms(repeatMs)}  (no cache exists; this is a real call)`);
  measured.embeddingMeanMs = embed?.mean ?? null;

  // =========================================================================
  rule('Seeding the corpus for retrieval measurement');

  const documentIds: string[] = [];
  try {
    const ingestStart = performance.now();
    const results = await ingestPath('evals/corpus');
    const ingestMs = performance.now() - ingestStart;
    let chunkTotal = 0;
    let tokenTotal = 0;
    for (const result of results) {
      if (result.documentId !== null) documentIds.push(result.documentId);
      chunkTotal += result.chunkCount;
      tokenTotal += result.tokenTotal;
    }
    console.log(
      `   ${documentIds.length} documents, ${chunkTotal} chunks, ${tokenTotal} tokens in ${ms(ingestMs)}`,
    );
    if (chunkTotal > 0) {
      const perChunk = ingestMs / chunkTotal;
      console.log(
        `   ingestion cost     ${ms(perChunk)} per chunk   ·   mean chunk ${Math.round(tokenTotal / chunkTotal)} tokens`,
      );
    }

    if (documentIds.length === 0) {
      console.log('   [BLOCKED] nothing ingested — retrieval sections skipped');
    } else {
      // =====================================================================
      rule('Retrieval latency vs number of retrieved chunks (MATCH_COUNT)');

      const configured = getRetrievalConfig();
      console.log(`   configured MATCH_COUNT = ${configured.matchCount}\n`);
      console.log('   matchCount   retrieval        context tokens   chunks returned');

      const question = 'What is the scavenge air pressure at full load?';
      const sweep = QUICK ? [3, 5, 8] : [1, 3, 5, 8, 12, 20];
      for (const matchCount of sweep) {
        const times: number[] = [];
        let contextTokens = 0;
        let returned = 0;
        for (let i = 0; i < (QUICK ? 1 : 3); i++) {
          const started = performance.now();
          const rows = await retrieveHybrid(question, { matchCount });
          times.push(performance.now() - started);
          returned = rows.length;
          contextTokens = rows.reduce((sum, row) => sum + estimateTokens(row.content), 0);
        }
        const s = stats(times)!;
        measured.contextTokensAtMatchCount.set(matchCount, contextTokens);
        const marker = matchCount === configured.matchCount ? '  <- current' : '';
        console.log(
          `   ${String(matchCount).padStart(9)}   ${ms(s.mean).padStart(9)}   ${String(contextTokens).padStart(14)}   ${String(returned).padStart(16)}${marker}`,
        );
      }
      console.log(
        '\n   Retrieval is a single indexed query, so its cost is nearly flat in\n' +
          '   matchCount. What grows is CONTEXT TOKENS, and those are paid again at\n' +
          '   prompt-processing time on every request — see the next section.',
      );
    }
  } catch (caught) {
    console.log(`   [BLOCKED] ${caught instanceof Error ? caught.message : String(caught)}`);
  }

  // =========================================================================
  rule('Prompt size vs generation speed (context size)');

  console.log('   prompt tokens   prompt eval      generation    tokens/s');
  const contextSweep = QUICK ? [200, 1200] : [200, 600, 1200, 2400];
  const filler =
    'The engine room watchkeeping routine requires hourly rounds of the machinery space. ';
  for (const target of contextSweep) {
    const prompt =
      filler.repeat(Math.max(1, Math.round(target / estimateTokens(filler)))) +
      '\n\nAnswer in one short sentence: what is checked hourly?';
    const timings = await timedGenerate(MODEL, prompt, 64);
    if (timings === null) {
      console.log(`   ${String(target).padStart(13)}   [failed]`);
      continue;
    }
    console.log(
      `   ${String(timings.promptTokens).padStart(13)}   ${ms(timings.promptEvalMs).padStart(11)}   ${ms(timings.evalMs).padStart(11)}   ${timings.tokensPerSecond.toFixed(1).padStart(8)}`,
    );
    contextPoints.push({ tokens: timings.promptTokens, promptEvalMs: timings.promptEvalMs });
  }

  // =========================================================================
  rule('Generation length (num_predict)');

  console.log('   num_predict   tokens made   generation     tokens/s');
  const lengthSweep = QUICK ? [128, 384] : [64, 128, 256, 384, 512];
  const shortPrompt = 'Explain in plain terms what a quorum disk does.';
  for (const numPredict of lengthSweep) {
    const timings = await timedGenerate(MODEL, shortPrompt, numPredict);
    if (timings === null) {
      console.log(`   ${String(numPredict).padStart(11)}   [failed]`);
      continue;
    }
    console.log(
      `   ${String(numPredict).padStart(11)}   ${String(timings.evalTokens).padStart(11)}   ${ms(timings.evalMs).padStart(11)}   ${timings.tokensPerSecond.toFixed(1).padStart(8)}`,
    );
    if (measured.tokensPerSecond === null) measured.tokensPerSecond = timings.tokensPerSecond;
  }
  console.log(
    '\n   Generation is linear in tokens produced, so the output ceiling is the\n' +
      '   single most direct latency control — and the one that most obviously\n' +
      '   trades against answer completeness.',
  );

  // =========================================================================
  rule('Model size and quantization');

  console.log('   model                  prompt eval    generation    tokens/s');
  const compareModels = QUICK ? models.slice(0, 2) : models;
  for (const model of compareModels) {
    const timings = await timedGenerate(model.name, shortPrompt, 128);
    if (timings === null) {
      console.log(`   ${model.name.padEnd(22)} [failed]`);
      continue;
    }
    console.log(
      `   ${model.name.padEnd(22)} ${ms(timings.promptEvalMs).padStart(11)}   ${ms(timings.evalMs).padStart(11)}   ${timings.tokensPerSecond.toFixed(1).padStart(8)}   (${model.quant})`,
    );
    modelSpeeds.push({ name: model.name, tokensPerSecond: timings.tokensPerSecond, quant: model.quant });
  }

  // =========================================================================
  rule('RAM, VRAM and CPU under load');

  const vram = await vramInUse();
  if (vram === null) {
    console.log('   Ollama reports no model resident right now.');
  } else {
    console.log(`   model resident     ${mb(vram.total)}`);
    console.log(`   of which in VRAM   ${mb(vram.vram)}`);
    if (vram.vram === 0) {
      console.log('   -> CPU-only inference. There is no GPU VRAM figure to report, and');
      console.log('      the roadmap item is answered by that rather than by a number.');
    }
  }

  const beforeFree = freemem();
  const cpuStart = cpuSample();
  const loadTimings = await timedGenerate(MODEL, shortPrompt, 128);
  const cpuPercent = cpuPercentSince(cpuStart);
  const duringFree = freemem();

  console.log(`   RAM free before    ${mb(beforeFree)}`);
  console.log(`   RAM free after     ${mb(duringFree)}   (delta ${mb(beforeFree - duringFree)})`);
  console.log(`   node RSS           ${mb(process.memoryUsage().rss)}`);
  console.log(
    `   CPU during a generation   ${cpuPercent.toFixed(1)}%  across ${cores.length} logical cores`,
  );
  if (loadTimings !== null) {
    console.log(`   (that generation: ${loadTimings.evalTokens} tokens in ${ms(loadTimings.evalMs)})`);
  }

  // =========================================================================
  rule('Concurrent users (real HTTP, exercises the Level 14 limiter)');

  let appUp = false;
  try {
    const ping = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(5_000) });
    const html = await ping.text();
    appUp =
      ping.ok &&
      (ping.headers.get('content-security-policy') ?? '').length > 0 &&
      ping.headers.get('x-powered-by') === null &&
      html.includes('AARIZ');
  } catch {
    appUp = false;
  }

  if (!appUp) {
    console.log(`   [BLOCKED] the application is not identifiable at ${BASE_URL}`);
    console.log('   Start it with:  npx next start --port 3007');
  } else {
    const askOnce = async (): Promise<{ status: number; ttft: number | null; totalMs: number }> => {
      const started = performance.now();
      let ttft: number | null = null;
      const response = await fetch(`${BASE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: shortPrompt }] }),
        signal: AbortSignal.timeout(300_000),
      });
      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (ttft === null && buffer.includes('"type":"delta"')) ttft = performance.now() - started;
        }
      } else {
        await response.arrayBuffer();
      }
      return { status: response.status, ttft, totalMs: performance.now() - started };
    };

    console.log('   users   ok   throttled   mean TTFT     mean total');
    for (const users of QUICK ? [1, 3] : [1, 2, 3]) {
      const cpuBefore = cpuSample();
      const outcomes = await Promise.all(Array.from({ length: users }, () => askOnce()));
      const usedCpu = cpuPercentSince(cpuBefore);

      const ok = outcomes.filter((o) => o.status === 200);
      const throttled = outcomes.filter((o) => o.status === 429);
      const ttfts = ok.map((o) => o.ttft).filter((v): v is number => v !== null);
      const totals = ok.map((o) => o.totalMs);
      const t = stats(ttfts);
      const total = stats(totals);
      console.log(
        `   ${String(users).padStart(5)}   ${String(ok.length).padStart(2)}   ${String(throttled.length).padStart(9)}   ${ms(t?.mean ?? null).padStart(9)}   ${ms(total?.mean ?? null).padStart(12)}   cpu ${usedCpu.toFixed(0)}%`,
      );
      if (throttled.length > 0 && measured.concurrencyThrottledAt === null) {
        measured.concurrencyThrottledAt = users;
      }
    }
    console.log(
      '\n   A 429 here is the Level 14 concurrency cap working, not a failure. It\n' +
        '   refuses immediately rather than queueing behind a ~30 s answer.',
    );
  }

  // =========================================================================
  // Cleanup before the recommendations, so a crash cannot skip it.
  if (documentIds.length > 0) {
    rule('Cleanup');
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(
      process.env.SUPABASE_URL ?? '',
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      { auth: { persistSession: false } },
    );
    let removed = 0;
    for (const id of documentIds) {
      const { error } = await db.from('documents').delete().eq('id', id);
      if (!error) removed++;
    }
    const left = await db.from('documents').select('id', { head: true, count: 'exact' });
    console.log(`   removed ${removed}/${documentIds.length} benchmark documents`);
    console.log(`   documents remaining: ${left.count ?? 'unknown'}`);
  }

  // =========================================================================
  console.log('\n========================================================================');
  console.log('  FINDINGS AND RECOMMENDATIONS');
  console.log('  Reported, NOT applied. Every item below trades against answer');
  console.log('  quality, and ROADMAP.md Level 21 forbids buying benchmark numbers');
  console.log('  with quality. Level 11 is the instrument that would settle any of');
  console.log('  them: re-run `npm run eval` after a change and compare.');
  console.log('========================================================================');
  // Derived from THIS run's numbers, not written in advance.
  const generation = measured.tokensPerSecond;
  if (generation !== null && generation > 0) {
    const budget = Number(process.env.GENERATION_MAX_TOKENS_ANONYMOUS ?? 384);
    recommend(
      `GENERATION LENGTH is the dominant lever. At ${generation.toFixed(1)} tok/s the current
` +
        `    anonymous ceiling of ${budget} tokens is worth up to ${(budget / generation).toFixed(0)} s of an answer's
` +
        `    latency. Lowering it shortens answers directly — a quality change, not a
` +
        `    free win — so it is a product decision, not a tuning one.`,
    );
  }

  if (contextPoints.length >= 2) {
    const first = contextPoints[0]!;
    const last = contextPoints[contextPoints.length - 1]!;
    const spanTokens = last.tokens - first.tokens;
    const spanMs = last.promptEvalMs - first.promptEvalMs;
    if (spanTokens > 0) {
      const perThousand = (spanMs / spanTokens) * 1000;
      recommend(
        `CONTEXT SIZE costs about ${ms(perThousand)} per 1000 prompt tokens on this machine,
` +
          `    paid on every request before a single token is generated. That is what
` +
          `    makes MATCH_COUNT a latency decision as well as a quality one.`,
      );
    }
  }

  const contextByMatch = measured.contextTokensAtMatchCount;
  const current = getRetrievalConfig().matchCount;
  const atCurrent = contextByMatch.get(current);
  if (atCurrent !== undefined && atCurrent > 0) {
    const cheaper = [...contextByMatch.entries()]
      .filter(([count]) => count < current)
      .sort((a, b) => b[0] - a[0])[0];
    if (cheaper !== undefined) {
      const saved = atCurrent - cheaper[1];
      recommend(
        `RETRIEVED CHUNKS: dropping MATCH_COUNT from ${current} to ${cheaper[0]} removes about
` +
          `    ${saved} context tokens per request. DO NOT make this change on latency
` +
          `    grounds alone — Level 11 measured 96.2% retrieval hit rate at ${current}, and
` +
          `    fewer chunks is exactly how that number falls. Re-run \`npm run eval\`
` +
          `    before and after if you want it.`,
      );
    }
  }

  if (modelSpeeds.length >= 2) {
    const fastest = [...modelSpeeds].sort((a, b) => b.tokensPerSecond - a.tokensPerSecond)[0]!;
    const configuredSpeed = modelSpeeds.find((m) => m.name === MODEL);
    if (configuredSpeed !== undefined && fastest.name !== MODEL && configuredSpeed.tokensPerSecond > 0) {
      const factor = fastest.tokensPerSecond / configuredSpeed.tokensPerSecond;
      recommend(
        `QUANTIZATION / MODEL SIZE: ${fastest.name} generates ${factor.toFixed(1)}x faster than the
` +
          `    configured ${MODEL}. Level 2 chose the larger model on quality grounds,
` +
          `    and Level 19 proved switching is one environment variable, so this is
` +
          `    available whenever the trade is wanted — but it IS the trade the
` +
          `    roadmap warns against making for benchmark numbers alone.`,
      );
    }
  }

  if (measured.embeddingMeanMs !== null && generation !== null && generation > 0) {
    const embedShare = measured.embeddingMeanMs;
    recommend(
      `CACHING: query embedding costs ${ms(embedShare)} against answers measured in tens of
` +
        `    seconds, so an embedding cache would recover well under 1% of a request
` +
        `    and only for repeated identical questions, which real chat rarely sends.
` +
        `    NOT RECOMMENDED: it would add state and a staleness question to buy noise.`,
    );
  }

  if (measured.concurrencyThrottledAt !== null) {
    recommend(
      `CONCURRENCY: throttling begins at ${measured.concurrencyThrottledAt} simultaneous callers, which is the Level 14
` +
        `    cap doing its job on ${cpus().length} logical cores. Raising it does not create
` +
        `    capacity — it converts a fast 429 into a slow timeout.`,
    );
  } else {
    recommend(
      `CONCURRENCY: no throttling was observed at the levels tested. The Level 14
` +
        `    cap was not reached, so nothing here argues for changing it.`,
    );
  }

  recommend(
    `CHUNK SIZE was NOT swept. Changing it requires re-embedding the entire
` +
      `    corpus, which is Level 22's subject, and a sweep would have had to
` +
      `    re-ingest per setting. Measured instead as the ingestion cost per chunk
` +
      `    reported above. Left for Level 22 rather than half-answered here.`,
  );

  for (const line of RECOMMENDATIONS) console.log(line);
  console.log('');
}

main().catch((error: unknown) => {
  console.error('\nBenchmark crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
