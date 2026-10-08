// Background worker: match jobs (versioned; stale jobs are superseded), expiry sweep, heartbeat.
import { hostname } from 'node:os';
import pg from 'pg';
import { loadEnv } from '../lib/env.ts';
import { closePools, getPool, withTx } from '../db/pool.ts';
import { loadRegistry } from '../seed/reference.ts';
import { claim, complete, enqueue, fail, type Job } from '../repo/jobs.ts';
import { setIntentStatus } from '../repo/intents.ts';
import { notify } from '../repo/notifications.ts';
import { latestRun, matchIntent } from '../matching/engine.ts';
import type { Registry } from '../domain/registry.ts';

export async function runJob(pool: pg.Pool, reg: Registry, job: Job): Promise<'done' | 'superseded'> {
  if (job.kind === 'match_intent') {
    const p = job.payload as { verticalId: number; intentId: string; version: number; trigger?: string };
    const cur = await pool.query('SELECT version, status FROM intents WHERE vertical_id = $1 AND id = $2', [p.verticalId, p.intentId]);
    if (!cur.rows[0] || cur.rows[0].version !== p.version) return 'superseded'; // a newer version has its own job
    // the interactive path may already have evaluated this exact version → nothing to do
    if (p.trigger === 'job' && (await latestRun(pool, p.verticalId, p.intentId, p.version))) return 'done';
    const r = await matchIntent(pool, reg, { verticalId: p.verticalId, intentId: p.intentId, version: p.version, trigger: (p.trigger as any) ?? 'job' });
    return r.status === 'superseded' ? 'superseded' : 'done';
  }
  if (job.kind === 'expire_sweep') {
    const { rows } = await pool.query(
      "SELECT vertical_id, id, user_id, title_ar FROM intents WHERE status = 'active' AND expires_at < now() ORDER BY expires_at LIMIT 500",
    );
    for (const r of rows) {
      const res = await withTx(pool, (tx) => setIntentStatus(tx, reg, r.vertical_id, String(r.id), null, 'expire'));
      if (!res.ok) continue;
      await matchIntent(pool, reg, { verticalId: r.vertical_id, intentId: String(r.id), version: res.version, trigger: 'status' });
      await notify(pool, { recipientId: String(r.user_id), kind: 'intent_expired', titleAr: 'انتهت صلاحية طلب', bodyAr: `«${r.title_ar}» — يمكنك استئنافه من القائمة`, payload: { verticalId: r.vertical_id }, dedupeKey: `expired:${r.vertical_id}:${r.id}:${res.version}` });
    }
    return 'done';
  }
  throw new Error(`unknown job kind ${job.kind}`);
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
    let job: Job | null = null;
    try {
      job = await claim(pool, workerId, 60);
      if (!job) {
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 2000); });
        wake = null;
        continue;
      }
      const t0 = Date.now();
      const status = await runJob(pool, reg, job);
      await complete(pool, job.id, status, { ms: Date.now() - t0 });
      console.log(`[worker] job ${job.id} ${job.kind} → ${status} (${Date.now() - t0} ms)`);
    } catch (e) {
      console.error(`[worker] job ${job?.id ?? '-'} failed: ${(e as Error).message}`);
      if (job) await fail(pool, job, e as Error).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await listener.end().catch(() => {});
  await closePools();
  console.log('[worker] stopped');
}
