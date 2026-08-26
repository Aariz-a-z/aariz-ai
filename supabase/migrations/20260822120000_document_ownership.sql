-- =============================================================================
-- Per-user documents — upload, ownership, and user-scoped retrieval
--
-- Additive and non-destructive. No table is dropped, no row is deleted, and no
-- existing conversation, document or chunk changes ownership: `user_id` is
-- added NULLABLE, so everything ingested before this migration stays anonymous
-- and keeps behaving exactly as it did at Levels 6-11.
--
-- Three existing objects ARE replaced, and each replacement is required for
-- correctness rather than tidiness. They are called out individually below:
--
--   1. documents_source_type_valid   widened to admit 'docx'
--   2. documents_content_hash_key    global uniqueness -> per-owner uniqueness
--   3. match_chunks / hybrid_match_chunks   gain an owner filter
--
-- Idempotent: safe to re-apply.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ownership
--
-- NULLABLE, and that is the whole compatibility story: an anonymous document
-- has user_id IS NULL, which is what every document ingested by the CLI and by
-- the Level 6-11 verification suites already is.
-- -----------------------------------------------------------------------------
alter table public.documents
  add column if not exists user_id uuid references auth.users (id) on delete cascade;

comment on column public.documents.user_id is
  'Owner of an uploaded document. NULL for the shared/CLI-ingested corpus. Never supplied by the client: written only from a server-verified Supabase Auth session.';

-- Useful metadata for the document list. Both nullable: the CLI path does not
-- record them, and a text file has no page count.
alter table public.documents add column if not exists byte_size  bigint;
alter table public.documents add column if not exists page_count integer;

create index if not exists documents_user_created_idx
  on public.documents (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 2. Source types — admit DOCX
--
-- The original CHECK listed exactly the four formats Level 6 required. Widening
-- it is additive: every value that was valid before is still valid.
-- -----------------------------------------------------------------------------
alter table public.documents drop constraint if exists documents_source_type_valid;
alter table public.documents
  add constraint documents_source_type_valid
  check (source_type in ('markdown', 'txt', 'pdf', 'html', 'docx'));

-- -----------------------------------------------------------------------------
-- 3. Deduplication becomes PER OWNER
--
-- This one is a security fix, not a refinement.
--
-- `content_hash` was globally unique, and the ingestion pipeline looks a
-- document up by hash alone. Once documents have owners, that combination is a
-- cross-user defect: if user B uploads a file user A already has, the lookup
-- finds A's row and the pipeline either returns A's document id to B or — with
-- force, or when A's row is in the `failed` state — DELETES A's document.
--
-- Two partial indexes rather than one composite:
--
--   * per owner, so two users may each hold the same file
--   * across the anonymous corpus, where user_id IS NULL, preserving Level 6
--     deduplication exactly
--
-- A plain UNIQUE (user_id, content_hash) would not do the second: SQL treats
-- NULLs as distinct, so every anonymous re-ingest would insert a duplicate.
-- -----------------------------------------------------------------------------
drop index if exists public.documents_content_hash_key;

create unique index if not exists documents_owner_content_hash_idx
  on public.documents (user_id, content_hash)
  where user_id is not null;

create unique index if not exists documents_anon_content_hash_idx
  on public.documents (content_hash)
  where user_id is null;

-- -----------------------------------------------------------------------------
-- 4. Privileges
--
-- RLS decides which rows; these decide whether the role may touch the table at
-- all. `anon` gets nothing and has no policy: an unauthenticated caller holding
-- the anon key reads no documents whatsoever. The anonymous CORPUS is still
-- reachable, but only through the server's service-role client.
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, update, delete on public.chunks    to authenticated;

grant all privileges on public.documents to service_role;
grant all privileges on public.chunks    to service_role;

revoke all on public.documents from anon;
revoke all on public.chunks    from anon;

-- -----------------------------------------------------------------------------
-- 5. RLS — documents
--
-- Same shape as the Level 13 conversation policies, for the same reasons:
-- `(select auth.uid())` so the call is an InitPlan rather than per-row, and
-- `user_id = auth.uid()` rather than IS NOT DISTINCT FROM, so a row with a NULL
-- owner — the shared corpus — is invisible to every authenticated user.
-- -----------------------------------------------------------------------------
alter table public.documents enable row level security;
alter table public.chunks    enable row level security;

drop policy if exists documents_select_own on public.documents;
create policy documents_select_own on public.documents
  for select to authenticated
  using (user_id = (select auth.uid()));

-- WITH CHECK stops a user creating a document already owned by someone else.
drop policy if exists documents_insert_own on public.documents;
create policy documents_insert_own on public.documents
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- USING controls which rows may be updated, WITH CHECK what they may become —
-- without the latter a user could hand their own document to another account.
drop policy if exists documents_update_own on public.documents;
create policy documents_update_own on public.documents
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists documents_delete_own on public.documents;
create policy documents_delete_own on public.documents
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- -----------------------------------------------------------------------------
-- 6. RLS — chunks
--
-- Ownership is inherited from the parent document rather than copied onto every
-- chunk. A chunk is reachable exactly when its document is, so the two can
-- never disagree — which a duplicated user_id column would eventually allow.
-- -----------------------------------------------------------------------------
drop policy if exists chunks_select_own on public.chunks;
create policy chunks_select_own on public.chunks
  for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = chunks.document_id and d.user_id = (select auth.uid())
    )
  );

drop policy if exists chunks_insert_own on public.chunks;
create policy chunks_insert_own on public.chunks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.documents d
      where d.id = chunks.document_id and d.user_id = (select auth.uid())
    )
  );

drop policy if exists chunks_update_own on public.chunks;
create policy chunks_update_own on public.chunks
  for update to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = chunks.document_id and d.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.documents d
      where d.id = chunks.document_id and d.user_id = (select auth.uid())
    )
  );

drop policy if exists chunks_delete_own on public.chunks;
create policy chunks_delete_own on public.chunks
  for delete to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = chunks.document_id and d.user_id = (select auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- 7. Retrieval becomes owner-scoped
--
-- Both search functions gain an `owner_id` parameter, and both filter with:
--
--     d.user_id is not distinct from owner_id
--
-- IS NOT DISTINCT FROM treats NULL = NULL as true, which gives exactly the two
-- behaviours needed from one expression:
--
--     owner_id IS NULL      -> matches the anonymous corpus only
--                              (Levels 6-11 keep working unchanged)
--     owner_id = <uuid>     -> matches that user's documents only
--
-- Note this is the opposite choice to the RLS policies above, deliberately.
-- There, NULL must NOT match, because auth.uid() is an identity and a NULL
-- owner is "nobody". Here owner_id is an explicit, server-supplied scope, and
-- NULL means "the anonymous corpus" — a value, not an absence.
--
-- These run as SECURITY INVOKER. Called through the service-role client they
-- bypass RLS, so this predicate is the boundary on that path and is applied in
-- the query rather than to the results.
-- -----------------------------------------------------------------------------
drop function if exists public.match_chunks(vector(768), integer, double precision);
drop function if exists public.match_chunks(vector(768), integer, double precision, uuid);

create function public.match_chunks(
  query_embedding      vector(768),
  match_count          integer,
  similarity_threshold double precision,
  owner_id             uuid default null
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
    c.id,
    c.document_id,
    c.chunk_index,
    c.content,
    (1 - (c.embedding <=> query_embedding))::double precision as similarity,
    d.title,
    d.source_url
  from public.chunks c
  join public.documents d on d.id = c.document_id
  where c.embedding is not null
    and d.status = 'ready'
    and d.user_id is not distinct from owner_id
    and (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
  -- Ordered by DISTANCE so the HNSW index is usable; distance ascending is
  -- similarity descending.
  order by c.embedding <=> query_embedding
  limit greatest(match_count, 0);
$$;

comment on function public.match_chunks is
  'Vector similarity search, scoped by owner. owner_id NULL selects the anonymous corpus; a uuid selects that user''s documents.';

drop function if exists public.hybrid_match_chunks(vector(768), text, integer, double precision, integer, integer);
drop function if exists public.hybrid_match_chunks(vector(768), text, integer, double precision, integer, integer, uuid);

create function public.hybrid_match_chunks(
  query_embedding      vector(768),
  query_text           text,
  match_count          integer,
  similarity_threshold double precision,
  rrf_k                integer,
  candidate_count      integer,
  owner_id             uuid default null
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
  parsed_query as (
    select websearch_to_tsquery('english', coalesce(query_text, '')) as tsq
  ),

  -- Arm 1: vector similarity. The threshold applies HERE ONLY — applying it
  -- after fusion would discard exact keyword hits whose vector similarity is
  -- low, which is the failure hybrid search exists to fix.
  vector_hits as (
    select
      c.id,
      row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.chunks c
    join public.documents d on d.id = c.document_id
    where c.embedding is not null
      and d.status = 'ready'
      and d.user_id is not distinct from owner_id
      and (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
    order by c.embedding <=> query_embedding
    limit greatest(candidate_count, 0)
  ),

  -- Arm 2: full-text relevance. ts_rank_cd accounts for term proximity.
  keyword_hits as (
    select
      c.id,
      ts_rank_cd(c.content_tsv, p.tsq)::double precision as score,
      row_number() over (order by ts_rank_cd(c.content_tsv, p.tsq) desc, c.id) as rank
    from public.chunks c
    join public.documents d on d.id = c.document_id
    cross join parsed_query p
    where d.status = 'ready'
      and d.user_id is not distinct from owner_id
      -- Required here too: the final SELECT computes a similarity for every
      -- fused row, and a keyword-only hit on an unembedded chunk would make
      -- that NULL, which the TypeScript result validator rejects.
      and c.embedding is not null
      and p.tsq is not null
      and c.content_tsv @@ p.tsq
    order by ts_rank_cd(c.content_tsv, p.tsq) desc, c.id
    limit greatest(candidate_count, 0)
  ),

  -- FULL OUTER JOIN so a chunk found by only one arm still survives.
  fused as (
    select
      coalesce(v.id, k.id)                      as id,
      v.rank                                    as v_rank,
      k.rank                                    as k_rank,
      k.score                                   as k_score,
      coalesce(1.0 / (rrf_k + v.rank), 0.0)
        + coalesce(1.0 / (rrf_k + k.rank), 0.0) as rrf
    from vector_hits v
    full outer join keyword_hits k on k.id = v.id
  )

  select
    c.id,
    c.document_id,
    c.chunk_index,
    c.content,
    (1 - (c.embedding <=> query_embedding))::double precision as similarity,
    f.k_score,
    f.v_rank::integer,
    f.k_rank::integer,
    f.rrf::double precision,
    d.title,
    d.source_url
  from fused f
  join public.chunks c    on c.id = f.id
  join public.documents d on d.id = c.document_id
  order by f.rrf desc, c.id
  limit greatest(match_count, 0);
$$;

comment on function public.hybrid_match_chunks is
  'Hybrid search (vector + full-text, RRF-fused), scoped by owner. owner_id NULL selects the anonymous corpus; a uuid selects that user''s documents.';

revoke execute on function public.match_chunks(vector(768), integer, double precision, uuid) from public;
revoke execute on function public.match_chunks(vector(768), integer, double precision, uuid) from anon, authenticated;
grant  execute on function public.match_chunks(vector(768), integer, double precision, uuid) to service_role;

revoke execute on function public.hybrid_match_chunks(vector(768), text, integer, double precision, integer, integer, uuid) from public;
revoke execute on function public.hybrid_match_chunks(vector(768), text, integer, double precision, integer, integer, uuid) from anon, authenticated;
grant  execute on function public.hybrid_match_chunks(vector(768), text, integer, double precision, integer, integer, uuid) to service_role;

notify pgrst, 'reload schema';
