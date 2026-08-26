/**
 * Level 18 — in-process request metrics.
 *
 * ROADMAP.md Level 18 asks the `/admin` dashboard to show failed requests,
 * average latency, retrieval failures and unanswered questions. None of those
 * exist in the database: they are properties of a request as it happens, not
 * rows anybody stores. This is where they are counted.
 *
 * IN-MEMORY, AND WHAT THAT COSTS
 * ------------------------------
 * The same trade Level 14 made for rate limiting, made again for the same
 * reasons and with the same honesty:
 *
 *   1. Metrics RESET WHEN THE SERVER RESTARTS. The dashboard shows this
 *      process's lifetime, not the application's history.
 *   2. They DO NOT COORDINATE ACROSS INSTANCES. Two processes behind a load
 *      balancer each report their own share.
 *
 * The alternative was a metrics table, which would mean a database write on
 * every chat turn — real latency on a request that already occupies the only
 * two cores this machine has — plus a migration and a retention policy for a
 * table that grows forever. On a single-process deployment beside a single
 * Ollama, that buys nothing this does not already provide.
 *
 * BOUNDED, ALWAYS
 * ---------------
 * The sample buffer is a fixed-size ring. It cannot grow, so a long-running
 * server cannot turn its own monitoring into a memory leak — the failure mode
 * the Level 14 bucket sweep exists to prevent, avoided here by construction
 * rather than by cleanup.
 *
 * NUMBERS AND METADATA ONLY
 * -------------------------
 * There is deliberately NO question text, answer text, prompt, embedding, IP
 * address, email or session id in this module, and no field that could carry
 * one. An admin dashboard is a place user content leaks to, so the data simply
 * is not collected. "Unanswered questions" is a COUNT; the questions
 * themselves are never retained.
 */

/**
 * How a request ended. Drives the failed / unanswered counters.
 *
 * `aborted` exists so that a user pressing Stop is not counted as a failure.
 * Conflating the two would make the dashboard's failure rate climb every time
 * the Stop button worked, which is the opposite of what it is for.
 *
 * Requests refused by Level 14 rate limiting, Level 16 origin checks or Level
 * 17 widget validation are not recorded at all: those are protections
 * succeeding, and counting them as failures would make the dashboard alarming
 * precisely when the application is defending itself correctly.
 */
export type RequestOutcome =
  /** Answered normally. */
  | 'ok'
  /** Answered, but the model declined for lack of grounding. */
  | 'refused'
  /** Did not produce an answer. */
  | 'error'
  /** The caller disconnected or pressed Stop. Not a failure. */
  | 'aborted';

/**
 * One request, as numbers.
 *
 * Every field is a number, a boolean, or a fixed enum. Nothing here can hold
 * user content even by accident.
 */
export interface RequestSample {
  /** Epoch milliseconds, for windowed rates. */
  at: number;
  outcome: RequestOutcome;
  /** Wall clock for the whole request. */
  totalMs: number;
  /** Query embedding only. Null when retrieval never ran. */
  embeddingMs: number | null;
  /** Database search only, embedding excluded. Null when retrieval never ran. */
  searchMs: number | null;
  /** First token to last token. Null when generation never started. */
  generationMs: number | null;
  /** Chunks that survived retrieval and grounding. */
  chunks: number;
  promptTokens: number;
  completionTokens: number;
  /** True when retrieval itself threw, as opposed to returning nothing. */
  retrievalFailed: boolean;
  /** True when the request came from the Level 17 embedded widget. */
  widget: boolean;
  /**
   * In-flight requests at the moment this one took its concurrency slot,
   * itself included.
   *
   * Read in the route with `concurrencySnapshot()` and carried here, because
   * the Level 14 counters live in the route's bundle and the dashboard cannot
   * see them directly. A peak is more useful than an instantaneous gauge
   * anyway: the question an operator has is "did we ever saturate", and a page
   * load between two requests would always answer "idle".
   */
  concurrent: number;
}

/**
 * Ring capacity.
 *
 * 500 requests at roughly 100 bytes each is around 50 KB — irrelevant next to
 * a 3B model, and enough history to make an average mean something on a
 * machine that answers about two requests a minute.
 */
const MAX_SAMPLES = 500;

/**
 * THE STORE IS PINNED TO `globalThis`, AND IT HAS TO BE.
 *
 * Module-level `let` does not work here, and this was measured rather than
 * guessed. Next.js compiles route handlers and server-component pages into
 * SEPARATE server bundles, so `src/lib/metrics.ts` is instantiated twice: once
 * in the bundle containing `app/api/chat/route.ts`, which writes, and once in
 * the bundle containing `app/admin/page.tsx`, which reads. With plain module
 * state the writer incremented its own copy and the dashboard read a
 * permanently empty one — four real chats produced four complete
 * `chat.completed` log lines and a dashboard still showing zero requests.
 *
 * `globalThis` is one object per Node process, so both bundles reach the same
 * store. This is the same idiom Next's own documentation uses for a database
 * client that must survive bundling and hot reload.
 *
 * Level 14's rate limiter does NOT need this and is deliberately left alone:
 * its state is only ever read and written by route handlers, which share a
 * bundle, so it has always been consistent with itself.
 */
interface MetricsStore {
  samples: RequestSample[];
  totalRequests: number;
  failedRequests: number;
  refusedRequests: number;
  retrievalFailures: number;
  /** Requests that produced an answer at all — the denominator for refusal rate. */
  answeredTotal: number;
  /** Highest number of simultaneous in-flight requests this process has seen. */
  peakConcurrent: number;
  startedAt: string;
}

const STORE_KEY = Symbol.for('aariz.metrics.store');

function emptyStore(): MetricsStore {
  return {
    samples: [],
    totalRequests: 0,
    failedRequests: 0,
    refusedRequests: 0,
    retrievalFailures: 0,
    answeredTotal: 0,
    peakConcurrent: 0,
    startedAt: new Date().toISOString(),
  };
}

function store(): MetricsStore {
  const host = globalThis as typeof globalThis & { [STORE_KEY]?: MetricsStore };
  host[STORE_KEY] ??= emptyStore();
  return host[STORE_KEY];
}

/** Record one finished request. Never throws: monitoring must not break a route. */
export function recordRequest(sample: Omit<RequestSample, 'at'>): void {
  try {
    const state = store();
    state.totalRequests++;
    if (sample.outcome === 'error') state.failedRequests++;
    if (sample.outcome === 'refused') state.refusedRequests++;
    if (sample.outcome === 'ok' || sample.outcome === 'refused') state.answeredTotal++;
    if (sample.retrievalFailed) state.retrievalFailures++;
    if (sample.concurrent > state.peakConcurrent) state.peakConcurrent = sample.concurrent;

    state.samples.push({ ...sample, at: Date.now() });
    // Fixed ceiling. The oldest sample leaves as the newest arrives.
    if (state.samples.length > MAX_SAMPLES) state.samples.shift();
  } catch {
    // A metrics failure is not a request failure.
  }
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Nearest-rank percentile.
 *
 * p95 matters more than the mean on this hardware: Level 11 measured a mean
 * answer of 31–39s against a p95 of 43–66s, so an average alone hides the
 * requests users actually notice.
 */
function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]!);
}

export interface LatencySummary {
  mean: number | null;
  p50: number | null;
  p95: number | null;
  /** How many samples the figures above are drawn from. */
  count: number;
}

function summarise(values: (number | null)[]): LatencySummary {
  const present = values.filter((value): value is number => value !== null);
  return {
    mean: mean(present),
    p50: percentile(present, 0.5),
    p95: percentile(present, 0.95),
    count: present.length,
  };
}

export interface MetricsSnapshot {
  /** Lifetime of THIS process, not of the application. */
  totalRequests: number;
  failedRequests: number;
  refusedRequests: number;
  retrievalFailures: number;
  /** Refusals as a fraction of requests that produced an answer at all. */
  unansweredRate: number | null;
  failureRate: number | null;
  total: LatencySummary;
  embedding: LatencySummary;
  search: LatencySummary;
  generation: LatencySummary;
  /** Mean chunks retrieved per answered request. */
  meanChunks: number | null;
  meanPromptTokens: number | null;
  meanCompletionTokens: number | null;
  /** Requests that arrived through the Level 17 widget. */
  widgetRequests: number;
  /** Most simultaneous in-flight requests seen since this process started. */
  peakConcurrent: number;
  /** How many samples the ring currently holds, and its ceiling. */
  sampleCount: number;
  sampleCapacity: number;
  /** When this process started counting. */
  since: string;
}

export function metricsSnapshot(): MetricsSnapshot {
  const state = store();
  const {
    samples,
    totalRequests,
    failedRequests,
    refusedRequests,
    retrievalFailures,
    answeredTotal,
  } = state;

  // Samples that produced an answer. Chunk and token means are meaningless for
  // a request that failed before generation, and including their zeroes would
  // drag every average toward nothing.
  const answered = samples.filter(
    (sample) => sample.outcome === 'ok' || sample.outcome === 'refused',
  );

  return {
    totalRequests,
    failedRequests,
    refusedRequests,
    retrievalFailures,
    // Denominator is requests that actually produced an answer. A refusal is a
    // property of answering, so failed and aborted requests do not belong in
    // the population being measured.
    unansweredRate: answeredTotal > 0 ? refusedRequests / answeredTotal : null,
    failureRate: totalRequests > 0 ? failedRequests / totalRequests : null,
    total: summarise(samples.map((sample) => sample.totalMs)),
    embedding: summarise(samples.map((sample) => sample.embeddingMs)),
    search: summarise(samples.map((sample) => sample.searchMs)),
    generation: summarise(samples.map((sample) => sample.generationMs)),
    meanChunks: mean(answered.map((sample) => sample.chunks)),
    meanPromptTokens: mean(answered.map((sample) => sample.promptTokens)),
    meanCompletionTokens: mean(answered.map((sample) => sample.completionTokens)),
    widgetRequests: samples.filter((sample) => sample.widget).length,
    peakConcurrent: state.peakConcurrent,
    sampleCount: samples.length,
    sampleCapacity: MAX_SAMPLES,
    since: state.startedAt,
  };
}

/** Testing helper: forget everything. Never called by application code. */
export function resetMetrics(): void {
  const host = globalThis as typeof globalThis & { [STORE_KEY]?: MetricsStore };
  host[STORE_KEY] = emptyStore();
}

/**
 * Whether an answer was a refusal.
 *
 * The markers are lifted verbatim from `scripts/eval.ts`, where they were
 * frozen BEFORE the Level 11 evaluation ran and have measured behaviour behind
 * them — 4/4 genuinely-missing questions correctly declined, 2/26 answerable
 * ones over-refused. Reusing that list rather than writing a second one keeps
 * the dashboard's "unanswered" figure meaning the same thing as the
 * evaluation's, and stops a matcher being quietly widened to flatter a metric.
 *
 * Only the boolean is kept. The text that produced it is never stored.
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

export function looksLikeRefusal(answer: string): boolean {
  const lowered = answer.toLowerCase();
  return REFUSAL_MARKERS.some((marker) => lowered.includes(marker));
}
