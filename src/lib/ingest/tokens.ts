/**
 * Token estimation for chunk-boundary decisions.
 *
 * ROADMAP.md specifies no tokenizer — only "approximately 600–900 tokens",
 * "approximately 100 token overlap", and a "token estimate" in the log line.
 * Ollama exposes no tokenize endpoint (verified: /api/tokenize, /api/tokenizer
 * and /api/count_tokens all return 404), so an exact count is only available
 * as a side effect of actually embedding a text.
 *
 * That gives a clean split of responsibilities:
 *
 *   - This estimator decides WHERE to cut. It runs thousands of times while
 *     packing chunks, so it must be fast, offline and deterministic.
 *   - The token_count actually STORED is the model's own `prompt_eval_count`,
 *     taken from the embedding call. Never an estimate.
 *
 * The divisor is calibrated, not invented. Measured against nomic-embed-text
 * over seven varied samples (prose, headings, code, punctuation-heavy text):
 * 3.44 characters per token in aggregate, with a per-sample range of 2.2 to
 * 5.64 — short strings skew low because the model adds special tokens. 3.5 is
 * used as a round figure within that measured range.
 *
 * Because the spread is real, chunk sizes are approximate — which is what the
 * roadmap asks for. The verification script reports the actual distribution so
 * the estimator's effect stays visible rather than assumed.
 */

/** Measured aggregate for nomic-embed-text. See the note above. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate the token count of a text.
 *
 * Used only for boundary decisions. Never stored — `token_count` in the
 * database always comes from the embedding model.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Characters that approximately correspond to a token budget. */
export function tokensToChars(tokens: number): number {
  return Math.max(1, Math.round(tokens * CHARS_PER_TOKEN));
}
