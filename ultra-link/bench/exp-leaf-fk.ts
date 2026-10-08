// node bench/exp-leaf-fk.ts [--db ultralink_bench] [--samples 30]
//
// Experiment (nothing persists): how much of a first matchIntent() is spent in foreign-key checks from matches to the
// PARTITIONED intents table, and what per-partition ("leaf") foreign keys would save.
//   variant parent — schema as migrated: matches (vertical_id, a|b_intent_id) → intents (partitioned parent)
//   variant leaf   — inside a transaction: those two FKs dropped and re-created per partition pair
//                    (matches_<v> → intents_<v>, NOT VALID: same check for new rows, no validation scan), then rolled back
// Each sample runs the real matchIntentTx() inside a savepoint that is rolled back, so every run is a first evaluation.
// Writes bench/results/exp-leaf-fk.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ROOT } from '../src/lib/env.ts';
import { loadRegistry } from '../src/seed/reference.ts';
import { matchIntentTx } from '../src/matching/engine.ts';
import { BENCH_DB, argInt, argValue, dbUrl, summarize } from './lib.ts';

const DB = argValue('db', BENCH_DB)!;
const SAMPLES = argInt('samples', 30);

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: dbUrl(DB), max: 2 });
  const reg = await loadRegistry(pool);
  const c = await pool.connect();
  const ids = (await c.query(`SELECT vertical_id, id FROM intents WHERE status = 'active' AND side = 'seek' AND vertical_id IN (1, 2)
      ORDER BY md5(id::text || 'leaf') LIMIT $1`, [SAMPLES + 3])).rows as { vertical_id: number; id: string }[];
  const fks = (await c.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'matches'::regclass AND contype = 'f' AND confrelid = 'intents'::regclass ORDER BY conname`)).rows as { conname: string; def: string }[];
  const pairs = (await c.query(`SELECT m.relid::regclass::text AS m, i.relid::regclass::text AS i
      FROM pg_partition_tree('matches') m JOIN pg_partition_tree('intents') i
        ON pg_get_expr((SELECT relpartbound FROM pg_class WHERE oid = m.relid), m.relid) = pg_get_expr((SELECT relpartbound FROM pg_class WHERE oid = i.relid), i.relid)
     WHERE m.isleaf AND i.isleaf`)).rows as { m: string; i: string }[];

  const run = async (label: string) => {
    const times: number[] = [];
    const pairsWritten: number[] = [];
    for (const [k, x] of ids.entries()) {
      await c.query('SAVEPOINT s');
      const t = performance.now();
      const r = await matchIntentTx(c, reg, { verticalId: x.vertical_id, intentId: String(x.id), trigger: 'job' });
      const ms = performance.now() - t;
      await c.query('ROLLBACK TO SAVEPOINT s');
      if (k >= 3) { times.push(ms); pairsWritten.push(r.totals.confirmed + r.totals.possible); }
    }
    const s = { ...summarize(times), pairsP50: summarize(pairsWritten).p50, pairsMax: Math.max(...pairsWritten) };
    console.log(`${label.padEnd(8)} ${JSON.stringify(s)}`);
    return s;
  };

  await c.query('BEGIN');
  const parent1 = await run('parent');
  await c.query('ROLLBACK');

  await c.query('BEGIN');
  for (const f of fks) await c.query(`ALTER TABLE matches DROP CONSTRAINT ${f.conname}`);
  for (const p of pairs) {
    for (const f of fks) {
      const cols = /FOREIGN KEY \(([^)]+)\)/.exec(f.def)![1];
      await c.query(`ALTER TABLE ${p.m} ADD FOREIGN KEY (${cols}) REFERENCES ${p.i} (vertical_id, id) ON DELETE CASCADE NOT VALID`);
    }
  }
  const leaf = await run('leaf');
  await c.query('ROLLBACK');

  await c.query('BEGIN');
  const parent2 = await run('parent');
  await c.query('ROLLBACK');
  c.release();
  await pool.end();
  const out = { db: DB, samples: SAMPLES, fks: fks.map((f) => f.def), partitionPairs: pairs.length, parent: parent1, leaf, parentAgain: parent2, at: new Date().toISOString() };
  mkdirSync(join(ROOT, 'bench', 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'bench', 'results', 'exp-leaf-fk.json'), JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
