/**
 * Real files for the document verification suite, built in memory.
 *
 * WHY THESE ARE GENERATED RATHER THAN COMMITTED
 * ---------------------------------------------
 * A binary fixture checked into the repository is a file nobody can review in a
 * diff. When one of these breaks, the question is always "is the parser wrong or
 * is the fixture wrong?", and a committed blob cannot answer it. Generated
 * fixtures are readable as code: the exact bytes are visible above the test that
 * consumes them.
 *
 * They are also genuinely valid — a hand-built ZIP with correct CRCs and a PDF
 * with a computed xref table, not a renamed text file. A fixture that only looks
 * like a PDF would prove nothing about a PDF parser.
 *
 * The corrupt variants matter just as much. Malformed-input handling is the part
 * of an extraction layer most likely to be wrong and least likely to be
 * exercised by hand, so each format has a deliberately broken twin.
 */

import { crc32 } from 'node:zlib';

const NL = String.fromCharCode(10);

// =============================================================================
// ZIP writer (stored, no compression)
// =============================================================================

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Build a ZIP archive with stored (uncompressed) entries.
 *
 * Compression is pointless for fixtures and stored entries keep the bytes
 * inspectable, but the headers, CRCs and central directory are all real — the
 * reader under test does no less work than it would on a file from Word.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed
    local.writeUInt32LE(size, 22); // uncompressed
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// =============================================================================
// DOCX
// =============================================================================

const CONTENT_TYPES_DOCX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const ROOT_RELS_DOCX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

function wordParagraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function wordTable(rows: string[][]): string {
  const body = rows
    .map(
      (row) =>
        '<w:tr>' +
        row.map((cell) => `<w:tc>${wordParagraph(cell)}</w:tc>`).join('') +
        '</w:tr>',
    )
    .join('');
  return `<w:tbl>${body}</w:tbl>`;
}

/** A .docx containing paragraphs and, optionally, a real table. */
export function buildDocx(paragraphs: string[], table?: string[][]): Buffer {
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map(wordParagraph).join('') +
    (table ? wordTable(table) : '') +
    '</w:body></w:document>';

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_DOCX, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_DOCX, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

// =============================================================================
// XLSX
// =============================================================================

const CONTENT_TYPES_XLSX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
  '</Types>';

const ROOT_RELS_XLSX =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

/** "A", "B" ... "AA". Mirrors the column naming the reader has to invert. */
function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export interface SheetSpec {
  name: string;
  rows: string[][];
}

/**
 * A .xlsx workbook using a shared-string table, which is what Excel actually
 * writes for text cells — testing against inline strings only would miss the
 * indirection the reader has to follow.
 */
export function buildXlsx(sheets: SheetSpec[]): Buffer {
  const shared: string[] = [];
  const indexOf = (text: string): number => {
    const existing = shared.indexOf(text);
    if (existing !== -1) return existing;
    shared.push(text);
    return shared.length - 1;
  };

  const sheetParts = sheets.map((sheet, sheetIndex) => {
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, columnIndex) => {
            if (value.length === 0) return '';
            const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
            // Numbers are written as numbers, text through the shared table —
            // both paths the reader must handle.
            if (/^-?\d+(\.\d+)?$/.test(value)) {
              return `<c r="${reference}"><v>${value}</v></c>`;
            }
            return `<c r="${reference}" t="s"><v>${indexOf(value)}</v></c>`;
          })
          .join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join('');

    return {
      path: `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      xml:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${rows}</sheetData></worksheet>`,
    };
  });

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map(
        (sheet, index) =>
          `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join('') +
    '</sheets></workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join('') +
    '</Relationships>';

  const sharedStrings =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((text) => `<si><t xml:space="preserve">${xmlEscape(text)}</t></si>`).join('') +
    '</sst>';

  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XLSX, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS_XLSX, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStrings, 'utf8') },
    ...sheetParts.map((part) => ({ name: part.path, data: Buffer.from(part.xml, 'utf8') })),
  ]);
}

// =============================================================================
// PDF
// =============================================================================

/**
 * A single-page PDF with real text operators and a computed xref table.
 *
 * Uncompressed on purpose: the bytes stay legible, and a text-extraction parser
 * has exactly as much work to do either way.
 */
export function buildPdf(lines: string[]): Buffer {
  // Parentheses delimit PDF strings; dropping them avoids an escaping rule the
  // fixtures do not need to exercise.
  const safe = lines.map((line) => line.replace(/[()\\]/g, ''));
  const content =
    'BT' + NL + '/F1 12 Tf' + NL +
    safe
      .map((line, index) => `1 0 0 1 72 ${720 - index * 18} Tm (${line}) Tj`)
      .join(NL) +
    NL + 'ET' + NL;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>${NL}stream${NL}${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4' + NL;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj${NL}${body}${NL}endobj${NL}`;
  });

  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref${NL}0 ${objects.length + 1}${NL}0000000000 65535 f ${NL}`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n ${NL}`;
  pdf +=
    `trailer${NL}<< /Size ${objects.length + 1} /Root 1 0 R >>${NL}` +
    `startxref${NL}${xrefAt}${NL}%%EOF${NL}`;

  return Buffer.from(pdf, 'latin1');
}

// =============================================================================
// Deliberately broken variants
// =============================================================================

/**
 * Files that are the right shape and the wrong content.
 *
 * Each keeps the magic bytes of its format so that type detection succeeds and
 * the failure lands in the PARSER — which is the code path under test. A file
 * of random bytes would be rejected earlier and prove nothing.
 */
export const corrupt = {
  /** Valid PDF header, then garbage where the object graph should be. */
  pdf: (): Buffer =>
    Buffer.concat([
      Buffer.from('%PDF-1.4' + NL, 'latin1'),
      Buffer.from('1 0 obj << /Type /Catalog /Pages 9 9 R >> endobj' + NL, 'latin1'),
      Buffer.from('trailer << /Root 1 0 R >>' + NL + 'startxref' + NL + '999999' + NL + '%%EOF', 'latin1'),
    ]),

  /** A real ZIP that is not a Word document — no word/document.xml. */
  docx: (): Buffer =>
    buildZip([{ name: 'not-a-document.txt', data: Buffer.from('this is not a docx', 'utf8') }]),

  /** A real ZIP that is not a workbook — no xl/workbook.xml. */
  xlsx: (): Buffer =>
    buildZip([{ name: 'random.xml', data: Buffer.from('<nothing/>', 'utf8') }]),

  /** Syntactically invalid JSON. */
  json: (): Buffer => Buffer.from('{ "name": "Aariz", "role": }', 'utf8'),

  /** ZIP magic bytes followed by truncated garbage. */
  truncatedZip: (): Buffer => Buffer.from('PK' + String.fromCharCode(3, 4) + 'broken', 'latin1'),
};
