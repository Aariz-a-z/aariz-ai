-- =============================================================================
-- Level 4 — document / vector schema
--
-- Creates the foundation the later pipeline builds on:
--
--     documents  ──1:N──▶  chunks  ──▶  vector search
--
-- Reproducible from a clean database: every statement is idempotent, so the
-- file can be re-applied without error and without altering existing rows.
--
-- The vector dimension is 768 because that is what nomic-embed-text actually
-- returned when measured at Level 2. It is not a guess, and it must not be
-- changed casually — Level 22 defines the reindex procedure required if the
-- embedding model ever changes.
--
-- Scope: schema only. No ingestion, chunking, embedding, or retrieval logic
-- lives here; those arrive at Levels 5–7.
-- =============================================================================

-- pgvector. Available on the Supabase free plan; must be enabled explicitly.
create extension if not exists vector;

-- -----------------------------------------------------------------------------
-- documents — one row per ingested source file
-- -----------------------------------------------------------------------------
create table if not exists public.documents (
  id           uuid        primary key default gen_random_uuid(),
  title        text        not null,
  source_url   text,
  source_type  text        not null,
  status       text        not null default 'pending',
  content_hash text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint documents_title_not_blank
    check (length(btrim(title)) > 0),

  -- The formats Level 6 is required to support.
  constraint documents_source_type_valid
    check (source_type in ('markdown', 'txt', 'pdf', 'html')),

  -- Ingestion lifecycle. 'failed' is a first-class state so a broken document
  -- is visible rather than silently absent.
  constraint documents_status_valid
    check (status in ('pending', 'processing', 'ready', 'failed')),

  constraint documents_content_hash_not_blank
    check (length(btrim(content_hash)) > 0)
);

comment on table public.documents is
  'One row per ingested source document. content_hash makes re-ingestion idempotent.';
comment on column public.documents.content_hash is
  'Hash of the extracted text. Level 6 uses sha256. UNIQUE, so re-ingesting an unchanged file cannot create a duplicate.';
comment on column public.documents.status is
  'pending | processing | ready | failed. Only ready documents should be retrieved from.';

-- Enforces the Level 6 rule "re-ingesting the same file must not create
-- duplicates" in the database, rather than trusting callers to check first.
create unique index if not exists documents_content_hash_key
  on public.documents (content_hash);

-- Retrieval will filter to ready documents; ingestion reporting filters to failed.
create index if not exists documents_status_idx
  on public.documents (status);

create index if not exists documents_created_at_idx
  on public.documents (created_at desc);

-- -----------------------------------------------------------------------------
-- chunks — retrievable fragments of a document, with their embedding
-- -----------------------------------------------------------------------------
create table if not exists public.chunks (
  id          uuid        primary key default gen_random_uuid(),
  document_id uuid        not null references public.documents (id) on delete cascade,
  chunk_index integer     not null,
  content     text        not null,
  token_count integer     not null,
  -- Nullable on purpose: a chunk exists once it is split, and is embedded in a
  -- later step. A NOT NULL column here would force those two operations into a
  -- single transaction and make partial-failure recovery harder.
  embedding   vector(768),
  created_at  timestamptz not null default now(),

  constraint chunks_chunk_index_non_negative
    check (chunk_index >= 0),

  constraint chunks_token_count_positive
    check (token_count > 0),

  constraint chunks_content_not_blank
    check (length(btrim(content)) > 0),

  -- A document cannot have two chunks at the same position.
  constraint chunks_document_id_chunk_index_key
    unique (document_id, chunk_index)
);

comment on table public.chunks is
  'Retrievable fragments of a document. Deleted automatically when the parent document is deleted.';
comment on column public.chunks.embedding is
  'vector(768) — matches nomic-embed-text, measured at Level 2. Changing the embedding model changes this dimension and requires the Level 22 reindex procedure.';
comment on column public.chunks.chunk_index is
  'Zero-based position within the parent document. Unique per document.';

-- Supports the cascade delete and every "all chunks for this document" lookup.
create index if not exists chunks_document_id_idx
  on public.chunks (document_id);

-- HNSW rather than IVFFlat: IVFFlat must be built against existing rows to
-- learn its lists, so building it on an empty table yields poor recall. HNSW
-- builds incrementally and is correct from empty.
--
-- vector_cosine_ops matches the `<=>` operator used for cosine distance.
create index if not exists chunks_embedding_hnsw_idx
  on public.chunks using hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- updated_at maintenance
--
-- Without a trigger, updated_at is only correct when every writer remembers to
-- set it — which makes it a column that quietly lies.
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row
  execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- Enabled with NO policies, which is deny-by-default: the anon and
-- authenticated roles can read nothing and write nothing. The service-role key
-- bypasses RLS, so server-side ingestion and retrieval keep working.
--
-- This is the correct posture until Level 13 introduces real users. Adding
-- permissive policies now would expose every document to any browser holding
-- the public anon key.
-- -----------------------------------------------------------------------------
alter table public.documents enable row level security;
alter table public.chunks    enable row level security;
