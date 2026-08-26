/**
 * Level 10 — local lexical reranker.
 *
 * No model call, no network, no dependency, sub-millisecond. It is therefore
 * always available, which matters: ROADMAP.md Level 10 requires that reranking
 * never break the chatbot, and a strategy that cannot fail is the strongest
 * form of that guarantee.
 *
 * WHAT IT ADDS THAT HYBRID SEARCH DOES NOT ALREADY HAVE
 * -----------------------------------------------------
 * Level 9 fuses the two arms with Reciprocal Rank Fusion, which is deliberately
 * *rank-only*: it uses each arm's ordering and throws the actual scores away.
 * That is the right call for fusing incomparable scales, but it loses real
 * information, and the loss is what this stage recovers:
 *
 *   1. MAGNITUDE. To RRF, a chunk the vector arm ranked first at similarity
 *      0.51 and one it ranked first at 0.88 are identical. Worse, a mediocre
 *      chunk found by both arms (1/61 + 1/61 = 0.0328) outranks an excellent
 *      chunk found by one (1/61 = 0.0164). Restoring magnitude corrects that.
 *
 *   2. EXACT SURFACE FORM. The keyword arm matches against `content_tsv`,
 *      which is stemmed and stripped of stopwords. Matching the raw text
 *      recovers the exact wording a user typed, which is precisely what a
 *      query like "full jitter" or "SEV3" depends on.
 *
 *   3. REDUNDANCY. Neither arm knows that three of the five chunks it is about
 *      to return say the same thing. Filling the context window with
 *      near-duplicates wastes the budget Level 8 has to ration.
 *
 * TERM WEIGHTING
 * --------------
 * Query terms are weighted by inverse document frequency computed over the
 * candidate set itself. A term present in every candidate discriminates
 * nothing and is worth nothing; a term in one candidate is decisive. This
 * replaces the hand-written "is it an identifier?" heuristic the first sketch
 * of this file had — IDF derives the same conclusion from the data instead of
 * from a regex, and cannot be wrong about a corpus it has actually measured.
 */

import type { HybridRetrievalResult } from '../retrieval.ts';
import type { Reranker, RerankedResult, RerankOptions } from './types.ts';

/**
 * Relevance weights.
 *
 * Chosen a priori from what each signal means, and deliberately NOT tuned
 * against the Level 10 fixture: the vector arm is the primary evidence of
 * relevance, exact term coverage is the correction the embedding is worst at,
 * and full-text magnitude confirms rather than leads. Fitting these three
 * numbers to the evaluation set would make "quality improved" a statement
 * about the tuning rather than about the technique.
 */
const WEIGHT_SIMILARITY = 0.5;
const WEIGHT_COVERAGE = 0.3;
const WEIGHT_KEYWORD = 0.2;

/**
 * Maximal Marginal Relevance trade-off. 1.0 is pure relevance, 0.0 is pure
 * diversity. 0.7 is the conventional starting point and keeps relevance
 * dominant while still breaking up runs of near-identical chunks.
 *
 * Note this cannot affect the top result: with nothing yet selected, the
 * redundancy term is zero, so position 1 is decided by relevance alone.
 */
const MMR_LAMBDA = 0.7;

/**
 * Words carrying no retrieval signal. Short by design — an aggressive list
 * removes terms that discriminate in a technical corpus, and IDF already
 * neutralises anything that turns out to be ubiquitous.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'his', 'has', 'had', 'how', 'its', 'who', 'did', 'does',
  'that', 'this', 'with', 'from', 'they', 'been', 'have', 'were', 'what',
  'when', 'will', 'would', 'there', 'their', 'which', 'about', 'into', 'than',
  'them', 'then', 'these', 'those', 'some', 'such', 'only', 'other', 'more',
  'must', 'should', 'could', 'before', 'after', 'while', 'being', 'each',
  'do', 'is', 'it', 'of', 'to', 'in', 'on', 'at', 'by', 'be', 'as', 'an', 'or',
  'if', 'we', 'us', 'so', 'no', 'up',
]);

/**
 * Split text into comparable terms.
 *
 * Splitting on every non-alphanumeric run means "ERR-4471" yields "err" and
 * "4471" while "SEV3" stays whole — both remain matchable. No stemming is
 * applied on purpose: the full-text arm already contributes the stemmed view,
 * and this stage exists to supply the exact-form view it lacks.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Min-max normalisation to [0, 1]. A flat input carries no signal, so 0.5. */
function normalise(values: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return values.map(() => 0.5);
  return values.map((value) => (value - min) / span);
}

/** Overlap between two token sets, in [0, 1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  // Iterate the smaller set: the result is symmetric and this bounds the work.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

export function createLexicalReranker(): Reranker {
  return {
    id: 'lexical',

    async rerank(
      query: string,
      candidates: HybridRetrievalResult[],
      options: RerankOptions,
    ): Promise<RerankedResult[]> {
      const queryTerms = [...new Set(tokenize(query))];
      const tokenSets = candidates.map((c) => new Set(tokenize(c.content)));

      // --- Inverse document frequency over the candidate set ----------------
      const total = candidates.length;
      const idf = new Map<string, number>();
      for (const term of queryTerms) {
        let df = 0;
        for (const set of tokenSets) if (set.has(term)) df++;
        idf.set(term, Math.log(1 + total / (1 + df)));
      }
      const idfTotal = queryTerms.reduce((sum, term) => sum + (idf.get(term) ?? 0), 0);

      // --- Per-candidate signals -------------------------------------------
      const coverage = tokenSets.map((set) => {
        if (idfTotal <= 0) return 0;
        let matched = 0;
        for (const term of queryTerms) if (set.has(term)) matched += idf.get(term) ?? 0;
        return matched / idfTotal;
      });

      const similarity = normalise(candidates.map((c) => c.similarity));
      // A null keyword score means the full-text arm never surfaced this chunk,
      // which is an absence of evidence rather than a low score — 0 is correct.
      const keyword = normalise(candidates.map((c) => c.keywordScore ?? 0));

      const relevance = candidates.map(
        (_, i) =>
          WEIGHT_SIMILARITY * (similarity[i] ?? 0) +
          WEIGHT_COVERAGE * (coverage[i] ?? 0) +
          WEIGHT_KEYWORD * (keyword[i] ?? 0),
      );

      // --- Maximal Marginal Relevance selection ----------------------------
      const selected: RerankedResult[] = [];
      const remaining = new Set(candidates.map((_, i) => i));
      const limit = Math.min(options.topK, candidates.length);

      while (selected.length < limit) {
        let bestIndex = -1;
        let bestScore = -Infinity;

        for (const i of remaining) {
          let redundancy = 0;
          for (const chosen of selected) {
            const overlap = jaccard(tokenSets[i]!, tokenSets[chosen.originalRank - 1]!);
            if (overlap > redundancy) redundancy = overlap;
          }
          const score = MMR_LAMBDA * (relevance[i] ?? 0) - (1 - MMR_LAMBDA) * redundancy;

          // Ties fall to the better fused rank, so the reranker never reorders
          // on noise: candidates arrive in RRF order, so the lower index wins.
          if (score > bestScore) {
            bestScore = score;
            bestIndex = i;
          }
        }

        if (bestIndex < 0) break;
        remaining.delete(bestIndex);
        selected.push({
          ...candidates[bestIndex]!,
          rerankScore: bestScore,
          originalRank: bestIndex + 1,
          rerankStrategy: 'lexical',
        });
      }

      return selected;
    },
  };
}
