// Durable job queue on PostgreSQL: SKIP LOCKED claiming, leases (crash recovery), dedupe while pending,
// exponential backoff, and an explicit 'superseded' state for jobs made obsolete by a newer version.
//
// Lease fencing: a claim increments `attempts`; complete()/fail() only touch the job while it is still
// 'running' under that same attempt, so a worker whose lease expired (and whose job was reclaimed) can
// neither finish nor reschedule someone else's run. A job that keeps crashing its worker (lease expiry
// without complete/fail) still counts attempts and ends 'failed' at max_attempts.
import type { Queryable } from '../db/pool.ts';

export interface Job { id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }

export async function enqueue(db: Queryable, kind: string, payload: Record<string, unknown>, opts: { dedupeKey?: string; priority?: number; runAt?: Date; maxAttempts?: number } = {}): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO jobs (kind, payload, dedupe_key, priority, run_at, max_attempts) VALUES ($1,$2,$3,$4,coalesce($5, now()),$6)
     ON CONFLICT (dedupe_key) WHERE status IN ('pending','running') AND dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [kind, JSON.stringify(payload), opts.dedupeKey ?? null, opts.priority ?? 100, opts.runAt?.toISOString() ?? null, opts.maxAttempts ?? 5],
  );
  if (rows[0]) await db.query("SELECT pg_notify('ul_jobs', $1)", [kind]);
  return rows[0] ? String(rows[0].id) : null;
}

export async function claim(db: Queryable, workerId: string, leaseSeconds = 60, kinds?: string[]): Promise<Job | null> {
  // a lease that expired on the last allowed attempt: the worker died running it every time → give up
  await db.query(
    `UPDATE jobs SET status = 'failed', last_error = coalesce(last_error, 'lease expired') || ' (lease expired after ' || attempts || ' attempts)',
       finished_at = now(), locked_by = NULL, locked_until = NULL
     WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts`,
  );
  const { rows } = await db.query(
    `WITH next AS (
       SELECT id FROM jobs
        WHERE ((status = 'pending' AND run_at <= now()) OR (status = 'running' AND locked_until < now() AND attempts < max_attempts))
          AND ($3::text[] IS NULL OR kind = ANY($3))
        ORDER BY priority, run_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1)
     UPDATE jobs j SET status = 'running', locked_by = $1, locked_until = now() + make_interval(secs => $2), attempts = j.attempts + 1, started_at = now()
       FROM next WHERE j.id = next.id
     RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts`,
    [workerId, leaseSeconds, kinds ?? null],
  );
  return rows[0] ? { ...rows[0], id: String(rows[0].id) } : null;
}

/** Finish a claimed job. With a Job (not a bare id) the write is fenced to that claim. Returns false if the lease was lost. */
export async function complete(db: Queryable, job: Job | string, status: 'done' | 'superseded', result?: unknown): Promise<boolean> {
  const id = typeof job === 'string' ? job : job.id;
  const attempts = typeof job === 'string' ? null : job.attempts;
  const r = await db.query(
    `UPDATE jobs SET status = $2, result = $3, finished_at = now(), locked_by = NULL, locked_until = NULL
      WHERE id = $1 AND ($4::int IS NULL OR (status = 'running' AND attempts = $4))`,
    [id, status, result === undefined ? null : JSON.stringify(result), attempts],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Backoff after attempt n: min(300 s, 2^n s). */
export function backoffSeconds(attempts: number): number { return Math.min(300, 2 ** attempts); }

/** Record a failure: retry later with exponential backoff, or 'failed' at max_attempts. Fenced to the claim. */
export async function fail(db: Queryable, job: Job, err: Error): Promise<boolean> {
  const final = job.attempts >= job.max_attempts;
  const r = await db.query(
    `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + make_interval(secs => $4), locked_by = NULL, locked_until = NULL,
       finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
     WHERE id = $1 AND status = 'running' AND attempts = $5`,
    [job.id, final ? 'failed' : 'pending', err.message.slice(0, 500), backoffSeconds(job.attempts), job.attempts],
  );
  return (r.rowCount ?? 0) > 0;
}
