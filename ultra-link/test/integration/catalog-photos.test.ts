// Product photos over HTTP (src/server/routes/catalog.ts): magic-byte typing (a renamed text file is 415), metadata
// removal end to end (the bytes served back carry no EXIF/GPS/XMP), 413 above 5 MB, content-addressed dedupe (one
// file + one blob row for the same picture on two products), 6 photos per product, the visibility rule of
// GET /api/photos/:id (owner always; a matched seeker only while product + store are active; others 404), and the
// garbage collection of unreferenced blobs.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, Client, logSink, type Harness } from './server-helpers.ts';
import { catalogRoutes } from '../../src/server/routes/catalog.ts';
import { closeTolerant } from './catalog-helpers.ts';
import { attachStoreInfo } from '../../src/catalog/match-cards.ts';
import { gcMedia } from '../../src/catalog/service.ts';
import { MediaStore } from '../../src/catalog/media-store.ts';
import { contains, GPS_MARKERS, jpegWithMetadata, plainPng, pngWithMetadata, textAsJpeg, webpWithMetadata } from '../fixtures/catalog-images.ts';

let h: Harness;
const logs = logSink();
const mediaDir = mkdtempSync(join(tmpdir(), 'ul-catalog-photos-'));
before(async () => { h = await harness(`catalog_photos_${process.pid}`, { routes: [catalogRoutes({ mediaDir })], featureRoutes: false, logStream: logs.stream, logLevel: 'info' }); });
after(async () => { await closeTolerant(h); rmSync(mediaDir, { recursive: true, force: true }); });

const filesOnDisk = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  if (existsSync(mediaDir)) walk(mediaDir);
  return out;
};

async function upload(c: Client, storeId: string, itemId: string, body: Buffer, contentType = 'image/jpeg') {
  const res = await h.app.inject({ method: 'POST', url: `/api/stores/${storeId}/items/${itemId}/photos`, payload: body, headers: { 'content-type': contentType, ...(c.cookie ? { cookie: c.cookie } : {}) } });
  let json: any = null;
  try { json = res.json(); } catch { /* not json */ }
  return { status: res.statusCode, body: json, raw: res.body };
}
async function fetchPhoto(c: Client, url: string) {
  const res = await h.app.inject({ method: 'GET', url, headers: c.cookie ? { cookie: c.cookie } : {} });
  return { status: res.statusCode, headers: res.headers, bytes: res.rawPayload };
}

async function shopWithProducts(lines: string) {
  const owner = new Client(h);
  const u = await owner.register('صاحب محل الصور');
  const s = (await owner.post('/api/stores', { nameAr: 'محل الصور', placeId: h.db.reg.placeByCode.get('sy.aleppo.azaz')!.id })).body.store;
  const p = await owner.post(`/api/stores/${s.id}/import/preview`, { text: lines });
  const r = await owner.post(`/api/stores/${s.id}/import/confirm`, { importId: randomUUID(), items: p.body.lines.map((l: any) => l.item) });
  assert.equal(r.status, 200, r.raw);
  return { owner, ownerId: u.id, store: s, products: r.body.products as any[] };
}

test('upload: JPEG with EXIF GPS is stored and served WITHOUT it; PNG and WebP metadata stripped; correct type + nosniff', async () => {
  const { owner, store, products } = await shopWithProducts('ايفون 12 مستعمل 300$\nلابتوب ديل 400$');
  const [p1] = products;
  const before = jpegWithMetadata({ orientation: 6 });
  const up = await upload(owner, store.id, p1.id, before, 'image/jpeg');
  assert.equal(up.status, 201, up.raw);
  assert.equal(up.body.photo.mime, 'image/jpeg');
  assert.deepEqual([up.body.photo.width, up.body.photo.height, up.body.photo.slot], [8, 8, 1]);
  assert.ok(up.body.metadataRemoved.includes('exif') && up.body.metadataRemoved.includes('xmp'));
  assert.match(up.body.photo.url, /^\/api\/photos\/[0-9a-f-]{36}$/);

  const got = await fetchPhoto(owner, up.body.photo.url);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'image/jpeg');
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.equal(Number(got.headers['content-length']), got.bytes.length);
  assert.ok(got.bytes.length < before.length);
  for (const [k, v] of Object.entries(GPS_MARKERS)) assert.ok(!contains(got.bytes, v), `${k} must not be served`);
  assert.ok(!contains(got.bytes, Buffer.from([36, 0, 0, 0, 1, 0, 0, 0, 35, 0, 0, 0, 1, 0, 0, 0])), 'no GPS rationals');
  // the file on disk is the cleaned one too
  const disk = filesOnDisk();
  assert.equal(disk.length, 1);
  assert.equal(statSync(disk[0]!).size, got.bytes.length);

  // the declared type is ignored: a PNG sent as application/octet-stream is a PNG (and its eXIf/tEXt are gone)
  const png = await upload(owner, store.id, p1.id, pngWithMetadata(16, 16), 'application/octet-stream');
  assert.equal(png.status, 201, png.raw);
  assert.equal(png.body.photo.mime, 'image/png');
  const pngBytes = (await fetchPhoto(owner, png.body.photo.url)).bytes;
  assert.ok(!contains(pngBytes, 'eXIf') && !contains(pngBytes, 'tEXt') && !contains(pngBytes, GPS_MARKERS.pngText));
  assert.equal((await fetchPhoto(owner, png.body.photo.url)).headers['content-type'], 'image/png');
  const webp = await upload(owner, store.id, p1.id, webpWithMetadata(), 'image/jpeg'); // lying Content-Type
  assert.equal(webp.status, 201, webp.raw);
  assert.equal(webp.body.photo.mime, 'image/webp');

  // the product card lists its photos
  const card = (await owner.get(`/api/stores/${store.id}/items/${p1.id}`)).body.item;
  assert.deepEqual(card.photos.map((x: any) => x.mime), ['image/jpeg', 'image/png', 'image/webp']);
  // nothing about the file reached the logs
  const text = logs.text();
  assert.ok(!text.includes('Exif') && !text.includes(GPS_MARKERS.make) && !text.includes('JFIF'));
});

test('wrong type → 415 (renamed text file, GIF, text/plain); too large → 413; corrupt → 422; empty → 400', async () => {
  const { owner, store, products } = await shopWithProducts('سامسونج A52 جديد 250$');
  const id = products[0].id;
  const renamed = await upload(owner, store.id, id, textAsJpeg(), 'image/jpeg');
  assert.equal(renamed.status, 415);
  assert.equal(renamed.body.error, 'unsupported_type');
  assert.match(renamed.body.messageAr, /JPEG أو PNG أو WebP/);
  assert.equal((await upload(owner, store.id, id, Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/png')).status, 415);
  assert.equal((await upload(owner, store.id, id, Buffer.from('hello'), 'text/plain')).status, 415, 'non-image content type refused before parsing');
  // > 5 MB: a valid PNG header followed by padding — refused by size before anything else
  const big = Buffer.concat([plainPng(8, 8), Buffer.alloc(5 * 1024 * 1024)]);
  const tooBig = await upload(owner, store.id, id, big, 'image/png');
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.error, 'too_large');
  assert.match(tooBig.body.messageAr, /٥ ميغابايت/);
  // exactly at the limit is accepted size-wise (then judged as an image: trailing bytes after IEND are dropped)
  const atLimit = Buffer.concat([plainPng(8, 8, 3), Buffer.alloc(5 * 1024 * 1024 - plainPng(8, 8, 3).length)]);
  const ok = await upload(owner, store.id, id, atLimit, 'image/png');
  assert.equal(ok.status, 201, ok.raw);
  assert.ok(ok.body.photo.bytes < 1000, 'the padding after IEND is not stored');
  const jpeg = jpegWithMetadata();
  assert.equal((await upload(owner, store.id, id, jpeg.subarray(0, 300), 'image/jpeg')).status, 422, 'truncated JPEG');
  assert.equal((await upload(owner, store.id, id, Buffer.alloc(0), 'image/jpeg')).status, 400);
  assert.equal(filesOnDisk().filter((f) => statSync(f).size > 1_000_000).length, 0, 'nothing big was ever written');
});

test('content-addressed: the same picture on two products is one file and one blob; twice on one product is one photo; max 6', async () => {
  const { owner, store, products } = await shopWithProducts('ايباد 2 مستعمل 200$\nتلفون نوكيا 20 يورو');
  const [a, b] = products;
  const blobsBefore = (await h.db.pool.query('SELECT count(*)::int AS n FROM media_blobs')).rows[0].n;
  const filesBefore = filesOnDisk().length;
  const img = plainPng(32, 32, 7);
  const u1 = await upload(owner, store.id, a.id, img, 'image/png');
  const u2 = await upload(owner, store.id, b.id, img, 'image/png');
  assert.deepEqual([u1.status, u2.status], [201, 201]);
  assert.equal(u1.body.deduplicated, false);
  assert.equal(u2.body.deduplicated, true, 'second product reuses the stored blob');
  assert.notEqual(u1.body.photo.id, u2.body.photo.id, 'two photos (one per product)…');
  assert.equal((await h.db.pool.query('SELECT count(*)::int AS n FROM media_blobs')).rows[0].n, blobsBefore + 1, '…one blob');
  assert.equal(filesOnDisk().length, filesBefore + 1, '…one file');
  // the same image again on the same product: the existing photo, 200, no new row
  const again = await upload(owner, store.id, a.id, img, 'image/png');
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyAttached, true);
  assert.equal(again.body.photo.id, u1.body.photo.id);
  // the EXIF-stripped JPEG and a clean JPEG of the same pixels are different files (address = cleaned bytes)
  for (let i = 1; i <= 5; i++) assert.equal((await upload(owner, store.id, a.id, plainPng(8, 8, 20 + i), 'image/png')).status, 201);
  const seventh = await upload(owner, store.id, a.id, plainPng(8, 8, 99), 'image/png');
  assert.equal(seventh.status, 409);
  assert.equal(seventh.body.error, 'photo_limit');
  const slots = (await owner.get(`/api/stores/${store.id}/items/${a.id}`)).body.item.photos.map((x: any) => x.slot);
  assert.deepEqual(slots, [1, 2, 3, 4, 5, 6]);
  // delete one, a slot frees up
  const del = await h.app.inject({ method: 'DELETE', url: `/api/stores/${store.id}/items/${a.id}/photos/${u1.body.photo.id}`, headers: { cookie: owner.cookie, 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal((await fetchPhoto(owner, u1.body.photo.url)).status, 404);
  assert.equal((await fetchPhoto(owner, u2.body.photo.url)).status, 200, 'the other product still shows the shared picture');
  const refill = await upload(owner, store.id, a.id, plainPng(8, 8, 99), 'image/png');
  assert.equal(refill.status, 201);
  assert.equal(refill.body.photo.slot, 1);

  // garbage collection: once no photo references a blob (and it is older than the grace period) blob + file go
  const media = new MediaStore(mediaDir);
  const hex = (await h.db.pool.query("SELECT encode(p.sha256, 'hex') AS hex FROM store_item_photos p WHERE p.public_id = $1", [u2.body.photo.id])).rows[0].hex;
  assert.equal(await gcMedia(h.db.pool, media, 3_600_000), 0, 'within the grace period nothing is collected');
  const del2 = await owner.post(`/api/stores/${store.id}/items/${b.id}/photos/${u2.body.photo.id}/delete`, {});
  assert.equal(del2.status, 200);
  assert.ok(await media.exists(hex));
  const n = await gcMedia(h.db.pool, media, 0);
  assert.ok(n >= 1);
  assert.equal(await media.exists(hex), false);
  assert.equal((await h.db.pool.query("SELECT count(*)::int AS n FROM media_blobs WHERE encode(sha256, 'hex') = $1", [hex])).rows[0].n, 0);
  assert.equal((await fetchPhoto(owner, refill.body.photo.url)).status, 200, 'referenced blobs are kept');
});

test('visibility: owner always; a matched seeker only while product and store are active; anyone else 404; logged out 401', async () => {
  const { owner, store, products } = await shopWithProducts('ايفون 11 برو 350$');
  const product = products[0];
  const up = await upload(owner, store.id, product.id, plainPng(24, 24, 5), 'image/png');
  assert.equal(up.status, 201);
  const url = up.body.photo.url;

  const stranger = new Client(h);
  await stranger.register('غريب');
  assert.equal((await fetchPhoto(stranger, url)).status, 404, 'no match → 404 (indistinguishable from "no such photo")');
  assert.equal((await fetchPhoto(stranger, `/api/photos/${randomUUID()}`)).status, 404);
  assert.equal((await fetchPhoto(new Client(h), url)).status, 401);

  const seeker = new Client(h);
  const su = await seeker.register('باحث');
  const res = await seeker.dialogue('بدي ايفون 11 برو بإعزاز حتى ٤٠٠ دولار');
  const want = res.intent.id;
  await seeker.post(`/api/intents/${want}/match`);
  const ms = (await seeker.get(`/api/matches?intent=${want}`)).body.items;
  const m = ms.find((x: any) => x.other.id === product.id);
  assert.ok(m, 'the seeker matches the product');
  assert.equal((await fetchPhoto(seeker, url)).status, 200, 'a live match makes the photo visible');
  // the match card carries the photo URL and the store badge
  await attachStoreInfo(h.db.pool, h.db.reg, su.id, ms);
  const card = ms.find((x: any) => x.other.id === product.id);
  assert.deepEqual(card.other.photos.map((x: any) => x.url), [url]);
  assert.equal(card.store.nameAr, 'محل الصور');
  assert.equal(card.store.groupLabelAr, 'منتج واحد من محل الصور');
  // the owner sees the badge of their own store on their side of a match
  const ownerView = (await owner.get(`/api/matches?intent=${product.id}`)).body.items;
  await attachStoreInfo(h.db.pool, h.db.reg, (await h.db.pool.query('SELECT user_id FROM intent_refs WHERE public_id = $1', [product.id])).rows[0].user_id, ownerView);
  assert.equal(ownerView[0].mineStore.nameAr, 'محل الصور');
  assert.equal(ownerView[0].store, undefined, 'a seeker is not a store');

  // store paused → product paused → the seeker loses access; the owner keeps it
  assert.equal((await owner.post(`/api/stores/${store.id}/status`, { action: 'pause' })).status, 200);
  assert.equal((await fetchPhoto(seeker, url)).status, 404);
  assert.equal((await fetchPhoto(owner, url)).status, 200);
  const paused = (await seeker.get(`/api/matches?intent=${want}&state=all`)).body.items;
  await attachStoreInfo(h.db.pool, h.db.reg, su.id, paused);
  assert.equal(paused.find((x: any) => x.other.id === product.id).other.photos, undefined, 'no photo URLs on an invalidated match');
  assert.equal((await owner.post(`/api/stores/${store.id}/status`, { action: 'resume' })).status, 200);
  assert.equal((await fetchPhoto(seeker, url)).status, 200, 'visible again once the match is live again');
  // the product deleted → gone for everyone
  assert.equal((await owner.post(`/api/stores/${store.id}/items/${product.id}/status`, { action: 'delete' })).status, 200);
  assert.equal((await fetchPhoto(seeker, url)).status, 404);
  assert.equal((await fetchPhoto(owner, url)).status, 404);
});
