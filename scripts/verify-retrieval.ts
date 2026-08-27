#!/usr/bin/env node
/**
 * Level 7 — retrieval verification.
 *
 * Exercises the real path: real Ollama embeddings, the real Supabase database,
 * the real match_chunks RPC and the existing HNSW index. Nothing is simulated
 * in memory.
 *
 * Seeds a small four-topic corpus through the Level 6 ingestion pipeline,
 * queries it, and removes every row it created.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-retrieval.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EMBEDDING_DIMENSION, embedDocuments, embedQuery } from '../src/lib/embeddings.ts';
import { ingestFile } from '../src/lib/ingest/pipeline.ts';
import {
  RetrievalError,
  getRetrievalConfig,
  retrieveChunks,
} from '../src/lib/retrieval.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { fromPgVector } from '../src/lib/supabase/vector.ts';
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

/**
 * Four clearly distinct topics, written as ordinary prose. Queries below share
 * few literal words with these texts, so a keyword match would not find them —
 * only semantic similarity will.
 */
const CORPUS: { slug: string; title: string; body: string }[] = [
  {
    slug: 'ml',
    title: 'Machine Learning Foundations',
    body: `Supervised models improve by comparing their predictions against labelled examples and adjusting internal weights to reduce the resulting error. Gradient descent performs that adjustment, stepping each parameter in the direction that most reduces the loss. Overfitting occurs when a model memorises its examples rather than the pattern behind them, which is why a held-out set is kept aside to measure whether anything general was actually learned.`,
  },
  {
    slug: 'db',
    title: 'Relational Database Systems',
    body: `Transactions guarantee that a group of statements either all take effect or none do. Isolation levels decide how much concurrent activity a transaction may observe: at the strictest level a range query repeated inside one transaction returns the same rows both times, preventing new rows from appearing partway through. Write-ahead logging makes durability possible by recording an intention on disk before the change reaches the data pages.`,
  },
  {
    slug: 'net',
    title: 'Computer Networking Fundamentals',
    body: `A reliable stream protocol numbers every byte it sends and expects the far end to acknowledge what arrived. When an acknowledgement does not come back in time the sender assumes the segment was dropped, retransmits it, and reduces its sending rate on the assumption that a queue somewhere is saturated. This congestion response is what keeps a shared link from collapsing when many senders compete for it.`,
  },
  {
    slug: 'os',
    title: 'Operating System Concepts',
    body: `The scheduler decides which runnable task occupies the processor next. Swapping from one task to another means saving the registers and stack pointer of the outgoing task and restoring those of the incoming one, an operation cheap enough to do thousands of times a second but not free. Virtual memory gives each task the illusion of a private address space, with the memory management unit translating those addresses to physical frames.`,
  },
];

const QUERIES: { query: string; expectSlug: string; label: string }[] = [
  { query: 'How do neural networks learn from training examples?', expectSlug: 'ml', label: 'machine learning' },
  { query: 'Which isolation level stops phantom rows appearing mid-transaction?', expectSlug: 'db', label: 'databases' },
  { query: 'What happens when a packet is lost in transit?', expectSlug: 'net', label: 'networking' },
  { query: 'What is involved in a context switch between processes?', expectSlug: 'os', label: 'operating systems' },
];

async function main(): Promise<void> {
  loadEnvLocal();

  const config = getRetrievalConfig();
  console.log('='.repeat(72));
  console.log('  LEVEL 7 — RETRIEVAL VERIFICATION');
  console.log(`  MATCH_COUNT=${config.matchCount}  SIMILARITY_THRESHOLD=${config.similarityThreshold}`);
  console.log('='.repeat(72));

  if (!isSupabaseConfigured()) {
    console.log('\n  BLOCKED — Supabase not configured in .env.local');
    process.exitCode = 1;
    return;
  }

  const client = getSupabaseAdminClient();

  console.log('\n-- Input validation (no database needed) ------------------------');
  for (const [label, bad] of [
    ['empty query', ''],
    ['whitespace-only query', '   \n\t '],
  ] as const) {
    try {
      await retrieveChunks(bad);
      check(false, `10/11. ${label} rejected`, 'no error thrown');
    } catch (error) {
      check(
        error instanceof RetrievalError && error.code === 'invalid_query',
        `10/11. ${label} rejected`,
        error instanceof RetrievalError ? error.code : 'wrong error type',
      );
    }
  }
  for (const [label, opts, code] of [
    ['matchCount = 0', { matchCount: 0 }, 'invalid_match_count'],
    ['matchCount = 1.5', { matchCount: 1.5 }, 'invalid_match_count'],
    ['matchCount = 1000', { matchCount: 1000 }, 'invalid_match_count'],
    ['threshold = 2', { similarityThreshold: 2 }, 'invalid_threshold'],
  ] as const) {
    try {
      await retrieveChunks('anything', opts);
      check(false, `invalid ${label} rejected`, 'no error thrown');
    } catch (error) {
      check(
        error instanceof RetrievalError && error.code === code,
        `invalid ${label} rejected`,
        error instanceof RetrievalError ? error.code : 'wrong error type',
      );
    }
  }

  console.log('\n-- Query embedding ----------------------------------------------');
  const probe = 'How do neural networks learn?';
  const queryVector = await embedQuery(probe);
  check(queryVector.length === EMBEDDING_DIMENSION, `1. query embedding is ${EMBEDDING_DIMENSION}-d`, `${queryVector.length}`);

  const asDocument = (await embedDocuments([probe]))[0]!;
  const prefixDelta = cosine(queryVector, asDocument);
  check(
    prefixDelta < 0.999,
    '2/17. query and document prefixes differ (embedQuery, not embedDocuments)',
    `cos = ${prefixDelta.toFixed(4)}`,
  );

  // --- Seed the corpus through the real Level 6 pipeline --------------------
  const dir = await mkdtemp(join(tmpdir(), 'aariz-retrieval-'));
  const documentIds: string[] = [];
  const slugToDocumentId = new Map<string, string>();

  try {
    const { count: docsBefore } = await client.from('documents').select('*', { count: 'exact', head: true });
    const { count: chunksBefore } = await client.from('chunks').select('*', { count: 'exact', head: true });
    console.log(`\n-- Seeding corpus (documents before: ${docsBefore}, chunks before: ${chunksBefore}) --`);

    for (const entry of CORPUS) {
      const path = join(dir, `${entry.slug}.md`);
      await writeFile(path, `# ${entry.title}\n\n${entry.body}\n`, 'utf8');
      const result = await ingestFile(path);
      if (result.outcome !== 'ingested' || !result.documentId) {
        check(false, `seed "${entry.title}"`, result.detail ?? result.outcome);
        return;
      }
      documentIds.push(result.documentId);
      slugToDocumentId.set(entry.slug, result.documentId);
      console.log(`  seeded ${entry.slug.padEnd(4)} ${result.chunkCount} chunk(s)  ${entry.title}`);
    }

    console.log('\n-- Semantic ranking ---------------------------------------------');
    let allTopHits = true;
    for (const q of QUERIES) {
      const results = await retrieveChunks(q.query);
      const expectedId = slugToDocumentId.get(q.expectSlug)!;
      const topIsExpected = results.length > 0 && results[0]!.documentId === expectedId;
      if (!topIsExpected) allTopHits = false;
      const others = results.filter((r) => r.documentId !== expectedId);
      const bestOther = others.length > 0 ? others[0]!.similarity : 0;
      console.log(
        `  "${q.query.slice(0, 46)}…"\n     top: ${results[0]?.documentTitle ?? '(none)'}  ` +
          `sim=${results[0]?.similarity.toFixed(4) ?? '-'}  next-other=${bestOther.toFixed(4)}`,
      );
      check(topIsExpected, `4/5. "${q.label}" query ranks its own document first`);
    }
    check(allTopHits, '3. retrieval returns results for every query');

    // --- Ordering, top-K, metadata ------------------------------------------
    console.log('\n-- Ordering, top-K, metadata ------------------------------------');
    const results = await retrieveChunks(QUERIES[0]!.query, { matchCount: 4, similarityThreshold: -1 });
    const descending = results.every((r, i) => i === 0 || results[i - 1]!.similarity >= r.similarity);
    check(descending, '6. results ordered by similarity, highest first', results.map((r) => r.similarity.toFixed(3)).join(' > '));

    const two = await retrieveChunks(QUERIES[0]!.query, { matchCount: 2, similarityThreshold: -1 });
    check(two.length <= 2, '7. top-K respected', `matchCount=2 returned ${two.length}`);

    const ids = results.map((r) => r.chunkId);
    check(new Set(ids).size === ids.length, '15. no duplicate results');

    const top = results[0]!;
    const { data: storedChunk } = await client
      .from('chunks')
      .select('id, document_id, chunk_index, content, embedding')
      .eq('id', top.chunkId)
      .single();
    check(
      storedChunk?.document_id === top.documentId &&
        storedChunk?.chunk_index === top.chunkIndex &&
        storedChunk?.content === top.content,
      '16. returned chunk metadata matches the stored row',
    );

    const { data: storedDoc } = await client
      .from('documents')
      .select('title, source_url')
      .eq('id', top.documentId)
      .single();
    check(storedDoc?.title === top.documentTitle, '16b. document title matches', top.documentTitle);
    check(storedDoc?.source_url === top.sourceUrl, '16c. source_url matches', String(top.sourceUrl));

    // --- Similarity arithmetic ----------------------------------------------
    console.log('\n-- Similarity metric --------------------------------------------');
    const storedVector = fromPgVector(storedChunk!.embedding!);
    const queryForTop = await embedQuery(QUERIES[0]!.query);
    const localCosine = cosine(queryForTop, storedVector);
    const delta = Math.abs(localCosine - top.similarity);
    check(
      delta < 0.001,
      '8. reported similarity equals locally computed cosine similarity',
      `rpc=${top.similarity.toFixed(6)} local=${localCosine.toFixed(6)} Δ=${delta.toExponential(2)}`,
    );
    check(
      top.similarity > 0 && top.similarity <= 1,
      '8b. similarity is a similarity, not a distance',
      `${top.similarity.toFixed(4)}`,
    );

    // --- Threshold -----------------------------------------------------------
    console.log('\n-- Threshold behaviour ------------------------------------------');
    const loose = await retrieveChunks(QUERIES[0]!.query, { matchCount: 20, similarityThreshold: -1 });
    const strict = await retrieveChunks(QUERIES[0]!.query, { matchCount: 20, similarityThreshold: 0.95 });
    check(loose.length > strict.length, '9. higher threshold returns fewer results', `${loose.length} vs ${strict.length}`);
    check(
      loose.every((r) => r.similarity >= -1) && strict.every((r) => r.similarity >= 0.95),
      '9b. every returned result clears the threshold',
    );

    const impossible = await retrieveChunks('zzzz qqqq unrelated gibberish token', {
      similarityThreshold: 0.99,
    });
    check(impossible.length === 0, '12. no-result case returns an empty array cleanly', `${impossible.length} results`);

    // --- Failure surfacing ---------------------------------------------------
    console.log('\n-- Failures are surfaced ----------------------------------------');
    const goodOllama = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1';
    try {
      await retrieveChunks('anything at all');
      check(false, '14. embedding provider failure surfaced', 'no error thrown');
    } catch (error) {
      check(error instanceof Error && /reach the embedding server/i.test(error.message), '14. embedding provider failure surfaced', error instanceof Error ? error.name : '');
    } finally {
      if (goodOllama) process.env.OLLAMA_BASE_URL = goodOllama;
      else delete process.env.OLLAMA_BASE_URL;
    }

    const { error: rpcError } = await client.rpc('match_chunks', {
      query_embedding: '[1,2,3]',
      match_count: 5,
      similarity_threshold: 0,
    });
    check(Boolean(rpcError), '13. database errors are surfaced, not swallowed', rpcError?.message?.slice(0, 60) ?? 'none');
  } finally {
    console.log('\n-- Cleanup ------------------------------------------------------');
    for (const id of documentIds) {
      await client.from('documents').delete().eq('id', id);
    }
    await rm(dir, { recursive: true, force: true });

    /**
     * Scoped to the ids THIS RUN created, not to the whole table.
     *
     * These asserted the `documents` and `chunks` tables were globally empty,
     * which only holds on a pristine database. Once the project owner had
     * uploaded a real document, a perfectly correct cleanup began reporting
     * failures — and the obvious way to make them green again would have been
     * to delete somebody's actual file.
     *
     * Tracking ids is also stricter than counting rows: a global zero is also
     * satisfied by a run that created nothing at all, whereas this fails if any
     * specific row this run made survives.
     */
    let documentsLeft = 0;
    let chunksLeft = 0;
    for (const id of documentIds) {
      const { count: d } = await client
        .from('documents')
        .select('*', { count: 'exact', head: true })
        .eq('id', id);
      const { count: c } = await client
        .from('chunks')
        .select('*', { count: 'exact', head: true })
        .eq('document_id', id);
      documentsLeft += d ?? 0;
      chunksLeft += c ?? 0;
    }
    check(
      documentsLeft === 0,
      '20. every document this run seeded was removed',
      `${documentsLeft} of ${documentIds.length} still present`,
    );
    check(chunksLeft === 0, '20b. their chunks went with them', `chunks=${chunksLeft}`);
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
