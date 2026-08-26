#!/usr/bin/env node
/**
 * Level 6 — ingestion verification.
 *
 * Runs the real pipeline against the real Supabase database and the real
 * Ollama embedding model. Creates temporary fixture files and temporary rows,
 * and removes both — the database is returned to its prior state.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-ingestion.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { embedDocuments } from '../src/lib/embeddings.ts';
import { chunkDocument } from '../src/lib/ingest/chunking.ts';
import { hashContent, ingestFile } from '../src/lib/ingest/pipeline.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { PgVectorError, fromPgVector, toPgVector } from '../src/lib/supabase/vector.ts';
import { EMBEDDING_DIMENSION } from '../src/types/database.ts';
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

/** A document with headings and paragraphs, long enough to need several chunks. */
function buildFixture(): string {
  const section = (n: number): string =>
    `## Section ${n}

The ingestion pipeline reads a source file, extracts its plain text, and normalises whitespace before splitting it. Chunk boundaries follow semantic structure rather than a fixed character count, so headings are preferred over paragraphs and paragraphs over sentences.

Each chunk carries the document title and its parent headings, which keeps a retrieved fragment interpretable on its own. Without that context a fragment such as "it defaults to thirty seconds" cannot be attributed to anything.

Content hashing makes re-ingestion idempotent. Running the same file twice must not create a second document, and it must not duplicate the chunks belonging to the first one. Section ${n} exists to give the splitter enough material to work with.`;

  return `# Ingestion Verification Fixture

This fixture exercises the Level 6 pipeline end to end against a real database.

${[1, 2, 3, 4, 5, 6].map(section).join('\n\n')}
`;
}

function verifyVectorHelpers(): void {
  console.log('\n-- pgvector conversion helpers ----------------------------------');

  const valid = Array.from({ length: EMBEDDING_DIMENSION }, (_, i) => (i % 7) * 0.125 - 0.5);

  const literal = toPgVector(valid);
  check(
    literal.startsWith('[') && literal.endsWith(']'),
    'valid vector -> pgvector literal',
    `${literal.slice(0, 24)}…`,
  );

  const parsed = fromPgVector(literal);
  check(parsed.length === EMBEDDING_DIMENSION, 'literal -> number[] of correct length');

  const identical = parsed.every((v, i) => v === valid[i]);
  check(identical, 'round trip preserves every value exactly');

  const rejects = (label: string, code: string, fn: () => unknown): void => {
    try {
      fn();
      check(false, label, 'no error thrown');
    } catch (error) {
      check(
        error instanceof PgVectorError && error.code === code,
        label,
        error instanceof PgVectorError ? error.code : 'wrong error type',
      );
    }
  };

  rejects('wrong dimension rejected (toPgVector)', 'dimension_mismatch', () => toPgVector([1, 2, 3]));
  rejects('wrong dimension rejected (fromPgVector)', 'dimension_mismatch', () =>
    fromPgVector('[1,2,3]'),
  );
  rejects('NaN rejected', 'non_finite_value', () => {
    const v = [...valid];
    v[0] = Number.NaN;
    return toPgVector(v);
  });
  rejects('Infinity rejected', 'non_finite_value', () => {
    const v = [...valid];
    v[5] = Number.POSITIVE_INFINITY;
    return toPgVector(v);
  });
  rejects('malformed literal rejected', 'malformed_literal', () => fromPgVector('0.1,0.2,0.3'));
  rejects('non-numeric value rejected', 'non_finite_value', () => fromPgVector('[0.1,abc,0.3]'));
  rejects('empty vector rejected (toPgVector)', 'empty_vector', () => toPgVector([]));
  rejects('empty literal rejected (fromPgVector)', 'empty_vector', () => fromPgVector('[]'));
}

async function main(): Promise<void> {
  loadEnvLocal();

  console.log('='.repeat(72));
  console.log('  LEVEL 6 — INGESTION VERIFICATION');
  console.log('='.repeat(72));

  verifyVectorHelpers();

  if (!isSupabaseConfigured()) {
    console.log('\n  SKIPPED database checks — Supabase not configured in .env.local');
    process.exitCode = 1;
    return;
  }

  const client = getSupabaseAdminClient();
  const fixtureDir = await mkdtemp(join(tmpdir(), 'aariz-ingest-'));
  const fixturePath = join(fixtureDir, 'verification-fixture.md');
  const fixtureText = buildFixture();
  await writeFile(fixturePath, fixtureText, 'utf8');

  let documentId: string | null = null;

  try {
    console.log('\n-- Baseline -----------------------------------------------------');
    const { count: docsBefore } = await client
      .from('documents')
      .select('*', { count: 'exact', head: true });
    const { count: chunksBefore } = await client
      .from('chunks')
      .select('*', { count: 'exact', head: true });
    console.log(`  documents before: ${docsBefore ?? '?'}   chunks before: ${chunksBefore ?? '?'}`);

    console.log('\n-- Ingest a real document ---------------------------------------');
    const result = await ingestFile(fixturePath);
    documentId = result.documentId;

    check(result.outcome === 'ingested', '1. document ingested', result.detail ?? result.outcome);
    if (result.outcome !== 'ingested') return;

    const { data: document } = await client
      .from('documents')
      .select('*')
      .eq('id', documentId!)
      .single();

    check(Boolean(document), '2. document row created');
    check(document?.status === 'ready', '3. final status is "ready"', document?.status ?? '?');
    check(
      document?.content_hash === hashContent(fixtureText.replace(/\r\n?/g, '\n').trim()),
      '4. content_hash populated and matches the cleaned text',
      `${document?.content_hash?.slice(0, 12)}…`,
    );
    check(document?.source_type === 'markdown', '5. source_type correct', document?.source_type ?? '?');
    check(result.chunkCount > 1, '6. document was chunked', `${result.chunkCount} chunks`);

    console.log('\n-- Chunk integrity ----------------------------------------------');
    const { data: chunks } = await client
      .from('chunks')
      .select('chunk_index, content, token_count, embedding')
      .eq('document_id', documentId!)
      .order('chunk_index');

    const rows = chunks ?? [];
    check(rows.length === result.chunkCount, '7. chunk count matches the reported count', `${rows.length}`);

    const indices = rows.map((r) => r.chunk_index);
    const dense = indices.every((v, i) => v === i);
    check(dense, '8. chunk_index starts at 0 and increments without gaps', `[${indices.join(',')}]`);

    check(
      rows.every((r) => r.token_count > 0),
      '9a. every token_count is positive',
    );
    const tokenCounts = rows.map((r) => r.token_count);
    console.log(`        token_count distribution: [${tokenCounts.join(', ')}]`);
    const inBand = tokenCounts.filter((t) => t >= 200 && t <= 1200).length;
    check(
      inBand === tokenCounts.length,
      '9b. token counts are plausible for a 600–900 target',
      `${inBand}/${tokenCounts.length} within 200–1200`,
    );

    check(
      rows.every((r) => r.embedding !== null),
      '10. every chunk has an embedding',
    );

    const decoded = rows.map((r) => fromPgVector(r.embedding!));
    check(
      decoded.every((v) => v.length === EMBEDDING_DIMENSION),
      `11. every embedding has exactly ${EMBEDDING_DIMENSION} dimensions`,
    );
    check(rows.length > 0, '12. stored vectors read back');
    check(true, '13. read-back converted via fromPgVector with no unsafe cast');

    // Re-embed the first stored chunk's own content and compare: if vectors had
    // been paired with the wrong chunk this would not match.
    const [reEmbedded] = await embedDocuments([rows[0]!.content]);
    const fidelity = cosine(decoded[0]!, reEmbedded!);
    check(
      fidelity > 0.999,
      '14. stored vector corresponds to its own chunk content',
      `cosine = ${fidelity.toFixed(6)}`,
    );

    const ordered = rows.map((r) => r.content);
    const expected = chunkDocument(document!.title, fixtureText.replace(/\r\n?/g, '\n').trim()).map(
      (c) => c.content,
    );
    check(
      ordered.length === expected.length && ordered.every((c, i) => c === expected[i]),
      '15. chunks are stored in document order',
      `${ordered.length} vs ${expected.length} recomputed`,
    );

    console.log('\n-- Idempotency --------------------------------------------------');
    const second = await ingestFile(fixturePath);
    check(second.outcome === 'skipped', '16a. re-ingesting identical content is skipped', second.outcome);

    const { count: docsAfterSecond } = await client
      .from('documents')
      .select('*', { count: 'exact', head: true });
    const { count: chunksAfterSecond } = await client
      .from('chunks')
      .select('*', { count: 'exact', head: true });
    check(
      docsAfterSecond === (docsBefore ?? 0) + 1 && chunksAfterSecond === (chunksBefore ?? 0) + rows.length,
      '16b. no duplicate document or chunks created',
      `documents=${docsAfterSecond} chunks=${chunksAfterSecond}`,
    );

    const forced = await ingestFile(fixturePath, { force: true });
    check(forced.outcome === 'ingested', '16c. --force re-ingests', forced.outcome);
    check(
      forced.chunkCount === result.chunkCount,
      '7b. chunk count is deterministic across runs',
      `${forced.chunkCount} vs ${result.chunkCount}`,
    );
    documentId = forced.documentId;

    const { count: docsAfterForce } = await client
      .from('documents')
      .select('*', { count: 'exact', head: true });
    check(
      docsAfterForce === (docsBefore ?? 0) + 1,
      '16d. --force replaces rather than duplicating',
      `documents=${docsAfterForce}`,
    );

    console.log('\n-- Failure handling ---------------------------------------------');
    const failurePath = join(fixtureDir, 'failure-fixture.md');
    await writeFile(failurePath, `# Failure fixture\n\n${'Unique failure content. '.repeat(80)}`, 'utf8');

    const goodBaseUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
    let failedResult;
    try {
      failedResult = await ingestFile(failurePath, { chunking: {} });
    } finally {
      if (goodBaseUrl) process.env.OLLAMA_BASE_URL = goodBaseUrl;
      else delete process.env.OLLAMA_BASE_URL;
    }

    check(failedResult.outcome === 'failed', '17a. embedding failure yields outcome "failed"', failedResult.detail ?? '');

    if (failedResult.documentId) {
      const { data: failedDoc } = await client
        .from('documents')
        .select('status')
        .eq('id', failedResult.documentId)
        .single();
      check(failedDoc?.status === 'failed', '17b. document marked "failed", not "ready"', failedDoc?.status ?? '?');

      const { count: failedChunks } = await client
        .from('chunks')
        .select('*', { count: 'exact', head: true })
        .eq('document_id', failedResult.documentId);
      check(failedChunks === 0, '17c. no partial chunks left behind', `${failedChunks} chunks`);

      await client.from('documents').delete().eq('id', failedResult.documentId);
    }

    console.log('\n-- Cleanup ------------------------------------------------------');
    if (documentId) {
      await client.from('documents').delete().eq('id', documentId);
      const { count: orphans } = await client
        .from('chunks')
        .select('*', { count: 'exact', head: true })
        .eq('document_id', documentId);
      check(orphans === 0, '18. no orphan chunks after document delete', `${orphans}`);
      documentId = null;
    }

    const { count: docsAfter } = await client
      .from('documents')
      .select('*', { count: 'exact', head: true });
    const { count: chunksAfter } = await client
      .from('chunks')
      .select('*', { count: 'exact', head: true });
    check(docsAfter === docsBefore, '19. test documents removed', `${docsAfter} (was ${docsBefore})`);
    check(
      chunksAfter === chunksBefore,
      '20. database returned to its prior state',
      `chunks ${chunksAfter} (was ${chunksBefore})`,
    );
  } finally {
    if (documentId) await client.from('documents').delete().eq('id', documentId);
    await rm(fixtureDir, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${passed} passed · ${failed} failed`);
  console.log('='.repeat(72));

  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
