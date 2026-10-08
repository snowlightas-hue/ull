// Distance-bounded candidate retrieval (the GEO directions of matchIntent and the /nearby endpoint).
//
// Used when the intent has a distance condition (hard radius, preferred radius or "nearest") AND an effective point
// (src/geo/semantics.ts). Then every counterpart that evaluatePair could accept lies within the bound, so retrieval is
// pinned to the neighbourhood instead of the place directions (whose "anywhere" scopes fan out over every GPS-located
// provider of the category). Four index-only directions, each bounded (truncation reported):
//
//   geo      — counterparts with a stored point: GiST KNN on ll_to_earth(geo_lat, geo_lng) inside earth_box(searchKm)
//   live     — counterparts sharing a live position: GiST KNN on live_positions (fresh rows only)
//   near     — counterparts WITHOUT a precise point whose place lies near enough (centroid − margin ≤ bound), or whose
//              place has no centroid (distance unknown ⇒ possible): equality on point_lft via intents_point_coarse_idx
//   pointless— counterparts without any place point (distance unknown, or a seeker's single scope centroid)
//
// Completeness (docs/GEO.md §3): a counterpart is excluded by my bound B unless d − (u_me + u_other) ≤ B, where d is
// the distance between effective points and u the uncertainties. Precise counterparts have u_other ≤ 6 km
// (COUNTERPART_GEO_UNC_MAX_KM), so KNN within B + u_me + 6 km (+ SQL slack) holds all of them; place-only ones are
// found through their place; unknown ones through 'near' (coordinate-less places) and 'pointless'.

import type { Queryable } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import type { MatchableIntent } from '../matching/evaluate.ts';
import type { IntentRow } from '../repo/intents.ts';
import { haversineKm } from './distance.ts';
import { boundOf, COUNTERPART_GEO_UNC_MAX_KM, defaultNearestKm, effectivePoint, placeCentroid, PRECISE_FIX_MAX_M, type DistanceBound, type EffectivePoint } from './semantics.ts';

/** Nearest-K cap per KNN direction (env UL_GEO_K). Hitting it sets `truncated` (the nearest K are always included). */
export const GEO_K = Number(process.env.UL_GEO_K ?? 200);
/** Cap for the place-based directions (same as the engine's CANDIDATE_LIMIT default). */
export const GEO_PLACE_LIMIT = Number(process.env.UL_CANDIDATE_LIMIT ?? 5000);
/** earthdistance's sphere (6378.168 km) is 0.11 % larger than the haversine mean radius → widen the SQL box a little. */
const SQL_SLACK = 1.003;
const SQL_SLACK_M = 50;

export interface GeoPlan { point: EffectivePoint; bound: DistanceBound; searchKm: number }

/** The plan for an intent with a distance condition and a known point; null → classic place retrieval. */
export function geoPlan(reg: Registry, me: MatchableIntent, now: Date, bound: DistanceBound | null = boundOf(reg, me)): GeoPlan | null {
  if (!bound) return null;
  const point = effectivePoint(reg, me, now);
  if (!point) return null;
  return { point, bound, searchKm: bound.km + point.uncKm + COUNTERPART_GEO_UNC_MAX_KM };
}

/** The bound used by /nearby when the intent states none: its "nearest" default. */
export function nearbyBound(reg: Registry, me: MatchableIntent): DistanceBound {
  return boundOf(reg, me) ?? { km: defaultNearestKm(reg, me.categoryCode), hard: false, preferredKm: null, isDefault: true };
}

/** Places whose centroid may be within the bound (margin-aware), and places without a usable centroid. */
export function placesWithin(reg: Registry, point: EffectivePoint, boundKm: number): { near: number[]; coordless: number[] } {
  const near: number[] = [];
  const coordless: number[] = [];
  for (const p of reg.places) {
    const c = placeCentroid(reg, p.id);
    if (!c) coordless.push(p.lft);
    else if (haversineKm(point, c) - c.uncKm - point.uncKm <= boundKm + 0.001) near.push(p.lft);
  }
  return { near, coordless };
}

export interface GeoRetrieval { ids: Set<string>; truncated: boolean; directions: string[]; outsideScope: number }

/** Matching keys of a retrieval: (vertical, realm, counter-side, deal, category set, not this user). */
export interface GeoKeys { verticalId: number; realm: string; side: string; dealTypeId: number; categoryIds: number[]; notUserId: string }

const boxMetres = (km: number) => km * 1000 * SQL_SLACK + SQL_SLACK_M;

/** Active intents with a stored point within `radiusKm` of `at`, nearest first (GiST KNN, index-only bounded). */
export async function knnIntents(db: Queryable, keys: GeoKeys, at: { lat: number; lng: number }, radiusKm: number, k: number): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT id FROM intents
      WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
        AND status = 'active' AND user_id <> $6 AND geo_lat IS NOT NULL
        AND earth_box(ll_to_earth($7, $8), $9) @> ll_to_earth(geo_lat, geo_lng)
      ORDER BY ll_to_earth(geo_lat, geo_lng) <-> ll_to_earth($7, $8)
      LIMIT $10`,
    [keys.verticalId, keys.realm, keys.side, keys.dealTypeId, keys.categoryIds, keys.notUserId, at.lat, at.lng, boxMetres(radiusKm), k],
  );
  return rows.map((r) => String(r.id));
}

/** Intents sharing a connected live position within `radiusKm` of `at`, nearest first (one minute of grace). */
export async function knnLive(db: Queryable, keys: GeoKeys, at: { lat: number; lng: number }, radiusKm: number, k: number): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT intent_id AS id FROM live_positions
      WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
        AND user_id <> $6 AND expires_at > now() - interval '1 minute'
        AND earth_box(ll_to_earth($7, $8), $9) @> ll_to_earth(lat, lng)
      ORDER BY ll_to_earth(lat, lng) <-> ll_to_earth($7, $8)
      LIMIT $10`,
    [keys.verticalId, keys.realm, keys.side, keys.dealTypeId, keys.categoryIds, keys.notUserId, at.lat, at.lng, boxMetres(radiusKm), k],
  );
  return rows.map((r) => String(r.id));
}

export async function retrieveNearby(tx: Queryable, reg: Registry, row: IntentRow, me: MatchableIntent, plan: GeoPlan, k = GEO_K): Promise<GeoRetrieval> {
  const ids = new Set<string>();
  let truncated = false;
  const add = (got: string[], limit: number) => { for (const id of got) ids.add(id); if (got.length >= limit) truncated = true; };
  const counterSide = me.side === 'join' ? 'join' : me.side === 'seek' ? 'provide' : 'seek';
  const cat = reg.categoryByCode.get(me.categoryCode)!;
  const catSet = [...new Set([...cat.ancestors, ...cat.descendants])];
  const keys: GeoKeys = { verticalId: row.vertical_id, realm: me.realm, side: counterSide, dealTypeId: row.deal_type_id, categoryIds: catSet, notUserId: me.userId };
  const common = [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, me.userId] as const; // $1..$6

  // geo: stored points, nearest first, inside the search box
  add(await knnIntents(tx, keys, plan.point, plan.searchKm, k), k);
  // live: connected positions (a minute of grace for clock skew; the evaluator decides freshness), nearest first
  if (counterSide !== 'seek') add(await knnLive(tx, keys, plan.point, plan.searchKm, k), k);

  // near: place-only counterparts at places that may be within reach (or whose distance cannot be known)
  const { near, coordless } = placesWithin(reg, plan.point, plan.bound.km);
  const lfts = [...near, ...coordless];
  if (lfts.length) {
    add(ids_((await tx.query(
      `SELECT id FROM intents
        WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
          AND status = 'active' AND user_id <> $6 AND (geo_lat IS NULL OR geo_accuracy_m > ${PRECISE_FIX_MAX_M})
          AND point_lft = ANY($7::int[])
        ORDER BY created_at DESC LIMIT $8`,
      [...common, lfts, GEO_PLACE_LIMIT],
    )).rows), GEO_PLACE_LIMIT);
  }

  // pointless: no place point at all (unknown distance, or a seeker's single scope place)
  add(ids_((await tx.query(
    `SELECT id FROM intents
      WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
        AND status = 'active' AND user_id <> $6 AND (geo_lat IS NULL OR geo_accuracy_m > ${PRECISE_FIX_MAX_M})
        AND point_lft IS NULL
      ORDER BY created_at DESC LIMIT $7`,
    [...common, GEO_PLACE_LIMIT],
  )).rows), GEO_PLACE_LIMIT);

  return { ids, truncated, directions: counterSide !== 'seek' ? ['geo', 'live', 'near', 'pointless'] : ['geo', 'near', 'pointless'], outsideScope: 0 };
}

const ids_ = (rows: { id: string }[]) => rows.map((r) => String(r.id));
