-- =============================================================================
-- Level 22 — re-ingestion staging, for a zero-downtime embedding swap.
--
-- ROADMAP.md Level 22 is explicit about the thing NOT to do:
--
--     Never: delete all embeddings then rebuild — because that creates
--     downtime. The live chatbot should continue using the old index until the
--     new one is ready.
--
-- So the new vectors are built somewhere else entirely, validated there, and
-- only then promoted. Throughout the build, `public.chunks.embedding` is
-- untouched and every search the application performs is answered from it
-- exactly as before. There is no window in which a chunk has no embedding.
--
-- WHY A SIDE TABLE RATHER THAN A SECOND COLUMN
-- --------------------------------------------
-- A second column on `chunks` would work, but it puts half-built state inside
-- the table the live query path reads, and it makes "abandon the attempt" a
-- schema change instead of a DELETE. A separate table keeps the in-progress
-- index completely outside the serving path: it can be filled, emptied,
-- inspected or thrown away without the running application noticing.
--
-- It also stores no content. Chunk text already exists in `public.chunks`, and
-- copying it here would mean two copies that can disagree — the staging row is
-- a vector and a model name, keyed to the chunk it belongs to.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Staging table
--
-- IF YOU ARE CHANGING THE EMBEDDING DIMENSION, THIS IS THE LINE TO EDIT.
-- `vector(768)` matches nomic-embed-text and therefore the current
-- `public.chunks.embedding`. A model with a different dimension needs this
-- number changed AND the promote function below will refuse until
-- `public.chunks.embedding` is altered to match — a deliberate stop, because
-- silently promoting mismatched vectors would corrupt every future search.
-- `scripts/reingest.ts --status` prints both dimensions so the mismatch is
-- visible before anything is built.
-- -----------------------------------------------------------------------------
create table if not exists public.chunks_reindex (
  chunk_id   uuid        primary key
                references public.chunks (id) on delete cascade,
  embedding  vector(768) not null,
  -- Which model produced this vector. Recorded per row so a half-finished
  -- build with a mixed model set is detectable rather than silently promoted.
  model      text        not null,
  created_at timestamptz not null default now(),

  constraint chunks_reindex_model_not_blank check (length(btrim(model)) > 0)
);

comment on table public.chunks_reindex is
  'Level 22 staging for a zero-downtime embedding rebuild. Holds candidate vectors only; the live search path never reads this table. Emptied after promotion.';

-- The staging index. Built here so that validation can run real similarity
-- queries against the NEW vectors before they are promoted — validating an
-- unindexed table would prove the numbers exist without proving they retrieve.
create index if not exists chunks_reindex_embedding_hnsw_idx
  on public.chunks_reindex using hnsw (embedding vector_cosine_ops);

create index if not exists chunks_reindex_model_idx
  on public.chunks_reindex (model);

-- -----------------------------------------------------------------------------
-- Row level security
--
-- Same posture as `public.chunks`: RLS on, no policies, so PostgreSQL denies
-- every row to every browser-facing role. Only the server's service-role
-- client, which bypasses RLS, can touch this. Re-indexing is an operator
-- action and there is no reason a browser should see staged vectors.
-- -----------------------------------------------------------------------------
alter table public.chunks_reindex enable row level security;

revoke all on public.chunks_reindex from anon, authenticated;

-- -----------------------------------------------------------------------------
-- The switch (ROADMAP.md step 4, "switch active index")
--
-- One statement, one transaction. Readers see the old vectors until it
-- commits and the new ones immediately after; there is no instant at which a
-- chunk is missing an embedding, which is the whole point of the level.
--
-- It refuses rather than half-applies:
--
--   * a dimension mismatch would corrupt search, so it stops;
--   * a staging set that does not cover every chunk would leave a mixed index
--     where some vectors came from one model and some from another, which is
--     worse than either model alone — cosine distance between vectors from
--     different models is meaningless.
--
-- SECURITY INVOKER, and callable only by the service role, matching the
-- Level 7/9 RPC posture.
-- -----------------------------------------------------------------------------
create or replace function public.promote_reindex(expected_model text)
returns table (promoted bigint, skipped bigint)
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  staged_total   bigint;
  staged_model   bigint;
  chunk_total    bigint;
  live_dimension int;
  stage_dimension int;
begin
  select count(*) into chunk_total  from public.chunks;
  select count(*) into staged_total from public.chunks_reindex;
  select count(*) into staged_model from public.chunks_reindex where model = expected_model;

  if staged_total = 0 then
    raise exception 'Nothing staged: build the new index before promoting.';
  end if;

  if staged_model <> staged_total then
    raise exception
      'Staging holds vectors from more than one model (% of % rows match "%"). Clear it and rebuild.',
      staged_model, staged_total, expected_model;
  end if;

  if staged_total <> chunk_total then
    raise exception
      'Staging covers % of % chunks. Promoting a partial index would mix models. Finish the build first.',
      staged_total, chunk_total;
  end if;

  -- Dimensions must agree or the UPDATE would fail mid-flight anyway; failing
  -- here makes the reason legible instead of a type error.
  select vector_dims(embedding) into live_dimension  from public.chunks       limit 1;
  select vector_dims(embedding) into stage_dimension from public.chunks_reindex limit 1;

  if live_dimension is not null and stage_dimension is not null
     and live_dimension <> stage_dimension then
    raise exception
      'Dimension mismatch: chunks.embedding is vector(%), staged vectors are vector(%). Alter the live column before promoting.',
      live_dimension, stage_dimension;
  end if;

  update public.chunks c
     set embedding = r.embedding
    from public.chunks_reindex r
   where r.chunk_id = c.id;

  get diagnostics promoted = row_count;
  skipped := chunk_total - promoted;
  return next;
end;
$$;

comment on function public.promote_reindex(text) is
  'Level 22 step 4. Atomically replaces every chunk embedding from staging. Refuses a partial, mixed-model or wrong-dimension set rather than corrupting the index.';

revoke all on function public.promote_reindex(text) from public, anon, authenticated;
grant execute on function public.promote_reindex(text) to service_role;
