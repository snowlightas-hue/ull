// End-to-end flows through the HTTP API (buildApp + inject, isolated database) — Role 8, independent tests.
//   * isolation: another user can neither read nor change anything of mine (intents, matches, conversations,
//     notifications, contact requests) and only ever gets 404; anonymous callers get 401; cross-site writes 403
//   * privacy before consent: no identity, phone or utterance of the counterpart until both agree
//   * retry with the same clientTurnId over the wire; draft persistence across devices (two sessions)
//   * robustness: no 5xx for user-reachable inputs (non-answers, huge amounts, malformed ids)
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, harness, mkPersona, type Harness } from './server-helpers.ts';

let h: Harness;
before(async () => { h = await harness(`r8_flows_api_${process.pid}`); });
after(async () => { await h?.close(); });

let ipSeq = 10;
const client = () => new Client(h, `10.8.0.${ipSeq++}`);

interface World { a: Client; b: Client; c: Client; aIntent: string; cIntent: string; aConv: string; matchId: string; notifId: string; contactId: string }
let world: World;

async function buildWorld(): Promise<World> {
  if (world) return world;
  const a = client(); const b = client(); const c = client();
  await a.register('أمل'); await b.register('باسل'); await c.register('كريم');
  // C registers with a phone (revealed only after consent)
  await c.post('/api/auth/logout');
  const reg = await c.post('/api/auth/register', { displayName: 'كريم المؤجر', phone: '+90 555 000 0101' });
  assert.equal(reg.status, 200);
  const ra = await a.dialogue('بدي شقة للإيجار بإعزاز حد أقصى 200 دولار بالشهر');
  assert.equal(ra.action, 'saved', JSON.stringify(ra));
  const rc = await c.dialogue('عندي شقة للإيجار بإعزاز بسعر 150 دولار بالشهر');
  assert.equal(rc.action, 'saved', JSON.stringify(rc));
  const run = await c.post(`/api/intents/${rc.intent.id}/match`);
  assert.equal(run.status, 200);
  assert.equal(run.body.totals.confirmed, 1, 'C’s offer matches A’s request');
  const mid = run.body.page.items[0].id;
  // A keeps an unfinished conversation (pending question)
  const aConv = await a.newConversation();
  const q = await a.say(aConv, 'بدي سيارة');
  assert.equal(q.body.action, 'ask');
  // C asks A for contact → A gets a notification + a pending contact request
  const cr = await c.post(`/api/matches/${mid}/contact`, {});
  assert.equal(cr.status, 200);
  const notes = await a.get('/api/notifications');
  const n = notes.body.items.find((x: any) => x.kind === 'contact_request');
  assert.ok(n, 'A was notified of the contact request');
  world = { a, b, c, aIntent: ra.intent.id, cIntent: rc.intent.id, aConv, matchId: mid, notifId: n.id, contactId: cr.body.contactRequest.id };
  return world;
}

test('isolation: a stranger gets 404 for every resource of another user, and sees none of it in lists', async () => {
  const w = await buildWorld();
  const B = w.b;
  const probes: [string, () => Promise<{ status: number }>][] = [
    ['GET intent', () => B.get(`/api/intents/${w.aIntent}`)],
    ['PATCH intent', () => B.patch(`/api/intents/${w.aIntent}`, { expectedVersion: 1, changes: { price: null } })],
    ['POST intent status', () => B.post(`/api/intents/${w.aIntent}/status`, { action: 'close' })],
    ['POST intent match', () => B.post(`/api/intents/${w.aIntent}/match`)],
    ['GET matches?intent=', () => B.get(`/api/matches?intent=${w.aIntent}`)],
    ['GET match', () => B.get(`/api/matches/${w.matchId}`)],
    ['POST match contact', () => B.post(`/api/matches/${w.matchId}/contact`, {})],
    ['POST turn into A’s conversation', () => B.say(w.aConv, 'بإعزاز')],
    ['POST cancel A’s conversation', () => B.post(`/api/conversations/${w.aConv}/cancel`)],
    ['POST read A’s notification', () => B.post(`/api/notifications/${w.notifId}/read`)],
    ['POST respond to A’s contact request', () => B.post(`/api/contact-requests/${w.contactId}/respond`, { accept: true })],
  ];
  const wrong: string[] = [];
  for (const [name, fn] of probes) { const r = await fn(); if (r.status !== 404) wrong.push(`${name} → ${r.status}`); }
  assert.deepEqual(wrong, [], 'never 200/403 (which would confirm the id exists) — always 404');
  // the requester of a contact cannot accept it on the recipient's behalf
  assert.equal((await w.c.post(`/api/contact-requests/${w.contactId}/respond`, { accept: true })).status, 404);
  // nothing of A leaks into B's lists
  const lists = [await B.get('/api/intents?side=requests'), await B.get('/api/intents?side=offers'), await B.get('/api/matches?state=all'), await B.get('/api/notifications'), await B.get('/api/conversations/current')];
  const blob = JSON.stringify(lists.map((l) => l.body));
  for (const id of [w.aIntent, w.cIntent, w.matchId, w.notifId, w.contactId, w.aConv]) assert.ok(!blob.includes(id), `B's lists do not contain ${id}`);
  assert.equal(lists[4]!.body.conversation, null);
  // and A's state was not changed by any of the probes
  const aState = await w.a.get(`/api/intents/${w.aIntent}`);
  assert.equal(aState.body.intent.status, 'active');
  assert.equal(aState.body.intent.version, 1);
  assert.equal((await w.a.get('/api/conversations/current')).body.conversation.id, w.aConv);
});

test('anonymous callers get 401 everywhere except the open routes; cross-site writes get 403', async () => {
  const w = await buildWorld();
  const anon = client();
  const routes: [string, () => Promise<{ status: number }>][] = [
    ['GET /api/me', () => anon.get('/api/me')],
    ['GET /api/intents', () => anon.get('/api/intents')],
    ['GET /api/matches', () => anon.get('/api/matches')],
    ['GET /api/notifications', () => anon.get('/api/notifications')],
    ['GET /api/events', () => anon.get('/api/events')],
    ['POST /api/conversations', () => anon.post('/api/conversations')],
    ['POST turn', () => anon.say(w.aConv, 'x')],
    ['GET intent', () => anon.get(`/api/intents/${w.aIntent}`)],
  ];
  const wrong: string[] = [];
  for (const [name, fn] of routes) { const r = await fn(); if (r.status !== 401) wrong.push(`${name} → ${r.status}`); }
  assert.deepEqual(wrong, []);
  for (const open of ['/api/health', '/api/personas', '/api/ai/status', '/api/session']) assert.notEqual((await anon.get(open)).status, 401, open);
  // CSRF: a logged-in user's browser tricked by another site
  const r = await w.a.post(`/api/intents/${w.aIntent}/status`, { action: 'close' }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
  const r2 = await w.a.post(`/api/intents/${w.aIntent}/status`, { action: 'close' }, { origin: 'null' });
  assert.equal(r2.status, 403, 'Origin: null (sandboxed iframe / file:) is refused');
  const form = await w.a.call('POST', `/api/intents/${w.aIntent}/status`, 'action=close', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415, 'a classic HTML form post is refused');
  assert.equal((await w.a.get(`/api/intents/${w.aIntent}`)).body.intent.status, 'active');
});

test('privacy before consent: no name, phone or utterance of the counterpart until both agree; then both see each other', async () => {
  const w = await buildWorld();
  const aView = await w.a.get('/api/matches?state=all');
  const cView = await w.c.get('/api/matches?state=all');
  const aJson = JSON.stringify(aView.body);
  const cJson = JSON.stringify(cView.body);
  assert.ok(!/كريم|0101/.test(aJson), 'A sees neither C’s name nor phone before accepting');
  assert.ok(!/أمل/.test(cJson), 'C does not see A’s name');
  assert.ok(!aJson.includes('عندي شقة للإيجار بإعزاز بسعر 150'), 'C’s utterance (source_text) is never shown to A');
  assert.ok(!cJson.includes('بدي شقة للإيجار بإعزاز حد أقصى'), 'A’s utterance is never shown to C');
  const aCard = aView.body.items.find((m: any) => m.id === w.matchId);
  assert.equal(aCard.contact.status, 'pending_in');
  assert.equal(aCard.contact.counterpart, undefined);
  // A accepts → identities are revealed to both, at the same moment
  const acc = await w.a.post(`/api/contact-requests/${w.contactId}/respond`, { accept: true });
  assert.equal(acc.status, 200);
  const a2 = (await w.a.get(`/api/matches/${w.matchId}`)).body.match;
  const c2 = (await w.c.get(`/api/matches/${w.matchId}`)).body.match;
  assert.equal(a2.contact.status, 'accepted');
  assert.equal(a2.contact.counterpart?.displayName, 'كريم المؤجر');
  assert.equal(a2.contact.counterpart?.phone, '+90 555 000 0101');
  assert.equal(c2.contact.counterpart?.displayName, 'أمل');
  // answering twice is not possible
  assert.equal((await w.a.post(`/api/contact-requests/${w.contactId}/respond`, { accept: false })).status, 404);
});

test('retry with the same clientTurnId over HTTP: same body; parallel duplicates too; one stored turn', async () => {
  const u = client();
  await u.register('مستخدم بشبكة ضعيفة');
  const conv = await u.newConversation();
  const id = randomUUID();
  const first = await u.say(conv, 'بدي شقة بإعزاز', id);
  const again = await u.say(conv, 'بدي شقة بإعزاز', id);
  assert.equal(first.status, 200);
  assert.deepEqual(again.body, first.body, 'identical replay (same JSON; key order may differ — the stored copy is jsonb)');
  const id2 = randomUUID();
  const par = await Promise.all([u.say(conv, 'إيجار', id2), u.say(conv, 'إيجار', id2), u.say(conv, 'إيجار', id2)]);
  const ok = par.filter((r) => r.status === 200);
  assert.ok(ok.length >= 1 && par.every((r) => r.status === 200 || r.status === 409), par.map((r) => r.status).join(','));
  for (const r of ok) assert.deepEqual(r.body, ok[0]!.body);
  assert.equal(ok[0]!.body.action, 'saved');
  const { rows } = await h.db.pool.query("SELECT count(*)::int AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.public_id = $1 AND m.role = 'user'", [conv]);
  assert.equal(rows[0].n, 2);
  // a malformed clientTurnId is a 400, not a silent non-idempotent turn
  const bad = await u.post(`/api/conversations/${await u.newConversation()}/turns`, { text: 'بدي شقة', modality: 'text', clientTurnId: 'not-a-uuid' });
  assert.equal(bad.status, 400);
});

test('draft persistence across devices: a second session of the same user resumes the pending question', async () => {
  await mkPersona(h.db.pool, 'r8_twodevices');
  const phone = client(); const laptop = client();
  assert.equal((await phone.post('/api/auth/demo-login', { handle: 'r8_twodevices' })).status, 200);
  const conv = await phone.newConversation();
  const q = await phone.say(conv, 'عندي سيارة للبيع بإعزاز');
  assert.equal(q.body.action, 'ask');
  assert.equal((await laptop.post('/api/auth/demo-login', { handle: 'r8_twodevices' })).status, 200);
  const cur = await laptop.get('/api/conversations/current');
  assert.equal(cur.body.conversation.id, conv);
  assert.equal(cur.body.conversation.question.id, q.body.question.id);
  const ans = await laptop.say(conv, '٦٠٠٠ دولار');
  assert.equal(ans.status, 200);
  assert.equal(ans.body.action, 'saved', `price + currency answered on the other device: ${ans.raw}`);
  assert.equal((await phone.get('/api/conversations/current')).body.conversation, null, 'the phone no longer shows a stale question');
});

test('robustness: user-reachable inputs never produce a 5xx', async () => {
  const u = client();
  await u.register('مستخدم محتار');
  const fives: string[] = [];
  const note = (what: string, r: { status: number; raw: string }) => { if (r.status >= 500) fives.push(`${what} → ${r.status} ${r.raw.slice(0, 80)}`); };
  // four answers that are not answers (the 4th exceeds the 3-attempt limit), then one more
  const conv = await u.newConversation();
  for (const t of ['بدي حدا يصلحلي شي', 'ممم', 'يعني', 'لحظة', 'طيب']) note(`turn «${t}»`, await u.say(conv, t));
  // money beyond the 15-digit API limit, negative, fractional, scientific
  const r = await u.dialogue('بدي شقة للإيجار بإعزاز حد أقصى 200 دولار بالشهر');
  const id = r.intent.id;
  const det = (await u.get(`/api/intents/${id}`)).body.intent;
  for (const hi of ['9007199254740993', '-1', '1.5', '1e3', '٢٠٠']) {
    const p = await u.patch(`/api/intents/${id}`, { expectedVersion: det.version, changes: { price: { op: 'lte', lo: null, hi, currency: 'USD', unit: 'month', strength: 'required' } } });
    note(`PATCH price.hi=${hi}`, p);
    assert.ok([400, 422].includes(p.status), `price.hi=${hi} rejected as invalid input (got ${p.status})`);
  }
  const huge = await u.patch(`/api/intents/${id}`, { expectedVersion: det.version, changes: { price: { op: 'lte', lo: null, hi: '999999999999999', currency: 'USD', unit: 'month', strength: 'required' } } });
  assert.equal(huge.status, 200, 'the largest allowed amount (15 digits) is accepted exactly');
  assert.equal(huge.body.intent.spec.price.hi, '999999999999999');
  // malformed ids and cursors
  note('GET bad intent id', await u.get('/api/intents/not-a-uuid'));
  note('GET bad cursor', await u.get('/api/matches?cursor=%%%'));
  note('GET huge limit', await u.get('/api/matches?limit=100000'));
  note('turn with 1001 chars', await u.say(await u.newConversation(), 'ب'.repeat(1001)));
  assert.deepEqual(fives, [], 'no 5xx for user-reachable input');
});
