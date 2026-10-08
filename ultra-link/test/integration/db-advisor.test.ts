// Schema advisor end to end on isolated databases: evidence in → deduplicated schema_proposals + DRAFT files in the
// given directory only; the schema itself never changes (catalog fingerprint); decided proposals are left alone; a
// partition draft is valid SQL that moves rows correctly when a human applies it; on a 0001-only database the advisor
// finds exactly the foreign-key indexes that migration 0002 adds, and none after it.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { ROOT, loadEnv } from '../../src/lib/env.ts';
import { migrate } from '../../src/db/migrate.ts';
import { withTx } from '../../src/db/pool.ts';
import { createIntent } from '../../src/repo/intents.ts';
import { runAdvisor } from '../../src/advisor/run.ts';

loadEnv();
const ADMIN = process.env.DATABASE_ADMIN_URL!;
const TAG = `r5_adv_${process.pid}`;
const OLD_DB = `ultralink_t_${TAG}_0001`;
let db: TestDb;
let dir: string;
const proposedBefore = readdirSync(join(ROOT, 'migrations', 'proposed')).sort();

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Everything DDL could change: relations (+ storage options), index and constraint definitions. */
async function fingerprint(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query(`SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
      SELECT 'r:' || c.relname || ':' || c.relkind || ':' || coalesce(array_to_string(c.reloptions, ','), '') AS x FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL SELECT 'i:' || pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
      UNION ALL SELECT 'k:' || conname || ':' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace) s`);
  return rows[0].h;
}

before(async () => {
  db = await freshDb(TAG);
  dir = mkdtempSync(join(tmpdir(), 'ul-advisor-'));
  const reg = db.reg;
  const u = await mkUser(db.pool, 'advisor evidence');
  // vocabulary evidence
  const electronics = reg.categoryByCode.get('goods.electronics')!.id;
  await db.pool.query(`INSERT INTO unknown_terms (term_norm, category_id, hits) VALUES ('فزعه', 0, 5), ('لابتوب', $1, 4), ('نادر', 0, 1)`, [electronics]);
  // extraction evidence: 25 turns, Jev decided the deal in 10 of them
  for (let k = 0; k < 25; k++) {
    await db.pool.query(`INSERT INTO extraction_runs (engine, input_hash, output, validated, latency_ms) VALUES ($1, sha256($2::bytea), $3, true, 40)`,
      [k < 10 ? 'jev-sim' : 'rules', `turn ${k}`, JSON.stringify({ categories: ['vehicles.car'], appliedJev: k < 10 ? ['deal'] : [] })]);
  }
  // matching evidence: 25 runs of a vehicles intent, 10 of them truncated
  const car = await withTx(db.pool, (tx) => createIntent(tx, reg, {
    userId: u, realm: 'synthetic', titleAr: 'سيارة', sourceText: null, conversationId: null,
    spec: { side: 'seek', categoryCode: 'vehicles.car', deal: 'sale', place: { pointPlaceId: null, scopePlaceIds: [], scopeStrength: 'required' }, price: null, when: null, attrs: {}, constraints: [] },
  }));
  for (let k = 0; k < 25; k++) {
    await db.pool.query(`INSERT INTO match_runs (vertical_id, intent_id, intent_version, eval_seq, candidates, confirmed, possible, excluded, truncated, duration_ms, trigger)
      VALUES ($1, $2, 1, $3, 100, 1, 0, 99, $4, 30, 'job')`, [car.verticalId, car.id, 1000 + k, k < 10]);
  }
  // a vertical that has no partition yet: its intents land in the DEFAULT partition
  const sale = reg.dealByCode.get('sale')!.id;
  await db.pool.query(`INSERT INTO verticals (id, code, name_ar) VALUES (99, 'pets', 'حيوانات أليفة')`);
  await db.pool.query(`INSERT INTO categories (id, code, vertical_id, name_ar, description_ar, depth, relation, allowed_deals) VALUES (9900, 'pets', 99, 'حيوانات', 'حيوانات أليفة', 0, 'exchange', $1)`, [[sale]]);
  for (let k = 0; k < 3; k++) {
    const { rows } = await db.pool.query(`INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar) VALUES (99, $1, 'synthetic', 'provide', 9900, $2, $3) RETURNING id, public_id`, [u, sale, `قطة ${k}`]);
    await db.pool.query('INSERT INTO intent_refs (public_id, vertical_id, intent_id, user_id) VALUES ($1, 99, $2, $3)', [rows[0].public_id, rows[0].id, u]);
  }
});

after(async () => {
  await db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  await admin(async (a) => { for (const n of [db?.name, OLD_DB]) if (n) await a.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`); });
});

const KEYS = ['lexicon:unmapped:فزعه', 'lexicon:goods.electronics:لابتوب', 'lexicon:jev-slot:deal', 'partition:dense:vehicles', 'partition:vertical:99'];

test('first run: proposals from every evidence source, stored once, drafts only in the given directory, schema untouched', async () => {
  const fp = await fingerprint(db.pool);
  const r = await runAdvisor({ url: db.url, target: 'test', dir, thresholds: { minStatsDays: 0 } });
  const keys = r.stored.map((s) => s.proposal.dedupeKey);
  for (const k of KEYS) assert.ok(keys.includes(k), `missing ${k} in ${keys.join(', ')}`);
  assert.ok(!keys.includes('lexicon:unmapped:نادر'), 'below the hit threshold');
  assert.ok(!keys.some((k) => k.startsWith('index:fk:')), 'after 0002 every cascading foreign key has an index');
  assert.ok(r.stored.every((s) => s.outcome === 'new'));
  const rows = (await db.pool.query('SELECT dedupe_key, kind, status, migration_file, proposed_by FROM schema_proposals ORDER BY id')).rows;
  assert.equal(rows.length, r.stored.length);
  assert.ok(rows.every((x) => x.status === 'proposed' && x.proposed_by.startsWith('advisor/')));
  const part = rows.find((x) => x.dedupe_key === 'partition:vertical:99')!;
  assert.equal(part.kind, 'partition');
  assert.ok(part.migration_file.startsWith(dir), part.migration_file);
  const files = readdirSync(dir);
  assert.equal(files.length, r.stored.filter((s) => s.proposal.draft).length);
  assert.ok(files.every((f) => /^[a-z0-9_]+\.sql$/.test(f)));
  assert.deepEqual(readdirSync(join(ROOT, 'migrations', 'proposed')).sort(), proposedBefore, 'repository drafts directory untouched');
  assert.equal(await fingerprint(db.pool), fp, 'no DDL was executed');
});

test('re-run: deduplicated (no new rows, nothing rewritten); decided proposals are never modified', async () => {
  const n0 = (await db.pool.query('SELECT count(*)::int AS n FROM schema_proposals')).rows[0].n;
  const again = await runAdvisor({ url: db.url, target: 'test', dir, thresholds: { minStatsDays: 0 } });
  assert.ok(again.stored.every((s) => s.outcome === 'unchanged' && !s.draftWritten), JSON.stringify(again.stored.map((s) => [s.proposal.dedupeKey, s.outcome])));
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM schema_proposals')).rows[0].n, n0);

  await db.pool.query(`UPDATE schema_proposals SET status = 'rejected', decided_by = 'reviewer', decided_at = now() WHERE dedupe_key = 'lexicon:unmapped:فزعه'`);
  await db.pool.query(`UPDATE unknown_terms SET hits = hits + 10 WHERE term_norm IN ('فزعه', 'لابتوب')`);
  const third = await runAdvisor({ url: db.url, target: 'test', dir, thresholds: { minStatsDays: 0 } });
  const by = new Map(third.stored.map((s) => [s.proposal.dedupeKey, s.outcome]));
  assert.equal(by.get('lexicon:unmapped:فزعه'), 'decided');
  assert.equal(by.get('lexicon:goods.electronics:لابتوب'), 'updated');
  const ev = async (k: string) => (await db.pool.query('SELECT status, evidence FROM schema_proposals WHERE dedupe_key = $1', [k])).rows[0];
  assert.deepEqual([(await ev('lexicon:unmapped:فزعه')).status, (await ev('lexicon:unmapped:فزعه')).evidence.hits], ['rejected', 5]);
  assert.equal((await ev('lexicon:goods.electronics:لابتوب')).evidence.hits, 14);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM schema_proposals')).rows[0].n, n0);
});

test('dry run writes nothing', async () => {
  const before = (await db.pool.query('SELECT count(*)::int AS n, max(id) AS m FROM schema_proposals')).rows[0];
  await db.pool.query(`INSERT INTO unknown_terms (term_norm, category_id, hits) VALUES ('جديد', 0, 9)`);
  const files = readdirSync(dir).length;
  const r = await runAdvisor({ url: db.url, target: 'test', dir, dryRun: true, thresholds: { minStatsDays: 0 } });
  assert.ok(r.stored.some((s) => s.proposal.dedupeKey === 'lexicon:unmapped:جديد' && s.outcome === 'new'));
  assert.deepEqual((await db.pool.query('SELECT count(*)::int AS n, max(id) AS m FROM schema_proposals')).rows[0], before);
  assert.equal(readdirSync(dir).length, files);
});

test('a partition draft is valid: applied by a human, it moves the rows and the finding disappears', async () => {
  const row = (await db.pool.query(`SELECT migration_file FROM schema_proposals WHERE dedupe_key = 'partition:vertical:99'`)).rows[0];
  const sql = readFileSync(row.migration_file, 'utf8');
  const refs = (await db.pool.query('SELECT public_id, intent_id FROM intent_refs WHERE vertical_id = 99 ORDER BY intent_id')).rows;
  await withTx(db.pool, (tx) => tx.query(sql)); // the human step — the advisor itself never runs this
  const after = (await db.pool.query(`SELECT (SELECT count(*) FROM intents_pets)::int AS moved, (SELECT count(*) FROM intents_other WHERE vertical_id = 99)::int AS left,
      (SELECT pg_get_expr(relpartbound, oid) FROM pg_class WHERE relname = 'matches_pets') AS mbound`)).rows[0];
  assert.deepEqual(after, { moved: 3, left: 0, mbound: "FOR VALUES IN ('99')" });
  assert.deepEqual((await db.pool.query('SELECT public_id, intent_id FROM intent_refs WHERE vertical_id = 99 ORDER BY intent_id')).rows, refs);
  const r = await runAdvisor({ url: db.url, target: 'test', dir, dryRun: true, thresholds: { minStatsDays: 0 } });
  assert.ok(!r.stored.some((s) => s.proposal.dedupeKey === 'partition:vertical:99'));
});

test('on a 0001-only database the advisor proposes exactly the foreign-key indexes that 0002 adds', async () => {
  await admin(async (a) => { await a.query(`DROP DATABASE IF EXISTS ${OLD_DB} WITH (FORCE)`); await a.query(`CREATE DATABASE ${OLD_DB} TEMPLATE ultralink_template`); });
  const url = ADMIN.replace(/\/[^/]+$/, `/${OLD_DB}`);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await migrate(pool, () => {}, { upTo: '0001' });
    const fp = await fingerprint(pool);
    const r = await runAdvisor({ url, target: 'test', dir, dryRun: true });
    const fk = r.stored.filter((s) => s.proposal.dedupeKey.startsWith('index:fk:')).map((s) => s.proposal.dedupeKey).sort();
    assert.deepEqual(fk, [
      'index:fk:contact_requests:requester_id', 'index:fk:conversations:user_id', 'index:fk:extraction_runs:message_id',
      'index:fk:intent_refs:user_id', 'index:fk:intent_refs:vertical_id,intent_id', 'index:fk:intents:conversation_id',
      'index:fk:match_refs:vertical_id,match_id',
    ]);
    assert.ok(r.notes.some((n) => /unindexed NO ACTION foreign key/.test(n)), 'reference-data FKs are reported, not proposed');
    assert.ok(r.notes.some((n) => /unused-index rule skipped/.test(n)), 'fresh statistics never justify dropping an index');
    assert.equal(await fingerprint(pool), fp);
  } finally {
    await pool.end();
  }
});
