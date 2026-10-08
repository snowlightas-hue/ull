// Product photo intake (V2.3, docs/CATALOG.md §4): the real type by MAGIC BYTES (never the file name, the extension or
// the Content-Type header), a structural walk of the container, and removal of ALL metadata before anything is stored:
// EXIF (incl. GPS, camera serials, embedded thumbnails), XMP, IPTC/Photoshop, MPF secondary images, comments, PNG text
// chunks and eXIf, WebP EXIF/XMP chunks, and any bytes after the end of the image.
//
// Zero dependencies and no decoding: JPEG segments, PNG chunks and WebP (RIFF) chunks are walked byte by byte; the
// pixel data is copied verbatim. What is KEPT is a whitelist of what a decoder needs (quantisation/Huffman tables,
// frame/scan headers, entropy data, PNG IHDR/PLTE/IDAT/IEND + rendering chunks, WebP image/animation chunks) plus colour
// management (ICC profile, Adobe APP14 colour transform) — none of those identify a person or a place.
//
// One deliberate exception: a JPEG's EXIF Orientation (1..8) is re-emitted as a fresh 32-byte EXIF block that holds that
// single tag and nothing else, so phone photos are not shown sideways (browsers honour it). Every other EXIF tag is gone.
//
// Pixel bombs: width × height is read from the headers and capped (default 50 MP, 16384 px per side) before any browser
// would try to decode the file. No thumbnails are produced (that needs a decoder; see docs/CATALOG.md).

export type ImageType = 'jpeg' | 'png' | 'webp';
export const IMAGE_MIME: Record<ImageType, 'image/jpeg' | 'image/png' | 'image/webp'> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const IMAGE_EXT: Record<ImageType, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

export type MediaErrorCode = 'unsupported_type' | 'malformed' | 'too_many_pixels' | 'empty';

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  constructor(code: MediaErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

export interface CleanImage {
  type: ImageType;
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: Buffer;
  width: number;
  height: number;
  /** names of the metadata blocks that were removed (for tests/diagnostics; never file contents) */
  removed: string[];
  /** EXIF orientation kept for display (JPEG only), null when absent or 1 */
  orientation: number | null;
}

export interface CleanOptions { maxPixels?: number; maxSide?: number }
export const DEFAULT_MAX_PIXELS = 50_000_000;
export const DEFAULT_MAX_SIDE = 16_384;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The image type from the first bytes, or null. Extension and declared Content-Type are never consulted. */
export function sniffImage(buf: Uint8Array): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && PNG_SIG.every((b, i) => buf[i] === b)) return 'png';
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'webp';
  return null;
}

/** Validate the container and return a metadata-free copy. Throws MediaError. */
export function cleanImage(input: Buffer, opts: CleanOptions = {}): CleanImage {
  if (!input.length) throw new MediaError('empty', 'no bytes');
  const type = sniffImage(input);
  if (!type) throw new MediaError('unsupported_type', 'not a JPEG, PNG or WebP file');
  const out = type === 'jpeg' ? cleanJpeg(input) : type === 'png' ? cleanPng(input) : cleanWebp(input);
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE;
  const maxPixels = opts.maxPixels ?? DEFAULT_MAX_PIXELS;
  if (!(out.width > 0 && out.height > 0)) throw new MediaError('malformed', 'no dimensions');
  if (out.width > maxSide || out.height > maxSide || out.width * out.height > maxPixels) throw new MediaError('too_many_pixels', `${out.width}x${out.height}`);
  return { type, mime: IMAGE_MIME[type], ...out };
}

function ascii(buf: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < buf.length; i++) s += String.fromCharCode(buf[i]!);
  return s;
}

// ───────────────────────────── JPEG ─────────────────────────────
// Markers: SOI D8, EOI D9, SOS DA, DQT DB, DNL DC, DRI DD, DHP DE, EXP DF, SOFn C0–CF (C4 DHT, C8 JPG, CC DAC), APPn E0–EF,
// COM FE, RSTn D0–D7 (only inside entropy data), TEM 01, JPGn F0–FD (extensions; dropped).

type Seg = Buffer;

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const KEEP_JPEG = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, ...SOF]);

function segment(marker: number, data: Buffer): Seg {
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = marker; head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

function cleanJpeg(buf: Buffer): { bytes: Buffer; width: number; height: number; removed: string[]; orientation: number | null } {
  const segs: Seg[] = [Buffer.from([0xff, 0xd8])];
  const removed: string[] = [];
  let orientation: number | null = null;
  let width = 0, height = 0, sawSof = false, sawSos = false, sawEoi = false;
  let app0At = -1; // index in segs of the kept JFIF APP0 (an orientation-only EXIF block goes right after it)
  let pos = 2;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) throw new MediaError('malformed', 'expected a marker');
    while (pos < buf.length && buf[pos] === 0xff) pos++; // fill bytes
    if (pos >= buf.length) throw new MediaError('malformed', 'truncated marker');
    const marker = buf[pos]!;
    pos++;
    if (marker === 0xd9) { segs.push(Buffer.from([0xff, 0xd9])); sawEoi = true; break; }
    if (marker === 0xd8 || marker === 0x00) throw new MediaError('malformed', 'unexpected marker');
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { segs.push(Buffer.from([0xff, marker])); continue; }
    if (pos + 2 > buf.length) throw new MediaError('malformed', 'truncated segment length');
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) throw new MediaError('malformed', 'segment length out of range');
    const data = buf.subarray(pos + 2, pos + len);
    pos += len;

    if (marker >= 0xe0 && marker <= 0xef) {
      const id = ascii(data, 0, 14);
      if (marker === 0xe0 && id.startsWith('JFIF\0') && data.length >= 14) {
        // JFIF header kept, any embedded thumbnail dropped (it can be an uncropped copy of the photo)
        const jfif = Buffer.from(data.subarray(0, 14));
        if (data.length > 14 || jfif[12] !== 0 || jfif[13] !== 0) removed.push('jfif_thumbnail');
        jfif[12] = 0; jfif[13] = 0;
        if (app0At < 0) { segs.push(segment(0xe0, jfif)); app0At = segs.length - 1; }
        continue;
      }
      if (marker === 0xe2 && id.startsWith('ICC_PROFILE\0')) { segs.push(segment(marker, data)); continue; } // colour management
      if (marker === 0xee && id.startsWith('Adobe')) { segs.push(segment(marker, data)); continue; } // colour transform (decoding)
      if (marker === 0xe1 && id.startsWith('Exif\0')) {
        orientation ??= exifOrientation(data);
        removed.push('exif');
      } else if (marker === 0xe1 && (id.startsWith('http://ns.ado') || id.startsWith('XMP'))) removed.push('xmp');
      else if (marker === 0xed) removed.push('iptc');
      else if (marker === 0xe2 && id.startsWith('MPF')) removed.push('mpf');
      else removed.push(`app${marker - 0xe0}`);
      continue;
    }
    if (marker === 0xfe) { removed.push('comment'); continue; }
    if (marker >= 0xf0 && marker <= 0xfd) { removed.push(`jpg${marker - 0xf0}`); continue; }
    if (SOF.has(marker)) {
      if (data.length < 6) throw new MediaError('malformed', 'short frame header');
      height = data.readUInt16BE(1);
      width = data.readUInt16BE(3);
      sawSof = true;
      segs.push(segment(marker, data));
      continue;
    }
    if (marker === 0xda) {
      if (!sawSof) throw new MediaError('malformed', 'scan before frame');
      sawSos = true;
      segs.push(segment(marker, data));
      // entropy-coded data runs until the next marker that is not a stuffed 0xFF00 or a restart marker
      let end = pos;
      while (end < buf.length) {
        if (buf[end] === 0xff && end + 1 < buf.length) {
          const n = buf[end + 1]!;
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        end++;
      }
      if (end >= buf.length) throw new MediaError('malformed', 'scan without an end');
      segs.push(buf.subarray(pos, end));
      pos = end;
      continue;
    }
    if (KEEP_JPEG.has(marker)) { segs.push(segment(marker, data)); continue; }
    throw new MediaError('malformed', 'unknown marker');
  }
  if (!sawSof || !sawSos || !sawEoi) throw new MediaError('malformed', 'incomplete JPEG');
  if (pos < buf.length) removed.push('trailing_data');
  const keepOrientation = orientation !== null && orientation >= 2 && orientation <= 8 ? orientation : null;
  if (keepOrientation) segs.splice(app0At >= 0 ? app0At + 1 : 1, 0, orientationExif(keepOrientation));
  return { bytes: Buffer.concat(segs), width, height, removed: [...new Set(removed)], orientation: keepOrientation };
}

/** Orientation (tag 0x0112) from IFD0 of an "Exif\0\0" APP1 payload; null when absent or unreadable. */
export function exifOrientation(app1: Buffer): number | null {
  try {
    const t = 6; // TIFF header after "Exif\0\0"
    if (app1.length < t + 8) return null;
    const order = ascii(app1, t, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const le = order === 'II';
    const u16 = (o: number) => (le ? app1.readUInt16LE(t + o) : app1.readUInt16BE(t + o));
    const u32 = (o: number) => (le ? app1.readUInt32LE(t + o) : app1.readUInt32BE(t + o));
    if (u16(2) !== 42) return null;
    const ifd = u32(4);
    if (ifd + 2 > app1.length - t) return null;
    const n = u16(ifd);
    for (let k = 0; k < n && k < 512; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > app1.length - t) return null;
      if (u16(e) === 0x0112 && u16(e + 2) === 3) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : null;
      }
    }
  } catch { /* unreadable EXIF: no orientation */ }
  return null;
}

/** A fresh APP1 segment holding ONLY the Orientation tag (big-endian TIFF, one IFD0 entry, no next IFD). */
export function orientationExif(o: number): Buffer {
  const d = Buffer.alloc(32);
  d.write('Exif\0\0', 0, 'latin1');
  d.write('MM', 6, 'latin1');
  d.writeUInt16BE(42, 8);
  d.writeUInt32BE(8, 10);          // IFD0 at offset 8 of the TIFF header
  d.writeUInt16BE(1, 14);          // one entry
  d.writeUInt16BE(0x0112, 16);     // Orientation
  d.writeUInt16BE(3, 18);          // SHORT
  d.writeUInt32BE(1, 20);          // count 1
  d.writeUInt16BE(o, 24);          // value (left-justified)
  d.writeUInt32BE(0, 28);          // no next IFD
  return segment(0xe1, d);
}

// ───────────────────────────── PNG ─────────────────────────────
// Kept: critical chunks and chunks that change how pixels render (transparency, gamma, colour space, ICC profile,
// significant bits, background, physical pixel size, APNG animation, HDR colour info). Everything else — tEXt, zTXt, iTXt
// (XMP lives here), eXIf, tIME, and any private/unknown chunk — is removed.
const KEEP_PNG = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'acTL', 'fcTL', 'fdAT', 'cICP', 'mDCv', 'cLLi']);

function cleanPng(buf: Buffer): { bytes: Buffer; width: number; height: number; removed: string[]; orientation: null } {
  const parts: Buffer[] = [PNG_SIG];
  const removed: string[] = [];
  let pos = 8, width = 0, height = 0, first = true, sawIdat = false, sawEnd = false;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) throw new MediaError('malformed', 'truncated chunk');
    const len = buf.readUInt32BE(pos);
    const type = ascii(buf, pos + 4, 4);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new MediaError('malformed', 'bad chunk type');
    if (len > 0x7fffffff || pos + 12 + len > buf.length) throw new MediaError('malformed', 'chunk length out of range');
    const whole = buf.subarray(pos, pos + 12 + len);
    if (first) {
      if (type !== 'IHDR' || len !== 13) throw new MediaError('malformed', 'IHDR must come first');
      width = buf.readUInt32BE(pos + 8);
      height = buf.readUInt32BE(pos + 12);
      first = false;
    }
    pos += 12 + len;
    if (type === 'IDAT') sawIdat = true;
    if (KEEP_PNG.has(type)) parts.push(whole);
    else removed.push(type);
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawIdat || !sawEnd) throw new MediaError('malformed', 'incomplete PNG');
  if (pos < buf.length) removed.push('trailing_data');
  return { bytes: Buffer.concat(parts), width, height, removed: [...new Set(removed)], orientation: null };
}

// ───────────────────────────── WebP ─────────────────────────────
// RIFF chunks: VP8 (lossy), VP8L (lossless), VP8X (extended header), ALPH, ANIM, ANMF, ICCP are kept; EXIF, "XMP " and any
// unknown chunk are removed, and the VP8X flags that announce EXIF/XMP are cleared.
const KEEP_WEBP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

function cleanWebp(buf: Buffer): { bytes: Buffer; width: number; height: number; removed: string[]; orientation: null } {
  const riffSize = buf.readUInt32LE(4);
  const end = 8 + riffSize;
  if (riffSize < 4 || end > buf.length) throw new MediaError('malformed', 'RIFF size out of range');
  const parts: Buffer[] = [];
  const removed: string[] = [];
  let pos = 12, width = 0, height = 0, canvas: { w: number; h: number } | null = null, image = false;
  while (pos < end) {
    if (pos + 8 > end) throw new MediaError('malformed', 'truncated chunk');
    const fourcc = ascii(buf, pos, 4);
    const size = buf.readUInt32LE(pos + 4);
    const padded = size + (size & 1);
    if (pos + 8 + size > end) throw new MediaError('malformed', 'chunk size out of range');
    const payload = buf.subarray(pos + 8, pos + 8 + size);
    let whole = Buffer.from(buf.subarray(pos, Math.min(pos + 8 + padded, end)));
    if (whole.length < 8 + padded) { // a last odd-sized chunk without its pad byte: write the pad byte
      const fixed = Buffer.alloc(8 + padded);
      whole.copy(fixed);
      whole = fixed;
    }
    pos += 8 + padded;
    if (!KEEP_WEBP.has(fourcc)) { removed.push(fourcc.trim().toLowerCase()); continue; }
    if (fourcc === 'VP8X') {
      if (size < 10) throw new MediaError('malformed', 'short VP8X');
      if (whole[8]! & 0x0c) removed.push('vp8x_metadata_flags');
      whole[8] = whole[8]! & ~0x0c; // clear EXIF (0x08) and XMP (0x04) flags
      canvas = { w: 1 + payload.readUIntLE(4, 3), h: 1 + payload.readUIntLE(7, 3) };
    } else if (fourcc === 'VP8 ') {
      // frame tag (3 bytes) + start code 9d 01 2a + 14-bit width/height (little endian)
      if (size < 10 || payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) throw new MediaError('malformed', 'bad VP8 header');
      width = payload.readUInt16LE(6) & 0x3fff; height = payload.readUInt16LE(8) & 0x3fff; image = true;
    } else if (fourcc === 'VP8L') {
      if (size < 5 || payload[0] !== 0x2f) throw new MediaError('malformed', 'bad VP8L header');
      const bits = payload.readUInt32LE(1);
      width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; image = true;
    } else if (fourcc === 'ANMF') image = true;
    parts.push(whole);
  }
  if (!image) throw new MediaError('malformed', 'no image data');
  if (canvas) { width = canvas.w; height = canvas.h; }
  if (end < buf.length) removed.push('trailing_data');
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return { bytes: Buffer.concat([head, body]), width, height, removed: [...new Set(removed)], orientation: null };
}
