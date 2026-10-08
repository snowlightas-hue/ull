// Performance of the GEO path with 100 000 GPS-located drivers (env UL_GEO_PERF_N) on an isolated database:
//   KNN (stored points / live positions), a full matchIntent for ride requests ("تكسي قريب مني"), /nearby, and — for
//   comparison — the same request WITHOUT a distance condition (classic place retrieval, which fans out over every
//   driver whose empty scope is keyed on the root place). Prints a table; asserts generous ceilings only.
import { after, before, test } from 'node:test';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { withTx } from '../../src/db/pool.ts';
import type { IntentSpec } from '../../src/domain/types.ts';
import { createIntent } from '../../src/repo/intents.ts';
import { matchIntent } from '../../src/matching/engine.ts';
import { GEO_K, knnIntents, knnLive, type GeoKeys } from '../../src/geo/retrieve.ts';
import { nearbyFor } from '../../src/geo/nearby.ts';
import { destination, type LatLng } from '../../src/geo/distance.ts';

const N = Number(process.env.UL_GEO_PERF_N ?? 100_000);
const TAG = `geo_perf_${process.pid}`;
let db: TestDb;
const CITIES: [string, number][] = [['sy.aleppo.azaz', 0.3], ['sy.aleppo.aleppo', 0.3], ['sy.aleppo.afrin', 0.15], ['sy.aleppo.al_bab', 0.1], ['sy.idlib.idlib', 0.1], ['sy.idlib.sarmada', 0.05]];
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1]!.toFixed(2) };
};
const results: Record<string, unknown> = {};

before(async () => {
  db = await freshDb(TAG);
  const t0 = Date.now();
  const reg = db.reg;
  await db.pool.query(`INSERT INTO users (display_name, realm) SELECT 'سائق ' || g, 'synthetic' FROM generate_series(1, 2000) g`);
  const centers = CITIES.map(([code, w]) => ({ ...reg.placeByCode.get(code)!, w }));
  const cum: number[] = [];
  centers.reduce((acc, c) => { cum.push(acc + c.w); return acc + c.w; }, 0);
  // N GPS-located ride offers clustered around 6 cities (σ ≈ 6 km), point = the cluster's city, empty scope (anywhere)
  await db.pool.query('SELECT setseed(0.42)');
  await db.pool.query(
    `WITH c AS (SELECT * FROM unnest($1::int[], $2::int[], $3::float8[], $4::float8[], $5::float8[]) AS t(place_id, lft, lat, lng, cum)),
          u AS (SELECT min(id) AS lo, max(id) AS hi FROM users),
          r AS (SELECT g, random() AS pick, random_normal(0, 0.054) AS dlat, random_normal(0, 0.067) AS dlng, random() AS age FROM generate_series(1, $6) g)
     INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar, point_place_id, point_lft, scope_place_ids,
                          geo_lat, geo_lng, geo_accuracy_m, geo_source, geo_at, expires_at, created_at, updated_at)
     SELECT 8, u.lo + (r.g % (u.hi - u.lo + 1)), 'synthetic', 'provide', $7, $8, 'تكسي ' || r.g, c.place_id, c.lft, '{}',
            c.lat + r.dlat, c.lng + r.dlng, 10 + (r.g % 40), 'gps', now(), now() + interval '60 days', now() - r.age * interval '30 days', now()
       FROM r CROSS JOIN u CROSS JOIN LATERAL (SELECT * FROM c WHERE c.cum >= r.pick ORDER BY c.cum LIMIT 1) c`,
    [centers.map((c) => c.id), centers.map((c) => c.lft), centers.map((c) => c.lat!), centers.map((c) => c.lng!), cum, N,
      reg.categoryByCode.get('transport.ride')!.id, reg.dealByCode.get('service')!.id],
  );
  await db.pool.query(`INSERT INTO intent_refs (public_id, vertical_id, intent_id, user_id) SELECT public_id, vertical_id, id, user_id FROM intents WHERE vertical_id = 8`);
  await db.pool.query(`INSERT INTO intent_scopes (vertical_id, intent_id, realm, side, deal_type_id, category_id, place_id)
     SELECT vertical_id, id, realm, side, deal_type_id, category_id, $1 FROM intents WHERE vertical_id = 8`, [reg.rootPlaceId]);
  // 5 % of drivers are connected right now (live position within ~300 m of their static point)
  await db.pool.query(`INSERT INTO live_positions (vertical_id, intent_id, user_id, realm, side, deal_type_id, category_id, lat, lng, accuracy_m, expires_at)
     SELECT vertical_id, id, user_id, realm, side, deal_type_id, category_id, geo_lat + random_normal(0, 0.003), geo_lng + random_normal(0, 0.003), 15, now() + interval '10 minutes'
       FROM intents WHERE vertical_id = 8 AND id % 20 = 0`);
  await db.pool.query('VACUUM (ANALYZE) intents_transport, intent_scopes, intent_refs, live_positions');
  results.setup = { drivers: N, live: Math.floor(N / 20), seconds: (Date.now() - t0) / 1000 };
});
after(async () => {
  results.k = GEO_K;
  console.log('\n[geo-perf] results\n' + JSON.stringify(results, null, 2));
  if (process.env.UL_GEO_PERF_OUT) writeFileSync(process.env.UL_GEO_PERF_OUT, JSON.stringify(results, null, 2));
  await db?.close();
  const pg = (await import('pg')).default;
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`); } finally { await a.end(); }
});

function riderSpec(at: LatLng, extra: Partial<IntentSpec['place']> = {}): IntentSpec {
  return { side: 'seek', categoryCode: 'transport.ride', deal: 'service', price: null, when: null, attrs: {}, constraints: [],
    place: { pointPlaceId: db.reg.placeByCode.get('sy.aleppo.azaz')!.id, scopePlaceIds: [], scopeStrength: 'required', geo: { ...at, accuracyM: 15, source: 'gps' }, ...extra } };
}

test(`KNN with ${N} geo intents: nearest 10 / 200 within 5–10 km, live nearest 10`, async () => {
  const reg = db.reg;
  const cat = reg.categoryByCode.get('transport.ride')!;
  const keys: GeoKeys = { verticalId: 8, realm: 'synthetic', side: 'provide', dealTypeId: reg.dealByCode.get('service')!.id, categoryIds: [cat.id, cat.ancestors.at(-1)!], notUserId: '0' };
  const azaz = reg.placeByCode.get('sy.aleppo.azaz')!;
  const pts = Array.from({ length: 60 }, (_, i) => destination({ lat: azaz.lat!, lng: azaz.lng! }, (i % 10) * 0.8, i * 47));
  for (const p of pts.slice(0, 5)) await knnIntents(db.pool, keys, p, 10, 10); // warm up
  const time = async (fn: () => Promise<string[]>) => { const t = performance.now(); const r = await fn(); return { ms: performance.now() - t, n: r.length }; };
  const k10 = []; const k200 = []; const k10r5 = []; const live = [];
  for (const p of pts) {
    k10.push(await time(() => knnIntents(db.pool, keys, p, 16, 10)));
    k200.push(await time(() => knnIntents(db.pool, keys, p, 16, 200)));
    k10r5.push(await time(() => knnIntents(db.pool, keys, p, 5, 10)));
    live.push(await time(() => knnLive(db.pool, keys, p, 16, 10)));
  }
  results.knn = {
    'stored nearest-10 (box 16 km)': stats(k10.map((x) => x.ms)),
    'stored nearest-200 (box 16 km)': stats(k200.map((x) => x.ms)),
    'stored nearest-10 within 5 km': stats(k10r5.map((x) => x.ms)),
    'live nearest-10 (box 16 km)': stats(live.map((x) => x.ms)),
    returned: { k10: stats(k10.map((x) => x.n)).mean, k200: stats(k200.map((x) => x.n)).mean, live10: stats(live.map((x) => x.n)).mean },
  };
  const plan = (await db.pool.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT id FROM intents WHERE vertical_id = 8 AND realm = 'synthetic' AND side = 'provide' AND deal_type_id = $1
      AND category_id = ANY($2) AND status = 'active' AND user_id <> 0 AND geo_lat IS NOT NULL
      AND earth_box(ll_to_earth($3, $4), 16000) @> ll_to_earth(geo_lat, geo_lng)
      ORDER BY ll_to_earth(geo_lat, geo_lng) <-> ll_to_earth($3, $4) LIMIT 10`, [keys.dealTypeId, keys.categoryIds, azaz.lat, azaz.lng])).rows.map((r) => r['QUERY PLAN']);
  results.knnPlan = plan;
  assert.ok(plan.join('\n').includes('Index Scan using intents_transport_ll_to_earth_idx'), plan.join('\n'));
  assert.ok(stats(k10.map((x) => x.ms)).p95 < 50, 'KNN p95 under 50 ms');
});

test(`full matchIntent for ride requests among ${N} geo intents (GEO path) vs. the classic place path`, async () => {
  const reg = db.reg;
  const users = await Promise.all(Array.from({ length: 30 }, (_, i) => mkUser(db.pool, `rider ${i}`)));
  const azaz = reg.placeByCode.get('sy.aleppo.azaz')!;
  const aleppo = reg.placeByCode.get('sy.aleppo.aleppo')!;
  const geoRuns: number[] = []; const geoWall: number[] = []; const cand: number[] = []; const found: number[] = []; let truncated = 0;
  const reqs: { v: number; id: string }[] = [];
  for (let i = 0; i < 30; i++) {
    const c = i % 2 ? azaz : aleppo;
    const at = destination({ lat: c.lat!, lng: c.lng! }, (i % 6) * 1.1, i * 61);
    const spec = riderSpec(at, i % 5 === 4 ? { radiusKm: { value: 3, strength: 'required' } } : { nearest: true });
    const r = await withTx(db.pool, (tx) => createIntent(tx, reg, { userId: users[i]!, realm: 'synthetic', spec, titleAr: 'بدي تكسي', sourceText: null, conversationId: null }));
    reqs.push({ v: r.verticalId, id: r.id });
    const t = performance.now();
    const run = await matchIntent(db.pool, reg, { verticalId: r.verticalId, intentId: r.id, trigger: 'interactive' });
    geoWall.push(performance.now() - t);
    geoRuns.push(run.durationMs);
    cand.push(run.totals.candidates);
    found.push(run.totals.confirmed + run.totals.possible);
    if (run.truncated) truncated++;
    assert.ok(run.directions.includes('geo'), String(run.directions));
  }
  // warm: the same requests again (pairs exist, no new notifications)
  const warm: number[] = [];
  for (const r of reqs) { const t = performance.now(); await matchIntent(db.pool, reg, { verticalId: r.v, intentId: r.id, trigger: 'job' }); warm.push(performance.now() - t); }
  const nb: number[] = [];
  for (const r of reqs.slice(0, 20)) { const t = performance.now(); const x = await nearbyFor(db.pool, reg, { verticalId: r.v, id: r.id }, { limit: 10 }); nb.push(performance.now() - t); assert.ok(x.ok && x.items.length === 10); }
  const notes = (await db.pool.query(`SELECT count(*)::int n FROM notifications WHERE kind = 'ride_nearby'`)).rows[0].n;
  results.matchIntentGeo = {
    'cold wall ms': stats(geoWall), 'cold engine ms (durationMs)': stats(geoRuns), 'warm wall ms': stats(warm),
    candidates: stats(cand), 'confirmed+possible': stats(found), truncatedRuns: truncated, rideNotifications: notes,
    'nearby (limit 10) ms': stats(nb),
  };
  assert.ok(notes <= 30 * 10, 'at most K = 10 driver notifications per request');
  assert.ok(stats(geoWall).p95 < 2000, 'ride matchIntent p95 under 2 s');

  // comparison: the same kind of request without any distance condition → classic PROBE over root-keyed scopes
  const classic: { ms: number; candidates: number; truncated: boolean }[] = [];
  for (let i = 0; i < 3; i++) {
    const at = destination({ lat: azaz.lat!, lng: azaz.lng! }, i, i * 90);
    const spec = riderSpec(at);
    const r = await withTx(db.pool, (tx) => createIntent(tx, reg, { userId: users[i]!, realm: 'synthetic', spec, titleAr: 'بدي تكسي (بلا مسافة)', sourceText: null, conversationId: null }));
    const t = performance.now();
    const run = await matchIntent(db.pool, reg, { verticalId: r.verticalId, intentId: r.id, trigger: 'interactive' });
    classic.push({ ms: performance.now() - t, candidates: run.totals.candidates, truncated: run.truncated });
    assert.ok(run.directions.includes('probe'));
  }
  results.matchIntentClassic = { 'wall ms': stats(classic.map((x) => x.ms)), candidates: stats(classic.map((x) => x.candidates)), truncated: classic.every((x) => x.truncated) };
});
