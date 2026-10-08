// Proximity semantics (pure): which point stands for an intent, which distance condition applies, and how a pair is
// judged on distance. evaluatePair (src/matching/evaluate.ts) calls proximityCheck(); retrieval (src/geo/retrieve.ts)
// uses the SAME effectivePoint()/boundOf() so that what SQL pre-selects is exactly what the evaluator can accept.
// Rules and their rationale: docs/GEO.md.
//
//   effective point = fresh live position (≤ 10 min) > static GPS fix > place centroid (approximate ± margin)
//   hard radius ("ضمن 5 كم")       → beyond (even at the most favourable end of the uncertainty) ⇒ excluded;
//                                     inside for sure ⇒ satisfied; in between (approximate points) ⇒ possible
//   "الأقرب" / preferred radius   → ranking by distance, inside a declared default limit (10 km transport, 50 km
//                                     otherwise, or the preferred radius when larger) — never widened automatically
//   no coordinates on a side       → distance unknown ⇒ possible, never confirmed
//   live position older than 10 min → "غير متصل منذ…" ⇒ possible, never confirmed

import type { Registry } from '../domain/registry.ts';
import type { MatchReason, Strength } from '../domain/types.ts';
import type { MatchableIntent } from '../matching/evaluate.ts';
import { agoAr, fmtKm, haversineKm, roundDistance, validLatLng } from './distance.ts';

/** A live position stops counting as "connected" this long after its last update (and expires_at = updated_at + this). */
export const LIVE_FRESH_MS = 10 * 60_000;
/** Server-side floor between two accepted live updates of one intent. */
export const LIVE_MIN_INTERVAL_MS = 10_000;
/** A GPS fix coarser than this (cell/IP based) is not trusted as a precise point: the place centroid is used instead. */
export const PRECISE_FIX_MAX_M = 3000;
/** Fixes at least this good are treated as exact (no uncertainty band, so "exactly at the radius" is inside). */
export const EXACT_FIX_M = 250;
/** How far a person can be from the centroid of the place they named (kind → km). Other kinds have no usable centroid. */
export const PLACE_MARGIN_KM: Record<string, number> = { city: 6, region: 30 };
/** A GeoPoint whose source is 'place' (a centroid sent as coordinates) is as approximate as a city. */
export const PLACE_GEO_UNC_KM = 6;
/** Largest uncertainty a counterpart point stored WITH coordinates can carry (retrieval slack, see retrieve.ts). */
export const COUNTERPART_GEO_UNC_MAX_KM = Math.max(PRECISE_FIX_MAX_M / 1000, PLACE_GEO_UNC_KM);
/** Default limit for "الأقرب / قريب مني" without a stated radius. */
export const DEFAULT_NEAREST_KM = { transport: 10, other: 50 } as const;
/** Ride requests notify at most this many nearest connected (live) drivers. */
export const RIDE_NOTIFY_K = 10;
/** Floating-point slack for "exactly at the radius" comparisons (1 metre). */
const EPS_KM = 0.001;

export type PointKind = 'live' | 'gps' | 'place';
export interface EffectivePoint {
  lat: number;
  lng: number;
  kind: PointKind;
  /** ± km: 0 for a good fix, the fix accuracy for a mediocre one, the place margin for a centroid */
  uncKm: number;
  /** the named place when kind = 'place' (for "حسب مركز إعزاز") */
  placeId?: number;
}

export interface LiveState { fresh: boolean; ageMs: number; labelAr: string }

/** Connection state of an intent's live position (null when it is not sharing). */
export function liveState(m: Pick<MatchableIntent, 'live'>, now: Date): LiveState | null {
  const l = m.live;
  if (!l) return null;
  const at = Date.parse(l.at);
  const ageMs = Number.isFinite(at) ? Math.max(0, now.getTime() - at) : Number.POSITIVE_INFINITY;
  const fresh = ageMs <= LIVE_FRESH_MS;
  const labelAr = !Number.isFinite(ageMs) ? 'غير متصل'
    : fresh ? (ageMs < 60_000 ? 'متصل الآن' : `آخر تحديث قبل ${agoAr(ageMs)}`)
    : `غير متصل منذ ${agoAr(ageMs)}`;
  return { fresh, ageMs, labelAr };
}

function fixUncKm(accuracyM: number | null | undefined): number {
  const a = accuracyM ?? 0;
  return a > EXACT_FIX_M ? a / 1000 : 0;
}

/** The single scope place of a point-less intent ("بدي سيارة بإعزاز ضمن 20 كم"), else the point place. */
function referencePlace(reg: Registry, m: Pick<MatchableIntent, 'pointPlaceId' | 'scopePlaceIds'>): number | null {
  if (m.pointPlaceId != null) return m.pointPlaceId;
  const s = m.scopePlaceIds.filter((p) => p !== reg.rootPlaceId);
  return s.length === 1 ? s[0]! : null;
}

/** Centroid of a place with its margin, when the place has usable coordinates. */
export function placeCentroid(reg: Registry, placeId: number | null): EffectivePoint | null {
  if (placeId == null) return null;
  const p = reg.placeById.get(placeId);
  const margin = p ? PLACE_MARGIN_KM[p.kind] : undefined;
  if (!p || margin === undefined || p.lat == null || p.lng == null) return null;
  return { lat: p.lat, lng: p.lng, kind: 'place', uncKm: margin, placeId };
}

/** Where an intent is, for distance purposes (see header). null = unknown. */
export function effectivePoint(reg: Registry, m: MatchableIntent, now: Date): EffectivePoint | null {
  const live = m.live;
  if (live && validLatLng(live) && (live.accuracyM ?? 0) <= PRECISE_FIX_MAX_M && liveState(m, now)?.fresh) {
    return { lat: live.lat, lng: live.lng, kind: 'live', uncKm: fixUncKm(live.accuracyM) };
  }
  const g = m.geo;
  if (g && validLatLng(g)) {
    if (g.source === 'place') return { lat: g.lat, lng: g.lng, kind: 'place', uncKm: PLACE_GEO_UNC_KM, placeId: m.pointPlaceId ?? undefined };
    if ((g.accuracyM ?? 0) <= PRECISE_FIX_MAX_M) return { lat: g.lat, lng: g.lng, kind: 'gps', uncKm: fixUncKm(g.accuracyM) };
  }
  const c = placeCentroid(reg, referencePlace(reg, m));
  if (c) return c;
  // a coarse fix is still better than nothing when the place has no centroid
  if (g && validLatLng(g)) return { lat: g.lat, lng: g.lng, kind: 'gps', uncKm: (g.accuracyM ?? 0) / 1000 };
  return null;
}

export function defaultNearestKm(reg: Registry, categoryCode: string): number {
  return reg.categoryByCode.get(categoryCode)?.verticalCode === 'transport' ? DEFAULT_NEAREST_KM.transport : DEFAULT_NEAREST_KM.other;
}

/**
 * The distance limit an intent puts on its counterparts.
 * hard: a stated required radius. Otherwise (nearest / preferred radius): the declared default limit, or the
 * preferred radius when it is larger — ranking happens inside it.
 */
export interface DistanceBound { km: number; hard: boolean; preferredKm: number | null; isDefault: boolean }

export function boundOf(reg: Registry, m: Pick<MatchableIntent, 'radiusKm' | 'nearest' | 'categoryCode'>): DistanceBound | null {
  const r = m.radiusKm;
  if (r && r.strength === 'required' && r.value > 0) return { km: r.value, hard: true, preferredKm: null, isDefault: false };
  if ((r && r.value > 0) || m.nearest) {
    const def = defaultNearestKm(reg, m.categoryCode);
    const pref = r && r.value > 0 ? r.value : null;
    return { km: Math.max(def, pref ?? 0), hard: false, preferredKm: pref, isDefault: pref === null || def > pref };
  }
  return null;
}

/** Does proximity take part in this pair at all? (Otherwise evaluatePair keeps its legacy centroid ranking.) */
export function proximityApplies(x: MatchableIntent, y: MatchableIntent): boolean {
  const any = (m: MatchableIntent) => !!m.geo || !!m.live || !!m.nearest || !!m.radiusKm;
  return any(x) || any(y);
}

export interface ProximityResult {
  reasons: MatchReason[];
  /** violated required conditions (each one is also in `reasons`) */
  hard: MatchReason[];
  /** unknown facts that block confirmation ('distance', 'live') */
  missing: string[];
  bonus: number;
  /** raw distance between the effective points (server-side only; never shown unrounded) */
  km: number | null;
}

/**
 * Judge a pair on distance. `a`/`b` are the canonical (seek, provide) or (lower-id join, higher-id join) order, so the
 * result is the same whichever way evaluatePair was called.
 */
export function proximityCheck(reg: Registry, a: MatchableIntent, b: MatchableIntent, peer: boolean, now: Date): ProximityResult {
  const out: ProximityResult = { reasons: [], hard: [], missing: [], bonus: 0, km: null };
  const r = (code: string, polarity: MatchReason['polarity'], text: string, strength?: Strength) => out.reasons.push(strength ? { code, polarity, text, strength } : { code, polarity, text });
  const miss = (k: string) => { if (!out.missing.includes(k)) out.missing.push(k); };

  // connection state of shared live positions
  for (const m of [a, b]) {
    const ls = liveState(m, now);
    if (!ls) continue;
    if (ls.fresh) { r('live_now', 'plus', `${ls.labelAr} — موقع مباشر`, 'preferred'); out.bonus += 300; }
    else { r('live_stale', 'unknown', `${ls.labelAr} — الموقع المباشر غير محدَّث`, 'required'); miss('live'); }
  }

  const pa = effectivePoint(reg, a, now);
  const pb = effectivePoint(reg, b, now);
  const km = pa && pb ? haversineKm(pa, pb) : null;
  out.km = km;
  const unc = (pa?.uncKm ?? 0) + (pb?.uncKm ?? 0);
  const shown = km === null ? null : roundDistance(km);
  const approx = [pa, pb].find((p) => p && p.uncKm > 0);
  const approxAr = !approx ? '' : approx.kind === 'place'
    ? ` — الموقع تقريبي (حسب ${approx.placeId != null ? 'مركز ' + (reg.placeById.get(approx.placeId)?.nameAr ?? 'المكان') : 'المكان المذكور'})`
    : ' — دقة الموقع محدودة';

  const bounds: { owner: 'a' | 'b'; bound: DistanceBound }[] = [];
  for (const [owner, m] of [['a', a], ['b', b]] as const) {
    const bd = boundOf(reg, m);
    if (bd) bounds.push({ owner, bound: bd });
  }
  for (const { owner, bound } of bounds) {
    const B = bound.km;
    const label = `${fmtKm(B)} كم`;
    // whose condition: the seeker's ("كما طلبت"), the provider's service radius, or a peer's
    const ofProvider = !peer && owner === 'b';
    const cond = bound.hard ? `ضمن ${label}` : `الأقرب حتى ${label}`;
    if (km === null || shown === null) {
      r('distance_unknown', 'unknown', `المسافة غير معروفة (موقع أحد الطرفين غير محدد) — ${ofProvider ? 'العرض يخدم ' : peer ? 'الشرط: ' : 'طلبك: '}${cond}`, 'required');
      miss('distance');
      continue;
    }
    if (km - unc > B + EPS_KM) {
      const dist = shown.km !== null && shown.km <= B ? `أكثر من ${label} بقليل` : shown.ar;
      const text = ofProvider ? `خارج نطاق خدمة العرض (${label}) — ${dist}`
        : bound.hard ? `أبعد من ${label} (${dist})`
        : bound.isDefault ? `أبعد من ${label} — الحد الافتراضي لـ«الأقرب» (${dist})` : `أبعد من ${label} (${dist})`;
      const ex: MatchReason = { code: 'distance_beyond_radius', polarity: 'minus', text, strength: 'required' };
      out.hard.push(ex);
      out.reasons.push(ex);
      continue;
    }
    if (km + unc <= B + EPS_KM) {
      if (bound.hard) r('distance_within_radius', 'plus', ofProvider ? `ضمن نطاق خدمة العرض (${label}) — ${shown.ar}` : peer ? `ضمن ${label} (${shown.ar})` : `ضمن ${label} كما طلبت (${shown.ar})`, 'required');
    } else {
      // only approximate points can straddle the limit: neither proven nor violated
      r('distance_uncertain', 'unknown', `قد يكون ضمن ${label} (${shown.ar})${approxAr} — يحتاج تأكيد`, 'required');
      miss('distance');
    }
    if (bound.preferredKm !== null) {
      const P = bound.preferredKm;
      if (km + unc <= P + EPS_KM) { r('distance_pref_satisfied', 'plus', `ضمن ${fmtKm(P)} كم تقريبًا كما تفضّل`, 'preferred'); out.bonus += 400; }
      else if (km - unc > P + EPS_KM) { r('distance_pref_unsatisfied', 'minus', `أبعد من ${fmtKm(P)} كم المفضّلة`, 'preferred'); out.bonus -= 400; }
    }
  }

  if (shown) {
    r('distance', 'info', `على بعد ${shown.ar}${approxAr}`);
    // ranking: with a distance wish the nearest clearly come first; otherwise the legacy gentle penalty
    if (bounds.length) out.bonus += Math.round(1500 / (1 + km!));
    else out.bonus -= Math.min(1000, Math.round(8 * km!));
  }
  return out;
}

/** Arabic phrase for a radius chip ("ضمن 5 كم", "الأقرب أولًا (حتى 10 كم)"). */
export function boundAr(reg: Registry, m: Pick<MatchableIntent, 'radiusKm' | 'nearest' | 'categoryCode'>): string | null {
  const bd = boundOf(reg, m);
  if (!bd) return null;
  if (bd.hard) return `ضمن ${fmtKm(bd.km)} كم`;
  if (bd.preferredKm !== null) return `حوالي ${fmtKm(bd.preferredKm)} كم — الأقرب أولًا (حتى ${fmtKm(bd.km)} كم)`;
  return `الأقرب أولًا (حتى ${fmtKm(bd.km)} كم)`;
}
