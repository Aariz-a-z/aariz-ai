/**
 * Embedding provider selection, batching, retry and validation.
 *
 * The counterpart to `src/lib/llm.ts`. Application code imports from here and
 * never from `embeddings/ollama` or `embeddings/gemini`, so adding a provider
 * means adding an adapter and a case below and nothing else (Roadmap Rule 8).
 *
 * THE PUBLIC SURFACE IS UNCHANGED
 * -------------------------------
 * `embedDocuments`, `embedDocumentsWithTokenCounts`, `embedQuery`,
 * `getEmbeddingModel`, `EmbeddingError` and `EMBEDDING_DIMENSION` are exactly
 * what they were when this module talked to Ollama directly. `retrieval.ts`,
 * `ingest/pipeline.ts` and six verification scripts import them and needed no
 * change — which is the point of cutting the seam underneath rather than
 * through them.
 *
 * WHAT LIVES HERE RATHER THAN IN AN ADAPTER
 * -----------------------------------------
 * Batching, retry with backoff, input validation, and the dimension check.
 * All four are policy that must not differ between providers: an adapter that
 * forgot to retry, or checked a different width, would show up as a quiet
 * difference in retrieval quality rather than as an obvious bug. Adapters do
 * one batch call and map their own errors, and nothing else.
 *
 * Server-only. `OLLAMA_*` and `GEMINI_API_KEY` are un-prefixed on purpose, so
 * Next never inlines them into a client bundle.
 */

import { EMBEDDING_DIMENSION } from '../types/database.ts';
import { createGeminiEmbeddingProvider, getGeminiEmbedModel } from './embeddings/gemini.ts';
import { createOllamaEmbeddingProvider, getOllamaEmbedModel } from './embeddings/ollama.ts';
import { isLocalProvider, isZeroApiMode } from './inference-mode.ts';
import {
  EmbeddingError,
  type EmbedOptions,
  type EmbedTask,
  type EmbeddedText,
  type EmbeddingProvider,
} from './embeddings/types.ts';
import { estimateTokens } from './ingest/tokens.ts';

export { EMBEDDING_DIMENSION };
export { EmbeddingError } from './embeddings/types.ts';
export type {
  EmbedOptions,
  EmbedTask,
  EmbeddedText,
  EmbeddingErrorCode,
  EmbeddingProvider,
} from './embeddings/types.ts';

/**
 * Texts per request. Ollama accepts more, but the reference machine is
 * CPU-only with two cores — a large batch produces one long unresponsive call
 * and a coarse failure unit, since a single bad text fails the whole batch.
 */
const DEFAULT_BATCH_SIZE = 16;

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/embeddings.ts is server-only and must not be imported from a client component.',
    );
  }
}

/**
 * Which embedding provider is configured.
 *
 * Selected by `LLM_PROVIDER`, the SAME variable that selects the generation
 * provider, and deliberately not a second one. Two switches would permit
 * Gemini generation with Ollama embeddings — a combination that works on a
 * laptop and cannot work on Vercel, and which would fail only at the first
 * upload rather than at startup.
 *
 * `disabled` (Level 23's demo mode) has no embedding provider: the routes
 * refuse before reaching here, and this throws if anything ever slips past.
 */
function providerId(): string {
  return (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const id = providerId();

  /**
   * ZERO_API_MODE, enforced here as well as in `llm.ts`.
   *
   * It was enforced ONLY in `llm.ts`, which meant the mode stopped cloud
   * generation and did nothing about cloud embeddings. With
   * `ZERO_API_MODE=true` and `LLM_PROVIDER=gemini`, `/api/chat` correctly
   * refused while `/api/documents` happily uploaded — sending every chunk of
   * the user's document to Google. Verified before this change: uploads under
   * that configuration succeeded and stored non-null Gemini vectors.
   *
   * That is the worse half of the leak to have missed. Ingestion makes one API
   * call per chunk, so it is the LARGER consumer, and the payload is the
   * document's full text rather than a question — exactly the content a
   * local-only mode exists to keep local.
   *
   * The check is deny-by-default and mirrors `llm.ts` exactly: an unknown
   * provider is not local, so a provider added later is refused under this mode
   * without having to remember to add it to any list.
   *
   * Placed in the factory rather than in each route because every embedding —
   * upload, CLI ingestion, re-ingestion, and the query side of retrieval —
   * passes through here. A route-level check would leave the CLI paths open.
   */
  if (isZeroApiMode() && !isLocalProvider(id)) {
    throw new EmbeddingError(
      'provider_error',
      `ZERO_API_MODE is enabled, so only a local provider may be used. ` +
        `LLM_PROVIDER="${id}" is not local.`,
    );
  }

  switch (id) {
    case 'ollama':
      return createOllamaEmbeddingProvider();
    case 'gemini':
      return createGeminiEmbeddingProvider();
    case 'disabled':
      throw new EmbeddingError(
        'provider_error',
        'Embedding is unavailable: this deployment is configured for no inference.',
      );
    default:
      throw new EmbeddingError(
        'provider_error',
        `Unknown LLM_PROVIDER "${id}". Supported: ollama, gemini, disabled.`,
      );
  }
}

/**
 * The active embedding model tag.
 *
 * Read without constructing a provider so it stays cheap and side-effect free
 * — `reingest.ts` calls it to label staged rows, and the health page calls it
 * on a path that must not throw.
 */
export function getEmbeddingModel(): string {
  return providerId() === 'gemini' ? getGeminiEmbedModel() : getOllamaEmbedModel();
}

/** Which provider produced the vectors. Used by health and monitoring. */
export function getEmbeddingProviderId(): string {
  return providerId();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Transient failures are worth retrying; a malformed request never is.
 *
 * `quota_exceeded` is deliberately NOT retryable. Retrying a rate-limit
 * response is how a budget overrun becomes a much larger one, and the whole
 * point of the Gemini budget is to stop that.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingError) {
    return error.code === 'provider_unreachable' || error.code === 'provider_error';
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BatchOutcome {
  embeddings: number[][];
  promptEvalCount: number;
}

/**
 * One batch, with the dimension check every provider is held to.
 *
 * A vector of the wrong width would be silently unusable — pgvector rejects it
 * at insert time with an opaque error, or worse, a model change makes every
 * stored vector quietly incomparable. Checking here fails at the source, and
 * names the Level 22 procedure because that is the actual remedy.
 */
async function embedBatch(
  provider: EmbeddingProvider,
  texts: string[],
  task: EmbedTask,
  options: EmbedOptions,
): Promise<BatchOutcome> {
  const { embeddings, promptEvalCount } = await provider.embedBatch(texts, task, options);

  for (const [index, vector] of embeddings.entries()) {
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION) {
      throw new EmbeddingError(
        'dimension_mismatch',
        `Embedding ${index} has dimension ${Array.isArray(vector) ? vector.length : 'unknown'}, ` +
          `but the database column is vector(${EMBEDDING_DIMENSION}). ` +
          `Model "${provider.model}" does not match the schema — see Level 22 for the reindex procedure.`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingError('provider_error', `Embedding ${index} contains a non-finite value.`);
    }
  }

  return { embeddings, promptEvalCount };
}

/** Retry transient failures with exponential backoff. Failures are never swallowed. */
async function embedBatchWithRetry(
  provider: EmbeddingProvider,
  texts: string[],
  task: EmbedTask,
  options: EmbedOptions,
): Promise<BatchOutcome> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await embedBatch(provider, texts, task, options);
    } catch (caught) {
      if (isAbortError(caught)) throw caught;
      lastError = caught;

      if (!isRetryable(caught) || attempt === maxAttempts) break;

      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  // Rethrow with attempt context rather than a generic wrapper, so the
  // original cause stays visible.
  if (lastError instanceof EmbeddingError) {
    throw new EmbeddingError(
      lastError.code,
      `${lastError.message} (failed after ${maxAttempts} attempt(s))`,
    );
  }
  throw lastError;
}

function validateTexts(texts: string[]): void {
  for (const [index, text] of texts.entries()) {
    if (typeof text !== 'string') {
      throw new EmbeddingError('invalid_input', `Text ${index} is not a string.`);
    }
    if (text.trim().length === 0) {
      throw new EmbeddingError(
        'invalid_input',
        `Text ${index} is empty. Embedding whitespace produces a vector that matches nothing meaningfully.`,
      );
    }
  }
}

/**
 * Embed texts for storage, in batches.
 *
 * Returns one vector per input, in the same order. Throws on any failure —
 * a partially-embedded batch would leave chunks silently unsearchable.
 */
export async function embedDocuments(
  texts: string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  assertServerOnly();

  if (texts.length === 0) return [];
  validateTexts(texts);

  const provider = createEmbeddingProvider();
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const results: number[][] = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    results.push(...(await embedBatchWithRetry(provider, batch, 'document', options)).embeddings);
  }

  return results;
}

/**
 * Embed texts for storage and return each one's token count.
 *
 * Embeds one text per request, because a batched request reports a single
 * count for the whole batch and per-chunk counts are what the database stores.
 * That is not the cost it sounds like: measured on the reference machine, ten
 * single calls took 1.63 s against 3.16 s for one ten-text batch, so
 * unbatching is actually faster there as well as more informative.
 *
 * WHERE THE COUNT COMES FROM, AND WHY IT DIFFERS BY PROVIDER
 * ----------------------------------------------------------
 * Ollama reports `prompt_eval_count` — the model's own figure, which is what
 * `chunks.token_count` has always held. The Gemini embedding endpoint reports
 * nothing, and the column is `not null check (token_count > 0)`, so a zero
 * would fail every insert.
 *
 * Rather than migrate a Level 4 constraint, a provider that reports no count
 * falls back to the Level 6 estimator. The consequence is stated plainly
 * because it is a real one: for Gemini-embedded rows `token_count` is an
 * ESTIMATE, not the model's own count. It is used for chunk-boundary
 * decisions and reporting, never for billing or correctness.
 */
export async function embedDocumentsWithTokenCounts(
  texts: string[],
  options: EmbedOptions = {},
): Promise<EmbeddedText[]> {
  assertServerOnly();

  if (texts.length === 0) return [];
  validateTexts(texts);

  const provider = createEmbeddingProvider();
  const results: EmbeddedText[] = [];

  for (const text of texts) {
    const { embeddings, promptEvalCount } = await embedBatchWithRetry(
      provider,
      [text],
      'document',
      options,
    );
    const embedding = embeddings[0];
    if (!embedding) {
      throw new EmbeddingError('provider_error', 'The embedding provider returned no vector.');
    }
    results.push({
      embedding,
      tokenCount: promptEvalCount > 0 ? promptEvalCount : Math.max(1, estimateTokens(text)),
    });
  }

  return results;
}

/**
 * Embed a search query.
 *
 * Uses the `query` task rather than `document`. Embedding a query as though it
 * were a document measurably degrades retrieval, so the two paths are
 * deliberately not interchangeable — see `embeddings/types.ts` for how each
 * provider expresses that.
 */
export async function embedQuery(text: string, options: EmbedOptions = {}): Promise<number[]> {
  assertServerOnly();

  validateTexts([text]);

  const provider = createEmbeddingProvider();
  const [vector] = (await embedBatchWithRetry(provider, [text], 'query', options)).embeddings;
  if (!vector) {
    throw new EmbeddingError(
      'provider_error',
      'The embedding provider returned no vector for the query.',
    );
  }
  return vector;
}
