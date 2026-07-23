import { inflateSync, brotliDecompressSync } from 'node:zlib';

/**
 * Read a font's real family name straight out of its bytes — no dependency, and
 * no shelling out to fontconfig (which the desktop build has no guarantee of).
 *
 * Why this has to exist: a burned caption's ASS `Fontname` must be the family
 * name libass will match, and libass matches on the name stored in the font's
 * own `name` table — NOT the filename. Upload "BebasNeue-Regular.ttf" whose
 * family is "Bebas Neue" and a Fontname of "BebasNeue-Regular" silently falls
 * back to the default face. So the server reads the true family once, at import,
 * and both the ASS and the preview's @font-face key off that.
 *
 * The `name` table lives inside an SFNT (TrueType/OpenType). The four accepted
 * formats are three wrappers around one: a bare SFNT, WOFF (per-table zlib), and
 * WOFF2 (one brotli stream, compact directory). We unwrap only as far as the
 * `name` table — never reconstructing glyphs — so even WOFF2, whose glyf/loca
 * tables are transformed, is cheap here: `name` is never transformed.
 */

export type FontFormat = 'truetype' | 'opentype' | 'woff' | 'woff2';

export interface FontInfo {
  /** The family libass will match and the preview will render. */
  family: string;
  /** The @font-face `format()` hint the browser wants for this file. */
  format: FontFormat;
}

/** The 63 tags WOFF2 can name by index; anything else is spelled out (index 63). */
const WOFF2_KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
];

/**
 * Read {family, format} from a font file, or throw with a user-facing reason.
 *
 * Throwing rather than guessing a family: a wrong family name is a caption that
 * burns in the fallback face with no error anywhere, which is far worse to debug
 * than an upload the user is told to re-save as a different format.
 */
export function readFontInfo(buffer: Buffer): FontInfo {
  const tag = buffer.subarray(0, 4).toString('latin1');

  if (tag === 'wOFF') return { family: familyFromNameTable(nameTableFromWoff(buffer)), format: 'woff' };
  if (tag === 'wOF2') return { family: familyFromNameTable(nameTableFromWoff2(buffer)), format: 'woff2' };

  const signature = buffer.readUInt32BE(0);
  // 0x00010000 = TrueType outlines, 'true'/'typ1' = legacy Mac, 'OTTO' = CFF,
  // 'ttcf' = a collection (we read its first face).
  const isSfnt = signature === 0x00010000 || tag === 'true' || tag === 'typ1' || tag === 'OTTO';
  if (isSfnt || tag === 'ttcf') {
    const sfntStart = tag === 'ttcf' ? buffer.readUInt32BE(12) : 0; // first font's offset table
    const flavor = buffer.subarray(sfntStart, sfntStart + 4).toString('latin1');
    const format: FontFormat = flavor === 'OTTO' ? 'opentype' : 'truetype';
    return { family: familyFromNameTable(nameTableFromSfnt(buffer, sfntStart)), format };
  }

  throw new Error('Unrecognized font file. Use a TTF, OTF, WOFF, or WOFF2 file.');
}

/** Locate the `name` table inside a bare SFNT and return its bytes. */
function nameTableFromSfnt(buffer: Buffer, start: number): Buffer {
  const numTables = buffer.readUInt16BE(start + 4);
  // Offset table (12 bytes) then 16-byte directory entries: tag, checksum, offset, length.
  let dir = start + 12;
  for (let i = 0; i < numTables; i++, dir += 16) {
    if (buffer.subarray(dir, dir + 4).toString('latin1') === 'name') {
      const offset = buffer.readUInt32BE(dir + 8);
      const length = buffer.readUInt32BE(dir + 12);
      return buffer.subarray(offset, offset + length);
    }
  }
  throw new Error('Font has no name table, so its family cannot be read.');
}

/** WOFF: the directory is uncompressed; each table's data may be zlib-deflated. */
function nameTableFromWoff(buffer: Buffer): Buffer {
  const numTables = buffer.readUInt16BE(12);
  // 44-byte header, then 20-byte entries: tag, offset, compLength, origLength, checksum.
  let dir = 44;
  for (let i = 0; i < numTables; i++, dir += 20) {
    if (buffer.subarray(dir, dir + 4).toString('latin1') === 'name') {
      const offset = buffer.readUInt32BE(dir + 4);
      const compLength = buffer.readUInt32BE(dir + 8);
      const origLength = buffer.readUInt32BE(dir + 12);
      const raw = buffer.subarray(offset, offset + compLength);
      // compLength < origLength means the table was deflated; equal means stored.
      return compLength < origLength ? inflateSync(raw) : raw;
    }
  }
  throw new Error('Font has no name table, so its family cannot be read.');
}

/**
 * WOFF2: a compact directory gives each table's length, then ONE brotli stream
 * holds every table back to back in directory order. We sum lengths to find where
 * `name` sits in the decompressed stream. `name` is never transformed, so its
 * stored length is its real length — no glyph reconstruction needed.
 */
function nameTableFromWoff2(buffer: Buffer): Buffer {
  const numTables = buffer.readUInt16BE(12);
  const totalCompressedSize = buffer.readUInt32BE(20);

  let p = 48; // fixed WOFF2 header length
  let nameOffset = -1;
  let nameLength = 0;
  let cursor = 0; // running offset into the decompressed table stream

  for (let i = 0; i < numTables; i++) {
    const flags = buffer.readUInt8(p++);
    const tagIndex = flags & 0x3f;
    const transformVersion = (flags >> 6) & 0x3;

    let tag: string;
    if (tagIndex === 63) {
      tag = buffer.subarray(p, p + 4).toString('latin1');
      p += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[tagIndex];
    }

    const origLength = readUIntBase128(buffer, p);
    p = origLength.next;

    // A transformLength is present when the table is actually transformed: for
    // glyf/loca that is version 0 (their DEFAULT is transformed, version 3 = not);
    // for every other table it is any non-zero version. `name` is neither, so it
    // takes neither branch — its stream length is just origLength.
    const transformed =
      tag === 'glyf' || tag === 'loca' ? transformVersion === 0 : transformVersion !== 0;
    let streamLength = origLength.value;
    if (transformed) {
      const transformLength = readUIntBase128(buffer, p);
      p = transformLength.next;
      streamLength = transformLength.value;
    }

    if (tag === 'name') {
      nameOffset = cursor;
      nameLength = streamLength;
    }
    cursor += streamLength;
  }

  if (nameOffset < 0) throw new Error('Font has no name table, so its family cannot be read.');

  const compressed = buffer.subarray(p, p + totalCompressedSize);
  const tables = brotliDecompressSync(compressed);
  return tables.subarray(nameOffset, nameOffset + nameLength);
}

/** WOFF2's variable-length big-endian integer: 7 data bits per byte, high bit continues. */
function readUIntBase128(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buffer.readUInt8(offset + i);
    // A leading 0x80 would be a zero-padded encoding, which the spec forbids.
    if (i === 0 && byte === 0x80) throw new Error('Malformed font (bad table length).');
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  throw new Error('Malformed font (table length too long).');
}

/**
 * Pull the family out of a `name` table.
 *
 * Prefer nameID 16 (Typographic Family) over 1 (Font Family): a font with named
 * instances puts the human family — "Bebas Neue" — in 16 and a per-style name in
 * 1. Within a nameID, prefer a Windows-BMP/English record, since that is the one
 * both browsers and libass key off; fall back to any record we can decode.
 */
function familyFromNameTable(table: Buffer): string {
  const count = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);

  let best: { score: number; text: string } | null = null;
  let rec = 6;
  for (let i = 0; i < count; i++, rec += 12) {
    const platformID = table.readUInt16BE(rec);
    const encodingID = table.readUInt16BE(rec + 2);
    const languageID = table.readUInt16BE(rec + 4);
    const nameID = table.readUInt16BE(rec + 6);
    if (nameID !== 1 && nameID !== 16) continue;

    const length = table.readUInt16BE(rec + 8);
    const offset = stringOffset + table.readUInt16BE(rec + 10);
    const bytes = table.subarray(offset, offset + length);
    const text = decodeNameString(platformID, bytes).trim();
    if (!text) continue;

    // Higher is better: 16 beats 1, Windows(3) beats Mac(1), US-English is ideal.
    let score = nameID === 16 ? 100 : 0;
    if (platformID === 3) score += 10;
    if (platformID === 3 && encodingID === 1 && languageID === 0x0409) score += 5;
    if (platformID === 1 && languageID === 0) score += 3;

    if (!best || score > best.score) best = { score, text };
  }

  if (!best) throw new Error('Could not read a family name from this font.');
  return best.text;
}

/**
 * Decode a name string. Windows (3) and Unicode (0) records are UTF-16BE; Mac (1)
 * records are effectively Latin-1 for the roman script we care about.
 */
function decodeNameString(platformID: number, bytes: Buffer): string {
  if (platformID === 3 || platformID === 0) {
    // Node has no 'utf-16be'; swap byte pairs into LE and decode. swap16 throws on
    // an odd length, so drop a stray trailing byte a malformed record might carry.
    const even = bytes.length % 2 === 0 ? bytes : bytes.subarray(0, bytes.length - 1);
    const swapped = Buffer.from(even);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return bytes.toString('latin1');
}
