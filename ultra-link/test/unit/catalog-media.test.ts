// Photo intake (src/catalog/media.ts): magic-byte typing, structural validation, and removal of EXIF/GPS/XMP/IPTC,
// comments, PNG text/eXIf chunks, WebP EXIF/XMP chunks and trailing bytes. Fixtures are generated in code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanImage, exifOrientation, MediaError, sniffImage } from '../../src/catalog/media.ts';
import { contains, GPS_MARKERS, hugePngHeader, jpegWithMetadata, plainJpeg, plainPng, pngWithMetadata, textAsJpeg, webpWithMetadata } from '../fixtures/catalog-images.ts';

/** JPEG markers (and APPn payloads) of a file, walking segments up to SOS. */
function jpegSegments(b: Buffer): { marker: number; data: Buffer }[] {
  const out: { marker: number; data: Buffer }[] = [];
  let p = 2;
  while (p < b.length && b[p] === 0xff) {
    const m = b[p + 1]!;
    if (m === 0xd9) break;
    const len = b.readUInt16BE(p + 2);
    out.push({ marker: m, data: b.subarray(p + 4, p + 2 + len) });
    if (m === 0xda) break;
    p += 2 + len;
  }
  return out;
}
function pngChunks(b: Buffer): string[] {
  const out: string[] = [];
  let p = 8;
  while (p + 8 <= b.length) { const len = b.readUInt32BE(p); out.push(b.toString('latin1', p + 4, p + 8)); p += 12 + len; }
  return out;
}
function webpChunks(b: Buffer): string[] {
  const out: string[] = [];
  let p = 12;
  while (p + 8 <= b.length) { const len = b.readUInt32LE(p + 4); out.push(b.toString('latin1', p, p + 4)); p += 8 + len + (len & 1); }
  return out;
}
const GPS_LAT_RATIONALS = Buffer.from([36, 0, 0, 0, 1, 0, 0, 0, 35, 0, 0, 0, 1, 0, 0, 0]); // 36/1, 35/1 (little endian)

test('type is decided by magic bytes only: JPEG, PNG, WebP recognised; a text file named .jpg is not an image', () => {
  assert.equal(sniffImage(jpegWithMetadata()), 'jpeg');
  assert.equal(sniffImage(plainPng()), 'png');
  assert.equal(sniffImage(webpWithMetadata()), 'webp');
  assert.equal(sniffImage(textAsJpeg()), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
  assert.throws(() => cleanImage(textAsJpeg()), (e: unknown) => e instanceof MediaError && e.code === 'unsupported_type');
  assert.throws(() => cleanImage(Buffer.alloc(0)), (e: unknown) => e instanceof MediaError && e.code === 'empty');
});

test('JPEG with an EXIF GPS block comes back without it (and without XMP, IPTC, comment, thumbnail, trailing bytes)', () => {
  const input = jpegWithMetadata({ orientation: 6 });
  // the fixture really carries the secrets
  assert.ok(contains(input, 'Exif\0\0') && contains(input, GPS_MARKERS.make) && contains(input, GPS_LAT_RATIONALS) && contains(input, GPS_MARKERS.xmpLat));
  const out = cleanImage(input);
  assert.equal(out.type, 'jpeg');
  assert.equal(out.mime, 'image/jpeg');
  assert.deepEqual([out.width, out.height], [8, 8]);
  for (const [k, v] of Object.entries(GPS_MARKERS)) assert.ok(!contains(out.bytes, v), `${k} must be gone`);
  assert.ok(!contains(out.bytes, GPS_LAT_RATIONALS), 'GPS latitude rationals must be gone');
  assert.ok(!contains(out.bytes, 'http://ns.adobe.com/xap'), 'XMP must be gone');
  assert.ok(!contains(out.bytes, 'Photoshop 3.0'), 'IPTC must be gone');
  assert.deepEqual(out.removed.sort(), ['comment', 'exif', 'iptc', 'jfif_thumbnail', 'trailing_data', 'xmp'].sort());
  const segs = jpegSegments(out.bytes);
  assert.ok(!segs.some((s) => s.marker === 0xfe), 'no comment segment');
  assert.ok(!segs.some((s) => s.marker === 0xed), 'no APP13');
  // exactly one APP1 remains: a fresh 32-byte EXIF holding ONLY the orientation (one IFD0 entry, tag 0x0112, no GPS pointer)
  const app1 = segs.filter((s) => s.marker === 0xe1);
  assert.equal(app1.length, 1);
  assert.equal(app1[0]!.data.length, 32);
  assert.equal(exifOrientation(app1[0]!.data), 6);
  assert.equal(app1[0]!.data.readUInt16BE(14), 1, 'IFD0 has a single entry');
  assert.ok(!contains(app1[0]!.data, Buffer.from([0x88, 0x25])) && !contains(app1[0]!.data, Buffer.from([0x25, 0x88])), 'no GPSInfo tag');
  // the JFIF header survives without its thumbnail; the file still ends with EOI
  const app0 = segs.find((s) => s.marker === 0xe0)!;
  assert.equal(app0.data.length, 14);
  assert.deepEqual([app0.data[12], app0.data[13]], [0, 0]);
  assert.deepEqual([...out.bytes.subarray(-2)], [0xff, 0xd9]);
  // idempotent: cleaning the cleaned file changes nothing
  assert.ok(cleanImage(out.bytes).bytes.equals(out.bytes));
});

test('JPEG orientation 1 (normal) leaves no EXIF at all; a clean JPEG is returned byte-for-byte', () => {
  const out = cleanImage(jpegWithMetadata({ orientation: 1 }));
  assert.equal(out.orientation, null);
  assert.equal(jpegSegments(out.bytes).filter((s) => s.marker === 0xe1).length, 0);
  const plain = plainJpeg();
  assert.ok(cleanImage(plain).bytes.equals(plain));
});

test('PNG: eXIf, tEXt, iTXt (XMP), zTXt, tIME and private chunks removed; pixels and rendering chunks kept', () => {
  const input = pngWithMetadata(16, 16);
  assert.ok(contains(input, GPS_MARKERS.pngText) && contains(input, 'eXIf'));
  const out = cleanImage(input);
  assert.deepEqual([out.type, out.width, out.height], ['png', 16, 16]);
  assert.deepEqual(pngChunks(out.bytes), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  for (const [k, v] of Object.entries(GPS_MARKERS)) assert.ok(!contains(out.bytes, v), `${k} must be gone`);
  assert.ok(!contains(out.bytes, GPS_LAT_RATIONALS));
  assert.deepEqual(out.removed.sort(), ['eXIf', 'iTXt', 'prVt', 'tEXt', 'tIME', 'trailing_data', 'zTXt'].sort());
  // the image data is the same bytes as a metadata-free encoding of the same picture
  const plain = plainPng(16, 16);
  assert.ok(cleanImage(plain).bytes.equals(plain));
  assert.ok(out.bytes.subarray(out.bytes.indexOf('IDAT') - 4).equals(plain.subarray(plain.indexOf('IDAT') - 4)));
});

test('WebP: EXIF and XMP chunks removed, VP8X metadata flags cleared, RIFF size rewritten', () => {
  const input = webpWithMetadata(20, 10);
  const out = cleanImage(input);
  assert.deepEqual([out.type, out.width, out.height], ['webp', 20, 10]);
  assert.deepEqual(webpChunks(out.bytes), ['VP8X', 'VP8L']);
  assert.equal(out.bytes[20]! & 0x0c, 0, 'EXIF/XMP flags cleared');
  assert.equal(out.bytes.readUInt32LE(4), out.bytes.length - 8);
  assert.ok(!contains(out.bytes, GPS_MARKERS.xmpLat) && !contains(out.bytes, GPS_LAT_RATIONALS));
});

test('malformed and oversized images are refused before anything is stored', () => {
  const jpeg = jpegWithMetadata();
  const cut = jpeg.subarray(0, jpeg.indexOf(Buffer.from([0xff, 0xda])) + 6); // stops inside the scan header
  assert.throws(() => cleanImage(cut), (e: unknown) => e instanceof MediaError && e.code === 'malformed');
  const png = plainPng(4, 4);
  assert.throws(() => cleanImage(png.subarray(0, png.length - 12)), (e: unknown) => e instanceof MediaError && e.code === 'malformed', 'PNG without IEND');
  assert.throws(() => cleanImage(hugePngHeader(20_000, 20_000)), (e: unknown) => e instanceof MediaError && e.code === 'too_many_pixels');
  assert.throws(() => cleanImage(hugePngHeader(16_385, 10)), (e: unknown) => e instanceof MediaError && e.code === 'too_many_pixels');
  assert.equal(cleanImage(hugePngHeader(7_000, 7_000)).width, 7_000, '49 MP is allowed');
});
