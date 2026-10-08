// Migrations on isolated databases (never the app DB): every migration applies to a fresh database; 0002's
// integrity constraints reject exactly the malformed rows they target; refs are unique; cascades still work;
// 0002 moves vertical-7 rows out of the DEFAULT partitions without losing a single dependant; the covering indexes
// give index-only plans to the engine's RANGE statement and the owner-list counts; applied files are immutable.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { ROOT, loadEnv } from '../../src/lib/env.ts';
import { migrate } from '../../src/db/migrate.ts';
import { withTx } from '../../src/db/pool.ts';
import { loadRegistry, syncReference } from '../../src/seed/reference.ts';
import { createIntent, setIntentStatus } from '../../src/repo/intents.ts';
import { matchIntent } from '../../src/matching/engine.ts';
import type { Registry } from '../../src/domain/registry.ts';
import type { IntentSpec } from '../../src/domain/types.ts';

loadEnv();
const ADMIN = process.env.DATABASE_ADMIN_URL!;
const TAG = `r5_mig_${process.pid}`;
let db: TestDb;
const extra: string[] = [];

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
/** Empty database from the template, migrated only up to `upTo` (the caller continues). */
async function blankDb(name: string, upTo: string): Promise<pg.Pool> {
  await admin(async (a) => { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.query(`CREATE DATABASE ${name} TEMPLATE ultralink_template`); });
  extra.push(name);
  const pool = new pg.Pool({ connectionString: ADMIN.replace(/\/[^/]+$/, `/${name}`), max: 4 });
  await migrate(pool, () => {}, { upTo });
  return pool;
}

before(async () => { db = await freshDb(TAG); });
after(async () => {
  await db?.close();
  await admin(async (a) => { for (const n of [db?.name, ...extra]) if (n) await a.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`); });
});

const spec = (reg: Registry, s: Partial<IntentSpec> & Pick<IntentSpec, 'side' | 'categoryCode' | 'deal'>): IntentSpec => ({
  place: { pointPlaceId: reg.placeByCode.get('sy.aleppo.azaz')!.id, scopePlaceIds: [], scopeStrength: 'required' },
  price: null, when: null, attrs: {}, constraints: [], ...s,
});

test('fresh database: every migration file applies, in order, with its checksum recorded', async () => {
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const { rows } = await db.pool.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.name), files);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum)));
  assert.ok(files.includes('0002_query_indexes_integrity_maintenance.sql'));
  // second run is a no-op
  assert.deepEqual(await migrate(db.pool, () => {}), []);
});

test('0002 objects exist: covering indexes, FK indexes, help partitions, storage settings', async () => {
  const def = async (name: string) => (await db.pool.query('SELECT pg_get_indexdef($1::regclass) AS d', [name])).rows[0].d as string;
  assert.match(await def('intents_point_idx'), /\(realm, side, deal_type_id, category_id, point_lft\) INCLUDE \(created_at, user_id, id, vertical_id\) WHERE \(status = 'active'::text\)/);
  assert.match(await def('intents_owner_idx'), /INCLUDE \(status\)/);
  assert.match(await def('notifications_unread_idx'), /\(recipient_id, created_at DESC, id DESC\) WHERE \(read_at IS NULL\)/);
  for (const ix of ['intent_refs_intent_key', 'match_refs_match_key', 'intent_refs_user_idx', 'contact_requests_requester_idx', 'conversations_user_idx', 'extraction_runs_message_idx', 'intents_conversation_idx']) {
    assert.ok((await db.pool.query('SELECT to_regclass($1) AS r', [ix])).rows[0].r, `${ix} exists`);
  }
  const bound = async (t: string) => (await db.pool.query('SELECT pg_get_expr(relpartbound, oid) AS b FROM pg_class WHERE relname = $1', [t])).rows[0]?.b;
  assert.equal(await bound('intents_help'), "FOR VALUES IN ('7')");
  assert.equal(await bound('matches_help'), "FOR VALUES IN ('7')");
  const opts = async (t: string) => ((await db.pool.query('SELECT reloptions FROM pg_class WHERE relname = $1', [t])).rows[0].reloptions ?? []) as string[];
  assert.ok((await opts('intents_help')).includes('autovacuum_vacuum_insert_scale_factor=0.05'));
  assert.ok((await opts('intents_vehicles')).includes('autovacuum_analyze_scale_factor=0.02'));
  assert.ok((await opts('sessions')).includes('fillfactor=70'));
  assert.ok((await opts('jobs')).includes('autovacuum_vacuum_threshold=500'));
});

test('integrity CHECKs reject malformed intents, scopes and runs (and the app path still writes valid rows)', async () => {
  const u = await mkUser(db.pool, 'checks');
  const reg = db.reg;
  const ok = await withTx(db.pool, (tx) => createIntent(tx, reg, {
    userId: u, realm: 'synthetic', titleAr: 'سيارة', sourceText: null, conversationId: null,
    spec: spec(reg, { side: 'provide', categoryCode: 'vehicles.car', deal: 'sale', price: { op: 'eq', lo: '500000', hi: '500000', currency: 'USD', unit: 'total', strength: 'required' } }),
  }));
  const peer = await withTx(db.pool, (tx) => createIntent(tx, reg, {
    userId: u, realm: 'synthetic', titleAr: 'رحلة', sourceText: null, conversationId: null,
    spec: spec(reg, { side: 'join', categoryCode: 'activities.trip', deal: 'activity', when: { from: '2026-10-10T08:00:00Z', to: '2026-10-10T12:00:00Z', strength: 'required' } }),
  }));
  const bad = async (sql: string, params: unknown[], constraint: string) => {
    await assert.rejects(db.pool.query(sql, params), (e: { code?: string; constraint?: string }) => {
      assert.equal(e.code, '23514', `${constraint}: expected check_violation, got ${e.code}`);
      assert.equal(e.constraint, constraint);
      return true;
    });
  };
  const where = 'WHERE vertical_id = $1 AND id = $2';
  const car = [ok.verticalId, ok.id];
  await bad(`UPDATE intents SET price_hi = 600000 ${where}`, car, 'intents_price_shape_chk');                                   // eq ⇒ lo = hi
  await bad(`UPDATE intents SET price_op = 'lte', price_hi = NULL ${where}`, car, 'intents_price_shape_chk');                 // lte ⇒ hi
  await bad(`UPDATE intents SET price_op = 'gte', price_lo = NULL ${where}`, car, 'intents_price_shape_chk');                 // gte ⇒ lo
  await bad(`UPDATE intents SET price_op = 'between', price_hi = NULL ${where}`, car, 'intents_price_shape_chk');             // between ⇒ both
  await bad(`UPDATE intents SET price_op = NULL, price_lo = NULL, price_hi = NULL ${where}`, car, 'intents_price_shape_chk');  // currency left
  await bad(`UPDATE intents SET when_range = tstzrange(now(), now() + interval '1 hour') ${where}`, car, 'intents_when_shape_chk'); // no strength
  const trip = [peer.verticalId, peer.id];
  await bad(`UPDATE intents SET when_range = tstzrange(lower(when_range), lower(when_range)) ${where}`, trip, 'intents_when_shape_chk'); // empty
  await bad(`UPDATE intents SET when_range = tstzrange(lower(when_range), NULL) ${where}`, trip, 'intents_when_shape_chk');             // unbounded
  await bad(`UPDATE intents SET status = 'closed' ${where}`, car, 'intents_closed_at_chk');
  await bad(`UPDATE intents SET closed_at = now() ${where}`, car, 'intents_closed_at_chk');
  await bad(`UPDATE intent_scopes SET side = 'buyer' ${where.replace('id = $2', 'intent_id = $2')}`, car, 'intent_scopes_values_chk');
  await bad(`INSERT INTO match_runs (vertical_id, intent_id, intent_version, eval_seq, candidates, confirmed, possible, excluded, trigger)
             VALUES ($1, $2, 1, 1, -1, 0, 0, 0, 'job')`, car, 'match_runs_counts_chk');
  // the status machine keeps closed_at consistent
  for (const a of ['pause', 'resume', 'close'] as const) assert.equal((await setIntentStatus(db.pool, reg, ok.verticalId, ok.id, u, a)).ok, true);
  const r = (await db.pool.query(`SELECT status, closed_at FROM intents ${where}`, car)).rows[0];
  assert.equal(r.status, 'closed');
  assert.ok(r.closed_at);
});

test('an intent cannot sit in a partition that disagrees with its category (composite FK); refs are unique', async () => {
  const u = await mkUser(db.pool, 'fk');
  const car = db.reg.categoryByCode.get('vehicles.car')!;
  await assert.rejects(db.pool.query(
    `INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar) VALUES (1, $1, 'synthetic', 'provide', $2, $3, 'x')`, [u, car.id, db.reg.dealByCode.get('sale')!.id],
  ), (e: { code?: string; constraint?: string }) => e.code === '23503' && e.constraint === 'intents_category_vertical_fkey');
  const i = await withTx(db.pool, (tx) => createIntent(tx, db.reg, { userId: u, realm: 'synthetic', titleAr: 'x', sourceText: null, conversationId: null, spec: spec(db.reg, { side: 'provide', categoryCode: 'vehicles.car', deal: 'sale' }) }));
  await assert.rejects(db.pool.query('INSERT INTO intent_refs (public_id, vertical_id, intent_id, user_id) VALUES (gen_random_uuid(), $1, $2, $3)', [i.verticalId, i.id, u]),
    (e: { code?: string; constraint?: string }) => e.code === '23505' && e.constraint === 'intent_refs_intent_key');
});

test('deleting a user still cascades through intents, refs, scopes, matches, runs and notifications', async () => {
  const reg = db.reg;
  const seller = await mkUser(db.pool, 'seller');
  const buyer = await mkUser(db.pool, 'buyer');
  const azaz = reg.placeByCode.get('sy.aleppo.azaz')!.id;
  const p = await withTx(db.pool, (tx) => createIntent(tx, reg, { userId: seller, realm: 'synthetic', titleAr: 'بيع سيارة', sourceText: null, conversationId: null, spec: spec(reg, { side: 'provide', categoryCode: 'vehicles.car', deal: 'sale' }) }));
  const s = await withTx(db.pool, (tx) => createIntent(tx, reg, { userId: buyer, realm: 'synthetic', titleAr: 'شراء سيارة', sourceText: null, conversationId: null, spec: spec(reg, { side: 'seek', categoryCode: 'vehicles.car', deal: 'sale', place: { pointPlaceId: null, scopePlaceIds: [azaz], scopeStrength: 'required' } }) }));
  const run = await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' });
  assert.ok(run.totals.confirmed + run.totals.possible >= 1, 'the pair matched');
  await db.pool.query('DELETE FROM users WHERE id = $1', [seller]);
  const left = (await db.pool.query(`SELECT
      (SELECT count(*) FROM intents WHERE user_id = $1)::int AS intents, (SELECT count(*) FROM intent_refs WHERE user_id = $1)::int AS refs,
      (SELECT count(*) FROM intent_scopes WHERE intent_id = $2)::int AS scopes, (SELECT count(*) FROM matches WHERE b_user_id = $1 OR a_user_id = $1)::int AS matches,
      (SELECT count(*) FROM match_refs r WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.vertical_id = r.vertical_id AND m.id = r.match_id))::int AS orphan_refs,
      (SELECT count(*) FROM notifications WHERE recipient_id = $1)::int AS notes`, [seller, p.id])).rows[0];
  assert.deepEqual(left, { intents: 0, refs: 0, scopes: 0, matches: 0, orphan_refs: 0, notes: 0 });
});

test('0002 moves vertical-7 (help) rows out of the DEFAULT partitions with every dependant intact', async () => {
  // rows are written with plain SQL in the 0001 shape (the repo layer may already expect later migrations)
  const pool = await blankDb(`ultralink_t_${TAG}_help`.slice(0, 60), '0001');
  try {
    await syncReference(pool);
    const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
    const [a, b] = [await mkUser(pool, 'needs help'), await mkUser(pool, 'volunteer')];
    const ids = await one(`SELECT (SELECT id FROM categories WHERE code = 'help.general') AS cat, (SELECT id FROM deal_types WHERE code = 'help') AS deal,
      (SELECT id FROM places WHERE code = 'sy.aleppo.azaz') AS azaz, (SELECT lft FROM places WHERE code = 'sy.aleppo.azaz') AS lft,
      (SELECT id FROM places WHERE parent_id IS NULL) AS root`);
    const intent = async (user: string, side: string, scope: number[]) => {
      const r = await one(`INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar, point_place_id, point_lft, scope_place_ids)
        VALUES (7, $1, 'synthetic', $2, $3, $4, 'مساعدة', $5, $6, $7) RETURNING id, public_id`, [user, side, ids.cat, ids.deal, ids.azaz, ids.lft, scope]);
      await pool.query('INSERT INTO intent_refs (public_id, vertical_id, intent_id, user_id) VALUES ($1, 7, $2, $3)', [r.public_id, r.id, user]);
      await pool.query(`INSERT INTO intent_scopes (vertical_id, intent_id, realm, side, deal_type_id, category_id, place_id) VALUES (7, $1, 'synthetic', $2, $3, $4, $5)`,
        [r.id, side, ids.deal, ids.cat, scope[0] ?? ids.root]);
      return String(r.id);
    };
    const seek = await intent(a, 'seek', [ids.azaz]);
    const prov = await intent(b, 'provide', []);
    const m = await one(`INSERT INTO matches (vertical_id, kind, a_intent_id, b_intent_id, a_user_id, b_user_id, state, score, a_version, b_version, eval_seq)
      VALUES (7, 'exchange', $1, $2, $3, $4, 'confirmed', 8000, 1, 1, nextval('match_eval_seq')) RETURNING id, public_id`, [seek, prov, a, b]);
    await pool.query('INSERT INTO match_refs (public_id, vertical_id, match_id) VALUES ($1, 7, $2)', [m.public_id, m.id]);
    await pool.query(`INSERT INTO match_runs (vertical_id, intent_id, intent_version, eval_seq, candidates, confirmed, possible, excluded, trigger) VALUES (7, $1, 1, 1, 1, 1, 0, 0, 'job')`, [seek]);
    await pool.query(`INSERT INTO contact_requests (vertical_id, match_id, requester_id, recipient_id) VALUES (7, $1, $2, $3)`, [m.id, a, b]);
    const snap = async () => {
      const out: Record<string, unknown[]> = {};
      for (const [t, order] of [['intents', 'id'], ['intent_refs', 'intent_id'], ['intent_scopes', 'intent_id, place_id'], ['matches', 'id'], ['match_refs', 'match_id'], ['contact_requests', 'id'], ['match_runs', 'id']]) {
        out[t] = (await pool.query(`SELECT to_jsonb(x) AS j FROM ${t} x WHERE vertical_id = 7 ORDER BY ${order}`)).rows.map((r) => r.j);
      }
      return out;
    };
    const before7 = await snap();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM intents_other WHERE vertical_id = 7')).rows[0].n, 2);
    assert.deepEqual(await migrate(pool, () => {}, { upTo: '0002' }), ['0002_query_indexes_integrity_maintenance.sql']);
    assert.deepEqual(await snap(), before7, 'every vertical-7 row and dependant survived unchanged (same ids, public ids, timestamps)');
    const where = (await pool.query(`SELECT (SELECT count(*) FROM intents_help)::int AS ih, (SELECT count(*) FROM intents_other)::int AS io,
      (SELECT count(*) FROM matches_help)::int AS mh, (SELECT count(*) FROM matches_other)::int AS mo`)).rows[0];
    assert.deepEqual(where, { ih: 2, io: 0, mh: 1, mo: 0 });
    // later migrations still apply on top, and the current engine works on the moved rows
    await migrate(pool, () => {});
    const reg = await loadRegistry(pool);
    const again = await matchIntent(pool, reg, { verticalId: 7, intentId: seek, trigger: 'job' });
    assert.equal(again.status, 'done');
  } finally {
    await pool.end();
  }
});

test('covering indexes: engine RANGE statement and owner-list counts are index-only', async () => {
  const reg = db.reg;
  const u = await mkUser(db.pool, 'ios');
  for (let k = 0; k < 30; k++) {
    await withTx(db.pool, (tx) => createIntent(tx, reg, { userId: u, realm: 'synthetic', titleAr: `سيارة ${k}`, sourceText: null, conversationId: null, spec: spec(reg, { side: 'provide', categoryCode: 'vehicles.car', deal: 'sale' }) }));
  }
  await db.pool.query('VACUUM (ANALYZE) intents');
  const c = await db.pool.connect();
  try {
    await c.query('SET enable_seqscan = off');
    await c.query('SET enable_bitmapscan = off');
    const aleppo = reg.placeByCode.get('sy.aleppo')!;
    const car = reg.categoryByCode.get('vehicles.car')!;
    const plan = async (sql: string, params: unknown[]) => (await c.query(`EXPLAIN (COSTS OFF) ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
    const range = await plan(`SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
        AND status = 'active' AND user_id <> $6 AND point_lft BETWEEN $7 AND $8 ORDER BY created_at DESC LIMIT $9`,
      [car.verticalId, 'synthetic', 'provide', reg.dealByCode.get('sale')!.id, [car.id], '0', aleppo.lft, aleppo.rgt, 5000]);
    // the partition-level index that belongs to a partitioned index on a given partition
    const leaf = async (parent: string, table: string) => (await c.query(
      `SELECT ic.relname FROM pg_inherits i JOIN pg_class ic ON ic.oid = i.inhrelid JOIN pg_index x ON x.indexrelid = ic.oid
        WHERE i.inhparent = $1::regclass AND x.indrelid = $2::regclass`, [parent, table])).rows[0].relname as string;
    assert.ok(range.includes(`Index Only Scan using ${await leaf('intents_point_idx', 'intents_vehicles')} on intents_vehicles`), range);
    const owner = await plan(`SELECT count(*) FROM intents WHERE user_id = $1 AND side = ANY($2) AND status = ANY($3)`, [u, ['provide'], ['active', 'paused']]);
    assert.ok(owner.includes(`Index Only Scan using ${await leaf('intents_owner_idx', 'intents_vehicles')} on intents_vehicles`), owner);
  } finally {
    c.release();
  }
});

test('an applied migration is immutable: a checksum mismatch stops the runner', async () => {
  await db.pool.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = '0002'");
  try {
    await assert.rejects(migrate(db.pool, () => {}), /0002_query_indexes_integrity_maintenance\.sql was modified after being applied/);
  } finally {
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    const sum = createHash('sha256').update(readFileSync(join(ROOT, 'migrations', '0002_query_indexes_integrity_maintenance.sql'), 'utf8')).digest('hex');
    await db.pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = '0002'", [sum]);
  }
});
