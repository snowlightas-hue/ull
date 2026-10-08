// Background worker: match jobs (versioned; stale jobs are superseded), expiry sweep, heartbeat.
// Every job is idempotent: a retry after a crash or a lost lease repeats at most work that is already
// guarded (eval_seq / versions for matches, UNIQUE dedupe keys for notifications).
import { hostname } from 'node:os';
import pg from 'pg';
import { loadEnv } from '../lib/env.ts';
import { closePools, getPool, withTx } from '../db/pool.ts';
import { loadRegistry } from '../seed/reference.ts';
import { claim, complete, enqueue, fail, type Job } from '../repo/jobs.ts';
import { setIntentStatus } from '../repo/intents.ts';
import { notify } from '../repo/notifications.ts';
import { latestRun, matchIntent, type MatchTrigger } from '../matching/engine.ts';
import type { Registry } from '../domain/registry.ts';

/** Max intents one expire_sweep job expires (the next sweep continues). */
export const SWEEP_MAX = Number(process.env.UL_SWEEP_MAX ?? 2000);

export async function runJob(pool: pg.Pool, reg: Registry, job: Job): Promise<'done' | 'superseded'> {
  if (job.kind === 'match_intent') {
    const p = job.payload as { verticalId: number; intentId: string; version: number; trigger?: MatchTrigger };
    const cur = await pool.query('SELECT version FROM intents WHERE vertical_id = $1 AND id = $2', [p.verticalId, p.intentId]);
    if (!cur.rows[0] || cur.rows[0].version !== p.version) return 'superseded'; // a newer version has its own job
    // the interactive / edit / status path usually evaluated this exact version already (a run row is only
    // committed together with its writes) → nothing left to do
    if (await latestRun(pool, p.verticalId, p.intentId, p.version)) return 'done';
    const r = await matchIntent(pool, reg, { verticalId: p.verticalId, intentId: p.intentId, version: p.version, trigger: p.trigger ?? 'job' });
    return r.status === 'superseded' ? 'superseded' : 'done';
  }
  if (job.kind === 'expire_sweep') {
    await sweepExpired(pool, reg);
    return 'done';
  }
  throw new Error(`unknown job kind ${job.kind}`);
}

export interface Processed {
  job: Job;
  /** done/superseded = finished; retry = rescheduled with backoff; failed = max_attempts reached; lease_lost = fenced out. */
  outcome: 'done' | 'superseded' | 'retry' | 'failed' | 'lease_lost';
  ms: number;
  error?: string;
}

/** One worker iteration: claim the next due job, run it, and record the outcome (fenced to this claim). */
export async function processNext(pool: pg.Pool, reg: Registry, workerId: string, opts: { leaseSeconds?: number; kinds?: string[] } = {}): Promise<Processed | null> {
  const job = await claim(pool, workerId, opts.leaseSeconds ?? 60, opts.kinds);
  if (!job) return null;
  const t0 = Date.now();
  try {
    const status = await runJob(pool, reg, job);
    const kept = await complete(pool, job, status, { ms: Date.now() - t0 });
    return { job, outcome: kept ? status : 'lease_lost', ms: Date.now() - t0 };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const recorded = await fail(pool, job, err).catch(() => false);
    const outcome = !recorded ? 'lease_lost' : job.attempts >= job.max_attempts ? 'failed' : 'retry';
    return { job, outcome, ms: Date.now() - t0, error: err.message };
  }
}

/**
 * Expire active intents whose expires_at passed. Per intent, ONE transaction re-checks the row under a lock
 * (a concurrent resume/edit wins), flips the status, enqueues the versioned re-match job and the owner's
 * notification; the re-match then runs right away (the job is the crash-safety net, and becomes a no-op).
 */
export async function sweepExpired(pool: pg.Pool, reg: Registry, max = SWEEP_MAX): Promise<number> {
  let expired = 0;
  while (expired < max) {
    const { rows } = await pool.query(
      "SELECT vertical_id, id FROM intents WHERE status = 'active' AND expires_at < now() ORDER BY expires_at, id LIMIT $1",
      [Math.min(500, max - expired)],
    );
    if (!rows.length) break;
    let progressed = 0;
    for (const r of rows) {
      const id = String(r.id);
      const res = await withTx(pool, async (tx) => {
        const cur = await tx.query("SELECT user_id, title_ar FROM intents WHERE vertical_id = $1 AND id = $2 AND status = 'active' AND expires_at < now() FOR UPDATE", [r.vertical_id, id]);
        if (!cur.rows[0]) return null;
        const s = await setIntentStatus(tx, reg, r.vertical_id, id, null, 'expire');
        if (!s.ok) return null;
        await enqueue(tx, 'match_intent', { verticalId: r.vertical_id, intentId: id, version: s.version, trigger: 'status' }, { dedupeKey: `match:${r.vertical_id}:${id}:${s.version}`, priority: 50 });
        await notify(tx, { recipientId: String(cur.rows[0].user_id), kind: 'intent_expired', titleAr: 'انتهت صلاحية طلب', bodyAr: `«${cur.rows[0].title_ar}» — يمكنك استئنافه من القائمة`, payload: { verticalId: r.vertical_id }, dedupeKey: `expired:${r.vertical_id}:${id}:${s.version}` });
        return s.version;
      });
      if (res === null) continue;
      progressed++;
      expired++;
      await matchIntent(pool, reg, { verticalId: r.vertical_id, intentId: id, version: res, trigger: 'status' });
    }
    if (!progressed) break;
  }
  return expired;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  if (process.env.UL_PIDFILE) { const { writeFileSync, rmSync } = await import('node:fs'); writeFileSync(process.env.UL_PIDFILE, String(process.pid)); process.on('exit', () => { try { rmSync(process.env.UL_PIDFILE!); } catch {} }); }
  const url = process.env.UL_DATABASE_URL ?? process.env.DATABASE_URL!;
  const pool = getPool(url);
  const reg = await loadRegistry(pool);
  const workerId = `${hostname()}:${process.pid}`;
  let stopping = false;
  let wake: (() => void) | null = null;
  const listener = new pg.Client({ connectionString: url });
  await listener.connect();
  await listener.query('LISTEN ul_jobs');
  listener.on('notification', () => wake?.());

  const beat = async () => {
    await pool.query("INSERT INTO worker_heartbeats (worker_id, beat_at, info) VALUES ($1, now(), $2) ON CONFLICT (worker_id) DO UPDATE SET beat_at = now(), info = EXCLUDED.info", [workerId, JSON.stringify({ pid: process.pid })]).catch(() => {});
    await pool.query("DELETE FROM worker_heartbeats WHERE beat_at < now() - interval '1 hour'").catch(() => {});
  };
  await beat();
  const hb = setInterval(() => void beat(), 10_000);
  const sweep = async () => { await enqueue(pool, 'expire_sweep', {}, { dedupeKey: 'expire_sweep', priority: 200 }).catch(() => {}); };
  await sweep();
  const sweepTimer = setInterval(() => void sweep(), 60_000);
  console.log(`[worker] ${workerId} started`);

  const shutdown = async () => { stopping = true; wake?.(); clearInterval(hb); clearInterval(sweepTimer); };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  while (!stopping) {
    try {
      const p = await processNext(pool, reg, workerId);
      if (!p) {
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 2000); });
        wake = null;
        continue;
      }
      if (p.outcome === 'lease_lost') console.warn(`[worker] job ${p.job.id}: outcome not recorded — lease lost (another worker owns it now) or database error${p.error ? `: ${p.error}` : ''}`);
      else if (p.error) console.error(`[worker] job ${p.job.id} ${p.job.kind} attempt ${p.job.attempts}/${p.job.max_attempts} → ${p.outcome}: ${p.error}`);
      else console.log(`[worker] job ${p.job.id} ${p.job.kind} → ${p.outcome} (${p.ms} ms)`);
      if (p.error) await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      // claim itself failed (database unavailable): back off and try again
      console.error(`[worker] claim failed: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await listener.end().catch(() => {});
  await closePools();
  console.log('[worker] stopped');
}
