/**
 * Text extraction and cleaning — the first two stages of the Level 6 pipeline:
 *
 *     file -> extract text -> clean text -> ...
 *
 * Supports the four source types ROADMAP.md requires — Markdown, TXT, PDF,
 * HTML — plus DOCX, added for per-user uploads.
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

export type ExtractErrorCode = 'unsupported_type' | 'read_failed' | 'parse_failed' | 'empty_document';

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

const EXTENSION_TO_SOURCE_TYPE: Record<string, DocumentSourceType> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.txt': 'txt',
  '.text': 'txt',
  '.pdf': 'pdf',
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
};

/** File extensions the pipeline will pick up when walking a directory. */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_TO_SOURCE_TYPE);

export function detectSourceType(filePath: string): DocumentSourceType {
  const type = EXTENSION_TO_SOURCE_TYPE[extname(filePath).toLowerCase()];
  if (!type) {
    throw new ExtractError(
      'unsupported_type',
      `Unsupported file type "${extname(filePath)}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    );
  }
  return type;
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

async function extractHtml(filePath: string, buffer: Buffer): Promise<{ title: string; text: string }> {
  const root = parseHtml(buffer.toString('utf8'));

  // Script and style contents are not prose and would otherwise be embedded.
  for (const node of root.querySelectorAll('script, style, noscript')) {
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
  for (const node of root.querySelectorAll('p, br, li, div')) {
    node.insertAdjacentHTML('afterend', '\n\n');
  }

  const body = root.querySelector('body') ?? root;
  const text = body.textContent ?? '';

  const title = titleTag || h1 || basename(filePath, extname(filePath));
  return { title, text };
}

/**
 * DOCX text.
 *
 * `extractRawText` rather than `convertToHtml`: the chunker wants prose, and
 * round-tripping through HTML would only add markup for it to strip again.
 * Imported dynamically so the CLI paths that never touch DOCX do not pay to
 * load it.
 */
async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? '';
}

async function extractPdf(buffer: Buffer): Promise<{ text: string; pageCount: number | null }> {
  // pdf-parse v2 exports a PDFParse class; the v1 default-function API is gone.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    // Page count is best-effort: it is surfaced in the document list only, and
    // the field name is not part of pdf-parse's documented contract, so a
    // missing value degrades to null rather than failing the upload.
    const raw = result as unknown as { total?: unknown; pages?: unknown };
    const pageCount =
      typeof raw.total === 'number'
        ? raw.total
        : Array.isArray(raw.pages)
          ? raw.pages.length
          : null;
    return { text: result.text ?? '', pageCount };
  } finally {
    await parser.destroy();
  }
}

/**
 * Read a file and return its cleaned text plus a title.
 *
 * Throws rather than returning empty text for an unreadable or empty document —
 * an empty document would otherwise be stored as "ready" with zero chunks and
 * look like a success.
 */
/**
 * Extract from bytes already in memory.
 *
 * `filename` is used only for the source type and as a title fallback; nothing
 * is read from disk. Uploaded bytes never touch the filesystem.
 */
export async function extractBuffer(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedDocument> {
  const sourceType = detectSourceType(filename);

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
        title = basename(filename, extname(filename));
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
        title = basename(filename, extname(filename));
        break;
      }
      case 'docx': {
        rawText = await extractDocx(buffer);
        title = basename(filename, extname(filename));
        break;
      }
    }
  } catch (caught) {
    if (caught instanceof ExtractError) throw caught;
    throw new ExtractError(
      'parse_failed',
      `Could not parse ${sourceType} file ${filename}: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }

  const text = cleanText(rawText);
  if (text.length === 0) {
    throw new ExtractError('empty_document', `${filename} contains no extractable text.`);
  }

  const resolvedTitle = (title ?? markdownTitle(text, filename)).trim();
  return {
    title: resolvedTitle.length > 0 ? resolvedTitle : basename(filename, extname(filename)),
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
