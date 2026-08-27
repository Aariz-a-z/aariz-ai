-- =============================================================================
-- Widen documents.source_type to admit the structured formats.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `documents_source_type_valid` has been widened once before (Level 22 added
-- 'docx'). Multi-format upload adds three more source types — 'xlsx', 'csv' and
-- 'json' — and without this the insert fails with:
--
--     new row for relation "documents" violates check constraint
--     "documents_source_type_valid"
--
-- Verified by inserting each value with the service-role key before writing
-- this file: 'csv', 'json' and 'xlsx' were all rejected, 'docx' was accepted.
--
-- WHY THE TYPE IS RECORDED HONESTLY RATHER THAN FOLDED INTO 'txt'
-- --------------------------------------------------------------
-- Mapping a spreadsheet onto 'txt' would have avoided this migration entirely.
-- It would also make the document list lie about what the user uploaded, and
-- make any future per-format handling — a different chunk size for tabular
-- data, say — impossible to write without first untangling the fudge. The
-- column means "what this document actually was"; keep it true.
--
-- WHAT IS DELIBERATELY NOT CHANGED
-- --------------------------------
-- `chunks.embedding` stays `vector(768)`. Nothing here touches the vector
-- dimension, the search RPCs, the HNSW indexes or any RLS policy. This is a
-- single widened CHECK constraint and nothing else.
--
-- '.doc' and '.xls' are absent on purpose. They are legacy OLE compound
-- binaries, not the ZIP-based formats their modern namesakes use, and no
-- source type is reserved for a format the extractor cannot read — see
-- `LEGACY_BINARY_FORMATS` in `src/lib/ingest/formats.ts`, which refuses them
-- at upload with an explanation rather than storing an unreadable row.
-- =============================================================================

alter table public.documents
  drop constraint if exists documents_source_type_valid;

alter table public.documents
  add constraint documents_source_type_valid
  check (source_type in ('markdown', 'txt', 'pdf', 'html', 'docx', 'xlsx', 'csv', 'json'));

comment on constraint documents_source_type_valid on public.documents is
  'Source formats the extraction layer can actually read. Kept in step with EXTENSION_TO_SOURCE_TYPE in src/lib/ingest/formats.ts — a value here that the extractor cannot produce is dead, and one it produces that is missing here fails every upload of that format.';
