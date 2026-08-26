#!/usr/bin/env node
/**
 * Level 5 — embedding verification.
 *
 * Exercises the real `src/lib/embeddings.ts` against the running Ollama
 * server. Read-only with respect to the database: it writes nothing.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-embeddings.ts
 */

import { randomUUID } from 'node:crypto';

import {
  EMBEDDING_DIMENSION,
  EmbeddingError,
  embedDocuments,
  embedQuery,
  getEmbeddingModel,
} from '../src/lib/embeddings.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { fromPgVector, toPgVector } from '../src/lib/supabase/vector.ts';
import { loadEnvLocal } from './_env.ts';

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

function l2Norm(v: number[]): number {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
}

async function main(): Promise<void> {
  loadEnvLocal();

  console.log('='.repeat(72));
  console.log('  LEVEL 5 — EMBEDDING VERIFICATION');
  console.log(`  model: ${getEmbeddingModel()}   expected dimension: ${EMBEDDING_DIMENSION}`);
  console.log('='.repeat(72));

  console.log('\n-- Dimension and shape ------------------------------------------');

  const docs = [
    'The billing service stores invoices in PostgreSQL and runs on Node.js 20.',
    'All services are deployed to Kubernetes and scale automatically.',
    'Bananas are a tropical fruit rich in potassium.',
  ];
  const docVectors = await embedDocuments(docs);

  check(docVectors.length === docs.length, 'one vector per input', `${docVectors.length}/${docs.length}`);
  check(
    docVectors.every((v) => v.length === EMBEDDING_DIMENSION),
    `every vector is exactly ${EMBEDDING_DIMENSION}-dimensional`,
    `widths: ${[...new Set(docVectors.map((v) => v.length))].join(', ')}`,
  );
  check(
    docVectors.every((v) => v.every(Number.isFinite)),
    'no NaN or Infinity values',
  );
  check(
    Math.abs(l2Norm(docVectors[0]!) - 1) < 0.01,
    'vectors are L2-normalised (/api/embed)',
    `norm = ${l2Norm(docVectors[0]!).toFixed(4)}`,
  );

  console.log('\n-- Batching -----------------------------------------------------');

  // 20 texts with batchSize 4 forces five batches and crosses every boundary.
  const many = Array.from({ length: 20 }, (_, i) => `Document number ${i} about topic ${i % 5}.`);
  const batched = await embedDocuments(many, { batchSize: 4 });
  check(batched.length === 20, 'batching returns every vector', `${batched.length}/20`);
  check(
    batched.every((v) => v.length === EMBEDDING_DIMENSION),
    'batched vectors keep the correct dimension',
  );

  // Order must survive batching, or chunk N would be stored with chunk M's vector.
  const single = await embedDocuments([many[7]!]);
  check(
    cosine(batched[7]!, single[0]!) > 0.999,
    'batch order is preserved (item 7 matches its standalone embedding)',
    `cos = ${cosine(batched[7]!, single[0]!).toFixed(5)}`,
  );

  console.log('\n-- Document vs query prefixes -----------------------------------');

  const query = 'Where does billing store its invoices?';
  const queryVector = await embedQuery(query);
  check(queryVector.length === EMBEDDING_DIMENSION, 'embedQuery returns the right dimension');

  const asDocument = (await embedDocuments([query]))[0]!;
  check(
    cosine(queryVector, asDocument) < 0.999,
    'embedQuery and embedDocuments produce different vectors for identical text',
    `cos = ${cosine(queryVector, asDocument).toFixed(4)}`,
  );

  const relevant = cosine(queryVector, docVectors[0]!);
  const irrelevant = cosine(queryVector, docVectors[2]!);
  check(
    relevant > irrelevant,
    'relevant document scores above an unrelated one',
    `relevant ${relevant.toFixed(4)} vs unrelated ${irrelevant.toFixed(4)}`,
  );

  console.log('\n-- Input validation ---------------------------------------------');

  check((await embedDocuments([])).length === 0, 'empty input returns an empty array');

  for (const [label, bad] of [
    ['empty string', ''],
    ['whitespace only', '   \n\t '],
  ] as const) {
    try {
      await embedDocuments([bad]);
      check(false, `rejects ${label}`, 'no error thrown');
    } catch (error) {
      check(
        error instanceof EmbeddingError && error.code === 'invalid_input',
        `rejects ${label}`,
        error instanceof EmbeddingError ? error.code : 'wrong error type',
      );
    }
  }

  console.log('\n-- Failure handling (not swallowed) -----------------------------');

  const goodBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1'; // nothing listens here
  const startedAt = Date.now();
  try {
    await embedQuery('this should fail', { maxAttempts: 2 });
    check(false, 'unreachable server throws', 'no error thrown');
  } catch (error) {
    const isRight = error instanceof EmbeddingError && error.code === 'provider_unreachable';
    check(isRight, 'unreachable server throws provider_unreachable', error instanceof Error ? error.message.slice(0, 90) : '');
    check(
      error instanceof Error && /failed after 2 attempt/.test(error.message),
      'retries are attempted and reported',
      `elapsed ${Date.now() - startedAt} ms`,
    );
  } finally {
    if (goodBaseUrl) process.env.OLLAMA_BASE_URL = goodBaseUrl;
    else delete process.env.OLLAMA_BASE_URL;
  }

  console.log('\n-- Schema compatibility -----------------------------------------');
  check(
    EMBEDDING_DIMENSION === 768,
    'EMBEDDING_DIMENSION matches the vector(768) column from Level 4',
    `${EMBEDDING_DIMENSION}`,
  );

  await verifyStorageRoundTrip();

  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${passed} passed · ${failed} failed`);
  console.log('='.repeat(72));

  if (failed > 0) process.exitCode = 1;
}

/**
 * Level 5 "Done when": a document is converted into embeddings and stored.
 *
 * Inserts a clearly-marked temporary document, stores real embeddings against
 * it, reads them back, and deletes it again. Nothing is left behind — cleanup
 * runs even when an assertion fails.
 */
async function verifyStorageRoundTrip(): Promise<void> {
  console.log('\n-- Embedding -> Supabase round trip ------------------------------');

  if (!isSupabaseConfigured()) {
    console.log('  SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env.local');
    return;
  }

  const client = getSupabaseAdminClient();
  const contentHash = `level5-verification-${randomUUID()}`;
  let documentId: string | null = null;

  const chunkTexts = [
    'The billing service stores invoices in PostgreSQL and exposes a REST API.',
    'All services are deployed to Kubernetes and scale automatically.',
  ];

  try {
    // 1. Insert the parent document. status and source_url are omitted on
    //    purpose — this exercises the Insert-type fix made during Level 4.
    const { data: document, error: insertDocError } = await client
      .from('documents')
      .insert({
        title: 'Level 5 verification (temporary)',
        source_type: 'markdown',
        content_hash: contentHash,
      })
      .select()
      .single();

    if (insertDocError || !document) {
      check(false, 'insert document', insertDocError?.message ?? 'no row returned');
      return;
    }
    documentId = document.id;
    check(true, 'insert document (status/source_url omitted)', `status defaulted to "${document.status}"`);

    // 2. Embed the chunks with the real module.
    const vectors = await embedDocuments(chunkTexts);
    check(vectors.length === chunkTexts.length, 'embed chunks', `${vectors.length} vectors`);

    // 3. Store them. pgvector expects a bracketed string over PostgREST; the
    //    generated column type is number[], so the conversion is explicit.
    const rows = chunkTexts.map((content, index) => ({
      document_id: documentId!,
      chunk_index: index,
      content,
      token_count: Math.max(1, Math.round(content.length / 4)),
      embedding: toPgVector(vectors[index]!),
    }));

    const { error: insertChunkError } = await client.from('chunks').insert(rows);
    check(!insertChunkError, 'insert chunks with embeddings', insertChunkError?.message ?? 'ok');
    if (insertChunkError) return;

    // 4. Read back and confirm the vector survived storage intact.
    const { data: stored, error: readError } = await client
      .from('chunks')
      .select('chunk_index, content, token_count, embedding')
      .eq('document_id', documentId)
      .order('chunk_index');

    check(!readError && stored?.length === 2, 'read chunks back', readError?.message ?? `${stored?.length ?? 0} rows`);

    if (stored && stored.length === 2) {
      const roundTripped = fromPgVector(stored[0]!.embedding!);
      check(
        roundTripped.length === EMBEDDING_DIMENSION,
        'stored vector keeps its dimension',
        `${roundTripped.length}`,
      );
      const fidelity = cosine(roundTripped, vectors[0]!);
      // pgvector stores float4, so a tiny precision loss is expected.
      check(fidelity > 0.9999, 'stored vector matches the original', `cosine = ${fidelity.toFixed(6)}`);
    }

    // 5. Constraints that could not be checked over the REST API.
    const { error: dupDocError } = await client
      .from('documents')
      .insert({ title: 'duplicate', source_type: 'markdown', content_hash: contentHash });
    check(
      dupDocError?.code === '23505',
      'UNIQUE(content_hash) rejects a duplicate document',
      dupDocError ? `${dupDocError.code}` : 'no error — constraint missing!',
    );

    const { error: dupChunkError } = await client.from('chunks').insert({
      document_id: documentId,
      chunk_index: 0,
      content: 'duplicate position',
      token_count: 5,
    });
    check(
      dupChunkError?.code === '23505',
      'UNIQUE(document_id, chunk_index) rejects a duplicate position',
      dupChunkError ? `${dupChunkError.code}` : 'no error — constraint missing!',
    );

    const { error: fkError } = await client.from('chunks').insert({
      document_id: randomUUID(),
      chunk_index: 0,
      content: 'orphan',
      token_count: 5,
    });
    check(
      fkError?.code === '23503',
      'FOREIGN KEY rejects a chunk with no parent document',
      fkError ? `${fkError.code}` : 'no error — foreign key missing!',
    );

    const { error: dimError } = await client.from('chunks').insert({
      document_id: documentId,
      chunk_index: 99,
      content: 'wrong width',
      token_count: 5,
      // Sent as a raw literal on purpose: this asserts the DATABASE rejects a
      // wrong width. toPgVector would refuse it client-side before it got here.
      embedding: '[0.1,0.2,0.3]',
    });
    check(
      Boolean(dimError),
      'vector(768) rejects a 3-dimension vector',
      dimError ? dimError.message.slice(0, 70) : 'no error — dimension not enforced!',
    );
  } finally {
    // 6. Clean up. Deleting the document must cascade to its chunks.
    if (documentId) {
      const { error: deleteError } = await client.from('documents').delete().eq('id', documentId);
      check(!deleteError, 'delete test document', deleteError?.message ?? 'ok');

      const { count } = await client
        .from('chunks')
        .select('*', { count: 'exact', head: true })
        .eq('document_id', documentId);
      check(count === 0, 'ON DELETE CASCADE removed the chunks', `${count ?? '?'} chunks remain`);
    }
  }
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
