/**
 * Compound File Binary reader — the container Word 97–2003 and Excel 97–2003 use.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `.docx` and `.xlsx` are ZIP archives of XML, which is why `structured.ts` can
 * read them with a ZIP reader. `.doc` and `.xls` are something else entirely:
 * an OLE2 compound file, which is a FAT-style filesystem inside a single file,
 * holding named binary streams. Nothing about the ZIP reader applies.
 *
 * WHY IT IS WRITTEN HERE RATHER THAN INSTALLED
 * --------------------------------------------
 * There is no maintained pure-JavaScript library for these formats that is safe
 * to point at untrusted uploads. Surveyed before writing this:
 *
 *   - `officeparser` (updated this month, otherwise the obvious choice) does
 *     NOT support `.doc` or `.xls` — only the modern ZIP-based formats.
 *   - `word-extractor` handles `.doc` but was last published in 2022 and does
 *     nothing for `.xls`.
 *   - SheetJS's npm build reads `.xls` and is pinned at 0.18.5 with unfixed
 *     prototype-pollution and ReDoS advisories.
 *   - `textract` shells out to `antiword`/`catdoc`, which means external
 *     binaries — unavailable on serverless, and executing a process over
 *     attacker-supplied bytes is precisely what this codebase must not do.
 *
 * So the choice was a stale dependency, a vulnerable one, a subprocess, or a
 * bounded reader written here. This is the bounded reader: it allocates nothing
 * it has not range-checked, follows no chain further than the file can justify,
 * and cannot execute anything.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No writing, no encryption, no 4 GB (version 4) files beyond reading their
 * header. Streams are read, named and handed back as bytes; interpreting them
 * is `legacy-office.ts`'s job.
 */

import { MAX_INFLATED_BYTES } from '../limits.ts';

const SIGNATURE = 'd0cf11e0a1b11ae1';

/** Sector chain terminators. */
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** Sectors a single chain may span before the file is treated as malformed. */
const MAX_CHAIN = 1_000_000;

/**
 * Total bytes all extracted streams may occupy.
 *
 * Shared with the ZIP reader rather than declared here. It was a local
 * `64 * 1024 * 1024`, which was comfortably above the old 10 MB upload ceiling
 * and would have become the BINDING limit if an operator raised
 * MAX_DOCUMENT_SIZE_MB past it — a 100 MB `.doc` failing on a number nobody
 * would have thought to look at. One ceiling, one place.
 */
const MAX_TOTAL_BYTES = MAX_INFLATED_BYTES;

export class CfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfbError';
  }
}

export interface CfbFile {
  /** Streams by name, e.g. "WordDocument", "1Table", "Workbook". */
  streams: Map<string, Buffer>;
}

/**
 * Read an OLE2 compound file and return its streams by name.
 *
 * Directory names are compared case-sensitively as stored, because the names
 * that matter here — `WordDocument`, `1Table`, `0Table`, `Workbook`, `Book` —
 * are written by Microsoft with fixed casing.
 */
export function readCfb(buffer: Buffer): CfbFile {
  if (buffer.length < 512) {
    throw new CfbError('File is too small to be a compound document.');
  }
  if (buffer.subarray(0, 8).toString('hex') !== SIGNATURE) {
    throw new CfbError('Not an OLE2 compound document.');
  }

  const sectorShift = buffer.readUInt16LE(30);
  const miniSectorShift = buffer.readUInt16LE(32);
  if (sectorShift < 7 || sectorShift > 20 || miniSectorShift < 2 || miniSectorShift > sectorShift) {
    throw new CfbError('Compound document header is malformed.');
  }
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;

  const numFatSectors = buffer.readUInt32LE(44);
  const firstDirSector = buffer.readUInt32LE(48);
  const miniCutoff = buffer.readUInt32LE(56);
  const firstMiniFat = buffer.readUInt32LE(60);
  const numMiniFatSectors = buffer.readUInt32LE(64);
  const firstDifat = buffer.readUInt32LE(68);
  const numDifatSectors = buffer.readUInt32LE(72);

  // Sector 0 begins immediately after the 512-byte header, whatever the sector
  // size — the header occupies the first sector only when sectorSize is 512.
  const sectorOffset = (sector: number): number => 512 + sector * sectorSize;

  const readSector = (sector: number): Buffer => {
    const start = sectorOffset(sector);
    const end = start + sectorSize;
    if (start < 0 || end > buffer.length) {
      throw new CfbError(`Compound document references sector ${sector} beyond the file.`);
    }
    return buffer.subarray(start, end);
  };

  // ---- DIFAT: the list of sectors that hold the FAT ------------------------
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    const entry = buffer.readUInt32LE(76 + i * 4);
    if (entry === FREESECT || entry === ENDOFCHAIN) break;
    fatSectors.push(entry);
  }

  // Files with more than 109 FAT sectors continue the DIFAT in its own chain.
  let difatSector = firstDifat;
  let difatGuard = 0;
  while (
    difatSector !== ENDOFCHAIN &&
    difatSector !== FREESECT &&
    difatGuard < numDifatSectors + 1 &&
    fatSectors.length < numFatSectors
  ) {
    const sector = readSector(difatSector);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector && fatSectors.length < numFatSectors; i++) {
      const entry = sector.readUInt32LE(i * 4);
      if (entry === FREESECT || entry === ENDOFCHAIN) break;
      fatSectors.push(entry);
    }
    difatSector = sector.readUInt32LE(sectorSize - 4);
    difatGuard++;
  }

  // ---- FAT ----------------------------------------------------------------
  const fat: number[] = [];
  for (const sector of fatSectors) {
    const data = readSector(sector);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(data.readUInt32LE(i * 4));
  }
  if (fat.length === 0) throw new CfbError('Compound document has no allocation table.');

  /** Follow a sector chain, bounded so a cycle cannot hang the process. */
  const chain = (start: number): number[] => {
    const sectors: number[] = [];
    let current = start;
    while (current !== ENDOFCHAIN && current !== FREESECT && sectors.length < MAX_CHAIN) {
      if (current < 0 || current >= fat.length) {
        throw new CfbError('Compound document allocation table is malformed.');
      }
      sectors.push(current);
      current = fat[current];
    }
    return sectors;
  };

  const readChain = (start: number, size: number): Buffer => {
    const parts = chain(start).map(readSector);
    return Buffer.concat(parts).subarray(0, size);
  };

  // ---- Directory ----------------------------------------------------------
  const directory = Buffer.concat(chain(firstDirSector).map(readSector));
  const entryCount = Math.floor(directory.length / 128);

  interface Entry {
    name: string;
    type: number;
    start: number;
    size: number;
  }
  const entries: Entry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const at = i * 128;
    const nameLength = directory.readUInt16LE(at + 64);
    // The stored length counts the UTF-16 terminator; drop it.
    const name =
      nameLength > 2
        ? directory.subarray(at, at + nameLength - 2).toString('utf16le')
        : '';
    entries.push({
      name,
      type: directory.readUInt8(at + 66),
      start: directory.readUInt32LE(at + 116),
      // Only the low 32 bits are read: a stream above 4 GB cannot be held in a
      // Buffer here anyway, and MAX_TOTAL_BYTES refuses it long before that.
      size: directory.readUInt32LE(at + 120),
    });
  }

  const root = entries.find((entry) => entry.type === 5);
  if (!root) throw new CfbError('Compound document has no root entry.');

  // ---- Mini stream --------------------------------------------------------
  // Streams smaller than the cutoff live inside a container stream owned by the
  // root entry, indexed by its own miniature FAT.
  const miniFat: number[] = [];
  let miniStream: Buffer = Buffer.alloc(0);
  if (root.size > 0 && numMiniFatSectors > 0) {
    const miniFatData = Buffer.concat(chain(firstMiniFat).map(readSector));
    for (let i = 0; i < miniFatData.length / 4; i++) miniFat.push(miniFatData.readUInt32LE(i * 4));
    miniStream = readChain(root.start, root.size);
  }

  const readMini = (start: number, size: number): Buffer => {
    const parts: Buffer[] = [];
    let current = start;
    let guard = 0;
    while (current !== ENDOFCHAIN && current !== FREESECT && guard < MAX_CHAIN) {
      if (current < 0 || current >= miniFat.length) break;
      const offset = current * miniSectorSize;
      if (offset + miniSectorSize > miniStream.length) break;
      parts.push(miniStream.subarray(offset, offset + miniSectorSize));
      current = miniFat[current];
      guard++;
    }
    return Buffer.concat(parts).subarray(0, size);
  };

  // ---- Streams ------------------------------------------------------------
  const streams = new Map<string, Buffer>();
  let total = 0;
  for (const entry of entries) {
    // Type 2 is a stream; 1 is a storage (directory) and 5 the root.
    if (entry.type !== 2 || entry.size === 0) continue;

    total += entry.size;
    if (total > MAX_TOTAL_BYTES) {
      throw new CfbError('Compound document holds more data than this app will process.');
    }

    const data =
      entry.size < miniCutoff ? readMini(entry.start, entry.size) : readChain(entry.start, entry.size);
    streams.set(entry.name, data);
  }

  return { streams };
}
