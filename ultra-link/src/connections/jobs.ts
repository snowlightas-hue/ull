// Worker jobs of the connections feature. Registered in src/worker/main.ts with one line:
//   if (job.kind.startsWith('conn_')) return runConnectionJob(pool, job);
// Every job is idempotent: archiving re-checks its conditions under the row lock, a share is ended once
// (ended_at IS NULL guard) and its notification has a per-share dedupe key.
import type pg from 'pg';
import type { Job } from '../repo/jobs.ts';
import { emitUserEvent } from '../repo/notifications.ts';
import { endExpiredShares } from './repo.ts';
import { CONN_LOCATION_END_KIND, CONN_SWEEP_KIND, scheduleConnectionsSweep } from './schedule.ts';

export { CONN_LOCATION_END_KIND, CONN_SWEEP_KIND } from './schedule.ts';

export interface SweepOptions {
  /** archive this many days after BOTH intents are closed / fulfilled / expired (default 14) */
  intentsDoneDays?: number;
  /** archive after this many days without a message (default 30; counted from creation when there is none) */
  idleDays?: number;
  /** at most this many connections archived per run (the next run continues) */
  max?: number;
  batch?: number;
}

export async function runConnectionJob(pool: pg.Pool, job: Job): Promise<'done' | 'superseded'> {
  if (job.kind === CONN_SWEEP_KIND) {
    await sweepConnections(pool);
    const more = (await pool.query(
      `SELECT EXISTS (SELECT 1 FROM connections WHERE status IN ('open','closed'))
           OR EXISTS (SELECT 1 FROM connection_location_shares WHERE ended_at IS NULL) AS more`)).rows[0].more;
    if (more) await scheduleConnectionsSweep(pool);
    return 'done';
  }
  if (job.kind === CONN_LOCATION_END_KIND) {
    const shareId = String((job.payload as { shareId?: unknown }).shareId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(shareId)) return 'superseded';
    await endExpiredShares(pool, shareId);
    return 'done';
  }
  throw new Error(`unknown job kind ${job.kind}`);
}

/**
 * Auto-archive (FEATURES-V2 §4): an open or closed connection is archived 14 days after both of its intents ended
 * (closed / fulfilled / expired — the later closed_at counts), or after 30 days without messages. Blocked
 * connections stay blocked. Walks the archivable connections in id order (partial index connections_sweep_idx),
 * re-checking the conditions inside the UPDATE (so a message or an intent resumed meanwhile wins). Also ends
 * location shares whose time ran out (the per-share job is the primary path).
 */
export async function sweepConnections(pool: pg.Pool, opts: SweepOptions = {}): Promise<{ archived: number; sharesEnded: number }> {
  const doneDays = opts.intentsDoneDays ?? 14;
  const idleDays = opts.idleDays ?? 30;
  const max = opts.max ?? 5000;
  const batch = opts.batch ?? 500;
  let archived = 0;
  let after = '0';
  while (archived < max) {
    const ids = (await pool.query(
      "SELECT id FROM connections WHERE status IN ('open','closed') AND id > $1 ORDER BY id LIMIT $2", [after, batch])).rows.map((r) => String(r.id));
    if (!ids.length) break;
    after = ids[ids.length - 1]!;
    const done = `(ia.status IN ('closed','fulfilled','expired') AND ib.status IN ('closed','fulfilled','expired')
                   AND greatest(ia.closed_at, ib.closed_at) <= now() - make_interval(days => $2))`;
    const { rows } = await pool.query(
      `UPDATE connections c SET status = 'archived', archived_at = now(), closed_at = coalesce(c.closed_at, now()), updated_at = now(),
              status_reason = CASE WHEN ${done} THEN 'intents_done' ELSE 'idle' END,
              a_phone_shared = false, b_phone_shared = false
         FROM intents ia, intents ib
        WHERE c.id = ANY($1::bigint[]) AND c.status IN ('open','closed')
          AND ia.vertical_id = c.vertical_id AND ia.id = c.a_intent_id AND ib.vertical_id = c.vertical_id AND ib.id = c.b_intent_id
          AND (${done} OR c.activity_at <= now() - make_interval(days => $3))
        RETURNING c.id, c.a_user_id, c.b_user_id`,
      [ids.slice(0, Math.max(0, max - archived)), doneDays, idleDays]);
    if (rows.length) {
      await pool.query(
        `UPDATE connection_location_shares SET ended_at = least(now(), expires_at), end_reason = 'connection_ended',
           lat = NULL, lng = NULL, accuracy_m = NULL, position_at = NULL
          WHERE connection_id = ANY($1::bigint[]) AND ended_at IS NULL`, [rows.map((r) => String(r.id))]);
      for (const u of new Set(rows.flatMap((r) => [String(r.a_user_id), String(r.b_user_id)]))) await emitUserEvent(pool, u, 'conn_update');
    }
    archived += rows.length;
  }
  const sharesEnded = await endExpiredShares(pool);
  return { archived, sharesEnded };
}
