// Proximity semantics (pure): distance math, rounding, effective-point choice, radius boundaries (incl. exactly at the
// radius), unknown / approximate distances, stale live positions, ranking, and generated properties (order
// independence, peer symmetry, verdict invariants, an independent oracle for the distance condition).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRegistry } from '../../src/domain/registry.ts';
import { EXCLUSION_PRIORITY, evaluatePair, specToMatchable, type MatchableIntent } from '../../src/matching/evaluate.ts';
import { agoAr, destination, haversineKm, roundDistance, type LatLng } from '../../src/geo/distance.ts';
import { boundOf, effectivePoint, LIVE_FRESH_MS, PLACE_MARGIN_KM, proximityCheck } from '../../src/geo/semantics.ts';
import type { Strength } from '../../src/domain/types.ts';

const reg = seedRegistry();
const NOW = new Date('2026-10-08T12:00:00Z');
const P = (code: string) => reg.placeByCode.get(code)!.id;
const AZAZ = P('sy.aleppo.azaz');
const AFRIN = P('sy.aleppo.afrin');
const ALEPPO = P('sy.aleppo.aleppo');
const C_AZAZ: LatLng = { lat: 36.5866, lng: 37.0463 };
const C_AFRIN: LatLng = { lat: 36.5119, lng: 36.8695 };
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let nextId = 1;
function mk(side: MatchableIntent['side'], over: Partial<MatchableIntent> = {}, categoryCode = 'transport.ride'): MatchableIntent {
  const id = String(nextId++);
  const cat = reg.categoryByCode.get(categoryCode)!;
  return {
    id, userId: `u${id}`, realm: 'synthetic', side, categoryCode, deal: cat.deals[0]!, status: 'active', version: 1,
    pointPlaceId: AZAZ, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [], price: null, when: null, attrs: {}, constraints: [],
    createdAt: ago(86_400_000), ...over,
  };
}
const gps = (p: LatLng, accuracyM = 15) => ({ lat: p.lat, lng: p.lng, accuracyM, source: 'gps' as const });
const rider = (p: LatLng, radius: { value: number; strength: Strength } | null, extra: Partial<MatchableIntent> = {}) =>
  mk('seek', { geo: gps(p), radiusKm: radius, nearest: radius ? radius.strength === 'preferred' : true, ...extra });
const driverAt = (p: LatLng, extra: Partial<MatchableIntent> = {}) => mk('provide', { geo: gps(p), ...extra });
const ev = (a: MatchableIntent, b: MatchableIntent) => evaluatePair(reg, a, b, { now: NOW });
const codes = (v: { reasons: { code: string }[] }) => v.reasons.map((r) => r.code);

// ───────────── distance math & rounding ─────────────
test('haversine: known distance, symmetry, zero, and destination() round trip', () => {
  const d = haversineKm(C_AZAZ, C_AFRIN);
  assert.ok(d > 17.5 && d < 18.2, `إعزاز–عفرين ${d}`);
  assert.equal(haversineKm(C_AFRIN, C_AZAZ), d);
  assert.equal(haversineKm(C_AZAZ, C_AZAZ), 0);
  for (const km of [0.05, 1, 5, 10, 49.9, 300]) {
    for (const br of [0, 45, 90, 180, 270, 333]) {
      const q = destination(C_AZAZ, km, br);
      assert.ok(Math.abs(haversineKm(C_AZAZ, q) - km) < 1e-6, `${km} km @${br}°`);
    }
  }
});

test('rounded distances: < 1 km, 0.5 km steps to 10 km, 1 km to 50 km, 5 km beyond', () => {
  const cases: [number, number | null, string][] = [
    [0, null, 'أقل من 1 كم'], [0.999, null, 'أقل من 1 كم'], [1, 1, '≈ 1 كم'], [1.24, 1, '≈ 1 كم'], [1.26, 1.5, '≈ 1.5 كم'],
    [7.2, 7, '≈ 7 كم'], [7.3, 7.5, '≈ 7.5 كم'], [9.76, 10, '≈ 10 كم'], [10.4, 10, '≈ 10 كم'], [49.4, 49, '≈ 49 كم'], [52, 50, '≈ 50 كم'], [53, 55, '≈ 55 كم'],
  ];
  for (const [km, bucket, ar] of cases) {
    const r = roundDistance(km);
    assert.equal(r.km, bucket, String(km));
    assert.equal(r.ar, ar, String(km));
    assert.equal(r.lt1, bucket === null);
  }
  assert.throws(() => roundDistance(-1));
  assert.equal(agoAr(30_000), 'أقل من دقيقة');
  assert.equal(agoAr(25 * 60_000), '25 د');
  assert.equal(agoAr(3 * 3600_000), '3 س');
});

// ───────────── effective point ─────────────
test('effective point: fresh live > static GPS > place centroid; stale or coarse fixes fall back', () => {
  const near = destination(C_AZAZ, 2, 90);
  const liveFix = { ...destination(C_AZAZ, 1, 0), accuracyM: 10 };
  const base = { geo: gps(near) };
  assert.equal(effectivePoint(reg, mk('provide', { ...base, live: { ...liveFix, at: ago(60_000) } }), NOW)!.kind, 'live');
  assert.equal(effectivePoint(reg, mk('provide', { ...base, live: { ...liveFix, at: ago(LIVE_FRESH_MS + 1000) } }), NOW)!.kind, 'gps', 'stale live → static GPS');
  assert.equal(effectivePoint(reg, mk('provide', { ...base, live: { ...liveFix, accuracyM: 5000, at: ago(1000) } }), NOW)!.kind, 'gps', 'coarse live fix ignored');
  const exactly = effectivePoint(reg, mk('provide', { ...base, live: { ...liveFix, at: ago(LIVE_FRESH_MS) } }), NOW)!;
  assert.equal(exactly.kind, 'live', 'exactly 10 minutes old is still connected');
  const g = effectivePoint(reg, mk('provide', base), NOW)!;
  assert.deepEqual([g.kind, g.uncKm], ['gps', 0]);
  assert.equal(effectivePoint(reg, mk('provide', { geo: gps(near, 1200) }), NOW)!.uncKm, 1.2, 'a mediocre fix carries its accuracy');
  const coarse = effectivePoint(reg, mk('provide', { geo: gps(near, 8000) }), NOW)!;
  assert.deepEqual([coarse.kind, coarse.placeId, coarse.uncKm], ['place', AZAZ, PLACE_MARGIN_KM.city], 'a fix worse than 3 km → the city centroid');
  const c = effectivePoint(reg, mk('provide', {}), NOW)!;
  assert.deepEqual([c.kind, c.lat, c.lng, c.uncKm], ['place', C_AZAZ.lat, C_AZAZ.lng, 6]);
  const seekScope = effectivePoint(reg, mk('seek', { pointPlaceId: null, scopePlaceIds: [AFRIN] }), NOW)!;
  assert.deepEqual([seekScope.kind, seekScope.placeId], ['place', AFRIN], 'a point-less seeker with one place → its centroid');
  assert.equal(effectivePoint(reg, mk('seek', { pointPlaceId: null, scopePlaceIds: [AFRIN, AZAZ] }), NOW), null, 'two places → unknown');
  assert.equal(effectivePoint(reg, mk('provide', { pointPlaceId: P('sy.aleppo') }), NOW), null, 'a region without coordinates → unknown');
  assert.equal(effectivePoint(reg, mk('provide', { pointPlaceId: P('sy.homs') }), NOW)!.uncKm, PLACE_MARGIN_KM.region);
  assert.equal(effectivePoint(reg, mk('provide', { pointPlaceId: null }), NOW), null);
  assert.equal(effectivePoint(reg, mk('provide', { geo: { ...C_AFRIN, source: 'place' } }), NOW)!.kind, 'place');
});

test('bounds: hard radius; nearest = declared default (10 km transport, 50 km otherwise); preferred radius ranks inside max(default, it)', () => {
  assert.deepEqual(boundOf(reg, { categoryCode: 'transport.ride', radiusKm: { value: 5, strength: 'required' } }), { km: 5, hard: true, preferredKm: null, isDefault: false });
  assert.deepEqual(boundOf(reg, { categoryCode: 'transport.ride', nearest: true }), { km: 10, hard: false, preferredKm: null, isDefault: true });
  assert.deepEqual(boundOf(reg, { categoryCode: 'services.plumbing', nearest: true }), { km: 50, hard: false, preferredKm: null, isDefault: true });
  assert.deepEqual(boundOf(reg, { categoryCode: 'transport.ride', radiusKm: { value: 3, strength: 'preferred' } }), { km: 10, hard: false, preferredKm: 3, isDefault: true });
  assert.deepEqual(boundOf(reg, { categoryCode: 'transport.ride', radiusKm: { value: 25, strength: 'preferred' } }), { km: 25, hard: false, preferredKm: 25, isDefault: false });
  assert.equal(boundOf(reg, { categoryCode: 'transport.ride' }), null);
});

// ───────────── hard radius boundaries ─────────────
test('hard radius: exactly at the radius is inside; one metre beyond is excluded with a rounded reason', () => {
  for (const R of [0.5, 1, 5, 7.5, 20]) {
    const at = destination(C_AZAZ, R, 77);
    const inside = ev(rider(C_AZAZ, { value: R, strength: 'required' }), driverAt(at));
    assert.equal(inside.verdict, 'match', `R=${R} at the radius`);
    assert.ok(codes(inside).includes('distance_within_radius'));
    const beyond = ev(rider(C_AZAZ, { value: R, strength: 'required' }), driverAt(destination(C_AZAZ, R + 0.0021, 77)));
    assert.equal(beyond.verdict, 'excluded', `R=${R} + 2 m`);
    assert.equal(beyond.exclusion!.code, 'distance_beyond_radius');
    assert.match(beyond.exclusion!.text, new RegExp(`^أبعد من ${R} كم`));
    const justIn = ev(rider(C_AZAZ, { value: R, strength: 'required' }), driverAt(destination(C_AZAZ, R - 0.01, 200)));
    assert.equal(justIn.verdict, 'match');
  }
  const far = ev(rider(C_AZAZ, { value: 5, strength: 'required' }), driverAt(destination(C_AZAZ, 7.2, 10)));
  assert.equal(far.exclusion!.text, 'أبعد من 5 كم (≈ 7 كم)');
  // the provider's own service radius applies the same way
  const svc = ev(rider(C_AZAZ, null), driverAt(destination(C_AZAZ, 8, 10), { radiusKm: { value: 5, strength: 'required' } }));
  assert.equal(svc.exclusion?.code, 'distance_beyond_radius');
  assert.match(svc.exclusion!.text, /خارج نطاق خدمة العرض \(5 كم\)/);
});

test('nearest without a radius: ranked inside the declared default limit, never widened', () => {
  const r = rider(C_AZAZ, null);
  const near = ev(r, driverAt(destination(C_AZAZ, 1.2, 0)));
  const mid = ev(r, driverAt(destination(C_AZAZ, 6, 0)));
  const far = ev(r, driverAt(destination(C_AZAZ, 10.5, 0)));
  assert.equal(near.verdict, 'match');
  assert.equal(mid.verdict, 'match');
  assert.ok(near.score > mid.score, `nearer ranks higher: ${near.score} > ${mid.score}`);
  assert.equal(far.verdict, 'excluded');
  assert.match(far.exclusion!.text, /الحد الافتراضي لـ«الأقرب»/);
  // a plumber "near me" has a 50 km default
  const plumber = (p: LatLng) => mk('provide', { geo: gps(p) }, 'services.plumbing');
  const seeker = mk('seek', { geo: gps(C_AZAZ), nearest: true }, 'services.plumbing');
  assert.equal(ev(seeker, plumber(destination(C_AZAZ, 30, 90))).verdict, 'match');
  assert.equal(ev(seeker, plumber(destination(C_AZAZ, 51, 90))).verdict, 'excluded');
});

test('preferred radius ("حوالي 3 كم"): plus inside, minus outside, never excluded inside the default limit', () => {
  const r = rider(C_AZAZ, { value: 3, strength: 'preferred' });
  const inside = ev(r, driverAt(destination(C_AZAZ, 2, 0)));
  const outside = ev(r, driverAt(destination(C_AZAZ, 6, 0)));
  assert.equal(inside.verdict, 'match');
  assert.ok(codes(inside).includes('distance_pref_satisfied'));
  assert.equal(outside.verdict, 'match');
  assert.ok(outside.reasons.some((x) => x.code === 'distance_pref_unsatisfied' && x.polarity === 'minus' && x.strength === 'preferred'));
  assert.ok(inside.score > outside.score);
});

// ───────────── unknown / approximate ─────────────
test('no coordinates anywhere on one side → distance unknown → possible, never confirmed', () => {
  const v = ev(rider(C_AZAZ, { value: 5, strength: 'required' }), mk('provide', { pointPlaceId: null }));
  assert.equal(v.verdict, 'possible');
  assert.ok(v.missing.includes('distance'));
  assert.ok(v.reasons.some((x) => x.code === 'distance_unknown' && x.polarity === 'unknown'));
  const region = ev(rider(C_AZAZ, null), mk('provide', { pointPlaceId: P('sy.aleppo') }));
  assert.equal(region.verdict, 'possible');
});

test('place-centroid-only distance: inside for sure → ok; straddling the radius → possible; clearly beyond → excluded', () => {
  // driver said "بإعزاز" (no GPS): centroid ± 6 km
  const named = (place: number) => mk('provide', { pointPlaceId: place });
  const v1 = ev(rider(C_AZAZ, { value: 10, strength: 'required' }), named(AZAZ)); // 0 ± 6 ≤ 10
  assert.equal(v1.verdict, 'match');
  const v2 = ev(rider(C_AZAZ, { value: 3, strength: 'required' }), named(AZAZ)); // 0 ± 6 straddles 3
  assert.equal(v2.verdict, 'possible');
  assert.ok(v2.missing.includes('distance'));
  assert.ok(v2.reasons.some((x) => x.code === 'distance_uncertain' && /تقريبي \(حسب مركز إعزاز\)/.test(x.text)), JSON.stringify(v2.reasons));
  const v3 = ev(rider(C_AZAZ, { value: 5, strength: 'required' }), named(ALEPPO)); // ≈ 43 km − 6 > 5
  assert.equal(v3.exclusion?.code, 'distance_beyond_radius');
  assert.ok(v1.reasons.some((x) => x.code === 'distance' && /تقريبي/.test(x.text)), 'approximate distances say so');
});

// ───────────── live positions ─────────────
test('live: a fresh position is used and shown as connected; a stale one is "غير متصل منذ…" → possible', () => {
  const r = rider(C_AZAZ, { value: 5, strength: 'required' });
  const home = destination(C_AZAZ, 20, 180); // static point far away, live position close
  const fresh = ev(r, driverAt(home, { live: { ...destination(C_AZAZ, 1.5, 0), accuracyM: 10, at: ago(90_000) } }));
  assert.equal(fresh.verdict, 'match', JSON.stringify(fresh.reasons));
  assert.ok(fresh.reasons.some((x) => x.code === 'live_now' && x.text.startsWith('آخر تحديث قبل 1 د')));
  const stale = ev(r, driverAt(destination(C_AZAZ, 1, 0), { live: { ...destination(C_AZAZ, 1, 0), accuracyM: 10, at: ago(25 * 60_000) } }));
  assert.equal(stale.verdict, 'possible');
  assert.ok(stale.missing.includes('live'));
  assert.ok(stale.reasons.some((x) => x.code === 'live_stale' && x.text.startsWith('غير متصل منذ 25 د')));
  // stale live + far static point: falls back to the static point → excluded
  const staleFar = ev(r, driverAt(home, { live: { ...destination(C_AZAZ, 1, 0), accuracyM: 10, at: ago(25 * 60_000) } }));
  assert.equal(staleFar.exclusion?.code, 'distance_beyond_radius');
  // connected drivers rank above static ones at the same distance
  const p = destination(C_AZAZ, 2, 45);
  assert.ok(ev(rider(C_AZAZ, null), driverAt(p, { live: { ...p, accuracyM: 10, at: ago(5_000) } })).score > ev(rider(C_AZAZ, null), driverAt(p)).score);
});

// ───────────── privacy of texts ─────────────
test('reason texts only carry rounded distances (bucket values), never raw coordinates', () => {
  const allowed = (n: number) => (n < 10 ? Number.isInteger(n * 2) : n < 50 ? Number.isInteger(n) : n % 5 === 0);
  for (let i = 0; i < 400; i++) {
    const km = 0.2 + i * 0.37;
    const d = driverAt(destination(C_AZAZ, km, i * 13), { radiusKm: i % 3 ? { value: 1 + (i % 9), strength: 'required' } : null });
    const v = ev(rider(C_AZAZ, i % 2 ? { value: 2 + (i % 11), strength: 'required' } : null), d);
    for (const r of v.reasons) {
      const nums = [...r.text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      for (const n of nums) assert.ok(allowed(n) || r.code.startsWith('live') , `${r.code}: "${r.text}" (${km})`);
      assert.ok(!r.text.includes(String(C_AZAZ.lat)) && !/\d+\.\d{3,}/.test(r.text), r.text);
    }
  }
});

// ───────────── generated properties ─────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
test('properties: order independence, peer symmetry, verdict invariants and a distance oracle over 3000 random geo pairs', () => {
  const r = mulberry32(Number(process.env.UL_PROP_SEED ?? 8082026));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const places = [AZAZ, AFRIN, ALEPPO, P('sy.aleppo.marea'), P('sy.aleppo'), P('sy.homs'), P('tr.kilis')];
  const randomPoint = () => destination(C_AZAZ, r() * 40, r() * 360);
  const one = (side: MatchableIntent['side'], cat: string): MatchableIntent => {
    const roll = r();
    const geo = roll < 0.55 ? { ...randomPoint(), accuracyM: pick([5, 30, 400, 1500, 2900, 6000]), source: 'gps' as const } : roll < 0.6 ? { ...randomPoint(), source: 'place' as const } : null;
    const liveRoll = r();
    const live = side !== 'seek' && liveRoll < 0.3 ? { ...randomPoint(), accuracyM: pick([5, 50, 2000, 4000]), at: ago(pick([0, 30_000, 9 * 60_000, LIVE_FRESH_MS, 11 * 60_000, 3 * 3600_000])) } : null;
    const radius = r() < 0.45 ? { value: pick([0.5, 1, 2, 5, 7.5, 10, 25]), strength: (r() < 0.7 ? 'required' : 'preferred') as Strength } : null;
    return mk(side, { pointPlaceId: r() < 0.85 ? pick(places) : null, geo, live, radiusKm: radius, nearest: r() < 0.3 }, cat);
  };
  let n = 0;
  const seen = { match: 0, possible: 0, excluded: 0 };
  for (let i = 0; i < 3000; i++) {
    const peer = r() < 0.25;
    const [a, b] = peer ? [one('join', 'activities.sports'), one('join', 'activities.sports')] : [one('seek', 'transport.ride'), one('provide', 'transport.ride')];
    const ab = ev(a, b);
    const ba = ev(b, a);
    assert.deepEqual(ba, ab, `#${i} order`);
    seen[ab.verdict]++;
    if (ab.verdict === 'excluded') {
      assert.ok((EXCLUSION_PRIORITY as readonly string[]).includes(ab.exclusion!.code));
      assert.ok(ab.reasons.some((x) => x.code === ab.exclusion!.code && x.polarity === 'minus'));
      assert.equal(ab.score, 0);
    } else if (ab.verdict === 'possible') {
      assert.ok(ab.missing.length > 0 && ab.reasons.some((x) => x.polarity === 'unknown'));
      assert.ok(ab.score >= 0 && ab.score <= 4999);
    } else {
      assert.deepEqual(ab.missing, []);
      assert.ok(ab.score >= 5000 && ab.score <= 10000);
    }
    // independent oracle for the distance dimension (seek/prov or canonical peer order irrelevant: symmetric)
    const s = peer ? (BigInt(a.id) < BigInt(b.id) ? a : b) : a;
    const p = peer ? (s === a ? b : a) : b;
    const pt = (m: MatchableIntent) => {
      const fresh = m.live && NOW.getTime() - Date.parse(m.live.at) <= LIVE_FRESH_MS && (m.live.accuracyM ?? 0) <= 3000;
      if (fresh) return { lat: m.live!.lat, lng: m.live!.lng, u: (m.live!.accuracyM ?? 0) > 250 ? m.live!.accuracyM! / 1000 : 0 };
      if (m.geo && m.geo.source === 'place') return { lat: m.geo.lat, lng: m.geo.lng, u: 6 };
      if (m.geo && (m.geo.accuracyM ?? 0) <= 3000) return { lat: m.geo.lat, lng: m.geo.lng, u: (m.geo.accuracyM ?? 0) > 250 ? m.geo.accuracyM! / 1000 : 0 };
      const pl = m.pointPlaceId != null ? reg.placeById.get(m.pointPlaceId)! : null;
      if (pl && pl.lat != null && (pl.kind === 'city' || pl.kind === 'region')) return { lat: pl.lat, lng: pl.lng!, u: pl.kind === 'city' ? 6 : 30 };
      if (m.geo) return { lat: m.geo.lat, lng: m.geo.lng, u: (m.geo.accuracyM ?? 0) / 1000 };
      return null;
    };
    const ps = pt(s);
    const pp = pt(p);
    const lim = (m: MatchableIntent) => (m.radiusKm?.strength === 'required' ? m.radiusKm.value : m.radiusKm || m.nearest ? Math.max(m.categoryCode.startsWith('transport') ? 10 : 50, m.radiusKm?.value ?? 0) : null);
    const limits = [lim(s), lim(p)].filter((x): x is number => x !== null);
    const px = proximityCheck(reg, s, p, peer, NOW);
    if (ps && pp && limits.length) {
      const d = haversineKm(ps, pp);
      const u = ps.u + pp.u;
      const violated = limits.some((L) => d - u > L + 0.001);
      assert.equal(px.hard.length > 0, violated, `#${i} oracle violated=${violated} d=${d} u=${u} limits=${limits}`);
      if (violated) assert.equal(ab.verdict, 'excluded');
      const unsure = !violated && limits.some((L) => d + u > L + 0.001);
      if (unsure) assert.notEqual(ab.verdict, 'match', `#${i} straddling must not be confirmed`);
    } else if (limits.length) {
      assert.ok(px.missing.includes('distance') && ab.verdict !== 'match', `#${i} unknown distance`);
    }
    n++;
  }
  assert.equal(n, 3000);
  for (const k of ['match', 'possible', 'excluded'] as const) assert.ok(seen[k] > 150, `${k}: ${seen[k]}`);
});

test('specToMatchable carries geo / radius / nearest from the spec (and nothing when absent)', () => {
  const spec = { side: 'seek' as const, categoryCode: 'transport.ride', deal: 'service' as const, price: null, when: null, attrs: {}, constraints: [],
    place: { pointPlaceId: AZAZ, scopePlaceIds: [], scopeStrength: 'required' as const, geo: gps(C_AZAZ), radiusKm: { value: 5, strength: 'required' as const }, nearest: true } };
  const m = specToMatchable(spec, { id: '1', userId: 'u' });
  assert.deepEqual([m.geo, m.radiusKm, m.nearest], [spec.place.geo, spec.place.radiusKm, true]);
  const plain = specToMatchable({ ...spec, place: { pointPlaceId: AZAZ, scopePlaceIds: [], scopeStrength: 'required' } }, { id: '2', userId: 'u' });
  assert.ok(!('geo' in plain) && !('radiusKm' in plain) && !('nearest' in plain));
});
