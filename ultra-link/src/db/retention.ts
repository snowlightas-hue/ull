// Data retention for operational tables (never intents, matches or users).
//
//   node src/db/retention.ts [--db app|test|bench] [--dry-run] [--batch 10000]
//
// Policy (defaults; override with UL_RETENTION_* env or the `policy` argument):
//   notifications   read  and older than 90 days → deleted; ANY notification older than 180 days → deleted.
//                   (The (recipient, dedupe_key) pair becomes reusable after deletion: an event that happens again
//                   after 90/180 days may notify again — acceptable and intended.)
//   jobs            done/superseded older than 7 days, failed older than 30 days (by finished_at, else created_at).
//   sessions        expired more than 1 day ago (the server also deletes expired sessions lazily).
//   match_runs      older than 30 days, EXCEPT the newest run of each intent (the API shows it).
//   extraction_runs older than 180 days (advisor evidence window).
//
// Mechanics: each table is walked by primary-key windows of `batch` ids, one short DELETE per window (the PK range
// scan plus a filter; no extra index, no long transaction, no lock escalation). Cost is O(table) per run, about
// 10 ms per 10k-id window on the benchmark machine; schedule daily (cron or the worker), off-peak.
import type pg from 'pg';
import { closePools, getPool } from './pool.ts';
import { urlFromArgs } from './target.ts';

export interface RetentionPolicy {
  notificationsReadDays: number;
  notificationsAnyDays: number;
  jobsDoneDays: number;
  jobsFailedDays: number;
  sessionsExpiredDays: number;
  matchRunsDays: number;
  extractionRunsDays: number;
}

const num = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : d;
};

export const DEFAULT_POLICY: RetentionPolicy = {
  notificationsReadDays: num('UL_RETENTION_NOTIFICATIONS_READ_DAYS', 90),
  notificationsAnyDays: num('UL_RETENTION_NOTIFICATIONS_ANY_DAYS', 180),
  jobsDoneDays: num('UL_RETENTION_JOBS_DONE_DAYS', 7),
  jobsFailedDays: num('UL_RETENTION_JOBS_FAILED_DAYS', 30),
  sessionsExpiredDays: num('UL_RETENTION_SESSIONS_EXPIRED_DAYS', 1),
  matchRunsDays: num('UL_RETENTION_MATCH_RUNS_DAYS', 30),
  extractionRunsDays: num('UL_RETENTION_EXTRACTION_RUNS_DAYS', 180),
};

interface Rule { table: string; where: string; params: (now: Date, p: RetentionPolicy) => unknown[] }

const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

/** Predicates per id-keyed table. `$1/$2` are the window bounds; further params come from `params()`. */
export const RULES: Rule[] = [
  {
    table: 'notifications',
    where: '((read_at IS NOT NULL AND created_at < $3) OR created_at < $4)',
    params: (now, p) => [daysAgo(now, p.notificationsReadDays), daysAgo(now, p.notificationsAnyDays)],
  },
  {
    table: 'jobs',
    where: `((status IN ('done', 'superseded') AND coalesce(finished_at, created_at) < $3) OR (status = 'failed' AND coalesce(finished_at, created_at) < $4))`,
    params: (now, p) => [daysAgo(now, p.jobsDoneDays), daysAgo(now, p.jobsFailedDays)],
  },
  {
    table: 'match_runs',
    where: `created_at < $3 AND EXISTS (SELECT 1 FROM match_runs n WHERE n.vertical_id = t.vertical_id AND n.intent_id = t.intent_id AND n.id > t.id)`,
    params: (now, p) => [daysAgo(now, p.matchRunsDays)],
  },
  {
    table: 'extraction_runs',
    where: 'created_at < $3',
    params: (now, p) => [daysAgo(now, p.extractionRunsDays)],
  },
];

export interface RetentionResult { table: string; deleted: number; windows: number; ms: number }

export async function runRetention(
  db: pg.Pool,
  opts: { policy?: Partial<RetentionPolicy>; batch?: number; dryRun?: boolean; now?: Date; log?: (s: string) => void } = {},
): Promise<RetentionResult[]> {
  const policy = { ...DEFAULT_POLICY, ...opts.policy };
  const batch = Math.max(100, opts.batch ?? 10_000);
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const out: RetentionResult[] = [];
  for (const rule of RULES) {
    const t0 = Date.now();
    const { rows } = await db.query(`SELECT min(id)::text AS lo, max(id)::text AS hi FROM ${rule.table}`);
    let deleted = 0;
    let windows = 0;
    if (rows[0].lo !== null) {
      const hi = BigInt(rows[0].hi);
      for (let lo = BigInt(rows[0].lo); lo <= hi; lo += BigInt(batch)) {
        const params = [lo.toString(), (lo + BigInt(batch)).toString(), ...rule.params(now, policy)];
        const sql = opts.dryRun
          ? `SELECT count(*)::int AS n FROM ${rule.table} t WHERE t.id >= $1 AND t.id < $2 AND ${rule.where}`
          : `DELETE FROM ${rule.table} t WHERE t.id >= $1 AND t.id < $2 AND ${rule.where}`;
        const r = await db.query(sql, params);
        deleted += opts.dryRun ? r.rows[0].n : r.rowCount ?? 0;
        windows++;
      }
    }
    out.push({ table: rule.table, deleted, windows, ms: Date.now() - t0 });
    log(`${rule.table}: ${opts.dryRun ? 'would delete' : 'deleted'} ${deleted} row(s) in ${windows} window(s), ${Date.now() - t0} ms`);
  }
  // sessions: keyed by token hash, but expires_at is indexed — bounded batches by expiry
  {
    const t0 = Date.now();
    const cutoff = daysAgo(now, policy.sessionsExpiredDays);
    let deleted = 0;
    let windows = 0;
    if (opts.dryRun) {
      deleted = (await db.query('SELECT count(*)::int AS n FROM sessions WHERE expires_at < $1', [cutoff])).rows[0].n;
    } else {
      for (;;) {
        const r = await db.query('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < $1 ORDER BY expires_at LIMIT $2)', [cutoff, batch]);
        windows++;
        deleted += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) < batch) break;
      }
    }
    out.push({ table: 'sessions', deleted, windows, ms: Date.now() - t0 });
    log(`sessions: ${opts.dryRun ? 'would delete' : 'deleted'} ${deleted} row(s), ${Date.now() - t0} ms`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url, target } = urlFromArgs();
  const dryRun = process.argv.includes('--dry-run');
  const bi = process.argv.indexOf('--batch');
  const batch = bi >= 0 ? Number(process.argv[bi + 1]) : undefined;
  console.log(`retention on ${target}${dryRun ? ' (dry run)' : ''}: ${JSON.stringify(DEFAULT_POLICY)}`);
  runRetention(getPool(url), { dryRun, batch, log: (s) => console.log(`  ${s}`) })
    .then(() => closePools())
    .catch(async (e) => { console.error((e as Error).message); await closePools(); process.exit(1); });
}
