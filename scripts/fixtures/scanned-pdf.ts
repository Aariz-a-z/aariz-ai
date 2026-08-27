/**
 * A genuinely image-only PDF — the fixture OCR has to be tested against.
 *
 * WHY THIS IS NOT OPTIONAL
 * ------------------------
 * Testing OCR with a PDF that has a text layer proves nothing: the normal
 * extractor reads it, OCR never runs, and the test passes while the feature is
 * broken. The file this builds contains ONE image XObject and no text operators
 * at all — no `BT`, no `Tj`, no `/Font` resource. `unpdf` extracts exactly zero
 * characters from it, which is what forces the OCR path.
 *
 * HOW IT IS BUILT
 * ---------------
 * Characters are drawn as pixels with a 5x7 bitmap font defined below, scaled
 * up, into a grayscale buffer. That buffer is deflated and embedded as a
 * `/DeviceGray` image. No font file, no rasteriser, no canvas library — which
 * matters because a fixture that needed a rendering dependency would be a
 * dependency the application does not otherwise have.
 *
 * The font is deliberately plain and rendered large. The point is to test the
 * OCR PATH, not to benchmark an OCR engine against difficult handwriting.
 */

import { deflateSync } from 'node:zlib';

const NL = String.fromCharCode(10);

/**
 * 5x7 glyphs, one number per row, five significant bits each.
 *
 * Uppercase, digits and a little punctuation is all a fixture needs. Lowercase
 * is deliberately absent: the invented tokens these documents carry are
 * uppercase, and 26 more glyphs would add nothing a test relies on.
 */
const FONT: Record<string, number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ',': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x08],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

export interface ScannedPageOptions {
  /** Pixels per font pixel. Larger renders bigger, more legible text. */
  scale?: number;
  /** Blank margin around the text block, in output pixels. */
  margin?: number;
}

/**
 * Render lines of text into a grayscale pixel buffer.
 *
 * White background, black text — the polarity a scanner produces, and the one
 * every OCR engine expects.
 */
function renderPage(
  lines: string[],
  options: Required<ScannedPageOptions>,
): { pixels: Buffer; width: number; height: number } {
  const { scale, margin } = options;
  const charWidth = (GLYPH_WIDTH + 1) * scale;
  const lineHeight = (GLYPH_HEIGHT + 3) * scale;

  const longest = lines.reduce((max, line) => Math.max(max, line.length), 1);
  const width = margin * 2 + longest * charWidth;
  const height = margin * 2 + lines.length * lineHeight;

  // 0xFF is white; text is painted to 0x00.
  const pixels = Buffer.alloc(width * height, 0xff);

  lines.forEach((line, lineIndex) => {
    const top = margin + lineIndex * lineHeight;
    [...line.toUpperCase()].forEach((char, charIndex) => {
      const glyph = FONT[char] ?? FONT[' '];
      const left = margin + charIndex * charWidth;

      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        const bits = glyph[row];
        for (let column = 0; column < GLYPH_WIDTH; column++) {
          // Bit 4 is the leftmost column of the glyph.
          if ((bits & (1 << (GLYPH_WIDTH - 1 - column))) === 0) continue;

          for (let dy = 0; dy < scale; dy++) {
            const y = top + row * scale + dy;
            if (y < 0 || y >= height) continue;
            const rowStart = y * width;
            for (let dx = 0; dx < scale; dx++) {
              const x = left + column * scale + dx;
              if (x < 0 || x >= width) continue;
              pixels[rowStart + x] = 0x00;
            }
          }
        }
      }
    });
  });

  return { pixels, width, height };
}

/**
 * Build a PDF whose only content is a scanned-looking image of the given text.
 *
 * The page draws one image XObject and nothing else. There is no `/Font`
 * resource and no text-showing operator anywhere in the content stream, so a
 * text extractor has literally nothing to find — which is the property that
 * makes this a real OCR test rather than a decorative one.
 */
export function buildScannedPdf(lines: string[], options: ScannedPageOptions = {}): Buffer {
  const settings = { scale: options.scale ?? 4, margin: options.margin ?? 40 };
  const { pixels, width, height } = renderPage(lines, settings);
  const compressed = deflateSync(pixels, { level: 9 });

  // Page sized so the image lands at roughly 96 DPI on a US Letter-ish page.
  const pageWidth = Math.min(612, width);
  const pageHeight = Math.round((height / width) * pageWidth);

  const content = `q${NL}${pageWidth} 0 0 ${pageHeight} 0 0 cm${NL}/Im0 Do${NL}Q${NL}`;

  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(content)} >>${NL}stream${NL}${content}endstream`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
          `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ` +
          `/Length ${compressed.length} >>${NL}stream${NL}`,
        'latin1',
      ),
      compressed,
      Buffer.from(`${NL}endstream`, 'latin1'),
    ]),
  ];

  const parts: Buffer[] = [Buffer.from('%PDF-1.4' + NL, 'latin1')];
  const offsets: number[] = [];
  let cursor = parts[0].length;

  objects.forEach((body, index) => {
    offsets.push(cursor);
    const head = Buffer.from(`${index + 1} 0 obj${NL}`, 'latin1');
    const tail = Buffer.from(`${NL}endobj${NL}`, 'latin1');
    const bodyBuffer = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    parts.push(head, bodyBuffer, tail);
    cursor += head.length + bodyBuffer.length + tail.length;
  });

  let trailer = `xref${NL}0 ${objects.length + 1}${NL}0000000000 65535 f ${NL}`;
  for (const offset of offsets) trailer += `${String(offset).padStart(10, '0')} 00000 n ${NL}`;
  trailer +=
    `trailer${NL}<< /Size ${objects.length + 1} /Root 1 0 R >>${NL}` +
    `startxref${NL}${cursor}${NL}%%EOF${NL}`;

  parts.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(parts);
}

/**
 * A PDF with a real text page AND an image-only page.
 *
 * The mixed case is the one most likely to be handled wrongly: a document whose
 * first page extracts cleanly can look "fine" while every scanned page after it
 * is silently dropped. Built by concatenating the two page trees into one file.
 */
export function buildMixedPdf(textLines: string[], scannedLines: string[]): Buffer {
  const settings = { scale: 4, margin: 40 };
  const { pixels, width, height } = renderPage(scannedLines, settings);
  const compressed = deflateSync(pixels, { level: 9 });

  const pageWidth = Math.min(612, width);
  const pageHeight = Math.round((height / width) * pageWidth);

  const textContent =
    'BT' + NL + '/F1 12 Tf' + NL +
    textLines
      .map((line, index) => `1 0 0 1 72 ${720 - index * 18} Tm (${line.replace(/[()\\]/g, '')}) Tj`)
      .join(NL) +
    NL + 'ET' + NL;

  const imageContent = `q${NL}${pageWidth} 0 0 ${pageHeight} 0 0 cm${NL}/Im0 Do${NL}Q${NL}`;

  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(textContent)} >>${NL}stream${NL}${textContent}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Contents 7 0 R /Resources << /XObject << /Im0 8 0 R >> >> >>`,
    `<< /Length ${Buffer.byteLength(imageContent)} >>${NL}stream${NL}${imageContent}endstream`,
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
          `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode ` +
          `/Length ${compressed.length} >>${NL}stream${NL}`,
        'latin1',
      ),
      compressed,
      Buffer.from(`${NL}endstream`, 'latin1'),
    ]),
  ];

  const parts: Buffer[] = [Buffer.from('%PDF-1.4' + NL, 'latin1')];
  const offsets: number[] = [];
  let cursor = parts[0].length;

  objects.forEach((body, index) => {
    offsets.push(cursor);
    const head = Buffer.from(`${index + 1} 0 obj${NL}`, 'latin1');
    const tail = Buffer.from(`${NL}endobj${NL}`, 'latin1');
    const bodyBuffer = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    parts.push(head, bodyBuffer, tail);
    cursor += head.length + bodyBuffer.length + tail.length;
  });

  let trailer = `xref${NL}0 ${objects.length + 1}${NL}0000000000 65535 f ${NL}`;
  for (const offset of offsets) trailer += `${String(offset).padStart(10, '0')} 00000 n ${NL}`;
  trailer +=
    `trailer${NL}<< /Size ${objects.length + 1} /Root 1 0 R >>${NL}` +
    `startxref${NL}${cursor}${NL}%%EOF${NL}`;

  parts.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(parts);
}

/** A structurally valid PDF with one genuinely blank page. */
export function buildBlankPdf(): Buffer {
  return buildScannedPdf([' '], { scale: 2, margin: 20 });
}
