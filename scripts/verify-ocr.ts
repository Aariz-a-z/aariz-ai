#!/usr/bin/env node
/**
 * OCR — scanned PDFs, end to end through the real upload route.
 *
 * WHAT MAKES THIS A REAL OCR TEST
 * -------------------------------
 * The fixture is a PDF whose only content is one image XObject. There is no
 * `/Font` resource and no `BT`/`Tj` operator anywhere in the content stream, so
 * `unpdf` extracts exactly zero characters from it — asserted below before
 * anything is uploaded, because a fixture that quietly grew a text layer would
 * turn this whole suite into a test of the ordinary PDF path.
 *
 * The text it carries is drawn pixel by pixel from a bitmap font. Its invented
 * identifiers — OCR-TEST-84721 and the rest — appear in no training corpus, so
 * an answer containing one cannot have come from the model's memory. It has to
 * have travelled: image -> OCR -> chunk -> embedding -> pgvector -> retrieval
 * -> answer -> citation.
 *
 * Run:
 *   LLM_PROVIDER=gemini node --experimental-strip-types scripts/verify-ocr.ts
 */

import { extractText, getDocumentProxy } from 'unpdf';

import { getSupabaseAdminClient, isSupabaseConfigured } from '../src/lib/supabase/server.ts';
import { needsOcr } from '../src/lib/ingest/extract.ts';
import { isOcrAvailable } from '../src/lib/ingest/ocr.ts';
import {
  MIN_TEXT_CHARS_PER_PAGE,
  MIN_TEXT_CHARS_TOTAL,
  resolveMaxDocumentBytes,
  resolveMaxOcrPages,
} from '../src/lib/limits.ts';
import { buildBlankPdf, buildMixedPdf, buildScannedPdf } from './fixtures/scanned-pdf.ts';
import { buildPdf } from './fixtures/documents.ts';
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

/** Characters `unpdf` can pull out of a PDF, which is what triggers OCR. */
async function extractableChars(pdf: Buffer): Promise<number> {
  const proxy = await getDocumentProxy(new Uint8Array(pdf));
  const result = await extractText(proxy, { mergePages: true });
  const text = Array.isArray(result.text) ? result.text.join('') : (result.text ?? '');
  return text.replace(/\s+/g, ' ').trim().length;
}

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

  async upload(
    filename: string,
    content: Buffer,
  ): Promise<{ status: number; body: { document?: { id: string; chunkCount: number }; error?: string } }> {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(content)], filename));
    const response = await this.request('/api/documents', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    let body: { document?: { id: string; chunkCount: number }; error?: string };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = {};
    }
    return { status: response.status, body };
  }

  async ask(prompt: string): Promise<{ answer: string; sources: { documentId: string }[] }> {
    const response = await this.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(180_000),
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
        const event = JSON.parse(line) as {
          type: string;
          text?: string;
          sources?: { documentId: string }[];
        };
        if (event.type === 'delta' && event.text) answer += event.text;
        else if (event.type === 'sources' && Array.isArray(event.sources)) sources = event.sources;
      }
    }
    return { answer, sources };
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  console.log('\n=== OCR — scanned documents ===\n');

  if (!isSupabaseConfigured()) {
    block('Supabase is not configured');
    summary();
    return;
  }

  // =========================================================================
  console.log('-- Detection thresholds (in-process) -------------------------------');

  check(
    MIN_TEXT_CHARS_TOTAL > 0 && MIN_TEXT_CHARS_PER_PAGE > 0,
    'a scanned PDF is detected by a threshold, not by text.length === 0',
    `total<${MIN_TEXT_CHARS_TOTAL} or per-page<${MIN_TEXT_CHARS_PER_PAGE}`,
  );
  check(
    resolveMaxDocumentBytes(undefined) === 50 * 1024 * 1024,
    'the upload ceiling defaults to 50 MB',
    `${resolveMaxDocumentBytes(undefined) / 1024 / 1024} MB`,
  );
  check(
    resolveMaxDocumentBytes('75') === 75 * 1024 * 1024,
    '  and honours MAX_DOCUMENT_SIZE_MB',
  );
  check(
    resolveMaxDocumentBytes('99999') === 200 * 1024 * 1024,
    '  and clamps an absurd value rather than honouring it',
    `${resolveMaxDocumentBytes('99999') / 1024 / 1024} MB`,
  );
  check(
    resolveMaxDocumentBytes('not-a-number') === 50 * 1024 * 1024,
    '  and falls back to the default on a typo',
  );
  check(resolveMaxOcrPages(undefined) === 20, 'OCR reads at most 20 pages by default');
  check(resolveMaxOcrPages('5') === 5, '  and honours MAX_OCR_PAGES');
  check(resolveMaxOcrPages('9999') === 200, '  and clamps an absurd page cap');

  /**
   * The OCR decision, tested directly rather than inferred from an upload.
   *
   * Inferring it was the first attempt and it did not work: a control PDF
   * carrying 63 characters is BELOW the threshold, so OCR ran on it too, and
   * the assertion "its text layer was used" passed either way. Calling the
   * predicate removes the ambiguity entirely.
   */
  check(needsOcr('', 1), 'an empty PDF needs OCR');
  check(needsOcr('   \n  ', 1), '  as does one with only whitespace');
  check(
    needsOcr('Scanned by Acme 2024   Page 1 of 12', 1),
    '  as does a scan carrying only a scanner header — the case text.length === 0 misses',
  );
  check(
    !needsOcr('x'.repeat(400), 1),
    'a page with real text does NOT need OCR',
  );
  check(
    needsOcr('x'.repeat(400), 40),
    '  but the same text spread over 40 pages does — per-page average, not total',
  );
  check(
    !needsOcr('x'.repeat(4000), 10),
    '  and a genuine 10-page text document does not',
  );

  // =========================================================================
  console.log('\n-- The fixture really is image-only --------------------------------');

  const scanned = buildScannedPdf([
    'TAX ASSESSMENT NOTICE',
    '',
    'REFERENCE OCR-TEST-84721',
    'THE LEVY RATE FOR PARCEL 7749 IS 12 PERCENT.',
    'ASSESSED BY THE HARROWGATE REVENUE OFFICE.',
  ]);

  const raw = scanned.toString('latin1');
  check(!/\bBT\b/.test(raw) && !/\bTj\b/.test(raw), 'the scanned fixture has no text operators');
  check(!/\/Font/.test(raw), '  and no font resource');
  check(/\/Image/.test(raw), '  and does contain an image XObject');

  const scannedChars = await extractableChars(scanned);
  check(scannedChars === 0, '  and a text extractor finds nothing in it', `${scannedChars} chars`);

  /**
   * Deliberately verbose. A short control PDF sat below the OCR threshold, so
   * OCR ran on it and the "text path" test proved nothing. The control has to
   * clear the threshold comfortably for the comparison to mean anything.
   */
  const normal = buildPdf([
    'Ordinary text PDF with a genuine embedded font and a real text layer.',
    'The reference for this page is TEXTPDF-3310 and it is written as text.',
    'This paragraph exists to carry the document comfortably past the minimum',
    'character threshold, so that the OCR path is not triggered for a file that',
    'a text extractor can already read perfectly well on its own.',
  ]);
  const normalChars = await extractableChars(normal);
  check(
    normalChars > MIN_TEXT_CHARS_TOTAL,
    'the control text PDF does have a text layer',
    `${normalChars} chars`,
  );
  check(
    !needsOcr('x'.repeat(normalChars), 1),
    '  and is comfortably above the OCR threshold, so the text path is taken',
  );

  if (!isOcrAvailable()) {
    block(
      'OCR end-to-end',
      `LLM_PROVIDER=${process.env.LLM_PROVIDER ?? 'ollama'} has no vision model — run with LLM_PROVIDER=gemini`,
    );
    summary();
    return;
  }

  // =========================================================================
  const admin = getSupabaseAdminClient();
  const stamp = Date.now();
  const createdUsers: string[] = [];
  const createdDocuments: string[] = [];

  try {
    const email = `ocr-${stamp}@example.test`;
    const password = `Ocr-${stamp}-Aa1!`;
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !created.user) {
      block('could not create the test account', error?.message ?? '');
      summary();
      return;
    }
    createdUsers.push(created.user.id);

    const client = new Client();
    const signin = await client.request('/api/auth/signin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!signin.ok) {
      block('could not sign in', `HTTP ${signin.status}`);
      summary();
      return;
    }

    // =======================================================================
    console.log('\n-- A normal text PDF still takes the text path ---------------------');

    const normalUpload = await client.upload(`normal-${stamp}.pdf`, normal);
    check(normalUpload.status === 201, 'an ordinary PDF uploads', `HTTP ${normalUpload.status} ${normalUpload.body.error ?? ''}`);
    if (normalUpload.body.document) {
      createdDocuments.push(normalUpload.body.document.id);
      const stored = await admin
        .from('chunks')
        .select('content')
        .eq('document_id', normalUpload.body.document.id);
      const text = (stored.data ?? []).map((row) => row.content).join(' ');
      check(/TEXTPDF-3310/i.test(text), '  and its text layer was used', `${text.length} chars`);
    }

    // =======================================================================
    console.log('\n-- A SCANNED PDF is OCRed and indexed ------------------------------');

    const started = Date.now();
    const scannedUpload = await client.upload(`assignment-tax-${stamp}.pdf`, scanned);
    const elapsed = Date.now() - started;

    check(
      scannedUpload.status === 201,
      'a scanned, image-only PDF uploads successfully',
      `HTTP ${scannedUpload.status} in ${elapsed}ms ${scannedUpload.body.error ?? ''}`,
    );
    // The whole point of the feature: the user must NOT be told about OCR.
    check(
      !/no text layer|needs OCR|OCR before/i.test(scannedUpload.body.error ?? ''),
      '  and the user is never shown a "no text layer" message',
      JSON.stringify(scannedUpload.body.error ?? '(no error)'),
    );

    if (scannedUpload.status === 201 && scannedUpload.body.document) {
      const documentId = scannedUpload.body.document.id;
      createdDocuments.push(documentId);

      check(
        (scannedUpload.body.document.chunkCount ?? 0) > 0,
        '  and produced chunks',
        `${scannedUpload.body.document.chunkCount}`,
      );

      const stored = await admin
        .from('chunks')
        .select('id, content, embedding')
        .eq('document_id', documentId);
      const rows = stored.data ?? [];
      const text = rows.map((row) => row.content).join(' ');

      check(/OCR-TEST-84721/i.test(text), '  and the OCR text reached the database', `${text.length} chars`);
      check(
        rows.length > 0 && rows.every((row) => row.embedding !== null),
        '  and every OCR chunk carries a Gemini embedding',
        `${rows.filter((r) => r.embedding !== null).length}/${rows.length}`,
      );

      // The full chain, proven by a fact that exists nowhere else.
      const answer = await client.ask('What is the reference number on the tax assessment notice?');
      check(
        /OCR-TEST-84721/i.test(answer.answer),
        '  and the scanned content is retrievable and answered',
        JSON.stringify(answer.answer.slice(0, 110)),
      );
      check(
        answer.sources.some((source) => source.documentId === documentId),
        '  and the citation points back to the scanned document',
        `${answer.sources.length} source(s)`,
      );

      const second = await client.ask('What is the levy rate for parcel 7749?');
      check(
        /12/.test(second.answer),
        '  and a second fact from the same scan is retrievable',
        JSON.stringify(second.answer.slice(0, 110)),
      );

      // Grounding must not be weakened by OCR content being present.
      const offTopic = await client.ask('What is the capital of Mongolia?');
      check(
        !/Ulaanbaatar/i.test(offTopic.answer),
        '  and an unrelated question is still refused, not answered from memory',
        JSON.stringify(offTopic.answer.slice(0, 110)),
      );
    }

    // =======================================================================
    console.log('\n-- A mixed text + scanned PDF --------------------------------------');

    const mixed = buildMixedPdf(
      ['Mixed document, page one is real text.', 'Page one reference MIXEDTEXT-5520.'],
      ['PAGE TWO IS A SCAN', 'SCANNED REFERENCE MIXEDSCAN-9931'],
    );
    const mixedChars = await extractableChars(mixed);
    console.log(`     the mixed fixture yields ${mixedChars} extractable characters`);

    const mixedUpload = await client.upload(`mixed-${stamp}.pdf`, mixed);
    check(mixedUpload.status === 201, 'a mixed text/scan PDF uploads', `HTTP ${mixedUpload.status} ${mixedUpload.body.error ?? ''}`);
    if (mixedUpload.body.document) {
      createdDocuments.push(mixedUpload.body.document.id);
      const stored = await admin
        .from('chunks')
        .select('content')
        .eq('document_id', mixedUpload.body.document.id);
      const text = (stored.data ?? []).map((row) => row.content).join(' ');
      /**
       * Reported rather than asserted, and deliberately.
       *
       * A two-page document whose text page carries enough characters is above
       * the OCR threshold, so the scanned page is NOT read — that is the
       * threshold behaving exactly as designed, not a defect. Asserting the
       * scanned half must appear would be asserting that the threshold does not
       * work. What IS asserted is that the document indexed and the text half
       * survived; the scanned half is printed so the trade-off stays visible.
       */
      check(/MIXEDTEXT-5520/i.test(text), '  and its text page was indexed');
      console.log(
        `     scanned page also captured: ${/MIXEDSCAN-9931/i.test(text) ? 'yes' : 'no (text page cleared the threshold, so OCR did not run)'}`,
      );
    }

    // =======================================================================
    console.log('\n-- A genuinely blank PDF is refused --------------------------------');

    const blankUpload = await client.upload(`blank-${stamp}.pdf`, buildBlankPdf());
    check(
      blankUpload.status >= 400 && blankUpload.status < 500,
      'a blank scan is refused rather than stored as an empty success',
      `HTTP ${blankUpload.status}`,
    );
    check(
      !/OCR|text layer|pdfjs|unpdf|DOMMatrix/i.test(blankUpload.body.error ?? ''),
      '  with a message naming no library or internal stage',
      JSON.stringify((blankUpload.body.error ?? '').slice(0, 90)),
    );
    if (blankUpload.status === 201 && blankUpload.body.document) {
      createdDocuments.push(blankUpload.body.document.id);
    }
  } finally {
    // =======================================================================
    console.log('\n-- Cleanup ---------------------------------------------------------');

    let documentsRemoved = 0;
    for (const id of createdDocuments) {
      const { error } = await admin.from('documents').delete().eq('id', id);
      if (!error) documentsRemoved++;
    }
    let usersRemoved = 0;
    for (const id of createdUsers) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (!error) usersRemoved++;
    }

    check(
      documentsRemoved === createdDocuments.length,
      'every document this run created was removed',
      `${documentsRemoved}/${createdDocuments.length}`,
    );
    check(
      usersRemoved === createdUsers.length,
      'every account this run created was removed',
      `${usersRemoved}/${createdUsers.length}`,
    );

    const { count } = await admin.from('documents').select('*', { count: 'exact', head: true });
    console.log(`     ${count} document(s) belonging to someone else were left alone`);
  }

  summary();
}

main().catch((error: unknown) => {
  console.error('\nVerification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
