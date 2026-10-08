// Test images for the catalog photo pipeline, generated in code (no binary fixtures in git).
//
//   jpegWithMetadata()  8×8 grey baseline JPEG (decodable) carrying: JFIF with an embedded thumbnail, an EXIF APP1 with
//                       Make/Model/Orientation and a GPS IFD (lat 36°35'11.76"N, lng 37°2'46.68"E), an XMP APP1 with a
//                       GPS position, an IPTC APP13, a comment, and bytes after EOI.
//   pngWithMetadata()   w×h RGB gradient PNG (decodable) carrying tEXt, iTXt (XMP), zTXt, eXIf (with GPS) and tIME chunks,
//                       plus a private chunk and trailing bytes.
//   webpWithMetadata()  structurally valid WebP (VP8X + VP8L header) with EXIF and XMP chunks (not meant to be decoded).
import { deflateSync, crc32 } from 'node:zlib';

export const GPS_MARKERS = {
  make: 'TestCam',
  model: 'Model-X9',
  xmpLat: '36,35.196N',
  comment: 'shop-owner home 36.5866,37.0463',
  trailing: 'TRAILING-36.5866-37.0463',
  pngText: 'Location: 36.5866 37.0463',
};

// ───────────── TIFF/EXIF builder (little endian) ─────────────
interface Entry { tag: number; type: 2 | 3 | 4 | 5; count: number; data: Buffer }
function tiffWithGps(orientation: number): Buffer {
  const enc = (s: string) => Buffer.from(s + '\0', 'latin1');
  const rationals = (xs: [number, number][]) => { const b = Buffer.alloc(8 * xs.length); xs.forEach(([n, d], i) => { b.writeUInt32LE(n, i * 8); b.writeUInt32LE(d, i * 8 + 4); }); return b; };
  const short = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const ifd0: Entry[] = [
    { tag: 0x010f, type: 2, count: GPS_MARKERS.make.length + 1, data: enc(GPS_MARKERS.make) },
    { tag: 0x0110, type: 2, count: GPS_MARKERS.model.length + 1, data: enc(GPS_MARKERS.model) },
    { tag: 0x0112, type: 3, count: 1, data: short(orientation) },
    { tag: 0x8825, type: 4, count: 1, data: Buffer.alloc(4) }, // GPS IFD pointer, patched below
  ];
  const gps: Entry[] = [
    { tag: 0x0001, type: 2, count: 2, data: enc('N') },
    { tag: 0x0002, type: 5, count: 3, data: rationals([[36, 1], [35, 1], [1176, 100]]) },
    { tag: 0x0003, type: 2, count: 2, data: enc('E') },
    { tag: 0x0004, type: 5, count: 3, data: rationals([[37, 1], [2, 1], [4668, 100]]) },
  ];
  // layout: header(8) | IFD0 | IFD0 data | GPS IFD | GPS data
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const extSize = (es: Entry[]) => es.reduce((a, e) => a + (e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
  const ifd0At = 8;
  const ifd0DataAt = ifd0At + ifdSize(ifd0.length);
  const gpsAt = ifd0DataAt + extSize(ifd0);
  const gpsDataAt = gpsAt + ifdSize(gps.length);
  ifd0[3]!.data.writeUInt32LE(gpsAt);
  const out = Buffer.alloc(gpsDataAt + extSize(gps));
  out.write('II', 0, 'latin1'); out.writeUInt16LE(42, 2); out.writeUInt32LE(ifd0At, 4);
  const writeIfd = (at: number, dataAt: number, es: Entry[]) => {
    out.writeUInt16LE(es.length, at);
    let d = dataAt;
    es.forEach((e, i) => {
      const p = at + 2 + i * 12;
      out.writeUInt16LE(e.tag, p); out.writeUInt16LE(e.type, p + 2); out.writeUInt32LE(e.count, p + 4);
      if (e.data.length <= 4) e.data.copy(out, p + 8);
      else { out.writeUInt32LE(d, p + 8); e.data.copy(out, d); d += e.data.length + (e.data.length & 1); }
    });
    out.writeUInt32LE(0, at + 2 + es.length * 12);
  };
  writeIfd(ifd0At, ifd0DataAt, ifd0);
  writeIfd(gpsAt, gpsDataAt, gps);
  return out;
}

// ───────────── JPEG ─────────────
function seg(marker: number, data: Buffer): Buffer {
  const h = Buffer.alloc(4); h[0] = 0xff; h[1] = marker; h.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([h, data]);
}

/** The decodable core of an 8×8 mid-grey baseline JPEG: DQT, SOF0, two one-symbol Huffman tables, SOS + data. */
function jpegCore(): Buffer[] {
  const dqt = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]);
  const sof0 = Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0]);
  const dht = (cls: number) => { const bits = Buffer.alloc(16); bits[0] = 1; return Buffer.concat([Buffer.from([cls << 4]), bits, Buffer.from([0x00])]); };
  const sos = Buffer.from([1, 1, 0x00, 0, 63, 0]);
  // one block: DC category 0 (code '0'), AC end-of-block (code '0'), padded with 1-bits → 0b00111111
  return [seg(0xdb, dqt), seg(0xc0, sof0), seg(0xc4, dht(0)), seg(0xc4, dht(1)), seg(0xda, sos), Buffer.from([0x3f])];
}

export function plainJpeg(): Buffer {
  const jfif = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, jfif), ...jpegCore(), Buffer.from([0xff, 0xd9])]);
}

export function jpegWithMetadata(opts: { orientation?: number } = {}): Buffer {
  const jfifThumb = Buffer.concat([Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 1, 1]), Buffer.from([0x11, 0x22, 0x33])]); // 1×1 RGB thumbnail
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffWithGps(opts.orientation ?? 6)]);
  const xmp = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="${GPS_MARKERS.xmpLat}"/></rdf:RDF></x:xmpmeta>`, 'latin1')]);
  const iptc = Buffer.concat([Buffer.from('Photoshop 3.0\x008BIM', 'latin1'), Buffer.from([0x04, 0x04, 0, 0, 0, 0, 0, 0x0c, 0x1c, 0x02, 0x5a, 0, 0x08]), Buffer.from('Azaz-XYZ', 'latin1')]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, jfifThumb), seg(0xe1, exif), seg(0xe1, xmp), seg(0xed, iptc), seg(0xfe, Buffer.from(GPS_MARKERS.comment, 'latin1')),
    ...jpegCore(),
    Buffer.from([0xff, 0xd9]),
    Buffer.from(GPS_MARKERS.trailing, 'latin1'),
  ]);
}

// ───────────── PNG ─────────────
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0);
  return Buffer.concat([head, data, crc]);
}

/** A w×h RGB PNG with a colour gradient (seed changes the colours → different bytes, different sha256). */
export function plainPng(w = 64, h = 64, seed = 0): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 4 + seed * 40) & 0xff; raw[o + 1] = (y * 4 + 80) & 0xff; raw[o + 2] = (200 - x * 2 + seed * 17) & 0xff;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function pngWithMetadata(w = 16, h = 16): Buffer {
  const base = plainPng(w, h);
  const ihdrEnd = 8 + 12 + 13;
  const idatAndEnd = base.subarray(ihdrEnd);
  const exif = tiffWithGps(1);
  return Buffer.concat([
    base.subarray(0, ihdrEnd),
    chunk('tEXt', Buffer.from(`Comment\0${GPS_MARKERS.pngText}`, 'latin1')),
    chunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><exif:GPSLatitude>${GPS_MARKERS.xmpLat}</exif:GPSLatitude></x:xmpmeta>`, 'latin1')),
    chunk('zTXt', Buffer.concat([Buffer.from('Author\0\0', 'latin1'), deflateSync(Buffer.from('Abu Ahmad', 'latin1'))])),
    chunk('eXIf', exif),
    chunk('tIME', Buffer.from([0x07, 0xea, 10, 8, 12, 0, 0])),
    chunk('prVt', Buffer.from('private', 'latin1')),
    chunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
    idatAndEnd,
    Buffer.from(GPS_MARKERS.trailing, 'latin1'),
  ]);
}

/** A PNG whose header claims w×h (pixel-bomb test); the data is a token IDAT. */
export function hugePngHeader(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(16))), chunk('IEND', Buffer.alloc(0))]);
}

// ───────────── WebP ─────────────
function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.write(fourcc, 0, 'latin1'); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

export function webpWithMetadata(w = 20, h = 10): Buffer {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04; vp8x.writeUIntLE(w - 1, 4, 3); vp8x.writeUIntLE(h - 1, 7, 3);
  const vp8l = Buffer.alloc(9); vp8l[0] = 0x2f; vp8l.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1);
  const body = Buffer.concat([
    riffChunk('VP8X', vp8x), riffChunk('VP8L', vp8l),
    riffChunk('EXIF', tiffWithGps(1)),
    riffChunk('XMP ', Buffer.from(`<x:xmpmeta><exif:GPSLatitude>${GPS_MARKERS.xmpLat}</exif:GPSLatitude></x:xmpmeta>`, 'latin1')),
  ]);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** A text file that a user renamed to photo.jpg. */
export function textAsJpeg(): Buffer {
  return Buffer.from('هذا ملف نصي وليس صورة\nthis is a text file renamed to .jpg\n', 'utf8');
}

/** Tiny helper: does `hay` contain `needle` (bytes)? */
export function contains(hay: Buffer, needle: string | Buffer): boolean {
  return hay.indexOf(typeof needle === 'string' ? Buffer.from(needle, 'latin1') : needle) >= 0;
}
