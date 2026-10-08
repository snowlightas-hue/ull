// npm run bench:run -- [--db ultralink_bench] [--label after] [--samples 200] [--match-samples 200] [--inserts 2000]
//                      [--skip-match] [--skip-insert] [--seed 7]
//
// Measures, on the benchmark database built by bench/generate.ts (never the app DB):
//   RANGE retrieval   — the engine's RANGE direction for intents with a required scope (one range scan per scope
//                       place + the bounded "outside scope" count + the unknown-point sample), same SQL as
//                       src/matching/engine.ts#retrieveCandidates
//   PROBE retrieval   — intent_scopes equality probe with the point's ancestors
//   BROAD retrieval   — recent counterparts in the category (no point, no hard scope)
//   matchIntent()     — the real engine function (retrieval + evaluation + versioned upserts + notifications)
//   owner list page   — the real listIntents() (first page, 20 cards, exact totals)
//   notifications     — the real listNotifications() (first page, 20)
//   insert throughput — the real createIntent() (intent + intent_refs + intent_scopes) in its own transaction,
//                       sequential and 4 concurrent connections
// plus table/index sizes, EXPLAIN (ANALYZE, BUFFERS) per query shape (bench/results/<label>/explain-*.txt), and a
// plan check over every sampled matching query: no Seq Scan on intents / intent_scopes / matches partitions.
// Latencies are wall-clock from the Node client over localhost TCP with a warm cache (the data set fits in RAM).
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { withTx } from '../src/db/pool.ts';
import { ROOT } from '../src/lib/env.ts';
import { loadRegistry } from '../src/seed/reference.ts';
import type { Registry } from '../src/domain/registry.ts';
import { INTENT_COLS, createIntent, intentToSpec, listIntents, loadIntent, rowToMatchable, type IntentRow } from '../src/repo/intents.ts';
import { listNotifications } from '../src/repo/notifications.ts';
import { CANDIDATE_LIMIT, matchIntent } from '../src/matching/engine.ts';
import { BENCH_DB, argInt, argValue, dbUrl, fmtBytes, fmtMs, summarize } from './lib.ts';

const DB = argValue('db', BENCH_DB)!;
const LABEL = argValue('label', 'run')!;
const SAMPLES = argInt('samples', 200);
const MATCH_SAMPLES = argInt('match-samples', 200);
const INSERTS = argInt('inserts', 2000);
const SEED = argInt('seed', 7);
const SKIP_MATCH = process.argv.includes('--skip-match');
const SKIP_INSERT = process.argv.includes('--skip-insert');
const OUT = join(ROOT, 'bench', 'results', LABEL);

type Q = { sql: string; params: unknown[] };

// ───────────── the engine's retrieval SQL (verbatim from src/matching/engine.ts) ─────────────
function counterpart(reg: Registry, row: IntentRow) {
  const me = rowToMatchable(reg, row);
  const counterSide = me.side === 'join' ? 'join' : me.side === 'seek' ? 'provide' : 'seek';
  const cat = reg.categoryByCode.get(me.categoryCode)!;
  const catSet = [...new Set([...cat.ancestors, ...cat.descendants])];
  const scope = me.scopePlaceIds.filter((p) => p !== reg.rootPlaceId);
  const hardScope = scope.length > 0 && me.scopeStrength === 'required';
  return { me, counterSide, cat, catSet, scope, hardScope };
}

function rangeQueries(reg: Registry, row: IntentRow): Q[] {
  const { me, counterSide, catSet, scope } = counterpart(reg, row);
  const qs: Q[] = scope.map((s) => {
    const p = reg.placeById.get(s)!;
    return {
      sql: `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
            AND status = 'active' AND point_lft BETWEEN $6 AND $7 AND user_id <> $8
          ORDER BY created_at DESC LIMIT $9`,
      params: [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, p.lft, p.rgt, me.userId, CANDIDATE_LIMIT],
    };
  });
  qs.push({
    sql: `SELECT count(*)::int AS n FROM (SELECT 1 FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4
          AND category_id = ANY($5) AND status = 'active' AND user_id <> $6 AND point_lft IS NOT NULL
          AND ${scope.map((_, k) => `NOT (point_lft BETWEEN $${7 + 2 * k} AND $${8 + 2 * k})`).join(' AND ')} LIMIT 1000) x`,
    params: [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, me.userId, ...scope.flatMap((s) => [reg.placeById.get(s)!.lft, reg.placeById.get(s)!.rgt])],
  });
  qs.push({
    sql: `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
          AND status = 'active' AND point_lft IS NULL AND user_id <> $6 ORDER BY created_at DESC LIMIT 200`,
    params: [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, me.userId],
  });
  return qs;
}

function probeQuery(reg: Registry, row: IntentRow): Q {
  const { me, counterSide, cat, catSet } = counterpart(reg, row);
  const placeAnc = reg.placeById.get(me.pointPlaceId!)!.ancestors;
  return {
    sql: `SELECT DISTINCT s.intent_id AS id FROM intent_scopes s
        WHERE s.vertical_id = $1 AND s.realm = $2 AND s.side = $3 AND s.deal_type_id = $4 AND s.category_id = ANY($5) AND s.place_id = ANY($6)
        LIMIT $7`,
    params: [row.vertical_id, me.realm, counterSide, row.deal_type_id, me.side === 'join' ? catSet : cat.ancestors.concat(cat.descendants), placeAnc, CANDIDATE_LIMIT],
  };
}

function broadQueries(reg: Registry, row: IntentRow): Q[] {
  const { me, counterSide, catSet, scope } = counterpart(reg, row);
  const qs: Q[] = scope.map((s) => {
    const p = reg.placeById.get(s)!;
    return {
      sql: `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
              AND status = 'active' AND point_lft BETWEEN $6 AND $7 AND user_id <> $8 ORDER BY created_at DESC LIMIT $9`,
      params: [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, p.lft, p.rgt, me.userId, CANDIDATE_LIMIT],
    };
  });
  qs.push({
    sql: `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
          AND status = 'active' AND user_id <> $6 ORDER BY created_at DESC LIMIT $7`,
    params: [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, me.userId, CANDIDATE_LIMIT],
  });
  return qs;
}

// ───────────── helpers ─────────────
async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t = performance.now();
  const out = await fn();
  return [performance.now() - t, out];
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (Array.isArray(v)) return `'{${v.join(',')}}'`;
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
/** Inline parameters for a readable EXPLAIN file (the server plans unnamed statements with the real values too). */
const inline = (q: Q) => q.sql.replace(/\$(\d+)/g, (_, i) => lit(q.params[Number(i) - 1]));

const SEQ_WATCH = /^(intents|intent_scopes|matches)(_|$)/;
function seqScans(plan: any, acc: string[] = []): string[] {
  if (plan['Node Type'] === 'Seq Scan' && SEQ_WATCH.test(plan['Relation Name'] ?? '')) acc.push(plan['Relation Name']);
  for (const p of plan.Plans ?? []) seqScans(p, acc);
  return acc;
}

const explains: Record<string, string[]> = {};
async function explainAnalyze(db: pg.Pool | pg.PoolClient, shape: string, title: string, q: Q, rollback = false): Promise<void> {
  const c = 'release' in db ? db : await (db as pg.Pool).connect();
  try {
    if (rollback) await c.query('BEGIN');
    const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${q.sql}`, q.params).finally(() => (rollback ? c.query('ROLLBACK') : undefined));
    (explains[shape] ??= []).push(`-- ${title}${rollback ? ' (executed inside a rolled-back transaction)' : ''}\n${inline(q).replace(/\n\s+/g, '\n  ')};\n\n${rows.map((r) => r['QUERY PLAN']).join('\n')}\n`);
  } finally {
    if (c !== db) (c as pg.PoolClient).release();
  }
}

async function sampleIds(c: pg.PoolClient, where: string, n: number): Promise<{ vertical_id: number; id: string }[]> {
  // deterministic sample: setseed + ORDER BY random() (one pass over the filtered rows at setup time)
  await c.query('SELECT setseed($1)', [((SEED % 1000) + 1) / 1001]);
  return (await c.query(`SELECT vertical_id, id FROM intents WHERE ${where} ORDER BY random() LIMIT $1`, [n])).rows;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const pool = new pg.Pool({ connectionString: dbUrl(DB), max: 8 });
  const reg = await loadRegistry(pool);
  const results: Record<string, unknown> = {};
  const lat: Record<string, ReturnType<typeof summarize> & Record<string, unknown>> = {};

  // ── machine & server
  const settings = Object.fromEntries((await pool.query(
    `SELECT name, current_setting(name) AS v FROM pg_settings WHERE name IN ('shared_buffers','work_mem','effective_cache_size','random_page_cost','jit','max_parallel_workers_per_gather','server_version')`,
  )).rows.map((r) => [r.name, r.v]));
  const machine = {
    nproc: Number(execSync('nproc').toString().trim()),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    memTotal: fmtBytes(os.totalmem()),
    free: execSync('free -h').toString().trim(),
    node: process.version,
    postgres: settings,
  };
  results.machine = machine;
  results.dataset = (await pool.query(`
    SELECT (SELECT count(*) FROM intents)::int AS intents, (SELECT count(*) FROM intents WHERE status = 'active')::int AS active_intents,
           (SELECT count(*) FROM intent_scopes)::int AS intent_scopes, (SELECT count(*) FROM matches)::int AS matches,
           (SELECT count(*) FROM notifications)::int AS notifications, (SELECT count(*) FROM users)::int AS users,
           (SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations) AS migrations`)).rows[0];
  console.log(`bench:run label=${LABEL} db=${DB} samples=${SAMPLES} — ${JSON.stringify(results.dataset)}`);
  console.log(`machine: ${machine.nproc} vCPU (${machine.cpuModel}), RAM ${machine.memTotal}; PostgreSQL ${settings.server_version}, shared_buffers ${settings.shared_buffers}`);

  // ── samples (deterministic)
  const sc = await pool.connect();
  const hard = `scope_strength = 'required' AND cardinality(scope_place_ids) > 0`;
  const rangeIds = await sampleIds(sc, `status = 'active' AND side IN ('seek','join') AND ${hard}`, SAMPLES + 20);
  const probeIds = await sampleIds(sc, `status = 'active' AND point_place_id IS NOT NULL AND (NOT (${hard}) OR side = 'join')`, SAMPLES + 20);
  const broadIds = await sampleIds(sc, `status = 'active' AND point_place_id IS NULL AND NOT (${hard})`, SAMPLES + 20);
  const matchIds = await sampleIds(sc, `status = 'active'`, MATCH_SAMPLES);
  await sc.query('SELECT setseed(0.31)');
  const owners = (await sc.query(`SELECT user_id::text AS u, side FROM intents ORDER BY random() LIMIT $1`, [SAMPLES + 20])).rows as { u: string; side: string }[];
  const recipients = (await sc.query(`SELECT recipient_id::text AS u FROM notifications ORDER BY random() LIMIT $1`, [SAMPLES + 20])).rows as { u: string }[];
  sc.release();
  const load = async (xs: { vertical_id: number; id: string }[]) => (await Promise.all(xs.map((x) => loadIntent(pool, x.vertical_id, String(x.id))))).filter((r): r is IntentRow => !!r);
  const rangeRows = await load(rangeIds);
  const probeRows = await load(probeIds);
  const broadRows = await load(broadIds);

  // ── retrieval shapes (warm-up on the first 20 samples, then measure)
  const planCheck: Record<string, { checked: number; seqScans: string[] }> = {};
  const checkPlan = async (shape: string, q: Q) => {
    const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${q.sql}`, q.params);
    const pc = (planCheck[shape] ??= { checked: 0, seqScans: [] });
    pc.checked++;
    pc.seqScans.push(...seqScans(rows[0]['QUERY PLAN'][0].Plan));
  };
  const shapes: { name: string; rows: IntentRow[]; build: (r: IntentRow) => Q[] }[] = [
    { name: 'range', rows: rangeRows, build: (r) => rangeQueries(reg, r) },
    { name: 'probe', rows: probeRows, build: (r) => [probeQuery(reg, r)] },
    { name: 'broad', rows: broadRows, build: (r) => broadQueries(reg, r) },
  ];
  for (const s of shapes) {
    const times: number[] = [];
    const counts: number[] = [];
    let worst = { ms: -1, row: s.rows[0]! };
    for (const [i, row] of s.rows.entries()) {
      const qs = s.build(row);
      let n = 0;
      const [ms] = await timed(async () => { for (const q of qs) n += (await pool.query(q.sql, q.params)).rowCount ?? 0; });
      if (i < 20) continue; // warm-up
      times.push(ms);
      counts.push(n);
      if (ms > worst.ms) worst = { ms, row };
      for (const q of qs) await checkPlan(s.name, q);
    }
    lat[s.name] = { ...summarize(times), rowsP50: summarize(counts).p50, rowsMax: Math.max(...counts) };
    const first = s.rows[20] ?? s.rows[0]!;
    for (const [k, q] of s.build(first).entries()) await explainAnalyze(pool, s.name, `typical sample (intent ${first.vertical_id}:${first.id}), query ${k + 1}`, q);
    for (const [k, q] of s.build(worst.row).entries()) await explainAnalyze(pool, s.name, `slowest sample (intent ${worst.row.vertical_id}:${worst.row.id}, ${fmtMs(worst.ms)} ms), query ${k + 1}`, q);
    console.log(`  ${s.name.padEnd(6)} ${JSON.stringify(lat[s.name])}`);
  }

  // matchIntent's other statements (EXPLAIN only): candidate fetch, existing matches, upsert, notification insert
  {
    const row = rangeRows[20]!;
    const ids = (await pool.query(rangeQueries(reg, row)[0]!.sql, rangeQueries(reg, row)[0]!.params)).rows.map((r) => String(r.id));
    const cand: Q = { sql: `SELECT ${INTENT_COLS} FROM intents i WHERE i.vertical_id = $1 AND i.id = ANY($2::bigint[])`, params: [row.vertical_id, ids] };
    const existing: Q = { sql: `SELECT id, public_id, a_intent_id, b_intent_id, state, a_user_id, b_user_id FROM matches WHERE vertical_id = $1 AND (a_intent_id = $2 OR b_intent_id = $2)`, params: [row.vertical_id, row.id] };
    await checkPlan('candidates', cand);
    await checkPlan('existing_matches', existing);
    await explainAnalyze(pool, 'match_statements', `candidate rows by primary key (${ids.length} ids)`, cand);
    await explainAnalyze(pool, 'match_statements', 'existing matches of the intent', existing);
    const other = ids[0] ?? row.id;
    const otherRow = await loadIntent(pool, row.vertical_id, other);
    await explainAnalyze(pool, 'match_statements', 'versioned match upsert', {
      sql: `INSERT INTO matches (vertical_id, kind, a_intent_id, b_intent_id, a_user_id, b_user_id, state, score, reasons, missing, a_version, b_version, eval_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (vertical_id, a_intent_id, b_intent_id) DO UPDATE SET
           state = EXCLUDED.state, score = EXCLUDED.score, reasons = EXCLUDED.reasons, missing = EXCLUDED.missing,
           a_version = EXCLUDED.a_version, b_version = EXCLUDED.b_version, eval_seq = EXCLUDED.eval_seq, invalid_reason_ar = NULL, updated_at = now()
         WHERE matches.eval_seq < EXCLUDED.eval_seq AND matches.a_version <= EXCLUDED.a_version AND matches.b_version <= EXCLUDED.b_version
         RETURNING id, public_id, (first_matched_at = now()) AS inserted`,
      params: [row.vertical_id, 'exchange', row.id, other, row.user_id, otherRow!.user_id === row.user_id ? '1' : otherRow!.user_id, 'confirmed', 7000, '[]', '[]', row.version, otherRow!.version, '999999999'],
    }, true);
    await explainAnalyze(pool, 'match_statements', 'notification insert (dedupe)', {
      sql: `INSERT INTO notifications (recipient_id, kind, title_ar, body_ar, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (recipient_id, dedupe_key) DO NOTHING RETURNING id`,
      params: [row.user_id, 'match_new', 'مطابقة جديدة مناسبة', 'x', '{}', `bench:${Date.now()}`],
    }, true);
  }

  // ── owner list page (real listIntents) and notifications page (real listNotifications)
  {
    const times: number[] = [];
    for (const [i, o] of owners.entries()) {
      const sides = o.side === 'provide' ? (['provide'] as const) : (['seek', 'join'] as const);
      const [ms] = await timed(() => listIntents(pool, reg, o.u, { sides: [...sides], limit: 20 }));
      if (i >= 20) times.push(ms);
    }
    lat.owner_list = summarize(times);
    const heavy = (await pool.query('SELECT user_id::text AS u, count(*)::int AS n FROM intents GROUP BY 1 ORDER BY 2 DESC LIMIT 1')).rows[0];
    for (const [title, u] of [[`heaviest owner (user ${heavy.u}, ${heavy.n} intents)`, heavy.u], [`typical owner (user ${owners[20]!.u})`, owners[20]!.u]] as const) {
      for (const sides of [['provide'], ['seek', 'join']]) {
        const statuses = ['active', 'paused', 'fulfilled', 'closed', 'expired'];
        await explainAnalyze(pool, 'owner_list', `${title} — total, sides ${sides}`, { sql: 'SELECT count(*) FROM intents WHERE user_id = $1 AND side = ANY($2) AND status = ANY($3)', params: [u, sides, statuses] });
        await explainAnalyze(pool, 'owner_list', `${title} — first page, sides ${sides}`, { sql: `SELECT ${INTENT_COLS} FROM intents i WHERE i.user_id = $1 AND i.side = ANY($2) AND i.status = ANY($3)  ORDER BY i.created_at DESC, i.id DESC LIMIT $4`, params: [u, sides, statuses, 21] });
      }
    }
    console.log(`  owner_list ${JSON.stringify(lat.owner_list)} (heaviest owner has ${heavy.n} intents)`);

    const ntimes: number[] = [];
    for (const [i, rcp] of recipients.entries()) {
      const [ms] = await timed(() => listNotifications(pool, rcp.u, { limit: 20 }));
      if (i >= 20) ntimes.push(ms);
    }
    lat.notifications = summarize(ntimes);
    const hn = (await pool.query('SELECT recipient_id::text AS u, count(*)::int AS n FROM notifications GROUP BY 1 ORDER BY 2 DESC LIMIT 1')).rows[0];
    for (const [title, u] of [[`heaviest recipient (user ${hn.u}, ${hn.n} notifications)`, hn.u], [`typical recipient (user ${recipients[20]!.u})`, recipients[20]!.u]] as const) {
      await explainAnalyze(pool, 'notifications', `${title} — total`, { sql: 'SELECT count(*) FROM notifications WHERE recipient_id = $1', params: [u] });
      await explainAnalyze(pool, 'notifications', `${title} — unread`, { sql: 'SELECT count(*) FROM notifications WHERE recipient_id = $1 AND read_at IS NULL', params: [u] });
      await explainAnalyze(pool, 'notifications', `${title} — first page`, { sql: `SELECT id, public_id, kind, title_ar, body_ar, payload, created_at, created_at::text AS created_key, read_at FROM notifications
      WHERE recipient_id = $1   ORDER BY created_at DESC, id DESC LIMIT $2`, params: [u, 21] });
      await explainAnalyze(pool, 'notifications', `${title} — first unread page`, { sql: `SELECT id, public_id, kind, title_ar, body_ar, payload, created_at, created_at::text AS created_key, read_at FROM notifications
      WHERE recipient_id = $1 AND read_at IS NULL  ORDER BY created_at DESC, id DESC LIMIT $2`, params: [u, 21] });
    }
    console.log(`  notifications ${JSON.stringify(lat.notifications)} (heaviest recipient has ${hn.n})`);
  }

  // ── worker statements (EXPLAIN only): job claim and expiry sweep
  await explainAnalyze(pool, 'worker', 'job claim (SKIP LOCKED)', {
    sql: `WITH next AS (
       SELECT id FROM jobs
        WHERE ((status = 'pending' AND run_at <= now()) OR (status = 'running' AND locked_until < now()))
          AND ($3::text[] IS NULL OR kind = ANY($3))
        ORDER BY priority, run_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1)
     UPDATE jobs j SET status = 'running', locked_by = $1, locked_until = now() + make_interval(secs => $2), attempts = j.attempts + 1, started_at = now()
       FROM next WHERE j.id = next.id
     RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts`, params: ['bench', 60, null],
  }, true);
  await explainAnalyze(pool, 'worker', 'expiry sweep', { sql: "SELECT vertical_id, id, user_id, title_ar FROM intents WHERE status = 'active' AND expires_at < now() ORDER BY expires_at LIMIT 500", params: [] });

  // ── insert throughput (real createIntent: intent + intent_refs + intent_scopes, one transaction each)
  if (!SKIP_INSERT && INSERTS > 0) {
    const src = await load((await pool.query(`SELECT vertical_id, id FROM intents WHERE status = 'active' ORDER BY id DESC LIMIT 500`)).rows);
    const specs = src.map((r) => ({ spec: intentToSpec(reg, r), title: r.title_ar, user: r.user_id }));
    const one = async (k: number) => {
      const s = specs[k % specs.length]!;
      return timed(() => withTx(pool, (tx) => createIntent(tx, reg, { userId: String(s.user), realm: 'real', spec: s.spec, titleAr: s.title, sourceText: null, conversationId: null })));
    };
    const seqLat: number[] = [];
    const t0 = performance.now();
    for (let k = 0; k < INSERTS; k++) seqLat.push((await one(k))[0]);
    const seqSec = (performance.now() - t0) / 1000;
    const parLat: number[] = [];
    let next = 0;
    const t1 = performance.now();
    await Promise.all(Array.from({ length: 4 }, async () => { while (next < INSERTS) { const k = next++; parLat.push((await one(k))[0]); } }));
    const parSec = (performance.now() - t1) / 1000;
    results.insert = {
      sequential: { intents: INSERTS, seconds: Math.round(seqSec * 100) / 100, perSec: Math.round(INSERTS / seqSec), latency: summarize(seqLat) },
      concurrent4: { intents: INSERTS, seconds: Math.round(parSec * 100) / 100, perSec: Math.round(INSERTS / parSec), latency: summarize(parLat) },
    };
    console.log(`  insert ${JSON.stringify(results.insert)}`);
  }

  // ── sizes (partitioned tables/indexes summed over their partitions)
  results.sizes = (await pool.query(`
    WITH rels AS (
      SELECT c.oid, c.relname, c.relkind FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND (c.relkind = 'p' OR (c.relkind = 'r' AND NOT c.relispartition))),
    leaves AS (
      SELECT r.relname, coalesce(t.relid, r.oid) AS relid FROM rels r
        LEFT JOIN LATERAL pg_partition_tree(r.oid) t ON r.relkind = 'p' AND t.isleaf
       WHERE r.relkind = 'r' OR t.relid IS NOT NULL)
    SELECT relname AS table, sum(pg_table_size(relid))::bigint AS table_bytes, sum(pg_indexes_size(relid))::bigint AS index_bytes,
           sum(pg_total_relation_size(relid))::bigint AS total_bytes
      FROM leaves GROUP BY relname ORDER BY 4 DESC LIMIT 12`)).rows.map((r) => ({ ...r, table_bytes: Number(r.table_bytes), index_bytes: Number(r.index_bytes), total_bytes: Number(r.total_bytes) }));
  results.indexSizes = (await pool.query(`
    SELECT i.relname AS index, t.relname AS table,
           coalesce((SELECT sum(pg_relation_size(p.relid)) FROM pg_partition_tree(i.oid) p WHERE p.isleaf), pg_relation_size(i.oid))::bigint AS bytes
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
     WHERE t.relname IN ('intents', 'intent_scopes', 'intent_refs', 'matches', 'notifications') AND NOT i.relispartition
     ORDER BY t.relname, 3 DESC`)).rows.map((r) => ({ ...r, bytes: Number(r.bytes) }));

  // ── full matchIntent (last: it writes matches/notifications/match_runs)
  if (!SKIP_MATCH && MATCH_SAMPLES > 0) {
    const times: number[] = [];
    const cands: number[] = [];
    let truncated = 0;
    const byDir: Record<string, number[]> = {};
    for (const [i, x] of matchIds.entries()) {
      const [ms, r] = await timed(() => matchIntent(pool, reg, { verticalId: x.vertical_id, intentId: String(x.id), trigger: 'job' }));
      times.push(ms);
      cands.push(r.totals.candidates);
      if (r.truncated) truncated++;
      (byDir[r.directions.join('+') || 'none'] ??= []).push(ms);
      if ((i + 1) % 25 === 0) console.log(`    matchIntent ${i + 1}/${matchIds.length} p50 so far ${fmtMs(summarize(times).p50)} ms`);
    }
    lat.match_intent = { ...summarize(times), candidatesP50: summarize(cands).p50, candidatesMax: Math.max(...cands), truncatedPct: Math.round((100 * truncated) / times.length) };
    results.matchByDirection = Object.fromEntries(Object.entries(byDir).map(([k, v]) => [k, summarize(v)]));
    console.log(`  matchIntent ${JSON.stringify(lat.match_intent)}`);
  }

  results.latencyMs = lat;
  results.planCheck = Object.fromEntries(Object.entries(planCheck).map(([k, v]) => [k, { checked: v.checked, seqScansOnIntentsScopesMatches: v.seqScans.length, relations: [...new Set(v.seqScans)] }]));
  const seqTotal = Object.values(planCheck).reduce((a, v) => a + v.seqScans.length, 0);
  results.noSeqScanOnMatchingQueries = seqTotal === 0;
  results.params = { db: DB, label: LABEL, samples: SAMPLES, matchSamples: SKIP_MATCH ? 0 : MATCH_SAMPLES, inserts: SKIP_INSERT ? 0 : INSERTS, seed: SEED, candidateLimit: CANDIDATE_LIMIT, at: new Date().toISOString() };

  for (const [shape, parts] of Object.entries(explains)) writeFileSync(join(OUT, `explain-${shape}.txt`), parts.join('\n') + '\n');
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2) + '\n');

  // ── human-readable summary
  const lines = [
    `| shape | samples | p50 ms | p95 ms | p99 ms | max ms |`,
    `|---|---:|---:|---:|---:|---:|`,
    ...Object.entries(lat).map(([k, v]) => `| ${k} | ${v.n} | ${fmtMs(v.p50)} | ${fmtMs(v.p95)} | ${fmtMs(v.p99)} | ${fmtMs(v.max)} |`),
  ];
  console.log('\n' + lines.join('\n'));
  console.log(`\nplan check: ${Object.entries(results.planCheck as Record<string, { checked: number; seqScansOnIntentsScopesMatches: number }>).map(([k, v]) => `${k} ${v.checked} plans/${v.seqScansOnIntentsScopesMatches} seq scans`).join(', ')} → ${seqTotal === 0 ? 'NO Seq Scan on intents/intent_scopes/matches' : 'SEQ SCANS FOUND'}`);
  console.log('sizes:');
  for (const s of results.sizes as { table: string; table_bytes: number; index_bytes: number; total_bytes: number }[]) console.log(`  ${s.table.padEnd(22)} table ${fmtBytes(s.table_bytes).padStart(8)}  indexes ${fmtBytes(s.index_bytes).padStart(8)}  total ${fmtBytes(s.total_bytes).padStart(8)}`);
  console.log(`results: ${join('bench', 'results', LABEL)}/results.json, explain-*.txt`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
