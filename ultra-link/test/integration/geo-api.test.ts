// Live / nearby HTTP API (src/server/routes/geo.ts) through buildApp + the real conversation: owner-only, provide/join
// only, ≥ 10 s between pings (429 + Retry-After), stop sharing, nearest-first with rounded distances and connection
// labels — and PRIVACY: no response a counterpart can see ever contains another user's coordinates.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, Client, type Harness } from './server-helpers.ts';
import geoRoutes from '../../src/server/routes/geo.ts';
import { withTx } from '../../src/db/pool.ts';
import { createIntent } from '../../src/repo/intents.ts';
import { destination, type LatLng } from '../../src/geo/distance.ts';
import type { IntentSpec } from '../../src/domain/types.ts';

let h: Harness;
const RIDER_AT: LatLng = { lat: 36.5905, lng: 37.0511 }; // إعزاز
before(async () => { h = await harness(`geo_api_${process.pid}`, { routes: [geoRoutes], featureRoutes: false }); });
after(async () => { await h?.close(); });

/** every coordinate a counterpart must never see, as text with 4+ decimals (how JSON would print them) */
const secrets: string[] = [];
const remember = (p: LatLng) => { for (const v of [p.lat, p.lng]) secrets.push(String(v).slice(0, String(Math.trunc(v)).length + 5)); };
function assertNoCoordinates(label: string, body: unknown) {
  const json = JSON.stringify(body);
  assert.ok(!/"(lat|lng|latitude|longitude|geo|geo_lat|geo_lng|accuracyM)"\s*:/.test(json), `${label}: coordinate field in ${json.slice(0, 400)}`);
  for (const s of secrets) assert.ok(!json.includes(s), `${label}: leaked ${s}`);
}

async function driverOffer(c: Client, userId: string, at: LatLng, title: string) {
  const reg = h.db.reg;
  const spec: IntentSpec = { side: 'provide', categoryCode: 'transport.ride', deal: 'service', price: null, when: null, attrs: {}, constraints: [],
    place: { pointPlaceId: reg.placeByCode.get('sy.aleppo.azaz')!.id, scopePlaceIds: [], scopeStrength: 'required', geo: { ...at, accuracyM: 10, source: 'gps' } } };
  remember(at);
  return withTx(h.db.pool, (tx) => createIntent(tx, reg, { userId, realm: 'real', spec, titleAr: title, sourceText: null, conversationId: null }));
}

test('ride flow over HTTP: live sharing rules, nearest-first nearby, and no coordinates in anything the other side sees', async () => {
  const rider = new Client(h);
  await rider.register('راكب');
  const d1 = new Client(h); const u1 = await d1.register('سائق قريب');
  const d2 = new Client(h); const u2 = await d2.register('سائق أبعد');
  const d3 = new Client(h); const u3 = await d3.register('سائق بعيد جدًا');
  const stranger = new Client(h); await stranger.register('غريب');
  remember(RIDER_AT);

  const near = await driverOffer(d1, u1.id, destination(RIDER_AT, 6, 90), 'تكسي أبو أحمد'); // static far-ish; will go live close
  const mid = await driverOffer(d2, u2.id, destination(RIDER_AT, 3.2, 200), 'تكسي الحارة');
  const far = await driverOffer(d3, u3.id, destination(RIDER_AT, 12, 10), 'تكسي بعيد'); // beyond the 10 km default, inside the search box → evaluated and excluded

  // ── live sharing: owner only, provide/join only, throttled, no version bump
  const liveFix = destination(RIDER_AT, 0.7, 45);
  remember(liveFix);
  const body = { lat: liveFix.lat, lng: liveFix.lng, accuracyM: 12, heading: 180, speedKmh: 20 };
  assert.equal((await stranger.post(`/api/intents/${near.publicId}/live`, body)).status, 404, 'not the owner → 404');
  const ok = await d1.post(`/api/intents/${near.publicId}/live`, body);
  assert.equal(ok.status, 200, ok.raw);
  assert.deepEqual(Object.keys(ok.body.live).sort(), ['expiresAt', 'fresh', 'labelAr', 'minIntervalSec', 'sharing', 'startedAt', 'ttlSec', 'updatedAt']);
  assertNoCoordinates('live ack', ok.body);
  const tooSoon = await d1.post(`/api/intents/${near.publicId}/live`, body);
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.body.error, 'rate_limited');
  assert.ok(Number(tooSoon.headers['retry-after']) >= 1 && Number(tooSoon.headers['retry-after']) <= 10);
  await h.db.pool.query("UPDATE live_positions SET started_at = started_at - interval '11 seconds', updated_at = updated_at - interval '11 seconds'");
  assert.equal((await d1.post(`/api/intents/${near.publicId}/live`, body)).status, 200, 'accepted again after 10 s');
  assert.equal((await d1.post(`/api/intents/${near.publicId}/live`, { ...body, accuracyM: 4000 })).status, 422, 'a 4 km fix is refused');
  assert.equal((await d1.post(`/api/intents/${near.publicId}/live`, { lat: 95, lng: 0, accuracyM: 5 })).status, 400);
  assert.equal((await d1.post(`/api/intents/${near.publicId}/live`, { lat: '36.5', lng: 37, accuracyM: 5 })).status, 400);
  assert.equal((await d1.get(`/api/intents/${near.publicId}`)).body.intent.version, 1, 'no version bump per ping');
  const offers = await d1.get('/api/intents?side=offers');
  const card = offers.body.items.find((i: { id: string }) => i.id === near.publicId);
  assert.deepEqual(card.live, { sharing: true, fresh: true, labelAr: 'متصل الآن' });
  assert.equal(card.placeAr, 'قرب إعزاز');

  // ── the rider's request through the real conversation ("بدي تكسي قريب مني" + «استخدم موقعي الحالي»)
  const conv = await rider.newConversation();
  const q = await rider.say(conv, 'بدي تكسي قريب مني');
  assert.equal(q.body.question?.field, 'geo');
  const saved = await rider.post(`/api/conversations/${conv}/turns`, { text: 'موقعي الحالي', modality: 'text', clientTurnId: randomUUID(), geo: { ...RIDER_AT, accuracyM: 15 } });
  assert.equal(saved.body.action, 'saved', saved.raw);
  const reqId: string = saved.body.intent.id;
  assert.equal(saved.body.intent.placeAr, 'قرب إعزاز');
  // a request cannot share a live position
  const seekLive = await rider.post(`/api/intents/${reqId}/live`, body);
  assert.equal(seekLive.status, 422);
  assert.equal(seekLive.body.error, 'live_not_allowed');

  const run = await rider.post(`/api/intents/${reqId}/match`);
  assert.equal(run.status, 200, run.raw);
  assert.equal(run.body.totals.confirmed + run.body.totals.possible, 2, JSON.stringify(run.body.totals));
  assert.ok(run.body.exclusions.some((e: { code: string }) => e.code === 'distance_beyond_radius'));
  const top = run.body.page.items[0];
  assert.equal(top.other.titleAr, 'تكسي أبو أحمد', 'the connected driver 0.7 km away ranks first');
  assert.ok(top.reasons.some((r: { code: string; text: string }) => r.code === 'distance' && r.text === 'على بعد أقل من 1 كم'));
  assert.ok(top.reasons.some((r: { code: string }) => r.code === 'live_now'));
  assertNoCoordinates('match run (rider)', run.body);

  const nearby = await rider.get(`/api/intents/${reqId}/nearby?limit=5`);
  assert.equal(nearby.status, 200, nearby.raw);
  assert.deepEqual(nearby.body.items.map((i: { intent: { titleAr: string } }) => i.intent.titleAr), ['تكسي أبو أحمد', 'تكسي الحارة']);
  assert.equal(nearby.body.items[0].freshnessAr, 'متصل الآن');
  assert.deepEqual(nearby.body.items[0].distance, { ar: 'أقل من 1 كم', km: null, lt1: true, approximate: false });
  assert.equal(nearby.body.items[1].distance.ar, '≈ 3 كم');
  assert.equal(nearby.body.items[1].freshnessAr, 'موقع ثابت');
  assert.ok(nearby.body.items.every((i: { matchId: string | null }) => typeof i.matchId === 'string'), 'stored matches are linked for the contact flow');
  assert.equal(nearby.body.limitAr, 'الأقرب أولًا (حتى 10 كم)');
  assertNoCoordinates('nearby (rider)', nearby.body);
  assert.equal((await stranger.get(`/api/intents/${reqId}/nearby`)).status, 404, 'nearby is owner-only');

  // ── drivers' side: notifications, match lists, their own nearby — never the rider's coordinates
  for (const [c, label] of [[d1, 'd1'], [d2, 'd2'], [d3, 'd3']] as const) {
    for (const url of ['/api/matches?state=all', '/api/notifications', '/api/intents?side=offers', '/api/me']) {
      const r = await c.get(url);
      assert.equal(r.status, 200, `${label} ${url}`);
      assertNoCoordinates(`${label} ${url}`, r.body);
    }
  }
  const notes = (await d1.get('/api/notifications')).body.items;
  assert.ok(notes.some((n: { kind: string; titleAr: string }) => n.kind === 'ride_nearby' && n.titleAr === 'طلب توصيلة قريب منك'), JSON.stringify(notes));
  assert.equal((await d3.get('/api/notifications')).body.items.length, 0, 'the driver 12 km away is not notified');
  const theirNearby = await d2.get(`/api/intents/${mid.publicId}/nearby`);
  assert.equal(theirNearby.status, 200);
  assert.equal(theirNearby.body.items[0].intent.id, reqId, 'a driver sees the waiting rider nearby');
  assertNoCoordinates('nearby (driver)', theirNearby.body);
  const matchId = (await d2.get('/api/matches')).body.items[0].id;
  assertNoCoordinates('match detail (driver)', (await d2.get(`/api/matches/${matchId}`)).body);

  // ── stop sharing (DELETE and the POST alias)
  const stop = await d1.call('DELETE', `/api/intents/${near.publicId}/live`, {});
  assert.deepEqual(stop.body, { ok: true, stopped: true });
  assert.deepEqual((await d1.post(`/api/intents/${near.publicId}/live/stop`)).body, { ok: true, stopped: false });
  assert.equal((await d1.get('/api/intents?side=offers')).body.items.find((i: { id: string }) => i.id === near.publicId).live, null);
  // without the live position the static point (6 km) applies: nearest is now the 3.2 km driver
  const after = await rider.get(`/api/intents/${reqId}/nearby`);
  assert.deepEqual(after.body.items.map((i: { intent: { titleAr: string } }) => i.intent.titleAr), ['تكسي الحارة', 'تكسي أبو أحمد']);
  void far;
});

test('nearby needs a location; a paused intent cannot share or list nearby', async () => {
  const c = new Client(h);
  const u = await c.register('بلا موقع');
  const reg = h.db.reg;
  const noPoint = await withTx(h.db.pool, (tx) => createIntent(tx, reg, { userId: u.id, realm: 'real', titleAr: 'سباك', sourceText: null, conversationId: null,
    spec: { side: 'seek', categoryCode: 'services.plumbing', deal: 'service', place: { pointPlaceId: null, scopePlaceIds: [], scopeStrength: 'required', nearest: true }, price: null, when: null, attrs: {}, constraints: [] } }));
  const r = await c.get(`/api/intents/${noPoint.publicId}/nearby`);
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'no_location');
  const offer = await withTx(h.db.pool, (tx) => createIntent(tx, reg, { userId: u.id, realm: 'real', titleAr: 'تكسي', sourceText: null, conversationId: null,
    spec: { side: 'provide', categoryCode: 'transport.ride', deal: 'service', place: { pointPlaceId: reg.placeByCode.get('sy.aleppo.afrin')!.id, scopePlaceIds: [], scopeStrength: 'required' }, price: null, when: null, attrs: {}, constraints: [] } }));
  assert.equal((await c.post(`/api/intents/${offer.publicId}/status`, { action: 'pause' })).status, 200);
  const paused = await c.post(`/api/intents/${offer.publicId}/live`, { lat: 36.5, lng: 36.87, accuracyM: 10 });
  assert.equal(paused.status, 409);
  assert.equal(paused.body.error, 'inactive');
  assert.equal((await c.get(`/api/intents/${offer.publicId}/nearby`)).status, 409);
  assert.equal((await c.get(`/api/intents/not-a-uuid/nearby`)).status, 400);
  assert.equal((await new Client(h).get(`/api/intents/${offer.publicId}/nearby`)).status, 401);
});
