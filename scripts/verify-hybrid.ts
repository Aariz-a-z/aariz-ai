#!/usr/bin/env node
/**
 * Level 9 — hybrid search verification.
 *
 * Exercises the real path: real Ollama embeddings, real Supabase, the real
 * hybrid_match_chunks RPC, the real GIN full-text index and the real HNSW
 * vector index. Nothing is simulated.
 *
 * The central claim under test is comparative: hybrid must retrieve chunks that
 * pure vector search misses or ranks poorly, WITHOUT losing the semantic
 * behaviour Level 7 already had. Both paths are run over the same corpus and
 * compared directly.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-hybrid.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ingestFile } from '../src/lib/ingest/pipeline.ts';
import {
  RetrievalError,
  getRetrievalConfig,
  retrieveChunks,
  retrieveHybrid,
} from '../src/lib/retrieval.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { loadEnvLocal } from './_env.ts';

let passed = 0;
let failed = 0;
let blocked = 0;

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
}

/**
 * Corpus designed to separate the two retrieval modes.
 *
 * Each document carries a rare identifier (an error code, a version string, a
 * product name) embedded in prose that is otherwise semantically similar to the
 * others. Embeddings blur rare tokens — that is exactly the weakness Level 9
 * exists to cover — so a query naming an identifier is where hybrid should win.
 */
const CORPUS = [
  {
    slug: 'alpha',
    title: 'Payment Gateway Runbook',
    body: `When a settlement batch stalls the service emits diagnostic code ERR-4471 into the operator log. The on-call engineer should drain the pending queue before retrying, because a second attempt while the queue is populated will duplicate the batch. Recovery normally completes within a few minutes once the queue is empty.`,
  },
  {
    slug: 'beta',
    title: 'Ledger Service Upgrade Notes',
    body: `Release 12.4.7-rc2 changes how reconciliation snapshots are written. Older snapshots remain readable, but any job started before the upgrade must be allowed to finish first. Operators should schedule the rollout during a quiet window and keep the previous build available for a rollback.`,
  },
  {
    slug: 'gamma',
    title: 'Treasury Platform Overview',
    body: `The Quillfeather module handles intraday liquidity forecasting for the treasury desk. It reads balances from the core ledger every fifteen minutes and produces a projection that the desk uses to decide short-term funding. Its accuracy depends on the freshness of the underlying balance feed.`,
  },
  {
    slug: 'delta',
    title: 'Operations Handbook',
    body: `Incident response follows a documented escalation path. The first responder acknowledges the alert, assesses customer impact, and decides whether to page the wider team. Post-incident reviews are written within two working days and focus on contributing factors rather than individual blame.`,
  },

  // --- Near-duplicate decoys -------------------------------------------------
  // The four documents above sit on distinct topics, which makes them easy: an
  // embedding of "ERR-4471" lands on the payments document because nothing else
  // is close. That does not exercise hybrid search at all.
  //
  // These decoys create the case hybrid actually exists for — passages that are
  // semantically almost identical and differ only in a rare identifier. Vector
  // similarity cannot separate them; full-text search can.
  ...['4472', '4473', '4474', '4475'].map((code) => ({
    slug: `decoy-${code}`,
    title: `Settlement Incident ${code}`,
    body: `When a settlement batch stalls the service emits diagnostic code ERR-${code} into the operator log. The on-call engineer should drain the pending queue before retrying, because a second attempt while the queue is populated will duplicate the batch. Recovery normally completes within a few minutes once the queue is empty.`,
  })),
];

/** Queries naming a rare identifier — the case hybrid is meant to fix. */
const KEYWORD_QUERIES = [
  // The discriminating case: five near-identical passages, one identifier apart.
  { query: 'ERR-4473', expectSlug: 'decoy-4473', label: 'error code among near-duplicates' },
  { query: 'ERR-4471', expectSlug: 'alpha', label: 'error code' },
  { query: '12.4.7-rc2', expectSlug: 'beta', label: 'version string' },
  { query: 'Quillfeather', expectSlug: 'gamma', label: 'product name' },
];

/** Semantic queries sharing little literal wording — Level 7 behaviour must survive. */
const SEMANTIC_QUERIES = [
  { query: 'What should the on-call person do when a payment batch gets stuck?', expectSlug: 'alpha', label: 'payments' },
  { query: 'How should a team handle reviewing an outage afterwards?', expectSlug: 'delta', label: 'incident review' },
];

async function main(): Promise<void> {
  loadEnvLocal();

  const config = getRetrievalConfig();
  console.log('='.repeat(72));
  console.log('  LEVEL 9 — HYBRID SEARCH VERIFICATION');
  console.log(
    `  MATCH_COUNT=${config.matchCount}  SIMILARITY_THRESHOLD=${config.similarityThreshold}` +
      `  RRF_K=${config.rrfK}  HYBRID_CANDIDATES=${config.hybridCandidates}`,
  );
  console.log('='.repeat(72));

  console.log('\n-- Input validation ---------------------------------------------');
  for (const [label, args] of [
    ['empty query', ['']],
    ['whitespace-only query', ['   \n ']],
  ] as const) {
    try {
      await retrieveHybrid(args[0]);
      check(false, `${label} rejected`, 'no error thrown');
    } catch (error) {
      check(
        error instanceof RetrievalError && error.code === 'invalid_query',
        `${label} rejected`,
        error instanceof RetrievalError ? error.code : 'wrong error type',
      );
    }
  }
  for (const [label, opts] of [
    ['matchCount = 0', { matchCount: 0 }],
    ['threshold = 5', { similarityThreshold: 5 }],
  ] as const) {
    try {
      await retrieveHybrid('anything', opts);
      check(false, `invalid ${label} rejected`, 'no error thrown');
    } catch (error) {
      check(error instanceof RetrievalError, `invalid ${label} rejected`, error instanceof RetrievalError ? error.code : '');
    }
  }

  if (!isSupabaseConfigured()) {
    console.log('\n  BLOCKED — Supabase not configured');
    blocked++;
    process.exitCode = 1;
    return;
  }

  const client = getSupabaseAdminClient();

  // The RPC is DDL that must be applied manually; fail loudly rather than
  // reporting a misleading pass.
  const probe = await client.rpc('hybrid_match_chunks', {
    query_embedding: `[${new Array(768).fill(0).join(',')}]`,
    query_text: 'probe',
    match_count: 1,
    similarity_threshold: -1,
    rrf_k: 60,
    candidate_count: 10,
  });
  if (probe.error) {
    console.log(`\n  BLOCKED — hybrid_match_chunks not callable: ${probe.error.code ?? ''} ${probe.error.message}`);
    console.log('  Apply supabase/migrations/20260819120000_hybrid_search.sql in the SQL Editor.');
    blocked++;
    console.log(`\n  ${passed} passed · ${failed} failed · ${blocked} blocked`);
    process.exitCode = 1;
    return;
  }
  check(true, 'hybrid_match_chunks RPC is callable');

  const dir = await mkdtemp(join(tmpdir(), 'aariz-hybrid-'));
  const documentIds: string[] = [];
  const slugToId = new Map<string, string>();

  try {
    console.log('\n-- Seeding corpus -----------------------------------------------');
    for (const entry of CORPUS) {
      const path = join(dir, `${entry.slug}.md`);
      await writeFile(path, `# ${entry.title}\n\n${entry.body}\n`, 'utf8');
      const result = await ingestFile(path);
      if (result.outcome !== 'ingested' || !result.documentId) {
        check(false, `seed ${entry.slug}`, result.detail ?? result.outcome);
        return;
      }
      documentIds.push(result.documentId);
      slugToId.set(entry.slug, result.documentId);
      console.log(`  seeded ${entry.slug.padEnd(6)} ${entry.title}`);
    }

    // Confirm the generated tsvector column actually populated for new rows.
    const { data: tsvRows } = await client
      .from('chunks')
      .select('id, content_tsv')
      .limit(1);
    check(
      Array.isArray(tsvRows) && tsvRows.length > 0 && Boolean(tsvRows[0]!.content_tsv),
      'generated content_tsv column is populated on ingest',
      typeof tsvRows?.[0]?.content_tsv === 'string' ? `${String(tsvRows[0]!.content_tsv).slice(0, 40)}…` : 'present',
    );

    console.log('\n-- Exact keyword queries: hybrid vs pure vector ------------------');
    let hybridWins = 0;
    for (const q of KEYWORD_QUERIES) {
      const expectedId = slugToId.get(q.expectSlug)!;

      const hybrid = await retrieveHybrid(q.query, { matchCount: 3 });
      const vectorOnly = await retrieveChunks(q.query, { matchCount: 3 });

      const hybridTop = hybrid[0]?.documentId === expectedId;
      const vectorTop = vectorOnly[0]?.documentId === expectedId;
      const vectorRankOfExpected = vectorOnly.findIndex((r) => r.documentId === expectedId);

      console.log(
        `  "${q.query}" (${q.label})\n` +
          `     hybrid top: ${hybrid[0]?.documentTitle ?? '(none)'}  ` +
          `[v_rank=${hybrid[0]?.vectorRank ?? '-'} k_rank=${hybrid[0]?.keywordRank ?? '-'} rrf=${hybrid[0]?.rrfScore.toFixed(5) ?? '-'}]\n` +
          `     vector top: ${vectorOnly[0]?.documentTitle ?? '(none)'}  ` +
          `(expected doc at vector position ${vectorRankOfExpected === -1 ? 'absent' : vectorRankOfExpected + 1})`,
      );

      check(hybridTop, `hybrid ranks the ${q.label} document first`);
      if (hybridTop && !vectorTop) hybridWins++;

      check(
        hybrid[0]?.keywordRank != null,
        `${q.label} hit was surfaced by the full-text arm`,
        `keyword_rank=${hybrid[0]?.keywordRank ?? 'null'}`,
      );
    }

    check(
      hybridWins > 0,
      'hybrid beats pure vector on at least one exact-identifier query',
      `${hybridWins}/${KEYWORD_QUERIES.length} queries where vector alone failed`,
    );

    console.log('\n-- Semantic queries still work ----------------------------------');
    for (const q of SEMANTIC_QUERIES) {
      const expectedId = slugToId.get(q.expectSlug)!;
      const hybrid = await retrieveHybrid(q.query, { matchCount: 3 });
      console.log(
        `  "${q.query.slice(0, 52)}…"\n     top: ${hybrid[0]?.documentTitle ?? '(none)'}  ` +
          `sim=${hybrid[0]?.similarity.toFixed(4) ?? '-'}`,
      );
      check(hybrid[0]?.documentId === expectedId, `semantic "${q.label}" query still ranks correctly`);
    }

    console.log('\n-- Fusion mechanics ---------------------------------------------');
    const fused = await retrieveHybrid('ERR-4471 settlement batch queue', { matchCount: 5 });

    const descending = fused.every((r, i) => i === 0 || fused[i - 1]!.rrfScore >= r.rrfScore);
    check(descending, 'results ordered by fused RRF score, highest first', fused.map((r) => r.rrfScore.toFixed(5)).join(' > '));

    const bothArms = fused.filter((r) => r.vectorRank != null && r.keywordRank != null);
    check(bothArms.length > 0, 'at least one chunk was found by BOTH arms', `${bothArms.length} of ${fused.length}`);

    // Verify the RRF arithmetic against the ranks the database reported.
    const sample = fused[0]!;
    const expectedRrf =
      (sample.vectorRank != null ? 1 / (config.rrfK + sample.vectorRank) : 0) +
      (sample.keywordRank != null ? 1 / (config.rrfK + sample.keywordRank) : 0);
    check(
      Math.abs(expectedRrf - sample.rrfScore) < 1e-9,
      'RRF score equals 1/(k+vector_rank) + 1/(k+keyword_rank)',
      `reported=${sample.rrfScore.toFixed(8)} recomputed=${expectedRrf.toFixed(8)}`,
    );

    const ids = fused.map((r) => r.chunkId);
    check(new Set(ids).size === ids.length, 'no duplicate chunks after fusion');
    check(fused.length <= 5, 'top-K respected', `${fused.length} <= 5`);

    console.log('\n-- Keyword hits survive the vector threshold --------------------');
    // The threshold gates the vector arm only. With it pinned to an impossible
    // value the vector arm returns nothing, so anything that comes back proves
    // the keyword arm is independent.
    const keywordOnly = await retrieveHybrid('Quillfeather', {
      matchCount: 3,
      similarityThreshold: 0.99,
    });
    check(
      keywordOnly.length > 0,
      'keyword match survives an impossible vector threshold',
      `${keywordOnly.length} result(s), vector_rank=${keywordOnly[0]?.vectorRank ?? 'null'}`,
    );
    check(
      keywordOnly.length > 0 && keywordOnly[0]!.vectorRank === null,
      'that hit came from the keyword arm alone',
    );
    check(
      keywordOnly[0]?.documentId === slugToId.get('gamma'),
      'keyword-only hit is the correct document',
    );

    const vectorOnlyAtThreshold = await retrieveChunks('Quillfeather', {
      matchCount: 3,
      similarityThreshold: 0.99,
    });
    check(
      vectorOnlyAtThreshold.length === 0,
      'pure vector search returns nothing at that threshold (control)',
      `${vectorOnlyAtThreshold.length} results`,
    );

    console.log('\n-- No-result behaviour ------------------------------------------');
    const nothing = await retrieveHybrid('zzzqqq nonexistent token xyzzy', {
      matchCount: 3,
      similarityThreshold: 0.99,
    });
    check(nothing.length === 0, 'unmatched query returns an empty array cleanly', `${nothing.length}`);
  } finally {
    console.log('\n-- Cleanup ------------------------------------------------------');
    for (const id of documentIds) {
      await client.from('documents').delete().eq('id', id);
    }
    await rm(dir, { recursive: true, force: true });

    const { count: docs } = await client.from('documents').select('*', { count: 'exact', head: true });
    const { count: chunks } = await client.from('chunks').select('*', { count: 'exact', head: true });
    check(docs === 0, 'test documents removed', `documents=${docs}`);
    check(chunks === 0, 'no orphan chunks remain', `chunks=${chunks}`);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${passed} passed · ${failed} failed · ${blocked} blocked`);
  console.log('='.repeat(72));

  if (failed > 0 || blocked > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
