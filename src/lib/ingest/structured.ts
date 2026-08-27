/**
 * Structured formats — XLSX, CSV and JSON — rendered as prose the chunker and
 * the embedding model can actually use.
 *
 * WHY RENDERING MATTERS MORE THAN PARSING HERE
 * --------------------------------------------
 * The parsing is the easy half. The half that decides whether retrieval works
 * is what the text looks like afterwards, because that text is what gets
 * embedded and what the model finally reads.
 *
 * A CSV dumped back out as CSV embeds terribly. `Aariz,21,AI Engineer` shares
 * no vocabulary with the question "what is Aariz's role?" — the word "role"
 * appears once, in a header row that lands in a different chunk from the data
 * row, and the association between the two is spatial, which an embedding does
 * not see. Every row is re-joined to its header instead:
 *
 *     Name: Aariz
 *     Age: 21
 *     Role: AI Engineer
 *
 * Now the row carries its own labels, survives chunking on its own, and matches
 * the question lexically as well as semantically. The same reasoning drives the
 * sheet-name and row-number prefixes on spreadsheets and the indented outline
 * for JSON: a value is worth little without the key that names it.
 *
 * WHY THERE IS NO SPREADSHEET DEPENDENCY
 * --------------------------------------
 * XLSX is a ZIP of XML, so it needs a ZIP reader and an XML reader — both
 * small, and both below. The two obvious packages were considered and rejected:
 * SheetJS's npm build is pinned at 0.18.5 with unfixed prototype-pollution and
 * ReDoS advisories, which is the wrong thing to point at untrusted uploads;
 * ExcelJS pulls nine transitive dependencies including an archive WRITER and an
 * unzipper, none of which this read-only path needs. A purpose-built reader is
 * smaller, auditable, and has no attack surface beyond what is written here.
 */

import { inflateRawSync } from 'node:zlib';

/**
 * Ceiling on rendered text from one file.
 *
 * Uploads are capped at 10 MB, but expansion is the risk, not input size: a
 * dense 10 MB CSV re-rendered with its headers on every row can multiply
 * several times over, and every character of it is chunked and embedded at
 * cost. Truncation is announced in the text rather than done silently, so a
 * user asking about the tail of a huge sheet finds out why it is missing.
 */
const MAX_RENDERED_CHARS = 2_000_000;

/** Total bytes a single archive may inflate to. Bounds a zip bomb. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export class StructuredParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredParseError';
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_RENDERED_CHARS) return text;
  return (
    text.slice(0, MAX_RENDERED_CHARS) +
    `\n\n[Truncated: this file produced more than ${MAX_RENDERED_CHARS.toLocaleString('en-US')} characters of text. Earlier content is indexed; the remainder was not.]`
  );
}

// =============================================================================
// ZIP
// =============================================================================

/**
 * The entries of a ZIP archive, by name.
 *
 * Only what XLSX needs: the central directory is walked, stored and deflated
 * entries are supported, and everything else is refused rather than guessed at.
 * Encrypted entries, Zip64 and the exotic compression methods all surface as an
 * error — a document that cannot be read must say so, not come back empty.
 */
function readZip(buffer: Buffer): Map<string, Buffer> {
  // The End of Central Directory record sits at the end, after a comment of up
  // to 65535 bytes, so it is found by scanning backwards for its signature.
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const lowest = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new StructuredParseError('Not a valid ZIP archive (no end-of-central-directory record).');
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    throw new StructuredParseError('Zip64 archives are not supported.');
  }
  if (cdOffset >= buffer.length) {
    throw new StructuredParseError('ZIP central directory offset is outside the file.');
  }

  const entries = new Map<string, Buffer>();
  let inflatedTotal = 0;
  let cursor = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new StructuredParseError('ZIP central directory is malformed.');
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    cursor += 46 + nameLength + extraLength + commentLength;

    // Bit 0 is the encryption flag. An encrypted entry cannot be read, and
    // returning its ciphertext as "text" would be worse than failing.
    if ((flags & 0x1) !== 0) {
      throw new StructuredParseError('Encrypted (password-protected) files are not supported.');
    }
    // Directory entries carry no data.
    if (name.endsWith('/')) continue;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new StructuredParseError(`ZIP entry "${name}" has a malformed local header.`);
    }
    // The local header repeats the name and extra fields, and its lengths are
    // the authoritative ones for locating the data — they can legitimately
    // differ from the central directory's.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > buffer.length) {
      throw new StructuredParseError(`ZIP entry "${name}" is truncated.`);
    }

    const raw = buffer.subarray(dataStart, dataEnd);
    let content: Buffer;
    if (method === 0) {
      content = Buffer.from(raw);
    } else if (method === 8) {
      try {
        content = inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES - inflatedTotal });
      } catch {
        throw new StructuredParseError(`ZIP entry "${name}" could not be decompressed.`);
      }
    } else {
      throw new StructuredParseError(`ZIP compression method ${method} is not supported.`);
    }

    inflatedTotal += content.length;
    if (inflatedTotal > MAX_INFLATED_BYTES) {
      throw new StructuredParseError('Archive expands to more data than this app will process.');
    }
    entries.set(name, content);
  }

  return entries;
}

// =============================================================================
// XML
// =============================================================================

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode the five XML entities plus numeric references. */
function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/**
 * Every `<tag ...>...</tag>` block at any depth, as [attributes, innerXml].
 *
 * A regex rather than an XML DOM, and deliberately: Office XML is machine
 * generated and rigidly structured, the shapes needed here are two levels deep,
 * and the alternative was an HTML parser whose void-element and tag-lowercasing
 * rules do not apply to this grammar. Self-closing tags are matched too, since
 * an empty spreadsheet cell is written `<c r="B2"/>`.
 */
function* xmlBlocks(xml: string, tag: string): Generator<{ attrs: string; inner: string }> {
  const pattern = new RegExp(`<${tag}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    yield { attrs: match[1] ?? '', inner: match[2] ?? '' };
  }
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match ? decodeXml(match[1]) : null;
}

/** Concatenated text of every `<t>` element, which is how Office stores runs. */
function textRuns(xml: string): string {
  let out = '';
  for (const run of xmlBlocks(xml, 't')) out += decodeXml(run.inner);
  return out;
}

// =============================================================================
// XLSX
// =============================================================================

/** "BC" -> 55. Spreadsheet columns are base-26 with no zero. */
function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1] ?? '';
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Extract an XLSX workbook as readable text, one section per worksheet.
 *
 * The first row of each sheet is treated as a header row and re-attached to
 * every data row below it — see the note at the top of this file for why that
 * decision is what makes a spreadsheet retrievable at all. A sheet whose first
 * row is empty, or which has only one row, is emitted as plain cell values
 * rather than inventing labels that were never there.
 */
export function extractXlsx(buffer: Buffer): { text: string; sheetCount: number } {
  const zip = readZip(buffer);

  const workbookXml = zip.get('xl/workbook.xml');
  if (!workbookXml) {
    throw new StructuredParseError('Not a valid .xlsx workbook (xl/workbook.xml is missing).');
  }

  // Shared strings are optional — a workbook of only numbers has none.
  const sharedStrings: string[] = [];
  const sharedXml = zip.get('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const item of xmlBlocks(sharedXml.toString('utf8'), 'si')) {
      sharedStrings.push(textRuns(item.inner));
    }
  }

  // rId -> worksheet path, so sheets can be matched to their names in order.
  const relations = new Map<string, string>();
  const relsXml = zip.get('xl/_rels/workbook.xml.rels');
  if (relsXml) {
    for (const rel of xmlBlocks(relsXml.toString('utf8'), 'Relationship')) {
      const id = attr(rel.attrs, 'Id');
      const target = attr(rel.attrs, 'Target');
      if (id && target) relations.set(id, target.replace(/^\/?(xl\/)?/, ''));
    }
  }

  const sections: string[] = [];
  let sheetCount = 0;

  for (const sheet of xmlBlocks(workbookXml.toString('utf8'), 'sheet')) {
    const name = attr(sheet.attrs, 'name') ?? `Sheet ${sheetCount + 1}`;
    const relId = attr(sheet.attrs, 'r:id') ?? attr(sheet.attrs, 'id');
    const target = relId ? relations.get(relId) : undefined;

    const sheetXml =
      (target ? zip.get(`xl/${target}`) : undefined) ??
      zip.get(`xl/worksheets/sheet${sheetCount + 1}.xml`);
    if (!sheetXml) continue;

    sheetCount++;
    const rows = readSheetRows(sheetXml.toString('utf8'), sharedStrings);
    sections.push(renderTable(name, rows));
  }

  if (sheetCount === 0) {
    throw new StructuredParseError('The workbook contains no readable worksheets.');
  }

  return { text: truncate(sections.join('\n\n')), sheetCount };
}

/** One sheet's cells as a dense row/column grid of strings. */
function readSheetRows(sheetXml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];

  for (const row of xmlBlocks(sheetXml, 'row')) {
    const cells: string[] = [];
    let column = 0;

    for (const cell of xmlBlocks(row.inner, 'c')) {
      const reference = attr(cell.attrs, 'r');
      // Blank cells are omitted from the XML entirely, so position comes from
      // the cell reference. Without this, a gap silently shifts every value in
      // the row one column left and re-labels the whole row.
      if (reference) {
        const index = columnIndex(reference);
        while (cells.length < index) cells.push('');
        column = index;
      } else {
        while (cells.length < column) cells.push('');
      }

      const type = attr(cell.attrs, 't');
      let value = '';
      if (type === 's') {
        const index = Number.parseInt(xmlBlocks(cell.inner, 'v').next().value?.inner ?? '', 10);
        value = Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textRuns(cell.inner);
      } else {
        const raw = xmlBlocks(cell.inner, 'v').next().value?.inner;
        value = raw === undefined ? '' : decodeXml(raw);
        if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
      }

      cells.push(value.trim());
      column = cells.length;
    }

    rows.push(cells);
  }

  return rows;
}

// =============================================================================
// Tabular rendering, shared by XLSX and CSV
// =============================================================================

/**
 * Render a grid as labelled records.
 *
 * `title` names the sheet or the file so a chunk lifted out of the middle of a
 * large workbook still says what it came from — which is also what makes the
 * citation back to it meaningful.
 */
function renderTable(title: string, rows: string[][]): string {
  const populated = rows.filter((row) => row.some((cell) => cell.length > 0));
  if (populated.length === 0) return `## ${title}\n\n(empty)`;

  const header = populated[0];
  const usableHeader =
    populated.length > 1 && header.every((cell) => cell.length > 0) && header.length > 0;

  const lines: string[] = [`## ${title}`, ''];

  if (!usableHeader) {
    // No header to attach, so values are emitted plainly rather than labelled
    // with a guess.
    for (const [index, row] of populated.entries()) {
      lines.push(`Row ${index + 1}: ${row.filter((c) => c.length > 0).join(' | ')}`);
    }
    return lines.join('\n');
  }

  lines.push(`Columns: ${header.join(', ')}`, '');

  for (let i = 1; i < populated.length; i++) {
    const row = populated[i];
    const pairs: string[] = [];
    for (let column = 0; column < header.length; column++) {
      const value = row[column] ?? '';
      if (value.length === 0) continue;
      pairs.push(`${header[column]}: ${value}`);
    }
    // A row whose cells are all blank carries nothing worth embedding.
    if (pairs.length === 0) continue;
    lines.push(`Row ${i + 1}`, ...pairs, '');
  }

  return lines.join('\n').trimEnd();
}

// =============================================================================
// DOCX
// =============================================================================

/**
 * Find balanced `<tag>...</tag>` spans, tracking depth.
 *
 * A non-greedy regex would stop at the first closing tag and truncate a table
 * nested inside a table cell — legal in Word and not especially rare. Counting
 * opens and closes costs a few lines and removes the whole class of bug.
 */
function findSpans(xml: string, tag: string): { start: number; end: number; inner: string }[] {
  const token = new RegExp(`<${tag}(?:\\s[^>]*?)?(/)?>|</${tag}>`, 'g');
  const spans: { start: number; end: number; inner: string }[] = [];
  let depth = 0;
  let openedAt = -1;
  let innerFrom = -1;
  let match: RegExpExecArray | null;

  while ((match = token.exec(xml)) !== null) {
    const isSelfClosing = match[1] === '/';
    const isClose = match[0].startsWith(`</`);

    if (isSelfClosing) {
      // An empty element at depth 0 is a span with no content.
      if (depth === 0) spans.push({ start: match.index, end: token.lastIndex, inner: '' });
      continue;
    }
    if (!isClose) {
      if (depth === 0) {
        openedAt = match.index;
        innerFrom = token.lastIndex;
      }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) {
        spans.push({ start: openedAt, end: token.lastIndex, inner: xml.slice(innerFrom, match.index) });
      }
    }
  }
  return spans;
}

/** Visible text of a run container: `<w:t>` content, with tabs and breaks. */
function wordText(xml: string): string {
  // Field instructions (`<w:instrText>`) are directives like PAGE or HYPERLINK,
  // not prose, and embedding them would put markup into the vector.
  const withoutFields = xml.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '');
  const normalised = withoutFields
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n');

  let out = '';
  for (const run of xmlBlocks(normalised, 'w:t')) out += decodeXml(run.inner);
  return out;
}

/**
 * Extract a DOCX as text, keeping paragraphs and tables in document order.
 *
 * WHY THIS DOES NOT USE MAMMOTH
 * -----------------------------
 * `mammoth.extractRawText` was the previous implementation and it destroys
 * tables. Measured on a three-column staff table, it returns:
 *
 *     Name / Age / Role / Aariz / 21 / AI Engineer / Rhea / 29 / Data Lead
 *
 * — every cell on its own line with no indication of which column it came from.
 * Chunked and embedded, "Aariz" and "AI Engineer" are no longer related to each
 * other or to their headers, so the obvious question ("what is Aariz's role?")
 * cannot be answered from the very document that contains the answer.
 *
 * Tables are therefore routed through the same `renderTable` the spreadsheet
 * and CSV paths use, which re-attaches each cell to its column header. Body
 * children are walked in order so a paragraph introducing a table still sits
 * above it.
 */
export function extractDocx(buffer: Buffer): { text: string; tableCount: number } {
  const zip = readZip(buffer);
  const documentXml = zip.get('word/document.xml');
  if (!documentXml) {
    throw new StructuredParseError('Not a valid .docx file (word/document.xml is missing).');
  }

  const xml = documentXml.toString('utf8');
  const body = findSpans(xml, 'w:body')[0]?.inner ?? xml;

  // Both element types located up front, then merged by position, which is what
  // keeps prose and tables in the order the author wrote them.
  const blocks: { start: number; kind: 'p' | 'tbl'; inner: string }[] = [
    ...findSpans(body, 'w:p').map((span) => ({ start: span.start, kind: 'p' as const, inner: span.inner })),
    ...findSpans(body, 'w:tbl').map((span) => ({ start: span.start, kind: 'tbl' as const, inner: span.inner })),
  ].sort((a, b) => a.start - b.start);

  // A paragraph inside a table is already rendered as part of that table.
  const tableSpans = findSpans(body, 'w:tbl');
  const insideTable = (position: number): boolean =>
    tableSpans.some((span) => position > span.start && position < span.end);

  const parts: string[] = [];
  let tableCount = 0;

  for (const block of blocks) {
    if (block.kind === 'p') {
      if (insideTable(block.start)) continue;
      const text = wordText(block.inner).trim();
      if (text.length > 0) parts.push(text);
      continue;
    }

    tableCount++;
    const rows = findSpans(block.inner, 'w:tr').map((row) =>
      findSpans(row.inner, 'w:tc').map((cell) => wordText(cell.inner).trim().replace(/\s+/g, ' ')),
    );
    if (rows.length > 0) parts.push(renderTable(`Table ${tableCount}`, rows));
  }

  return { text: truncate(parts.join('\n\n')), tableCount };
}

// =============================================================================
// CSV
// =============================================================================

/**
 * RFC 4180 CSV, including quoted fields containing commas, newlines and
 * doubled quotes.
 *
 * Hand-written because splitting on commas is wrong for any file that has ever
 * been near a spreadsheet, and a dependency for eighty lines of state machine
 * is not a trade worth making.
 *
 * The delimiter is detected rather than assumed: European locales export
 * semicolon-separated files with a `.csv` extension and a naive comma split
 * turns every row into one long field.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^﻿/, '');
  const separator = delimiter ?? detectDelimiter(source);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === separator) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // Consume CRLF as one terminator.
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // A file not ending in a newline still has a final record.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.map((entry) => entry.map((cell) => cell.trim()));
}

/** Whichever candidate separator appears most often in the first few lines. */
function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 5).join('\n');
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t', '|']) {
    // Count only outside quotes, approximated by stripping quoted spans first.
    const count = sample.replace(/"[^"]*"/g, '').split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export function extractCsv(buffer: Buffer, title: string): { text: string; rowCount: number } {
  const rows = parseCsv(buffer.toString('utf8'));
  if (rows.length === 0) {
    throw new StructuredParseError('The CSV file contains no rows.');
  }
  return { text: truncate(renderTable(title, rows)), rowCount: rows.length };
}

// =============================================================================
// JSON
// =============================================================================

/**
 * Render parsed JSON as an indented outline.
 *
 * Flattening to `a.b.c: value` was the alternative and it reads badly at depth;
 * an outline keeps a key beside its siblings, which is the relationship a
 * reader — and a retrieval query — actually uses. Arrays of objects get one
 * block each rather than an index-per-line, so a record stays whole through
 * chunking for the same reason a spreadsheet row does.
 */
function renderJson(value: unknown, indent = 0): string[] {
  const pad = '  '.repeat(indent);

  if (value === null) return [`${pad}(null)`];
  if (typeof value !== 'object') return [`${pad}${String(value)}`];

  if (Array.isArray(value)) {
    const lines: string[] = [];
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const block = renderJson(item, indent + 1);
        // Hang the first line off the dash so a record reads as one unit.
        lines.push(`${pad}-`, ...block);
      } else {
        lines.push(`${pad}- ${item === null ? '(null)' : String(item)}`);
      }
    }
    return lines.length > 0 ? lines : [`${pad}(empty list)`];
  }

  const lines: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== null && typeof item === 'object') {
      const nested = renderJson(item, indent + 1);
      const isEmpty =
        (Array.isArray(item) && item.length === 0) ||
        (!Array.isArray(item) && Object.keys(item as object).length === 0);
      if (isEmpty) {
        lines.push(`${pad}${key}: (empty)`);
      } else {
        lines.push(`${pad}${key}:`, ...nested);
      }
    } else {
      lines.push(`${pad}${key}: ${item === null ? '(null)' : String(item)}`);
    }
  }
  return lines.length > 0 ? lines : [`${pad}(empty)`];
}

export function extractJson(buffer: Buffer, title: string): { text: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch (caught) {
    // The parser's message names the byte offset, which is genuinely useful to
    // whoever has to fix the file, and discloses nothing about the server.
    throw new StructuredParseError(
      `The file is not valid JSON: ${caught instanceof Error ? caught.message : 'parse failed'}`,
    );
  }

  const body = renderJson(parsed).join('\n');
  return { text: truncate(`## ${title}\n\n${body}`) };
}
