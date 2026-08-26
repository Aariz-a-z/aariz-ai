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

import { crc32 } from 'node:zlib';

import { signIn } from '../src/lib/auth.ts';
import { createAuthedClient, isAuthConfigured } from '../src/lib/supabase/authed.ts';
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
// File fixtures, built byte-exactly in memory
// ---------------------------------------------------------------------------

/**
 * A ZIP with stored (uncompressed) entries.
 *
 * Enough to make a valid DOCX: the format is a ZIP of XML parts, and
 * compression is optional. Stored entries keep this readable and make the
 * offsets easy to get right.
 */
function buildZip(entries: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.from(entry.content, 'utf8');
    const sum = crc32(dataBuf);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (arbitrary, valid)
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, dataBuf);
    centrals.push(central);
    offset += local.length + dataBuf.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

function buildDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');

  return buildZip([
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}</w:body></w:document>`,
    },
  ]);
}

/** A single-page PDF with a real xref table, so byte offsets must be correct. */
function buildPdf(line: string): Buffer {
  const escaped = line.replace(/([\\()])/g, '\\$1');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

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

  async ask(prompt: string, extra: Record<string, unknown> = {}): Promise<{ answer: string; sources: { documentId: string }[] }> {
    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], ...extra }),
    });
    if (!response.ok || !response.body) return { answer: '', sources: [] };

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

  for (const [label, url] of [['the application', `${BASE_URL}/`], ['Ollama', `${process.env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434'}/api/version`]] as const) {
    try {
      const ping = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!ping.ok) throw new Error(String(ping.status));
    } catch {
      block(`${label} is not reachable`, url);
      summary();
      return;
    }
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

    const huge = await alice.upload('huge.txt', Buffer.alloc(11 * 1024 * 1024, 0x61));
    check(huge.status === 413, 'an oversized file is rejected', `HTTP ${huge.status}`);

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

    const pdfBuf = buildPdf('The Kingfisher probe reports code KF-9931 on calibration failure.');
    const pdfUp = await alice.upload('kingfisher.pdf', pdfBuf);
    if (pdfUp.status === 201) {
      check(true, 'a real PDF uploads and processes', `${pdfUp.body.document?.chunkCount} chunk(s)`);
    } else {
      check(false, 'a real PDF uploads and processes', `HTTP ${pdfUp.status} ${pdfUp.body.error ?? ''}`);
    }

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

  summary();
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
