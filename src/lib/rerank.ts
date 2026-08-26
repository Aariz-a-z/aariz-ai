/**
 * Level 10 — reranking: strategy selection, configuration, and the fail-open
 * boundary.
 *
 *     question
 *        ↓  retrieveHybrid(matchCount: RERANK_CANDIDATES)   Level 9, unchanged
 *     large fused candidate set                             ← "retrieve a larger
 *        ↓  Reranker.rerank()                                  candidate set"
 *     top MATCH_COUNT
 *        ↓  buildGroundedContext()                          Level 8, unchanged
 *
 * Application code imports from here and never from `rerank/lexical` or
 * `rerank/llm` directly, exactly as it imports `lib/llm` and never
 * `lib/llm/ollama` (Roadmap Rule 8).
 *
 * THE CENTRAL GUARANTEE
 * ---------------------
 * ROADMAP.md Level 10: "Never make the entire chatbot fail because reranking
 * is unavailable." Reranking is a reordering of results that already exist, so
 * every failure has a correct answer available — the fused order Level 9
 * produced. `rerankResults` therefore catches everything a strategy can throw,
 * logs it server-side, and returns that order. There is no path from a broken
 * reranker to a failed request.
 *
 * Server-only: it reaches the database through the Level 7/9 retrieval layer.
 */

import { isAbortError } from './llm/types.ts';
import { log } from './log.ts';
import { createLexicalReranker } from './rerank/lexical.ts';
import { createLlmReranker } from './rerank/llm.ts';
import {
  RerankError,
  passthrough,
  type Reranker,
  type RerankStrategyId,
  type RerankedResult,
} from './rerank/types.ts';
import {
  getRetrievalConfig,
  retrieveHybrid,
  type HybridRetrievalResult,
  type RetrievalOptions,
} from './retrieval.ts';

export { RerankError, passthrough } from './rerank/types.ts';
export type {
  Reranker,
  RerankOptions,
  RerankStrategyId,
  RerankedResult,
} from './rerank/types.ts';

/**
 * Whether reranking runs when RERANK_ENABLED is unset.
 *
 * OFF, and that is a measured result rather than a preference. On the Level 10
 * fixture — 12 documents, 16 labelled queries, frozen before this code existed
 * — the lexical reranker changed nothing:
 *
 *     metric                 Level 9    Level 10    delta
 *     top-1 accuracy           87.5%       87.5%        0
 *     hit rate @5             100.0%      100.0%        0
 *     mean reciprocal rank    0.9375      0.9375        0
 *
 *     improved: 0    unchanged: 16    degraded: 0
 *
 * Level 9 hybrid search already answers that fixture at 87.5% top-1 and 100%
 * hit rate, so there was almost no headroom, and the two remaining misses are
 * genuine document-level ambiguities in which two pages both contain the
 * queried phrase verbatim. Reranking did not fix them and did not break
 * anything either.
 *
 * ROADMAP.md Level 10 anticipates precisely this: "If local reranking is
 * impractical, implement the reranker interface but allow it to be disabled."
 * Defaulting to off means a stage that has not been shown to help does not
 * silently sit in the request path. Turning it on is one environment variable,
 * and `scripts/verify-rerank.ts` re-runs the comparison against any corpus.
 *
 * STATUS: Level 10 was accepted as implementation-complete under that fallback
 * clause. The literal "Done when" — "retrieval quality improves on the
 * evaluation dataset" — REMAINS UNPROVEN, and is not claimed here. The Level 10
 * fixture reached its ceiling (Level 9 alone scored 100% hit@5 on it) and
 * produced only one chunk per document, so it could neither show a gain nor
 * exercise the reranker's redundancy handling. That question is deferred to the
 * Level 11 evaluation dataset, which is built to have the headroom this fixture
 * lacked: re-run the comparison there before deciding whether to enable this.
 */
const DEFAULT_ENABLED = false;

/**
 * The lexical strategy is the default because it is the one that is always
 * available: no model, no network, no failure mode. The `llm` strategy is
 * measured as impractical on this hardware — see `rerank/llm.ts`.
 */
const DEFAULT_STRATEGY: RerankStrategyId = 'lexical';

/**
 * Candidates fetched for the reranker to choose from.
 *
 * This is ROADMAP.md's "first retrieve a larger candidate set". Reranking can
 * only reorder what it is given, so the gain comes from the window between
 * MATCH_COUNT (5) and this number: a chunk fused at position 14 can reach the
 * answer only if it was fetched in the first place.
 *
 * Bounded by MAX_MATCH_COUNT in retrieval.ts, which this must not exceed.
 */
const DEFAULT_CANDIDATES = 20;
const MAX_CANDIDATES = 100;

/**
 * Wall-clock budget for the rerank stage.
 *
 * Generous for the lexical strategy, which finishes in under a millisecond,
 * and deliberately far below what the `llm` strategy needs — an LLM rerank
 * that overruns is exactly the case that must degrade to the fused order
 * instead of holding the user's request open.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface RerankConfig {
  enabled: boolean;
  strategy: RerankStrategyId;
  candidates: number;
  timeoutMs: number;
}

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/rerank.ts is server-only and must not be imported from a client component.',
    );
  }
}

/**
 * Parse a boolean environment variable strictly.
 *
 * A typo must not silently mean "off". ROADMAP.md specifies
 * `RERANK_ENABLED=true/false`, so anything else is a configuration error and
 * is reported as one.
 */
function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new RerankError(
    'invalid_configuration',
    `${name} must be "true" or "false", received "${raw}".`,
  );
}

/** The effective reranking parameters. Single source of truth. */
export function getRerankConfig(): RerankConfig {
  const enabled = readBooleanEnv('RERANK_ENABLED', DEFAULT_ENABLED);

  const rawStrategy = process.env.RERANK_STRATEGY?.trim().toLowerCase();
  if (rawStrategy && rawStrategy !== 'lexical' && rawStrategy !== 'llm') {
    throw new RerankError(
      'invalid_configuration',
      `RERANK_STRATEGY must be "lexical" or "llm", received "${rawStrategy}".`,
    );
  }
  const strategy: RerankStrategyId = (rawStrategy as RerankStrategyId | undefined) ?? DEFAULT_STRATEGY;

  const rawCandidates = process.env.RERANK_CANDIDATES?.trim();
  const candidates = rawCandidates ? Number(rawCandidates) : DEFAULT_CANDIDATES;
  if (!Number.isInteger(candidates) || candidates < 1 || candidates > MAX_CANDIDATES) {
    throw new RerankError(
      'invalid_configuration',
      `RERANK_CANDIDATES must be an integer within [1, ${MAX_CANDIDATES}], received "${rawCandidates}".`,
    );
  }

  const rawTimeout = process.env.RERANK_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new RerankError(
      'invalid_configuration',
      `RERANK_TIMEOUT_MS must be a positive number, received "${rawTimeout}".`,
    );
  }

  return { enabled, strategy, candidates, timeoutMs };
}

/**
 * Build the configured strategy.
 *
 * Exported so verification can construct a strategy directly — the `llm`
 * reranker in particular needs an injected provider, because the standalone
 * scripts cannot resolve the alias imports inside the Ollama adapter.
 */
export function createReranker(strategy: RerankStrategyId): Reranker {
  switch (strategy) {
    case 'lexical':
      return createLexicalReranker();
    case 'llm':
      return createLlmReranker();
  }
}

export interface RerankResultsOptions {
  topK: number;
  signal?: AbortSignal;
  /** Overrides the configured strategy. Used by verification to compare them. */
  reranker?: Reranker;
  /** Overrides the configured budget. */
  timeoutMs?: number;
}

/**
 * Rerank a candidate list, falling back to its existing order on any failure.
 *
 * The only exception is a caller-initiated abort: if the user pressed Stop
 * there is nothing to fall back *to*, and swallowing that would have the route
 * finish work nobody is waiting for.
 */
export async function rerankResults(
  query: string,
  candidates: HybridRetrievalResult[],
  options: RerankResultsOptions,
): Promise<RerankedResult[]> {
  const { topK, signal } = options;
  if (candidates.length === 0) return [];

  // The caller has already gone. Reranking is pure extra work at this point,
  // and completing it would have the route finish a request nobody awaits.
  signal?.throwIfAborted();

  const config = getRerankConfig();
  if (!config.enabled && !options.reranker) {
    return passthrough(candidates, topK, 'none');
  }

  const reranker = options.reranker ?? createReranker(config.strategy);
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;

  // The strategy sees whichever fires first. AbortSignal.any keeps the caller's
  // cancellation and our own budget as separate, distinguishable causes.
  const budget = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, budget]) : budget;

  try {
    const reranked = await reranker.rerank(query, candidates, { topK, signal: combined });

    // A strategy that returns nothing has not reranked, it has deleted the
    // answer. Treated as a failure so the fused order survives.
    if (reranked.length === 0) {
      throw new RerankError('unusable_response', `Strategy "${reranker.id}" returned no results.`);
    }
    return reranked;
  } catch (caught) {
    // Caller cancelled — propagate, do not "recover" into wasted work.
    //
    // Keyed on the caller's signal rather than on the shape of what was thrown.
    // A strategy is not obliged to honour its AbortSignal, and one that ignores
    // it and then fails for an unrelated reason must not have the user's Stop
    // quietly converted into a successful answer.
    if (signal?.aborted) throw signal.reason ?? caught;

    const reason =
      budget.aborted && isAbortError(caught)
        ? `exceeded its ${timeoutMs}ms budget`
        : caught instanceof Error
          ? caught.message
          : String(caught);

    // Logged, never surfaced: the user gets a correctly grounded answer built
    // from the fused ordering, which is what Level 9 would have returned anyway.
    log.warn('rerank.failed', {
      strategy: reranker.id,
      reason,
      outcome: 'fell back to fused retrieval order',
    });
    return passthrough(candidates, topK, 'none');
  }
}

/**
 * Retrieve, then rerank — the entry point the RAG layer uses.
 *
 * With reranking disabled this is Level 9 exactly: the same `retrieveHybrid`
 * call with the same arguments, wrapped so the return type is uniform. That
 * equivalence is asserted directly by the Level 10 verification suite, because
 * "off" must mean "unchanged" and not merely "similar".
 */
export async function retrieveReranked(
  query: string,
  options: RetrievalOptions = {},
): Promise<RerankedResult[]> {
  assertServerOnly();

  const config = getRerankConfig();
  const topK = options.matchCount ?? getRetrievalConfig().matchCount;

  if (!config.enabled) {
    const fused = await retrieveHybrid(query, options);
    return passthrough(fused, topK, 'none');
  }

  // Over-fetch so the reranker has something to work with. Never fewer than
  // the caller asked for.
  const candidates = await retrieveHybrid(query, {
    ...options,
    matchCount: Math.max(config.candidates, topK),
  });

  if (candidates.length === 0) return [];

  return rerankResults(query, candidates, { topK, signal: options.signal });
}
