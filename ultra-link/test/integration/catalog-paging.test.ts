// «متجري» product list: exact totals and keyset paging (catalog order) over 120 products imported in ONE confirm,
// status filters, bad cursors, and the 1,000-products-per-store cap. Prints measured timings (this machine) for the
// bulk path: preview / confirm of 120 lines and one page read.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, Client, type Harness } from './server-helpers.ts';
import { catalogRoutes } from '../../src/server/routes/catalog.ts';

let h: Harness;
const mediaDir = mkdtempSync(join(tmpdir(), 'ul-catalog-paging-'));
before(async () => { h = await harness(`catalog_paging_${process.pid}`, { routes: [catalogRoutes({ mediaDir })], featureRoutes: false }); });
after(async () => { await h?.close(); rmSync(mediaDir, { recursive: true, force: true }); });

const ITEMS = ['موبايل', 'لابتوب', 'تابلت', 'شاشة', 'كمبيوتر', 'ايباد'];
const COLORS = ['أحمر', 'أزرق', 'أسود', 'أبيض', 'ذهبي'];
const KINDS = ['فاخر', 'عادي', 'صغير', 'كبير'];
const MODELS = ['ممتاز', 'أصلي', 'مكفول', 'مضمون', 'حديث', 'خفيف', 'قوي', 'أنيق', 'عملي'];
/** n distinct, parseable product lines («موبايل أحمر فاخر 101 دولار») */
export function catalogLines(n: number, offset = 0): string[] {
  const out: string[] = [];
  for (let k = offset; out.length < n; k++) {
    const i = k % ITEMS.length, c = Math.floor(k / ITEMS.length) % COLORS.length, q = Math.floor(k / (ITEMS.length * COLORS.length)) % KINDS.length;
    const batch = Math.floor(k / (ITEMS.length * COLORS.length * KINDS.length));
    // digit-free model words: «طراز ب1» would read as «بـ1» (a price of 1) — the parser's documented behaviour
    out.push(`${ITEMS[i]} ${COLORS[c]} ${KINDS[q]}${batch ? ` ${MODELS[(batch - 1) % MODELS.length]}` : ''} ${100 + k} دولار`);
  }
  return out;
}

test('120 products: exact totals, keyset pages forward and back, status filters, cursors validated', async () => {
  const owner = new Client(h);
  await owner.register('تاجر الجملة');
  const s = (await owner.post('/api/stores', { nameAr: 'مستودع الإلكترونيات', placeId: h.db.reg.placeByCode.get('sy.aleppo.al_bab')!.id })).body.store;
  const text = catalogLines(120).join('\n');
  let t0 = performance.now();
  const p = await owner.post(`/api/stores/${s.id}/import/preview`, { text });
  const previewMs = performance.now() - t0;
  assert.equal(p.status, 200, p.raw);
  assert.equal(p.body.summary.ok, 120, JSON.stringify(p.body.lines.filter((l: any) => !l.ok).slice(0, 3)));
  t0 = performance.now();
  const c = await owner.post(`/api/stores/${s.id}/import/confirm`, { importId: randomUUID(), items: p.body.lines.map((l: any) => l.item) });
  const confirmMs = performance.now() - t0;
  assert.equal(c.status, 200, c.raw);
  assert.equal(c.body.created, 120);
  assert.equal(c.body.matching.evaluated, 120);

  // forward: 25 per page → 25, 25, 25, 25, 20
  const seen: string[] = [];
  const positions: number[] = [];
  let cursor: string | null = null;
  const ranges: string[] = [];
  let pageMs = 0;
  for (let page = 0; page < 10; page++) {
    t0 = performance.now();
    const r: any = await owner.get(`/api/stores/${s.id}/items?limit=25${cursor ? `&cursor=${cursor}` : ''}`);
    pageMs = Math.max(pageMs, performance.now() - t0);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.total, 120, 'exact total on every page');
    ranges.push(`${r.body.rangeStart}-${r.body.rangeEnd}`);
    for (const it of r.body.items) { seen.push(it.id); positions.push(it.position); }
    cursor = r.body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(ranges, ['1-25', '26-50', '51-75', '76-100', '101-120']);
  assert.equal(new Set(seen).size, 120, 'no duplicates, nothing skipped');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'catalog order (position)');
  assert.deepEqual(seen, c.body.items.slice(0, 120), 'the order the owner pasted');
  const first = (await owner.get(`/api/stores/${s.id}/items?limit=25`)).body;
  assert.equal(first.items[0].nameAr, 'موبايل أحمر فاخر');
  assert.equal(first.items[0].price.minor, '10000');
  assert.equal(first.prevCursor, null);

  // backward from page 3 gives exactly page 2
  const p2 = (await owner.get(`/api/stores/${s.id}/items?limit=25&cursor=${first.nextCursor}`)).body;
  const p3 = (await owner.get(`/api/stores/${s.id}/items?limit=25&cursor=${p2.nextCursor}`)).body;
  const back = (await owner.get(`/api/stores/${s.id}/items?limit=25&dir=prev&cursor=${p3.prevCursor}`)).body;
  assert.deepEqual(back.items.map((x: any) => x.id), p2.items.map((x: any) => x.id));
  assert.equal(back.rangeStart, 26);
  assert.equal(back.total, 120);

  // pause 3 products → exact totals per filter
  for (const id of seen.slice(10, 13)) assert.equal((await owner.post(`/api/stores/${s.id}/items/${id}/status`, { action: 'pause' })).status, 200);
  const paused = (await owner.get(`/api/stores/${s.id}/items?status=paused&limit=2`)).body;
  assert.equal(paused.total, 3);
  assert.deepEqual([paused.rangeStart, paused.rangeEnd, paused.items.length], [1, 2, 2]);
  const p2b = (await owner.get(`/api/stores/${s.id}/items?status=paused&limit=2&cursor=${paused.nextCursor}`)).body;
  assert.deepEqual([p2b.rangeStart, p2b.rangeEnd, p2b.nextCursor], [3, 3, null]);
  assert.equal((await owner.get(`/api/stores/${s.id}/items?status=active&limit=1`)).body.total, 117);
  assert.equal((await owner.get(`/api/stores/${s.id}/items?status=active,paused&limit=1`)).body.total, 120);
  assert.deepEqual((await owner.get(`/api/stores/${s.id}`)).body.store.counts, { total: 120, active: 117, paused: 3, expired: 0, fulfilled: 0 });

  // input validation
  assert.equal((await owner.get(`/api/stores/${s.id}/items?cursor=not-a-cursor!`)).status, 400);
  assert.equal((await owner.get(`/api/stores/${s.id}/items?cursor=${Buffer.from('{"k":"x","id":"1"}').toString('base64url')}`)).body.error, 'bad_cursor');
  assert.equal((await owner.get(`/api/stores/${s.id}/items?status=closed`)).status, 400, 'deleted products are not listable');
  assert.equal((await owner.get(`/api/stores/${s.id}/items?limit=101`)).status, 400);

  console.log(`# measured (this machine, isolated test DB): preview 120 lines ${previewMs.toFixed(0)} ms; confirm 120 lines incl. inline matching ${confirmMs.toFixed(0)} ms; slowest page of 25 ${pageMs.toFixed(1)} ms`);
});

test('the 1,000-products-per-store cap is enforced at confirm (exact count, nothing half-saved)', async () => {
  const owner = new Client(h);
  await owner.register('تاجر كبير');
  const s = (await owner.post('/api/stores', { nameAr: 'المستودع الكبير', placeId: h.db.reg.placeByCode.get('sy.aleppo.azaz')!.id })).body.store;
  const all = catalogLines(1001);
  const times: number[] = [];
  for (let b = 0; b < 5; b++) {
    const items = all.slice(b * 200, b * 200 + 200).map((line) => ({ line }));
    const t0 = performance.now();
    const r = await owner.post(`/api/stores/${s.id}/import/confirm`, { importId: randomUUID(), items });
    times.push(performance.now() - t0);
    assert.equal(r.status, 200, r.raw.slice(0, 500));
    assert.equal(r.body.created, 200);
  }
  const over = await owner.post(`/api/stores/${s.id}/import/confirm`, { importId: randomUUID(), items: [{ line: all[1000]! }] });
  assert.equal(over.status, 422);
  assert.equal(over.body.error, 'product_limit');
  const st = (await owner.get(`/api/stores/${s.id}`)).body.store;
  assert.equal(st.counts.total, 1000);
  const preview = await owner.post(`/api/stores/${s.id}/import/preview`, { text: all[1000] });
  assert.equal(preview.body.limits.remaining, 0);
  // the list of a full store pages exactly
  const last = (await owner.get(`/api/stores/${s.id}/items?limit=100&dir=prev&cursor=${Buffer.from(JSON.stringify({ k: 1_000_000, id: '1' })).toString('base64url')}`)).body;
  assert.deepEqual([last.rangeStart, last.rangeEnd, last.total], [901, 1000, 1000]);
  console.log(`# measured (this machine): confirm of 200 lines into one store, 5 batches: ${times.map((t) => t.toFixed(0)).join(' / ')} ms (incl. inline matching of every new product)`);
});
