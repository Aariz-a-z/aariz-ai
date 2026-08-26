-- =============================================================================
-- Level 9 — hybrid search (vector + full-text, fused with Reciprocal Rank Fusion)
--
-- ROADMAP.md Level 9 asks for PostgreSQL full-text search combined with vector
-- similarity, candidates drawn from both systems, and a principled fusion.
--
-- Level 7's `match_chunks` is deliberately left untouched: it remains the
-- pure-vector path, its verification suite still exercises it, and the hybrid
-- function is added alongside rather than replacing it.
--
-- Idempotent: safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Full-text index over chunk content
--
-- A GENERATED STORED column rather than a trigger: it cannot drift out of sync
-- with `content`, needs no backfill step, and is maintained by Postgres itself.
-- 'english' gives stemming ("retries" matches "retry") while still indexing
-- identifiers — to_tsvector('english', 'ERR-4471') yields 'err-4471', 'err' and
-- '4471', so exact codes remain findable.
-- -----------------------------------------------------------------------------
alter table public.chunks
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('english', content)) stored;

comment on column public.chunks.content_tsv is
  'Level 9 full-text index vector, generated from content. Used by hybrid_match_chunks.';

create index if not exists chunks_content_tsv_idx
  on public.chunks using gin (content_tsv);

-- -----------------------------------------------------------------------------
-- hybrid_match_chunks — two independent candidate lists, fused by RRF
--
--   RRF score = Σ  1 / (k + rank_in_that_list)
--
-- Rank-based rather than score-based fusion on purpose: cosine similarity and
-- ts_rank_cd are on incomparable scales, so blending the raw numbers would mean
-- inventing a weighting. RRF only needs the ordering from each system.
-- k = 60 is the value from the original RRF paper and damps the influence of
-- top-1 positions so a single system cannot dominate the fused ranking.
-- -----------------------------------------------------------------------------
create or replace function public.hybrid_match_chunks(
  query_embedding      vector(768),
  query_text           text,
  match_count          integer,
  similarity_threshold double precision,
  rrf_k                integer,
  candidate_count      integer
)
returns table (
  chunk_id        uuid,
  document_id     uuid,
  chunk_index     integer,
  content         text,
  similarity      double precision,
  keyword_score   double precision,
  vector_rank     integer,
  keyword_rank    integer,
  rrf_score       double precision,
  document_title  text,
  source_url      text
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with
  -- websearch_to_tsquery is used rather than to_tsquery because it accepts raw
  -- user input safely: unbalanced quotes and stray operators degrade to plain
  -- terms instead of raising a syntax error.
  parsed_query as (
    select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq
  ),

  -- Arm 1: vector similarity. The similarity threshold applies HERE ONLY.
  -- Applying it after fusion would discard exact keyword matches whose vector
  -- similarity happens to be low, which is the failure Level 9 exists to fix.
  vector_hits as (
    select
      c.id,
      row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.chunks c
    join public.documents d on d.id = c.document_id
    where c.embedding is not null
      and d.status = 'ready'
      and (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
    order by c.embedding <=> query_embedding
    limit greatest(candidate_count, 0)
  ),

  -- Arm 2: full-text relevance. ts_rank_cd accounts for term proximity, which
  -- suits chunk-sized passages better than plain ts_rank.
  keyword_hits as (
    select
      c.id,
      ts_rank_cd(c.content_tsv, p.tsq)::double precision as score,
      row_number() over (order by ts_rank_cd(c.content_tsv, p.tsq) desc, c.id) as rank
    from public.chunks c
    join public.documents d on d.id = c.document_id
    cross join parsed_query p
    where d.status = 'ready'
      -- Also required here, not just in the vector arm: the final SELECT
      -- computes a similarity for every fused row so the UI can display one.
      -- A keyword-only hit on an unembedded chunk would make that NULL, which
      -- the TypeScript result validator rejects as a malformed row.
      and c.embedding is not null
      and p.tsq is not null
      and c.content_tsv @@ p.tsq
    order by ts_rank_cd(c.content_tsv, p.tsq) desc, c.id
    limit greatest(candidate_count, 0)
  ),

  -- FULL OUTER JOIN so a chunk found by only one arm still survives.
  fused as (
    select
      coalesce(v.id, k.id)                                as id,
      v.rank                                              as v_rank,
      k.rank                                              as k_rank,
      k.score                                             as k_score,
      coalesce(1.0 / (rrf_k + v.rank), 0.0)
        + coalesce(1.0 / (rrf_k + k.rank), 0.0)           as rrf
    from vector_hits v
    full outer join keyword_hits k on k.id = v.id
  )

  select
    c.id            as chunk_id,
    c.document_id   as document_id,
    c.chunk_index   as chunk_index,
    c.content       as content,
    -- Recomputed for every fused row, including keyword-only hits, so the UI
    -- can always show a meaningful similarity next to a source.
    (1 - (c.embedding <=> query_embedding))::double precision as similarity,
    f.k_score       as keyword_score,
    f.v_rank::integer as vector_rank,
    f.k_rank::integer as keyword_rank,
    f.rrf::double precision as rrf_score,
    d.title         as document_title,
    d.source_url    as source_url
  from fused f
  join public.chunks c    on c.id = f.id
  join public.documents d on d.id = c.document_id
  order by f.rrf desc, c.id
  limit greatest(match_count, 0);
$$;

comment on function public.hybrid_match_chunks is
  'Level 9 hybrid search. Draws candidates from vector similarity and PostgreSQL full-text search independently, then fuses them with Reciprocal Rank Fusion (1/(k+rank)). The similarity threshold gates only the vector arm so exact keyword hits are never filtered out.';

-- Same privilege posture as match_chunks: deny-by-default for browser-facing
-- roles, explicit grant to the server-side role. Relying on the PUBLIC default
-- is not safe on Supabase — see the Level 7 migration for what that cost.
revoke execute on function public.hybrid_match_chunks(vector(768), text, integer, double precision, integer, integer) from public;
revoke execute on function public.hybrid_match_chunks(vector(768), text, integer, double precision, integer, integer) from anon, authenticated;
grant  execute on function public.hybrid_match_chunks(vector(768), text, integer, double precision, integer, integer) to service_role;

notify pgrst, 'reload schema';
