/**
 * Level 10 — the reranker contract.
 *
 * Nothing here mentions a model, a vendor, or a scoring technique. ROADMAP.md
 * Level 10 asks for "the reranker interface" precisely so that a strategy can
 * be swapped or switched off without the rest of the pipeline noticing, and
 * Rule 8 requires the same provider-agnosticism the LLM layer already has.
 *
 * Mirrors the shape of `src/lib/llm/types.ts` deliberately: contract here,
 * implementations in sibling files, selection in `src/lib/rerank.ts`.
 */

import type { HybridRetrievalResult } from '../retrieval.ts';

/**
 * Which reranking implementation to use.
 *
 * `none` is not listed: disabling reranking is a configuration state, not a
 * strategy, and it is handled before a reranker is ever constructed.
 */
export type RerankStrategyId = 'lexical' | 'llm';

/**
 * A reranked chunk.
 *
 * Extends `HybridRetrievalResult` rather than replacing it, exactly as Level 9
 * extended `RetrievalResult`. Every existing consumer — `buildGroundedContext`
 * above all — therefore accepts these unchanged, and the Level 8 grounding and
 * citation code needs no modification at all.
 */
export interface RerankedResult extends HybridRetrievalResult {
  /**
   * The reranker's own score. Comparable only within a single result set:
   * strategies use different scales and none of them is a probability.
   *
   * Null when reranking did not run — disabled, unavailable, or failed open.
   */
  rerankScore: number | null;
  /** 1-based position in the fused candidate list, before reranking. */
  originalRank: number;
  /** Which strategy produced this ordering; `none` when the fused order stands. */
  rerankStrategy: RerankStrategyId | 'none';
}

export interface RerankOptions {
  /** How many results to return. The candidate list is normally much longer. */
  topK: number;
  /**
   * Aborts the rerank only. The caller's retrieval has already completed, so
   * cancelling here costs nothing already paid for.
   */
  signal?: AbortSignal;
}

export interface Reranker {
  readonly id: RerankStrategyId;
  /**
   * Reorder `candidates` and return the best `topK`.
   *
   * Implementations may assume `candidates` is non-empty and already ordered by
   * fused RRF score. They must not mutate it.
   *
   * Throwing is acceptable — the caller in `src/lib/rerank.ts` catches and
   * falls back to the fused order, which is what keeps a broken or unavailable
   * reranker from breaking the chatbot (ROADMAP.md Level 10).
   */
  rerank(
    query: string,
    candidates: HybridRetrievalResult[],
    options: RerankOptions,
  ): Promise<RerankedResult[]>;
}

/** Why a rerank attempt failed. Never surfaced to the browser — always fails open. */
export type RerankErrorCode =
  | 'invalid_configuration'
  | 'provider_unavailable'
  | 'timeout'
  | 'unusable_response';

export class RerankError extends Error {
  readonly code: RerankErrorCode;

  constructor(code: RerankErrorCode, message: string) {
    super(message);
    this.name = 'RerankError';
    this.code = code;
  }
}

/**
 * Carry a candidate through unchanged, recording that reranking did not run.
 *
 * Shared by the disabled path and every fail-open path so the three cannot
 * drift apart in how they report themselves.
 */
export function passthrough(
  candidates: HybridRetrievalResult[],
  topK: number,
  strategy: RerankStrategyId | 'none' = 'none',
): RerankedResult[] {
  return candidates.slice(0, topK).map((candidate, index) => ({
    ...candidate,
    rerankScore: null,
    originalRank: index + 1,
    rerankStrategy: strategy,
  }));
}
