// Stores & catalog over HTTP (src/server/routes/catalog.ts) on an isolated database: store profile + limits, bulk
// preview (15+ Levantine lines), idempotent confirm, products matching a real seeker through the unchanged engine,
// price edit → invalidation, store pause/resume → products paused/resumed → matches invalidated/restored, product
// delete, 404/401 isolation, and synthetic/real separation.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, Client, mkPersona, type Harness } from './server-helpers.ts';
import { catalogRoutes } from '../../src/server/routes/catalog.ts';
import { closeTolerant } from './catalog-helpers.ts';
import { attachStoreInfo } from '../../src/catalog/match-cards.ts';

let h: Harness;
const mediaDir = mkdtempSync(join(tmpdir(), 'ul-catalog-api-'));
before(async () => { h = await harness(`catalog_api_${process.pid}`, { routes: [catalogRoutes({ mediaDir })], featureRoutes: false }); });
after(async () => { await closeTolerant(h); rmSync(mediaDir, { recursive: true, force: true }); });

const AZAZ = () => h.db.reg.placeByCode.get('sy.aleppo.azaz')!.id;
const AFRIN = () => h.db.reg.placeByCode.get('sy.aleppo.afrin')!.id;

async function mkStore(c: Client, name = 'محل أبو أحمد للموبايلات', placeId = AZAZ()) {
  const r = await c.post('/api/stores', { nameAr: name, descriptionAr: 'موبايلات وإكسسوارات', placeId, contactPref: 'chat', hoursAr: 'من ٩ للـ ٨' });
  assert.equal(r.status, 200, r.raw);
  return r.body.store as { id: string; version: number; status: string; synthetic: boolean; labelAr: string };
}

/** preview → confirm every ok line (the items exactly as the preview proposed them) */
async function importLines(c: Client, storeId: string, text: string, opts: { importId?: string; defaultCurrency?: string } = {}) {
  const p = await c.post(`/api/stores/${storeId}/import/preview`, { text, defaultCurrency: opts.defaultCurrency });
  assert.equal(p.status, 200, p.raw);
  const items = p.body.lines.filter((l: any) => l.ok).map((l: any) => l.item);
  const r = await c.post(`/api/stores/${storeId}/import/confirm`, { importId: opts.importId ?? randomUUID(), items, defaultCurrency: opts.defaultCurrency });
  assert.equal(r.status, 200, r.raw);
  return { preview: p.body, confirm: r.body };
}

async function seekerRequest(c: Client, text: string): Promise<string> {
  const res = await c.dialogue(text);
  assert.equal(res.action, 'saved', JSON.stringify(res).slice(0, 400));
  return res.intent.id as string;
}

async function matchesOf(c: Client, intentId: string, state = 'all') {
  const r = await c.get(`/api/matches?intent=${intentId}&state=${state}&limit=50`);
  assert.equal(r.status, 200, r.raw);
  return r.body.items as any[];
}

test('store profile: create, read, edit with version, per-owner cap of 5, realm from the owner, validation', async () => {
  const owner = new Client(h);
  await owner.register('أبو أحمد');
  const s = await mkStore(owner);
  assert.equal(s.status, 'active');
  assert.equal(s.synthetic, false);
  const got = await owner.get(`/api/stores/${s.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.store.placeAr, 'إعزاز');
  assert.deepEqual(got.body.store.counts, { total: 0, active: 0, paused: 0, expired: 0, fulfilled: 0 });
  const ed = await owner.patch(`/api/stores/${s.id}`, { expectedVersion: s.version, nameAr: 'أبو أحمد للموبايلات', hoursAr: '' });
  assert.equal(ed.status, 200, ed.raw);
  assert.equal(ed.body.store.nameAr, 'أبو أحمد للموبايلات');
  assert.equal(ed.body.store.hoursAr, null);
  assert.equal((await owner.patch(`/api/stores/${s.id}`, { expectedVersion: s.version, nameAr: 'قديم' })).status, 409, 'stale version');
  assert.equal((await owner.post('/api/stores', { nameAr: 'x', placeId: AZAZ() })).status, 400, 'name too short');
  assert.equal((await owner.post('/api/stores', { nameAr: 'متجر', placeId: h.db.reg.rootPlaceId })).status, 422, 'a store needs a real place');
  assert.equal((await owner.post('/api/stores', { nameAr: 'متجر', placeId: 999_999 })).status, 422);
  for (let i = 2; i <= 5; i++) await mkStore(owner, `متجر رقم ${i}`);
  const sixth = await owner.post('/api/stores', { nameAr: 'المتجر السادس', placeId: AZAZ() });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.error, 'store_limit');
  assert.equal((await owner.get('/api/stores')).body.items.length, 5);

  // a synthetic (demo) owner's store is synthetic — the realm is the owner's, never the client's
  await mkPersona(h.db.pool, 'cat_demo_owner');
  const demo = new Client(h);
  assert.equal((await demo.post('/api/auth/demo-login', { handle: 'cat_demo_owner' })).status, 200);
  const ds = await mkStore(demo, 'متجر تجريبي');
  assert.equal(ds.synthetic, true);
  assert.equal(ds.labelAr, 'متجر تجريبي (تجريبي)');
  const row = (await h.db.pool.query('SELECT realm FROM stores WHERE public_id = $1', [ds.id])).rows[0];
  assert.equal(row.realm, 'synthetic');
});

test('bulk import: preview of 20 Levantine lines over HTTP, nothing saved until confirm; confirm is idempotent by importId', async () => {
  const owner = new Client(h);
  await owner.register('صاحب محل');
  const s = await mkStore(owner);
  const text = [
    'ايفون 12 مستعمل - 300$', 'شاحن سامسونج ١٠ دولار', 'سامسونج A52 جديد ٣٠٠$', 'لابتوب ديل 300 دولار', 'براد سامسونج ١٠ آلاف ليرة تركي',
    'غسالة بـ٥٠ الف', 'كنباية 3 مقاعد 150 دولار', 'جاكيت جلد 25$', 'كيلو بندورة ٥ ليرات', 'شاشة 32 انش', 'مكيف جديد 400 دولار قابل للتفاوض',
    'ايباد 2 مستعمل نظيف ٢٠٠ دولار', 'تلفون نوكيا 20 يورو', 'صباط رياضي 1500 ليرة تركية', 'فرن غاز 2 مليون ليرة سورية', '$250 لابتوب لينوفو',
    'موبايل شاومي ٣٠٠٠ ليرة', 'ايفون 12 مستعمل ٣١٠$', 'سيارة كيا ريو 2015 للايجار 30 دولار باليوم', 'كفر ايفون ٥$',
  ].join('\n');
  const p = await owner.post(`/api/stores/${s.id}/import/preview`, { text });
  assert.equal(p.status, 200, p.raw);
  assert.equal(p.body.summary.total, 20);
  const by = (n: number) => p.body.lines.find((l: any) => l.lineNo === n);
  assert.deepEqual(by(1).price, { minor: '30000', amount: '300', currency: 'USD', unit: 'total', negotiable: false });
  assert.equal(by(1).categoryAr, 'إلكترونيات');
  assert.deepEqual(by(5).price.minor, '1000000');
  assert.equal(by(5).price.currency, 'TRY');
  assert.deepEqual(by(6).problems.map((x: any) => x.code), ['missing_currency']);
  assert.deepEqual(by(9).problems.map((x: any) => x.code), ['unknown_category', 'ambiguous_lira']);
  assert.deepEqual(by(10).problems.map((x: any) => x.code), ['missing_price']);
  assert.deepEqual(by(18).problems.map((x: any) => x.code), ['duplicate_in_batch']);
  assert.equal(p.body.summary.ok, 15);
  assert.equal(p.body.limits.remaining, 1000);
  assert.equal((await owner.get(`/api/stores/${s.id}/items`)).body.total, 0, 'preview saves nothing');

  // the owner fixes «غسالة بـ٥٠ الف» (currency) and unchecks the rest of the problem lines
  const items = p.body.lines.filter((l: any) => l.ok).map((l: any) => l.item);
  items.push({ ...by(6).item, currency: 'TRY' });
  const importId = randomUUID();
  const c1 = await owner.post(`/api/stores/${s.id}/import/confirm`, { importId, items });
  assert.equal(c1.status, 200, c1.raw);
  assert.equal(c1.body.created, 16);
  assert.equal(c1.body.replay, false);
  assert.equal(c1.body.items.length, 16);
  const washer = c1.body.products.find((x: any) => x.nameAr === 'غسالة');
  assert.equal(washer.price.minor, '5000000');
  assert.equal(washer.price.currency, 'TRY');
  assert.equal(washer.side, 'provide');
  // a retried confirm (same importId, same list) is a no-op that returns the first result
  const c2 = await owner.post(`/api/stores/${s.id}/import/confirm`, { importId, items });
  assert.equal(c2.status, 200, c2.raw);
  assert.equal(c2.body.replay, true);
  assert.deepEqual(c2.body.items, c1.body.items);
  // concurrent double-click: both answer the same ids, still 16 products
  const [d1, d2] = await Promise.all([1, 2].map(() => owner.post(`/api/stores/${s.id}/import/confirm`, { importId, items })));
  assert.deepEqual([d1!.status, d2!.status], [200, 200]);
  assert.equal((await owner.get(`/api/stores/${s.id}/items?limit=100`)).body.total, 16);
  const intents = await h.db.pool.query("SELECT count(*)::int AS n FROM intents i JOIN store_items si ON si.vertical_id = i.vertical_id AND si.intent_id = i.id WHERE i.side = 'provide'");
  assert.equal(intents.rows[0].n, 16);
  // the same importId with a different list is refused
  const c3 = await owner.post(`/api/stores/${s.id}/import/confirm`, { importId, items: items.slice(0, 2) });
  assert.equal(c3.status, 409);
  assert.equal(c3.body.error, 'import_id_reused');
  // a line with a problem refuses the whole confirm (nothing half-saved), with per-line problems
  const bad = await owner.post(`/api/stores/${s.id}/import/confirm`, { importId: randomUUID(), items: [{ line: 'سماعة جديدة 20 دولار', categoryCode: 'goods.electronics' }, { line: 'شاشة 32 انش' }] });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'import_invalid');
  assert.deepEqual(bad.body.lines.map((l: any) => l.problems.map((x: any) => x.code)), [['missing_price']]);
  // re-importing a product that now exists is flagged as a duplicate of the existing product
  const again = await owner.post(`/api/stores/${s.id}/import/preview`, { text: 'ايفون 12 مستعمل 280$' });
  assert.deepEqual(again.body.lines[0].problems.map((x: any) => x.code), ['duplicate_existing']);
  assert.equal(again.body.lines[0].duplicateOf.nameAr, 'ايفون 12 مستعمل');
  // limits
  const tooMany = await owner.post(`/api/stores/${s.id}/import/preview`, { text: Array.from({ length: 201 }, (_, i) => `ايفون ${i} 100$`).join('\n') });
  assert.equal(tooMany.status, 422);
  assert.equal(tooMany.body.error, 'too_many_lines');
  assert.equal((await owner.post(`/api/stores/${s.id}/import/preview`, { text: '\n \n' })).status, 422);
});

test('products match an existing seeker through the unchanged engine; price edit invalidates; store pause/resume; delete', async () => {
  const seeker = new Client(h);
  const seekerUser = await seeker.register('باحث عن موبايل');
  const want = await seekerRequest(seeker, 'بدي ايفون بإعزاز حتى ٣٥٠ دولار');
  assert.equal((await matchesOf(seeker, want)).length, 0, 'nothing yet');

  const owner = new Client(h);
  await owner.register('أبو أحمد');
  const s = await mkStore(owner, 'أبو أحمد للموبايلات');
  const { confirm } = await importLines(owner, s.id, 'ايفون 12 مستعمل - 300$\nايفون 11 نظيف ٢٥٠ دولار\nايفون 13 برو 500$\nبراد سامسونج 200$');
  assert.equal(confirm.created, 4);
  assert.ok(confirm.matching.evaluated >= 4);
  const iphone12 = confirm.products.find((x: any) => x.nameAr === 'ايفون 12 مستعمل');

  // the seeker now has confirmed matches with reasons (300 and 250 fit «حتى 350»; 500 does not; a fridge is another category)
  let ms = await matchesOf(seeker, want, 'active');
  assert.deepEqual(ms.map((m) => m.other.titleAr).sort(), ['ايفون 11 نظيف', 'ايفون 12 مستعمل']);
  const m12 = ms.find((m) => m.other.id === iphone12.id);
  assert.equal(m12.state, 'confirmed');
  assert.ok(m12.reasons.some((r: any) => r.polarity === 'plus' && /السعر|سعر/.test(r.text)), JSON.stringify(m12.reasons));
  assert.ok(m12.reasons.some((r: any) => r.code.startsWith('place')), 'a place reason');
  // a notification reached the seeker (the owner, who was looking at the import result, was not spammed)
  const notes = await seeker.get('/api/notifications');
  assert.ok(notes.body.items.some((n: any) => n.kind === 'match_new'));

  // store grouping info for the match list (the integrator calls attachStoreInfo next to decorateMatchCards)
  await attachStoreInfo(h.db.pool, h.db.reg, seekerUser.id, ms);
  assert.equal(ms[0].store.id, s.id);
  assert.equal(ms[0].store.requestMatches, 2);
  assert.equal(ms[0].store.groupLabelAr, 'منتجان من متجر أبو أحمد للموبايلات');
  assert.deepEqual(ms[0].other.photos, []);

  // price edit: 300 → 400 → above the seeker's max → that match is invalidated with the reason
  const edit = await owner.patch(`/api/stores/${s.id}/items/${iphone12.id}`, { expectedVersion: iphone12.version, amount: '400' });
  assert.equal(edit.status, 200, edit.raw);
  assert.equal(edit.body.item.price.minor, '40000');
  assert.equal(edit.body.item.version, iphone12.version + 1);
  assert.ok(edit.body.matching.invalidated >= 1);
  ms = await matchesOf(seeker, want, 'all');
  const after12 = ms.find((m) => m.other.id === iphone12.id);
  assert.equal(after12.state, 'invalidated');
  assert.match(after12.invalidReasonAr, /السعر|أعلى/);
  assert.equal((await owner.patch(`/api/stores/${s.id}/items/${iphone12.id}`, { expectedVersion: iphone12.version, amount: '290' })).status, 409, 'stale version');
  const back = await owner.patch(`/api/stores/${s.id}/items/${iphone12.id}`, { expectedVersion: iphone12.version + 1, amount: '290' });
  assert.equal(back.status, 200);
  assert.equal((await matchesOf(seeker, want, 'all')).find((m) => m.other.id === iphone12.id).state, 'confirmed', 'fits again → confirmed again');

  // the owner pauses ONE product by hand, then pauses the store: every product paused, the seeker's matches invalidated
  const iphone11 = confirm.products.find((x: any) => x.nameAr === 'ايفون 11 نظيف');
  assert.equal((await owner.post(`/api/stores/${s.id}/items/${iphone11.id}/status`, { action: 'pause' })).status, 200);
  const paused = await owner.post(`/api/stores/${s.id}/status`, { action: 'pause' });
  assert.equal(paused.status, 200, paused.raw);
  assert.equal(paused.body.store.status, 'paused');
  assert.equal(paused.body.changed, 3, 'the 3 still-active products (one was already paused by hand)');
  assert.deepEqual(paused.body.store.counts, { total: 4, active: 0, paused: 4, expired: 0, fulfilled: 0 });
  assert.equal((await matchesOf(seeker, want, 'active')).length, 0, 'no live match while the store is paused');
  assert.ok((await matchesOf(seeker, want, 'invalidated')).every((m) => m.state === 'invalidated'));
  assert.equal((await owner.post(`/api/stores/${s.id}/status`, { action: 'pause' })).status, 409);
  const blocked = await owner.post(`/api/stores/${s.id}/items/${iphone12.id}/status`, { action: 'resume' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'store_paused');
  // resume: exactly what the store paused comes back; the hand-paused product stays paused
  const resumed = await owner.post(`/api/stores/${s.id}/status`, { action: 'resume' });
  assert.equal(resumed.status, 200, resumed.raw);
  assert.equal(resumed.body.changed, 3);
  assert.deepEqual(resumed.body.store.counts, { total: 4, active: 3, paused: 1, expired: 0, fulfilled: 0 });
  ms = await matchesOf(seeker, want, 'active');
  assert.deepEqual(ms.map((m) => [m.other.id, m.state]), [[iphone12.id, 'confirmed']], 'restored (iPhone 11 is still paused by its owner)');

  // delete = close the intent + unlink: gone from the store, the match is invalidated
  const del = await owner.post(`/api/stores/${s.id}/items/${iphone12.id}/status`, { action: 'delete' });
  assert.equal(del.status, 200, del.raw);
  assert.equal(del.body.item, null);
  assert.equal((await owner.get(`/api/stores/${s.id}/items/${iphone12.id}`)).status, 404);
  assert.equal((await owner.get(`/api/stores/${s.id}`)).body.store.counts.total, 3);
  assert.equal((await matchesOf(seeker, want, 'all')).find((m) => m.other.id === iphone12.id).state, 'invalidated');
  const closed = await h.db.pool.query("SELECT status FROM intents i JOIN intent_refs r ON r.vertical_id = i.vertical_id AND r.intent_id = i.id WHERE r.public_id = $1", [iphone12.id]);
  assert.equal(closed.rows[0].status, 'closed');

  // moving the store moves its products (new versions → re-match): إعزاز → عفرين is outside «بإعزاز»
  const st = (await owner.get(`/api/stores/${s.id}`)).body.store;
  const moved = await owner.patch(`/api/stores/${s.id}`, { expectedVersion: st.version, placeId: AFRIN() });
  assert.equal(moved.status, 200, moved.raw);
  assert.equal(moved.body.store.placeAr, 'عفرين');
  const items = (await owner.get(`/api/stores/${s.id}/items?limit=50`)).body.items;
  assert.ok(items.every((x: any) => x.placeAr === 'عفرين'));
  assert.equal((await matchesOf(seeker, want, 'active')).length, 0);
});

test('isolation: another user gets 404 on every store/product/import/photo route; logged out gets 401', async () => {
  const owner = new Client(h);
  await owner.register('مالك');
  const s = await mkStore(owner);
  const { confirm } = await importLines(owner, s.id, 'ايفون 8 100$');
  const item = confirm.products[0];
  const other = new Client(h);
  await other.register('متطفل');
  const anon = new Client(h);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const routes: [string, string, unknown?][] = [
    ['GET', `/api/stores/${s.id}`], ['PATCH', `/api/stores/${s.id}`, { expectedVersion: 1, nameAr: 'مسروق' }],
    ['POST', `/api/stores/${s.id}/status`, { action: 'pause' }], ['GET', `/api/stores/${s.id}/items`],
    ['GET', `/api/stores/${s.id}/items/${item.id}`], ['PATCH', `/api/stores/${s.id}/items/${item.id}`, { expectedVersion: 1, amount: '1' }],
    ['POST', `/api/stores/${s.id}/items/${item.id}/status`, { action: 'delete' }],
    ['POST', `/api/stores/${s.id}/import/preview`, { text: 'ايفون 100$' }],
    ['POST', `/api/stores/${s.id}/import/confirm`, { importId: randomUUID(), items: [{ line: 'ايفون X 100$' }] }],
    ['DELETE', `/api/stores/${s.id}/items/${item.id}/photos/${randomUUID()}`],
  ];
  for (const [m, url, body] of routes) {
    const r = await other.call(m as any, url, body);
    assert.equal(r.status, 404, `${m} ${url} as another user → ${r.status} ${r.raw}`);
    const a = await anon.call(m as any, url, body);
    assert.equal(a.status, 401, `${m} ${url} logged out → ${a.status}`);
  }
  const up = await h.app.inject({ method: 'POST', url: `/api/stores/${s.id}/items/${item.id}/photos`, payload: png, headers: { 'content-type': 'image/png', cookie: other.cookie } });
  assert.equal(up.statusCode, 404);
  assert.equal((await other.get('/api/stores')).body.items.length, 0, 'the list is per owner');
  // using the owner's product id under the intruder's own store is still 404
  const mine = await mkStore(other, 'متجر المتطفل');
  assert.equal((await other.get(`/api/stores/${mine.id}/items/${item.id}`)).status, 404);
  // nothing changed
  const still = await owner.get(`/api/stores/${s.id}`);
  assert.equal(still.body.store.status, 'active');
  assert.equal(still.body.store.counts.total, 1);
});

test('synthetic stores never match real users (and do match synthetic ones)', async () => {
  await mkPersona(h.db.pool, 'cat_syn_shop');
  const shop = new Client(h);
  await shop.post('/api/auth/demo-login', { handle: 'cat_syn_shop' });
  const s = await mkStore(shop, 'متجر تجريبي للموبايلات');
  assert.equal(s.synthetic, true);
  const { confirm } = await importLines(shop, s.id, 'ايفون 12 برو ماكس 320$');
  const product = confirm.products[0];
  assert.equal(product.synthetic, true);
  assert.equal(product.titleAr, 'ايفون 12 برو ماكس (تجريبي)');

  // a REAL shop sells the same phone, so the real seeker has a real counterpart
  const realShop = new Client(h);
  await realShop.register('محل حقيقي');
  const rs = await mkStore(realShop, 'محل الأمل');
  const realProduct = (await importLines(realShop, rs.id, 'ايفون 12 برو ماكس 330$')).confirm.products[0];

  const real = new Client(h);
  await real.register('مستخدم حقيقي');
  const realWant = await seekerRequest(real, 'بدي ايفون 12 برو ماكس بإعزاز حتى ٤٠٠ دولار');
  const run = await real.post(`/api/intents/${realWant}/match`);
  assert.equal(run.status, 200, run.raw);
  const realMatches = await matchesOf(real, realWant, 'all');
  assert.ok(realMatches.some((m) => m.other.id === realProduct.id), 'the real seeker matches the real product');
  assert.ok(realMatches.every((m) => m.other.id !== product.id && m.other.synthetic === false), 'but never the synthetic product');
  // and the engine's realm check, not only retrieval, refuses the pair
  const pairs = await h.db.pool.query(
    `SELECT count(*)::int AS n FROM matches m JOIN intent_refs r ON r.vertical_id = m.vertical_id AND r.intent_id = m.b_intent_id WHERE r.public_id = $1 AND m.a_user_id = (SELECT id FROM users WHERE display_name = 'مستخدم حقيقي')`, [product.id]);
  assert.equal(pairs.rows[0].n, 0);

  await mkPersona(h.db.pool, 'cat_syn_buyer');
  const synBuyer = new Client(h);
  await synBuyer.post('/api/auth/demo-login', { handle: 'cat_syn_buyer' });
  const synWant = await seekerRequest(synBuyer, 'بدي ايفون 12 برو ماكس بإعزاز حتى ٤٠٠ دولار');
  assert.equal((await synBuyer.post(`/api/intents/${synWant}/match`)).status, 200);
  const sm = await matchesOf(synBuyer, synWant, 'active');
  assert.deepEqual(sm.map((m) => m.other.id), [product.id], 'synthetic ↔ synthetic matches');
  // database invariant: a store item is a provide intent of the store owner in the store's realm
  const rows = await h.db.pool.query(
    `SELECT count(*)::int AS bad FROM store_items si JOIN stores s ON s.id = si.store_id JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id
      WHERE i.user_id <> s.owner_id OR i.realm <> s.realm OR i.side <> 'provide'`);
  assert.equal(rows.rows[0].bad, 0);
  const realIntent = await h.db.pool.query("SELECT i.vertical_id, i.id FROM intents i WHERE i.realm = 'real' AND i.side = 'seek' LIMIT 1");
  await assert.rejects(h.db.pool.query('INSERT INTO store_items (vertical_id, intent_id, store_id, position, name_ar, name_norm) SELECT $1, $2, s.id, 999, $3, $3 FROM stores s WHERE s.public_id = $4',
    [realIntent.rows[0].vertical_id, realIntent.rows[0].id, 'x', s.id]), /not a provide intent of the store owner/);
});
