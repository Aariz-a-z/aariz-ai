#!/usr/bin/env node
/**
 * Level 6 — document ingestion CLI.
 *
 *   npm run ingest -- <file-or-directory> [--force]
 *
 * Examples:
 *   npm run ingest -- ./docs
 *   npm run ingest -- ./docs/guide.md --force
 *
 * Logs, per ROADMAP.md: filename, chunks, token estimate, processing time,
 * status, errors.
 */

import { ingestPath, type IngestResult } from '../src/lib/ingest/pipeline.ts';
import { isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { loadEnvLocal } from './_env.ts';

function usage(): void {
  console.log(`
Usage:
  npm run ingest -- <file-or-directory> [--force]

Supported: .md .markdown .mdx .txt .text .pdf .html .htm

Options:
  --force    Re-ingest even if identical content is already stored.
`);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function printResult(result: IngestResult): void {
  const marker =
    result.outcome === 'ingested' ? 'OK     ' : result.outcome === 'skipped' ? 'SKIP   ' : 'FAILED ';

  console.log(`\n${marker} ${result.file}`);
  console.log(`         title      : ${result.title || '(none)'}`);
  console.log(`         type       : ${result.sourceType ?? '(unknown)'}`);
  console.log(`         chunks     : ${result.chunkCount}`);
  console.log(`         tokens     : ${result.tokenTotal}`);
  console.log(`         time       : ${formatDuration(result.durationMs)}`);
  console.log(`         status     : ${result.outcome}`);
  if (result.detail) console.log(`         detail     : ${result.detail}`);
}

async function main(): Promise<void> {
  loadEnvLocal();

  const args = process.argv.slice(2);

  // npm consumes `--force` as one of its own flags, so `npm run ingest -- x
  // --force` never reaches argv. npm does export it as npm_config_force, so
  // honour that too — otherwise the documented invocation silently no-ops.
  const force = args.includes('--force') || process.env.npm_config_force === 'true';

  const target = args.find((arg) => !arg.startsWith('--'));

  if (!target || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exitCode = target ? 0 : 1;
    return;
  }

  if (!isSupabaseConfigured()) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local.');
    process.exitCode = 1;
    return;
  }

  console.log(`Ingesting: ${target}${force ? '  (--force)' : ''}`);

  let results: IngestResult[];
  try {
    results = await ingestPath(target, { force });
  } catch (caught) {
    console.error(`\nIngestion failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    process.exitCode = 1;
    return;
  }

  for (const result of results) printResult(result);

  const ingested = results.filter((r) => r.outcome === 'ingested');
  const skipped = results.filter((r) => r.outcome === 'skipped');
  const failed = results.filter((r) => r.outcome === 'failed');

  console.log(`\n${'='.repeat(64)}`);
  console.log(
    `  ${ingested.length} ingested · ${skipped.length} skipped · ${failed.length} failed`,
  );
  console.log(
    `  ${ingested.reduce((sum, r) => sum + r.chunkCount, 0)} chunks · ` +
      `${ingested.reduce((sum, r) => sum + r.tokenTotal, 0)} tokens · ` +
      `${formatDuration(results.reduce((sum, r) => sum + r.durationMs, 0))} total`,
  );
  console.log('='.repeat(64));

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('\nIngestion crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
