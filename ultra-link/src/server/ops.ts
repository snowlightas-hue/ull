// Operations: health report, local-only metrics, lazy session cleanup, privacy-safe error logging.
import type pg from 'pg';
import type { FastifyRequest } from 'fastify';
import { getJevStatus } from '../ai/index.ts';

/** Process-local counters (since start). DB-derived totals are computed on demand in metrics(). */
export function newCounters() {
  return {
    startedAt: Date.now(),
    http: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } as Record<string, number>,
    turns: { ok: 0, failed: 0, saved: 0, asked: 0, unclear: 0, byEngine: { rules: 0, jev: 0, 'jev-sim': 0 } as Record<string, number>, latencyMsTotal: 0 },
    rateLimited: { turns: 0, auth: 0, simulate: 0 } as Record<string, number>,
    sessionsCleaned: 0,
    sessionCleanupRuns: 0,
  };
}
export type Counters = ReturnType<typeof newCounters>;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

export interface HealthInput { pool: pg.Pool; version: string; registry: string; startedAt: number; draining: boolean; events: { connected: boolean; reconnects: number } | null }

/** GET /api/health — 200 when the database answers, 503 when it does not or the server is draining. */
export async function health(h: HealthInput): Promise<{ code: number; body: Record<string, unknown> }> {
  const t0 = performance.now();
  const db = await withTimeout(h.pool.query('SELECT 1'), 2000).then(() => true, () => false);
  const dbLatencyMs = Math.round((performance.now() - t0) * 10) / 10;
  let worker: { lastBeatAt: string | null; ageMs: number | null; alive: boolean } = { lastBeatAt: null, ageMs: null, alive: false };
  let queue: { pending: number; due: number; running: number; failed: number; oldestDueAgeMs: number | null } | null = null;
  if (db) {
    try {
      const [hb, q] = await withTimeout(Promise.all([
        h.pool.query('SELECT max(beat_at) AS beat, (extract(epoch FROM now() - max(beat_at)) * 1000)::bigint AS age FROM worker_heartbeats'),
        h.pool.query(`SELECT
            count(*) FILTER (WHERE status = 'pending')::int AS pending,
            count(*) FILTER (WHERE status = 'pending' AND run_at <= now())::int AS due,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            (extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'pending' AND run_at <= now())) * 1000)::bigint AS oldest_due_ms,
            (SELECT count(*) FROM jobs WHERE status = 'failed')::int AS failed
          FROM jobs WHERE status IN ('pending', 'running')`),
      ]), 2000);
      const beat = hb.rows[0]?.beat ?? null;
      const age = hb.rows[0]?.age == null ? null : Number(hb.rows[0].age);
      worker = { lastBeatAt: beat ? new Date(beat).toISOString() : null, ageMs: age, alive: age !== null && age < 30_000 };
      const r = q.rows[0];
      queue = { pending: r.pending, due: r.due, running: r.running, failed: r.failed, oldestDueAgeMs: r.oldest_due_ms == null ? null : Number(r.oldest_due_ms) };
    } catch { /* partial report below */ }
  }
  const jev = getJevStatus();
  const ok = db && !h.draining;
  const degraded: string[] = [];
  if (db && !worker.alive) degraded.push('worker');
  if (h.events && !h.events.connected) degraded.push('events');
  if (queue && queue.oldestDueAgeMs !== null && queue.oldestDueAgeMs > 120_000) degraded.push('queue_lag');
  return {
    code: ok ? 200 : 503,
    body: {
      ok, status: !db ? 'down' : h.draining ? 'draining' : degraded.length ? 'degraded' : 'ok', degraded,
      db, dbLatencyMs, worker, queue,
      jev: { mode: jev.mode, verified: jev.verified, labelAr: jev.labelAr, lastSuccessAt: jev.lastSuccessAt, lastError: jev.lastError },
      events: h.events, version: h.version, registry: h.registry, uptimeS: Math.round((Date.now() - h.startedAt) / 1000),
    },
  };
}

/** Metrics are served only to the machine itself (no proxy hop, loopback socket). */
export function isLocalRequest(req: FastifyRequest): boolean {
  const ip = req.socket?.remoteAddress ?? req.ip;
  const loop = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loop && req.headers['x-forwarded-for'] === undefined && req.headers.forwarded === undefined && req.headers['x-real-ip'] === undefined;
}

/** GET /api/metrics — DB totals (bounded by a statement timeout) + process counters. */
export async function metrics(pool: pg.Pool, c: Counters, extra: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  let db: Record<string, unknown> = {};
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '3s'");
    const [t, runs, jobs, sess] = [
      (await client.query(`SELECT
          (SELECT count(*) FROM conversation_messages WHERE role = 'user')::bigint AS turns,
          (SELECT count(*) FROM conversation_messages WHERE role = 'user' AND created_at > now() - interval '24 hours')::bigint AS turns_24h,
          (SELECT count(*) FROM conversations WHERE state = 'saved')::bigint AS saves,
          (SELECT count(*) FROM conversations WHERE state = 'saved' AND updated_at > now() - interval '24 hours')::bigint AS saves_24h,
          (SELECT count(*) FROM notifications)::bigint AS notifications,
          (SELECT count(*) FROM notifications WHERE created_at > now() - interval '24 hours')::bigint AS notifications_24h,
          (SELECT count(*) FROM notifications WHERE read_at IS NULL)::bigint AS notifications_unread,
          (SELECT count(*) FROM extraction_runs WHERE engine <> 'rules')::bigint AS jev_turns`)).rows[0],
      // percentiles over the most recent 10k runs (index scan on the PK, bounded cost)
      (await client.query(`WITH recent AS (SELECT duration_ms, created_at FROM match_runs ORDER BY id DESC LIMIT 10000)
          SELECT (SELECT count(*) FROM match_runs)::bigint AS total,
                 count(*) FILTER (WHERE created_at > now() - interval '24 hours')::bigint AS last_24h,
                 count(duration_ms)::int AS sample,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
                 max(duration_ms) AS max
            FROM recent`)).rows[0],
      (await client.query('SELECT status, count(*)::bigint AS n FROM jobs GROUP BY status')).rows,
      (await client.query('SELECT count(*) FILTER (WHERE expires_at > now())::bigint AS active, count(*) FILTER (WHERE expires_at <= now())::bigint AS expired FROM sessions')).rows[0],
    ];
    await client.query('COMMIT');
    const n = (v: unknown) => (v == null ? null : Number(v));
    const byStatus: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0, superseded: 0 };
    for (const r of jobs) byStatus[r.status] = Number(r.n);
    db = {
      turns: { total: n(t.turns), last24h: n(t.turns_24h), withJev: n(t.jev_turns) },
      saves: { total: n(t.saves), last24h: n(t.saves_24h) },
      matchRuns: { total: n(runs.total), last24h: n(runs.last_24h), durationMs: { sample: runs.sample, p50: n(runs.p50), p95: n(runs.p95), max: n(runs.max) } },
      jobs: byStatus,
      notifications: { sent: n(t.notifications), last24h: n(t.notifications_24h), unread: n(t.notifications_unread) },
      sessions: { active: n(sess.active), expired: n(sess.expired) },
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    db = { error: (e as { code?: string }).code === '57014' ? 'statement_timeout' : 'unavailable' };
  } finally {
    client.release();
  }
  const mem = process.memoryUsage();
  return {
    at: new Date().toISOString(),
    db,
    process: {
      uptimeS: Math.round((Date.now() - c.startedAt) / 1000), pid: process.pid, rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576),
      http: c.http, turns: c.turns, rateLimited: c.rateLimited, sessionsCleaned: c.sessionsCleaned, sessionCleanupRuns: c.sessionCleanupRuns,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      ...extra,
    },
  };
}

/**
 * Lazy expired-session cleanup: piggybacks on requests, runs at most once per interval, deletes in small
 * batches (index on expires_at), never blocks the request that triggered it.
 */
export class SessionJanitor {
  private last = 0;
  private running: Promise<number> | null = null;
  private readonly pool: pg.Pool;
  private readonly intervalMs: number;
  private readonly counters: Counters;
  private readonly onError: (e: unknown) => void;

  constructor(pool: pg.Pool, counters: Counters, onError: (e: unknown) => void, intervalMs = Number(process.env.UL_SESSION_CLEANUP_MS ?? 10 * 60_000)) {
    this.pool = pool; this.counters = counters; this.onError = onError; this.intervalMs = intervalMs;
  }

  /** Fire-and-forget; returns the running promise (tests await it). */
  maybeRun(now = Date.now()): Promise<number> | null {
    if (this.running || now - this.last < this.intervalMs) return this.running;
    this.last = now;
    return this.run();
  }

  run(): Promise<number> {
    if (this.running) return this.running;
    this.running = (async () => {
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const r = await this.pool.query('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at < now() ORDER BY expires_at LIMIT 1000)');
        total += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) < 1000) break;
      }
      this.counters.sessionsCleaned += total;
      this.counters.sessionCleanupRuns++;
      return total;
    })().catch((e) => { this.onError(e); return 0; }).finally(() => { this.running = null; });
    return this.running;
  }
}

/**
 * Error details that are safe to log: no request bodies, no quoted values (PostgreSQL echoes input in
 * messages), no Arabic text (user utterances), bounded length.
 */
export function safeErr(e: unknown): { type: string; code?: string; message: string; stack?: string } {
  const err = (e ?? {}) as { name?: string; code?: string; message?: string; stack?: string };
  const clean = (s: string) => s
    .replace(/"[^"]*"/g, '"‹…›"')
    .replace(/'[^']*'/g, "'‹…›'")
    .replace(/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+(?:[\s؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+)*/g, '‹ar›')
    .slice(0, 300);
  const message = clean(String(err.message ?? e));
  const frames = typeof err.stack === 'string' ? err.stack.split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 8).map((l) => clean(l.trim())).join(' | ') : undefined;
  return { type: String(err.name ?? 'Error'), ...(err.code ? { code: String(err.code) } : {}), message, ...(frames ? { stack: frames } : {}) };
}
