/**
 * Google Gemini generation adapter.
 *
 * Implements the Level 3 `LlmProvider` contract over Gemini's REST API with
 * `fetch` and no SDK — the same choice the Ollama adapter beside it makes, for
 * the same reason: the surface used here is one endpoint in two modes, and a
 * dependency that must be kept current to send a JSON body is a liability.
 *
 * WHAT THE MESSAGE MAPPING HAS TO RECONCILE
 * -----------------------------------------
 * The application speaks `system` / `user` / `assistant` (Level 3). Gemini has
 * no system role in its turn list: instructions go in a separate
 * `systemInstruction` field, and the model's own turns are called `model`.
 *
 * That distinction is load-bearing rather than cosmetic. Level 8 puts the
 * grounding rules in the system message and retrieved document text in the
 * user turn, precisely so a document cannot rewrite the instructions. Folding
 * the system prompt into the first user turn — the obvious shortcut — would
 * collapse that boundary and hand every uploaded document a route into the
 * instruction channel.
 *
 * WHAT IS NEVER SURFACED
 * ----------------------
 * The API key, obviously, but also the upstream error text: Google's messages
 * can echo request content and name internal services, and these errors reach
 * a user through the chat route. Failures are mapped onto `LlmErrorCode` and
 * the detail goes to the server log instead.
 */

import { LlmError, type LlmMessage, type LlmProvider, type LlmStreamOptions } from './types.ts';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Default model, verified against a real key rather than documentation.
 *
 * Two documented defaults were tried and both failed against a live key.
 * `gemini-2.0-flash` does not exist; `gemini-2.5-flash` returned 404 with the
 * API's own instruction:
 *
 *     "This model models/gemini-2.5-flash is no longer available to new
 *      users. Please update your code to use models/gemini-3.6-flash"
 *
 * So this default is the one Google names, confirmed working. Google retires
 * model ids, and a documented default is a guess until something calls the
 * API — expect to revisit this.
 *
 * THINKING TOKENS COME OUT OF THE SAME BUDGET
 * -------------------------------------------
 * Gemini 3.x models reason internally before answering, and those tokens are
 * charged against `maxOutputTokens`. Measured on a six-token prompt: 69
 * thinking tokens before any text. With too small a ceiling the response comes
 * back `finishReason: MAX_TOKENS` with EMPTY content — an answer that silently
 * is not there.
 *
 * The Level 14 ceilings (384 anonymous / 512 authenticated) were verified to
 * leave room. They are not raised here: that is a cost control, and changing
 * it is the operator's call, not this adapter's.
 *
 * `thinkingConfig: { thinkingBudget: 0 }` does NOT work — this model rejects
 * it with 400 — so thinking cannot be switched off to reclaim the budget.
 */
const DEFAULT_MODEL = 'gemini-3.6-flash';

/**
 * Shorter than the 120 s Ollama budget, deliberately.
 *
 * That budget exists because a local CPU genuinely takes ~31 s to answer
 * (Level 11). A hosted API does not, and one that has gone quiet for a minute
 * has failed. Still generous enough for a long grounded answer.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface GeminiConfig {
  apiKey: string;
  model: string;
}

function timeoutMs(): number {
  const raw = process.env.GEMINI_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    throw new LlmError(
      'invalid_configuration',
      `GEMINI_TIMEOUT_MS must be a number >= 1000, received "${raw}".`,
      500,
    );
  }
  return parsed;
}

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

/**
 * Split our messages into Gemini's shape.
 *
 * System messages are concatenated into `systemInstruction`; everything else
 * becomes a turn with `user` or `model`. See the note at the top for why the
 * system content must not be merged into a user turn.
 */
function toGeminiRequest(messages: LlmMessage[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: { role: 'user' | 'model'; parts: GeminiPart[] }[];
} {
  const systemParts: GeminiPart[] = [];
  const contents: { role: 'user' | 'model'; parts: GeminiPart[] }[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push({ text: message.content });
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }

  return {
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
  };
}

/** Map an upstream status onto our vocabulary. The upstream text is discarded. */
function errorFromStatus(status: number, model: string): LlmError {
  if (status === 400) {
    return new LlmError(
      'invalid_configuration',
      'The model request was rejected. Check GEMINI_API_KEY and the configured model.',
      500,
    );
  }
  if (status === 401 || status === 403) {
    return new LlmError('invalid_configuration', 'The configured API key was rejected.', 500);
  }
  if (status === 404) {
    return new LlmError('model_not_found', `Model "${model}" is not available to this key.`, 503);
  }
  if (status === 429) {
    // Mapped to provider_error rather than a new code so the Level 3 union is
    // untouched; the chat route turns this into a 502 the user can act on, and
    // the application's own budget (Level 14 + the Gemini category) is what
    // should normally prevent ever reaching it.
    return new LlmError('provider_error', 'The model provider is over its quota.', 502);
  }
  if (status >= 500) {
    return new LlmError('provider_error', 'The model provider reported a server error.', 502);
  }
  return new LlmError('provider_error', `The model request failed (HTTP ${status}).`, 502);
}

export function createGeminiProvider(config: GeminiConfig): LlmProvider {
  const { apiKey, model } = config;

  async function post(streaming: boolean, options: LlmStreamOptions): Promise<Response> {
    const method = streaming ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${API_BASE}/models/${encodeURIComponent(model)}:${method}`;

    const { systemInstruction, contents } = toGeminiRequest(options.messages);

    const body = {
      ...(systemInstruction ? { systemInstruction } : {}),
      contents,
      generationConfig: {
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        // Level 14's per-caller output ceiling, honoured identically here so a
        // provider switch cannot quietly remove a cost control.
        ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
      },
    };

    const budget = AbortSignal.timeout(timeoutMs());
    const combined = options.signal ? AbortSignal.any([options.signal, budget]) : budget;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        // The key goes in a header, never the query string: a URL is the part
        // most likely to reach an access log or a proxy trace.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (caught) {
      if (budget.aborted) {
        throw new LlmError(
          'provider_error',
          `The model provider did not respond within ${timeoutMs()}ms.`,
          504,
        );
      }
      // A caller-initiated abort must propagate untouched so the route can
      // tell "user pressed Stop" from "provider failed".
      if (caught instanceof Error && caught.name === 'AbortError') throw caught;
      throw new LlmError('provider_unreachable', 'Could not reach the model provider.', 503);
    }

    if (!response.ok) {
      await response.text().catch(() => undefined);
      throw errorFromStatus(response.status, model);
    }
    return response;
  }

  /** Pull the text out of one response object, refusing a blocked generation. */
  function textFrom(data: GeminiResponse): string {
    if (data.error) {
      throw new LlmError('provider_error', 'The model provider returned an error.', 502);
    }
    if (data.promptFeedback?.blockReason) {
      // Surfaced as a refusal rather than a crash, and without the category —
      // which can be revealing about the question that was asked.
      throw new LlmError('provider_error', 'The request was blocked by the provider.', 502);
    }
    return (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');
  }

  return {
    id: 'gemini',
    model,

    async generate(options: LlmStreamOptions): Promise<string> {
      const response = await post(false, options);
      return textFrom((await response.json()) as GeminiResponse);
    },

    async *stream(options: LlmStreamOptions): AsyncGenerator<string, void, unknown> {
      const response = await post(true, options);

      if (response.body === null) {
        throw new LlmError('provider_error', 'The model provider returned an empty body.', 502);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Server-sent events: `data: {json}` per line, blank lines between.
          let newline: number;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);

            if (line.length === 0 || !line.startsWith('data:')) continue;

            const payload = line.slice('data:'.length).trim();
            if (payload === '[DONE]') return;

            let chunk: GeminiResponse;
            try {
              chunk = JSON.parse(payload) as GeminiResponse;
            } catch {
              // A partial frame is not a failure; the next read completes it.
              continue;
            }

            const text = textFrom(chunk);
            if (text.length > 0) yield text;
          }
        }
      } finally {
        // Releases the connection on abort, error, or early return.
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
