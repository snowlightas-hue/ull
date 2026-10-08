// GEO retrieval on an isolated database: KNN equals brute force over ~500 random points (filters, radius, order);
// distance-bounded retrieval never misses a counterpart the evaluator accepts (brute force over random geo / place /
// live / unknown intents); live positions expire; persistence round trip and CHECKs; pause stops sharing; a ride
// request notifies only the K nearest connected drivers, once.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { withTx } from '../../src/db/pool.ts';
import type { GeoPoint, IntentSpec, Strength } from '../../src/domain/types.ts';
import { createIntent, intentToSpec, loadIntent, rowToMatchable, setIntentStatus, toCard, updateIntent } from '../../src/repo/intents.ts';
import { matchIntent, retrieveCandidates } from '../../src/matching/engine.ts';
import { evaluatePair } from '../../src/matching/evaluate.ts';
import { destination, haversineKm, type LatLng } from '../../src/geo/distance.ts';
import { knnIntents, knnLive, type GeoKeys } from '../../src/geo/retrieve.ts';
import { purgeStaleLive, stopLive, upsertLivePosition } from '../../src/geo/live.ts';
import { geoPlan } from '../../src/geo/retrieve.ts';

let db: TestDb;
const TAG = `geo_ret_${process.pid}`;
const AZAZ: LatLng = { lat: 36.5866, lng: 37.0463 };
const P = (code: string) => db.reg.placeByCode.get(code)!.id;
function rnd(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gps = (p: LatLng, accuracyM = 10): GeoPoint => ({ lat: p.lat, lng: p.lng, accuracyM, source: 'gps' });
function ride(side: 'seek' | 'provide', place: Partial<IntentSpec['place']>, categoryCode = 'transport.ride'): IntentSpec {
  return { side, categoryCode, deal: 'service', place: { pointPlaceId: P('sy.aleppo.azaz'), scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [], ...place }, price: null, when: null, attrs: {}, constraints: [] };
}
async function mk(userId: string, spec: IntentSpec, realm: 'synthetic' | 'real' = 'synthetic') {
  return withTx(db.pool, (tx) => createIntent(tx, db.reg, { userId, realm, spec, titleAr: 'توصيلة', sourceText: null, conversationId: null }));
}
/** a live row whose last update was `agoMs` ago (bypasses the 10 s throttle: test fixture) */
async function liveAt(v: number, id: string, p: LatLng, agoMs: number, accuracyM = 10) {
  await db.pool.query(
    `INSERT INTO live_positions (vertical_id, intent_id, user_id, realm, side, deal_type_id, category_id, lat, lng, accuracy_m, started_at, updated_at, expires_at)
     SELECT vertical_id, id, user_id, realm, side, deal_type_id, category_id, $3, $4, $5, t, t, t + interval '10 minutes'
       FROM intents, LATERAL (SELECT now() - make_interval(secs => $6::double precision / 1000) AS t) x WHERE vertical_id = $1 AND id = $2
     ON CONFLICT (vertical_id, intent_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy_m = EXCLUDED.accuracy_m,
       started_at = EXCLUDED.started_at, updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at`,
    [v, id, p.lat, p.lng, accuracyM, agoMs],
  );
}

before(async () => { db = await freshDb(TAG); });
after(async () => {
  await db?.close();
  const { default: pg } = await import('pg');
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`); } finally { await a.end(); }
});

test('KNN on stored points equals brute force over ~500 random points (filters, radius, nearest-first order)', async () => {
  const r = rnd(500);
  const users = await Promise.all(Array.from({ length: 12 }, (_, i) => mkUser(db.pool, `k${i}`)));
  const me = await mkUser(db.pool, 'knn-me');
  const pts: { id: string; p: LatLng; ok: boolean }[] = [];
  for (let i = 0; i < 520; i++) {
    const p = destination(AZAZ, Math.sqrt(r()) * 40, r() * 360);
    const roll = r();
    // noise that must never come back: seekers, another category, my own, paused
    const kind = roll < 0.06 ? 'seek' : roll < 0.12 ? 'delivery' : roll < 0.16 ? 'mine' : roll < 0.2 ? 'paused' : 'ok';
    const spec = ride(kind === 'seek' ? 'seek' : 'provide', { geo: gps(p) }, kind === 'delivery' ? 'transport.delivery' : 'transport.ride');
    const c = await mk(kind === 'mine' ? me : users[i % users.length]!, spec);
    if (kind === 'paused') await setIntentStatus(db.pool, db.reg, c.verticalId, c.id, null, 'pause');
    pts.push({ id: c.id, p, ok: kind === 'ok' });
  }
  const cat = db.reg.categoryByCode.get('transport.ride')!;
  const keys: GeoKeys = { verticalId: 8, realm: 'synthetic', side: 'provide', dealTypeId: db.reg.dealByCode.get('service')!.id, categoryIds: [...new Set([...cat.ancestors, ...cat.descendants])], notUserId: me };
  let compared = 0;
  for (let q = 0; q < 40; q++) {
    const center = destination(AZAZ, r() * 30, r() * 360);
    const R = [0.5, 1, 2, 5, 10, 20, 35][q % 7]!;
    const got = new Set(await knnIntents(db.pool, keys, center, R, 10_000));
    for (const x of pts) {
      const d = haversineKm(center, x.p);
      if (!x.ok) { assert.ok(!got.has(x.id), `filtered row ${x.id} returned`); continue; }
      if (d <= R) { assert.ok(got.has(x.id), `missed ${x.id} at ${d} km (R ${R})`); compared++; }
      // the SQL box is a superset by design (cube corners + 0.3 % slack); never far beyond the radius
      if (got.has(x.id)) assert.ok(d <= R * 1.75 + 0.1, `returned ${x.id} at ${d} km for R ${R}`);
    }
    // nearest-first: the K nearest by brute force, in order
    const k = 10;
    const top = await knnIntents(db.pool, keys, center, 1000, k);
    const want = pts.filter((x) => x.ok).map((x) => ({ id: x.id, d: haversineKm(center, x.p) })).sort((a, b) => a.d - b.d).slice(0, k).map((x) => x.id);
    assert.deepEqual(top, want, `nearest ${k} around query ${q}`);
  }
  assert.ok(compared > 1000, `compared ${compared}`);
  // the plan uses the GiST index (KNN ordering) — never a scan of the partition
  const c = await db.pool.connect();
  try {
    await c.query('SET enable_seqscan = off');
    const plan = (await c.query(`EXPLAIN (COSTS OFF) SELECT id FROM intents WHERE vertical_id = 8 AND realm = 'synthetic' AND side = 'provide' AND deal_type_id = 3
        AND category_id = ANY('{801,800}') AND status = 'active' AND user_id <> 0 AND geo_lat IS NOT NULL
        AND earth_box(ll_to_earth(36.58, 37.04), 5000) @> ll_to_earth(geo_lat, geo_lng)
        ORDER BY ll_to_earth(geo_lat, geo_lng) <-> ll_to_earth(36.58, 37.04) LIMIT 10`)).rows.map((x) => x['QUERY PLAN']).join('\n');
    assert.match(plan, /Index Scan using intents_transport_ll_to_earth_idx on intents_transport/, plan);
    assert.match(plan, /Order By: \(\(ll_to_earth/, plan);
  } finally { c.release(); }
});

test('distance-bounded retrieval never misses a counterpart the evaluator accepts (brute force, mixed geo / place / live / unknown)', async () => {
  const r = rnd(4243);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const users = await Promise.all(Array.from({ length: 20 }, (_, i) => mkUser(db.pool, `b${i}`)));
  const places = ['sy.aleppo.azaz', 'sy.aleppo.afrin', 'sy.aleppo.marea', 'sy.aleppo.tal_rifaat', 'tr.kilis', 'sy.aleppo.aleppo', 'sy.aleppo', 'sy.homs'].map(P);
  const made: { v: number; id: string }[] = [];
  const cats = ['services.plumbing', 'services.electrical'];
  for (let i = 0; i < 360; i++) {
    const side = r() < 0.4 ? 'seek' : 'provide';
    const p = destination(AZAZ, Math.sqrt(r()) * 45, r() * 360);
    const geoRoll = r();
    const geo: GeoPoint | null = geoRoll < 0.5 ? gps(p, pick([5, 60, 900, 2600, 7000])) : geoRoll < 0.55 ? { lat: p.lat, lng: p.lng, source: 'place' } : null;
    const point = r() < 0.88 ? pick(places) : null;
    const radius = r() < 0.4 ? { value: pick([1, 3, 5, 10, 20]), strength: (r() < 0.7 ? 'required' : 'preferred') as Strength } : null;
    const spec: IntentSpec = {
      side, categoryCode: pick(cats), deal: 'service',
      place: { pointPlaceId: point, scopePlaceIds: side === 'seek' && point === null && r() < 0.5 ? [pick(places)] : [], scopeStrength: 'required', excludePlaceIds: [], geo, radiusKm: radius, nearest: r() < 0.3 },
      price: null, when: null, attrs: {}, constraints: [],
    };
    const c = await mk(pick(users), spec);
    made.push({ v: c.verticalId, id: c.id });
    if (side === 'provide' && r() < 0.35) await liveAt(c.verticalId, c.id, destination(AZAZ, Math.sqrt(r()) * 40, r() * 360), pick([0, 120_000, 540_000, 900_000, 7_200_000]), pick([10, 1500, 2900]));
  }
  for (const x of made.slice(0, 10)) await setIntentStatus(db.pool, db.reg, x.v, x.id, null, 'pause');
  const rows = await Promise.all(made.map((x) => loadIntent(db.pool, x.v, x.id)));
  const all = rows.map((row) => ({ row: row!, m: rowToMatchable(db.reg, row!) }));
  const now = new Date();
  let bounded = 0;
  let expected = 0;
  const misses: string[] = [];
  for (const me of all) {
    if (me.m.status !== 'active' || !geoPlan(db.reg, me.m, now)) continue;
    bounded++;
    const got = await retrieveCandidates(db.pool, db.reg, me.row, me.m, now);
    assert.ok(got.directions.includes('geo'), String(got.directions));
    assert.equal(got.truncated, false);
    for (const o of all) {
      if (o.m.id === me.m.id) continue;
      const v = evaluatePair(db.reg, me.m, o.m, { now });
      if (v.verdict === 'excluded') continue;
      expected++;
      if (!got.ids.has(o.m.id)) misses.push(`${me.m.id} missed ${o.m.id} (${v.verdict}: ${v.reasons.map((x) => x.code).join(',')})`);
    }
  }
  assert.deepEqual(misses.slice(0, 5), []);
  assert.ok(bounded > 60 && expected > 300, `bounded ${bounded}, expected pairs ${expected}`);
});

test('live positions: throttled upsert without a version bump, expiry, stop, purge, and pause ends sharing', async () => {
  const owner = await mkUser(db.pool, 'driver-live');
  const other = await mkUser(db.pool, 'rider-live');
  const d = await mk(owner, ride('provide', { geo: gps(AZAZ) }));
  const s = await mk(other, ride('seek', { geo: gps(AZAZ), nearest: true }));
  const ref = { verticalId: d.verticalId, id: d.id };
  const fix = { ...destination(AZAZ, 0.8, 30), accuracyM: 8, heading: 90, speedKmh: 30 };
  assert.equal((await upsertLivePosition(db.pool, ref, other, fix)).ok, false, 'not the owner');
  assert.deepEqual(await upsertLivePosition(db.pool, { verticalId: s.verticalId, id: s.id }, other, fix), { ok: false, reason: 'side_not_allowed' });
  assert.deepEqual(await upsertLivePosition(db.pool, ref, owner, { ...fix, accuracyM: 5000 }), { ok: false, reason: 'inaccurate' });
  const first = await upsertLivePosition(db.pool, ref, owner, fix);
  assert.equal(first.ok, true);
  const again = await upsertLivePosition(db.pool, ref, owner, fix);
  assert.equal(again.ok, false);
  assert.ok(!again.ok && again.reason === 'too_soon' && again.retryAfterMs! > 0 && again.retryAfterMs! <= 10_000);
  await db.pool.query("UPDATE live_positions SET started_at = started_at - interval '11 seconds', updated_at = updated_at - interval '11 seconds' WHERE intent_id = $1", [d.id]);
  assert.equal((await upsertLivePosition(db.pool, ref, owner, fix)).ok, true, 'accepted after 10 s');
  const row = await loadIntent(db.pool, d.verticalId, d.id);
  assert.equal(row!.version, 1, 'pings never bump the version');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM match_runs WHERE intent_id = $1', [d.id])).rows[0].n, 0, 'no re-match per ping');
  const card = toCard(db.reg, row!);
  assert.deepEqual(card.live, { sharing: true, fresh: true, labelAr: 'متصل الآن' });
  // fresh → found by the live KNN; stale (> 10 min + 1 min grace) → not
  const cat = db.reg.categoryByCode.get('transport.ride')!;
  const keys: GeoKeys = { verticalId: 8, realm: 'synthetic', side: 'provide', dealTypeId: db.reg.dealByCode.get('service')!.id, categoryIds: [cat.id, cat.ancestors.at(-1)!], notUserId: other };
  assert.ok((await knnLive(db.pool, keys, AZAZ, 2, 10)).includes(d.id));
  await liveAt(d.verticalId, d.id, fix, 12 * 60_000);
  assert.ok(!(await knnLive(db.pool, keys, AZAZ, 2, 10)).includes(d.id), 'stale positions are not retrieved');
  const stale = rowToMatchable(db.reg, (await loadIntent(db.pool, d.verticalId, d.id))!);
  const v = evaluatePair(db.reg, rowToMatchable(db.reg, (await loadIntent(db.pool, s.verticalId, s.id))!), stale);
  assert.equal(v.verdict, 'possible');
  assert.ok(v.reasons.some((x) => x.code === 'live_stale' && x.text.startsWith('غير متصل منذ 12 د')), JSON.stringify(v.reasons));
  assert.equal(toCard(db.reg, (await loadIntent(db.pool, d.verticalId, d.id))!).live!.fresh, false);
  // purge only touches long-dead rows
  assert.equal(await purgeStaleLive(db.pool), 0);
  await liveAt(d.verticalId, d.id, fix, 30 * 3600_000);
  assert.equal(await purgeStaleLive(db.pool), 1);
  // stop / pause
  assert.equal((await upsertLivePosition(db.pool, ref, owner, fix)).ok, true);
  assert.equal(await stopLive(db.pool, ref, other), false, 'only the owner stops');
  assert.equal(await stopLive(db.pool, ref, owner), true);
  assert.equal((await upsertLivePosition(db.pool, ref, owner, fix)).ok, true);
  await setIntentStatus(db.pool, db.reg, d.verticalId, d.id, owner, 'pause');
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM live_positions WHERE intent_id = $1', [d.id])).rows[0].n, 0, 'pause ends sharing');
  assert.deepEqual(await upsertLivePosition(db.pool, ref, owner, fix), { ok: false, reason: 'inactive' });
});

test('persistence: geo / radius / nearest round-trip, edits, CHECKs, and cards never carry coordinates', async () => {
  const u = await mkUser(db.pool, 'persist');
  const p = destination(AZAZ, 1.234, 77);
  const spec = ride('seek', { geo: { ...gps(p, 12.6), at: '2026-10-08T10:00:00.000Z' }, radiusKm: { value: 5, strength: 'required' }, nearest: true });
  const c = await mk(u, spec);
  const row = (await loadIntent(db.pool, c.verticalId, c.id))!;
  const back = intentToSpec(db.reg, row);
  assert.deepEqual(back.place.geo, { lat: p.lat, lng: p.lng, source: 'gps', accuracyM: 13, at: '2026-10-08T10:00:00.000Z' });
  assert.deepEqual(back.place.radiusKm, { value: 5, strength: 'required' });
  assert.equal(back.place.nearest, true);
  const card = toCard(db.reg, row);
  assert.equal(card.placeAr, 'قرب إعزاز');
  assert.ok(card.chips.some((x) => x.labelAr === 'المسافة' && x.valueAr === 'ضمن 5 كم' && x.strength === 'required'));
  const json = JSON.stringify(card);
  assert.ok(!/"lat"|"lng"|geo_/.test(json) && !json.includes(String(p.lat).slice(0, 7)) && !json.includes(String(p.lng).slice(0, 7)), json);
  // edit: drop the radius, keep the point
  const v2 = await withTx(db.pool, (tx) => updateIntent(tx, db.reg, c.verticalId, c.id, u, 1, { ...back, place: { ...back.place, radiusKm: null, nearest: false } }, 'x'));
  assert.ok(v2.ok);
  const after2 = rowToMatchable(db.reg, (await loadIntent(db.pool, c.verticalId, c.id))!);
  assert.deepEqual([after2.radiusKm, after2.nearest, after2.geo?.lat], [null, false, p.lat]);
  // CHECKs
  const bad = async (sql: string, constraint: string) => assert.rejects(db.pool.query(sql, [c.verticalId, c.id]), (e: { constraint?: string }) => e.constraint === constraint);
  await bad('UPDATE intents SET geo_lat = 91 WHERE vertical_id = $1 AND id = $2', 'intents_geo_chk');
  await bad('UPDATE intents SET geo_lng = NULL WHERE vertical_id = $1 AND id = $2', 'intents_geo_chk');
  await bad('UPDATE intents SET geo_source = NULL WHERE vertical_id = $1 AND id = $2', 'intents_geo_chk');
  await bad("UPDATE intents SET geo_source = 'wifi' WHERE vertical_id = $1 AND id = $2", 'intents_geo_chk');
  await bad('UPDATE intents SET radius_km = 3 WHERE vertical_id = $1 AND id = $2', 'intents_radius_chk');
  await bad("UPDATE intents SET radius_km = 0, radius_strength = 'required' WHERE vertical_id = $1 AND id = $2", 'intents_radius_chk');
  await bad("UPDATE intents SET radius_km = 501, radius_strength = 'required' WHERE vertical_id = $1 AND id = $2", 'intents_radius_chk');
  // ride intents live in their own partition
  assert.equal((await db.pool.query('SELECT tableoid::regclass::text AS t FROM intents WHERE vertical_id = $1 AND id = $2', [c.verticalId, c.id])).rows[0].t, 'intents_transport');
});

test('a ride request notifies only the K = 10 nearest CONNECTED drivers, once; the rider sees every acceptable driver', async () => {
  const rider = await mkUser(db.pool, 'rider-k');
  const center = { lat: 35.9306, lng: 36.6339 }; // إدلب: ~100 km from the other tests' points (shared database)
  const drivers: { id: string; user: string; km: number; live: boolean }[] = [];
  for (let i = 0; i < 24; i++) {
    const user = await mkUser(db.pool, `drv${i}`);
    const km = 0.4 + i * 0.35; // 0.4 … 8.45 km, all inside the 10 km default
    const p = destination(center, km, i * 37);
    const live = i % 3 !== 1; // two thirds connected
    const c = await mk(user, ride('provide', { geo: gps(p) }));
    if (live) await liveAt(c.verticalId, c.id, p, 30_000);
    drivers.push({ id: c.id, user, km, live });
  }
  const far = await mkUser(db.pool, 'drv-far');
  const farC = await mk(far, ride('provide', { geo: gps(destination(center, 14, 90)) }));
  await liveAt(farC.verticalId, farC.id, destination(center, 14, 90), 1000);
  const req = await mk(rider, ride('seek', { geo: gps(center), nearest: true }));
  const run = await matchIntent(db.pool, db.reg, { verticalId: req.verticalId, intentId: req.id, trigger: 'interactive' });
  assert.ok(run.directions.includes('geo') && run.directions.includes('live'), String(run.directions));
  assert.equal(run.totals.confirmed + run.totals.possible, 24, JSON.stringify(run));
  assert.ok(run.exclusions.some((e) => e.code === 'distance_beyond_radius' && e.textAr === 'أبعد من المسافة المحددة'));
  const notified = (await db.pool.query(`SELECT recipient_id::text AS u, kind, body_ar FROM notifications WHERE kind = 'ride_nearby' ORDER BY id`)).rows;
  const want = drivers.filter((d) => d.live).sort((a, b) => a.km - b.km).slice(0, 10).map((d) => d.user).sort();
  assert.deepEqual(notified.map((n) => n.u).sort(), want);
  assert.ok(notified.every((n) => /على بعد (≈ \d+(\.5)? كم|أقل من 1 كم)/.test(n.body_ar)), JSON.stringify(notified[0]));
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM notifications WHERE recipient_id = $1', [rider])).rows[0].n, 0, 'the interactive viewer is not notified');
  // repeated / job-triggered runs never notify again
  await matchIntent(db.pool, db.reg, { verticalId: req.verticalId, intentId: req.id, trigger: 'job' });
  await matchIntent(db.pool, db.reg, { verticalId: req.verticalId, intentId: req.id, trigger: 'job' });
  assert.equal((await db.pool.query(`SELECT count(*)::int n FROM notifications WHERE kind = 'ride_nearby'`)).rows[0].n, 10);
  // stored match rows: ranked by distance (nearest first among confirmed), reasons carry rounded distances only
  const ms = (await db.pool.query('SELECT b_intent_id::text AS b, score, reasons FROM matches WHERE a_intent_id = $1 AND state = $2 ORDER BY score DESC', [req.id, 'confirmed'])).rows;
  const kmOf = new Map(drivers.map((d) => [d.id, d.km] as const));
  const liveConfirmed = ms.filter((m) => drivers.find((d) => d.id === m.b)!.live).map((m) => kmOf.get(m.b)!);
  assert.deepEqual(liveConfirmed, [...liveConfirmed].sort((a, b) => a - b), 'connected drivers ordered nearest first');
  for (const m of ms) for (const x of m.reasons) assert.ok(!/\d+\.\d{2,}/.test(x.text), x.text);
});
