/**
 * Per-user document management.
 *
 * Reads and deletes run through the caller's own RLS-subject client, so the
 * database is the boundary — the same arrangement Level 13 uses for
 * conversations, and for the same reason: a `.eq('user_id', …)` that someone
 * forgets to write is a silent cross-user leak, whereas a missing RLS policy
 * fails closed.
 *
 * Ingestion is the one place service-role is still used, and deliberately: it
 * writes a document and its chunks in several steps and must be able to mark a
 * document `failed` and clear partial chunks even when the row is in a state
 * the user's own policies would not permit mid-flight. The owner is stamped
 * from the verified session at insert time, and every subsequent read of that
 * row goes back through RLS.
 *
 * Server-only.
 */

import {
  LEGACY_BINARY_FORMATS,
  SUPPORTED_EXTENSIONS,
  fileExtension,
} from './ingest/formats.ts';
import { ingestBuffer } from './ingest/pipeline.ts';
import { createAuthedClient } from './supabase/authed.ts';
import type { DocumentRow, DocumentSourceType, DocumentStatus } from '../types/database.ts';

/**
 * Upload ceiling.
 *
 * Ten megabytes is far more than the text-bearing documents this pipeline is
 * for, and small enough that a single request cannot exhaust memory on a
 * two-core machine. Level 14 (abuse protection) adds the per-user and per-IP
 * limits around this; this is the per-file bound only.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Formats accepted over HTTP.
 *
 * Now exactly what the extractor can read, and derived from the same registry
 * the file picker uses rather than written out again here.
 *
 * It used to be the narrower list `['.pdf', '.docx', '.txt']`, on the reasoning
 * that an upload endpoint should accept the smallest set that meets the
 * requirement. That reasoning had a cost nobody had noticed: the picker offered
 * nine extensions, so a user could select a `.md` file the extractor handles
 * perfectly and get back a 415 from this check. Two lists, two intentions, one
 * confused user. There is one list now, in `formats.ts`, and both ends read it.
 */
export const UPLOAD_EXTENSIONS = SUPPORTED_EXTENSIONS;

export type DocumentErrorCode =
  | 'unauthenticated'
  | 'invalid_file'
  | 'too_large'
  | 'unsupported_type'
  | 'storage_failed';

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  readonly status: number;

  constructor(code: DocumentErrorCode, message: string, status: number) {
    super(message);
    this.name = 'DocumentError';
    this.code = code;
    this.status = status;
  }
}

/** What the browser is shown. Never includes `user_id` or `content_hash`. */
export interface DocumentSummary {
  id: string;
  title: string;
  filename: string;
  sourceType: DocumentSourceType;
  status: DocumentStatus;
  byteSize: number | null;
  pageCount: number | null;
  chunkCount: number;
  createdAt: string;
}

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/documents.ts is server-only and must not be imported from a client component.',
    );
  }
}

function toSummary(row: DocumentRow & { chunks?: { count: number }[] }): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    // `source_url` holds the original filename for uploads; the CLI leaves it null.
    filename: row.source_url ?? row.title,
    sourceType: row.source_type,
    status: row.status,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    chunkCount: row.chunks?.[0]?.count ?? 0,
    createdAt: row.created_at,
  };
}

/**
 * The signed-in user's documents, newest first.
 *
 * Runs as the user through RLS. The `.eq('user_id', …)` is defence in depth,
 * not the boundary.
 */
export async function listDocuments(
  userId: string,
  accessToken: string,
): Promise<DocumentSummary[]> {
  assertServerOnly();

  const { data, error } = await createAuthedClient(accessToken)
    .from('documents')
    .select('*, chunks(count)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new DocumentError('storage_failed', `Could not list documents: ${error.message}`, 500);
  }
  return (data ?? []).map((row) => toSummary(row as DocumentRow & { chunks?: { count: number }[] }));
}

/**
 * Delete one document the caller owns.
 *
 * False means nothing was deleted — absent, or someone else's; the caller
 * cannot tell which, and the API answers 404 either way.
 *
 * Chunks go with it through ON DELETE CASCADE rather than a second delete that
 * could be interrupted halfway and leave orphans.
 */
export async function deleteDocument(
  userId: string,
  accessToken: string,
  documentId: string,
): Promise<boolean> {
  assertServerOnly();

  const { data, error } = await createAuthedClient(accessToken)
    .from('documents')
    .delete()
    .eq('id', documentId)
    .eq('user_id', userId)
    .select('id');

  if (error) {
    throw new DocumentError('storage_failed', `Could not delete document: ${error.message}`, 500);
  }
  return (data ?? []).length > 0;
}

// Shared with the client so both ends split a filename identically. The local
// copy also mishandled a path: it took the last dot of the WHOLE string, so
// "docs.v2/notes" reported ".v2/notes" as an extension.

/**
 * Validate and ingest an uploaded file.
 *
 * Validation happens before a single byte is parsed: type and size are cheap to
 * check and an oversized or unsupported file should never reach a parser.
 */
export async function uploadDocument(
  userId: string,
  file: File,
  options: { signal?: AbortSignal } = {},
): Promise<DocumentSummary> {
  assertServerOnly();

  const filename = (file.name ?? '').trim();
  if (filename.length === 0) {
    throw new DocumentError('invalid_file', 'The upload has no filename.', 400);
  }

  const extension = fileExtension(filename);
  if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
    /**
     * `.doc` and `.xls` are refused with instructions rather than a list.
     * Someone uploading a Word document has a fixable problem, and repeating
     * twelve extensions at them does not identify it; "save it as .docx" does.
     */
    const legacy = LEGACY_BINARY_FORMATS[extension];
    if (legacy) throw new DocumentError('unsupported_type', legacy, 415);

    throw new DocumentError(
      'unsupported_type',
      `Unsupported file type "${extension || filename}". Accepted: ${UPLOAD_EXTENSIONS.join(', ')}.`,
      415,
    );
  }

  if (file.size === 0) {
    throw new DocumentError('invalid_file', 'The file is empty.', 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new DocumentError(
      'too_large',
      `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      413,
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Owner comes from the verified session, passed in by the route. There is no
  // parameter here that a client could populate.
  const result = await ingestBuffer(buffer, filename, {
    ownerId: userId,
    byteSize: buffer.byteLength,
    signal: options.signal,
  });

  if (result.outcome === 'failed' || result.documentId === null) {
    // A malformed or unreadable file is the user's problem to see, not a 500.
    throw new DocumentError(
      'invalid_file',
      result.detail ?? 'The document could not be processed.',
      422,
    );
  }

  return {
    id: result.documentId,
    title: result.title,
    filename,
    sourceType: result.sourceType ?? 'txt',
    // `skipped` means an identical file is already stored for this user, which
    // is a success from the caller's point of view: the content is searchable.
    status: 'ready',
    byteSize: buffer.byteLength,
    pageCount: null,
    chunkCount: result.chunkCount,
    createdAt: new Date().toISOString(),
  };
}
