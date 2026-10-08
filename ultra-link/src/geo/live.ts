// Live positions (live_positions, migration 0003): one hot row per intent whose owner is sharing their position.
// A ping is ONE upsert: the intent's version is not bumped and no re-match runs (cost: a ping every 10–15 s per
// driver must stay O(1)). Throttled per intent in the database itself (≥ 10 s between accepted updates), so the limit
// holds across processes and tabs. Only the owner, only provide / join intents, only while the intent is active.

import type { Queryable } from '../db/pool.ts';
import { LIVE_FRESH_MS, LIVE_MIN_INTERVAL_MS, PRECISE_FIX_MAX_M } from './semantics.ts';

export interface LiveFix { lat: number; lng: number; accuracyM: number; heading?: number | null; speedKmh?: number | null }
export type LiveUpsert =
  | { ok: true; updatedAt: string; expiresAt: string; startedAt: string }
  | { ok: false; reason: 'not_found' | 'side_not_allowed' | 'inactive' | 'inaccurate' | 'too_soon'; retryAfterMs?: number };

export async function upsertLivePosition(
  db: Queryable, ref: { verticalId: number; id: string }, userId: string, fix: LiveFix,
  opts: { minIntervalMs?: number; ttlMs?: number } = {},
): Promise<LiveUpsert> {
  if (!(fix.accuracyM >= 0) || fix.accuracyM > PRECISE_FIX_MAX_M) return { ok: false, reason: 'inaccurate' };
  const minMs = opts.minIntervalMs ?? LIVE_MIN_INTERVAL_MS;
  const ttlMs = opts.ttlMs ?? LIVE_FRESH_MS;
  const { rows } = await db.query(
    `INSERT INTO live_positions AS lp (vertical_id, intent_id, user_id, realm, side, deal_type_id, category_id, lat, lng, accuracy_m, heading, speed_kmh, started_at, updated_at, expires_at)
     SELECT i.vertical_id, i.id, i.user_id, i.realm, i.side, i.deal_type_id, i.category_id, $4, $5, $6, $7, $8, now(), now(), now() + make_interval(secs => $9::double precision / 1000)
       FROM intents i
      WHERE i.vertical_id = $1 AND i.id = $2 AND i.user_id = $3 AND i.status = 'active' AND i.side IN ('provide', 'join')
     ON CONFLICT (vertical_id, intent_id) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy_m = EXCLUDED.accuracy_m, heading = EXCLUDED.heading, speed_kmh = EXCLUDED.speed_kmh,
       realm = EXCLUDED.realm, side = EXCLUDED.side, deal_type_id = EXCLUDED.deal_type_id, category_id = EXCLUDED.category_id,
       started_at = CASE WHEN lp.expires_at < now() THEN now() ELSE lp.started_at END,
       updated_at = now(), expires_at = EXCLUDED.expires_at
      WHERE lp.updated_at <= now() - make_interval(secs => $10::double precision / 1000)
     RETURNING updated_at, expires_at, started_at`,
    [ref.verticalId, ref.id, userId, fix.lat, fix.lng, Math.round(fix.accuracyM), fix.heading == null ? null : Math.round(fix.heading) % 360,
      fix.speedKmh == null ? null : Math.min(400, Math.round(fix.speedKmh)), ttlMs, minMs],
  );
  if (rows[0]) return { ok: true, updatedAt: iso(rows[0].updated_at), expiresAt: iso(rows[0].expires_at), startedAt: iso(rows[0].started_at) };
  // why not: tell apart "not yours", "not shareable", "not active" and "too soon"
  const i = (await db.query('SELECT side, status FROM intents WHERE vertical_id = $1 AND id = $2 AND user_id = $3', [ref.verticalId, ref.id, userId])).rows[0];
  if (!i) return { ok: false, reason: 'not_found' };
  if (i.side !== 'provide' && i.side !== 'join') return { ok: false, reason: 'side_not_allowed' };
  if (i.status !== 'active') return { ok: false, reason: 'inactive' };
  const last = (await db.query(
    `SELECT GREATEST(0, EXTRACT(EPOCH FROM (updated_at + make_interval(secs => $3::double precision / 1000) - now())) * 1000)::bigint AS wait
       FROM live_positions WHERE vertical_id = $1 AND intent_id = $2`, [ref.verticalId, ref.id, minMs])).rows[0];
  return { ok: false, reason: 'too_soon', retryAfterMs: Math.max(1, Number(last?.wait ?? minMs)) };
}

/** Stop sharing (owner only). Returns whether a row was removed. */
export async function stopLive(db: Queryable, ref: { verticalId: number; id: string }, userId: string): Promise<boolean> {
  const r = await db.query('DELETE FROM live_positions WHERE vertical_id = $1 AND intent_id = $2 AND user_id = $3', [ref.verticalId, ref.id, userId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Housekeeping: drop positions nobody has refreshed for a long time (default 24 h). Stale rows are harmless for
 * matching (the evaluator treats them as "غير متصل" and falls back to the static point), but they should not linger.
 * Suggested caller: the worker's minute tick / expire_sweep (not wired here — see docs/GEO.md).
 */
export async function purgeStaleLive(db: Queryable, olderThanMs = 24 * 3600_000, limit = 5000): Promise<number> {
  const r = await db.query(
    `DELETE FROM live_positions WHERE ctid = ANY(ARRAY(SELECT ctid FROM live_positions WHERE expires_at < now() - make_interval(secs => $1::double precision / 1000) LIMIT $2))`,
    [olderThanMs, limit],
  );
  return r.rowCount ?? 0;
}

function iso(v: string | Date): string { return new Date(v).toISOString(); }
