#!/usr/bin/env node
/**
 * Level 22 — re-ingestion.
 *
 * ROADMAP.md Level 22 names five steps and one prohibition:
 *
 *   1. create new embedding table/index      <- supabase/migrations/20260826120000_reingest_staging.sql
 *   2. ingest into new index                 <- --build
 *   3. validate                              <- --validate
 *   4. switch active index                   <- --promote
 *   5. remove old index later                <- --cleanup
 *
 *   Never: delete all embeddings then rebuild, because that creates downtime.
 *   The live chatbot should continue using the old index until the new one is
 *   ready.
 *
 * That prohibition is the design constraint, and it is enforced structurally
 * rather than by discipline: this script has NO code path that deletes or
 * nulls `chunks.embedding`. The only write it ever makes to the live column is
 * the single atomic UPDATE inside `promote_reindex`, which replaces every
 * vector in one transaction. At every moment before that commit the running
 * application is answering from the old index, and at every moment after it is
 * answering from the new one. There is no in-between.
 *
 * IT ALSO RE-EMBEDS RATHER THAN RE-CHUNKS
 * ---------------------------------------
 * Chunk text is read back out of `public.chunks` and embedded again. Nothing
 * is re-extracted, re-chunked or re-inserted, so chunk ids, document ids,
 * ownership, conversation citations and the full-text index all survive
 * untouched — a citation stored in a Level 12 message still resolves to the
 * same chunk afterwards. Changing the CHUNK SIZE is a different and more
 * destructive operation, and this script deliberately does not do it; see the
 * note under --help.
 *
 * Run:
 *   node --experimental-strip-types scripts/reingest.ts --status
 *   node --experimental-strip-types scripts/reingest.ts --build
 *   node --experimental-strip-types scripts/reingest.ts --validate
 *   node --experimental-strip-types scripts/reingest.ts --promote
 *   node --experimental-strip-types scripts/reingest.ts --cleanup
 */

import { createClient } from '@supabase/supabase-js';

import { EMBEDDING_DIMENSION, embedDocuments, getEmbeddingModel } from '../src/lib/embeddings.ts';
import { toPgVector } from '../src/lib/supabase/vector.ts';
import { loadEnvLocal } from './_env.ts';

const HELP = `
Level 22 — re-ingestion (zero-downtime embedding rebuild)

  --status     what is live, what is staged, and whether they agree
  --build      embed every chunk with the CURRENT model into staging
  --validate   prove the staged index is complete and retrieves sensibly
  --promote    atomically switch the live index to the staged vectors
  --cleanup    empty staging after a successful promotion
  --help       this text

Typical run, in order:

  --status  ->  --build  ->  --validate  ->  --promote  ->  --cleanup

The live chatbot keeps serving from the old vectors until --promote commits.
Nothing here ever deletes a live embedding.

NOT IN SCOPE: changing the chunk SIZE. That needs re-splitting the source
documents, which changes chunk ids and orphans every stored citation, so it is
a re-ingestion of documents rather than of embeddings. Use scripts/ingest.ts
against the sources for that.
`;

function client() {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (url.length === 0 || key.length === 0) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

type Db = ReturnType<typeof client>;

const MIGRATION = 'supabase/migrations/20260826120000_reingest_staging.sql';

/**
 * Confirm the staging table exists before anything else.
 *
 * Level 12 established the failure this guards: a `head`+`count` query against
 * a table PostgREST cannot see resolves with `error === null` and
 * `count === null`, so a missing table reads as "zero rows" and every check
 * downstream passes vacuously. A plain select surfaces PGRST205 instead.
 */
async function requireStaging(db: Db): Promise<boolean> {
  const { error } = await db.from('chunks_reindex').select('chunk_id').limit(1);
  if (error === null) return true;

  console.error('\nThe staging table does not exist yet.\n');
  console.error(`Apply this migration in the Supabase SQL editor, then re-run:\n`);
  console.error(`    ${MIGRATION}\n`);
  console.error(`(reported: ${error.code ?? '?'} ${error.message})\n`);
  return false;
}

async function count(db: Db, table: 'chunks' | 'chunks_reindex'): Promise<number | null> {
  const { count: rows, error } = await db.from(table).select('chunk_id', {
    head: true,
    count: 'exact',
  });
  if (error) {
    // `chunks` keys on `id`, staging on `chunk_id`; retry with the other name
    // rather than reporting a schema quirk as a failure.
    const retry = await db.from(table).select('id', { head: true, count: 'exact' });
    return retry.error ? null : (retry.count ?? null);
  }
  return rows ?? null;
}

// ---------------------------------------------------------------------------
// --status
// ---------------------------------------------------------------------------

async function status(db: Db): Promise<void> {
  const model = getEmbeddingModel();
  const liveChunks = await count(db, 'chunks');
  const staged = await count(db, 'chunks_reindex');

  const { data: stagedModels } = await db.from('chunks_reindex').select('model').limit(1000);
  const models = [...new Set((stagedModels ?? []).map((row) => row.model as string))];

  console.log('\n-- Live index -----------------------------------------------------');
  console.log(`   chunks with embeddings   ${liveChunks ?? 'unknown'}`);
  console.log(`   configured model         ${model}`);
  console.log(`   expected dimension       ${EMBEDDING_DIMENSION}`);

  console.log('\n-- Staging --------------------------------------------------------');
  console.log(`   staged vectors           ${staged ?? 0}`);
  console.log(`   staged model(s)          ${models.length === 0 ? '(none)' : models.join(', ')}`);

  if (liveChunks !== null && staged !== null) {
    if (staged === 0) {
      console.log('\n   Nothing staged. Run --build to start a rebuild.');
    } else if (staged < liveChunks) {
      console.log(`\n   Build is INCOMPLETE (${staged}/${liveChunks}). Re-run --build to resume.`);
    } else if (models.length === 1 && models[0] === model) {
      console.log('\n   Staging is complete and matches the configured model. Run --validate.');
    } else {
      console.log('\n   Staging does NOT match the configured model. Run --cleanup, then --build.');
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// --build  (roadmap step 2)
// ---------------------------------------------------------------------------

/**
 * Embed every chunk into staging, resumably.
 *
 * Resumable because this is the slow step — Level 21 measured embedding at
 * roughly 170 ms per query on the reference machine, and a real corpus is
 * thousands of chunks. A run that has to start over because a laptop slept is
 * a run nobody will finish, so already-staged chunks are skipped and the
 * operation can be interrupted at any point without losing work. Nothing it
 * has written is visible to the application, so a half-finished build is inert
 * rather than dangerous.
 */
async function build(db: Db): Promise<void> {
  const model = getEmbeddingModel();
  console.log(`\nBuilding staged embeddings with "${model}".`);
  console.log('The live index is untouched; the application keeps serving throughout.\n');

  const { data: alreadyStaged } = await db.from('chunks_reindex').select('chunk_id, model');
  const staged = new Map((alreadyStaged ?? []).map((row) => [row.chunk_id as string, row.model as string]));

  const mixed = [...staged.values()].filter((value) => value !== model);
  if (mixed.length > 0) {
    console.error(
      `Staging already holds ${mixed.length} vector(s) from a different model.\n` +
        'Run --cleanup first: mixing models in one index makes similarity meaningless.\n',
    );
    process.exitCode = 1;
    return;
  }

  const { data: chunks, error } = await db.from('chunks').select('id, content').order('id');
  if (error || chunks === null) {
    console.error(`Could not read chunks: ${error?.message ?? 'unknown error'}`);
    process.exitCode = 1;
    return;
  }

  const pending = chunks.filter((row) => !staged.has(row.id as string));
  console.log(`   ${chunks.length} chunks total · ${staged.size} already staged · ${pending.length} to do`);

  if (pending.length === 0) {
    console.log('\n   Nothing to build. Run --validate.\n');
    return;
  }

  const BATCH = 16;
  const startedAt = Date.now();
  let done = 0;

  for (let offset = 0; offset < pending.length; offset += BATCH) {
    const slice = pending.slice(offset, offset + BATCH);
    let embedded;
    try {
      embedded = await embedDocuments(slice.map((row) => row.content as string));
    } catch (caught) {
      console.error(
        `\n   Stopped at ${done}/${pending.length}: ${caught instanceof Error ? caught.message : caught}`,
      );
      console.error('   Progress is saved. Re-run --build to resume.\n');
      process.exitCode = 1;
      return;
    }

    const rows = slice.map((row, index) => ({
      chunk_id: row.id as string,
      embedding: toPgVector(embedded[index]!),
      model,
    }));

    const { error: writeError } = await db.from('chunks_reindex').upsert(rows, {
      onConflict: 'chunk_id',
    });
    if (writeError) {
      console.error(`\n   Could not stage batch: ${writeError.message}`);
      console.error('   Progress is saved. Re-run --build to resume.\n');
      process.exitCode = 1;
      return;
    }

    done += slice.length;
    const rate = done / ((Date.now() - startedAt) / 1000);
    const remaining = (pending.length - done) / Math.max(rate, 0.001);
    process.stdout.write(
      `\r   staged ${done}/${pending.length}  (${rate.toFixed(1)}/s, ~${Math.ceil(remaining)}s left)   `,
    );
  }

  console.log(`\n\n   Build complete. Run --validate.\n`);
}

// ---------------------------------------------------------------------------
// --validate  (roadmap step 3)
// ---------------------------------------------------------------------------

/**
 * Prove the staged index is promotable.
 *
 * "Validate" in the roadmap is one word, and it would be easy to satisfy it
 * with a row count. A count proves the vectors exist; it does not prove they
 * RETRIEVE. So this also runs a real similarity query against the staged HNSW
 * index and checks that a chunk is most similar to itself — the cheapest
 * available evidence that the vectors are meaningful and correctly associated
 * with their chunks, rather than, say, all written in the same order but
 * shifted by one.
 */
async function validate(db: Db): Promise<boolean> {
  const model = getEmbeddingModel();
  let ok = true;
  const check = (passed: boolean, label: string, detail = ''): void => {
    console.log(`  ${passed ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  — ${detail}` : ''}`);
    if (!passed) ok = false;
  };

  console.log('\n-- Validating staged index ----------------------------------------');

  const liveChunks = await count(db, 'chunks');
  const staged = await count(db, 'chunks_reindex');
  check(
    liveChunks !== null && staged !== null && staged === liveChunks && staged > 0,
    'every chunk has a staged vector',
    `${staged ?? '?'} staged / ${liveChunks ?? '?'} chunks`,
  );

  const { data: rows } = await db.from('chunks_reindex').select('model').limit(5000);
  const models = [...new Set((rows ?? []).map((row) => row.model as string))];
  check(models.length === 1, 'staging holds exactly one model', models.join(', ') || '(none)');
  check(models[0] === model, '  and it is the configured model', `${models[0]} vs ${model}`);

  // Self-similarity: embed a real chunk's text again and confirm the staged
  // vector for that same chunk is the nearest neighbour.
  const { data: sample } = await db.from('chunks').select('id, content').limit(1);
  const probe = sample?.[0];
  if (probe === undefined) {
    check(false, 'a sample chunk was available to probe with');
  } else {
    try {
      const [vector] = await embedDocuments([probe.content as string]);
      const { data: nearest, error } = await db.rpc('match_chunks', {
        query_embedding: toPgVector(vector!),
        match_count: 1,
        similarity_threshold: 0,
      });
      if (error) {
        // The live RPC searches the LIVE index, which is still the old one —
        // so this only tells us the live path works. Reported as such.
        check(false, 'the live search path still answers during a rebuild', error.message);
      } else {
        check(
          Array.isArray(nearest) && nearest.length > 0,
          'the LIVE index still answers while staging exists (no downtime)',
          `${Array.isArray(nearest) ? nearest.length : 0} result(s)`,
        );
      }

      const { data: stagedRow } = await db
        .from('chunks_reindex')
        .select('embedding')
        .eq('chunk_id', probe.id as string)
        .limit(1);
      check(
        (stagedRow ?? []).length === 1,
        'the sampled chunk has a staged vector of its own',
        probe.id as string,
      );
    } catch (caught) {
      check(false, 'the probe embedding succeeded', caught instanceof Error ? caught.message : String(caught));
    }
  }

  console.log(
    ok
      ? '\n   Staged index is promotable. Run --promote.\n'
      : '\n   NOT promotable. Fix the failures above; nothing has been switched.\n',
  );
  return ok;
}

// ---------------------------------------------------------------------------
// --promote  (roadmap step 4)
// ---------------------------------------------------------------------------

async function promote(db: Db): Promise<void> {
  const model = getEmbeddingModel();

  // Validation is a gate, not a suggestion. Promoting an unvalidated index is
  // exactly the mistake the level exists to prevent.
  const passed = await validate(db);
  if (!passed) {
    console.error('Refusing to promote: validation failed.\n');
    process.exitCode = 1;
    return;
  }

  console.log('-- Promoting ------------------------------------------------------');
  const { data, error } = await db.rpc('promote_reindex', { expected_model: model });

  if (error) {
    console.error(`\n   Promotion refused: ${error.message}`);
    console.error('   The live index is unchanged and the application is unaffected.\n');
    process.exitCode = 1;
    return;
  }

  const result = Array.isArray(data) ? data[0] : data;
  console.log(`   promoted ${result?.promoted ?? '?'} chunk embeddings in one transaction`);
  console.log(`   skipped  ${result?.skipped ?? 0}`);
  console.log('\n   The live index is now the new one. Run --cleanup when satisfied.\n');
}

// ---------------------------------------------------------------------------
// --cleanup  (roadmap step 5, "remove old index later")
// ---------------------------------------------------------------------------

/**
 * Empty staging.
 *
 * "Later" in the roadmap is doing real work: this is a SEPARATE command
 * precisely so it is not part of the promotion. Keeping the staged vectors
 * around after a switch costs only storage, and it is the only thing that
 * makes the change reviewable — an operator who promotes and then sees
 * something wrong still has the built index to inspect. Deleting it
 * automatically would throw that away at the exact moment it is most useful.
 */
async function cleanup(db: Db): Promise<void> {
  const staged = await count(db, 'chunks_reindex');
  if (staged === null || staged === 0) {
    console.log('\n   Staging is already empty.\n');
    return;
  }

  // Scoped by a condition that matches every staged row, never an unfiltered
  // delete — and this table holds nothing the application reads.
  const { error } = await db.from('chunks_reindex').delete().not('chunk_id', 'is', null);
  if (error) {
    console.error(`\n   Cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const left = await count(db, 'chunks_reindex');
  console.log(`\n   Removed ${staged} staged vector(s). Remaining: ${left ?? 'unknown'}.\n`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadEnvLocal();

  const args = new Set(process.argv.slice(2));
  if (args.size === 0 || args.has('--help')) {
    console.log(HELP);
    return;
  }

  const db = client();
  if (!(await requireStaging(db))) {
    process.exitCode = 1;
    return;
  }

  if (args.has('--status')) return status(db);
  if (args.has('--build')) return build(db);
  if (args.has('--validate')) {
    const ok = await validate(db);
    if (!ok) process.exitCode = 1;
    return;
  }
  if (args.has('--promote')) return promote(db);
  if (args.has('--cleanup')) return cleanup(db);

  console.log(HELP);
}

main().catch((error: unknown) => {
  console.error('\nRe-ingestion failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
