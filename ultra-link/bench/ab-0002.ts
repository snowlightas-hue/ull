// node bench/ab-0002.ts [--db ultralink_bench] [--samples 200] [--delete-samples 25]
//
// Paired A/B of migration 0002's index changes on ONE database (built by bench/generate.ts with all migrations) and
// the SAME samples: variant "0002" = the schema as migrated; variant "0001" = inside a transaction that drops the 0002
// indexes and recreates the 0001 definitions, measured, then ROLLED BACK (nothing persists).
// Shapes: engine RANGE and BROAD retrieval (retrieveCandidates), owner list (listIntents), contact respond (statement
// from src/server/app.ts) and user delete (cascade) — the last two inside savepoints that are rolled back.
// Writes bench/results/ab-0002.json. Never touches the app database.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT } from '../src/lib/env.ts';
import { loadRegistry } from '../src/seed/reference.ts';
import { listIntents, loadIntent, rowToMatchable, type IntentRow } from '../src/repo/intents.ts';
import { retrieveCandidates } from '../src/matching/engine.ts';
import { BENCH_DB, argInt, argValue, dbUrl, summarize } from './lib.ts';

const DB = argValue('db', BENCH_DB)!;
const SAMPLES = argInt('samples', 200);
const DELETE_SAMPLES = argInt('delete-samples', 25);
const WARM = 20;

// 0001 definitions of everything 0002 changed or added that the measured shapes can use
const TO_0001 = [
  'DROP INDEX intents_point_idx',
  `CREATE INDEX intents_point_idx ON intents (realm, side, deal_type_id, category_id, point_lft) INCLUDE (price_lo, currency, price_unit) WHERE status = 'active'`,
  'DROP INDEX intents_owner_idx',
  'CREATE INDEX intents_owner_idx ON intents (user_id, side, created_at DESC, id DESC)',
  'ALTER TABLE intent_refs DROP CONSTRAINT intent_refs_intent_key',
  'ALTER TABLE match_refs DROP CONSTRAINT match_refs_match_key',
  'DROP INDEX intent_refs_user_idx',
  'DROP INDEX contact_requests_requester_idx',
  'DROP INDEX conversations_user_idx',
  'DROP INDEX extraction_runs_message_idx',
  'DROP INDEX intents_conversation_idx',
];

const timed = async <T>(fn: () => Promise<T>): Promise<[number, T]> => { const t = performance.now(); const o = await fn(); return [performance.now() - t, o]; };

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: dbUrl(DB), max: 2 });
  const reg = await loadRegistry(pool);
  const c = await pool.connect();
  const migrations = (await c.query(`SELECT string_agg(version, ',' ORDER BY version) AS v FROM schema_migrations`)).rows[0].v;
  if (!String(migrations).includes('0002')) throw new Error(`${DB} must be generated with 0002 applied (has ${migrations})`);
  // deterministic samples independent of physical row order
  const pick = async (where: string, n: number) => (await c.query(`SELECT vertical_id, id FROM intents WHERE ${where} ORDER BY md5(id::text || 'ab') LIMIT $1`, [n])).rows;
  const hard = `scope_strength = 'required' AND cardinality(scope_place_ids) > 0`;
  const load = async (xs: { vertical_id: number; id: string }[]) => (await Promise.all(xs.map((x) => loadIntent(pool, x.vertical_id, String(x.id))))).filter((r): r is IntentRow => !!r);
  const range = await load(await pick(`status = 'active' AND side = 'seek' AND ${hard}`, SAMPLES + WARM));
  const broad = await load(await pick(`status = 'active' AND point_place_id IS NULL AND NOT (${hard})`, SAMPLES + WARM));
  const owners = (await c.query(`SELECT DISTINCT ON (md5(user_id::text || 'ab')) user_id::text AS u, side FROM intents ORDER BY md5(user_id::text || 'ab') LIMIT $1`, [SAMPLES + WARM])).rows as { u: string; side: string }[];
  const contacts = (await c.query(`SELECT public_id::text AS p, recipient_id::text AS u FROM contact_requests WHERE status = 'pending' ORDER BY md5(id::text || 'ab') LIMIT $1`, [SAMPLES + WARM])).rows as { p: string; u: string }[];
  const victims = (await c.query(`SELECT u FROM (SELECT DISTINCT user_id AS u FROM intents) d WHERE (SELECT count(*) FROM intents i WHERE i.user_id = d.u) BETWEEN 5 AND 40
      ORDER BY md5(u::text || 'ab') LIMIT $1`, [DELETE_SAMPLES + 3])).rows.map((r) => String(r.u));

  /** Plan of the engine's first RANGE statement for the first sample (to show which index each variant uses). */
  const rangePlan = async (): Promise<string> => {
    const log: { sql: string; params: unknown[] }[] = [];
    const rec = { query: (sql: string, params: unknown[] = []) => { log.push({ sql, params }); return c.query(sql, params); } };
    await retrieveCandidates(rec as unknown as pg.PoolClient, reg, range[0]!, rowToMatchable(reg, range[0]!));
    const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${log[0]!.sql}`, log[0]!.params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  };

  const measure = async (label: string) => {
    const out: Record<string, ReturnType<typeof summarize>> = {};
    for (const [name, rows] of [['range', range], ['broad', broad]] as const) {
      const ts: number[] = [];
      for (const [i, row] of rows.entries()) {
        const [ms] = await timed(() => retrieveCandidates(c, reg, row, rowToMatchable(reg, row)));
        if (i >= WARM) ts.push(ms);
      }
      out[name] = summarize(ts);
    }
    const ol: number[] = [];
    for (const [i, o] of owners.entries()) {
      const sides = o.side === 'provide' ? ['provide' as const] : ['seek' as const, 'join' as const];
      const [ms] = await timed(() => listIntents(c, reg, o.u, { sides, limit: 20 }));
      if (i >= WARM) ol.push(ms);
    }
    out.owner_list = summarize(ol);
    const cr: number[] = [];
    for (let i = 0; i < SAMPLES + WARM; i++) {
      const x = contacts[i % contacts.length]!;
      await c.query('SAVEPOINT ab');
      const [ms] = await timed(() => c.query(`UPDATE contact_requests c SET status = $3, responded_at = now() FROM match_refs r
        WHERE c.public_id = $1 AND c.recipient_id = $2 AND c.status = 'pending' AND r.vertical_id = c.vertical_id AND r.match_id = c.match_id
        RETURNING c.public_id, c.status, c.requester_id, r.public_id AS match_public_id`, [x.p, x.u, 'accepted']));
      await c.query('ROLLBACK TO SAVEPOINT ab');
      if (i >= WARM) cr.push(ms);
    }
    out.contact_respond = summarize(cr);
    const ud: number[] = [];
    for (const [i, u] of victims.entries()) {
      await c.query('SAVEPOINT ab');
      const [ms] = await timed(() => c.query('DELETE FROM users WHERE id = $1', [u]));
      await c.query('ROLLBACK TO SAVEPOINT ab');
      if (i >= 3) ud.push(ms);
    }
    out.user_delete = summarize(ud);
    console.log(`variant ${label}:`);
    for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(16)} n=${v.n} p50 ${v.p50} p95 ${v.p95} p99 ${v.p99} ms`);
    return out;
  };

  await c.query('BEGIN');
  const plan2 = await rangePlan();
  const v2 = await measure('0002 (as migrated)');
  await c.query('ROLLBACK');
  await c.query('BEGIN');
  await c.query(`SET LOCAL lock_timeout = '10s'`);
  const t0 = performance.now();
  for (const s of TO_0001) await c.query(s);
  console.log(`(recreated 0001 indexes inside the transaction in ${Math.round(performance.now() - t0)} ms)`);
  // an index built in this transaction is unusable here if it had to be marked indcheckxmin (broken HOT chains)
  const unusable = (await c.query(`SELECT count(*)::int AS n FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
      WHERE x.indcheckxmin AND t.relnamespace = 'public'::regnamespace`)).rows[0].n;
  if (unusable) throw new Error(`${unusable} index(es) marked indcheckxmin — the 0001 variant would not be comparable`);
  const plan1 = await rangePlan();
  const v1 = await measure('0001 (inside a rolled-back transaction)');
  await c.query('ROLLBACK');
  c.release();
  await pool.end();

  const result = { db: DB, migrations, samples: SAMPLES, deleteSamples: DELETE_SAMPLES, at: new Date().toISOString(), variant0002: v2, variant0001: v1 };
  mkdirSync(join(ROOT, 'bench', 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'bench', 'results', 'ab-0002.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(ROOT, 'bench', 'results', 'ab-0002-range-plans.txt'), `-- variant 0002 (as migrated)\n${plan2}\n\n-- variant 0001 (indexes recreated inside a rolled-back transaction)\n${plan1}\n`);
  console.log('\n| shape | 0001 p50 | 0002 p50 | 0001 p95 | 0002 p95 | 0001 p99 | 0002 p99 |\n|---|---:|---:|---:|---:|---:|---:|');
  for (const k of Object.keys(v2)) console.log(`| ${k} | ${v1[k]!.p50} | ${v2[k]!.p50} | ${v1[k]!.p95} | ${v2[k]!.p95} | ${v1[k]!.p99} | ${v2[k]!.p99} |`);
}

main().catch((e) => { console.error(e); process.exit(1); });
