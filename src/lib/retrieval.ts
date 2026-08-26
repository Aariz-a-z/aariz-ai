/**
 * Level 7 — vector retrieval.
 *
 *     user question
 *          ↓  embedQuery()            search_query: prefix, 768-d, L2-normalised
 *     query embedding
 *          ↓  toPgVector()            application number[] -> pgvector literal
 *     Supabase vector search          match_chunks RPC, HNSW cosine index
 *          ↓
 *     top candidates                  over-fetched
 *          ↓  deduplicate
 *     top relevant chunks
 *
 * Server-only. Reuses the existing embedding module, Supabase admin client and
 * pgvector helpers — this file adds no second implementation of any of them,
 * and never talks to Ollama or PostgREST directly.
 */

import { embedQuery } from './embeddings.ts';
import { getSupabaseAdminClient } from './supabase/server.ts';
import { toPgVector } from './supabase/vector.ts';

/**
 * Defaults for the two configurable parameters ROADMAP.md names.
 *
 * Read from the environment in exactly one place, so retrieval parameters are
 * not hard-coded "everywhere" (ROADMAP.md line 584).
 *
 * The threshold default comes from measurement rather than taste: at Level 5 a
 * relevant document scored 0.797 against its query while an unrelated one
 * scored 0.433, so 0.5 sits in the gap between them.
 */
const DEFAULT_MATCH_COUNT = 5;
const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

/**
 * Candidates fetched per requested result, before deduplication.
 *
 * Deduplication removes rows, so fetching exactly matchCount would return
 * fewer than asked whenever a duplicate appears.
 */
const CANDIDATE_OVERFETCH = 3;

/** Guards against a caller asking the database for an unbounded scan. */
const MAX_MATCH_COUNT = 100;

/**
 * Reciprocal Rank Fusion constant (Level 9).
 *
 * 60 is the value from the original RRF paper. It damps the influence of the
 * top positions, so neither the vector arm nor the keyword arm can dominate the
 * fused ranking on its own.
 */
const DEFAULT_RRF_K = 60;

/**
 * Candidates drawn from EACH arm before fusion.
 *
 * Larger than MATCH_COUNT on purpose: fusion can only reorder what it is given,
 * so a chunk ranked 20th by vector but 1st by keyword has to be in the pool to
 * be rescued.
 */
const DEFAULT_HYBRID_CANDIDATES = 30;

const MAX_HYBRID_CANDIDATES = 200;

export type RetrievalErrorCode =
  | 'invalid_query'
  | 'invalid_match_count'
  | 'invalid_threshold'
  | 'search_failed'
  | 'malformed_result';

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;

  constructor(code: RetrievalErrorCode, message: string) {
    super(message);
    this.name = 'RetrievalError';
    this.code = code;
  }
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  /** Cosine SIMILARITY in [-1, 1]. Higher is closer. This is not distance. */
  similarity: number;
  documentTitle: string;
  sourceUrl: string | null;
}

export interface RetrievalOptions {
  /** Maximum results to return. Defaults to MATCH_COUNT. */
  matchCount?: number;
  /** Minimum cosine similarity to keep. Defaults to SIMILARITY_THRESHOLD. */
  similarityThreshold?: number;
  signal?: AbortSignal;
  /**
   * Whose documents to search.
   *
   * Null or omitted searches the shared, unowned corpus — the CLI-ingested
   * documents every Level 6-11 suite uses. A uuid restricts the search to that
   * user's uploads.
   *
   * This is applied INSIDE the SQL function, not to its results: filtering
   * afterwards in JavaScript would mean the database had already returned
   * another user's chunks to this process, and one forgotten filter would be a
   * silent cross-user leak. The value must come from a server-verified session.
   */
  ownerId?: string | null;
  /**
   * Level 18 — optional sink for stage latencies.
   *
   * ROADMAP.md Level 18 requires retrieval latency and embedding latency as
   * SEPARATE figures, and only this function knows where one ends and the
   * other begins: it embeds the query, then searches. Measuring from outside
   * could only ever produce the sum.
   *
   * An out-parameter rather than a wider return type on purpose. `retrieveHybrid`
   * flows through `rerankResults` into `buildGroundedContext`, and changing
   * what it returns would ripple through three levels of code that have their
   * own passing suites. An optional field that existing callers do not pass
   * changes nothing for them, and no timing is collected when it is absent.
   */
  timings?: RetrievalTimings;
}

/**
 * Where the time went inside one retrieval call.
 *
 * Mutated in place by `retrieveHybrid`. Fields stay null if that stage did not
 * run — a caller must not read a zero as "instant" when it means "never
 * happened".
 */
export interface RetrievalTimings {
  /** Query embedding: the Ollama round trip. */
  embeddingMs: number | null;
  /** The database search alone, with embedding time excluded. */
  searchMs: number | null;
}

export interface RetrievalConfig {
  matchCount: number;
  similarityThreshold: number;
  /** RRF constant k. Level 9. */
  rrfK: number;
  /** Candidates per arm before fusion. Level 9. */
  hybridCandidates: number;
}

/**
 * A hybrid result, with the fusion diagnostics attached.
 *
 * Extends `RetrievalResult`, so every existing consumer — including the Level 8
 * RAG layer — accepts it unchanged.
 */
export interface HybridRetrievalResult extends RetrievalResult {
  /** Full-text relevance from ts_rank_cd; null when only the vector arm matched. */
  keywordScore: number | null;
  /** 1-based rank in the vector candidate list; null if absent from it. */
  vectorRank: number | null;
  /** 1-based rank in the keyword candidate list; null if absent from it. */
  keywordRank: number | null;
  /** Fused score that determined the ordering. */
  rrfScore: number;
}

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/retrieval.ts is server-only and must not be imported from a client component.',
    );
  }
}

function readNumericEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new RetrievalError(
      'invalid_threshold',
      `${name} must be a finite number, received "${raw}".`,
    );
  }
  return parsed;
}

/** The effective retrieval parameters. Single source of truth. */
export function getRetrievalConfig(): RetrievalConfig {
  return {
    matchCount: readNumericEnv('MATCH_COUNT', DEFAULT_MATCH_COUNT),
    similarityThreshold: readNumericEnv('SIMILARITY_THRESHOLD', DEFAULT_SIMILARITY_THRESHOLD),
    rrfK: readNumericEnv('RRF_K', DEFAULT_RRF_K),
    hybridCandidates: readNumericEnv('HYBRID_CANDIDATES', DEFAULT_HYBRID_CANDIDATES),
  };
}

function validate(query: string, config: RetrievalConfig): void {
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new RetrievalError(
      'invalid_query',
      'Query must be a non-empty string. An empty query has no meaningful nearest neighbour.',
    );
  }
  if (!Number.isInteger(config.matchCount) || config.matchCount < 1) {
    throw new RetrievalError(
      'invalid_match_count',
      `matchCount must be a positive integer, received ${config.matchCount}.`,
    );
  }
  if (config.matchCount > MAX_MATCH_COUNT) {
    throw new RetrievalError(
      'invalid_match_count',
      `matchCount must not exceed ${MAX_MATCH_COUNT}, received ${config.matchCount}.`,
    );
  }
  if (config.similarityThreshold < -1 || config.similarityThreshold > 1) {
    throw new RetrievalError(
      'invalid_threshold',
      `similarityThreshold must be within [-1, 1], received ${config.similarityThreshold}.`,
    );
  }
  if (!Number.isInteger(config.rrfK) || config.rrfK < 1) {
    throw new RetrievalError(
      'invalid_match_count',
      `rrfK must be a positive integer, received ${config.rrfK}.`,
    );
  }
  if (
    !Number.isInteger(config.hybridCandidates) ||
    config.hybridCandidates < 1 ||
    config.hybridCandidates > MAX_HYBRID_CANDIDATES
  ) {
    throw new RetrievalError(
      'invalid_match_count',
      `hybridCandidates must be an integer within [1, ${MAX_HYBRID_CANDIDATES}], received ${config.hybridCandidates}.`,
    );
  }
}

/**
 * Drop duplicates while preserving rank order.
 *
 * Two kinds of duplication are possible: the same chunk returned twice
 * (defensive — the schema should prevent it), and distinct chunks whose text is
 * identical, which happens with boilerplate repeated across documents.
 *
 * Chunk overlap produces *near*-duplicates; those are deliberately kept,
 * because the shared region is only part of each chunk and discarding one would
 * throw away the rest of its content.
 */
function deduplicate(rows: RetrievalResult[]): RetrievalResult[] {
  const seenChunkIds = new Set<string>();
  const seenContent = new Set<string>();
  const unique: RetrievalResult[] = [];

  for (const row of rows) {
    const normalised = row.content.replace(/\s+/g, ' ').trim();
    if (seenChunkIds.has(row.chunkId) || seenContent.has(normalised)) continue;
    seenChunkIds.add(row.chunkId);
    seenContent.add(normalised);
    unique.push(row);
  }

  return unique;
}

/**
 * Retrieve the chunks most relevant to a question.
 *
 * Results are ordered by similarity, highest first. An empty array means
 * nothing cleared the threshold — a valid answer, not an error.
 */
export async function retrieveChunks(
  query: string,
  options: RetrievalOptions = {},
): Promise<RetrievalResult[]> {
  assertServerOnly();

  const defaults = getRetrievalConfig();
  const config: RetrievalConfig = {
    ...defaults,
    matchCount: options.matchCount ?? defaults.matchCount,
    similarityThreshold: options.similarityThreshold ?? defaults.similarityThreshold,
  };

  validate(query, config);

  // embedQuery applies the "search_query: " prefix. Never embedDocuments here:
  // Level 5 measured that embedding a query as a document degrades retrieval.
  const queryVector = await embedQuery(query.trim(), { signal: options.signal });
  const queryLiteral = toPgVector(queryVector);

  const client = getSupabaseAdminClient();
  const { data, error } = await client.rpc('match_chunks', {
    query_embedding: queryLiteral,
    match_count: config.matchCount * CANDIDATE_OVERFETCH,
    similarity_threshold: config.similarityThreshold,
    owner_id: options.ownerId ?? null,
  });

  if (error) {
    throw new RetrievalError(
      'search_failed',
      `Vector search failed: ${error.message}${error.hint ? ` (${error.hint})` : ''}`,
    );
  }

  if (data === null) return [];
  if (!Array.isArray(data)) {
    throw new RetrievalError('malformed_result', 'match_chunks did not return an array.');
  }

  const mapped: RetrievalResult[] = data.map((row, index) => {
    if (
      typeof row.chunk_id !== 'string' ||
      typeof row.document_id !== 'string' ||
      typeof row.chunk_index !== 'number' ||
      typeof row.content !== 'string' ||
      typeof row.similarity !== 'number' ||
      !Number.isFinite(row.similarity)
    ) {
      throw new RetrievalError(
        'malformed_result',
        `match_chunks row ${index} has an unexpected shape.`,
      );
    }

    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      similarity: row.similarity,
      documentTitle: row.document_title,
      sourceUrl: row.source_url,
    };
  });

  // The RPC already orders by distance ascending, which is similarity
  // descending. Sorting again is cheap insurance against a future change to the
  // function silently reordering results.
  mapped.sort((a, b) => b.similarity - a.similarity);

  return deduplicate(mapped).slice(0, config.matchCount);
}

/**
 * Level 9 — hybrid retrieval.
 *
 *     question
 *        ├─ vector arm    embedQuery() -> cosine similarity, HNSW index
 *        └─ keyword arm   websearch_to_tsquery -> ts_rank_cd, GIN index
 *              ↓
 *        Reciprocal Rank Fusion   Σ 1 / (k + rank)
 *              ↓
 *        deduplicate -> top matchCount
 *
 * Both arms run inside one `hybrid_match_chunks` round trip, so fusion happens
 * where the data lives rather than shipping two candidate lists to Node.
 *
 * `retrieveChunks` above is deliberately left as the pure-vector path: Level 7
 * verifies it directly, and keeping it lets the two be compared.
 */
export async function retrieveHybrid(
  query: string,
  options: RetrievalOptions = {},
): Promise<HybridRetrievalResult[]> {
  assertServerOnly();

  const defaults = getRetrievalConfig();
  const config: RetrievalConfig = {
    ...defaults,
    matchCount: options.matchCount ?? defaults.matchCount,
    similarityThreshold: options.similarityThreshold ?? defaults.similarityThreshold,
  };

  validate(query, config);

  const trimmed = query.trim();

  // Same query embedding behaviour as the vector path — "search_query: " prefix
  // applied by embedQuery, never embedDocuments.
  //
  // Level 18: timed around the call rather than inside embeddings.ts, so the
  // measurement belongs to this retrieval and cannot be confused with the
  // batch embedding the ingestion pipeline does.
  const embeddingStartedAt = performance.now();
  const queryVector = await embedQuery(trimmed, { signal: options.signal });
  if (options.timings) {
    options.timings.embeddingMs = Math.round(performance.now() - embeddingStartedAt);
  }
  const queryLiteral = toPgVector(queryVector);

  const client = getSupabaseAdminClient();
  const searchStartedAt = performance.now();
  const { data, error } = await client.rpc('hybrid_match_chunks', {
    query_embedding: queryLiteral,
    // The raw question goes to full-text search. websearch_to_tsquery parses
    // arbitrary user input safely, so no escaping is needed here.
    query_text: trimmed,
    match_count: config.matchCount * CANDIDATE_OVERFETCH,
    similarity_threshold: config.similarityThreshold,
    rrf_k: config.rrfK,
    candidate_count: config.hybridCandidates,
    owner_id: options.ownerId ?? null,
  });

  // Recorded before the error branch: a search that FAILED still consumed
  // time, and a dashboard that only ever times successes reports a system
  // that looks faster the more it breaks.
  if (options.timings) {
    options.timings.searchMs = Math.round(performance.now() - searchStartedAt);
  }

  if (error) {
    throw new RetrievalError(
      'search_failed',
      `Hybrid search failed: ${error.message}${error.hint ? ` (${error.hint})` : ''}`,
    );
  }

  if (data === null) return [];
  if (!Array.isArray(data)) {
    throw new RetrievalError('malformed_result', 'hybrid_match_chunks did not return an array.');
  }

  const mapped: HybridRetrievalResult[] = data.map((row, index) => {
    if (
      typeof row.chunk_id !== 'string' ||
      typeof row.document_id !== 'string' ||
      typeof row.chunk_index !== 'number' ||
      typeof row.content !== 'string' ||
      typeof row.similarity !== 'number' ||
      !Number.isFinite(row.similarity) ||
      typeof row.rrf_score !== 'number' ||
      !Number.isFinite(row.rrf_score)
    ) {
      throw new RetrievalError(
        'malformed_result',
        `hybrid_match_chunks row ${index} has an unexpected shape.`,
      );
    }

    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      similarity: row.similarity,
      documentTitle: row.document_title,
      sourceUrl: row.source_url,
      keywordScore: row.keyword_score,
      vectorRank: row.vector_rank,
      keywordRank: row.keyword_rank,
      rrfScore: row.rrf_score,
    };
  });

  // Ordered by fused score, NOT by similarity — a keyword-only hit can and
  // should outrank a semantically closer chunk. Re-sorting here would undo the
  // fusion the database just performed.
  mapped.sort((a, b) => b.rrfScore - a.rrfScore);

  return deduplicate(mapped).slice(0, config.matchCount) as HybridRetrievalResult[];
}
