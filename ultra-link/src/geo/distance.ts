// Pure distance math and privacy-preserving distance text (no DB, no Node APIs: also bundled into the web demo).
//
// Coordinates are WGS84 degrees (floats are fine: they are not money). Distances are great-circle kilometres on a
// sphere of mean radius 6371.0088 km (haversine). PostgreSQL's earthdistance uses 6378.168 km, i.e. ≈ 0.11 % longer:
// SQL is only ever used to PRE-SELECT candidates (with a slack, see src/geo/retrieve.ts); every verdict and every
// distance shown to a user comes from this file.

export interface LatLng { lat: number; lng: number }

export const EARTH_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

/** Great-circle distance in km (haversine; exact to floating point for any two points). */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The point `km` away from `from` along `bearingDeg` (0 = north, 90 = east). Used by tests and synthetic data. */
export function destination(from: LatLng, km: number, bearingDeg: number): LatLng {
  const d = km / EARTH_RADIUS_KM;
  const br = bearingDeg * RAD;
  const lat1 = from.lat * RAD;
  const lng1 = from.lng * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / RAD, lng: ((lng2 / RAD + 540) % 360) - 180 };
}

export function validLatLng(p: { lat?: unknown; lng?: unknown } | null | undefined): p is LatLng {
  return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/**
 * A distance as other people may see it. Exact distances would let someone locate a person by measuring from a few
 * places (trilateration), so every distance that leaves the server is bucketed:
 *   < 1 km → "أقل من 1 كم"; 1–10 km → 0.5 km steps; 10–50 km → 1 km steps; ≥ 50 km → 5 km steps.
 * `km` is the bucket value (null for "less than 1 km"); the raw distance never leaves this function's caller.
 */
export interface RoundedDistance { km: number | null; lt1: boolean; ar: string }

export function roundDistance(km: number): RoundedDistance {
  if (!Number.isFinite(km) || km < 0) throw new RangeError(`bad distance ${km}`);
  if (km < 1) return { km: null, lt1: true, ar: 'أقل من 1 كم' };
  const step = km < 10 ? 0.5 : km < 50 ? 1 : 5;
  const v = Math.max(1, Math.round(km / step) * step);
  return { km: v, lt1: false, ar: `≈ ${fmtKm(v)} كم` };
}

/** "5", "2.5", "0.5" — Western digits; the UI localizes digits (public/js/ui/format.js ar()). */
export function fmtKm(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
}

/**
 * Elapsed time as a short Arabic phrase for freshness labels ("الآن", "3 د", "2 س", "4 يوم").
 * Minutes/hours are abbreviated (د / س) like the product copy («قبل ٣ د»), which also avoids Arabic plural forms.
 */
export function agoAr(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'أقل من دقيقة';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} د`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} س`;
  return `${Math.floor(h / 24)} يوم`;
}
