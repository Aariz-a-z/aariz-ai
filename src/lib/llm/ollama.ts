/**
 * Ollama adapter.
 *
 * The only file in the application that knows Ollama exists.
 *
 * Every endpoint and payload shape here was verified against the running
 * server at Level 2 (Ollama 0.30.11) rather than recalled:
 *
 *   POST /api/chat  { model, messages, stream, options }
 *     stream=false -> one JSON object: { message: { content }, done, ... }
 *     stream=true  -> NDJSON, one JSON object per line, final line done=true
 *
 * Timing fields (`load_duration`, `prompt_eval_duration`, `eval_duration`) are
 * nanoseconds. They are not consumed here; `scripts/bench-ollama.ts` reads them.
 */

// Relative rather than the `@/lib` alias, matching `gemini.ts` beside it.
// Next resolves the alias and plain Node does not, so the alias made this
// module unloadable from any verification script — the Ollama half of
// `verify-grounding.ts` crashed on it while the Gemini half ran fine.
import {
  LlmError,
  isAbortError,
  type LlmProvider,
  type LlmStreamOptions,
} from './types.ts';

export interface OllamaProviderConfig {
  baseUrl: string;
  model: string;
}

/**
 * Default ceiling on generated tokens.
 *
 * This is a hardware guard, not the Level 14 abuse-protection system: on a
 * 2-core CPU an unbounded generation can run for many minutes with no way for
 * the user to tell a slow answer from a hung one. Level 14 adds real per-user
 * and per-IP limits on top.
 */
const DEFAULT_MAX_TOKENS = 512;

/**
 * Level 16 — upstream timeout.
 *
 * Before this, a stalled Ollama held the request open until the client gave up.
 * That is worse than it sounds in combination with the Level 14 concurrency
 * cap: a hung request keeps its slot, and with only two slots, TWO stalls take
 * the whole service down and every later caller sees 429 forever. The timeout
 * is what makes the concurrency limiter recoverable rather than a latch.
 *
 * This is a TOTAL-DURATION budget covering the response and the streamed body,
 * not an idle timeout. 120 s sits well clear of the measured p95 of 43-66 s
 * (Level 11), and generation length is separately bounded by `num_predict`, so
 * a legitimate answer should never approach it.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

function timeoutMs(): number {
  const raw = process.env.OLLAMA_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    throw new LlmError(
      'invalid_configuration',
      `OLLAMA_TIMEOUT_MS must be a number >= 1000, received "${raw}".`,
      500,
    );
  }
  return parsed;
}

/** One line of Ollama's NDJSON stream, or its single non-streaming response. */
interface OllamaChatChunk {
  message?: { role: string; content: string };
  done?: boolean;
  done_reason?: string;
  /** Ollama reports in-band failures on this field with HTTP 200. */
  error?: string;
}

function buildRequestBody(config: OllamaProviderConfig, options: LlmStreamOptions, stream: boolean) {
  return JSON.stringify({
    model: config.model,
    messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
    stream,
    options: {
      temperature: options.temperature ?? 0.2,
      num_predict: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    },
  });
}

/** Turn transport-level failures into typed, mappable errors. */
function toLlmError(error: unknown, baseUrl: string): LlmError {
  // A refused connection is by far the most common cause: server not started.
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND|ECONNRESET/i.test(message)) {
    return new LlmError(
      'provider_unreachable',
      `Cannot reach the Ollama server at ${baseUrl}. Is it running?`,
      503,
    );
  }
  return new LlmError('provider_error', message, 502);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: string };
      return parsed.error ?? text;
    } catch {
      return text;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Map a non-2xx from Ollama onto a typed error. */
async function errorFromResponse(response: Response, model: string): Promise<LlmError> {
  const detail = await readErrorBody(response);

  if (response.status === 404) {
    return new LlmError(
      'model_not_found',
      `Model "${model}" is not installed on the Ollama server (${detail}).`,
      503,
    );
  }
  return new LlmError('provider_error', `Ollama returned ${response.status}: ${detail}`, 502);
}

export function createOllamaProvider(config: OllamaProviderConfig): LlmProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');

  async function post(body: string, signal: AbortSignal | undefined): Promise<Response> {
    // The caller's cancellation and our own budget are separate causes, kept
    // distinguishable so a user pressing Stop is not reported as a timeout.
    const budget = AbortSignal.timeout(timeoutMs());
    const combined = signal ? AbortSignal.any([signal, budget]) : budget;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: combined,
      });
    } catch (caught) {
      // Our budget expired: the model server is unresponsive, which is a
      // provider fault and must surface as one so the slot is released and the
      // caller gets a real error instead of an open socket.
      if (budget.aborted) {
        throw new LlmError(
          'provider_error',
          `The model server did not respond within ${timeoutMs()}ms.`,
          504,
        );
      }
      // An abort is the caller's decision, not a provider fault — pass it through.
      if (isAbortError(caught)) throw caught;
      throw toLlmError(caught, baseUrl);
    }

    if (!response.ok) {
      throw await errorFromResponse(response, config.model);
    }
    return response;
  }

  return {
    id: 'ollama',
    model: config.model,

    async generate(options: LlmStreamOptions): Promise<string> {
      const response = await post(buildRequestBody(config, options, false), options.signal);
      const data = (await response.json()) as OllamaChatChunk;

      if (data.error) {
        throw new LlmError('provider_error', `Ollama error: ${data.error}`, 502);
      }
      return data.message?.content ?? '';
    },

    async *stream(options: LlmStreamOptions): AsyncGenerator<string, void, unknown> {
      const response = await post(buildRequestBody(config, options, true), options.signal);

      if (response.body === null) {
        throw new LlmError('provider_error', 'Ollama returned an empty response body.', 502);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // NDJSON: complete lines only; a partial tail waits for more bytes.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;

            let chunk: OllamaChatChunk;
            try {
              chunk = JSON.parse(trimmed) as OllamaChatChunk;
            } catch {
              throw new LlmError('provider_error', `Malformed NDJSON line from Ollama: ${trimmed}`, 502);
            }

            // Ollama can report a mid-stream failure inside a 200 response.
            if (chunk.error) {
              throw new LlmError('provider_error', `Ollama error: ${chunk.error}`, 502);
            }

            const text = chunk.message?.content;
            if (text) yield text;

            if (chunk.done) return;
          }
        }
      } finally {
        // Releases the upstream connection on abort or early return.
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
