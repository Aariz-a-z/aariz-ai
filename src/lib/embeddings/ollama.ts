/**
 * Ollama embedding adapter.
 *
 * The Level 5 implementation, moved behind the provider interface unchanged.
 * Its behaviour is deliberately identical: the same endpoint, the same task
 * prefixes, the same error mapping. Local development must keep working
 * exactly as it did, and the safest way to guarantee that is to move the code
 * rather than rewrite it.
 *
 * Two endpoints exist and they do NOT return the same thing:
 *
 *   POST /api/embed       -> { embeddings: [[...]] }   L2-normalised (norm = 1)
 *   POST /api/embeddings  -> { embedding:   [...]  }   raw, NOT normalised
 *
 * This uses `/api/embed`. Mixing the two corrupts similarity scores.
 */

import {
  EmbeddingError,
  type BatchResult,
  type EmbedOptions,
  type EmbedTask,
  type EmbeddingProvider,
} from './types.ts';

const DEFAULT_MODEL = 'nomic-embed-text';
const DEFAULT_BASE_URL = 'http://localhost:11434';

/**
 * Task prefixes required by nomic-embed-text. Stored text and search text are
 * embedded into deliberately different regions of the space.
 */
const DOCUMENT_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';

/**
 * Level 16 — upstream timeout for embedding calls.
 *
 * An upload holds a Level 14 concurrency slot while it embeds, so a stalled
 * embedding server would pin a slot indefinitely. 30 s is generous against the
 * measured ~1.6 s per batch (Level 5) while still failing fast enough to free
 * the slot.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutMs(): number {
  const raw = process.env.OLLAMA_EMBED_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    throw new Error(`OLLAMA_EMBED_TIMEOUT_MS must be a number >= 1000, received "${raw}".`);
  }
  return parsed;
}

export function getOllamaEmbedModel(): string {
  return process.env.OLLAMA_EMBED_MODEL?.trim() || DEFAULT_MODEL;
}

function getBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
  /** Total tokens consumed by this request, across all inputs. */
  prompt_eval_count?: number;
  error?: string;
}

export function createOllamaEmbeddingProvider(): EmbeddingProvider {
  const model = getOllamaEmbedModel();

  return {
    id: 'ollama',
    model,

    async embedBatch(texts: string[], task: EmbedTask, options: EmbedOptions): Promise<BatchResult> {
      const prefix = task === 'query' ? QUERY_PREFIX : DOCUMENT_PREFIX;
      const url = `${getBaseUrl()}/api/embed`;

      const budget = AbortSignal.timeout(timeoutMs());
      const combined = options.signal ? AbortSignal.any([options.signal, budget]) : budget;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts.map((text) => `${prefix}${text}`) }),
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

      // Dimension and finiteness checking stay in the factory above, so every
      // provider is held to the same schema by the same code. Only the shape
      // of this response is the adapter's business.
      return { embeddings, promptEvalCount: data.prompt_eval_count ?? 0 };
    },
  };
}
