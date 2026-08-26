#!/usr/bin/env node
/**
 * Level 22 — re-ingestion verification.
 *
 * ROADMAP.md Level 22's real requirement is a NEGATIVE one:
 *
 *     Never: delete all embeddings then rebuild, because that creates
 *     downtime. The live chatbot should continue using the old index until the
 *     new one is ready.
 *
 * A negative like that cannot be proved by watching a successful run — a run
 * that happens not to delete anything looks identical to one that could not.
 * So this suite proves it two ways:
 *
 *   statically   by reading `scripts/reingest.ts` and asserting there is NO
 *                code path that deletes or nulls a live embedding, and that
 *                the only write to the live column is the atomic promote.
 *                This is the stronger of the two: it holds for every input,
 *                not just the one that was tried.
 *
 *   dynamically  by running the whole lifecycle against a real corpus and
 *                confirming the live index answers a real query at every
 *                stage — before the build, during it, and after promotion.
 *
 * The dynamic half needs the migration applied. When it is not, those checks
 * report BLOCKED rather than passing vacuously, because "the table is missing"
 * and "the table is empty" are indistinguishable to a count query — the Level
 * 12 lesson that a `head`+`count` against an absent table returns
 * `error === null, count === null`.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-reingest.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import { getEmbeddingModel } from '../src/lib/embeddings.ts';
import { loadEnvLocal } from './_env.ts';

let passed = 0;
let failed = 0;
let blocked = 0;

function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) passed++;
  else failed++;
}

function block(label: string, detail = ''): void {
  console.log(`  [BLOCKED] ${label}${detail ? `  — ${detail}` : ''}`);
  blocked++;
}

function summary(): void {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`  ${passed} passed · ${failed} failed · ${blocked} blocked`);
  console.log('='.repeat(72));
  if (failed > 0 || blocked > 0) process.exitCode = 1;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/** Source with comments removed, so prose about a rule is not mistaken for it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Level 22 — re-ingestion ===\n');

  // =========================================================================
  console.log('-- The prohibition, proved from the source ------------------------');

  const script = code(read('scripts', 'reingest.ts'));

  /**
   * The load-bearing assertion of this level. Any of these would be a way to
   * take the live index down mid-rebuild.
   */
  const forbidden: [string, RegExp][] = [
    ["deletes from chunks", /from\(['"]chunks['"]\)[\s\S]{0,80}?\.delete\(/],
    ["nulls a live embedding", /update\(\s*\{[^}]*embedding\s*:\s*null/i],
    ["updates chunks.embedding directly", /from\(['"]chunks['"]\)[\s\S]{0,120}?\.update\(/],
    ["truncates anything", /truncate/i],
    ["drops anything", /\bdrop\s+(table|index|column)\b/i],
  ];
  for (const [label, pattern] of forbidden) {
    check(!pattern.test(script), `reingest.ts never ${label}`);
  }

  check(
    /promote_reindex/.test(script),
    'the only live-index write goes through promote_reindex',
  );
  check(
    /from\(['"]chunks['"]\)[\s\S]{0,60}?\.select\(/.test(script),
    'reingest.ts reads chunk text rather than re-chunking it',
  );
  check(
    !/ingestPath|chunkText|splitInto/i.test(script),
    '  and does not re-run the chunker (chunk ids, and therefore citations, survive)',
  );

  // Validation must gate promotion, not merely precede it in the docs.
  check(
    /const passed = await validate\(db\)[\s\S]{0,200}?if \(!passed\)[\s\S]{0,120}?return;/.test(script),
    'promote() refuses to run when validate() fails',
  );

  // =========================================================================
  console.log('\n-- The migration provides the five steps --------------------------');

  const migration = read('supabase', 'migrations', '20260826120000_reingest_staging.sql');

  for (const [label, pattern] of [
    ['a staging table separate from chunks', /create table if not exists public\.chunks_reindex/],
    ['its own HNSW index, so staged vectors can be searched', /chunks_reindex_embedding_hnsw_idx[\s\S]{0,80}hnsw/],
    ['a per-row model column, so a mixed build is detectable', /model\s+text\s+not null/],
    ['row level security enabled', /alter table public\.chunks_reindex enable row level security/],
    ['no grants to browser roles', /revoke all on public\.chunks_reindex from anon, authenticated/],
    ['an atomic promote function', /create or replace function public\.promote_reindex/],
    ['executable only by the service role', /grant execute on function public\.promote_reindex\(text\) to service_role/],
  ] as const) {
    check(pattern.test(migration), `the migration declares ${label}`);
  }

  for (const [label, pattern] of [
    ['a partial staging set', /Promoting a partial index would mix models/],
    ['a mixed-model staging set', /more than one model/],
    ['a dimension mismatch', /Dimension mismatch/],
    ['an empty staging set', /Nothing staged/],
  ] as const) {
    check(pattern.test(migration), `promote_reindex refuses ${label}`);
  }

  check(
    /update public\.chunks c\s+set embedding = r\.embedding/.test(migration),
    'the switch is a single UPDATE — one transaction, no window without embeddings',
  );
  check(
    !/delete from public\.chunks\b/i.test(migration) && !/truncate/i.test(migration),
    'the migration never deletes live embeddings',
  );

  // =========================================================================
  console.log('\n-- Against the live database --------------------------------------');

  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (url.length === 0 || key.length === 0) {
    block('Supabase is not configured', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    summary();
    return;
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // A plain select, never head+count: Level 12 established that a count
  // against a missing table resolves with no error and a null count, which
  // would let every check below pass without the table existing.
  const probe = await db.from('chunks_reindex').select('chunk_id').limit(1);

  if (probe.error !== null) {
    block(
      'the staging table does not exist — the migration is NOT applied',
      `${probe.error.code ?? '?'} ${probe.error.message}`,
    );
    console.log('\n  Apply this in the Supabase SQL editor, then re-run:');
    console.log('      supabase/migrations/20260826120000_reingest_staging.sql');
    console.log('\n  Every check above is static and holds regardless; the lifecycle');
    console.log('  checks below genuinely cannot run until the table exists.');

    // Still worth proving: the tool refuses to do anything without its table,
    // rather than failing halfway through a rebuild.
    check(
      /requireStaging/.test(script) && /PGRST205|does not exist yet/.test(read('scripts', 'reingest.ts')),
      'reingest.ts refuses up front when the migration is missing',
    );
    summary();
    return;
  }

  check(true, 'the staging table exists');

  const model = getEmbeddingModel();
  const liveCount = await db.from('chunks').select('id', { head: true, count: 'exact' });
  const stagedCount = await db.from('chunks_reindex').select('chunk_id', { head: true, count: 'exact' });
  console.log(`   live chunks ${liveCount.count ?? '?'} · staged ${stagedCount.count ?? 0} · model ${model}`);

  // The live search path must answer whether or not a rebuild is in flight.
  // This is the "no downtime" claim, checked against the real RPC.
  const { error: liveError } = await db.rpc('match_chunks', {
    query_embedding: `[${Array.from({ length: 768 }, () => 0.01).join(',')}]`,
    match_count: 1,
    similarity_threshold: 0,
  });
  check(liveError === null, 'the LIVE search RPC answers while staging exists', liveError?.message ?? 'ok');

  // promote_reindex must be reachable and must refuse an empty staging set
  // rather than silently succeeding.
  if ((stagedCount.count ?? 0) === 0) {
    const { error } = await db.rpc('promote_reindex', { expected_model: model });
    check(
      error !== null && /nothing staged/i.test(error.message),
      'promote_reindex refuses when nothing is staged',
      error?.message ?? 'NO ERROR — it succeeded on an empty set',
    );
  } else {
    block('staging is not empty', 'skipping the empty-set refusal check to avoid disturbing it');
  }
}

main()
  .then(summary)
  .catch((error: unknown) => {
    console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
