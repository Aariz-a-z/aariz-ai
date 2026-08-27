/**
 * Level 23 — dependency health.
 *
 * ROADMAP.md Level 23 asks for `GET /api/health` returning
 * `{ ok, llm, database }`, and says plainly: "Do not expose secrets."
 *
 * WHAT THIS DELIBERATELY NEVER REPORTS
 * ------------------------------------
 * The two words `available` and `unavailable`, and nothing else. Not the
 * Ollama address, not the Supabase URL, not the model tag, not an error
 * message, not a status code from an upstream, not a latency that would let
 * someone infer where a service is hosted. A health endpoint is the most
 * reliably unauthenticated route an application has, so it is the worst place
 * to be generous — everything it returns is returned to everybody.
 *
 * That also means a failure reason is LOST here on purpose. The operator gets
 * the reason from the structured log (Level 16/18), which is server-side; the
 * public JSON gets a single word.
 *
 * WHY THE RESULT IS CACHED
 * ------------------------
 * Without a cache, an unauthenticated endpoint that probes two upstreams on
 * every request is an amplifier: one cheap request to us becomes one request
 * to Ollama and one to Postgres, and a flood becomes a flood against the very
 * dependencies the endpoint exists to watch. A few seconds of caching removes
 * that entirely — dependency probes are bounded to one per interval no matter
 * how often the endpoint is called — while still being far fresher than any
 * sane monitoring interval.
 *
 * Server-only.
 */

import {
  isGeminiProvider,
  isInferenceDisabled,
  isLocalProvider,
  isZeroApiMode,
} from './inference-mode.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from './supabase/server.ts';

export type DependencyState = 'available' | 'unavailable';

export interface HealthReport {
  ok: boolean;
  llm: DependencyState;
  database: DependencyState;
}

/**
 * Probe timeout.
 *
 * Deliberately short and unrelated to `OLLAMA_TIMEOUT_MS` (120s, Level 16).
 * That budget exists so a long generation is not cut off; a health check has
 * the opposite requirement — an upstream that has not answered in two seconds
 * is not healthy, whatever it does at second ninety.
 */
const PROBE_TIMEOUT_MS = 2_000;

/** How long a probe result is reused. See the note above. */
const CACHE_TTL_MS = 5_000;

interface CachedHealth {
  report: HealthReport;
  at: number;
}

/**
 * Cached on `globalThis` for the reason Level 18 documented: Next compiles
 * route handlers and pages into separate server bundles, so plain module state
 * is per-bundle. Health is only read from one route today, but a cache that
 * silently becomes two caches is the kind of thing that is discovered late.
 */
const CACHE_KEY = Symbol.for('aariz.health.cache');

function cached(): CachedHealth | null {
  const host = globalThis as typeof globalThis & { [CACHE_KEY]?: CachedHealth };
  const entry = host[CACHE_KEY];
  if (entry === undefined) return null;
  return Date.now() - entry.at < CACHE_TTL_MS ? entry : null;
}

function store(report: HealthReport): void {
  const host = globalThis as typeof globalThis & { [CACHE_KEY]?: CachedHealth };
  host[CACHE_KEY] = { report, at: Date.now() };
}

/**
 * Is the model server reachable?
 *
 * `/api/tags` is the cheapest endpoint Ollama has that proves it is actually
 * serving rather than merely accepting connections — a listening socket with a
 * wedged process would pass a TCP check and fail every real request. The
 * response body is discarded: the model list is server-side configuration and
 * has no business in a public health payload.
 *
 * The base URL is read here rather than passed in, and this is the one module
 * besides the provider factory and `inference-mode.ts` that does so. It is a
 * reachability probe, not part of the RAG pipeline, and it never emits what it
 * read.
 */
async function probeLlm(): Promise<DependencyState> {
  // A deployment configured for no inference has nothing to probe. Attempting
  // it would spend the full timeout on every health check reaching for a
  // `localhost` that, in a serverless container, is the container itself.
  if (isInferenceDisabled()) return 'unavailable';

  /**
   * A provider forbidden by ZERO_API_MODE is unavailable, not healthy.
   *
   * Reported `available` before this: the probe reached Google, Google
   * answered, and health said everything was fine — while `/api/chat` and
   * every upload were refusing that exact configuration. An operator reading
   * a green health check would have had no idea why nothing worked.
   *
   * Checked WITHOUT a network call, and that is the point. The question is not
   * whether the provider is reachable but whether this deployment is permitted
   * to use it, and the answer is known from configuration alone. Probing first
   * would also mean a local-only deployment quietly contacting the very API
   * the mode exists to avoid — a health check is not an exemption.
   */
  const configuredProvider = (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();
  if (isZeroApiMode() && !isLocalProvider(configuredProvider)) return 'unavailable';

  /**
   * Gemini mode never touches `localhost`.
   *
   * This is the check that keeps a hosted deployment from reaching for a
   * machine that is not there — in a serverless container `localhost` is the
   * container itself, so the probe would burn its whole timeout on every
   * health check and report a fault that does not exist.
   *
   * Reachability only: the key is sent because the endpoint requires one, and
   * a rejected key is a genuine "unavailable" that an operator needs to see.
   * Nothing about the response is reported beyond one word.
   */
  if (isGeminiProvider()) {
    const key = process.env.GEMINI_API_KEY?.trim();
    if (!key) return 'unavailable';
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      return response.ok ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Drain so the socket is released rather than left to the GC.
    await response.arrayBuffer().catch(() => undefined);
    return response.ok ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Is the database reachable?
 *
 * A `head` count against a real table. Deliberately NOT a bare connection
 * check: Level 12 established that a query against a table PostgREST cannot
 * see resolves with no error at all, so "the connection opened" is not
 * evidence the schema is there. An error object here is the signal.
 */
async function probeDatabase(): Promise<DependencyState> {
  if (!isSupabaseConfigured()) return 'unavailable';
  try {
    const { error } = await getSupabaseAdminClient()
      .from('documents')
      .select('id', { head: true, count: 'exact' });
    return error === null ? 'available' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * The health report, cached briefly.
 *
 * Both probes run concurrently: they are independent, and a health check that
 * takes the sum of its timeouts is a health check that times out.
 */
export async function checkHealth(): Promise<HealthReport> {
  const hit = cached();
  if (hit !== null) return hit.report;

  const [llm, database] = await Promise.all([probeLlm(), probeDatabase()]);
  const report: HealthReport = {
    ok: llm === 'available' && database === 'available',
    llm,
    database,
  };

  store(report);
  return report;
}

/** Testing helper: forget the cached probe. Never called by application code. */
export function resetHealthCache(): void {
  const host = globalThis as typeof globalThis & { [CACHE_KEY]?: CachedHealth };
  delete host[CACHE_KEY];
}
