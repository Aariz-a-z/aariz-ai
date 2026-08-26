/**
 * Level 20 — offline / zero-API mode.
 *
 * ROADMAP.md Level 20 asks for `ZERO_API_MODE=true`, under which the LLM,
 * embeddings, retrieval and reranking are all local and there are "no paid AI
 * API calls" — and for the admin interface to say so plainly, so that "it is
 * obvious that the chatbot is not consuming a cloud AI API".
 *
 * TWO SEPARATE JOBS, AND ONLY ONE OF THEM IS A CLAIM
 * --------------------------------------------------
 * This module DESCRIBES the configuration; `src/lib/llm.ts` ENFORCES it. That
 * split matters. A banner reading "Inference mode: LOCAL" is worth nothing if
 * it is only a label — the value of the mode is that a cloud provider becomes
 * unselectable, and that refusal has to live where the provider is chosen.
 * What this module produces is a report, and the report is accurate because
 * the enforcement exists, not the other way round.
 *
 * WHY IT READS THE ENVIRONMENT DIRECTLY
 * -------------------------------------
 * Rather than constructing a provider to ask it what it is. Building one has
 * side effects (`warnIfOllamaLooksExposed` logs), it would fail for a
 * misconfigured deployment that still deserves an honest status page, and
 * `src/lib/llm.ts` uses `@/` path aliases that standalone verification scripts
 * cannot resolve. Deliberately import-free for the same reason
 * `widget-origins.ts` is: it has to work in the App Router and in a plain Node
 * script alike.
 */

/** Providers that run on hardware you control. */
const LOCAL_PROVIDERS = new Set(['ollama']);

/**
 * The value that means "this deployment performs no inference at all".
 *
 * Added for the public Vercel demo (docs/DEPLOYMENT.md, Mode A3). A serverless
 * function cannot reach the `localhost:11434` on a developer's laptop — the
 * address resolves to the function's own container — so a deployment with no
 * reachable model must say so rather than attempt a connection that can only
 * time out.
 *
 * It disables EVERY inference path, not only chat. Document upload embeds each
 * chunk before storing it, so it depends on the same unreachable server;
 * leaving upload enabled would produce a spinner that ends in a timeout, which
 * is a worse lie than an honest refusal.
 */
export const DISABLED_PROVIDER = 'disabled';

export const ZERO_API_MODE_ENV = 'ZERO_API_MODE';

/**
 * Parse a boolean environment variable strictly.
 *
 * A typo must not silently mean "off" for a switch whose whole purpose is to
 * guarantee something. `ZERO_API_MODE=ture` is a configuration error, not a
 * quiet opt-out of the guarantee the operator thought they had enabled.
 */
function readStrictBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be "true" or "false", received "${raw}".`);
}

/**
 * Whether zero-API mode is switched on.
 *
 * Defaults to FALSE, and that is not a weaker default than it looks. The
 * project's default configuration is already fully local — Ollama for
 * generation, `nomic-embed-text` for embeddings, Postgres for retrieval — so
 * the mode does not turn local inference on. It turns the ability to leave
 * local inference OFF. Defaulting it to true would silently forbid a
 * configuration Level 19 deliberately allows.
 */
export function isZeroApiMode(): boolean {
  return readStrictBoolean(ZERO_API_MODE_ENV, false);
}

export function isLocalProvider(providerId: string): boolean {
  return LOCAL_PROVIDERS.has(providerId.trim().toLowerCase());
}

/**
 * Is inference switched off for this deployment?
 *
 * Explicit configuration, never inference-by-detection. Guessing from
 * `process.env.VERCEL` would mean the application behaved differently in a
 * place nobody chose, and would silently disable chat for anyone who did wire
 * up a reachable endpoint on a hosted platform.
 */
export function isGeminiProvider(): boolean {
  return (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase() === 'gemini';
}

export function isInferenceDisabled(): boolean {
  return (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase() === DISABLED_PROVIDER;
}

/**
 * The message shown wherever inference is unavailable.
 *
 * One constant so the API, the first-party UI and the embedded widget cannot
 * drift into telling a visitor three different stories. It names no address,
 * no provider and no environment variable — and it is honest that the
 * capability is absent rather than broken.
 */
export const INFERENCE_DISABLED_MESSAGE =
  'AI chat is currently unavailable on the public demo. ' +
  'Please run AARIZ AI locally to use Ollama-powered chat.';

export type InferenceMode = 'LOCAL' | 'CLOUD' | 'NONE';

export interface InferenceDescription {
  /** The roadmap's "Inference mode". */
  mode: InferenceMode;
  /** The roadmap's "Provider", in the form a human expects to read. */
  provider: string;
  /** The roadmap's "Model". */
  model: string;
  /** Level 5's embedding model — local inference too, and worth stating. */
  embeddingModel: string;
  /** Level 10 requires reranking to be local or disabled; this says which. */
  reranking: string;
  /** Whether the guarantee is enforced, as opposed to merely currently true. */
  zeroApiMode: boolean;
  /**
   * True when every inference component runs locally.
   *
   * Distinct from `zeroApiMode`: a default deployment is entirely local
   * WITHOUT the flag set, and the admin page should say so honestly rather
   * than implying a cloud call is happening just because the switch is off.
   */
  allLocal: boolean;
}

/** Display names. The provider id is a lowercase token; this is for reading. */
const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  disabled: 'none (inference disabled)',
  gemini: 'Google Gemini',
};

/**
 * Describe the configured inference stack.
 *
 * Never throws on a missing model: a status page that crashes when
 * configuration is wrong is a status page that stops working exactly when it
 * is needed. Absent values are reported as "not configured".
 */
export function describeInference(): InferenceDescription {
  const providerId = (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();
  const local = isLocalProvider(providerId);
  const disabled = providerId === DISABLED_PROVIDER;

  const model =
    (providerId === 'ollama' ? process.env.OLLAMA_MODEL?.trim() : undefined) || 'not configured';

  const embeddingModel = process.env.OLLAMA_EMBED_MODEL?.trim() || 'nomic-embed-text';

  // Mirrors src/lib/rerank.ts, whose default is off. Both strategies it can
  // run — lexical and llm — are local, so reranking never reaches a cloud API
  // whatever this says.
  const rerankEnabled = (process.env.RERANK_ENABLED ?? 'false').trim().toLowerCase();
  const rerankStrategy = (process.env.RERANK_STRATEGY ?? 'lexical').trim().toLowerCase();
  const reranking =
    rerankEnabled === 'true' || rerankEnabled === '1' ? `${rerankStrategy} (local)` : 'disabled';

  return {
    // A deployment that performs no inference is neither local nor cloud, and
    // saying "CLOUD" would imply a paid API is being called. It is NONE.
    mode: disabled ? 'NONE' : local ? 'LOCAL' : 'CLOUD',
    provider: PROVIDER_LABELS[providerId] ?? providerId,
    model,
    embeddingModel,
    reranking,
    zeroApiMode: isZeroApiMode(),
    // Embeddings and retrieval have no cloud path in this application at all —
    // `nomic-embed-text` runs on Ollama and search is SQL — so whether
    // everything is local reduces to the generation provider. A disabled
    // deployment is not "all local": it runs nothing.
    allLocal: local,
  };
}
