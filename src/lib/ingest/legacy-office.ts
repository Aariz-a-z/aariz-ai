/**
 * Word 97–2003 (`.doc`) and Excel 97–2003 (`.xls`) text extraction.
 *
 * Both sit inside the OLE2 compound container that `cfb.ts` reads; this module
 * interprets the streams it hands back. See `cfb.ts` for why the container
 * reader is written here rather than installed — the short version is that no
 * maintained JavaScript library reads these two formats safely, and the
 * candidates were a stale package, a package with unfixed advisories, or
 * shelling out to `antiword`.
 *
 * WHAT "SUPPORTED" MEANS FOR THESE TWO
 * ------------------------------------
 * Text, and text only. No styling, no images, no embedded objects, no macros —
 * and macros in particular are never read, never interpreted and never
 * executed. `.doc` and `.xls` are the classic macro-carrying formats, so it is
 * worth being explicit: this code walks byte ranges and decodes characters. The
 * VBA storage is simply one of the streams it does not look at.
 *
 * These are lossier than the modern formats by nature. A `.docx` states its
 * structure in XML; a `.doc` stores a flat character range plus a piece table,
 * so headers, footnotes and text boxes are interleaved with body text in ways
 * that cannot always be told apart. Body text extracts reliably, which is what
 * retrieval needs.
 */

import { MAX_EXTRACTED_CHARS } from '../limits.ts';
import { CfbError, readCfb } from './cfb.ts';

export class LegacyOfficeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyOfficeError';
  }
}

/** Ceiling on extracted text, matching the structured formats. */
const MAX_CHARS = MAX_EXTRACTED_CHARS;

// =============================================================================
// Shared
// =============================================================================

/**
 * Windows-1252, which is what "compressed" text in a `.doc` actually is.
 *
 * Only the 0x80–0x9F range differs from Latin-1, and it is exactly the range
 * holding the punctuation Word inserts constantly — curly quotes, en and em
 * dashes, the ellipsis. Decoding these as Latin-1 control codes would litter
 * the extracted text with replacement characters at every quotation mark.
 */
const CP1252_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„',
  0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ',
  0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeCp1252(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) {
    out += byte >= 0x80 && byte <= 0x9f ? (CP1252_HIGH[byte] ?? '�') : String.fromCharCode(byte);
  }
  return out;
}

/**
 * Turn Word's in-band control characters into ordinary whitespace.
 *
 * Word stores structure as control codes inside the character stream rather
 * than as markup: 0x07 ends a table cell, 0x0D ends a paragraph, 0x0B is a soft
 * line break, and 0x13–0x15 bracket field instructions such as page numbers and
 * hyperlink targets. Left in place they would be embedded as text; stripped
 * without replacement, words either side of a cell boundary would be glued
 * together into tokens that match nothing.
 */
function normaliseWordControls(text: string): string {
  return text
    // Field instruction runs: 0x13 begin, 0x14 separator, 0x15 end. The
    // instruction between begin and separator is a directive (MERGEFIELD,
    // HYPERLINK), not prose, so the whole span is dropped.
    .replace(/[^]*?/g, '')
    .replace(/[]/g, '')
    // Cell and row ends become a separator so adjacent cells stay distinct.
    .replace(/[]/g, '\t')
    .replace(/[\r]/g, '\n')
    // Embedded objects, drawings and the annotation marks Word leaves behind.
    .replace(/[]/g, '')
    // Non-breaking and optional hyphens read as ordinary characters.
    .replace(/ /g, ' ')
    .replace(//g, '');
}

// =============================================================================
// .doc — Word 97-2003
// =============================================================================

/**
 * Extract the body text of a Word 97–2003 document.
 *
 * The text is NOT one contiguous run. Word stores a piece table (the `Clx` in
 * the table stream) describing where each span of characters lives and whether
 * it is stored one byte per character or two. Reading `fcMin`–`fcMac` directly
 * — the approach that looks obvious — produces correct output only for a
 * document that has never been edited, and mangled output for everything else.
 *
 * Offsets are from MS-DOC and were confirmed against a real Word file before
 * this was written: `fcClx` at 0x01A2 resolved inside the table stream, and the
 * `Clx` there began with the expected `0x02` marker.
 */
export function extractDoc(buffer: Buffer): { text: string } {
  let streams: Map<string, Buffer>;
  try {
    streams = readCfb(buffer).streams;
  } catch (caught) {
    throw new LegacyOfficeError(
      caught instanceof CfbError ? caught.message : 'Could not read the Word document.',
    );
  }

  const wordDocument = streams.get('WordDocument');
  if (!wordDocument || wordDocument.length < 0x1a6 + 4) {
    throw new LegacyOfficeError('Not a valid .doc file (the WordDocument stream is missing).');
  }
  if (wordDocument.readUInt16LE(0) !== 0xa5ec) {
    throw new LegacyOfficeError('Not a valid .doc file (bad document signature).');
  }

  const flags = wordDocument.readUInt16LE(10);
  // Bit 8 marks an encrypted document. Its text is ciphertext, and returning
  // that as "extracted text" would be worse than refusing.
  if ((flags & 0x0100) !== 0) {
    throw new LegacyOfficeError('This .doc file is password-protected and cannot be read.');
  }

  // Bit 9 selects which of the two table streams is current.
  const tableName = (flags >> 9) & 1 ? '1Table' : '0Table';
  const table = streams.get(tableName);
  if (!table) {
    throw new LegacyOfficeError(`Not a valid .doc file (the ${tableName} stream is missing).`);
  }

  const fcClx = wordDocument.readUInt32LE(0x1a2);
  const lcbClx = wordDocument.readUInt32LE(0x1a6);
  if (fcClx + lcbClx > table.length || lcbClx < 5) {
    throw new LegacyOfficeError('The .doc piece table is missing or malformed.');
  }

  const clx = table.subarray(fcClx, fcClx + lcbClx);

  // A Clx is zero or more RgPrc (formatting, marker 0x01) followed by the Pcdt
  // (the piece table, marker 0x02). Skip the formatting runs to reach it.
  let at = 0;
  while (at < clx.length && clx[at] === 0x01) {
    if (at + 3 > clx.length) throw new LegacyOfficeError('The .doc piece table is truncated.');
    at += 1 + 2 + clx.readUInt16LE(at + 1);
  }
  if (at >= clx.length || clx[at] !== 0x02) {
    throw new LegacyOfficeError('The .doc piece table could not be located.');
  }

  const pcdtLength = clx.readUInt32LE(at + 1);
  const plc = clx.subarray(at + 5, at + 5 + pcdtLength);

  // PlcPcd: (n+1) character positions of 4 bytes, then n descriptors of 8.
  const pieceCount = Math.floor((plc.length - 4) / 12);
  if (pieceCount <= 0) throw new LegacyOfficeError('The .doc file contains no text pieces.');

  const cpAt = (index: number): number => plc.readUInt32LE(index * 4);
  const pcdAt = (index: number): number => 4 * (pieceCount + 1) + index * 8;

  let text = '';
  for (let piece = 0; piece < pieceCount && text.length < MAX_CHARS; piece++) {
    const characters = cpAt(piece + 1) - cpAt(piece);
    if (characters <= 0) continue;

    const fcValue = plc.readUInt32LE(pcdAt(piece) + 2);
    // Bit 30 means the span is stored one byte per character in CP1252; the
    // real offset is then the remaining bits halved. Otherwise it is UTF-16LE
    // at the offset as given.
    const compressed = (fcValue & 0x40000000) !== 0;
    const offset = compressed ? (fcValue & 0x3fffffff) >>> 1 : fcValue;
    const byteLength = compressed ? characters : characters * 2;

    if (offset < 0 || offset + byteLength > wordDocument.length) continue;
    const raw = wordDocument.subarray(offset, offset + byteLength);
    text += compressed ? decodeCp1252(raw) : raw.toString('utf16le');
  }

  const cleaned = normaliseWordControls(text).slice(0, MAX_CHARS);
  if (cleaned.trim().length === 0) {
    throw new LegacyOfficeError('No text could be extracted from this .doc file.');
  }
  return { text: cleaned };
}

// =============================================================================
// .xls — Excel 97-2003
// =============================================================================

/** BIFF record types this reader understands. Everything else is skipped. */
const BIFF = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RK: 0x027e,
  MULRK: 0x00bd,
  NUMBER: 0x0203,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
} as const;

/** An RK value packs a number into 32 bits with two encoding flags. */
function decodeRk(value: number): number {
  const isInteger = (value & 0x02) !== 0;
  const isDivided = (value & 0x01) !== 0;

  let result: number;
  if (isInteger) {
    // Arithmetic shift preserves the sign of a negative integer.
    result = value >> 2;
  } else {
    // The 30 high bits are the top of an IEEE-754 double; the rest is zero.
    const bytes = Buffer.alloc(8);
    bytes.writeInt32LE(0, 0);
    bytes.writeInt32LE(value & 0xfffffffc, 4);
    result = bytes.readDoubleLE(0);
  }
  return isDivided ? result / 100 : result;
}

/**
 * Read one XLUnicodeRichExtendedString, returning its text and total size.
 *
 * The shared-string table is the awkward part of BIFF: a string carries a
 * per-string flag saying whether it is 8-bit or 16-bit, and the table can spill
 * across CONTINUE records at any byte boundary — including in the middle of a
 * string, where the continuation restates the width flag. The SST is therefore
 * concatenated first and parsed as one buffer, which sidesteps splitting in the
 * middle of a character.
 */
function readSstString(data: Buffer, start: number): { text: string; next: number } {
  if (start + 3 > data.length) return { text: '', next: data.length };

  const characters = data.readUInt16LE(start);
  const flags = data.readUInt8(start + 2);
  const wide = (flags & 0x01) !== 0;
  const hasFarEast = (flags & 0x04) !== 0;
  const hasRichText = (flags & 0x08) !== 0;

  let at = start + 3;
  let runCount = 0;
  let farEastSize = 0;
  if (hasRichText) {
    runCount = data.readUInt16LE(at);
    at += 2;
  }
  if (hasFarEast) {
    farEastSize = data.readUInt32LE(at);
    at += 4;
  }

  const byteLength = wide ? characters * 2 : characters;
  if (at + byteLength > data.length) return { text: '', next: data.length };

  const raw = data.subarray(at, at + byteLength);
  const text = wide ? raw.toString('utf16le') : decodeCp1252(raw);

  return { text, next: at + byteLength + runCount * 4 + farEastSize };
}

/**
 * Extract an Excel 97–2003 workbook as readable text.
 *
 * Rendered the same way as `.xlsx`: sheet name, then each row re-joined to the
 * header row above it, for the reason set out at the top of `structured.ts` —
 * a bare grid of values embeds badly, and a row that carries its own column
 * labels survives chunking as a self-contained record.
 */
export function extractXls(buffer: Buffer): { text: string; sheetCount: number } {
  let streams: Map<string, Buffer>;
  try {
    streams = readCfb(buffer).streams;
  } catch (caught) {
    throw new LegacyOfficeError(
      caught instanceof CfbError ? caught.message : 'Could not read the Excel workbook.',
    );
  }

  // "Workbook" is BIFF8 (Excel 97+); "Book" is BIFF5 (Excel 5.0/95).
  const workbook = streams.get('Workbook') ?? streams.get('Book');
  if (!workbook) {
    throw new LegacyOfficeError('Not a valid .xls file (no Workbook stream).');
  }

  // ---- Pass one: records, shared strings, sheet names ---------------------
  const sharedStrings: string[] = [];
  const sheetNames: { name: string; offset: number }[] = [];
  const records: { type: number; data: Buffer; at: number }[] = [];

  let at = 0;
  while (at + 4 <= workbook.length) {
    const type = workbook.readUInt16LE(at);
    const length = workbook.readUInt16LE(at + 2);
    const body = workbook.subarray(at + 4, at + 4 + length);
    if (at + 4 + length > workbook.length) break;

    records.push({ type, data: body, at });

    if (type === BIFF.BOUNDSHEET && body.length >= 8) {
      const nameLength = body.readUInt8(6);
      const wide = (body.readUInt8(7) & 0x01) !== 0;
      const nameBytes = body.subarray(8, 8 + (wide ? nameLength * 2 : nameLength));
      sheetNames.push({
        name: wide ? nameBytes.toString('utf16le') : decodeCp1252(nameBytes),
        offset: body.readUInt32LE(0),
      });
    }

    if (type === BIFF.SST) {
      // Gather this SST and every CONTINUE that follows it, then parse the
      // concatenation — a string may straddle the boundary.
      const parts: Buffer[] = [body];
      let scan = at + 4 + length;
      while (scan + 4 <= workbook.length && workbook.readUInt16LE(scan) === BIFF.CONTINUE) {
        const continueLength = workbook.readUInt16LE(scan + 2);
        parts.push(workbook.subarray(scan + 4, scan + 4 + continueLength));
        scan += 4 + continueLength;
      }
      const sst = Buffer.concat(parts);
      const unique = sst.length >= 8 ? sst.readUInt32LE(4) : 0;
      let cursor = 8;
      for (let i = 0; i < unique && cursor < sst.length; i++) {
        const { text, next } = readSstString(sst, cursor);
        sharedStrings.push(text);
        if (next <= cursor) break;
        cursor = next;
      }
    }

    at += 4 + length;
  }

  if (sheetNames.length === 0) {
    throw new LegacyOfficeError('The workbook contains no readable worksheets.');
  }

  // ---- Pass two: cells, grouped by the sheet they belong to ---------------
  // BOUNDSHEET records carry each sheet's byte offset, so a record belongs to
  // the last sheet whose offset it follows.
  const grids = sheetNames.map(() => new Map<number, Map<number, string>>());

  const sheetIndexFor = (offset: number): number => {
    let index = -1;
    for (let i = 0; i < sheetNames.length; i++) {
      if (offset >= sheetNames[i].offset) index = i;
    }
    return index;
  };

  const put = (sheet: number, row: number, column: number, value: string): void => {
    if (sheet < 0 || value.length === 0) return;
    const grid = grids[sheet];
    if (!grid.has(row)) grid.set(row, new Map());
    grid.get(row)!.set(column, value);
  };

  for (const record of records) {
    const { type, data } = record;
    if (data.length < 4) continue;
    const sheet = sheetIndexFor(record.at);
    const row = data.readUInt16LE(0);
    const column = data.readUInt16LE(2);

    switch (type) {
      case BIFF.LABELSST: {
        if (data.length < 10) break;
        const index = data.readUInt32LE(6);
        put(sheet, row, column, sharedStrings[index] ?? '');
        break;
      }
      case BIFF.LABEL: {
        if (data.length < 8) break;
        const characters = data.readUInt16LE(6);
        const wide = data.length > 8 && (data.readUInt8(8) & 0x01) !== 0;
        const bytes = data.subarray(9, 9 + (wide ? characters * 2 : characters));
        put(sheet, row, column, wide ? bytes.toString('utf16le') : decodeCp1252(bytes));
        break;
      }
      case BIFF.RK: {
        if (data.length < 10) break;
        put(sheet, row, column, String(decodeRk(data.readInt32LE(6))));
        break;
      }
      case BIFF.MULRK: {
        // One record covering a run of columns, each 6 bytes: 2 XF + 4 RK.
        const last = data.readUInt16LE(data.length - 2);
        for (let i = 0; column + i <= last; i++) {
          const offset = 4 + i * 6;
          if (offset + 6 > data.length - 2) break;
          put(sheet, row, column + i, String(decodeRk(data.readInt32LE(offset + 2))));
        }
        break;
      }
      case BIFF.NUMBER: {
        if (data.length < 14) break;
        put(sheet, row, column, String(data.readDoubleLE(6)));
        break;
      }
      case BIFF.BOOLERR: {
        if (data.length < 8) break;
        // Byte 7 distinguishes a boolean from an error code; errors are skipped
        // because "#REF!" is not content worth embedding.
        if (data.readUInt8(7) === 0) put(sheet, row, column, data.readUInt8(6) ? 'TRUE' : 'FALSE');
        break;
      }
      default:
        break;
    }
  }

  // ---- Render -------------------------------------------------------------
  const sections: string[] = [];
  for (const [index, sheet] of sheetNames.entries()) {
    const grid = grids[index];
    if (grid.size === 0) continue;

    const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
    const rows: string[][] = rowNumbers.map((rowNumber) => {
      const cells = grid.get(rowNumber)!;
      const widest = Math.max(...cells.keys());
      const out: string[] = [];
      for (let column = 0; column <= widest; column++) out.push(cells.get(column) ?? '');
      return out;
    });

    sections.push(renderGrid(sheet.name, rows));
  }

  if (sections.length === 0) {
    throw new LegacyOfficeError('No cell values could be read from this .xls file.');
  }

  return { text: sections.join('\n\n').slice(0, MAX_CHARS), sheetCount: sections.length };
}

/**
 * Header-joined rendering, matching `structured.ts`'s `renderTable`.
 *
 * Duplicated deliberately rather than imported: `structured.ts` owns the ZIP
 * formats and this module owns the OLE2 ones, and a shared private helper
 * between them would couple two readers that have nothing else in common. The
 * OUTPUT SHAPE is what must match, and that is asserted in the verification
 * suite rather than enforced by a shared function.
 */
function renderGrid(title: string, rows: string[][]): string {
  const populated = rows.filter((row) => row.some((cell) => cell.trim().length > 0));
  if (populated.length === 0) return `## ${title}\n\n(empty)`;

  const header = populated[0];
  const usableHeader = populated.length > 1 && header.every((cell) => cell.trim().length > 0);

  const lines: string[] = [`## ${title}`, ''];

  if (!usableHeader) {
    for (const [index, row] of populated.entries()) {
      lines.push(`Row ${index + 1}: ${row.filter((cell) => cell.length > 0).join(' | ')}`);
    }
    return lines.join('\n');
  }

  lines.push(`Columns: ${header.join(', ')}`, '');
  for (let i = 1; i < populated.length; i++) {
    const pairs: string[] = [];
    for (let column = 0; column < header.length; column++) {
      const value = populated[i][column] ?? '';
      if (value.trim().length === 0) continue;
      pairs.push(`${header[column]}: ${value}`);
    }
    if (pairs.length === 0) continue;
    lines.push(`Row ${i + 1}`, ...pairs, '');
  }

  return lines.join('\n').trimEnd();
}
