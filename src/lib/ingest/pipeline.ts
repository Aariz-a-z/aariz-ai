/**
 * Ingestion pipeline — the Level 6 flow, end to end:
 *
 *     file -> extract text -> clean text -> split into chunks
 *          -> embed locally -> store in Supabase
 *
 * Uses the existing server-side Supabase admin client and the existing
 * embeddings module. No new database client, no duplicate helpers.
 */

import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

import { embedDocumentsWithTokenCounts } from '../embeddings.ts';
import { getSupabaseAdminClient } from '../supabase/server.ts';
import { toPgVector } from '../supabase/vector.ts';
import type { DocumentSourceType } from '../../types/database.ts';
import { chunkDocument, type ChunkOptions } from './chunking.ts';
import {
  SUPPORTED_EXTENSIONS,
  extractBuffer,
  extractDocument,
  type ExtractedDocument,
} from './extract.ts';

export type IngestOutcome = 'ingested' | 'skipped' | 'failed';

export interface IngestResult {
  file: string;
  outcome: IngestOutcome;
  documentId: string | null;
  title: string;
  sourceType: DocumentSourceType | null;
  chunkCount: number;
  /** Sum of the model's own token counts across stored chunks. */
  tokenTotal: number;
  durationMs: number;
  /** Why the file was skipped, or how it failed. */
  detail?: string;
}

export interface IngestOptions {
  /** Re-ingest even when an identical document is already stored. */
  force?: boolean;
  signal?: AbortSignal;
  chunking?: ChunkOptions;
  /**
   * Owner of the resulting document.
   *
   * Undefined or null means the shared, unowned corpus — what the CLI and every
   * Level 6-11 verification suite produces. A uuid comes from a server-verified
   * Supabase Auth session and NEVER from client input.
   */
  ownerId?: string | null;
  /** Upload size in bytes, recorded for the document list. */
  byteSize?: number | null;
  /**
   * Origin of the document — the original filename for an upload.
   *
   * Stored in `source_url`, which the CLI leaves null. Without it the document
   * list could only show the extracted title, which for a PDF is often not the
   * name the user recognises.
   */
  sourceUrl?: string | null;
}

/** Content hash used for deduplication. Matches UNIQUE(content_hash). */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}

/**
 * Ingest one file.
 *
 * Status transitions follow the schema's model exactly:
 * `pending` on insert, `processing` while chunking and embedding, then
 * `ready` on success or `failed` on error. A failed document keeps its row —
 * so the failure is visible rather than silently absent — but its chunks are
 * removed, because partial chunks would misrepresent it as searchable.
 */
export async function ingestFile(filePath: string, options: IngestOptions = {}): Promise<IngestResult> {
  const absolute = resolve(filePath);

  let extracted: ExtractedDocument;
  try {
    extracted = await extractDocument(absolute);
  } catch (caught) {
    return {
      file: absolute,
      outcome: 'failed',
      documentId: null,
      title: basename(absolute),
      sourceType: null,
      chunkCount: 0,
      tokenTotal: 0,
      durationMs: 0,
      detail: caught instanceof Error ? caught.message : String(caught),
    };
  }

  return await ingestExtracted(extracted, absolute, options);
}

/**
 * The shared ingestion core: deduplicate, store, chunk, embed, mark ready.
 *
 * Both entry points below funnel through this, so there is exactly one
 * implementation of chunking, embedding and status handling — the CLI path and
 * the upload path cannot drift apart, and there is no second embedding
 * implementation to keep in step.
 *
 * Status transitions follow the schema's model exactly: `pending` on insert,
 * `processing` while chunking and embedding, then `ready` on success or
 * `failed` on error. A failed document keeps its row — so the failure is
 * visible rather than silently absent — but its chunks are removed, because
 * partial chunks would misrepresent it as searchable.
 */
export async function ingestExtracted(
  extracted: ExtractedDocument,
  sourceLabel: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const startedAt = Date.now();
  const client = getSupabaseAdminClient();
  const absolute = sourceLabel;

  const base: IngestResult = {
    file: sourceLabel,
    outcome: 'failed',
    documentId: null,
    title: extracted.title,
    sourceType: extracted.sourceType,
    chunkCount: 0,
    tokenTotal: 0,
    durationMs: 0,
  };

  const { title, text, sourceType, pageCount } = extracted;
  const contentHash = hashContent(text);

  // --- Deduplication -------------------------------------------------------
  // Handled explicitly rather than by catching a 23505 from the UNIQUE index,
  // so the outcome is a deliberate "skipped" instead of an error.
  // Scoped to the owner. A global lookup would be a cross-user defect: if user
  // B uploads a file user A already has, an unscoped match finds A's row and
  // this function either returns A's document id to B or deletes A's document
  // outright. The partial unique indexes in the migration mirror this scope.
  const ownerId = options.ownerId ?? null;
  const dedupeQuery = client
    .from('documents')
    .select('id, status')
    .eq('content_hash', contentHash);

  const { data: existing, error: lookupError } = await (ownerId === null
    ? dedupeQuery.is('user_id', null)
    : dedupeQuery.eq('user_id', ownerId)
  ).maybeSingle();

  if (lookupError) {
    return {
      ...base,
      title,
      sourceType,
      durationMs: Date.now() - startedAt,
      detail: `Lookup failed: ${lookupError.message}`,
    };
  }

  if (existing) {
    // A previously failed document is always retried: leaving it skipped would
    // make a transient embedding failure permanent.
    const retryingFailed = existing.status === 'failed';

    if (!options.force && !retryingFailed) {
      return {
        ...base,
        outcome: 'skipped',
        documentId: existing.id,
        title,
        sourceType,
        durationMs: Date.now() - startedAt,
        detail: 'Identical content already ingested. Use --force to re-ingest.',
      };
    }

    // Cascade removes the old chunks, so no orphans survive the replacement.
    const { error: deleteError } = await client.from('documents').delete().eq('id', existing.id);
    if (deleteError) {
      return {
        ...base,
        title,
        sourceType,
        durationMs: Date.now() - startedAt,
        detail: `Could not replace existing document: ${deleteError.message}`,
      };
    }
  }

  // --- Create the document (status: pending) -------------------------------
  const { data: document, error: insertError } = await client
    .from('documents')
    .insert({
      title,
      source_type: sourceType,
      content_hash: contentHash,
      // Ownership is written from the caller's verified identity, never echoed
      // back from anything the uploader sent.
      user_id: ownerId,
      byte_size: options.byteSize ?? null,
      page_count: pageCount,
      source_url: options.sourceUrl ?? null,
    })
    .select('id')
    .single();

  if (insertError || !document) {
    return {
      ...base,
      title,
      sourceType,
      durationMs: Date.now() - startedAt,
      detail: `Could not create document: ${insertError?.message ?? 'no row returned'}`,
    };
  }

  const documentId = document.id;

  /** Mark failed and remove partial chunks, so state is never misleading. */
  const failDocument = async (detail: string): Promise<IngestResult> => {
    await client.from('chunks').delete().eq('document_id', documentId);
    await client.from('documents').update({ status: 'failed' }).eq('id', documentId);
    return {
      ...base,
      outcome: 'failed',
      documentId,
      title,
      sourceType,
      durationMs: Date.now() - startedAt,
      detail,
    };
  };

  try {
    await client.from('documents').update({ status: 'processing' }).eq('id', documentId);

    const chunks = chunkDocument(title, text, options.chunking);
    if (chunks.length === 0) {
      return await failDocument('Document produced no chunks.');
    }

    // Embedded in chunk order; embedDocumentsWithTokenCounts preserves order,
    // so embedded[i] belongs to chunks[i]. Nothing is sorted after this point.
    const embedded = await embedDocumentsWithTokenCounts(
      chunks.map((chunk) => chunk.content),
      { signal: options.signal },
    );

    if (embedded.length !== chunks.length) {
      return await failDocument(
        `Embedding count mismatch: ${embedded.length} vectors for ${chunks.length} chunks.`,
      );
    }

    const rows = chunks.map((chunk, index) => {
      const result = embedded[index]!;
      return {
        document_id: documentId,
        chunk_index: chunk.index,
        content: chunk.content,
        token_count: result.tokenCount,
        embedding: toPgVector(result.embedding),
      };
    });

    const { error: chunkError } = await client.from('chunks').insert(rows);
    if (chunkError) {
      return await failDocument(`Could not store chunks: ${chunkError.message}`);
    }

    const { error: readyError } = await client
      .from('documents')
      .update({ status: 'ready' })
      .eq('id', documentId);
    if (readyError) {
      return await failDocument(`Could not mark document ready: ${readyError.message}`);
    }

    return {
      file: absolute,
      outcome: 'ingested',
      documentId,
      title,
      sourceType,
      chunkCount: rows.length,
      tokenTotal: rows.reduce((sum, row) => sum + row.token_count, 0),
      durationMs: Date.now() - startedAt,
    };
  } catch (caught) {
    return await failDocument(caught instanceof Error ? caught.message : String(caught));
  }
}


/**
 * Ingest bytes already in memory — the HTTP upload path.
 *
 * Nothing is written to disk: uploaded content goes from the request straight
 * into extraction.
 */
export async function ingestBuffer(
  buffer: Buffer,
  filename: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  let extracted: ExtractedDocument;
  try {
    extracted = await extractBuffer(buffer, filename);
  } catch (caught) {
    return {
      file: filename,
      outcome: 'failed',
      documentId: null,
      title: filename,
      sourceType: null,
      chunkCount: 0,
      tokenTotal: 0,
      durationMs: 0,
      detail: caught instanceof Error ? caught.message : String(caught),
    };
  }

  return await ingestExtracted(extracted, filename, {
    ...options,
    byteSize: options.byteSize ?? buffer.byteLength,
    sourceUrl: options.sourceUrl ?? filename,
  });
}

/** Recursively collect supported files under a directory. */
async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...(await collectFiles(full)));
    } else if (SUPPORTED_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  }

  return files.sort();
}

/**
 * Ingest a single file or every supported file under a directory.
 *
 * Files are processed one at a time. This machine has two CPU cores and the
 * embedding model is the bottleneck, so concurrency would slow the run down
 * rather than speed it up.
 */
export async function ingestPath(target: string, options: IngestOptions = {}): Promise<IngestResult[]> {
  const absolute = resolve(target);

  let stats;
  try {
    stats = await stat(absolute);
  } catch {
    throw new IngestError(`Path not found: ${absolute}`);
  }

  if (stats.isDirectory()) {
    const files = await collectFiles(absolute);
    if (files.length === 0) {
      throw new IngestError(
        `No supported files under ${absolute}. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
      );
    }
    const results: IngestResult[] = [];
    for (const file of files) {
      results.push(await ingestFile(file, options));
    }
    return results;
  }

  return [await ingestFile(absolute, options)];
}
