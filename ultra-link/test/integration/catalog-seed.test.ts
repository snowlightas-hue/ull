// Demo store seed (src/seed/stores-demo.ts): 25 synthetic products through the real import path, clearly labeled,
// idempotent, grouped for the demo buyer, invisible to real users.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, Client, type Harness } from './server-helpers.ts';
import { catalogRoutes } from '../../src/server/routes/catalog.ts';
import { DEMO_STORE, DEMO_STORE_LINES, seedDemoStores } from '../../src/seed/stores-demo.ts';
import { attachStoreInfo } from '../../src/catalog/match-cards.ts';

let h: Harness;
const mediaDir = mkdtempSync(join(tmpdir(), 'ul-catalog-seed-'));
before(async () => { h = await harness(`catalog_seed_${process.pid}`, { routes: [catalogRoutes({ mediaDir })], featureRoutes: false }); });
after(async () => { await h?.close(); rmSync(mediaDir, { recursive: true, force: true }); });

test('seedDemoStores: one synthetic store, 25 labeled products, idempotent, grouped matches for the demo buyer, never real', async () => {
  const logs: string[] = [];
  const r1 = await seedDemoStores(h.db.pool, h.db.reg, (s) => logs.push(s));
  assert.equal(DEMO_STORE_LINES.length, 25);
  assert.equal(r1.products, 25);
  assert.equal(r1.createdProducts, 25);
  assert.equal(r1.matches, 19, 'the 19 products at or under 300 USD');
  const r2 = await seedDemoStores(h.db.pool, h.db.reg, () => {});
  assert.deepEqual([r2.storeId, r2.products, r2.createdProducts, r2.buyerRequest], [r1.storeId, 25, 0, r1.buyerRequest], 'second run changes nothing');

  const rows = await h.db.pool.query(
    `SELECT s.realm AS store_realm, u.realm AS owner_realm, i.realm, i.title_ar, i.side FROM stores s JOIN users u ON u.id = s.owner_id
       JOIN store_items si ON si.store_id = s.id JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id`);
  assert.equal(rows.rows.length, 25);
  for (const x of rows.rows) {
    assert.deepEqual([x.store_realm, x.owner_realm, x.realm, x.side], ['synthetic', 'synthetic', 'synthetic', 'provide']);
    assert.match(x.title_ar, /\(تجريبي\)$/);
  }

  // the demo owner can log in and sees «متجري» with the store labeled synthetic
  const owner = new Client(h);
  assert.equal((await owner.post('/api/auth/demo-login', { handle: DEMO_STORE.ownerHandle })).status, 200);
  const stores = (await owner.get('/api/stores')).body.items;
  assert.equal(stores.length, 1);
  assert.equal(stores[0].labelAr, 'أبو أحمد للموبايلات (تجريبي)');
  assert.equal(stores[0].counts.active, 25);

  // the demo buyer sees many products of ONE store for ONE request → «19 منتجًا من متجر … (تجريبي)»
  const buyer = new Client(h);
  assert.equal((await buyer.post('/api/auth/demo-login', { handle: DEMO_STORE.buyerHandle })).status, 200);
  const me = (await buyer.get('/api/me')).body.user;
  const page = (await buyer.get(`/api/matches?intent=${r1.buyerRequest}&limit=50`)).body;
  assert.equal(page.total, 19);
  const uid = (await h.db.pool.query('SELECT id FROM users WHERE public_id = $1', [me.publicId])).rows[0].id;
  await attachStoreInfo(h.db.pool, h.db.reg, String(uid), page.items);
  assert.ok(page.items.every((m: any) => m.store?.id === r1.storeId));
  assert.equal(page.items[0].store.groupLabelAr, '19 منتجًا من متجر أبو أحمد للموبايلات (تجريبي)');

  // a real user asking for the same thing sees none of it
  const real = new Client(h);
  await real.register('مستخدم حقيقي');
  const saved = await real.dialogue('بدي موبايل بإعزاز حتى ٣٠٠ دولار');
  const run = await real.post(`/api/intents/${saved.intent.id}/match`);
  assert.equal(run.body.totals.confirmed + run.body.totals.possible, 0);
  assert.ok(logs.some((l) => l.includes('25 synthetic products')));
});
