// Job scheduling for connections (kept separate from jobs.ts so the repository can enqueue without a cycle).
//   conn_sweep         — auto-archive + expired-share safety net. Self-rescheduling chain: one job per time slot
//                        (dedupe key conn_sweep:<slot>), started when a connection opens, continued by each run while
//                        archivable connections or live shares exist. Chains started twice merge on the slot key.
//   conn_location_end  — at a share's expiry: erase its coordinates and tell the counterpart the share ended.
import type { Queryable } from '../db/pool.ts';
import { enqueue } from '../repo/jobs.ts';

export const CONN_SWEEP_KIND = 'conn_sweep';
export const CONN_LOCATION_END_KIND = 'conn_location_end';

/** Sweep period (env UL_CONN_SWEEP_MS, default 1 h; archive thresholds are days, so hourly is plenty). */
export function sweepIntervalMs(): number {
  const n = Number(process.env.UL_CONN_SWEEP_MS ?? 3_600_000);
  return Number.isFinite(n) && n >= 1000 ? n : 3_600_000;
}

/** Enqueue the sweep of the NEXT slot (no-op when it is already pending). */
export async function scheduleConnectionsSweep(db: Queryable, now = Date.now()): Promise<void> {
  const every = sweepIntervalMs();
  const slot = Math.floor(now / every) + 1;
  await enqueue(db, CONN_SWEEP_KIND, {}, { dedupeKey: `${CONN_SWEEP_KIND}:${slot}`, runAt: new Date(slot * every), priority: 200 });
}

export async function scheduleLocationEnd(db: Queryable, shareId: string, at: Date): Promise<void> {
  await enqueue(db, CONN_LOCATION_END_KIND, { shareId }, { dedupeKey: `${CONN_LOCATION_END_KIND}:${shareId}`, runAt: at, priority: 60 });
}
