/**
 * Local embeddings via Ollama.
 *
 * Server-only. No paid embedding API is involved: vectors are produced by a
 * model running on this machine.
 *
 * Two behaviours here were measured against the running model rather than
 * assumed (Level 5 verification):
 *
 *  1. `POST /api/embed` accepts an array for `input` and returns one vector
 *     per element, so batching is a single round trip.
 *
 *  2. nomic-embed-text requires task-instruction prefixes. Prefixing changes
 *     the vector materially (cosine 0.917 against the unprefixed form), and
 *     asymmetric prefixing measurably improves retrieval separation — the
 *     relevant/irrelevant cosine margin rose from 0.344 to 0.371 on a probe
 *     pair. This is why `embedDocuments` and `embedQuery` are separate
 *     functions rather than one `embed()`: callers must not have to remember
 *     which prefix applies.
 *
 * Level 6 consumes this to ingest documents; Level 7 consumes `embedQuery`
 * for retrieval. Neither exists yet.
 */

// Relative rather than the usual '@/' alias, and with an explicit extension:
// EMBEDDING_DIMENSION is a runtime value, and scripts/verify-embeddings.ts
// imports this module directly under `node --experimental-strip-types`, which
// resolves neither tsconfig path aliases nor extensionless specifiers.
import { EMBEDDING_DIMENSION } from '../types/database.ts';

export { EMBEDDING_DIMENSION };

/** Model tag. Overridable, but the dimension must keep matching the schema. */
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const DEFAULT_BASE_URL = 'http://localhost:11434';

/**
 * Level 16 — upstream timeout for embedding calls.
 *
 * Same reasoning as the generation timeout: an upload holds a Level 14
 * concurrency slot while it embeds, so a stalled embedding server would pin a
 * slot indefinitely. 30 s is generous against the measured ~1.6 s per batch
 * (Level 5) while still failing fast enough to free the slot.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutMs(): number {
  const raw = process.env.OLLAMA_EMBED_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    // A plain Error, not an EmbeddingError: this is operator misconfiguration,
    // not a failure of the embedding domain, and widening the Level 5 error
    // union for it would blur that distinction. It should also not be caught by
    // any `instanceof EmbeddingError` handler and quietly reported as a
    // provider problem.
    throw new Error(`OLLAMA_EMBED_TIMEOUT_MS must be a number >= 1000, received "${raw}".`);
  }
  return parsed;
}

/**
 * Task prefixes required by nomic-embed-text. Stored text and search text are
 * embedded into deliberately different regions of the space.
 */
const DOCUMENT_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';

/**
 * Texts per request. Ollama accepts more, but this machine is CPU-only with
 * two cores — a large batch produces one long unresponsive call and a coarse
 * failure unit, since a single bad text fails the whole batch.
 */
const DEFAULT_BATCH_SIZE = 16;

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

export type EmbeddingErrorCode =
  | 'invalid_input'
  | 'provider_unreachable'
  | 'model_not_found'
  | 'dimension_mismatch'
  | 'provider_error';

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

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
  /** Total tokens consumed by this request, across all inputs. */
  prompt_eval_count?: number;
  error?: string;
}

/** One embedded text with the model's own token count for it. */
export interface EmbeddedText {
  embedding: number[];
  /**
   * Exact token count reported by the embedding model, not an estimate.
   * Only meaningful when the text was embedded on its own — a batched
   * request reports one total for the whole batch.
   */
  tokenCount: number;
}

interface BatchResult {
  embeddings: number[][];
  /** Total for the batch. Per-text only when the batch held one text. */
  promptEvalCount: number;
}

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/embeddings.ts is server-only and must not be imported from a client component.',
    );
  }
}

export function getEmbeddingModel(): string {
  return process.env.OLLAMA_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
}

function getBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Transient failures are worth retrying; a malformed request never is. */
function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingError) {
    return error.code === 'provider_unreachable' || error.code === 'provider_error';
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Embed one batch, with dimension checking.
 *
 * A vector of the wrong width would be silently unusable — pgvector rejects it
 * at insert time with an opaque error, or worse, a future model change makes
 * every stored vector quietly incomparable. Checking here fails at the source.
 */
async function embedBatch(texts: string[], options: EmbedOptions): Promise<BatchResult> {
  const model = getEmbeddingModel();
  const url = `${getBaseUrl()}/api/embed`;

  const budget = AbortSignal.timeout(timeoutMs());
  const combined = options.signal ? AbortSignal.any([options.signal, budget]) : budget;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: combined,
    });
  } catch (caught) {
    // Our budget, not the caller's: report it as the provider being
    // unresponsive so the concurrency slot is released with a real error.
    if (budget.aborted) {
      throw new EmbeddingError(
        'provider_unreachable',
        `The embedding server did not respond within ${timeoutMs()}ms.`,
      );
    }
    if (isAbortError(caught)) throw caught;
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new EmbeddingError(
      'provider_unreachable',
      `Cannot reach the embedding server. Is Ollama running? (${detail})`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => `HTTP ${response.status}`);
    if (response.status === 404) {
      throw new EmbeddingError(
        'model_not_found',
        `Embedding model "${model}" is not installed. Pull it with: ollama pull ${model}`,
      );
    }
    throw new EmbeddingError(
      'provider_error',
      `Embedding request failed with HTTP ${response.status}: ${detail}`,
    );
  }

  const data = (await response.json()) as OllamaEmbedResponse;

  if (data.error) {
    throw new EmbeddingError('provider_error', `Embedding server error: ${data.error}`);
  }

  const embeddings = data.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new EmbeddingError(
      'provider_error',
      `Expected ${texts.length} embeddings, received ${Array.isArray(embeddings) ? embeddings.length : 'none'}.`,
    );
  }

  for (const [index, vector] of embeddings.entries()) {
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION) {
      throw new EmbeddingError(
        'dimension_mismatch',
        `Embedding ${index} has dimension ${Array.isArray(vector) ? vector.length : 'unknown'}, ` +
          `but the database column is vector(${EMBEDDING_DIMENSION}). ` +
          `Model "${model}" does not match the schema — see Level 22 for the reindex procedure.`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingError('provider_error', `Embedding ${index} contains a non-finite value.`);
    }
  }

  return { embeddings, promptEvalCount: data.prompt_eval_count ?? 0 };
}

/** Retry transient failures with exponential backoff. Failures are never swallowed. */
async function embedBatchWithRetry(texts: string[], options: EmbedOptions): Promise<BatchResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await embedBatch(texts, options);
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

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const results: number[][] = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize).map((text) => `${DOCUMENT_PREFIX}${text}`);
    results.push(...(await embedBatchWithRetry(batch, options)).embeddings);
  }

  return results;
}

/**
 * Embed texts for storage and return each one's exact token count.
 *
 * Embeds one text per request, because a batched request reports a single
 * `prompt_eval_count` for the whole batch and per-chunk counts are what the
 * database stores. That is not the cost it sounds like: measured on this
 * machine, ten single calls took 1.63 s against 3.16 s for one ten-text batch,
 * so unbatching is actually faster here as well as more informative.
 *
 * Order is preserved: result[i] corresponds to texts[i].
 */
export async function embedDocumentsWithTokenCounts(
  texts: string[],
  options: EmbedOptions = {},
): Promise<EmbeddedText[]> {
  assertServerOnly();

  if (texts.length === 0) return [];
  validateTexts(texts);

  const results: EmbeddedText[] = [];

  for (const text of texts) {
    const { embeddings, promptEvalCount } = await embedBatchWithRetry(
      [`${DOCUMENT_PREFIX}${text}`],
      options,
    );
    const embedding = embeddings[0];
    if (!embedding) {
      throw new EmbeddingError('provider_error', 'Embedding server returned no vector.');
    }
    results.push({ embedding, tokenCount: promptEvalCount });
  }

  return results;
}

/**
 * Embed a search query.
 *
 * Uses a different task prefix from `embedDocuments`. Embedding a query as
 * though it were a document measurably degrades retrieval, so the two paths
 * are deliberately not interchangeable.
 */
export async function embedQuery(text: string, options: EmbedOptions = {}): Promise<number[]> {
  assertServerOnly();

  validateTexts([text]);

  const [vector] = (await embedBatchWithRetry([`${QUERY_PREFIX}${text}`], options)).embeddings;
  if (!vector) {
    throw new EmbeddingError('provider_error', 'Embedding server returned no vector for the query.');
  }
  return vector;
}
