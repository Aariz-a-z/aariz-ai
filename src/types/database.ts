/**
 * Database schema types.
 *
 * Hand-written to mirror `supabase/migrations/20260817120000_init_documents_and_chunks.sql`.
 * Once a Supabase project exists these can be regenerated with
 * `supabase gen types typescript`, which is authoritative — until then this
 * file and the migration must be kept in step by hand.
 */

import type { AnswerSource } from './chat.ts';

/** Ingestion lifecycle. Only `ready` documents should be retrieved from. */
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * Source formats the extraction layer can read.
 *
 * Mirrored by the `documents_source_type_valid` CHECK constraint in the
 * database, and the two must stay in step: a value here that the constraint
 * rejects fails every upload of that format at the final insert, after the
 * expensive embedding work has already been paid for. Widening this therefore
 * always comes with a migration — see
 * `supabase/migrations/20260827120000_structured_source_types.sql`.
 *
 * `.doc` and `.xls` are deliberately absent. They are legacy OLE compound
 * binaries rather than the ZIP-of-XML their modern namesakes use, and no source
 * type is reserved for a format the extractor cannot actually read.
 */
export const DOCUMENT_SOURCE_TYPES = [
  'markdown',
  'txt',
  'pdf',
  'html',
  'docx',
  'xlsx',
  'csv',
  'json',
] as const;

// Derived from the array rather than declared beside it, so the values and the
// type cannot disagree — and so a test can iterate the real list at runtime
// instead of hard-coding a second copy of it.
export type DocumentSourceType = (typeof DOCUMENT_SOURCE_TYPES)[number];

/**
 * Embedding width, measured from nomic-embed-text at Level 2 — not assumed.
 *
 * This must equal the `vector(...)` dimension in the migration. Changing the
 * embedding model changes this number and requires the Level 22 reindex
 * procedure; it is exported so later levels can assert against it rather than
 * hard-coding 768 in several places.
 */
export const EMBEDDING_DIMENSION = 768;

/**
 * These are type aliases, not interfaces, and that is load-bearing.
 *
 * Supabase's `GenericSchema` constraint is expressed with `Record<string, …>`.
 * TypeScript gives anonymous object types an implicit index signature but does
 * NOT give one to an interface, so declaring these as interfaces makes the
 * schema fail the constraint — at which point `SupabaseClient` resolves its
 * `Schema` generic to `never` and every table loses its types, with no error
 * at the definition site. Keep them as `type`.
 */
export type DocumentRow = {
  id: string;
  title: string;
  source_url: string | null;
  source_type: DocumentSourceType;
  status: DocumentStatus;
  content_hash: string;
  /**
   * Owner of an uploaded document; NULL for the shared, CLI-ingested corpus.
   *
   * Never written from client input. It comes from a server-verified Supabase
   * Auth session, and RLS compares it against `auth.uid()` so the database
   * enforces isolation independently of any filtering this application does.
   */
  user_id: string | null;
  /** Upload size in bytes. NULL for CLI-ingested documents. */
  byte_size: number | null;
  /** Pages, where the format has them and the parser reported them. */
  page_count: number | null;
  created_at: string;
  updated_at: string;
}

export type ChunkRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  /**
   * The pgvector wire format, not an array.
   *
   * PostgREST carries `vector` columns as a bracketed string —
   * `"[0.123,0.456,…]"` — in both directions. Typing this `number[]` is what
   * forced `as unknown as number[]` casts at Level 5. Application code should
   * never touch this string: convert with `toPgVector` / `fromPgVector` from
   * `src/lib/supabase/vector.ts` and work in `number[]` everywhere else.
   *
   * Null until the chunk has been embedded.
   */
  embedding: string | null;
  /**
   * Level 9 full-text index vector, GENERATED ALWAYS from content.
   *
   * Read-only: Postgres maintains it, so it is excluded from Insert and Update.
   * PostgREST serialises tsvector as a string.
   */
  content_tsv: string | null;
  created_at: string;
}


/**
 * One row returned by the `match_chunks` RPC (Level 7).
 *
 * `similarity` is cosine SIMILARITY in [-1, 1], already converted from
 * pgvector cosine distance inside the function (similarity = 1 - distance).
 * Higher is closer.
 */
export type MatchChunkRow = {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
  document_title: string;
  source_url: string | null;
};


/**
 * One row returned by the `hybrid_match_chunks` RPC (Level 9).
 *
 * Extends the vector-only shape with the fusion diagnostics: each arm’s rank
 * (null when that arm did not surface the chunk) and the combined RRF score
 * that determines the final ordering.
 */
export type HybridMatchChunkRow = MatchChunkRow & {
  /** ts_rank_cd score from the full-text arm; null when only the vector arm matched. */
  keyword_score: number | null;
  /** 1-based rank within the vector candidate list; null if not in it. */
  vector_rank: number | null;
  /** 1-based rank within the keyword candidate list; null if not in it. */
  keyword_rank: number | null;
  /** Reciprocal Rank Fusion score. Higher ranks first. */
  rrf_score: number;
};

/**
 * A stored conversation (Level 12).
 *
 * `session_id` is the owner. It is an opaque server-generated value delivered
 * to the browser in an httpOnly cookie — never supplied by the client, and not
 * a user identity. Level 13 adds authenticated ownership beside it.
 */
export type ConversationRow = {
  id: string;
  session_id: string;
  /**
   * Level 13 authenticated owner, or null for an anonymous conversation.
   *
   * Never written from client input. It is set only from an identity that
   * Supabase Auth verified server-side, and RLS policies compare it against
   * `auth.uid()` so the database enforces isolation independently of any
   * filtering this application does.
   */
  user_id: string | null;
  title: string;
  /** Compressed older history. Null until the context strategy needs one. */
  summary: string | null;
  /** Watermark: turns created at or before this instant are inside `summary`. */
  summarised_through: string | null;
  created_at: string;
  updated_at: string;
};

/** Roles a *stored* turn may have. 'system' is deliberately absent — see below. */
export type MessageRole = 'user' | 'assistant';

/**
 * One stored conversation turn (Level 12).
 *
 * The system prompt is never a row here. It is assembled server-side on every
 * request, so storing it would create a second, writable source for the
 * instruction channel — the boundary Level 8's grounding depends on.
 */
export type MessageRow = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  /**
   * Level 8 citations for an assistant turn, so a refreshed page renders the
   * same sources under the same answer. Null on user turns.
   *
   * Typed as `AnswerSource[]` rather than `unknown`: it is written and read
   * only by this application, and keeping the shape here means a change to
   * AnswerSource surfaces at every call site instead of silently passing.
   */
  sources: AnswerSource[] | null;
  created_at: string;
};

/**
 * Make selected keys optional.
 *
 * Note the `Omit` must list every optional key. Writing
 * `Omit<T, 'a'> & Partial<Pick<T, 'a' | 'b'>>` does NOT make `b` optional —
 * intersecting a required property with an optional one leaves it required.
 */
type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type Database = {
  public: {
    Tables: {
      documents: {
        Row: DocumentRow;
        /**
         * Optional on insert: `id`/`created_at`/`updated_at` and `status` have
         * database defaults, and `source_url` is nullable (local files have none).
         * Required: title, source_type, content_hash.
         */
        Insert: WithOptional<
          DocumentRow,
          | 'id'
          | 'created_at'
          | 'updated_at'
          | 'status'
          | 'source_url'
          // Optional: the shared corpus has no owner and no upload metadata.
          | 'user_id'
          | 'byte_size'
          | 'page_count'
        >;
        Update: Partial<DocumentRow>;
        Relationships: [];
      };
      chunks: {
        Row: ChunkRow;
        /**
         * `embedding` is optional because a chunk is inserted when it is split
         * and embedded in a later pass — the reason the column is nullable.
         */
        Insert: Omit<
          WithOptional<ChunkRow, 'id' | 'created_at' | 'embedding'>,
          // GENERATED ALWAYS — Postgres computes it. Including it in a write
          // payload is an error, so it is excluded from Insert and Update.
          'content_tsv'
        >;
        Update: Partial<Omit<ChunkRow, 'content_tsv'>>;
        Relationships: [
          {
            foreignKeyName: 'chunks_document_id_fkey';
            columns: ['document_id'];
            referencedRelation: 'documents';
            referencedColumns: ['id'];
          },
        ];
      };
      conversations: {
        Row: ConversationRow;
        /** Only `session_id` must be supplied; everything else has a default or is nullable. */
        Insert: WithOptional<
          ConversationRow,
          | 'id'
          | 'title'
          | 'summary'
          | 'summarised_through'
          | 'created_at'
          | 'updated_at'
          // Optional because anonymous conversations have no authenticated owner.
          | 'user_id'
        >;
        Update: Partial<ConversationRow>;
        Relationships: [];
      };
      messages: {
        Row: MessageRow;
        Insert: WithOptional<MessageRow, 'id' | 'sources' | 'created_at'>;
        Update: Partial<MessageRow>;
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey';
            columns: ['conversation_id'];
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    // `Record<string, never>` rather than `Record<never, never>`: Supabase's
    // GenericSchema requires a string index signature on each of these. Without
    // one the whole schema silently fails to match, every table resolves to
    // `never`, and client calls lose their types without any error at the
    // definition site.
    Views: Record<string, never>;
    Functions: {
      /** Level 7 vector similarity search. See supabase/migrations/*_match_chunks_rpc.sql */
      match_chunks: {
        Args: {
          /** pgvector wire literal from toPgVector(). */
          query_embedding: string;
          match_count: number;
          similarity_threshold: number;
          /** NULL selects the anonymous corpus; a uuid selects that user's documents. */
          owner_id?: string | null;
        };
        Returns: MatchChunkRow[];
      };
      /** Level 9 hybrid search. See supabase/migrations/*_hybrid_search.sql */
      hybrid_match_chunks: {
        Args: {
          /** pgvector wire literal from toPgVector(). */
          query_embedding: string;
          /** Raw user question, parsed with websearch_to_tsquery. */
          query_text: string;
          match_count: number;
          /** Gates the vector arm only. */
          similarity_threshold: number;
          rrf_k: number;
          candidate_count: number;
          /** NULL selects the anonymous corpus; a uuid selects that user's documents. */
          owner_id?: string | null;
        };
        Returns: HybridMatchChunkRow[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
