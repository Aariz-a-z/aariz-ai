/**
 * Document size and workload limits — one definition, read everywhere.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The upload ceiling was written down twice, as `MAX_UPLOAD_BYTES = 10 * 1024 *
 * 1024` in both `documents.ts` and `documents-client.ts`, with a comment on the
 * second saying it "mirrors" the first. Mirrors drift. The accepted-extension
 * list had the same arrangement and did drift — the picker offered nine formats
 * the upload route refused — which is the whole reason `formats.ts` exists.
 * Raising a size limit in one of two places would fail the same way: the server
 * would accept a 40 MB file the browser had already refused, or worse the
 * reverse.
 *
 * WHY IT IMPORTS NOTHING
 * ----------------------
 * Same property that makes `formats.ts` shareable. No `node:*`, no parser, and
 * critically no `process.env` at module scope — the resolver below is a pure
 * function of a string, so the browser can hold the same code without needing
 * the variable, and a test can check the parsing without setting environment.
 *
 * The server resolves the real value and hands it to the client as a prop, the
 * way `inferenceDisabled` already travels. No `NEXT_PUBLIC_` variable is
 * introduced: publishing configuration to every visitor is how an environment
 * variable meant as a feature flag ends up disclosing infrastructure.
 */

/** Name of the variable an operator sets. Exported so docs and tests agree. */
export const MAX_DOCUMENT_SIZE_MB_ENV = 'MAX_DOCUMENT_SIZE_MB';

/**
 * Default ceiling, in megabytes.
 *
 * Raised from 10 MB. 50 MB is a deliberate choice rather than a round number:
 *
 *   - A serverless function receives the whole upload in memory before any
 *     parser sees it, and then holds the extracted text and every embedding
 *     vector alongside it. 50 MB of PDF is comfortable inside a 1 GB function;
 *     several hundred megabytes is not.
 *   - Vercel's platform limit on a request body is 4.5 MB for the Edge runtime
 *     and larger for Node, but a synchronous upload still has to finish inside
 *     the function's execution budget. See the execution-time note in
 *     `docs/DEPLOYMENT.md` — a large scanned document is bounded by TIME long
 *     before it is bounded by size.
 *   - Every parser here has its own decompression ceiling, so a 50 MB archive
 *     cannot expand without limit. Those are the numbers below.
 */
export const DEFAULT_MAX_DOCUMENT_SIZE_MB = 50;

/** Hard ceiling on what an operator may configure, whatever they set. */
export const ABSOLUTE_MAX_DOCUMENT_SIZE_MB = 200;

export function megabytesToBytes(megabytes: number): number {
  return Math.floor(megabytes * 1024 * 1024);
}

/**
 * Resolve the configured ceiling from a raw environment value.
 *
 * Pure, so it can be tested without touching `process.env`, and so the client
 * bundle can call it with `undefined` and get the default.
 *
 * An unparseable value falls back to the default rather than throwing. That is
 * the opposite of how `ZERO_API_MODE` treats a typo, and deliberately so: a
 * misspelled security mode must fail loudly because silence would remove a
 * guarantee, whereas a misspelled size limit failing loudly would take the
 * whole application down over a comfort setting. Out-of-range values are
 * clamped rather than honoured, so neither 0 nor 10000 can be configured.
 */
export function resolveMaxDocumentBytes(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return megabytesToBytes(DEFAULT_MAX_DOCUMENT_SIZE_MB);

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return megabytesToBytes(DEFAULT_MAX_DOCUMENT_SIZE_MB);
  }

  const clamped = Math.min(parsed, ABSOLUTE_MAX_DOCUMENT_SIZE_MB);
  return megabytesToBytes(clamped);
}

// =============================================================================
// Extraction workload ceilings
// =============================================================================

/**
 * Characters of extracted text a single document may contribute.
 *
 * Raised alongside the size limit, because the old 2,000,000 would have made a
 * 50 MB allowance meaningless: a large spreadsheet re-rendered with headers on
 * every row hits that in a fraction of the file. Still bounded, because every
 * character is chunked and embedded at cost, and an unbounded value turns one
 * upload into an unbounded provider bill.
 */
export const MAX_EXTRACTED_CHARS = 8_000_000;

/**
 * Bytes any single archive may inflate to.
 *
 * This is the decompression-bomb ceiling. It is deliberately NOT scaled to the
 * upload limit: a zip bomb is small on disk by definition, so tying this to the
 * file size would defeat it entirely. A 42 KB archive expanding to 4 GB is the
 * classic case, and it is refused by this number, not by the upload check.
 */
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

// =============================================================================
// OCR ceilings
// =============================================================================

/** Name of the variable an operator sets to cap OCR pages. */
export const MAX_OCR_PAGES_ENV = 'MAX_OCR_PAGES';

/**
 * Pages of a scanned document that will be read.
 *
 * OCR is the most expensive thing this pipeline can be asked to do — a vision
 * model call whose cost and latency scale with page count — so it is capped
 * separately from everything else. Twenty pages covers the documents people
 * actually scan (a form, a statement, an assignment) while refusing a
 * 500-page book that would exhaust an execution budget long before it finished.
 *
 * A document over the cap is not rejected. The pages within the cap are read
 * and the shortfall is stated in the text, because half of a long scan indexed
 * is far more useful than none of it.
 */
export const DEFAULT_MAX_OCR_PAGES = 20;

export function resolveMaxOcrPages(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_MAX_OCR_PAGES;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_OCR_PAGES;
  return Math.min(parsed, 200);
}

/**
 * Bytes of PDF that may be sent to the OCR provider in one call.
 *
 * Lower than the upload ceiling on purpose. The provider takes the document
 * base64-encoded, which inflates it by a third, and a request far larger than
 * this is refused by the API rather than answered — so refusing it here gives
 * the user a sentence they can act on instead of a provider error.
 */
export const MAX_OCR_INPUT_BYTES = 18 * 1024 * 1024;

/** Wall-clock ceiling for one OCR call. */
export const OCR_TIMEOUT_MS = 120_000;

/** Characters of OCR output accepted from one document. */
export const MAX_OCR_CHARS = 400_000;

/**
 * Below this many characters per page, a PDF is treated as scanned.
 *
 * Not `length === 0`, and the difference matters. A scanned page routinely
 * carries a handful of extractable characters — a header applied by the
 * scanner, a page number stamped by the copier, an OCR layer some other tool
 * left half-finished — and any of those defeats a zero check while leaving the
 * document's actual content unreadable.
 *
 * Fifty characters per page is roughly one short line. A real text page carries
 * hundreds to thousands, so the gap between the two cases is wide and the
 * threshold does not sit near anything.
 */
export const MIN_TEXT_CHARS_PER_PAGE = 50;

/**
 * A document with fewer than this many characters in total is scanned-or-empty
 * regardless of page count, which catches the single-page case where a
 * per-page average is not yet meaningful.
 */
export const MIN_TEXT_CHARS_TOTAL = 100;
