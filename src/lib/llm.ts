/**
 * Provider selection — the single entry point for model access.
 *
 * Application code imports from here and never from `llm/ollama`. Adding a
 * provider means adding a case below and an adapter file; nothing else in the
 * application changes (Roadmap Rule 8, Level 19).
 *
 * Server-only. The configuration it reads (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`)
 * is intentionally un-prefixed, so Next.js never inlines it into the client
 * bundle. The runtime guard below turns an accidental client import into an
 * immediate, obvious failure rather than a silent `undefined`.
 */

import { createOllamaProvider } from '@/lib/llm/ollama';
import {
  DISABLED_PROVIDER,
  INFERENCE_DISABLED_MESSAGE,
  isLocalProvider,
  isZeroApiMode,
} from '@/lib/inference-mode';
import { warnIfOllamaLooksExposed } from '@/lib/rate-limit';
import { LlmError, type LlmProvider } from '@/lib/llm/types';

export type { LlmMessage, LlmProvider, LlmRole, LlmStreamOptions } from '@/lib/llm/types';
export { LlmError, isAbortError } from '@/lib/llm/types';

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/llm.ts is server-only and must not be imported from a client component.',
    );
  }
}

/**
 * Build the configured provider.
 *
 * Throws `LlmError` with `invalid_configuration` rather than falling back to a
 * default model: a silently wrong model would produce plausible answers from
 * something the user never chose.
 */
export function getLlmProvider(): LlmProvider {
  assertServerOnly();

  const providerId = (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();

  /**
   * Level 20 — the teeth behind "no paid AI API calls".
   *
   * Checked BEFORE the switch, so it applies to every provider that exists now
   * and every one added later: a new cloud adapter is refused by default
   * rather than needing to remember to add itself to a list. This is what
   * makes the admin page's "Inference mode: LOCAL" a guarantee instead of a
   * label — with the mode on, there is no configuration that reaches a cloud
   * API, including one set by an operator who did not realise.
   *
   * The message names the mode so the cause is obvious, and names no
   * credential or endpoint.
   */
  if (isZeroApiMode() && !isLocalProvider(providerId)) {
    throw new LlmError(
      'invalid_configuration',
      `ZERO_API_MODE is enabled, so only a local provider may be used. ` +
        `LLM_PROVIDER="${providerId}" is not local.`,
      500,
    );
  }

  switch (providerId) {
    case 'ollama': {
      const model = process.env.OLLAMA_MODEL?.trim();
      if (!model) {
        throw new LlmError(
          'invalid_configuration',
          'OLLAMA_MODEL is not set. Choose a model in .env.local.',
          500,
        );
      }
      const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL;

      // ROADMAP.md Level 14: "Do not expose the Ollama server directly to the
      // public internet without appropriate authentication/network controls."
      // Ollama authenticates nobody, so anything that can reach it can use it
      // and manage installed models. Warned once, server-side; the address is
      // never sent to a client.
      warnIfOllamaLooksExposed(baseUrl);

      return createOllamaProvider({ baseUrl, model });
    }

    /**
     * No inference in this deployment (docs/DEPLOYMENT.md Mode A3).
     *
     * A distinct case rather than an unreachable `OLLAMA_BASE_URL`, because
     * the two are different situations and deserve different words: an
     * unreachable endpoint is a fault, this is a deliberate configuration.
     * Callers get the honest public message; nothing is attempted.
     */
    case DISABLED_PROVIDER:
      throw new LlmError('not_implemented', INFERENCE_DISABLED_MESSAGE, 503);

    case 'gemini':
      throw new LlmError(
        'not_implemented',
        'LLM_PROVIDER=gemini is not implemented. The default architecture is self-hosted.',
        501,
      );

    default:
      throw new LlmError(
        'invalid_configuration',
        `Unknown LLM_PROVIDER "${providerId}". Supported: ollama, disabled.`,
        500,
      );
  }
}
