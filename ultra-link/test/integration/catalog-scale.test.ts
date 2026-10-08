// OPT-IN scale measurement for docs/CATALOG.md §7 (skipped unless UL_CATALOG_SCALE=1):
//
//   UL_CATALOG_SCALE=1 node --test --test-concurrency=1 test/integration/catalog-scale.test.ts
//   (UL_CATALOG_STORES=1000 UL_CATALOG_PER_STORE=1000 UL_CATALOG_SEEKERS=500 by default)
//
// Bulk-loads STORES × PER_STORE real products (ordinary provide intents + refs + scope keys + store_items, spread over
// every city of the registry) and SEEKERS electronics requests in إعزاز into an isolated database, then measures the
// catalog's own queries (p50/p95 over 30 runs), shows their plans, and times one 200-line confirm through the real
// service (createIntent + store_items + inline matching against the seekers) and one seeker's match run against the
// product volume. Prints numbers; asserts only plan shapes (index use), never a timing.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, type TestDb } from '../helpers/testdb.ts';
import { dropDb } from './server-helpers.ts';
import { existingNames, listItems, storeCounts } from '../../src/catalog/repo.ts';
import { attachStoreInfo } from '../../src/catalog/match-cards.ts';
import { confirmImport } from '../../src/catalog/service.ts';
import { matchIntent } from '../../src/matching/engine.ts';
import type { SessionUser } from '../../src/repo/users.ts';

const ON = process.env.UL_CATALOG_SCALE === '1';
const STORES = Number(process.env.UL_CATALOG_STORES ?? 1000);
const PER = Number(process.env.UL_CATALOG_PER_STORE ?? 1000);
const SEEKERS = Number(process.env.UL_CATALOG_SEEKERS ?? 500);
let db: TestDb;
before(async () => { if (ON) db = await freshDb(`catalog_scale_${process.pid}`); });
after(async () => { if (ON && db) { await db.close(); await dropDb(db.name); } });

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!; };
async function timeIt(n: number, fn: () => Promise<unknown>): Promise<string> {
  for (let i = 0; i < 3; i++) await fn(); // warm
  const ts: number[] = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); }
  return `p50 ${pct(ts, 50).toFixed(2)} ms, p95 ${pct(ts, 95).toFixed(2)} ms`;
}
async function plan(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`, params);
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

test('catalog at scale: list / count / names / store badges / 200-line confirm / seeker match', { skip: !ON && 'set UL_CATALOG_SCALE=1 to run' }, async () => {
  const c = await db.pool.connect();
  const azaz = db.reg.placeByCode.get('sy.aleppo.azaz')!;
  const t0 = performance.now();
  try {
    await c.query('SET maintenance_work_mem = \'256MB\'');
    await c.query(`CREATE TEMP TABLE cities AS SELECT id, lft, row_number() OVER (ORDER BY id) - 1 AS k FROM places WHERE kind = 'city'`);
    const ncities = (await c.query('SELECT count(*)::int AS n FROM cities')).rows[0].n as number;
    await c.query(`CREATE TEMP TABLE owners AS WITH u AS (INSERT INTO users (display_name, realm) SELECT 'تاجر ' || g, 'real' FROM generate_series(1, $1) g RETURNING id)
                   SELECT id, row_number() OVER (ORDER BY id) AS n FROM u`, [STORES]);
    await c.query(`INSERT INTO stores (owner_id, realm, name_ar, place_id, next_position)
                   SELECT o.id, 'real', 'متجر ' || o.n, ci.id, $2 + 1 FROM owners o JOIN cities ci ON ci.k = (o.n - 1) % $1`, [ncities, PER]);
    await c.query(`INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar, point_place_id, point_lft,
                     price_op, price_lo, price_hi, currency, price_unit, price_strength, attrs, expires_at, created_at, updated_at)
                   SELECT 6, s.owner_id, 'real', 'provide', 601, 1, 'منتج ' || s.id || '-' || g, s.place_id, ci.lft,
                     'eq', 1000 + (g * 37 % 90000), 1000 + (g * 37 % 90000), 'USD', 'total', 'required', '{"condition":"used"}',
                     now() + interval '60 days', now() - make_interval(secs => g), now()
                     FROM stores s JOIN cities ci ON ci.id = s.place_id, generate_series(1, $1) g`, [PER]);
    await c.query(`INSERT INTO intent_refs (public_id, vertical_id, intent_id, user_id) SELECT public_id, vertical_id, id, user_id FROM intents WHERE side = 'provide'`);
    await c.query(`INSERT INTO intent_scopes (vertical_id, intent_id, realm, side, deal_type_id, category_id, place_id) SELECT vertical_id, id, realm, side, deal_type_id, category_id, 1 FROM intents WHERE side = 'provide'`);
    // bulk load only: the per-row invariant trigger is checked by construction here (same owner, realm, side)
    await c.query('ALTER TABLE store_items DISABLE TRIGGER store_items_check_trg');
    await c.query(`INSERT INTO store_items (vertical_id, intent_id, store_id, position, name_ar, name_norm)
                   SELECT i.vertical_id, i.id, s.id, row_number() OVER (PARTITION BY s.id ORDER BY i.id), i.title_ar, i.title_ar
                     FROM intents i JOIN stores s ON s.owner_id = i.user_id WHERE i.side = 'provide'`);
    await c.query('ALTER TABLE store_items ENABLE TRIGGER store_items_check_trg');
    // seekers: electronics in إعزاز, «حتى N دولار»
    await c.query(`CREATE TEMP TABLE seekers AS WITH u AS (INSERT INTO users (display_name, realm) SELECT 'باحث ' || g, 'real' FROM generate_series(1, $1) g RETURNING id) SELECT id FROM u`, [SEEKERS]);
    await c.query(`INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar, scope_place_ids, scope_strength, price_op, price_hi, currency, price_unit, price_strength, expires_at)
                   SELECT 6, id, 'real', 'seek', 601, 1, 'موبايل للشراء', ARRAY[$1::int], 'required', 'lte', 20000 + (id % 50) * 1000, 'USD', 'total', 'required', now() + interval '30 days' FROM seekers`, [azaz.id]);
    await c.query(`INSERT INTO intent_refs (public_id, vertical_id, intent_id, user_id) SELECT public_id, vertical_id, id, user_id FROM intents WHERE side = 'seek'`);
    await c.query(`INSERT INTO intent_scopes (vertical_id, intent_id, realm, side, deal_type_id, category_id, place_id) SELECT vertical_id, id, realm, side, deal_type_id, category_id, $1 FROM intents WHERE side = 'seek'`, [azaz.id]);
  } finally { c.release(); }
  await db.pool.query('VACUUM (ANALYZE)');
  const loadMs = performance.now() - t0;
  const n = (await db.pool.query('SELECT count(*)::int AS n FROM store_items')).rows[0].n;
  assert.equal(n, STORES * PER);
  const big = (await db.pool.query(`SELECT s.id, s.public_id, s.owner_id FROM stores s JOIN places p ON p.id = s.place_id WHERE p.code = 'sy.aleppo.azaz' ORDER BY s.id LIMIT 1`)).rows[0];
  const storeId = String(big.id);
  const out: string[] = [`bulk load ${STORES} stores × ${PER} products + ${SEEKERS} seekers + VACUUM ANALYZE: ${(loadMs / 1000).toFixed(1)} s (setup only: one INSERT…SELECT per table, per-row FK checks)`];
  const size = async (rel: string) => Number((await db.pool.query('SELECT pg_total_relation_size($1::regclass) AS b', [rel])).rows[0].b);
  const itemsBytes = await size('store_items');
  const goods = await size('intents_goods');
  out.push(`sizes: store_items ${(itemsBytes / 1048576).toFixed(1)} MB incl. indexes (${(itemsBytes / n).toFixed(0)} B per product); intents_goods ${(goods / 1048576).toFixed(1)} MB (${(goods / (n + SEEKERS)).toFixed(0)} B per intent); stores ${(await size('stores') / 1024).toFixed(0)} kB`);

  out.push(`listItems first page (20, all statuses): ${await timeIt(30, () => listItems(db.pool, db.reg, storeId, { statuses: ['active', 'paused', 'expired', 'fulfilled'], limit: 20 }))}`);
  const half = Math.floor(PER / 2);
  const mid = Buffer.from(JSON.stringify({ k: half, id: '1' })).toString('base64url');
  out.push(`listItems page after position ${half}: ${await timeIt(30, () => listItems(db.pool, db.reg, storeId, { statuses: ['active'], cursor: mid, limit: 20 }))}`);
  out.push(`storeCounts (exact per-status totals of one store): ${await timeIt(30, () => storeCounts(db.pool, [storeId]))}`);
  out.push(`existingNames (duplicate check, ${PER} names): ${await timeIt(30, () => existingNames(db.pool, storeId))}`);
  const ids = (await db.pool.query('SELECT r.public_id FROM store_items si JOIN intent_refs r ON r.vertical_id = si.vertical_id AND r.intent_id = si.intent_id WHERE si.store_id = $1 ORDER BY si.position LIMIT 20', [storeId])).rows.map((r) => r.public_id);
  const seekerRef = (await db.pool.query("SELECT r.public_id, r.user_id FROM intent_refs r JOIN intents i ON i.vertical_id = r.vertical_id AND i.id = r.intent_id WHERE i.side = 'seek' LIMIT 1")).rows[0];
  out.push(`attachStoreInfo on 20 match cards: ${await timeIt(30, () => attachStoreInfo(db.pool, db.reg, String(seekerRef.user_id), ids.map((id) => ({ state: 'confirmed', mine: { id: seekerRef.public_id }, other: { id, status: 'active' } }))))}`);

  const listPlan = await plan(`SELECT si.position FROM store_items si JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id WHERE si.store_id = $1 AND i.status = ANY($2) AND si.position > $3 ORDER BY si.position LIMIT 21`, [storeId, ['active'], half]);
  assert.match(listPlan, /store_items_position_key/, listPlan);
  const countPlan = await plan(`SELECT count(*) FROM store_items si JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id WHERE si.store_id = $1 AND i.status = ANY($2)`, [storeId, ['active']]);
  assert.match(countPlan, /store_items_position_key|store_items_name_idx/, countPlan);
  console.log(`# plan: list page\n${listPlan.split('\n').map((l) => '#   ' + l).join('\n')}`);

  // a 200-line confirm into a fresh store in إعزاز, where SEEKERS requests wait (inline matching evaluates them all)
  const ownerRow = (await db.pool.query("INSERT INTO users (display_name, realm) VALUES ('تاجر جديد', 'real') RETURNING id, public_id")).rows[0];
  const owner: SessionUser = { id: String(ownerRow.id), publicId: ownerRow.public_id, displayName: 'تاجر جديد', realm: 'real', handle: null };
  const st = (await db.pool.query(`INSERT INTO stores (owner_id, realm, name_ar, place_id) VALUES ($1, 'real', 'متجر جديد', $2) RETURNING public_id`, [owner.id, azaz.id])).rows[0].public_id;
  const items = Array.from({ length: 200 }, (_, i) => ({ line: `موبايل ${['أحمر', 'أزرق', 'أسود', 'أبيض', 'ذهبي'][i % 5]} ${['فاخر', 'عادي', 'صغير', 'كبير'][Math.floor(i / 5) % 4]} ${['ممتاز', 'أصلي', 'مكفول', 'مضمون', 'حديث', 'خفيف', 'قوي', 'أنيق', 'عملي', 'جميل'][Math.floor(i / 20)]} ${150 + i} دولار` }));
  let t1 = performance.now();
  const res = await confirmImport(db.pool, db.reg, owner, st, { importId: randomUUID(), defaults: {}, items });
  const confirmMs = performance.now() - t1;
  assert.equal(res.created, 200);
  out.push(`confirm 200 lines into a store in إعزاز (${STORES * PER} products in the DB, ${SEEKERS} seekers there): ${(confirmMs / 1000).toFixed(2)} s total; inline matching evaluated ${res.matching?.evaluated} products → ${res.matching?.confirmed} confirmed + ${res.matching?.possible} possible pairs`);

  // a seeker's request in a city holding ~PER×STORES/cities products: the engine's candidate cap applies
  const sk = (await db.pool.query("INSERT INTO users (display_name, realm) VALUES ('باحث جديد', 'real') RETURNING id")).rows[0].id;
  const iv = (await db.pool.query(`INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar, scope_place_ids, scope_strength, price_op, price_hi, currency, price_unit, price_strength, expires_at)
       VALUES (6, $1, 'real', 'seek', 601, 1, 'موبايل', ARRAY[$2::int], 'required', 'lte', 30000, 'USD', 'total', 'required', now() + interval '30 days') RETURNING id, public_id`, [sk, azaz.id])).rows[0];
  await db.pool.query('INSERT INTO intent_refs (public_id, vertical_id, intent_id, user_id) VALUES ($1, 6, $2, $3)', [iv.public_id, iv.id, sk]);
  const inCity = (await db.pool.query(`SELECT count(*)::int AS n FROM intents WHERE vertical_id = 6 AND side = 'provide' AND point_place_id = $1 AND status = 'active'`, [azaz.id])).rows[0].n;
  t1 = performance.now();
  const run = await matchIntent(db.pool, db.reg, { verticalId: 6, intentId: String(iv.id), trigger: 'interactive' });
  out.push(`one seeker «موبايل بإعزاز حتى 300$» vs ${inCity} active products in إعزاز: ${(performance.now() - t1).toFixed(0)} ms, ${run.totals.candidates} candidates evaluated, truncated=${run.truncated}, ${run.totals.confirmed} confirmed`);
  for (const l of out) console.log(`# measured: ${l}`);
});
