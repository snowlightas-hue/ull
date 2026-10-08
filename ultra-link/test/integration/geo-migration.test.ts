// Migration 0003_geo on isolated databases: applies on a fresh database (extensions, transport partitions, columns,
// indexes, live_positions); stops with an explicit remedy when earthdistance cannot be created (it is not a trusted
// extension) and when vertical-8 rows already sit in the DEFAULT partitions — rolling back completely in both cases.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDb, mkUser } from '../helpers/testdb.ts';
import { loadEnv } from '../../src/lib/env.ts';
import { migrate } from '../../src/db/migrate.ts';
import { withTx } from '../../src/db/pool.ts';
import { loadRegistry, syncReference } from '../../src/seed/reference.ts';
import { createIntent } from '../../src/repo/intents.ts';

loadEnv();
const ADMIN = process.env.DATABASE_ADMIN_URL!;
const TAG = `geo_mig_${process.pid}`;
const dbs: string[] = [];
const pools: pg.Pool[] = [];

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function blank(name: string, template: string): Promise<pg.Pool> {
  await admin(async (a) => { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await a.query(`CREATE DATABASE ${name} TEMPLATE ${template}`); });
  dbs.push(name);
  const pool = new pg.Pool({ connectionString: ADMIN.replace(/\/[^/]+$/, `/${name}`), max: 4 });
  pools.push(pool);
  return pool;
}
after(async () => {
  for (const p of pools) await p.end().catch(() => {});
  await admin(async (a) => { for (const n of dbs) await a.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`); });
});
const exists = async (pool: pg.Pool, rel: string) => !!(await pool.query('SELECT to_regclass($1) AS r', [rel])).rows[0].r;

test('fresh database: 0003 applies — extensions, transport partitions, geo columns, indexes, live_positions', async () => {
  const db = await freshDb(`${TAG}_fresh`);
  dbs.push(db.name);
  try {
    const applied = (await db.pool.query('SELECT name FROM schema_migrations ORDER BY version')).rows.map((r) => r.name);
    assert.ok(applied.includes('0003_geo.sql'), String(applied));
    const ext = (await db.pool.query("SELECT extname FROM pg_extension WHERE extname IN ('cube','earthdistance') ORDER BY 1")).rows.map((r) => r.extname);
    assert.deepEqual(ext, ['cube', 'earthdistance']);
    const bound = async (t: string) => (await db.pool.query('SELECT pg_get_expr(relpartbound, oid) AS b FROM pg_class WHERE relname = $1', [t])).rows[0]?.b;
    assert.equal(await bound('intents_transport'), "FOR VALUES IN ('8')");
    assert.equal(await bound('matches_transport'), "FOR VALUES IN ('8')");
    const cols = (await db.pool.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'intents' AND column_name IN ('geo_lat','geo_lng','geo_accuracy_m','geo_source','geo_at','radius_km','radius_strength','nearest') ORDER BY column_name`)).rows;
    assert.equal(cols.length, 8);
    assert.deepEqual(cols.find((c) => c.column_name === 'nearest'), { column_name: 'nearest', data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
    assert.equal(cols.find((c) => c.column_name === 'radius_km')!.data_type, 'numeric');
    for (const ix of ['intents_geo_knn_idx', 'intents_point_coarse_idx', 'live_positions_knn_idx', 'live_positions_expiry_idx', 'live_positions_user_idx']) assert.ok(await exists(db.pool, ix), ix);
    assert.match((await db.pool.query("SELECT pg_get_indexdef('intents_geo_knn_idx'::regclass) AS d")).rows[0].d, /USING gist \(ll_to_earth\(geo_lat, geo_lng\)\) WHERE \(\(status = 'active'::text\) AND \(geo_lat IS NOT NULL\)\)/);
    // cascade: deleting the user removes the live row with the intent
    const u = await mkUser(db.pool, 'cascade');
    const reg = db.reg;
    const c = await withTx(db.pool, (tx) => createIntent(tx, reg, { userId: u, realm: 'synthetic', titleAr: 'تكسي', sourceText: null, conversationId: null,
      spec: { side: 'provide', categoryCode: 'transport.ride', deal: 'service', place: { pointPlaceId: reg.placeByCode.get('sy.aleppo.azaz')!.id, scopePlaceIds: [], scopeStrength: 'required' }, price: null, when: null, attrs: {}, constraints: [] } }));
    await db.pool.query(`INSERT INTO live_positions (vertical_id, intent_id, user_id, realm, side, deal_type_id, category_id, lat, lng, expires_at)
      SELECT vertical_id, id, user_id, realm, side, deal_type_id, category_id, 36.5, 37.0, now() + interval '10 minutes' FROM intents WHERE id = $1`, [c.id]);
    await assert.rejects(db.pool.query(`UPDATE live_positions SET side = 'seek'`), (e: { code?: string }) => e.code === '23514');
    await db.pool.query('DELETE FROM users WHERE id = $1', [u]);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM live_positions')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('without earthdistance and no superuser: cube is created, then an explicit remedy — and nothing of 0003 remains', async () => {
  // template0 has no extensions; the trusted ones that 0001 needs can be created by the database owner
  const pool = await blank(`ultralink_t_${TAG}_noext`.slice(0, 60), 'template0');
  await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto');
  const superuser = (await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper;
  if (superuser) return; // a superuser simply creates earthdistance: nothing to check here
  await assert.rejects(migrate(pool, () => {}), (e: Error) => {
    assert.match(e.message, /0003_geo\.sql failed: 0003_geo: extension earthdistance is missing and role \w+ may not create it \(earthdistance is not a trusted extension\)/);
    return true;
  });
  const versions = (await pool.query('SELECT version FROM schema_migrations ORDER BY 1')).rows.map((r) => r.version);
  assert.deepEqual(versions, ['0001', '0002']);
  assert.equal(await exists(pool, 'live_positions'), false);
  assert.equal(await exists(pool, 'intents_transport'), false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM pg_extension WHERE extname = 'cube'")).rows[0].n, 0, 'the whole migration rolled back');
});

test('vertical-8 rows already in the DEFAULT partition: 0003 stops with a clear message; after removing them it applies', async () => {
  const pool = await blank(`ultralink_t_${TAG}_guard`.slice(0, 60), 'ultralink_template');
  await migrate(pool, () => {}, { upTo: '0002' });
  await syncReference(pool); // knows vertical 8 already (taxonomy ahead of the schema)
  const reg = await loadRegistry(pool);
  const u = (await pool.query("INSERT INTO users (display_name, realm) VALUES ('early', 'synthetic') RETURNING id")).rows[0].id;
  // a row written by pre-0003 code (no geo columns yet)
  const c = { id: String((await pool.query(
    `INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar) VALUES ($1, $2, 'synthetic', 'provide', $3, $4, 'تكسي مبكر') RETURNING id`,
    [reg.categoryByCode.get('transport.ride')!.verticalId, u, reg.categoryByCode.get('transport.ride')!.id, reg.dealByCode.get('service')!.id])).rows[0].id) };
  assert.equal((await pool.query('SELECT tableoid::regclass::text AS t FROM intents WHERE id = $1', [c.id])).rows[0].t, 'intents_other');
  await assert.rejects(migrate(pool, () => {}), /0003_geo: 1 intents and 0 matches of vertical 8 \(transport\) already sit in the DEFAULT partitions/);
  assert.deepEqual((await pool.query('SELECT version FROM schema_migrations ORDER BY 1')).rows.map((r) => r.version), ['0001', '0002']);
  assert.equal(await exists(pool, 'intents_transport'), false, 'rolled back');
  await pool.query('DELETE FROM intents WHERE vertical_id = 8');
  assert.deepEqual(await migrate(pool, () => {}), ['0003_geo.sql']);
  assert.ok(await exists(pool, 'intents_transport'));
});
