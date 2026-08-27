/**
 * The single source of truth for which file formats this application accepts.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The accepted-format list used to be written down three times, and the three
 * copies did not agree. Measured before this change:
 *
 *   - `documents-client.ts`  offered 9 extensions in the file picker
 *   - `documents.ts`         accepted 3 at the upload route (.pdf .docx .txt)
 *   - `extract.ts`           could parse 9
 *
 * So the picker let a user select a `.md` file that the upload endpoint then
 * refused with a 415 — a format the extractor was perfectly capable of reading.
 * Nobody had lied; the lists had simply drifted, which is what separate lists
 * do. There is now one list and everything derives from it.
 *
 * WHY IT IS SAFE TO IMPORT FROM THE BROWSER
 * -----------------------------------------
 * This file imports nothing. No `node:fs`, no `node:path`, no parser. That is
 * the property that lets the client bundle share the real list instead of
 * keeping a hand-copied one, and it is worth preserving — the moment this
 * module imports a Node built-in, `documents-client.ts` can no longer use it
 * and the drift starts again.
 */

import type { DocumentSourceType } from '../../types/database.ts';

/**
 * Extension to source type. The order here is the order the UI lists them in,
 * grouped by what a person would recognise rather than alphabetically.
 */
export const EXTENSION_TO_SOURCE_TYPE: Record<string, DocumentSourceType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'doc',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
  '.csv': 'csv',
  '.json': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.txt': 'txt',
  '.text': 'txt',
  '.html': 'html',
  '.htm': 'html',
};

/**
 * Every extension the pipeline can genuinely read, end to end.
 *
 * "Genuinely" is the operative word: an entry here is a promise that upload,
 * extraction, chunking, embedding and retrieval all work for that format. The
 * verification suite proves each one against a real file rather than trusting
 * this list.
 */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_TO_SOURCE_TYPE);

/**
 * Formats that are recognised and deliberately refused.
 *
 * EMPTY, and kept rather than deleted.
 *
 * `.doc` and `.xls` lived here until an OLE2 compound-file reader was written
 * for them (`cfb.ts` and `legacy-office.ts`), so this is no longer the list of
 * legacy Office formats — it is the mechanism for refusing ANY format by name
 * with advice instead of a bare "unsupported type". The next format that needs
 * that treatment adds one line here rather than re-deriving the plumbing.
 *
 * An entry here wins over the generic "unsupported file type" message, so use
 * it whenever a format is common enough that a user will reasonably try it and
 * there is something specific worth telling them.
 */
export const LEGACY_BINARY_FORMATS: Record<string, string> = {};

/**
 * MIME types a browser may report for the formats above.
 *
 * Advisory only, and that is a deliberate security decision rather than
 * laziness. `Content-Type` on a multipart part is supplied by the client and a
 * caller can set it to anything; Windows also reports `application/json` for
 * `.json` in some browsers and `text/plain` in others, and CSV arrives as at
 * least four different types in the wild. Validating on it would reject honest
 * uploads while stopping no attacker.
 *
 * The extension decides which parser runs, and the parser is the real check:
 * every one of them either produces text from bytes it understands or throws.
 * A `.pdf` full of ZIP bytes fails in the PDF parser, whatever it claimed to be.
 */
export const EXTENSION_TO_MIME: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.doc': ['application/msword'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls': ['application/vnd.ms-excel'],
  '.csv': ['text/csv', 'application/csv', 'text/plain'],
  '.json': ['application/json', 'text/json', 'text/plain'],
  '.md': ['text/markdown', 'text/plain'],
  '.markdown': ['text/markdown', 'text/plain'],
  '.mdx': ['text/markdown', 'text/plain'],
  '.txt': ['text/plain'],
  '.text': ['text/plain'],
  '.html': ['text/html'],
  '.htm': ['text/html'],
};

/**
 * Lower-cased extension including the dot, or '' when there is none.
 *
 * Deliberately not `node:path`'s `extname`: this module must stay importable
 * from the browser. The last-dot rule matches `extname` for every name that
 * reaches it, including `archive.tar.gz` (`.gz`) and dotfiles like `.env`,
 * which correctly yield no extension rather than `.env`.
 */
export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // dot <= 0 covers both "no dot at all" and a leading-dot name with no
  // extension, e.g. ".gitignore".
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** For a file input's `accept` attribute. */
export const ACCEPT_ATTRIBUTE = SUPPORTED_EXTENSIONS.join(',');

/**
 * Groups for the UI, so the list reads like something a person recognises
 * rather than twelve extensions in a row.
 */
export const FORMAT_GROUPS: { label: string; extensions: string[] }[] = [
  { label: 'Documents', extensions: ['.pdf', '.docx', '.doc'] },
  { label: 'Spreadsheets & data', extensions: ['.xlsx', '.xls', '.csv', '.json'] },
  { label: 'Text & markup', extensions: ['.md', '.markdown', '.mdx', '.txt', '.text', '.html', '.htm'] },
];

/** One short line naming what can be uploaded, for help text and errors. */
export function describeSupportedFormats(): string {
  return FORMAT_GROUPS.map((group) => `${group.label}: ${group.extensions.join(' ')}`).join(' · ');
}
