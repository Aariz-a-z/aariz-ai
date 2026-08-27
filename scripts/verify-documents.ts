#!/usr/bin/env node
/**
 * Per-user documents — upload, ownership and user-scoped retrieval.
 *
 * Real Supabase, real Supabase Auth users, real Ollama embeddings, the real
 * upload endpoint, and real RLS.
 *
 * As at Level 13, every isolation claim is tested TWICE: once through the API,
 * which proves the routes are careful, and once through raw clients built from
 * each user's own JWT, which proves the DATABASE is. The service-role key is
 * never used for an isolation assertion — it bypasses RLS and would make the
 * policies look correct whatever they said.
 *
 * The fixtures are genuine files built in memory: a TXT, a DOCX (a real ZIP
 * container with the minimum OOXML parts) and a PDF (with a correct xref
 * table). Uploading bytes that only pretend to be those formats would test the
 * validator and nothing else.
 *
 * Run:
 *   node --experimental-strip-types scripts/verify-documents.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signIn } from '../src/lib/auth.ts';
import { createAuthedClient, isAuthConfigured } from '../src/lib/supabase/authed.ts';
import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { SUPPORTED_EXTENSIONS } from '../src/lib/ingest/extract.ts';
import { EXTENSION_TO_SOURCE_TYPE } from '../src/lib/ingest/formats.ts';
import { ACCEPTED_EXTENSIONS } from '../src/lib/documents-client.ts';
import { UPLOAD_EXTENSIONS, getMaxUploadBytes } from '../src/lib/documents.ts';
import { DOCUMENT_SOURCE_TYPES } from '../src/types/database.ts';
import { buildDocx, buildPdf, buildXlsx, corrupt } from './fixtures/documents.ts';
import { isInferenceDisabled } from '../src/lib/inference-mode.ts';
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

const BASE_URL = (process.env.EVAL_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// File fixtures
// ---------------------------------------------------------------------------
//
// These used to be built here — a ZIP writer, a DOCX writer and a PDF writer,
// all local to this file. They moved to `scripts/fixtures/documents.ts` when
// multi-format support arrived, because a second suite needed the same builders
// and a copied byte-level format writer is a copy that drifts silently: a fix
// to one CRC calculation would leave the other quietly producing files no
// parser accepts. The builders are unchanged in substance, and now cover
// XLSX and the deliberately corrupt variants as well.

// ---------------------------------------------------------------------------

class Client {
  private cookies = new Map<string, string>();

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const sep = pair?.indexOf('=') ?? -1;
      if (!pair || sep === -1) continue;
      const name = pair.slice(0, sep).trim();
      const value = pair.slice(sep + 1).trim();
      if (value.length === 0) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const response = await this.request(path, init);
    let body: T;
    try {
      body = (await response.json()) as T;
    } catch {
      body = {} as T;
    }
    return { status: response.status, body };
  }

  async upload(
    filename: string,
    content: Buffer,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; body: { document?: { id: string; chunkCount: number }; error?: string } }> {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(content)], filename));
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return this.json('/api/documents', { method: 'POST', body: form });
  }

  /**
   * Ask, retrying only when the PROVIDER rate-limits us.
   *
   * This suite now asks far more questions than it used to — thirteen formats,
   * each with its own retrieval check — and fires them back to back, which is
   * enough to trip Gemini's free-tier per-minute limit. The result was a page
   * of failures reading `answer: ""` that said nothing about this application:
   * the upload, the chunks and the embeddings were all verified fine, and only
   * the generation call was refused.
   *
   * Retrying a 429 is not a weakened assertion. Nothing about what is checked
   * changes; the suite simply stops reporting Google's throughput policy as a
   * defect in the code under test. Every other status still fails immediately,
   * and an answer that comes back wrong still fails.
   */
  async ask(prompt: string, extra: Record<string, unknown> = {}): Promise<{ answer: string; sources: { documentId: string }[] }> {
    let response: Response | null = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      response = await this.request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], ...extra }),
      });
      // 429 is our own budget or the provider's; 502 is how a provider 429
      // surfaces once mapped. Both are throughput, not correctness.
      if (response.status !== 429 && response.status !== 502) break;
      await response.arrayBuffer().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 4_000 * (attempt + 1)));
    }

    if (response === null || !response.ok || !response.body) return { answer: '', sources: [] };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let sources: { documentId: string }[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const e = JSON.parse(line) as { type: string; text?: string; sources?: { documentId: string }[] };
        if (e.type === 'delta' && e.text) answer += e.text;
        else if (e.type === 'sources' && Array.isArray(e.sources)) sources = e.sources;
      }
    }
    return { answer, sources };
  }
}

/**
 * The UI half of document upload.
 *
 * Everything else in this suite proves the API and the isolation model. None
 * of it proves a user can actually REACH any of it — and for a long time they
 * could not: the upload control existed only inside the collapsible sidebar,
 * and the file picker offered three of the six formats the backend accepts, so
 * a Markdown file could not even be selected. Both faults are invisible to an
 * API-level test, which is exactly why these checks exist.
 */
function verifyUploadUi(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');
  const strip = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

  console.log('\n-- The upload control is reachable from the chat UI ----------------');

  const composer = strip(read('src', 'components', 'chat-composer.tsx'));
  const chat = strip(read('src', 'components', 'chat.tsx'));
  const client = read('src', 'lib', 'documents-client.ts');

  check(/onAttach/.test(composer), 'the composer accepts an attach handler');
  check(/type="file"/.test(composer), '  and renders a real file input');
  check(/Attach a document/.test(composer), '  with an accessible label');
  check(/isUploading/.test(composer), '  and shows a busy state while indexing');
  check(/attachDisabledReason/.test(composer), '  and explains WHY when it cannot be used');

  check(/onAttach=\{handleAttach\}/.test(chat), 'the chat wires the handler in');
  check(/uploadDocument/.test(chat), '  reusing the existing upload client');
  check(
    !/fetch\(['"`]\/api\/documents/.test(chat),
    '  rather than a second upload path of its own',
  );
  /**
   * The upload's outcome must be reported in all three of its states, and it
   * must not be reported through the CHAT's error state — which is what used to
   * happen: a rejected file called `setStatus('error')` and the user was shown
   * "Could not generate a reply" about a document they had just attached.
   */
  check(/kind: 'working'/.test(chat), '  and shows progress while extracting and indexing');
  check(/kind: 'done'/.test(chat), '  and confirms when a document is indexed');
  check(/kind: 'error'/.test(chat), '  and reports an extraction failure');
  check(
    !/setStatus\('error'\)/.test(chat.slice(chat.indexOf('handleAttach'), chat.indexOf('attachDisabledReason'))),
    '  without putting the CHAT into an error state over a file',
  );
  check(/DocumentPanel/.test(chat), 'the document library is still rendered');
  check(
    /Sign in to upload documents/.test(chat),
    'a signed-out user is told to sign in rather than shown a dead control',
  );

  console.log('\n-- The picker offers exactly what the backend accepts ---------------');

  /**
   * Compared as VALUES, not as source text.
   *
   * This used to scrape `ACCEPTED_EXTENSIONS = [...]` out of the client file
   * with a regex, and that was testing the wrong pair. It compared the picker
   * against the EXTRACTOR's list while the gate that actually rejects uploads
   * is `UPLOAD_EXTENSIONS` in `documents.ts` — which at the time held three
   * entries against the picker's nine. The suite passed while the picker
   * offered six formats the upload route refused with a 415.
   *
   * All three lists are imported and compared directly now. They resolve to the
   * same array today; asserting it keeps them that way if anyone re-introduces
   * a copy, and the regex can no longer pass by matching a list nobody enforces.
   */
  const accepted = [...ACCEPTED_EXTENSIONS];

  check(accepted.length > 0, 'the client declares an accept list', accepted.join(' '));
  for (const extension of SUPPORTED_EXTENSIONS) {
    check(accepted.includes(extension), `  the picker offers ${extension}, which the extractor supports`);
  }
  for (const offered of accepted) {
    check(
      SUPPORTED_EXTENSIONS.includes(offered),
      `  it offers nothing the extractor would reject (${offered})`,
    );
  }

  // The list that actually returns 415 — the one the old test never looked at.
  for (const offered of accepted) {
    check(
      (UPLOAD_EXTENSIONS as readonly string[]).includes(offered),
      `  the UPLOAD ROUTE accepts ${offered}, so the picker is not advertising a 415`,
    );
  }
  for (const gated of UPLOAD_EXTENSIONS) {
    check(
      accepted.includes(gated),
      `  the picker offers ${gated}, so no accepted format is unreachable`,
    );
  }

  // Every offered extension must map to a source type the DATABASE will store.
  // Without this, a format can extract perfectly and still fail at the insert.
  const storable = new Set(DOCUMENT_SOURCE_TYPES);
  for (const offered of accepted) {
    const sourceType = EXTENSION_TO_SOURCE_TYPE[offered];
    check(
      sourceType !== undefined && storable.has(sourceType),
      `  ${offered} maps to a storable source type (${sourceType ?? 'none'})`,
    );
  }

  const panel = strip(read('src', 'components', 'document-panel.tsx'));
  check(
    /accept=\{ACCEPT_ATTRIBUTE\}/.test(panel),
    'the sidebar panel uses the same shared list, so the two cannot drift',
  );

  console.log('\n-- Upload is enabled in Gemini production mode ----------------------');

  const saved = process.env.LLM_PROVIDER;
  try {
    process.env.LLM_PROVIDER = 'gemini';
    check(!isInferenceDisabled(), 'LLM_PROVIDER=gemini does NOT disable the documents route');
    process.env.LLM_PROVIDER = 'ollama';
    check(!isInferenceDisabled(), 'LLM_PROVIDER=ollama does not disable it either');
    process.env.LLM_PROVIDER = 'disabled';
    check(isInferenceDisabled(), 'only LLM_PROVIDER=disabled turns it off (the A3 demo)');
  } finally {
    if (saved === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = saved;
  }

  console.log('\n-- No secret reaches the upload UI ----------------------------------');
  for (const [label, needle] of [
    ['a service-role reference', 'SERVICE_ROLE'],
    ['a Gemini key reference', 'GEMINI_API_KEY'],
    ['an Ollama address', '11434'],
  ] as const) {
    check(
      !composer.includes(needle) && !chat.includes(needle) && !client.includes(needle),
      `the upload UI contains no ${label}`.replace('no a', 'no').replace('no an', 'no'),
    );
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== Per-user documents — upload, ownership, isolation ===\n');

  if (!isSupabaseConfigured()) {
    block('Supabase is not configured');
    summary();
    return;
  }
  if (!isAuthConfigured()) {
    block('SUPABASE_ANON_KEY is not set');
    summary();
    return;
  }

  const admin = getSupabaseAdminClient();

  // The migration must be applied. A real select, not head/count: a head
  // request against a missing column resolves without error on this instance.
  const columnProbe = await admin.from('documents').select('id, user_id, byte_size, page_count').limit(1);
  if (columnProbe.error) {
    block(
      'the document-ownership migration has not been applied',
      `${columnProbe.error.message} — run supabase/migrations/20260822120000_document_ownership.sql in a NEW SQL Editor query`,
    );
    summary();
    return;
  }

  // The owner-scoped RPC must exist too — the column alone is not enough.
  const rpcProbe = await admin.rpc('match_chunks', {
    query_embedding: `[${new Array(768).fill(0).join(',')}]`,
    match_count: 1,
    similarity_threshold: 2,
    owner_id: null,
  });
  if (rpcProbe.error) {
    block(
      'match_chunks does not accept owner_id',
      `${rpcProbe.error.message} — the migration was not fully applied`,
    );
    summary();
    return;
  }

  /**
   * Preconditions, checked against the provider actually configured.
   *
   * This used to ping Ollama unconditionally and block the entire suite when it
   * did not answer. That was correct when Ollama was the only provider and
   * became wrong the moment Gemini existed: a Gemini deployment has no Ollama
   * to reach, so a perfectly healthy stack reported `0 passed · 1 blocked`.
   *
   * The application's own health endpoint is the right question to ask, because
   * it reports on whichever provider is configured and is the same signal
   * production uses. Ollama is pinged only when Ollama is the one in use.
   */
  const preconditions: { label: string; url: string }[] = [
    { label: 'the application', url: `${BASE_URL}/` },
  ];
  if ((process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase() === 'ollama') {
    preconditions.push({
      label: 'Ollama',
      url: `${process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434'}/api/version`,
    });
  }

  for (const { label, url } of preconditions) {
    try {
      const ping = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!ping.ok) throw new Error(String(ping.status));
    } catch {
      block(`${label} is not reachable`, url);
      summary();
      return;
    }
  }

  /**
   * The server's inference must be up, whatever it is.
   *
   * Weaker than the old Ollama ping in the sense that it names no provider, and
   * stronger in the sense that it asks the SERVER whether it can actually
   * embed — which is what every upload below depends on. A stack that answers
   * this with `llm: unavailable` would otherwise produce a page of failures
   * that all say "embedding failed" and none of which are about documents.
   */
  try {
    const health = (await (await fetch(`${BASE_URL}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    })).json()) as { llm?: string; database?: string };
    if (health.llm !== 'available' || health.database !== 'available') {
      block(
        'the server reports a dependency down',
        `llm=${health.llm} database=${health.database}`,
      );
      summary();
      return;
    }
  } catch {
    block('the health endpoint did not answer', `${BASE_URL}/api/health`);
    summary();
    return;
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = `Test-${runId}-Aa1!`;
  const emailA = `doc-a-${runId}@example.test`;
  const emailB = `doc-b-${runId}@example.test`;
  const testUserIds: string[] = [];

  try {
    console.log('-- Accounts ------------------------------------------------------');
    for (const email of [emailA, emailB]) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
      testUserIds.push(data.user.id);
    }
    const [userAId, userBId] = testUserIds as [string, string];
    check(testUserIds.length === 2, 'two test accounts created');

    const alice = new Client();
    const bob = new Client();
    for (const [client, email] of [[alice, emailA], [bob, emailB]] as const) {
      const r = await client.json<{ authenticated?: boolean }>('/api/auth/signin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (r.status !== 200) throw new Error(`sign-in failed for ${email}`);
    }
    check(true, 'both users signed in');

    // --- 1. Upload, full pipeline -----------------------------------------
    console.log('\n-- Upload: extract -> chunk -> embed -> store ---------------------');
    const aliceText = Buffer.from(
      'Falconridge Deployment Notes\n\n' +
        'The Falconridge cluster reports error PX-7742 when its quorum disk becomes unreachable. ' +
        'The documented remedy is to fence the failed node and rebuild the quorum from the surviving replicas. ' +
        'The cluster tolerates a quorum loss of up to ninety seconds before it self-fences.\n',
      'utf8',
    );

    const upload = await alice.upload('falconridge.txt', aliceText);
    check(upload.status === 201, 'A can upload a TXT document', `HTTP ${upload.status} ${upload.body.error ?? ''}`);
    const docA = upload.body.document!.id;
    check(upload.body.document!.chunkCount > 0, 'the upload produced chunks', `${upload.body.document!.chunkCount}`);

    const stored = await admin.from('documents').select('user_id, status, byte_size, source_url').eq('id', docA).single();
    check(stored.data?.user_id === userAId, 'the document is owned by the uploading user', 'user_id = A');
    check(stored.data?.status === 'ready', 'status is ready', String(stored.data?.status));
    check(stored.data?.byte_size === aliceText.byteLength, 'byte size recorded', `${stored.data?.byte_size}`);
    check(stored.data?.source_url === 'falconridge.txt', 'original filename recorded', String(stored.data?.source_url));

    const embedded = await admin.from('chunks').select('id, embedding').eq('document_id', docA);
    check(
      (embedded.data ?? []).length > 0 && (embedded.data ?? []).every((c) => c.embedding !== null),
      'every stored chunk has an embedding',
      `${(embedded.data ?? []).length} chunks`,
    );

    // --- 2/3. Listing ------------------------------------------------------
    console.log('\n-- Listing -------------------------------------------------------');
    const listA = await alice.json<{ documents: { id: string }[] }>('/api/documents');
    check(listA.body.documents.some((d) => d.id === docA), 'A sees their own document');

    const listB = await bob.json<{ documents: { id: string }[] }>('/api/documents');
    check(!listB.body.documents.some((d) => d.id === docA), "B's list never contains A's document", `${listB.body.documents.length} doc(s)`);

    const anonList = await new Client().request('/api/documents');
    check(anonList.status === 401, 'an anonymous caller cannot list documents', `HTTP ${anonList.status}`);

    // --- 11/5/6. Direct-ID access through the API --------------------------
    console.log('\n-- Cross-user access through the API ------------------------------');
    const bDelete = await bob.request(`/api/documents/${docA}`, { method: 'DELETE' });
    check(bDelete.status === 404, "B cannot DELETE A's document by id", `HTTP ${bDelete.status}`);

    const stillThere = await admin.from('documents').select('id').eq('id', docA).maybeSingle();
    check(stillThere.data !== null, "A's document survived B's delete attempt");

    // --- 12. Spoofing -------------------------------------------------------
    console.log('\n-- Identity spoofing ---------------------------------------------');
    const spoof = await bob.upload('planted.txt', Buffer.from('planted content', 'utf8'), { user_id: userAId });
    check(spoof.status === 400, 'a user_id form field is rejected outright', `HTTP ${spoof.status}`);

    const spoofOwner = await bob.upload('planted2.txt', Buffer.from('planted content two', 'utf8'), { owner_id: userAId });
    check(spoofOwner.status === 400, 'an owner_id form field is rejected outright', `HTTP ${spoofOwner.status}`);

    // --- 4/7/8. DIRECT RLS --------------------------------------------------
    console.log('\n-- Direct RLS (no service-role, no application) -------------------');
    const sessA = await signIn(emailA, password);
    const sessB = await signIn(emailB, password);
    const rlsA = createAuthedClient(sessA.accessToken);
    const rlsB = createAuthedClient(sessB.accessToken);

    const aOwnDoc = await rlsA.from('documents').select('id').eq('id', docA);
    check(!aOwnDoc.error && (aOwnDoc.data ?? []).length === 1, "A's client CAN read A's document (positive control)", `${(aOwnDoc.data ?? []).length} row(s)`);

    const bCrossDoc = await rlsB.from('documents').select('id').eq('id', docA);
    check((bCrossDoc.data ?? []).length === 0, "RLS: B reads ZERO rows of A's document", `${(bCrossDoc.data ?? []).length} row(s)`);

    const bAllDocs = await rlsB.from('documents').select('id');
    check(!(bAllDocs.data ?? []).some((d) => d.id === docA), "RLS: an unfiltered select by B never returns A's document", `${(bAllDocs.data ?? []).length} visible`);

    const aOwnChunks = await rlsA.from('chunks').select('id').eq('document_id', docA);
    check((aOwnChunks.data ?? []).length > 0, "A's client CAN read A's chunks", `${(aOwnChunks.data ?? []).length} row(s)`);

    const bCrossChunks = await rlsB.from('chunks').select('id').eq('document_id', docA);
    check((bCrossChunks.data ?? []).length === 0, "RLS: B reads ZERO of A's chunks", `${(bCrossChunks.data ?? []).length} row(s)`);

    const bInsertChunk = await rlsB
      .from('chunks')
      .insert({ document_id: docA, chunk_index: 9999, content: 'injected by B', token_count: 3 })
      .select('id');
    check(bInsertChunk.error !== null, "RLS: B cannot INSERT a chunk into A's document", bInsertChunk.error?.code ?? 'NO ERROR — insert succeeded');

    const bUpdateDoc = await rlsB.from('documents').update({ title: 'stolen' }).eq('id', docA).select('id');
    check((bUpdateDoc.data ?? []).length === 0, "RLS: B's UPDATE of A's document affects no rows", `${(bUpdateDoc.data ?? []).length} row(s)`);

    const bDeleteDoc = await rlsB.from('documents').delete().eq('id', docA).select('id');
    check((bDeleteDoc.data ?? []).length === 0, "RLS: B's DELETE of A's document affects no rows", `${(bDeleteDoc.data ?? []).length} row(s)`);

    const bTakeover = await rlsB.from('documents').update({ user_id: userBId }).eq('id', docA).select('id');
    check((bTakeover.data ?? []).length === 0, 'RLS: B cannot reassign A’s document to themselves', `${(bTakeover.data ?? []).length} row(s)`);

    const bPlantDoc = await rlsB
      .from('documents')
      .insert({ title: 'planted', source_type: 'txt', content_hash: `planted-${runId}`, user_id: userAId })
      .select('id');
    check(bPlantDoc.error !== null, 'RLS: B cannot INSERT a document owned by A', bPlantDoc.error?.code ?? 'NO ERROR — insert succeeded');

    const intact = await admin.from('documents').select('title, user_id').eq('id', docA).single();
    check(intact.data?.title !== 'stolen' && intact.data?.user_id === userAId, 'after every attack the document is unchanged and still owned by A');

    // --- 9/10. Chat retrieval is owner-scoped -------------------------------
    console.log('\n-- Chat retrieval is scoped to the asker --------------------------');
    const question = 'What is error PX-7742 and how is it fixed?';

    const answerA = await alice.ask(question, { startConversation: true });
    check(answerA.sources.some((s) => s.documentId === docA), "A's answer cites A's own document", `${answerA.sources.length} source(s)`);
    check(/PX-7742|quorum|fence/i.test(answerA.answer), 'and the answer uses its content', JSON.stringify(answerA.answer.slice(0, 70)));

    const answerB = await bob.ask(question, { startConversation: true });
    check(!answerB.sources.some((s) => s.documentId === docA), "B's answer NEVER cites A's document", `${answerB.sources.length} source(s)`);

    // --- 10 (R10). Empty knowledge base -------------------------------------
    check(answerB.sources.length === 0, 'a user with no documents retrieves nothing', `${answerB.sources.length} source(s)`);
    check(
      /do not|does not|no document|not cover|unable|cannot/i.test(answerB.answer),
      'and is told so rather than given a general-knowledge answer',
      JSON.stringify(answerB.answer.slice(0, 70)),
    );

    // --- Upload validation ---------------------------------------------------
    console.log('\n-- Upload validation ---------------------------------------------');
    const badType = await alice.upload('notes.exe', Buffer.from('MZ binary', 'utf8'));
    check(badType.status === 415, 'an unsupported file type is rejected', `HTTP ${badType.status}`);

    const empty = await alice.upload('empty.txt', Buffer.alloc(0));
    check(empty.status === 400, 'an empty file is rejected', `HTTP ${empty.status}`);

    /**
     * Sized from the CONFIGURED limit, not from a literal.
     *
     * This allocated a flat 11 MB, which was comfortably over the old 10 MB
     * ceiling and is comfortably UNDER the new 50 MB one — so the test began
     * uploading a legal file and asserting it was refused. Deriving the size
     * means the assertion keeps testing "over the limit" whatever the limit is,
     * and an operator raising MAX_DOCUMENT_SIZE_MB does not silently turn this
     * check into a no-op.
     */
    const overLimit = Buffer.alloc(getMaxUploadBytes() + 1024, 0x61);
    const huge = await alice.upload('huge.txt', overLimit);
    check(
      huge.status === 413,
      'a file over the configured limit is rejected',
      `${(overLimit.length / 1024 / 1024).toFixed(0)} MB -> HTTP ${huge.status}`,
    );

    const malformedDocx = await alice.upload('broken.docx', Buffer.from('this is not a zip', 'utf8'));
    check(malformedDocx.status === 422, 'a malformed DOCX fails cleanly, not as a 500', `HTTP ${malformedDocx.status}`);

    const noRow = await admin.from('documents').select('id').eq('source_url', 'broken.docx');
    check((noRow.data ?? []).length === 0, 'a failed upload leaves no searchable document behind', `${(noRow.data ?? []).length} row(s)`);

    // --- DOCX and PDF end to end --------------------------------------------
    console.log('\n-- DOCX and PDF ---------------------------------------------------');
    const docxBuf = buildDocx([
      'Sparrowvane Handbook',
      'The Sparrowvane relay emits status SV-2210 when its clock drifts beyond tolerance.',
      'Correcting it requires resynchronising against the stratum-1 source and restarting the daemon.',
    ]);
    const docxUp = await alice.upload('sparrowvane.docx', docxBuf);
    check(docxUp.status === 201, 'a real DOCX uploads and processes', `HTTP ${docxUp.status} ${docxUp.body.error ?? ''}`);
    if (docxUp.status === 201) {
      check((docxUp.body.document?.chunkCount ?? 0) > 0, 'the DOCX produced chunks', `${docxUp.body.document?.chunkCount}`);
      const docxAnswer = await alice.ask('What is status SV-2210?');
      check(/SV-2210|clock|drift|stratum/i.test(docxAnswer.answer), 'DOCX content is retrievable and answerable', JSON.stringify(docxAnswer.answer.slice(0, 70)));
    }

    const pdfBuf = buildPdf(['The Kingfisher probe reports code KF-9931 on calibration failure.']);
    const pdfUp = await alice.upload('kingfisher.pdf', pdfBuf);
    if (pdfUp.status === 201) {
      check(true, 'a real PDF uploads and processes', `${pdfUp.body.document?.chunkCount} chunk(s)`);
    } else {
      check(false, 'a real PDF uploads and processes', `HTTP ${pdfUp.status} ${pdfUp.body.error ?? ''}`);
    }

    // --- Every supported format, end to end ---------------------------------
    /**
     * The claim under test is NOT "the upload endpoint returned 201".
     *
     * A 201 proves bytes were accepted. It says nothing about whether the text
     * came out intact, whether it was chunked into anything meaningful, whether
     * the embedding described it, or whether a question can reach it again. A
     * format can return 201 for every upload and still be useless — an XLSX
     * read as UTF-8 would store a page of ZIP header bytes and report success.
     *
     * So each format carries a fact that exists nowhere else in the corpus, in
     * the codebase, or in the model's training data — invented identifiers like
     * "QR-4417" paired with invented nouns. The document is uploaded, then the
     * fact is asked for. Getting it back proves the whole chain ran: extraction
     * produced the right text, chunking kept the fact intact, the embedding put
     * it near the question, retrieval found it, and the model was given it.
     *
     * The citation is checked against the document id as well, because an
     * answer citing the wrong document is a different bug that a text match
     * alone would not catch.
     */
    console.log('\n-- Every supported format, end to end -----------------------------');

    const formatCases: {
      filename: string;
      bytes: Buffer;
      question: string;
      expect: RegExp;
      note: string;
    }[] = [
      {
        filename: 'quarry.txt',
        bytes: Buffer.from(
          'Quarry Notes\n\nThe Tamsin quarry uses permit QR-4417 for night extraction.\n' +
            'Permit QR-4417 was issued by the Vale district office.',
          'utf8',
        ),
        question: 'Which permit does the Tamsin quarry use for night extraction?',
        expect: /QR-4417/i,
        note: 'plain text',
      },
      {
        filename: 'harbour.md',
        bytes: Buffer.from(
          '# Harbour Manual\n\n## Berthing\n\nThe Ellsmere berth is rated for vessels up to ' +
            'HD-8802 tonnage class.\n\nExceeding HD-8802 requires the harbourmaster to sign off.',
          'utf8',
        ),
        question: 'What tonnage class is the Ellsmere berth rated for?',
        expect: /HD-8802/i,
        note: 'markdown (.md)',
      },
      /**
       * The alias extensions, tested as extensions rather than assumed.
       *
       * `.markdown`, `.mdx` and `.htm` map to source types already covered by
       * `.md` and `.html`, so it is tempting to treat them as the same case.
       * They are not: an extension has to survive `fileExtension`, the picker's
       * accept list, the upload route's allow list and `EXTENSION_TO_SOURCE_TYPE`
       * before it ever reaches a parser, and every one of those is a separate
       * lookup that can be missing an entry. `.markdown`, `.text` and `.htm`
       * were the exact three left out of the picker once before.
       */
      {
        filename: 'foundry.markdown',
        bytes: Buffer.from(
          '# Foundry Notes\n\nThe Calder foundry pours alloy grade FD-7350 on Tuesdays.',
          'utf8',
        ),
        question: 'Which alloy grade does the Calder foundry pour?',
        expect: /FD-7350/i,
        note: 'markdown (.markdown)',
      },
      {
        filename: 'orchard.mdx',
        bytes: Buffer.from(
          '# Orchard Register\n\nThe Marlowe orchard is registered under holding MX-6612.',
          'utf8',
        ),
        question: 'Under which holding is the Marlowe orchard registered?',
        expect: /MX-6612/i,
        note: 'markdown (.mdx)',
      },
      {
        filename: 'signal.htm',
        bytes: Buffer.from(
          '<html><head><title>Signal Box</title></head><body>' +
            '<h1>Signal Box</h1><p>The Denby signal box uses interlocking type SB-4471.</p>' +
            '</body></html>',
          'utf8',
        ),
        question: 'What interlocking type does the Denby signal box use?',
        expect: /SB-4471/i,
        note: 'html (.htm)',
      },
      {
        filename: 'ledger.text',
        bytes: Buffer.from(
          'Ledger Notes\n\nThe Whitmore ledger is reconciled against account WM-2093.',
          'utf8',
        ),
        question: 'Which account is the Whitmore ledger reconciled against?',
        expect: /WM-2093/i,
        note: 'plain text (.text)',
      },
      {
        filename: 'lantern.html',
        bytes: Buffer.from(
          '<html><head><title>Lantern Spec</title></head><body>' +
            '<script>window.stolen = "SCRIPTLEAK-9001";</script>' +
            '<style>.x { color: red; }</style>' +
            '<h1>Lantern Spec</h1>' +
            '<p>The Kelvedon lantern draws LM-5150 watts at full output.</p>' +
            '<p>Dimming below LM-5150 extends the emitter life.</p>' +
            '</body></html>',
          'utf8',
        ),
        question: 'How many watts does the Kelvedon lantern draw at full output?',
        expect: /LM-5150/i,
        note: 'html',
      },
      {
        filename: 'kingfisher2.pdf',
        bytes: buildPdf([
          'Kingfisher Field Report',
          'The Marlow sensor array returns fault PX-6633 when the housing floods.',
          'Fault PX-6633 clears once the housing is drained and resealed.',
        ]),
        question: 'What fault does the Marlow sensor array return when the housing floods?',
        expect: /PX-6633/i,
        note: 'pdf',
      },
      {
        filename: 'roster.docx',
        bytes: buildDocx(
          ['Ridgeway Staff Roster', 'The roster below is current for this quarter.'],
          [
            ['Name', 'Badge', 'Role'],
            ['Perrin Vale', 'BG-7719', 'Night Warden'],
            ['Osgood Finn', 'BG-2204', 'Signals Officer'],
          ],
        ),
        question: 'What is Perrin Vale\'s badge number and role?',
        expect: /BG-7719|night warden/i,
        note: 'docx with a table',
      },
      {
        filename: 'inventory.xlsx',
        bytes: buildXlsx([
          {
            name: 'Depot Stock',
            rows: [
              ['Item', 'Code', 'Quantity'],
              ['Brake shoe', 'ZT-3390', '48'],
              ['Coupling pin', 'ZT-1145', '12'],
            ],
          },
        ]),
        question: 'What is the code for the brake shoe in the depot stock?',
        expect: /ZT-3390/i,
        note: 'xlsx with a shared-string table',
      },
      {
        filename: 'contacts.csv',
        bytes: Buffer.from(
          'Name,Extension,Department\n' +
            'Marisol Quint,EX-9042,Hydrology\n' +
            '"Bracken, Ivo",EX-3318,Geodesy\n',
          'utf8',
        ),
        question: 'What is Marisol Quint\'s extension?',
        expect: /EX-9042/i,
        note: 'csv, including a quoted field containing a comma',
      },
      {
        filename: 'settings.json',
        bytes: Buffer.from(
          JSON.stringify(
            {
              service: 'thornfield-relay',
              deployment: { region: 'north-vale', buildTag: 'TF-2288' },
              maintainers: [{ name: 'Alder Reyne', pager: 'PG-6070' }],
            },
            null,
            2,
          ),
          'utf8',
        ),
        question: 'What is the build tag for the thornfield-relay deployment?',
        expect: /TF-2288/i,
        note: 'json with nesting and an array of objects',
      },
    ];

    const formatOutcomes: { note: string; uploaded: boolean; answered: boolean }[] = [];

    for (const testCase of formatCases) {
      const uploaded = await alice.upload(testCase.filename, testCase.bytes);
      const ok201 = uploaded.status === 201;
      check(
        ok201,
        `${testCase.filename} uploads and processes (${testCase.note})`,
        ok201
          ? `${uploaded.body.document?.chunkCount} chunk(s)`
          : `HTTP ${uploaded.status} ${uploaded.body.error ?? ''}`,
      );

      if (!ok201) {
        formatOutcomes.push({ note: testCase.note, uploaded: false, answered: false });
        continue;
      }

      check(
        (uploaded.body.document?.chunkCount ?? 0) > 0,
        `  ${testCase.filename} produced at least one chunk`,
        `${uploaded.body.document?.chunkCount}`,
      );

      const documentId = uploaded.body.document?.id ?? '';

      // Chunks exist in the database with a real embedding, not a null column.
      const stored = await admin
        .from('chunks')
        .select('id, embedding')
        .eq('document_id', documentId);
      const embedded = (stored.data ?? []).filter((row) => row.embedding !== null).length;
      check(
        embedded > 0 && embedded === (stored.data ?? []).length,
        `  every chunk of ${testCase.filename} carries an embedding`,
        `${embedded}/${(stored.data ?? []).length}`,
      );

      const answer = await alice.ask(testCase.question);
      const answered = testCase.expect.test(answer.answer);
      check(
        answered,
        `  the fact from ${testCase.filename} is retrievable and answered`,
        JSON.stringify(answer.answer.slice(0, 90)),
      );
      check(
        answer.sources.some((source) => source.documentId === documentId),
        `  the citation points back to ${testCase.filename}`,
        `${answer.sources.length} source(s)`,
      );

      formatOutcomes.push({ note: testCase.note, uploaded: true, answered });
    }

    console.log('\n   format summary:');
    for (const outcome of formatOutcomes) {
      const verdict = outcome.uploaded && outcome.answered ? 'end-to-end' : outcome.uploaded ? 'uploaded, NOT answered' : 'FAILED';
      console.log(`     ${outcome.note.padEnd(38)} ${verdict}`);
    }

    // --- Malformed input for every parser ------------------------------------
    /**
     * Each of these keeps the magic bytes of a real file of its type, so type
     * detection succeeds and the failure has to be produced by the PARSER. A
     * blob of random bytes would be rejected earlier and would prove nothing
     * about the code under test.
     *
     * The assertion is 4xx rather than merely "not 201": a corrupt upload is
     * the user's problem to see and fix, and a 500 would both hide that and
     * imply the server broke.
     */
    console.log('\n-- Malformed files fail as 4xx, never 500 -------------------------');

    const malformed: { filename: string; bytes: Buffer; note: string }[] = [
      { filename: 'broken2.pdf', bytes: corrupt.pdf(), note: 'PDF with a wrecked object graph' },
      { filename: 'broken2.docx', bytes: corrupt.docx(), note: 'ZIP with no word/document.xml' },
      { filename: 'broken.xlsx', bytes: corrupt.xlsx(), note: 'ZIP with no xl/workbook.xml' },
      { filename: 'broken.json', bytes: corrupt.json(), note: 'syntactically invalid JSON' },
      { filename: 'truncated.xlsx', bytes: corrupt.truncatedZip(), note: 'truncated ZIP' },
    ];

    for (const bad of malformed) {
      const response = await alice.upload(bad.filename, bad.bytes);
      check(
        response.status >= 400 && response.status < 500,
        `${bad.note} is refused with 4xx`,
        `HTTP ${response.status}`,
      );
      check(
        typeof response.body.error === 'string' && response.body.error.length > 0,
        `  and says why`,
        JSON.stringify((response.body.error ?? '').slice(0, 80)),
      );
      // A refused upload must not leave a half-built document behind.
      const orphan = await admin.from('documents').select('id').eq('source_url', bad.filename);
      check(
        (orphan.data ?? []).length === 0,
        `  and stores nothing`,
        `${(orphan.data ?? []).length} row(s)`,
      );
    }

    // --- The two legacy OLE2 formats ----------------------------------------
    /**
     * `.doc` and `.xls` used to be refused by name with advice to convert them.
     * They are read directly now, through a compound-file reader written for
     * this codebase (`cfb.ts`) rather than a dependency — see the note at the
     * top of that file for why every available package was rejected.
     *
     * Verifying them needs a file that Microsoft actually wrote. A fixture
     * built here would only prove the reader can read this repository's own
     * writer, which is the one thing nobody needs to know. So the suite uses a
     * real sample when one is available and says so plainly when it is not,
     * rather than inventing coverage.
     *
     * `MsoIrmProtector.xls` ships with Windows and is a genuine Excel-produced
     * BIFF8 workbook, which makes it a legitimate sample on any Windows
     * machine. Point LEGACY_DOC_SAMPLE / LEGACY_XLS_SAMPLE at your own files to
     * override.
     */
    console.log('\n-- Legacy .doc and .xls --------------------------------------------');

    const legacySamples: { extension: string; path: string | undefined }[] = [
      { extension: '.doc', path: process.env.LEGACY_DOC_SAMPLE },
      {
        extension: '.xls',
        path:
          process.env.LEGACY_XLS_SAMPLE ??
          'C:\\Windows\\System32\\MSDRM\\MsoIrmProtector.xls',
      },
    ];

    for (const sample of legacySamples) {
      if (!sample.path || !existsSync(sample.path)) {
        block(
          `${sample.extension} end-to-end`,
          `no sample available — set ${sample.extension === '.doc' ? 'LEGACY_DOC_SAMPLE' : 'LEGACY_XLS_SAMPLE'} to a real file`,
        );
        continue;
      }

      const bytes = readFileSync(sample.path);
      const uploaded = await alice.upload(`legacy-sample${sample.extension}`, bytes);
      check(
        uploaded.status === 201,
        `a real ${sample.extension} uploads and processes`,
        uploaded.status === 201
          ? `${uploaded.body.document?.chunkCount} chunk(s)`
          : `HTTP ${uploaded.status} ${uploaded.body.error ?? ''}`,
      );
      if (uploaded.status !== 201) continue;

      const documentId = uploaded.body.document?.id ?? '';
      const stored = await admin.from('chunks').select('content, embedding').eq('document_id', documentId);
      const rows = stored.data ?? [];
      check(rows.length > 0, `  ${sample.extension} produced chunks`, `${rows.length}`);
      check(
        rows.every((row) => row.embedding !== null),
        `  every ${sample.extension} chunk carries an embedding`,
      );
      // The failure mode that matters for a binary format: bytes stored as if
      // they were prose. Real extracted text is overwhelmingly printable.
      const text = rows.map((row) => row.content).join(' ');
      const printable = [...text].filter((c) => c >= ' ' || c === '\n' || c === '\t').length;
      check(
        text.length > 0 && printable / text.length > 0.99,
        `  ${sample.extension} yielded readable text, not raw bytes`,
        `${((printable / Math.max(text.length, 1)) * 100).toFixed(1)}% printable`,
      );
      check(
        !/\uFFFD/.test(text),
        `  and decoded its character set without replacement characters`,
      );
    }

    // --- Size and emptiness --------------------------------------------------
    console.log('\n-- Size and emptiness ---------------------------------------------');

    const oversizedBytes = Buffer.alloc(getMaxUploadBytes() + 1024, 'a');
    const oversized = await alice.upload('huge.txt', oversizedBytes);
    check(
      oversized.status === 413 || oversized.status === 400,
      'an oversized file is refused before it is parsed',
      `${(oversizedBytes.length / 1024 / 1024).toFixed(0)} MB -> HTTP ${oversized.status}`,
    );

    /**
     * A file comfortably under the ceiling must still be accepted, or "the
     * limit works" would also be satisfied by a route that refused everything.
     *
     * Deliberately modest. The first version repeated a line 2,000 times, which
     * chunked into dozens of passages and spent dozens of embedding calls to
     * prove one boolean — enough to trip the provider's per-minute limit and
     * fail on a 429 that had nothing to do with size. A few chunks demonstrate
     * exactly the same thing.
     */
    const underLimit = Buffer.from(
      `Ceiling probe. The clearance code is CL-7781.
`.repeat(40),
      'utf8',
    );
    const accepted = await alice.upload('under-limit.txt', underLimit);
    check(
      accepted.status === 201,
      '  while a large-but-legal file is still accepted',
      `${(underLimit.length / 1024).toFixed(0)} KB -> HTTP ${accepted.status}`,
    );
    if (accepted.body.document) {
      await admin.from('documents').delete().eq('id', accepted.body.document.id);
    }

    const emptyFile = await alice.upload('nothing.txt', Buffer.alloc(0));
    check(
      emptyFile.status >= 400 && emptyFile.status < 500,
      'an empty file is refused',
      `HTTP ${emptyFile.status}`,
    );

    const whitespaceOnly = await alice.upload('blank.txt', Buffer.from('   \n\n  \t ', 'utf8'));
    check(
      whitespaceOnly.status >= 400 && whitespaceOnly.status < 500,
      'a file of only whitespace is refused as having no text',
      `HTTP ${whitespaceOnly.status}`,
    );

    const unsupported = await alice.upload('payload.exe', Buffer.from('MZ\x90\x00', 'latin1'));
    check(
      unsupported.status === 415,
      'an unsupported extension is refused with 415, never silently accepted',
      `HTTP ${unsupported.status}`,
    );

    // --- 13. Cascade ---------------------------------------------------------
    console.log('\n-- Deleting a document removes its chunks ------------------------');
    const before = await admin.from('chunks').select('*', { count: 'exact', head: true }).eq('document_id', docA);
    const del = await alice.request(`/api/documents/${docA}`, { method: 'DELETE' });
    check(del.status === 200, 'A can delete their own document', `HTTP ${del.status}`);

    const after = await admin.from('chunks').select('*', { count: 'exact', head: true }).eq('document_id', docA);
    check((before.count ?? 0) > 0 && after.count === 0, 'deleting the document cascaded to its chunks', `${before.count} -> ${after.count}`);

    const gone = await admin.from('documents').select('id').eq('id', docA).maybeSingle();
    check(gone.data === null, 'the document row is gone');

    // --- 14. Level 13 conversations intact -----------------------------------
    console.log('\n-- Level 13 behaviour preserved ----------------------------------');
    const convos = await alice.json<{ conversations: { id: string }[] }>('/api/conversations');
    check(convos.status === 200 && convos.body.conversations.length > 0, "A's conversations still exist", `${convos.body.conversations.length}`);

    const bConvos = await bob.json<{ conversations: { id: string }[] }>('/api/conversations');
    const overlap = bConvos.body.conversations.filter((c) => convos.body.conversations.some((a) => a.id === c.id));
    check(overlap.length === 0, "B still cannot see A's conversations", `${overlap.length} shared`);

    const anonChat = await new Client().ask('hello there');
    check(anonChat.answer.length > 0, 'anonymous chat still works against the shared corpus');
  } finally {
    console.log('\n-- Cleanup ---------------------------------------------------------');
    // Deleting the auth user cascades to their documents (user_id FK), from
    // there to chunks, and to their conversations and messages. Scoped to the
    // accounts this run created — never a global delete.
    let removed = 0;
    for (const id of testUserIds) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) console.error(`   could not delete test user ${id}: ${error.message}`);
      else removed++;
    }
    check(removed === testUserIds.length, 'test accounts removed', `${removed}/${testUserIds.length}`);

    let orphanDocs = 0;
    for (const id of testUserIds) {
      const { count } = await admin
        .from('documents')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', id);
      orphanDocs += count ?? 0;
    }
    check(orphanDocs === 0, 'no documents remain for the test accounts', `${orphanDocs}`);

    const { count: docs } = await admin.from('documents').select('*', { count: 'exact', head: true });
    const { count: chunks } = await admin.from('chunks').select('*', { count: 'exact', head: true });
    const { count: convos } = await admin.from('conversations').select('*', { count: 'exact', head: true });
    console.log(
      `     database holds ${docs} document(s), ${chunks} chunk(s), ${convos} conversation(s) not created by this run (untouched)`,
    );
  }

  verifyUploadUi();

  summary();
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
