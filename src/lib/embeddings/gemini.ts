/**
 * Google Gemini embedding adapter.
 *
 * REST over `fetch`, with no SDK. The Ollama adapter beside it already
 * establishes that pattern, the surface used here is two endpoints, and a
 * dependency that has to be kept current in order to send one JSON body is a
 * liability rather than a convenience.
 *
 * DIMENSION IS THE WHOLE RISK
 * ---------------------------
 * `chunks.embedding` is `vector(768)`, and that number appears in both search
 * RPCs' signatures. Every embedding model currently reachable returns 3072 by
 * default, so this adapter ALWAYS requests `outputDimensionality: 768`. The
 * schema is preserved with no migration; the truncation happens upstream.
 *
 * That default was set by calling the API, not by reading about it. The
 * documented `text-embedding-004` — which does return 768 natively — is no
 * longer available: ListModels offers only `gemini-embedding-001`,
 * `gemini-embedding-2-preview` and `gemini-embedding-2`, and asking for the
 * documented one returns 404.
 *
 * Whatever comes back, the factory above checks its width against
 * `EMBEDDING_DIMENSION` and refuses a mismatch — so a wrong model produces a
 * precise error at the first call, not a corrupted index discovered later.
 *
 * SAME WIDTH IS NOT THE SAME SPACE
 * --------------------------------
 * A Gemini vector and a nomic vector of equal length are not comparable;
 * cosine similarity between them is meaningless. Switching providers on a
 * populated corpus therefore requires the Level 22 re-ingestion
 * (`npm run reingest`), and `promote_reindex`'s per-row model guard will
 * refuse a half-migrated index on its own.
 */

import { EMBEDDING_DIMENSION } from '../../types/database.ts';
import {
  EmbeddingError,
  type BatchResult,
  type EmbedOptions,
  type EmbedTask,
  type EmbeddingProvider,
} from './types.ts';

/**
 * Verified against a real key rather than taken from documentation.
 *
 * `text-embedding-004` is documented widely and is NOT available: a live
 * ListModels call returned only `gemini-embedding-001`,
 * `gemini-embedding-2-preview` and `gemini-embedding-2`. Asking for the
 * documented model produced a 404, which is precisely the class of error no
 * amount of reading could have caught.
 *
 * `gemini-embedding-001` returns 3072 dimensions by default, so it MUST be
 * asked to truncate — see `outputDimensionality` below.
 */
const DEFAULT_MODEL = 'gemini-embedding-001';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Shorter than the Ollama budget on purpose. A hosted API that has not
 * answered in fifteen seconds is not slow, it is failing — and unlike a local
 * model there is no cold start to wait through.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

function timeoutMs(): number {
  const raw = process.env.GEMINI_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    throw new Error(`GEMINI_TIMEOUT_MS must be a number >= 1000, received "${raw}".`);
  }
  return parsed;
}

export function getGeminiEmbedModel(): string {
  return process.env.GEMINI_EMBED_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * Truncation width, defaulting to the schema's own dimension.
 *
 * This defaults to 768 rather than being omitted, and that changed once the
 * API was actually called. Every embedding model this key can reach is a
 * `gemini-embedding-*` model returning 3072 by default — which the factory
 * would reject against a `vector(768)` column. Omitting the field would make
 * the out-of-the-box configuration fail on its first upload.
 *
 * Set explicitly only to override. All currently available models accept it.
 */
function outputDimensionality(): number {
  const raw = process.env.GEMINI_EMBED_DIMENSIONS?.trim();
  if (!raw) return EMBEDDING_DIMENSION;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`GEMINI_EMBED_DIMENSIONS must be a positive integer, received "${raw}".`);
  }
  return parsed;
}

function requireApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    // Names the variable, never a value — there is no value to name.
    throw new EmbeddingError(
      'invalid_credentials',
      'GEMINI_API_KEY is not set. Add it to the server environment.',
    );
  }
  return key;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Gemini's `taskType`, which replaces nomic's text prefixes. */
function taskType(task: EmbedTask): string {
  return task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
}

interface GeminiEmbedResponse {
  embeddings?: { values?: number[] }[];
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Map an upstream failure onto our own vocabulary.
 *
 * The upstream message is deliberately NOT propagated. Google's errors can
 * echo request content and name internal services, and this string reaches a
 * user through the ingestion path. The detail belongs in the server log; the
 * caller gets a category.
 */
function errorFromStatus(status: number): EmbeddingError {
  if (status === 400) {
    return new EmbeddingError(
      'invalid_credentials',
      'The embedding request was rejected. Check GEMINI_API_KEY and the configured model.',
    );
  }
  if (status === 401 || status === 403) {
    return new EmbeddingError('invalid_credentials', 'The configured API key was rejected.');
  }
  if (status === 404) {
    return new EmbeddingError(
      'model_not_found',
      `Embedding model "${getGeminiEmbedModel()}" is not available to this key.`,
    );
  }
  if (status === 429) {
    return new EmbeddingError(
      'quota_exceeded',
      'The embedding provider is over its quota. Try again later.',
    );
  }
  if (status >= 500) {
    return new EmbeddingError('provider_error', 'The embedding provider reported a server error.');
  }
  return new EmbeddingError('provider_error', `The embedding request failed (HTTP ${status}).`);
}

export function createGeminiEmbeddingProvider(): EmbeddingProvider {
  const model = getGeminiEmbedModel();

  return {
    id: 'gemini',
    model,

    async embedBatch(texts: string[], task: EmbedTask, options: EmbedOptions): Promise<BatchResult> {
      const key = requireApiKey();
      const dimensions = outputDimensionality();

      // The key travels in a header, not the query string: a URL is the part
      // most likely to be written to an access log or a proxy trace.
      const url = `${API_BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`;

      const body = {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType: taskType(task),
          outputDimensionality: dimensions,
        })),
      };

      const budget = AbortSignal.timeout(timeoutMs());
      const combined = options.signal ? AbortSignal.any([options.signal, budget]) : budget;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': key,
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (caught) {
        if (budget.aborted) {
          throw new EmbeddingError(
            'provider_unreachable',
            `The embedding provider did not respond within ${timeoutMs()}ms.`,
          );
        }
        if (isAbortError(caught)) throw caught;
        // The underlying message can contain the resolved host; not surfaced.
        throw new EmbeddingError('provider_unreachable', 'Could not reach the embedding provider.');
      }

      if (!response.ok) {
        // Drained and discarded: read so the socket is released, not so the
        // contents can be shown to anyone.
        await response.text().catch(() => undefined);
        throw errorFromStatus(response.status);
      }

      const data = (await response.json()) as GeminiEmbedResponse;

      if (data.error) {
        throw new EmbeddingError('provider_error', 'The embedding provider returned an error.');
      }

      const returned = data.embeddings;
      if (!Array.isArray(returned) || returned.length !== texts.length) {
        throw new EmbeddingError(
          'provider_error',
          `Expected ${texts.length} embeddings, received ${Array.isArray(returned) ? returned.length : 'none'}.`,
        );
      }

      const embeddings = returned.map((entry) => entry.values ?? []);

      /**
       * Gemini reports no token count for embeddings.
       *
       * Zero rather than an estimate: `chunks.token_count` has always held the
       * model's own figure, and quietly substituting a guess would make a
       * stored column mean two different things depending on which provider
       * wrote the row.
       */
      return { embeddings, promptEvalCount: 0 };
    },
  };
}
