-- =============================================================================
-- Level 7 — vector similarity search RPC
--
-- ROADMAP.md Level 7 requires "a Supabase RPC function for vector similarity
-- search". This is that function. PostgREST cannot express `ORDER BY
-- embedding <=> $1` over the REST API, so retrieval genuinely needs a database
-- function rather than a direct table query.
--
-- Idempotent: CREATE OR REPLACE, safe to re-apply.
-- =============================================================================

-- `extensions` is included because Supabase installs pgvector there; a schema
-- listed in search_path that does not exist is ignored, so this is also correct
-- on a vanilla Postgres where the extension landed in public.
create or replace function public.match_chunks(
  query_embedding      vector(768),
  match_count          integer,
  similarity_threshold double precision
)
returns table (
  chunk_id       uuid,
  document_id    uuid,
  chunk_index    integer,
  content        text,
  similarity     double precision,
  document_title text,
  source_url     text
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id          as chunk_id,
    c.document_id as document_id,
    c.chunk_index as chunk_index,
    c.content     as content,
    -- pgvector's <=> is COSINE DISTANCE. Similarity is 1 - distance, so a
    -- higher `similarity` means a closer match. Callers compare with >=.
    (1 - (c.embedding <=> query_embedding))::double precision as similarity,
    d.title       as document_title,
    d.source_url  as source_url
  from public.chunks c
  join public.documents d on d.id = c.document_id
  where c.embedding is not null
    -- A document that failed or is still processing may hold partial chunks;
    -- answering from those would surface half-ingested content as if complete.
    and d.status = 'ready'
    and (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
  -- Ordered by DISTANCE ascending, not similarity descending. They are
  -- equivalent orderings, but only the distance form can use
  -- chunks_embedding_hnsw_idx (hnsw ... vector_cosine_ops). Ordering by the
  -- computed similarity column would silently fall back to a sequential scan.
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 0);
$$;

comment on function public.match_chunks is
  'Level 7 vector similarity search. Returns chunks of ready documents whose cosine similarity to query_embedding is >= similarity_threshold, closest first. Ordered by cosine distance so the HNSW index is used.';

-- Privileges, stated explicitly rather than inherited.
--
-- Relying on Postgres granting EXECUTE to PUBLIC by default is not safe here:
-- Supabase restricts that default, so revoking from anon/authenticated alone
-- can leave NO role able to execute the function. PostgREST omits functions
-- that no reachable role may execute, so the RPC then appears "missing" with
-- PGRST202 even though it exists — which is exactly what happened on the first
-- attempt at this migration.
--
-- So: revoke from everyone, then grant to precisely the role that needs it.
-- Deny-by-default for browser-facing roles matches the Level 4 RLS posture;
-- Level 13 grants authenticated access alongside real RLS policies.
revoke execute on function public.match_chunks(vector(768), integer, double precision) from public;
revoke execute on function public.match_chunks(vector(768), integer, double precision) from anon, authenticated;
grant  execute on function public.match_chunks(vector(768), integer, double precision) to service_role;

-- Force PostgREST to refresh its schema cache immediately instead of waiting
-- for its next reload, so the RPC is callable as soon as this migration ends.
notify pgrst, 'reload schema';
