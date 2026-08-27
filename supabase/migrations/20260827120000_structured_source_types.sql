-- =============================================================================
-- Widen documents.source_type to admit every format the extractor can read.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `documents_source_type_valid` has been widened once before (Level 22 added
-- 'docx'). Multi-format upload adds five more source types — 'doc', 'xlsx',
-- 'xls', 'csv' and 'json' — and without this the insert fails with:
--
--     new row for relation "documents" violates check constraint
--     "documents_source_type_valid"
--
-- Verified by inserting each value with the service-role key before writing
-- this file: 'csv', 'json' and 'xlsx' were all rejected, 'docx' was accepted.
-- The failure lands at the very END of ingestion, after extraction, chunking
-- and one embedding call per chunk have already been paid for, which is why it
-- surfaced as a puzzling 422 rather than as an obvious configuration error.
--
-- WHY THE TYPE IS RECORDED HONESTLY RATHER THAN FOLDED INTO 'txt'
-- --------------------------------------------------------------
-- Mapping a spreadsheet onto 'txt' would have avoided this migration entirely.
-- It would also make the document list lie about what the user uploaded, and
-- make any future per-format handling — a different chunk size for tabular
-- data, say — impossible to write without first untangling the fudge. The
-- column means "what this document actually was"; keep it true.
--
-- 'doc' and 'xls' are INCLUDED. They are legacy OLE2 compound binaries rather
-- than the ZIP-of-XML their modern namesakes use, so they are read by a
-- separate container reader (`src/lib/ingest/cfb.ts`) — but they finish in the
-- same pipeline and deserve their own honest source type rather than being
-- filed under 'docx' or 'xlsx'.
--
-- WHAT IS DELIBERATELY NOT CHANGED
-- --------------------------------
-- `chunks.embedding` stays `vector(768)`. Nothing here touches the vector
-- dimension, the search RPCs, the HNSW indexes, or any RLS policy. This is a
-- single widened CHECK constraint and nothing else.
--
-- APPLYING IT
-- -----------
-- Run this file against the project database — Supabase dashboard SQL editor,
-- `supabase db push` on a linked project, or psql. It is idempotent: the drop
-- is guarded, and re-running it leaves the same constraint in place.
-- =============================================================================

alter table public.documents
  drop constraint if exists documents_source_type_valid;

alter table public.documents
  add constraint documents_source_type_valid
  check (source_type in (
    'markdown', 'txt', 'pdf', 'html',
    'docx', 'doc',
    'xlsx', 'xls',
    'csv', 'json'
  ));

comment on constraint documents_source_type_valid on public.documents is
  'Source formats the extraction layer can actually read. Kept in step with EXTENSION_TO_SOURCE_TYPE in src/lib/ingest/formats.ts and DOCUMENT_SOURCE_TYPES in src/types/database.ts. A value here the extractor cannot produce is dead; one it produces that is missing here fails every upload of that format at the final insert.';
