// HTTP API contract, end to end through buildApp() + inject on an isolated database:
// 401, CSRF (415/403), isolation (404 for everything that is not yours), idempotent and concurrent turns,
// draft persistence, pagination totals beyond 100 rows, recipient-only notifications, synthetic-only
// simulation, optimistic PATCH (409), no duplicate notifications.
import './server-env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, electricianSpec, harness, mkPersona, seedIntents, type Harness } from './server-helpers.ts';
import { resolveIntentRef } from '../../src/repo/intents.ts';
import { runJob } from '../../src/worker/main.ts';

let h: Harness;
let A: Client; let B: Client; let C: Client;
let aId: string; let bId: string; let cId: string;
/** A's saved request (seek electrician in al-Bab), C's matching offer, the match between them */
let aIntent: string; let cOffer: string; let matchId: string;

before(async () => {
  h = await harness('api', { rateLimits: { turns: null, auth: null, simulate: null } });
  A = new Client(h); B = new Client(h); C = new Client(h);
  aId = (await A.register('أحمد اختبار')).id;
  bId = (await B.register('بشرى اختبار')).id;
  cId = (await C.register('كمال كهربجي')).id;
  [cOffer] = await seedIntents(h, cId, 'real', 1, { spec: electricianSpec(h, 'provide') }) as [string];
  const saved = await A.dialogue('بدي كهربجي', 'الباب');
  assert.equal(saved.action, 'saved', JSON.stringify(saved));
  aIntent = saved.intent.id;
  const run = await A.post(`/api/intents/${aIntent}/match`);
  assert.equal(run.status, 200, run.raw);
  const m = run.body.page.items.find((x: any) => x.other.id === cOffer);
  assert.ok(m, 'A sees C\'s offer as a match');
  matchId = m.id;
});
after(async () => { await h?.close(); });

test('401: every private route refuses anonymous callers with {error, messageAr}', async () => {
  const anon = new Client(h);
  const id = randomUUID();
  const routes: [string, string][] = [
    ['GET', '/api/me'], ['GET', '/api/intents'], ['GET', `/api/intents/${id}`], ['GET', '/api/matches'], ['GET', `/api/matches/${id}`],
    ['GET', '/api/notifications'], ['GET', '/api/conversations/current'], ['GET', '/api/events'],
    ['POST', '/api/conversations'], ['POST', `/api/conversations/${id}/turns`], ['POST', `/api/intents/${id}/match`],
    ['PATCH', `/api/intents/${id}`], ['POST', `/api/notifications/${id}/read`], ['POST', '/api/notifications/read-all'],
    ['POST', `/api/matches/${id}/contact`], ['POST', `/api/contact-requests/${id}/respond`], ['POST', '/api/demo/simulate'],
  ];
  for (const [method, url] of routes) {
    const r = await anon.call(method as 'GET', url, method === 'GET' ? undefined : {});
    assert.equal(r.status, 401, `${method} ${url} → ${r.status}`);
    assert.equal(r.body.error, 'unauthorized');
    assert.ok(r.body.messageAr);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  // a forged or expired cookie is anonymous too
  const forged = await anon.get('/api/me', { cookie: 'ul_session=' + 'x'.repeat(43) });
  assert.equal(forged.status, 401);
  // open routes
  for (const url of ['/api/health', '/api/ai/status', '/api/personas', '/api/taxonomy']) assert.equal((await anon.get(url)).status, 200, url);
  assert.deepEqual((await anon.get('/api/session')).body, { user: null });
  // logout clears the session server-side: the old cookie stops working
  const D = new Client(h); await D.register('مؤقت');
  const old = D.cookie;
  assert.equal((await D.post('/api/auth/logout')).status, 200);
  assert.equal((await D.get('/api/me', { cookie: old })).status, 401);
});

test('CSRF: mutations need JSON (415) from our own origin (403)', async () => {
  const conv = '/api/conversations';
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await A.post(conv, 'a=1', { 'content-type': ct });
    assert.equal(r.status, 415, ct);
    assert.equal(r.body.error, 'json_required');
  }
  const noCt = await A.app.inject({ method: 'POST', url: conv, headers: { cookie: A.cookie } });
  assert.equal(noCt.statusCode, 415);
  const crossOrigin: Record<string, string>[] = [
    { origin: 'http://evil.example' },
    { origin: 'null' },
    { origin: 'http://localhost:81' },
    { origin: 'https://localhost' },
    { referer: 'http://evil.example/page' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'http://localhost', 'sec-fetch-site': 'cross-site' },
    { origin: 'https://app.example', 'x-forwarded-host': 'app.example' }, // X-Forwarded-Host counts only behind a trusted proxy
  ];
  for (const headers of crossOrigin) {
    const r = await A.post(conv, {}, headers);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.equal(r.body.error, 'bad_origin');
  }
  // login CSRF is refused too, before any account is created
  const before = Number((await h.db.pool.query('SELECT count(*) FROM users')).rows[0].count);
  const reg = await new Client(h).post('/api/auth/register', { displayName: 'مهاجم' }, { origin: 'http://evil.example' });
  assert.equal(reg.status, 403);
  assert.equal(Number((await h.db.pool.query('SELECT count(*) FROM users')).rows[0].count), before);
  // same origin (Origin, Referer, Sec-Fetch-Site) passes; inject's Host is localhost:80
  assert.equal((await A.post(conv, {}, { origin: 'http://localhost' })).status, 200);
  assert.equal((await A.post(conv, {}, { origin: 'http://localhost:80' })).status, 200);
  assert.equal((await A.post(conv, {}, { referer: 'http://localhost/app' })).status, 200);
  assert.equal((await A.post(conv, {}, { 'sec-fetch-site': 'same-origin' })).status, 200);
  // GETs are never blocked by the guard
  assert.equal((await A.get('/api/me', { origin: 'http://evil.example' })).status, 200);
});

test('isolation: other users get 404 (never 403) for intents, matches, notifications, contact requests, conversations', async () => {
  // intents
  for (const [m, url, body] of [
    ['GET', `/api/intents/${aIntent}`, undefined], ['PATCH', `/api/intents/${aIntent}`, { expectedVersion: 1, changes: {} }],
    ['POST', `/api/intents/${aIntent}/status`, { action: 'pause' }], ['POST', `/api/intents/${aIntent}/match`, {}],
    ['GET', `/api/matches?intent=${aIntent}`, undefined],
  ] as const) {
    const r = await B.call(m, url, body);
    assert.equal(r.status, 404, `${m} ${url}`);
    assert.equal(r.body.error, 'not_found');
  }
  const own = await A.get(`/api/intents/${aIntent}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.intent.status, 'active', 'B could not pause it');
  // B's lists never contain A's or C's data
  assert.equal((await B.get('/api/intents?side=requests')).body.total, 0);
  assert.equal((await B.get('/api/matches?state=all')).body.total, 0);
  // matches: the two parties see it, a third party does not
  assert.equal((await C.get(`/api/matches/${matchId}`)).status, 200);
  assert.equal((await B.get(`/api/matches/${matchId}`)).status, 404);
  assert.equal((await B.post(`/api/matches/${matchId}/contact`, { messageAr: 'مرحبا' })).status, 404);
  // notifications: C was notified about the match; only C can read it
  const cNotes = (await C.get('/api/notifications')).body;
  const note = cNotes.items.find((n: any) => n.kind === 'match' || n.kind.startsWith('match'));
  assert.ok(note, `C has a match notification: ${JSON.stringify(cNotes.items.map((n: any) => n.kind))}`);
  for (const other of [A, B]) {
    const r = await other.post(`/api/notifications/${note.id}/read`);
    assert.equal(r.status, 404);
    assert.ok(!(await other.get('/api/notifications')).body.items.some((n: any) => n.id === note.id));
  }
  assert.equal((await B.post('/api/notifications/read-all')).body.updated, 0);
  const still = (await C.get('/api/notifications')).body.items.find((n: any) => n.id === note.id);
  assert.equal(still.readAt, null, 'nobody else marked it read');
  assert.equal((await C.post(`/api/notifications/${note.id}/read`)).status, 200);
  assert.ok((await C.get('/api/notifications')).body.items.find((n: any) => n.id === note.id).readAt);
  // contact requests: only the recipient may answer
  const cr = await A.post(`/api/matches/${matchId}/contact`, { messageAr: 'متى تقدر تجي؟' });
  assert.equal(cr.status, 200, cr.raw);
  const reqId = cr.body.contactRequest.id;
  for (const who of [A, B]) assert.equal((await who.post(`/api/contact-requests/${reqId}/respond`, { accept: true })).status, 404);
  const ok = await C.post(`/api/contact-requests/${reqId}/respond`, { accept: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.contactRequest.status, 'accepted');
  assert.equal((await C.post(`/api/contact-requests/${reqId}/respond`, { accept: false })).status, 404, 'answered once');
  // after acceptance the parties see each other; the third party still sees nothing
  const am = (await A.get(`/api/matches/${matchId}`)).body.match;
  assert.equal(am.contact.status, 'accepted');
  assert.equal(am.contact.counterpart.displayName, 'كمال كهربجي');
  // conversations
  const conv = await A.newConversation();
  assert.equal((await B.say(conv, 'بدي شقة')).status, 404);
  assert.equal((await B.post(`/api/conversations/${conv}/cancel`)).status, 404);
  assert.equal((await B.get('/api/conversations/current')).body.conversation, null);
  // malformed ids are 400 before touching SQL
  for (const url of ['/api/intents/123', '/api/intents/..%2F..', `/api/matches/${aIntent}x`]) assert.equal((await A.get(url)).status, 400, url);
});

test('idempotent turns: a retried clientTurnId returns the stored answer and is processed once', async () => {
  const conv = await A.newConversation();
  const t1 = randomUUID();
  const r1 = await A.say(conv, 'بدي شقة بإعزاز', t1);
  const r1b = await A.say(conv, 'بدي شقة بإعزاز', t1);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1b.body, r1.body);
  // even concurrent duplicates (double tap / network retry race)
  const t2 = randomUUID();
  const [x, y] = await Promise.all([A.say(conv, 'إيجار', t2), A.say(conv, 'إيجار', t2)]);
  assert.equal(x.status, 200, x.raw); assert.equal(y.status, 200, y.raw);
  assert.deepEqual(x.body, y.body);
  assert.equal(x.body.action, 'saved');
  const replay = await A.say(conv, 'إيجار', t2);
  assert.deepEqual(replay.body, x.body, 'replay after save → same saved result, not 409');
  const { rows } = await h.db.pool.query(
    `SELECT count(*) FILTER (WHERE m.role = 'user')::int AS user_msgs, (SELECT count(*)::int FROM intents i WHERE i.conversation_id = c.id) AS intents
       FROM conversations c JOIN conversation_messages m ON m.conversation_id = c.id WHERE c.public_id = $1 GROUP BY c.id`, [conv]);
  assert.deepEqual(rows[0], { user_msgs: 2, intents: 1 });
  // a new clientTurnId on a saved conversation is a clear 409
  const late = await A.say(conv, 'شي تاني');
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'conversation_closed');
});

test('concurrent turns on one conversation: serialized, no lost update', async () => {
  const conv = await A.newConversation();
  const q = () => h.db.pool.query(`SELECT c.revision, (c.draft->>'turns')::int AS turns,
      (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS msgs
      FROM conversations c WHERE c.public_id = $1`, [conv]);
  const before = (await q()).rows[0];
  const texts = ['مرحبا', 'كيفك', 'شو الأخبار', 'أهلين', 'سلام', 'صباح الخير'];
  const res = await Promise.all(texts.map((t) => A.say(conv, t)));
  for (const r of res) assert.ok(r.status === 200 || (r.status === 409 && r.body.error === 'busy'), `${r.status} ${r.raw}`);
  const ok = res.filter((r) => r.status === 200).length;
  assert.ok(ok >= 1);
  const after = (await q()).rows[0];
  assert.equal(after.msgs - before.msgs, ok, 'one stored message per accepted turn');
  assert.equal(after.revision - before.revision, ok, 'every accepted turn advanced the revision exactly once');
  assert.equal(after.turns - (before.turns ?? 0), ok, 'the draft counts every accepted turn (none overwritten)');
});

test('draft persistence: /api/conversations/current restores the open draft after a reload', async () => {
  const conv = await A.newConversation();
  const r = await A.say(conv, 'بدي شقة بإعزاز');
  assert.equal(r.body.action, 'ask');
  const reload = new Client(h); reload.cookie = A.cookie; // same browser, fresh page
  const cur = (await reload.get('/api/conversations/current')).body.conversation;
  assert.equal(cur.id, conv);
  assert.equal(cur.state, 'asking');
  assert.equal(cur.turns, 1);
  assert.deepEqual(cur.question, r.body.question);
  assert.deepEqual(cur.summary, r.body.summary);
  assert.equal((await B.get('/api/conversations/current')).body.conversation, null, 'never another user\'s draft');
  const fin = await reload.say(conv, 'إيجار');
  assert.equal(fin.body.action, 'saved');
  assert.equal((await A.get('/api/conversations/current')).body.conversation, null, 'saved → nothing to restore');
  const c2 = await A.newConversation();
  await A.say(c2, 'بدي سيارة');
  assert.equal((await A.post(`/api/conversations/${c2}/cancel`)).status, 200);
  assert.equal((await A.get('/api/conversations/current')).body.conversation, null, 'cancelled → nothing to restore');
});

test('pagination: exact totals and ranges over more than 100 intents and notifications', async () => {
  const P = new Client(h);
  const pId = (await P.register('صفحات')).id;
  const t0 = Date.now();
  const ids = await seedIntents(h, pId, 'real', 130, { createdAt: (i) => new Date(t0 - i * 60_000) });
  const seen: string[] = [];
  let r = await P.get('/api/intents?side=requests&limit=50');
  const ranges: [number, number][] = [];
  for (;;) {
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.total, 130);
    assert.equal(r.body.limit, 50);
    ranges.push([r.body.rangeStart, r.body.rangeEnd]);
    seen.push(...r.body.items.map((x: any) => x.id));
    if (!r.body.nextCursor) break;
    r = await P.get(`/api/intents?side=requests&limit=50&cursor=${r.body.nextCursor}`);
  }
  assert.deepEqual(ranges, [[1, 50], [51, 100], [101, 130]]);
  assert.deepEqual(seen, ids, 'newest first, every row exactly once');
  const back = await P.get(`/api/intents?side=requests&limit=50&dir=prev&cursor=${r.body.prevCursor}`);
  assert.deepEqual([back.body.rangeStart, back.body.rangeEnd, back.body.items.length], [51, 100, 50]);
  assert.deepEqual(back.body.items.map((x: any) => x.id), ids.slice(50, 100));
  assert.equal((await P.get('/api/intents?side=requests&limit=100')).body.items.length, 100);
  assert.equal((await P.get('/api/intents?side=offers')).body.total, 0);
  // notifications: 120 rows, 30 read
  await h.db.pool.query(
    `INSERT INTO notifications (recipient_id, kind, title_ar, dedupe_key, created_at, read_at)
     SELECT $1, 'test', 'تنبيه ' || g, 'page:' || g, now() - g * interval '1 minute', CASE WHEN g > 90 THEN now() END FROM generate_series(1, 120) g`, [pId]);
  const n1 = (await P.get('/api/notifications?limit=100')).body;
  assert.deepEqual([n1.total, n1.unread, n1.items.length, n1.rangeStart, n1.rangeEnd], [120, 90, 100, 1, 100]);
  const n2 = (await P.get(`/api/notifications?limit=100&cursor=${n1.nextCursor}`)).body;
  assert.deepEqual([n2.items.length, n2.rangeStart, n2.rangeEnd, n2.nextCursor], [20, 101, 120, null]);
  const u = (await P.get('/api/notifications?unread=1&limit=100')).body;
  assert.deepEqual([u.total, u.items.length], [90, 90]);
  const all = await P.post('/api/notifications/read-all');
  assert.equal(all.body.updated, 90);
  assert.equal((await P.get('/api/me')).body.counts.unread, 0);
  // limits are bounded
  for (const q of ['limit=0', 'limit=101', 'limit=-1', 'limit=1e3']) assert.equal((await P.get(`/api/intents?${q}`)).status, 400, q);
});

test('simulation is refused for real accounts (403) and works for a synthetic persona', async () => {
  const r = await A.post('/api/demo/simulate', { scenario: 'later_match' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'synthetic_only');
  await mkPersona(h.db.pool, 'syn_owner_001');
  await mkPersona(h.db.pool, 'test_persona');
  const S = new Client(h);
  assert.equal((await S.post('/api/auth/demo-login', { handle: 'test_persona' })).status, 200);
  assert.equal((await S.post('/api/demo/simulate', { scenario: 'later_match' })).status, 404, 'nothing to simulate yet');
  const saved = await S.dialogue('بدي كهربجي', 'الباب');
  assert.equal(saved.action, 'saved');
  const sim = await S.post('/api/demo/simulate', { scenario: 'later_match' });
  assert.equal(sim.status, 200, sim.raw);
  const { rows } = await h.db.pool.query('SELECT i.realm, u.realm AS owner_realm FROM intents i JOIN users u ON u.id = i.user_id WHERE i.public_id = $1', [sim.body.created.id]);
  assert.deepEqual(rows[0], { realm: 'synthetic', owner_realm: 'synthetic' }, 'simulated data never enters the real realm');
  assert.equal((await S.post('/api/demo/simulate', { scenario: 'other' })).status, 400);
  assert.equal((await new Client(h).post('/api/auth/demo-login', { handle: 'nobody_here' })).status, 404);
});

test('PATCH: optimistic concurrency → 409 on a stale version, exactly one winner under a race', async () => {
  const get = async () => (await A.get(`/api/intents/${aIntent}`)).body.intent;
  const v = (await get()).version;
  const ok = await A.patch(`/api/intents/${aIntent}`, { expectedVersion: v, changes: { attrs: {} } });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(ok.body.intent.version, v + 1);
  const stale = await A.patch(`/api/intents/${aIntent}`, { expectedVersion: v, changes: { attrs: {} } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'version_conflict');
  assert.ok(stale.body.messageAr);
  const race = await Promise.all([1, 2, 3, 4].map(() => A.patch(`/api/intents/${aIntent}`, { expectedVersion: v + 1, changes: { attrs: {} } })));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409, 409, 409], race.map((r) => r.raw).join('\n'));
  assert.equal((await get()).version, v + 2);
  // invalid input is 400/422, never 500
  assert.equal((await A.patch(`/api/intents/${aIntent}`, { expectedVersion: 'x', changes: {} })).status, 400);
  assert.equal((await A.patch(`/api/intents/${aIntent}`, { expectedVersion: v + 2, changes: { categoryCode: 'no.such.category' } })).status, 422);
  assert.equal((await A.patch(`/api/intents/${aIntent}`, '{"expectedVersion":', {})).status, 400);
});

test('no duplicate notifications: repeated contact requests, answers and match runs notify once', async () => {
  const D = new Client(h); const dId = (await D.register('دانا'));
  const E = new Client(h); const eId = (await E.register('عماد'));
  await seedIntents(h, eId.id, 'real', 1, { spec: electricianSpec(h, 'provide') });
  const saved = await D.dialogue('بدي كهربجي', 'الباب');
  for (let i = 0; i < 3; i++) assert.equal((await D.post(`/api/intents/${saved.intent.id}/match`)).status, 200);
  const m = (await D.get(`/api/matches?intent=${saved.intent.id}`)).body.items.find((x: any) => x.other.id !== cOffer) ?? null;
  assert.ok(m, 'D matched E\'s offer');
  const kinds = async (userId: string) => (await h.db.pool.query('SELECT kind, count(*)::int AS n FROM notifications WHERE recipient_id = $1 GROUP BY kind ORDER BY kind', [userId])).rows;
  const e1 = await kinds(eId.id);
  assert.ok(e1.every((r) => r.n === 1), `one notification per event for E: ${JSON.stringify(e1)}`);
  const reqs = await Promise.all([1, 2, 3].map(() => D.post(`/api/matches/${m.id}/contact`, { messageAr: 'مرحبا' })));
  assert.ok(reqs.every((r) => r.status === 200), reqs.map((r) => r.raw).join('\n'));
  assert.equal(new Set(reqs.map((r) => r.body.contactRequest.id)).size, 1, 'one contact request per (match, requester)');
  const e2 = await kinds(eId.id);
  assert.equal(e2.find((r) => r.kind === 'contact_request')?.n, 1);
  const answers = await Promise.all([1, 2].map(() => E.post(`/api/contact-requests/${reqs[0]!.body.contactRequest.id}/respond`, { accept: true })));
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 404]);
  const d2 = await kinds(dId.id);
  assert.equal(d2.find((r) => r.kind === 'contact_accepted')?.n, 1);
  const dup = await h.db.pool.query('SELECT recipient_id, dedupe_key, count(*) FROM notifications GROUP BY 1, 2 HAVING count(*) > 1');
  assert.equal(dup.rowCount, 0);
});

test('status change commits its safety-net match_intent job in the same transaction (crash-safe re-match)', async () => {
  const D = new Client(h); await D.register('حالة الطلب');
  const saved = await D.dialogue('بدي كهربجي', 'الباب');
  const ref = (await resolveIntentRef(h.db.pool, saved.intent.id))!;
  const jobs = async () => (await h.db.pool.query(
    "SELECT id::text, kind, payload, attempts, max_attempts, dedupe_key, status FROM jobs WHERE kind = 'match_intent' AND payload->>'intentId' = $1 AND payload->>'trigger' = 'status' ORDER BY id",
    [ref.id])).rows;
  const runs = async (version: number) => (await h.db.pool.query('SELECT count(*)::int AS n FROM match_runs WHERE vertical_id = $1 AND intent_id = $2 AND intent_version = $3', [ref.verticalId, ref.id, version])).rows[0].n;
  const p = await D.post(`/api/intents/${saved.intent.id}/status`, { action: 'pause' });
  assert.equal(p.status, 200, p.raw);
  assert.equal(p.body.intent.status, 'paused');
  const v = p.body.intent.version;
  let js = await jobs();
  assert.equal(js.length, 1);
  assert.deepEqual(js[0].payload, { verticalId: ref.verticalId, intentId: ref.id, version: v, trigger: 'status' });
  assert.equal(js[0].dedupe_key, `match:${ref.verticalId}:${ref.id}:${v}`);
  assert.equal((await D.post(`/api/intents/${saved.intent.id}/status`, { action: 'pause' })).status, 409);
  assert.equal((await jobs()).length, 1, 'a refused transition enqueues nothing');
  // normal case: the inline re-match already evaluated this version → the job is a cheap no-op
  assert.equal(await runs(v), 1);
  assert.equal(await runJob(h.db.pool, h.db.reg, js[0]), 'done');
  assert.equal(await runs(v), 1);
  // crash between the commit and the inline re-match: the committed job alone re-evaluates the new version
  const r = await D.post(`/api/intents/${saved.intent.id}/status`, { action: 'resume' });
  assert.equal(r.status, 200);
  const v2 = r.body.intent.version;
  await h.db.pool.query('DELETE FROM match_runs WHERE vertical_id = $1 AND intent_id = $2 AND intent_version = $3', [ref.verticalId, ref.id, v2]);
  js = await jobs();
  const j2 = js.find((j) => j.payload.version === v2);
  assert.ok(j2, 'resume enqueued its own versioned job');
  assert.equal(await runJob(h.db.pool, h.db.reg, j2), 'done');
  assert.equal(await runs(v2), 1, 'the worker job re-ran matching for the new version');
});
