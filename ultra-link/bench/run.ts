// npm run bench:run -- [--db ultralink_bench] [--label after] [--samples 200] [--match-samples 200] [--inserts 2000]
//                      [--skip-match] [--skip-insert] [--seed 7] [--delete-samples 25]
//
// Measures, on the benchmark database built by bench/generate.ts (never the app DB):
//   RANGE retrieval   — engine retrieveCandidates() for seekers with a required scope (direction 'range' only)
//   PROBE retrieval   — engine retrieveCandidates() for intents with a point and no hard scope ('probe' only)
//   BROAD retrieval   — engine retrieveCandidates() without point and hard scope ('broad')
//                       (the real exported function is called through a recording Queryable, so the SQL that is
//                       timed, plan-checked and EXPLAINed is always exactly the engine's current SQL)
//   matchIntent()     — the real engine function (retrieval + evaluation + versioned upserts + notifications)
//   owner list page   — the real listIntents() (first page, 20 cards, exact totals)
//   match list page   — the real listMatches() (first page, 20 cards, exact totals, hydrated)
//   notifications     — the real listNotifications() (first page, 20)
//   contact respond   — the UPDATE … FROM match_refs statement of POST /api/contact-requests/:id/respond
//                       (verbatim from src/server/app.ts), each inside a rolled-back transaction
//   user delete       — DELETE FROM users (ON DELETE CASCADE through intents, refs, scopes, matches, runs,
//                       notifications …) as done by `npm run db:reset-demo`, each inside a rolled-back transaction
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
import { createIntent, intentToSpec, listIntents, loadIntent, rowToMatchable, type IntentRow } from '../src/repo/intents.ts';
import { listNotifications } from '../src/repo/notifications.ts';
import { CANDIDATE_LIMIT, listMatches, matchIntent, matchIntentTx, retrieveCandidates } from '../src/matching/engine.ts';
import { BENCH_DB, argInt, argValue, dbUrl, fmtBytes, fmtMs, summarize } from './lib.ts';

const DB = argValue('db', BENCH_DB)!;
const LABEL = argValue('label', 'run')!;
const SAMPLES = argInt('samples', 200);
const MATCH_SAMPLES = argInt('match-samples', 200);
const INSERTS = argInt('inserts', 2000);
const SEED = argInt('seed', 7);
const DELETE_SAMPLES = argInt('delete-samples', 25);
const SKIP_MATCH = process.argv.includes('--skip-match');
const SKIP_INSERT = process.argv.includes('--skip-insert');
const OUT = join(ROOT, 'bench', 'results', LABEL);

type Q = { sql: string; params: unknown[] };

/** A Queryable that records every statement (text + params) and forwards it. */
function recorder(target: pg.Pool | pg.PoolClient): { db: pg.Pool; log: Q[] } {
  const log: Q[] = [];
  const db = { query: (sql: string, params?: unknown[]) => { log.push({ sql, params: params ?? [] }); return target.query(sql, params); } };
  return { db: db as unknown as pg.Pool, log };
}

// ───────────── helpers ─────────────
async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t = performance.now();
  const out = await fn();
  return [performance.now() - t, out];
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (Array.isArray(v)) return v.length > 12 ? `'{${v.slice(0, 6).join(',')},…}' /* ${v.length} elements, abbreviated here only */` : `'{${v.join(',')}}'`;
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
  const rangeIds = await sampleIds(sc, `status = 'active' AND side = 'seek' AND ${hard}`, SAMPLES + 20);
  const probeIds = await sampleIds(sc, `status = 'active' AND point_place_id IS NOT NULL AND side <> 'join' AND NOT (${hard})`, SAMPLES + 20);
  const broadIds = await sampleIds(sc, `status = 'active' AND point_place_id IS NULL AND NOT (${hard})`, SAMPLES + 20);
  const matchIds = await sampleIds(sc, `status = 'active'`, MATCH_SAMPLES);
  await sc.query('SELECT setseed(0.31)');
  const owners = (await sc.query(`SELECT user_id::text AS u, side FROM intents ORDER BY random() LIMIT $1`, [SAMPLES + 20])).rows as { u: string; side: string }[];
  const recipients = (await sc.query(`SELECT recipient_id::text AS u FROM notifications ORDER BY random() LIMIT $1`, [SAMPLES + 20])).rows as { u: string }[];
  const matchUsers = (await sc.query(`SELECT CASE WHEN random() < 0.5 THEN a_user_id ELSE b_user_id END::text AS u FROM matches ORDER BY random() LIMIT $1`, [SAMPLES + 20])).rows as { u: string }[];
  const pendingContacts = (await sc.query(`SELECT public_id::text AS p, recipient_id::text AS u FROM contact_requests WHERE status = 'pending' ORDER BY random() LIMIT $1`, [SAMPLES + 20])).rows as { p: string; u: string }[];
  // users to delete (rolled back): owners of random intents (activity-weighted, like owners above), excluding the
  // few bulk "dealer" accounts so one sample is not dominated by a 5,000-intent cascade
  const deleteUsers = (await sc.query(
    `SELECT u FROM (SELECT DISTINCT user_id AS u FROM (SELECT user_id FROM intents ORDER BY random() LIMIT $1) s) d
      WHERE (SELECT count(*) FROM intents i WHERE i.user_id = d.u) < 200 LIMIT $2`, [DELETE_SAMPLES * 4, DELETE_SAMPLES + 3])).rows.map((r) => String(r.u));
  sc.release();
  const load = async (xs: { vertical_id: number; id: string }[]) => (await Promise.all(xs.map((x) => loadIntent(pool, x.vertical_id, String(x.id))))).filter((r): r is IntentRow => !!r);
  const rangeRows = await load(rangeIds);
  const probeRows = await load(probeIds);
  const broadRows = await load(broadIds);

  // ── retrieval directions: the engine's exported retrieveCandidates() through a recording Queryable
  //    (warm-up on the first 20 samples, then measure; every recorded statement is plan-checked)
  const planCheck: Record<string, { checked: number; seqScans: string[] }> = {};
  const checkPlan = async (shape: string, q: Q) => {
    const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${q.sql}`, q.params);
    const pc = (planCheck[shape] ??= { checked: 0, seqScans: [] });
    pc.checked++;
    pc.seqScans.push(...seqScans(rows[0]['QUERY PLAN'][0].Plan));
  };
  const directionsSeen: Record<string, Record<string, number>> = {};
  for (const [name, rows] of [['range', rangeRows], ['probe', probeRows], ['broad', broadRows]] as const) {
    const times: number[] = [];
    const counts: number[] = [];
    let worst = { ms: -1, log: [] as Q[], row: rows[0]! };
    let typical: { log: Q[]; row: IntentRow } | null = null;
    for (const [i, row] of rows.entries()) {
      const rec = recorder(pool);
      const [ms, out] = await timed(() => retrieveCandidates(rec.db, reg, row, rowToMatchable(reg, row)));
      const dirs = out.directions.join('+');
      (directionsSeen[name] ??= {})[dirs] = (directionsSeen[name]![dirs] ?? 0) + 1;
      if (i < 20) continue; // warm-up
      times.push(ms);
      counts.push(out.ids.size);
      typical ??= { log: rec.log, row };
      if (ms > worst.ms) worst = { ms, log: rec.log, row };
      for (const q of rec.log) await checkPlan(name, q);
    }
    lat[name] = { ...summarize(times), candidatesP50: summarize(counts).p50, candidatesMax: Math.max(...counts) };
    for (const [k, q] of typical!.log.entries()) await explainAnalyze(pool, name, `typical sample (intent ${typical!.row.vertical_id}:${typical!.row.id}), statement ${k + 1}/${typical!.log.length}`, q);
    for (const [k, q] of worst.log.entries()) await explainAnalyze(pool, name, `slowest sample (intent ${worst.row.vertical_id}:${worst.row.id}, ${fmtMs(worst.ms)} ms), statement ${k + 1}/${worst.log.length}`, q);
    console.log(`  ${name.padEnd(6)} ${JSON.stringify(lat[name])} directions ${JSON.stringify(directionsSeen[name])}`);
  }
  results.directionsSeen = directionsSeen;

  // ── one complete matchIntentTx() with every statement EXPLAIN ANALYZEd in place: before each statement runs for
  //    real, it is executed once under EXPLAIN inside a savepoint that is rolled back; the whole run is rolled back too
  for (const [title, row] of [['RANGE-direction intent', rangeRows[20]!], ['PROBE-direction intent', probeRows[20]!]] as const) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      let k = 0;
      const db = {
        query: async (sql: string, params: unknown[] = []) => {
          k++;
          if (!/^\s*select\s+(pg_advisory_xact_lock|pg_notify|nextval)/i.test(sql)) {
            await c.query('SAVEPOINT bench_explain');
            const { rows: plan } = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
            await c.query('ROLLBACK TO SAVEPOINT bench_explain');
            (explains.match_statements ??= []).push(`-- ${title} ${row.vertical_id}:${row.id} — matchIntentTx statement ${k} (executed in a rolled-back savepoint)\n${inline({ sql, params }).replace(/\n\s+/g, '\n  ')};\n\n${plan.map((r) => r['QUERY PLAN']).join('\n')}\n`);
            if (/^\s*select/i.test(sql)) await checkPlan('match_statements', { sql, params });
          }
          return c.query(sql, params);
        },
      };
      await matchIntentTx(db as unknown as pg.Pool, reg, { verticalId: row.vertical_id, intentId: String(row.id), trigger: 'job' });
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
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
        const rec = recorder(pool);
        await listIntents(rec.db, reg, u, { sides: sides as ('seek' | 'provide' | 'join')[], limit: 20 });
        for (const [k, q] of rec.log.entries()) await explainAnalyze(pool, 'owner_list', `${title} — sides ${sides}, listIntents statement ${k + 1}/${rec.log.length}`, q);
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
      for (const unreadOnly of [false, true]) {
        const rec = recorder(pool);
        await listNotifications(rec.db, u, { limit: 20, unreadOnly });
        for (const [k, q] of rec.log.entries()) await explainAnalyze(pool, 'notifications', `${title}${unreadOnly ? ' — unread only' : ''}, listNotifications statement ${k + 1}/${rec.log.length}`, q);
      }
    }
    console.log(`  notifications ${JSON.stringify(lat.notifications)} (heaviest recipient has ${hn.n})`);

    // match list page (real listMatches: exact total, keyset page, rangeStart, hydration with both intents + contacts)
    const mtimes: number[] = [];
    for (const [i, mu] of matchUsers.entries()) {
      const [ms] = await timed(() => listMatches(pool, reg, mu.u, { states: ['confirmed', 'possible'], limit: 20 }));
      if (i >= 20) mtimes.push(ms);
    }
    lat.match_list = summarize(mtimes);
    const hm = (await pool.query(`SELECT u::text AS u, count(*)::int AS n FROM (SELECT a_user_id AS u FROM matches UNION ALL SELECT b_user_id FROM matches) x GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)).rows[0];
    for (const [title, u] of [[`heaviest match user (user ${hm.u}, ${hm.n} matches)`, hm.u], [`typical match user (user ${matchUsers[20]!.u})`, matchUsers[20]!.u]] as const) {
      const rec = recorder(pool);
      await listMatches(rec.db, reg, u, { states: ['confirmed', 'possible'], limit: 20 });
      for (const [k, q] of rec.log.entries()) await explainAnalyze(pool, 'match_list', `${title}, listMatches statement ${k + 1}/${rec.log.length}`, q);
    }
    console.log(`  match_list ${JSON.stringify(lat.match_list)} (heaviest user has ${hm.n} matches)`);
  }

  // ── contact respond (statement verbatim from src/server/app.ts), rolled back
  if (pendingContacts.length) {
    const respond = (p: { p: string; u: string }): Q => ({
      sql: `UPDATE contact_requests c SET status = $3, responded_at = now() FROM match_refs r
        WHERE c.public_id = $1 AND c.recipient_id = $2 AND c.status = 'pending' AND r.vertical_id = c.vertical_id AND r.match_id = c.match_id
        RETURNING c.public_id, c.status, c.requester_id, r.public_id AS match_public_id`,
      params: [p.p, p.u, 'accepted'],
    });
    const times: number[] = [];
    const c = await pool.connect();
    try {
      for (let i = 0; i < SAMPLES + 20; i++) {
        const q = respond(pendingContacts[i % pendingContacts.length]!);
        await c.query('BEGIN');
        const [ms, r] = await timed(() => c.query(q.sql, q.params));
        await c.query('ROLLBACK');
        if (r.rowCount !== 1) throw new Error('contact respond sample did not update exactly one row');
        if (i >= 20) times.push(ms);
      }
    } finally {
      c.release();
    }
    lat.contact_respond = summarize(times);
    await explainAnalyze(pool, 'contact_respond', 'accept a pending contact request', respond(pendingContacts[0]!), true);
    console.log(`  contact_respond ${JSON.stringify(lat.contact_respond)}`);
  }

  // ── user delete with ON DELETE CASCADE (demo reset path), rolled back
  if (deleteUsers.length > 3) {
    const times: number[] = [];
    const owned: number[] = [];
    const c = await pool.connect();
    try {
      for (const [i, u] of deleteUsers.entries()) {
        await c.query('BEGIN');
        const n = (await c.query('SELECT count(*)::int AS n FROM intents WHERE user_id = $1', [u])).rows[0].n;
        const [ms] = await timed(() => c.query('DELETE FROM users WHERE id = $1', [u]));
        await c.query('ROLLBACK');
        if (i >= 3) { times.push(ms); owned.push(n); }
      }
    } finally {
      c.release();
    }
    lat.user_delete = { ...summarize(times), intentsPerUserP50: summarize(owned).p50, intentsPerUserMax: Math.max(...owned) };
    await explainAnalyze(pool, 'user_delete', `delete user ${deleteUsers[3]} (cascade; trigger lines show where the time goes)`, { sql: 'DELETE FROM users WHERE id = $1', params: [deleteUsers[3]] }, true);
    console.log(`  user_delete ${JSON.stringify(lat.user_delete)}`);
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
