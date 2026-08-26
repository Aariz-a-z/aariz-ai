/**
 * Level 10 — model-based reranker.
 *
 * The classic cross-encoder arrangement: show the model the question and one
 * passage together and ask how well the passage answers it. Unlike the
 * bi-encoder retrieval in Level 5, the two texts are scored jointly, which is
 * why this normally beats embedding similarity.
 *
 * IT IS OFF BY DEFAULT ON THIS HARDWARE, AND HERE IS WHY
 * ------------------------------------------------------
 * Measured against the real Ollama server on the target machine. Cost per
 * candidate varies by an order of magnitude with passage length and how warm
 * the model and prompt cache are, so both ends are recorded:
 *
 *   pointwise, llama3.2:3b, ~414-token passages, cold
 *       10.4 s per candidate  ->  ~155 s for a 15-candidate set
 *   pointwise, llama3.2:3b, ~300-token passages, warm (verify-rerank.ts)
 *        0.7 s per candidate  ->   ~14 s for a 20-candidate set
 *   pointwise, llama3.2:1b, ~414-token passages
 *        8.2 s per candidate, and it scored a passage that directly answered
 *        the question 2 out of 10 — cheaper and also a worse judge
 *   listwise,  llama3.2:3b, 8 candidates in one call
 *       20.4 s, and the reply was "1, 2, 3, 4, 5, 6, 7, 8" — the input order,
 *       i.e. it performed no reranking at all
 *
 * The best case, 14 s added before the first token of an answer, is still far
 * outside an interactive budget, and the listwise result shows a 3B model does
 * not reliably discriminate even when it is given the chance.
 *
 * Ollama 0.30.11 exposes no reranking endpoint (`/api/rerank`, `/api/rank`,
 * `/v1/rerank`, `/api/score` and `/api/classify` all return 404), so a real
 * cross-encoder cannot be served through the existing provider either. That is
 * the "local reranking is impractical" case ROADMAP.md Level 10 anticipates,
 * and the roadmap's instruction for it is to implement the interface and allow
 * it to be disabled.
 *
 * It is implemented rather than stubbed for three reasons: it makes
 * RERANK_STRATEGY a real switch instead of decoration, it is the reproducible
 * artifact behind the "impractical" claim above, and it is what exercises the
 * fail-open path under a genuine timeout. On better hardware, or once Ollama
 * ships a reranking endpoint, this becomes the strategy worth enabling.
 */

import type { LlmProvider } from '../llm/types.ts';
import type { HybridRetrievalResult } from '../retrieval.ts';
import { RerankError, type Reranker, type RerankedResult, type RerankOptions } from './types.ts';

/**
 * Passage characters shown to the model.
 *
 * Prompt processing is the dominant cost — Level 2 measured it collapsing from
 * 115 tok/s to 38 tok/s at around 1000 tokens — so this is a latency control,
 * not a quality one. Roughly 300 tokens.
 */
const DEFAULT_MAX_PASSAGE_CHARS = 1_200;

/** Highest score the rubric allows. Kept in one place; the prompt reads it. */
const SCORE_MAX = 10;

export interface LlmRerankerOptions {
  /**
   * Supplies the model. Injectable so verification can drive a real provider
   * directly, and so this module never imports the provider factory eagerly —
   * loading `src/lib/llm.ts` pulls in the Ollama adapter, which the standalone
   * scripts cannot resolve.
   */
  resolveProvider?: () => Promise<LlmProvider>;
  maxPassageChars?: number;
}

const defaultResolveProvider = async (): Promise<LlmProvider> => {
  const { getLlmProvider } = await import('../llm.ts');
  return getLlmProvider();
};

/**
 * Pull a 0–10 rating out of a free-form reply.
 *
 * Small models pad with prose however firmly they are told not to, so the first
 * integer in range is taken rather than requiring the whole reply to be a
 * number. Values above the maximum are clamped instead of discarded: a model
 * answering "10/10" or "95" means "very relevant", not "unparseable".
 */
function parseScore(reply: string): number | null {
  const match = reply.match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(value, SCORE_MAX);
}

function buildPrompt(query: string, passage: string): string {
  return [
    `Rate how well the passage answers the question, from 0 to ${SCORE_MAX}.`,
    `${SCORE_MAX} means it contains the answer. 0 means it is unrelated.`,
    'Reply with the number only.',
    '',
    `QUESTION: ${query}`,
    '',
    'PASSAGE:',
    passage,
    '',
    'SCORE:',
  ].join('\n');
}

export function createLlmReranker(options: LlmRerankerOptions = {}): Reranker {
  const resolveProvider = options.resolveProvider ?? defaultResolveProvider;
  const maxPassageChars = options.maxPassageChars ?? DEFAULT_MAX_PASSAGE_CHARS;

  return {
    id: 'llm',

    async rerank(
      query: string,
      candidates: HybridRetrievalResult[],
      rerankOptions: RerankOptions,
    ): Promise<RerankedResult[]> {
      let provider: LlmProvider;
      try {
        provider = await resolveProvider();
      } catch (caught) {
        throw new RerankError(
          'provider_unavailable',
          `Could not obtain an LLM provider for reranking: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }

      // Sequential on purpose. The target machine has two cores and Ollama
      // serves one request at a time; issuing these concurrently makes the
      // total no faster and the individual latencies far worse.
      const scores: (number | null)[] = [];
      for (const candidate of candidates) {
        rerankOptions.signal?.throwIfAborted();

        const passage = candidate.content.slice(0, maxPassageChars);
        const reply = await provider.generate({
          messages: [{ role: 'user', content: buildPrompt(query, passage) }],
          signal: rerankOptions.signal,
          // Deterministic: the same passage must not drift between positions
          // across runs, or the ordering stops being reproducible.
          temperature: 0,
          maxTokens: 8,
        });
        scores.push(parseScore(reply));
      }

      // A model that mostly fails to produce a number is not reranking, it is
      // adding latency. Refusing the whole result set makes the caller fall
      // back to the fused order rather than trusting a near-random ordering.
      const parsed = scores.filter((score) => score !== null).length;
      if (parsed * 2 < scores.length) {
        throw new RerankError(
          'unusable_response',
          `Model returned an unusable score for ${scores.length - parsed} of ${scores.length} candidates.`,
        );
      }

      const ranked: RerankedResult[] = candidates.map((candidate, index) => ({
        ...candidate,
        rerankScore: scores[index] ?? 0,
        originalRank: index + 1,
        rerankStrategy: 'llm' as const,
      }));

      // Array.prototype.sort is stable, so equal scores keep their fused order.
      // That matters here: this model ties candidates constantly, and the fused
      // ranking is the better tie-break.
      ranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));

      return ranked.slice(0, rerankOptions.topK);
    },
  };
}
