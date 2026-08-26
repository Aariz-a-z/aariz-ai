/**
 * Provider-agnostic embedding contract.
 *
 * The mirror of `src/lib/llm/types.ts`, added when a second embedding provider
 * arrived. Level 19 abstracted GENERATION and deliberately stopped there;
 * embeddings stayed a single flat module talking to Ollama because there was
 * only ever one implementation. Gemini is the second, so the same seam is cut
 * here — and cut in the same shape, so there is one pattern to learn rather
 * than two.
 *
 * Nothing in this file mentions Ollama, Gemini or HTTP.
 *
 * WHY `task` IS PART OF THE INTERFACE
 * -----------------------------------
 * Because providers express it incompatibly, and the difference is not
 * cosmetic. nomic-embed-text needs literal text prefixes — `search_document: `
 * and `search_query: ` — prepended to the input. Gemini takes a structured
 * `taskType` field and would embed those prefixes as if they were part of the
 * user's question.
 *
 * So the caller states the INTENT and each adapter expresses it in its own
 * dialect. Passing pre-prefixed text through a shared interface would have
 * silently corrupted every Gemini vector while looking perfectly correct.
 */

/** Storage or search. The two are not interchangeable — see the note above. */
export type EmbedTask = 'document' | 'query';

export type EmbeddingErrorCode =
  | 'invalid_input'
  | 'provider_unreachable'
  | 'model_not_found'
  | 'dimension_mismatch'
  | 'provider_error'
  /** Added with Gemini: the key is absent, malformed, or rejected. */
  | 'invalid_credentials'
  /** Added with Gemini: the upstream account or key is over its quota. */
  | 'quota_exceeded';

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;

  constructor(code: EmbeddingErrorCode, message: string) {
    super(message);
    this.name = 'EmbeddingError';
    this.code = code;
  }
}

export interface EmbedOptions {
  signal?: AbortSignal;
  /** Texts per request. Defaults to 16. */
  batchSize?: number;
  /** Total attempts per batch, including the first. Defaults to 3. */
  maxAttempts?: number;
}

/** One embedded text with the model's own token count for it. */
export interface EmbeddedText {
  embedding: number[];
  /**
   * Token count reported by the embedding model where it reports one.
   *
   * Only meaningful when the text was embedded on its own — a batched request
   * reports one total for the whole batch. Providers that report nothing
   * return 0, and callers that store this must treat 0 as "not reported"
   * rather than "empty".
   */
  tokenCount: number;
}

export interface BatchResult {
  embeddings: number[][];
  /** Total for the batch. Per-text only when the batch held one text. */
  promptEvalCount: number;
}

/**
 * One embedding provider.
 *
 * Adapters implement a single batch call and nothing else. Retry, backoff,
 * batching, input validation and dimension checking all live in
 * `src/lib/embeddings.ts` above them, so those behaviours cannot drift between
 * providers — an adapter that forgot to retry, or checked a different
 * dimension, would be a silent difference in retrieval quality rather than an
 * obvious bug.
 */
export interface EmbeddingProvider {
  /** Stable identifier, e.g. "ollama". Safe to log. */
  readonly id: string;
  /** Model tag in use. Server-side only — never send this to a browser. */
  readonly model: string;
  /** Embed one batch. Throws `EmbeddingError`; never returns a partial result. */
  embedBatch(texts: string[], task: EmbedTask, options: EmbedOptions): Promise<BatchResult>;
}
