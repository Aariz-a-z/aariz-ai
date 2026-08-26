/**
 * Provider-agnostic LLM contract.
 *
 * Nothing in this file mentions Ollama, HTTP, or any vendor. The rest of the
 * application depends on these types alone, so swapping the provider (Roadmap
 * Rule 8, Level 19) touches only the adapter behind them.
 *
 * `embed()` is deliberately absent. The roadmap lists it as part of the
 * abstraction, but embeddings arrive at Level 5 — declaring a method now that
 * every implementation would have to stub out is dead code, so it joins this
 * interface when there is something real behind it.
 */

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export interface LlmStreamOptions {
  /** Full turn list, oldest first. A system message, if any, comes first. */
  messages: LlmMessage[];
  /** Aborted when the caller stops generation. */
  signal?: AbortSignal;
  /** 0 = deterministic. Defaults to the provider's own default. */
  temperature?: number;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
}

export interface LlmProvider {
  /** Stable identifier, e.g. "ollama". Safe to log. */
  readonly id: string;
  /** Model tag in use. Server-side only — never send this to a browser. */
  readonly model: string;
  /** Buffered generation. Returns the complete text. */
  generate(options: LlmStreamOptions): Promise<string>;
  /** Incremental generation. Yields text deltas as they arrive. */
  stream(options: LlmStreamOptions): AsyncGenerator<string, void, unknown>;
}

/**
 * Why a provider call failed, in terms the API layer can map to HTTP without
 * knowing which provider produced it.
 */
export type LlmErrorCode =
  | 'invalid_configuration'
  | 'provider_unreachable'
  | 'model_not_found'
  | 'provider_error'
  | 'not_implemented';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  /** Suggested HTTP status for the API layer. */
  readonly status: number;

  constructor(code: LlmErrorCode, message: string, status: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

/** True for a deliberate abort rather than a failure. */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
