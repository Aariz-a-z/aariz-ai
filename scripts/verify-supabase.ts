#!/usr/bin/env node
/**
 * Level 4 — live database verification.
 *
 * Checks the applied migration against the real Supabase project. Read-only:
 * it inserts nothing, creates nothing, and drops nothing.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-supabase.ts
 *
 * Reads .env.local directly, because a standalone Node script does not get
 * Next.js's environment loading. Values are never printed.
 *
 * SCOPE LIMIT, stated up front: the service-role key reaches PostgREST, not
 * the Postgres catalog. That is enough to prove connectivity, table existence,
 * column names, primary keys and foreign keys. It cannot see index
 * definitions, RLS status, or policies — `information_schema` and `pg_catalog`
 * are not exposed over the REST API. Those checks need the SQL block printed
 * at the end, run in the Supabase SQL Editor.
 */

import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { loadEnvLocal } from './_env.ts';

const EXPECTED_EMBEDDING_DIMENSION = 768;

const EXPECTED_COLUMNS = {
  documents: [
    'id',
    'title',
    'source_url',
    'source_type',
    'status',
    'content_hash',
    'created_at',
    'updated_at',
  ],
  chunks: ['id', 'document_id', 'chunk_index', 'content', 'token_count', 'embedding', 'created_at'],
} as const;

let passed = 0;
let failed = 0;
let unknown = 0;

function report(ok: boolean | null, label: string, detail = ''): void {
  const mark = ok === null ? '[NEEDS SQL]' : ok ? '[PASS]' : '[FAIL]';
  if (ok === null) unknown++;
  else if (ok) passed++;
  else failed++;
  console.log(`  ${mark.padEnd(12)} ${label}${detail ? `  — ${detail}` : ''}`);
}

/**
 * PostgREST publishes an OpenAPI description of every exposed table, including
 * per-column type info and `<pk/>` / `<fk .../>` markers in the descriptions.
 */
interface OpenApiSpec {
  definitions?: Record<
    string,
    {
      properties?: Record<string, { type?: string; format?: string; description?: string }>;
    }
  >;
}

async function fetchOpenApi(url: string, key: string): Promise<OpenApiSpec | null> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as OpenApiSpec;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();

  console.log('='.repeat(72));
  console.log('  LEVEL 4 — LIVE SUPABASE VERIFICATION');
  console.log('='.repeat(72));

  if (!isSupabaseConfigured()) {
    console.log('\n  SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set in .env.local.');
    console.log('  Fill both in, then re-run. Nothing was contacted.\n');
    process.exitCode = 1;
    return;
  }

  const url = process.env.SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();

  console.log('\n-- Connection ---------------------------------------------------');

  let client;
  try {
    client = getSupabaseAdminClient();
    report(true, '13. getSupabaseAdminClient() constructed');
  } catch (error) {
    report(false, '13. getSupabaseAdminClient()', error instanceof Error ? error.message : 'failed');
    process.exitCode = 1;
    return;
  }

  const spec = await fetchOpenApi(url, key);
  report(spec !== null, '1. Supabase REST API reachable', spec === null ? 'no response' : 'OpenAPI served');

  console.log('\n-- Tables -------------------------------------------------------');

  for (const table of ['documents', 'chunks'] as const) {
    const { error, count } = await client
      .from(table)
      .select('*', { count: 'exact', head: true });

    if (error) {
      report(false, `${table === 'documents' ? '3' : '4'}. public.${table} readable`, error.message);
    } else {
      report(
        true,
        `${table === 'documents' ? '3' : '4'}. public.${table} readable`,
        `row count ${count ?? 0}`,
      );
    }
  }

  console.log('\n-- Columns ------------------------------------------------------');

  if (spec?.definitions) {
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const properties = spec.definitions[table]?.properties;
      if (!properties) {
        report(false, `6. ${table} columns`, 'table not present in API schema');
        continue;
      }
      const actual = Object.keys(properties);
      const missing = expected.filter((c) => !actual.includes(c));
      report(
        missing.length === 0,
        `6. ${table} columns (${expected.length} expected)`,
        missing.length === 0 ? actual.join(', ') : `MISSING: ${missing.join(', ')}`,
      );
    }

    console.log('\n-- Keys ---------------------------------------------------------');

    for (const table of ['documents', 'chunks'] as const) {
      const properties = spec.definitions[table]?.properties ?? {};
      const pk = Object.entries(properties)
        .filter(([, meta]) => meta.description?.includes('<pk/>'))
        .map(([name]) => name);
      report(pk.includes('id'), `7. ${table} primary key`, pk.length ? pk.join(', ') : 'none reported');
    }

    const chunkProps = spec.definitions.chunks?.properties ?? {};
    const fkDescription = chunkProps.document_id?.description ?? '';
    const fkMatch = /<fk table='([^']+)' column='([^']+)'\/>/.exec(fkDescription);
    report(
      fkMatch?.[1] === 'documents' && fkMatch[2] === 'id',
      '8. chunks.document_id -> documents.id',
      fkMatch ? `${fkMatch[1]}.${fkMatch[2]}` : 'not reported by API',
    );

    console.log('\n-- Embedding column ---------------------------------------------');
    const embeddingMeta = chunkProps.embedding;
    const format = embeddingMeta?.format ?? '';

    // PostgREST *does* report the parameterised type in `format`
    // (e.g. "public.vector(768)"), which settles check 5 without SQL.
    report(
      format.includes(`vector(${EXPECTED_EMBEDDING_DIMENSION})`),
      `5. chunks.embedding is exactly vector(${EXPECTED_EMBEDDING_DIMENSION})`,
      `API format: ${format || 'not reported'}`,
    );

    // Worth surfacing: the wire type is a string, not a JSON array. Vectors
    // must be sent as '[0.1,0.2,...]' and parsed back on read.
    console.log(`  wire type over PostgREST: ${embeddingMeta?.type ?? 'unknown'} (send/receive as a bracketed string)`);
  } else {
    report(false, '6. column introspection', 'OpenAPI schema unavailable');
  }

  console.log('\n-- Not checkable over the REST API ------------------------------');
  report(null, '2.  pgvector extension present');
  report(null, '9.  unique constraints');
  report(null, '10. indexes, including the HNSW vector index');
  report(null, '11. RLS enabled on both tables');
  report(null, '12. no unintended policies');

  console.log('\n' + '='.repeat(72));
  console.log(`  ${passed} passed · ${failed} failed · ${unknown} need the SQL block below`);
  console.log('='.repeat(72));
  console.log(SQL_VERIFICATION_BLOCK);

  if (failed > 0) process.exitCode = 1;
}

const SQL_VERIFICATION_BLOCK = `
Run this in the Supabase dashboard -> SQL Editor, and paste the output back.
It is read-only.

-- 2. pgvector extension
select extname, extversion from pg_extension where extname = 'vector';

-- 5. exact column types (embedding must read: vector(768))
select table_name, column_name, format_type(a.atttypid, a.atttypmod) as exact_type, is_nullable
from information_schema.columns c
join pg_attribute a
  on a.attrelid = (quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass
 and a.attname  = c.column_name
where c.table_schema = 'public' and c.table_name in ('documents','chunks')
order by c.table_name, c.ordinal_position;

-- 7/8/9. constraints: primary keys, foreign keys, unique, checks
select conrelid::regclass as table_name, conname, contype,
       pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace
  and conrelid::regclass::text in ('documents','chunks')
order by conrelid::regclass::text, contype, conname;

-- 10. indexes (chunks_embedding_hnsw_idx must use hnsw)
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename in ('documents','chunks')
order by tablename, indexname;

-- 11. RLS enabled
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relnamespace = 'public'::regnamespace and relname in ('documents','chunks');

-- 12. policies (expected: zero rows)
select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public' and tablename in ('documents','chunks');
`;

main().catch((error: unknown) => {
  console.error('\nVerification failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
