/**
 * Text extraction and cleaning — the first two stages of the Level 6 pipeline:
 *
 *     file -> extract text -> clean text -> ...
 *
 * Every supported format converges on ONE `ExtractedDocument` here and then
 * follows the identical path: chunk, embed, store, retrieve, cite. There is no
 * per-format pipeline and there must not be one — the formats differ only in
 * how bytes become text, which is the whole of what this file does.
 *
 * Two entry points over one implementation: `extractDocument` reads a path (the
 * CLI ingestion path), `extractBuffer` takes bytes already in memory (the HTTP
 * upload path). Uploads must not be written to disk first, so the buffer form
 * is the primitive and the file form delegates to it.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { parse as parseHtml } from 'node-html-parser';

import type { DocumentSourceType } from '../../types/database.ts';
import {
  EXTENSION_TO_SOURCE_TYPE,
  LEGACY_BINARY_FORMATS,
  SUPPORTED_EXTENSIONS,
  fileExtension,
} from './formats.ts';
import {
  StructuredParseError,
  extractCsv,
  extractDocx,
  extractJson,
  extractXlsx,
} from './structured.ts';

export type ExtractErrorCode =
  | 'unsupported_type'
  | 'read_failed'
  | 'parse_failed'
  | 'empty_document';

export class ExtractError extends Error {
  readonly code: ExtractErrorCode;

  constructor(code: ExtractErrorCode, message: string) {
    super(message);
    this.name = 'ExtractError';
    this.code = code;
  }
}

export interface ExtractedDocument {
  /** Document title: first heading where the format has one, else the filename. */
  title: string;
  /** Cleaned plain text. */
  text: string;
  sourceType: DocumentSourceType;
  /** Pages, where the format has them and the parser reported them. */
  pageCount: number | null;
}

// Re-exported so existing importers keep working after the list moved to
// `formats.ts`, which is browser-safe and shared with the client.
export { SUPPORTED_EXTENSIONS };

export function detectSourceType(filePath: string): DocumentSourceType {
  const extension = fileExtension(filePath);
  const type = EXTENSION_TO_SOURCE_TYPE[extension];
  if (type) return type;

  /**
   * A recognised-but-unreadable format is named rather than lumped in with
   * unknown extensions. Someone who uploads a `.doc` has a specific, fixable
   * problem, and "unsupported file type" does not tell them what to do about
   * it while "save it as .docx" does.
   */
  const legacy = LEGACY_BINARY_FORMATS[extension];
  if (legacy) throw new ExtractError('unsupported_type', legacy);

  throw new ExtractError(
    'unsupported_type',
    `Unsupported file type "${extension || filePath}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
  );
}

/**
 * Normalise whitespace without destroying structure.
 *
 * Blank lines are meaningful — the chunker uses them as paragraph boundaries —
 * so runs of them collapse to exactly one rather than disappearing.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // Zero-width and BOM characters, common in PDF and HTML extraction.
    .replace(/[​-‍﻿]/g, '')
    // Trailing spaces would otherwise survive into chunk content.
    .replace(/[ \t]+$/gm, '')
    // Collapse 3+ newlines to a paragraph break.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First markdown H1, else the filename without its extension. */
function markdownTitle(text: string, filePath: string): string {
  const match = /^#\s+(.+)$/m.exec(text);
  const heading = match?.[1]?.trim();
  return heading && heading.length > 0 ? heading : basename(filePath, extname(filePath));
}

async function extractHtml(
  filePath: string,
  buffer: Buffer,
): Promise<{ title: string; text: string }> {
  const root = parseHtml(buffer.toString('utf8'));

  /**
   * Script and style contents are removed before anything else.
   *
   * Two reasons, and the second is the one that matters. They are not prose, so
   * embedding them would fill the index with minified JavaScript. And this is
   * the only point at which script text could enter the system at all — it is
   * discarded here, never evaluated, never returned to a browser, and never
   * stored. Nothing downstream renders HTML; the pipeline handles plain text
   * from this line onward.
   */
  for (const node of root.querySelectorAll('script, style, noscript, iframe, object, embed')) {
    node.remove();
  }

  const titleTag = root.querySelector('title')?.textContent?.trim();
  const h1 = root.querySelector('h1')?.textContent?.trim();

  // Convert headings to markdown so the chunker sees the same structure it
  // sees in a markdown file, rather than a flat wall of text.
  for (let level = 1; level <= 6; level++) {
    for (const node of root.querySelectorAll(`h${level}`)) {
      node.replaceWith(`\n\n${'#'.repeat(level)} ${node.textContent.trim()}\n\n`);
    }
  }
  for (const node of root.querySelectorAll('p, br, li, div, tr')) {
    node.insertAdjacentHTML('afterend', '\n\n');
  }

  const body = root.querySelector('body') ?? root;
  const text = body.textContent ?? '';

  const title = titleTag || h1 || basename(filePath, extname(filePath));
  return { title, text };
}

/**
 * PDF text.
 *
 * WHY unpdf AND NOT pdf-parse
 * ---------------------------
 * `pdf-parse` wraps `pdfjs-dist`, which reaches for browser globals — and the
 * upload failed in the deployed environment with:
 *
 *     Failed to load external module pdf-parse
 *     ReferenceError: DOMMatrix is not defined
 *
 * It was also declared in `serverExternalPackages`, so Next did not bundle it
 * and the runtime had to resolve it from `node_modules` — which is exactly the
 * arrangement that breaks when a serverless build traces files imperfectly, and
 * matches the "failed to load external module" half of that error.
 *
 * The fix is not to polyfill the missing global or to swallow the error, both
 * of which leave a parser that only works where its host happens to cooperate.
 * `unpdf` ships a build of pdfjs prepared for non-browser runtimes with those
 * globals provided internally, so it depends on nothing the host must supply.
 * It bundles cleanly, which is what allowed `pdf-parse` to be dropped from
 * `serverExternalPackages` entirely.
 *
 * It also extracts more cleanly: `pdf-parse` appended a synthetic `-- 1 of 1 --`
 * page footer to the text, which would have been chunked and embedded as if the
 * author had written it.
 */
async function extractPdf(buffer: Buffer): Promise<{ text: string; pageCount: number | null }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: true });

  const text = Array.isArray(result.text) ? result.text.join('\n\n') : (result.text ?? '');
  return {
    text,
    pageCount: typeof result.totalPages === 'number' ? result.totalPages : null,
  };
}

/**
 * Extract from bytes already in memory.
 *
 * `filename` is used only for the source type and as a title fallback; nothing
 * is read from disk. Uploaded bytes never touch the filesystem, and no uploaded
 * file is executed, evaluated or handed to a shell at any point.
 */
export async function extractBuffer(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
  const sourceType = detectSourceType(filename);
  const stem = basename(filename, extname(filename));

  let rawText: string;
  let pageCount: number | null = null;
  // Null means "derive from the cleaned text below". Title extraction must run
  // AFTER cleaning: a UTF-8 BOM — which Windows editors and PowerShell write by
  // default — sits before the first "#", so /^#/ never matches the raw string
  // and every such file would silently fall back to its filename.
  let title: string | null;

  try {
    switch (sourceType) {
      case 'markdown': {
        rawText = buffer.toString('utf8');
        title = null;
        break;
      }
      case 'txt': {
        rawText = buffer.toString('utf8');
        title = stem;
        break;
      }
      case 'html': {
        const extracted = await extractHtml(filename, buffer);
        rawText = extracted.text;
        title = extracted.title;
        break;
      }
      case 'pdf': {
        const extracted = await extractPdf(buffer);
        rawText = extracted.text;
        pageCount = extracted.pageCount;
        title = stem;
        break;
      }
      case 'docx': {
        rawText = extractDocx(buffer).text;
        title = stem;
        break;
      }
      case 'xlsx': {
        rawText = extractXlsx(buffer).text;
        title = stem;
        break;
      }
      case 'csv': {
        rawText = extractCsv(buffer, stem).text;
        title = stem;
        break;
      }
      case 'json': {
        rawText = extractJson(buffer, stem).text;
        title = stem;
        break;
      }
    }
  } catch (caught) {
    if (caught instanceof ExtractError) throw caught;
    /**
     * A parser's own message is surfaced when it is one this codebase wrote —
     * "Encrypted (password-protected) files are not supported", "The file is
     * not valid JSON: Unexpected token }". Those name the user's actual problem
     * and disclose nothing about the server.
     *
     * A third-party parser's message is not forwarded: it can carry absolute
     * paths and internal module names. The format and filename are enough for
     * the user, and the detail goes to the server log instead.
     */
    if (caught instanceof StructuredParseError) {
      throw new ExtractError('parse_failed', caught.message);
    }
    throw new ExtractError(
      'parse_failed',
      `Could not read ${filename}. The file may be corrupted or not a valid ${sourceType.toUpperCase()} file.`,
    );
  }

  const text = cleanText(rawText);
  if (text.length === 0) {
    /**
     * The PDF case gets its own sentence because it has its own cause. A PDF
     * that parsed cleanly and yielded nothing is almost always a scan — pages
     * of images with no text layer — and telling that user to check the file
     * "is not empty" sends them to look at a document that plainly is not.
     * Every other format that reaches here really is empty.
     */
    throw new ExtractError(
      'empty_document',
      sourceType === 'pdf'
        ? `${filename} has no text layer. It is most likely a scan, and needs OCR before it can be indexed.`
        : `${filename} contains no extractable text.`,
    );
  }

  const resolvedTitle = (title ?? markdownTitle(text, filename)).trim();
  return {
    title: resolvedTitle.length > 0 ? resolvedTitle : stem,
    text,
    sourceType,
    pageCount,
  };
}

/**
 * Read a file and return its cleaned text plus a title.
 *
 * Throws rather than returning empty text for an unreadable or empty document —
 * an empty document would otherwise be stored as "ready" with zero chunks and
 * look like a success.
 */
export async function extractDocument(filePath: string): Promise<ExtractedDocument> {
  // Validate the type before reading, so an unsupported file fails fast with
  // the same error whichever entry point was used.
  detectSourceType(filePath);

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (caught) {
    throw new ExtractError(
      'read_failed',
      `Could not read ${filePath}: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }

  return await extractBuffer(buffer, filePath);
}
