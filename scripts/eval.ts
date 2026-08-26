#!/usr/bin/env node
/**
 * Level 11 — evaluation harness.
 *
 * ROADMAP.md Level 11: "Stop relying on subjective testing." This measures the
 * real system — real Supabase, real Ollama, the real `/api/chat` route — against
 * a question set frozen before this file was written.
 *
 * Run:
 *   npm run eval                      full: retrieval + answers + latency
 *   npm run eval -- --retrieval-only  fast loop for retrieval changes
 *
 * WHAT IS MEASURED, AND OVER WHAT
 * -------------------------------
 *   retrieval hit rate  — the PRIMARY expected source appears in the top K.
 *                         Over the 26 answerable questions only; the four
 *                         missing-information questions have no correct source
 *                         by construction and are excluded rather than counted
 *                         as free wins.
 *   top-5 recall        — mean fraction of ALL expected sources present in the
 *                         top K. Differs from hit rate only for the questions
 *                         that genuinely span several documents.
 *   answer correctness  — deterministic matching, see the caveat below.
 *                         Over all 30: fact match for 26, refusal for 4.
 *   latency             — retrieval latency, and for the full run time to first
 *                         token and total time through the real API.
 *   failure rate        — over every answer request attempted: a non-200, an
 *                         error event mid-stream, a timeout, or an exception.
 *
 * THE CORRECTNESS METRIC IS A PROXY. READ THIS BEFORE QUOTING IT.
 * ---------------------------------------------------------------
 * Correctness is decided by normalised substring matching against expected
 * values, NOT by semantic judgement. An LLM judge was deliberately rejected:
 * Level 10 measured this hardware's model returning the identity permutation
 * on a ranking task and scoring a directly relevant passage 2 out of 10, so it
 * cannot credibly grade anything, least of all its own output.
 *
 * The consequence is a one-sided error. A correct answer phrased in a way the
 * matcher does not anticipate is scored WRONG; the matcher will not score a
 * wrong answer right unless it happens to contain the expected value. The
 * reported figure is therefore a LOWER BOUND on true correctness, and every
 * raw answer is written to the JSON report so the calls can be checked by hand.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { ingestPath } from '../src/lib/ingest/pipeline.ts';
import { getRerankConfig, retrieveReranked } from '../src/lib/rerank.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { loadEnvLocal } from './_env.ts';

// ---------------------------------------------------------------------------
// The frozen dataset
// ---------------------------------------------------------------------------

type MatchMode = 'all' | 'any' | 'refuse';

interface MatchRule {
  mode: MatchMode;
  /**
   * Alternative groups. Each inner array holds equivalent surface forms of one
   * required value ("85", "eighty-five"), so formatting differences are not
   * counted as wrong answers. `all` requires every group satisfied; `any`
   * requires one — which is how the ambiguous questions are scored, since more
   * than one reading of them is defensible.
   */
  groups: string[][];
}

interface EvalQuestion {
  id: string;
  kind:
    | 'direct_fact'
    | 'multiple_documents'
    | 'paraphrasing'
    | 'exact_terminology'
    | 'negative'
    | 'missing_information'
    | 'ambiguous';
  question: string;
  expected_fact: string | null;
  /** Corpus slugs. Primary first. Empty for missing-information questions. */
  expected_source: string[];
  expected_behavior: 'answer' | 'refuse';
  match: MatchRule;
}

const TOP_K = 5;
const ANSWER_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Deterministic matching
// ---------------------------------------------------------------------------

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[°º]/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phrases indicating the assistant declined for lack of information.
 *
 * Taken from the wording the system prompt actually instructs — "The provided
 * documents do not cover that." — plus the paraphrases a model reliably
 * produces around it. Chosen before the evaluation was run.
 */
const REFUSAL_MARKERS = [
  'do not cover',
  'does not cover',
  "don't cover",
  'not covered',
  'do not contain',
  'does not contain',
  "doesn't contain",
  'no documents',
  'not mention',
  'does not mention',
  'not specify',
  'does not specify',
  'no information',
  'not provide',
  'does not provide',
  'not available in',
  'not included in',
  'cannot find',
  'unable to find',
  'not found in',
  'do not have',
  'does not appear',
];

function isRefusal(answer: string): boolean {
  const hay = normalise(answer);
  return REFUSAL_MARKERS.some((marker) => hay.includes(marker));
}

function matchesExpectation(answer: string, rule: MatchRule): boolean {
  const hay = normalise(answer);
  if (rule.mode === 'refuse') return isRefusal(answer);

  const satisfied = (group: string[]): boolean =>
    group.some((value) => hay.includes(normalise(value)));

  return rule.mode === 'all' ? rule.groups.every(satisfied) : rule.groups.some(satisfied);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const ms = (value: number): string => `${Math.round(value)}ms`;

// ---------------------------------------------------------------------------
// Retrieval measurement
// ---------------------------------------------------------------------------

interface RetrievalOutcome {
  id: string;
  kind: string;
  hit: boolean;
  recall: number;
  rank: number;
  latencyMs: number;
  retrieved: string[];
}

async function measureRetrieval(
  questions: EvalQuestion[],
  idToSlug: Map<string, string>,
): Promise<RetrievalOutcome[]> {
  const outcomes: RetrievalOutcome[] = [];

  for (const q of questions) {
    const started = Date.now();
    const results = await retrieveReranked(q.question, { matchCount: TOP_K });
    const latencyMs = Date.now() - started;

    const retrieved = results.map((r) => idToSlug.get(r.documentId) ?? '(unknown)');
    const primary = q.expected_source[0];
    const rank = primary ? retrieved.indexOf(primary) + 1 : 0;
    const found = q.expected_source.filter((s) => retrieved.includes(s)).length;

    outcomes.push({
      id: q.id,
      kind: q.kind,
      hit: rank > 0,
      recall: q.expected_source.length === 0 ? 0 : found / q.expected_source.length,
      rank,
      latencyMs,
      retrieved,
    });
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// Answer measurement — through the real /api/chat route
// ---------------------------------------------------------------------------

interface AnswerOutcome {
  id: string;
  kind: string;
  question: string;
  expected_fact: string | null;
  expected_behavior: string;
  /** Preserved verbatim so every scoring decision can be checked by hand. */
  answer: string;
  correct: boolean;
  refused: boolean;
  failed: boolean;
  failure: string | null;
  citedSources: string[];
  firstTokenMs: number | null;
  totalMs: number;
}

async function askApi(
  baseUrl: string,
  question: string,
): Promise<{
  answer: string;
  sources: { documentId: string }[];
  firstTokenMs: number | null;
  totalMs: number;
  failure: string | null;
}> {
  const started = Date.now();
  let firstTokenMs: number | null = null;
  let answer = '';
  const sources: { documentId: string }[] = [];

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
  } catch (caught) {
    return {
      answer: '',
      sources: [],
      firstTokenMs: null,
      totalMs: Date.now() - started,
      failure: `request failed: ${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }

  if (!response.ok || !response.body) {
    return {
      answer: '',
      sources: [],
      firstTokenMs: null,
      totalMs: Date.now() - started,
      failure: `HTTP ${response.status}`,
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failure: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;

      let event: { type?: string; text?: string; message?: string; sources?: unknown };
      try {
        event = JSON.parse(line);
      } catch {
        failure ??= 'malformed NDJSON line';
        continue;
      }

      if (event.type === 'sources' && Array.isArray(event.sources)) {
        for (const raw of event.sources) {
          const source = raw as { documentId?: unknown };
          if (typeof source.documentId === 'string') sources.push({ documentId: source.documentId });
        }
      } else if (event.type === 'delta' && typeof event.text === 'string') {
        firstTokenMs ??= Date.now() - started;
        answer += event.text;
      } else if (event.type === 'error') {
        failure ??= `stream error: ${event.message ?? 'unknown'}`;
      }
    }
  }

  return { answer, sources, firstTokenMs, totalMs: Date.now() - started, failure };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvLocal();

  const retrievalOnly = process.argv.includes('--retrieval-only');
  const baseUrl = (process.env.EVAL_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const ollamaUrl = process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';

  console.log('\n=== Level 11 — evaluation ===\n');
  console.log(`  mode: ${retrievalOnly ? 'retrieval only' : 'full (retrieval + answers)'}`);

  // --- Preconditions. Fail loudly; never silently skip a measurement. ------
  if (!isSupabaseConfigured()) {
    console.error('\nFATAL: Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
    process.exitCode = 1;
    return;
  }

  try {
    const ping = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(5_000) });
    if (!ping.ok) throw new Error(String(ping.status));
  } catch {
    console.error(`\nFATAL: Ollama is not reachable at ${ollamaUrl}. Start it with "ollama serve".`);
    process.exitCode = 1;
    return;
  }

  if (!retrievalOnly) {
    // ROADMAP.md requires answer correctness, latency and failure rate to be
    // measured. Those need the real route. Skipping them quietly would leave
    // three of the five required metrics unreported while still printing a
    // result that looked complete.
    try {
      const ping = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5_000) });
      if (!ping.ok) throw new Error(String(ping.status));
    } catch {
      console.error(
        `\nFATAL: the application is not running at ${baseUrl}.\n` +
          '       Answer correctness, latency and failure rate are measured through the real\n' +
          '       /api/chat route and cannot be evaluated without it.\n\n' +
          '       Start it with "npm run dev", or run "npm run eval -- --retrieval-only".',
      );
      process.exitCode = 1;
      return;
    }
  }

  // --- Load the frozen dataset --------------------------------------------
  const questionsFile = resolve('evals/questions.jsonl');
  const raw = await readFile(questionsFile, 'utf8');
  const questions: EvalQuestion[] = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvalQuestion;
      } catch (caught) {
        throw new Error(`evals/questions.jsonl line ${index + 1} is not valid JSON: ${String(caught)}`);
      }
    });

  const answerable = questions.filter((q) => q.expected_behavior === 'answer');
  console.log(`  dataset: ${questions.length} questions (${answerable.length} answerable, ${questions.length - answerable.length} expecting refusal)`);

  const rerankConfig = getRerankConfig();
  console.log(`  reranking: ${rerankConfig.enabled ? `ENABLED (${rerankConfig.strategy})` : 'DISABLED'} — the configured setting is used for the headline numbers\n`);

  const client = getSupabaseAdminClient();
  const documentIds: string[] = [];
  const idToSlug = new Map<string, string>();
  const savedRerank = process.env.RERANK_ENABLED;

  try {
    // --- Seed the corpus through the real ingestion path -------------------
    console.log('-- Ingesting evaluation corpus -----------------------------------');
    const results = await ingestPath('evals/corpus');
    for (const result of results) {
      if (result.outcome !== 'ingested' || !result.documentId) {
        throw new Error(`Corpus ingestion failed for ${result.file}: ${result.detail ?? result.outcome}`);
      }
      documentIds.push(result.documentId);
      idToSlug.set(result.documentId, basename(result.file).replace(/\.md$/, ''));
    }
    const { count: chunkCount } = await client
      .from('chunks')
      .select('*', { count: 'exact', head: true });
    console.log(`   ${documentIds.length} documents, ${chunkCount ?? '?'} chunks\n`);

    // --- Retrieval, under the configured reranking setting -----------------
    console.log('-- Retrieval ------------------------------------------------------');
    const retrieval = await measureRetrieval(answerable, idToSlug);

    const hitRate = retrieval.filter((r) => r.hit).length / retrieval.length;
    const recall = mean(retrieval.map((r) => r.recall));
    const retrievalLatencies = retrieval.map((r) => r.latencyMs);

    console.log(`   retrieval hit rate   ${pct(hitRate)}   (${retrieval.filter((r) => r.hit).length}/${retrieval.length} primary source in top ${TOP_K})`);
    console.log(`   top-${TOP_K} recall        ${pct(recall)}   (mean fraction of all expected sources retrieved)`);
    console.log(`   retrieval latency    mean ${ms(mean(retrievalLatencies))}  p50 ${ms(percentile(retrievalLatencies, 50))}  p95 ${ms(percentile(retrievalLatencies, 95))}`);

    console.log('\n   by question kind:');
    const kinds = [...new Set(answerable.map((q) => q.kind))];
    for (const kind of kinds) {
      const subset = retrieval.filter((r) => r.kind === kind);
      console.log(
        `     ${kind.padEnd(20)} n=${String(subset.length).padStart(2)}  hit ${pct(subset.filter((s) => s.hit).length / subset.length).padStart(6)}  recall ${pct(mean(subset.map((s) => s.recall))).padStart(6)}`,
      );
    }

    const misses = retrieval.filter((r) => !r.hit);
    if (misses.length > 0) {
      console.log('\n   retrieval misses:');
      for (const miss of misses) {
        const q = answerable.find((x) => x.id === miss.id)!;
        console.log(`     ${miss.id} "${q.question.slice(0, 58)}"`);
        console.log(`        wanted [${q.expected_source.join(', ')}]  got [${miss.retrieved.join(', ')}]`);
      }
    }

    // --- Rerank OFF vs ON. Measurement only; nothing is tuned from it. -----
    console.log('\n-- Reranking comparison (measurement only, per Level 10) ----------');
    const comparison: Record<string, { hitRate: number; recall: number; meanLatency: number }> = {};
    for (const [label, value] of [['OFF', 'false'], ['ON', 'true']] as const) {
      process.env.RERANK_ENABLED = value;
      const run = await measureRetrieval(answerable, idToSlug);
      comparison[label] = {
        hitRate: run.filter((r) => r.hit).length / run.length,
        recall: mean(run.map((r) => r.recall)),
        meanLatency: mean(run.map((r) => r.latencyMs)),
      };
    }
    process.env.RERANK_ENABLED = savedRerank;

    console.log('   setting   hit rate   recall@5   mean latency');
    for (const label of ['OFF', 'ON'] as const) {
      const c = comparison[label]!;
      console.log(`   ${label.padEnd(9)} ${pct(c.hitRate).padStart(8)}   ${pct(c.recall).padStart(8)}   ${ms(c.meanLatency).padStart(12)}`);
    }
    const deltaHit = comparison['ON']!.hitRate - comparison['OFF']!.hitRate;
    const deltaRecall = comparison['ON']!.recall - comparison['OFF']!.recall;
    console.log(`   delta     ${(deltaHit >= 0 ? '+' : '') + pct(deltaHit)}   ${(deltaRecall >= 0 ? '+' : '') + pct(deltaRecall)}`);

    // --- Answers, through the real route -----------------------------------
    const answers: AnswerOutcome[] = [];
    if (!retrievalOnly) {
      console.log(`\n-- Answers (real /api/chat at ${baseUrl}) --------------------------`);
      console.log('   this runs a real local model once per question and is slow\n');

      for (const [index, q] of questions.entries()) {
        const result = await askApi(baseUrl, q.question);
        const failed = result.failure !== null;
        const correct = failed ? false : matchesExpectation(result.answer, q.match);

        answers.push({
          id: q.id,
          kind: q.kind,
          question: q.question,
          expected_fact: q.expected_fact,
          expected_behavior: q.expected_behavior,
          answer: result.answer,
          correct,
          refused: isRefusal(result.answer),
          failed,
          failure: result.failure,
          citedSources: result.sources.map((s) => idToSlug.get(s.documentId) ?? '(unknown)'),
          firstTokenMs: result.firstTokenMs,
          totalMs: result.totalMs,
        });

        const mark = failed ? 'FAIL' : correct ? ' ok ' : 'MISS';
        console.log(
          `   [${String(index + 1).padStart(2)}/${questions.length}] ${mark} ${q.id}  ${ms(result.totalMs).padStart(7)}  ${q.question.slice(0, 46)}`,
        );
      }
    }

    // --- Report -------------------------------------------------------------
    console.log(`\n${'='.repeat(72)}`);
    console.log('  RESULTS');
    console.log('='.repeat(72));
    console.log(`  retrieval hit rate       ${pct(hitRate)}`);
    console.log(`  top-${TOP_K} recall            ${pct(recall)}`);

    let correctness = 0;
    let failureRate = 0;
    if (!retrievalOnly && answers.length > 0) {
      correctness = answers.filter((a) => a.correct).length / answers.length;
      failureRate = answers.filter((a) => a.failed).length / answers.length;

      const firstTokens = answers.filter((a) => a.firstTokenMs !== null).map((a) => a.firstTokenMs!);
      const totals = answers.map((a) => a.totalMs);

      console.log(`  answer correctness       ${pct(correctness)}   (deterministic proxy — lower bound)`);
      console.log(`  failure rate             ${pct(failureRate)}   (${answers.filter((a) => a.failed).length}/${answers.length} requests)`);
      console.log(`  time to first token      mean ${ms(mean(firstTokens))}  p50 ${ms(percentile(firstTokens, 50))}  p95 ${ms(percentile(firstTokens, 95))}`);
      console.log(`  total answer latency     mean ${ms(mean(totals))}  p50 ${ms(percentile(totals, 50))}  p95 ${ms(percentile(totals, 95))}`);

      const refusalQs = answers.filter((a) => a.expected_behavior === 'refuse');
      console.log(
        `\n  refusal behaviour        ${refusalQs.filter((a) => a.correct).length}/${refusalQs.length} missing-information questions correctly declined`,
      );
      const overRefused = answers.filter((a) => a.expected_behavior === 'answer' && a.refused);
      console.log(`  over-refusal             ${overRefused.length}/${answers.length - refusalQs.length} answerable questions were declined`);
    } else {
      console.log('  answer correctness       not measured (--retrieval-only)');
      console.log('  latency / failure rate   not measured (--retrieval-only)');
    }

    console.log(`\n  ROADMAP target: >85% retrieval hit rate`);
    console.log(
      `  actual:         ${pct(hitRate)}  ->  ${hitRate > 0.85 ? 'TARGET MET' : 'BELOW TARGET (reported as measured)'}`,
    );

    const reportDir = resolve('evals/reports');
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode: retrievalOnly ? 'retrieval-only' : 'full',
          config: {
            topK: TOP_K,
            rerank: rerankConfig,
            matchCount: process.env.MATCH_COUNT ?? null,
            similarityThreshold: process.env.SIMILARITY_THRESHOLD ?? null,
            model: process.env.OLLAMA_MODEL ?? null,
            embedModel: process.env.OLLAMA_EMBED_MODEL ?? null,
          },
          metrics: {
            retrievalHitRate: hitRate,
            topKRecall: recall,
            answerCorrectness: retrievalOnly ? null : correctness,
            failureRate: retrievalOnly ? null : failureRate,
            retrievalLatencyMs: {
              mean: mean(retrievalLatencies),
              p50: percentile(retrievalLatencies, 50),
              p95: percentile(retrievalLatencies, 95),
            },
          },
          rerankComparison: comparison,
          correctnessCaveat:
            'Deterministic substring matching, not semantic judgement. A correct answer phrased unexpectedly is scored wrong, so this is a lower bound. Raw answers are preserved below for manual inspection.',
          retrieval,
          answers,
        },
        null,
        2,
      ),
      'utf8',
    );
    console.log(`\n  full report with every raw answer: ${reportPath}`);
  } finally {
    process.env.RERANK_ENABLED = savedRerank;

    console.log('\n-- Cleanup --------------------------------------------------------');
    for (const id of documentIds) {
      await client.from('documents').delete().eq('id', id);
    }
    const { count: docs } = await client.from('documents').select('*', { count: 'exact', head: true });
    const { count: chunks } = await client.from('chunks').select('*', { count: 'exact', head: true });
    console.log(`   documents=${docs}  chunks=${chunks}`);
    if (docs !== 0 || chunks !== 0) {
      console.error('   WARNING: evaluation data was not fully removed.');
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error('\nEvaluation crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
