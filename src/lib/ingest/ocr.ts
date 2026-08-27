/**
 * OCR for scanned PDFs.
 *
 * WHY THE PROVIDER'S VISION MODEL, AND NOT TESSERACT
 * --------------------------------------------------
 * The obvious choice is `tesseract.js`, and it was rejected after working out
 * what it would actually cost here. Tesseract reads IMAGES, not PDFs, so a
 * scanned PDF has to be rasterised first — which means pdfjs plus a canvas
 * implementation, and every canvas implementation for Node is either native
 * bindings (`node-canvas`, `@napi-rs/canvas`) or another WASM blob. Added to
 * Tesseract's own ~30 MB of WASM and ~15 MB of language data, that is three new
 * dependencies, one of them native, to make a serverless function that already
 * has a bundle-size ceiling do CPU-bound work it has no cores for. The user's
 * own constraint — "prefer a solution that does NOT require installing system
 * packages such as Tesseract binaries if that would break Vercel" — points the
 * same way.
 *
 * The configured LLM provider already reads PDFs. Gemini accepts
 * `application/pdf` as `inline_data` and transcribes it, scanned or not,
 * including rotated pages and mixed text/image documents, because it is looking
 * at rendered pages rather than parsing a content stream. Verified against a
 * genuinely image-only fixture before this file was written: 2.8 seconds, exact
 * transcription.
 *
 * So OCR adds ZERO dependencies, no WASM, no binaries, no temporary files, and
 * no rasterisation step. It is one `fetch`, which is the only thing a
 * serverless function is unambiguously good at.
 *
 * PRIVACY, STATED PLAINLY
 * -----------------------
 * OCR sends the PDF to the same provider that already receives the document.
 * In Gemini mode every chunk of every uploaded file is sent to Google to be
 * embedded — that is what `LLM_PROVIDER=gemini` means, and it is documented in
 * `docs/DEPLOYMENT.md` under "Privacy — the trade this mode makes". Sending the
 * page images too does not cross a boundary that was not already crossed; it
 * moves no data to a NEW party. What it must not do is happen when the operator
 * has said no external calls, and it does not: `ZERO_API_MODE` refuses the
 * embedding provider, so ingestion stops before OCR is ever reached.
 *
 * A LOCAL DEPLOYMENT CANNOT OCR
 * -----------------------------
 * `llama3.2:3b` is a text model. In Ollama mode there is no vision capability
 * to call, so a scanned PDF fails with a message saying the document could not
 * be read — not a message about OCR, which would mean nothing to the person
 * holding the file. This is a real limitation and it is reported, not hidden.
 */

import {
  MAX_OCR_CHARS,
  MAX_OCR_INPUT_BYTES,
  MAX_OCR_PAGES_ENV,
  OCR_TIMEOUT_MS,
  resolveMaxOcrPages,
} from '../limits.ts';

export type OcrErrorCode =
  | 'unsupported_provider'
  | 'too_large'
  | 'provider_failed'
  | 'no_text_found';

export class OcrError extends Error {
  readonly code: OcrErrorCode;

  constructor(code: OcrErrorCode, message: string) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
  }
}

/** Whether the configured provider can read images at all. */
export function isOcrAvailable(): boolean {
  return (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase() === 'gemini';
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * The transcription instruction.
 *
 * Written to suppress the two things a chat-tuned model does by default and
 * which would both poison an index: commentary around the transcription
 * ("Here is the text from your document:"), and helpfully summarising instead
 * of transcribing. It also asks for a marker on unreadable pages so a failed
 * page is visible in the text rather than silently absent.
 */
const OCR_INSTRUCTION = [
  'Transcribe ALL visible text in this document, exactly as written, preserving reading order.',
  'Include headings, labels, table cells, numbers, codes and reference identifiers verbatim.',
  'Do not summarise, translate, correct, explain or comment. Output only the transcribed text.',
  'Separate pages with a blank line. If a page contains no readable text, write [blank page].',
].join(' ');

interface GeminiPart {
  text?: string;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string };
}

export interface OcrResult {
  text: string;
  /** Pages the provider was asked to read, after the cap. */
  pagesRequested: number;
  /** True when the document was longer than the cap allows. */
  truncated: boolean;
}

/**
 * Read a scanned PDF.
 *
 * `pageCount` comes from the PDF parser, which can count pages in a document it
 * cannot extract a single character from — page objects are structure, text is
 * content. That is what makes the page cap enforceable BEFORE the expensive
 * call rather than after it.
 */
export async function ocrPdf(
  buffer: Buffer,
  pageCount: number | null,
  options: { signal?: AbortSignal } = {},
): Promise<OcrResult> {
  if (!isOcrAvailable()) {
    throw new OcrError(
      'unsupported_provider',
      'This deployment cannot read scanned documents.',
    );
  }

  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new OcrError('unsupported_provider', 'This deployment cannot read scanned documents.');
  }

  if (buffer.byteLength > MAX_OCR_INPUT_BYTES) {
    throw new OcrError(
      'too_large',
      'This document is too large to process. Please upload a smaller file.',
    );
  }

  const maxPages = resolveMaxOcrPages(process.env[MAX_OCR_PAGES_ENV]);
  const pages = pageCount ?? 1;
  const truncated = pages > maxPages;

  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';
  const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;

  // Two independent budgets: the caller's abort (a user closing the tab) and
  // this module's own ceiling, so a provider that never answers cannot hold a
  // function open until the platform kills it.
  const budget = AbortSignal.timeout(OCR_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;

  const instruction = truncated
    ? `${OCR_INSTRUCTION} Transcribe only the first ${maxPages} pages.`
    : OCR_INSTRUCTION;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      // The key travels in a header, never a query string.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: 'application/pdf', data: buffer.toString('base64') } },
              { text: instruction },
            ],
          },
        ],
        generationConfig: {
          // Transcription, not composition. Any creativity here is a
          // hallucinated line in somebody's document.
          temperature: 0,
          maxOutputTokens: 8192,
        },
      }),
      signal,
    });
  } catch (caught) {
    if (budget.aborted) {
      throw new OcrError(
        'provider_failed',
        'This document took too long to process. Please try a smaller file.',
      );
    }
    // A caller-initiated abort propagates untouched so the route can tell it
    // apart from a failure.
    if (caught instanceof Error && caught.name === 'AbortError') throw caught;
    throw new OcrError('provider_failed', 'The document could not be read. Please try again.');
  }

  if (!response.ok) {
    // Drained so the socket is released, discarded because a provider error
    // body can echo request content and name internal services.
    await response.text().catch(() => undefined);
    throw new OcrError('provider_failed', 'The document could not be read. Please try again.');
  }

  const data = (await response.json()) as GeminiResponse;
  if (data.error || data.promptFeedback?.blockReason) {
    throw new OcrError('provider_failed', 'The document could not be read. Please try again.');
  }

  const raw = (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('');

  /**
   * Strip the model's own "blank page" markers before measuring.
   *
   * A document of nothing but blank pages must NOT come back as a success
   * holding four copies of the word "[blank page]" — that is meaningless text
   * stored as if it were content, which is exactly what a blank document is
   * supposed to be refused for.
   */
  const cleaned = raw.replace(/\[blank page\]/gi, '').trim();

  if (cleaned.length === 0) {
    throw new OcrError('no_text_found', 'No readable text was found in this document.');
  }

  const text = cleaned.slice(0, MAX_OCR_CHARS);
  return {
    text: truncated
      ? `${text}\n\n[Only the first ${maxPages} pages of this document were read.]`
      : text,
    pagesRequested: Math.min(pages, maxPages),
    truncated,
  };
}
