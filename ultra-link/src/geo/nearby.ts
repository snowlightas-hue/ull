// "Who is nearest to my intent right now?" — on demand, with fresh live positions (stored matches keep the distance
// of the moment they were computed; pings never trigger re-matching). Owner-only (the route checks it).
// PRIVACY: items carry a rounded distance, a connection label and the counterpart's card — never coordinates.

import type { Queryable } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import type { MatchReason } from '../domain/types.ts';
import { evaluatePair, type MatchableIntent } from '../matching/evaluate.ts';
import { INTENT_COLS, loadIntent, rowToMatchable, toCard, type IntentCard, type IntentRow } from '../repo/intents.ts';
import { haversineKm, roundDistance } from './distance.ts';
import { geoPlan, nearbyBound, retrieveNearby } from './retrieve.ts';
import { boundAr, effectivePoint, liveState } from './semantics.ts';

export interface NearbyItem {
  intent: IntentCard;
  distance: { ar: string; km: number | null; lt1: boolean; approximate: boolean } | null;
  live: { fresh: boolean; labelAr: string } | null;
  /** 'متصل الآن' | 'آخر تحديث قبل 3 د' | 'غير متصل منذ 25 د' | 'موقع ثابت' | 'موقع تقريبي' | 'الموقع غير معروف' */
  freshnessAr: string;
  verdict: 'confirmed' | 'possible';
  score: number;
  reasons: MatchReason[];
  /** the stored match for this pair (to request contact), when one exists and is still valid */
  matchId: string | null;
}

export type NearbyResult =
  | { ok: true; items: NearbyItem[]; limitAr: string; from: 'live' | 'gps' | 'place'; truncated: boolean }
  | { ok: false; reason: 'not_found' | 'inactive' | 'no_location' };

export async function nearbyFor(db: Queryable, reg: Registry, ref: { verticalId: number; id: string }, opts: { limit: number; now?: Date }): Promise<NearbyResult> {
  const now = opts.now ?? new Date();
  const row = await loadIntent(db, ref.verticalId, ref.id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'active') return { ok: false, reason: 'inactive' };
  const stated = rowToMatchable(reg, row);
  // without a stated distance condition, "nearby" means: as if the owner had asked for the nearest (declared default)
  const me: MatchableIntent = stated.radiusKm || stated.nearest ? stated : { ...stated, nearest: true };
  const plan = geoPlan(reg, me, now, nearbyBound(reg, me));
  if (!plan) return { ok: false, reason: 'no_location' };
  const got = await retrieveNearby(db, reg, row, me, plan, Math.max(50, opts.limit * 5));
  const rows = got.ids.size
    ? (await db.query(`SELECT ${INTENT_COLS} FROM intents i WHERE i.vertical_id = $1 AND i.id = ANY($2::bigint[])`, [ref.verticalId, [...got.ids]])).rows as IntentRow[]
    : [];
  const scored: { row: IntentRow; other: MatchableIntent; km: number | null; v: ReturnType<typeof evaluatePair> }[] = [];
  for (const r of rows) {
    const other = rowToMatchable(reg, r);
    const v = evaluatePair(reg, me, other, { now });
    if (v.verdict === 'excluded') continue;
    const to = effectivePoint(reg, other, now);
    scored.push({ row: r, other, km: to ? haversineKm(plan.point, to) : null, v });
  }
  scored.sort((x, y) => (x.km ?? Infinity) - (y.km ?? Infinity) || y.v.score - x.v.score || (x.other.id < y.other.id ? -1 : 1));
  const page = scored.slice(0, opts.limit);
  const matchIds = await storedMatches(db, ref.verticalId, ref.id, page.map((p) => p.other.id));
  const items: NearbyItem[] = page.map(({ row: r, other, km, v }) => {
    const to = effectivePoint(reg, other, now);
    const ls = liveState(other, now);
    const approximate = !!to && (to.uncKm > 0 || plan.point.uncKm > 0);
    const freshnessAr = to?.kind === 'live' ? ls!.labelAr : ls && !ls.fresh ? ls.labelAr : to?.kind === 'gps' ? 'موقع ثابت' : to?.kind === 'place' ? 'موقع تقريبي' : 'الموقع غير معروف';
    const rd = km === null ? null : roundDistance(km);
    return {
      intent: toCard(reg, r, undefined, false),
      distance: rd ? { ar: rd.ar, km: rd.km, lt1: rd.lt1, approximate } : null,
      live: ls ? { fresh: ls.fresh, labelAr: ls.labelAr } : null,
      freshnessAr,
      verdict: v.verdict === 'match' ? 'confirmed' : 'possible',
      score: v.score,
      reasons: v.reasons,
      matchId: matchIds.get(other.id) ?? null,
    };
  });
  return { ok: true, items, limitAr: boundAr(reg, me) ?? '', from: plan.point.kind, truncated: got.truncated };
}

async function storedMatches(db: Queryable, verticalId: number, myId: string, others: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!others.length) return out;
  const { rows } = await db.query(
    `SELECT public_id, a_intent_id, b_intent_id FROM matches
      WHERE vertical_id = $1 AND state <> 'invalidated'
        AND ((a_intent_id = $2 AND b_intent_id = ANY($3::bigint[])) OR (b_intent_id = $2 AND a_intent_id = ANY($3::bigint[])))`,
    [verticalId, myId, others],
  );
  for (const r of rows) out.set(String(r.a_intent_id) === myId ? String(r.b_intent_id) : String(r.a_intent_id), r.public_id);
  return out;
}
