// Connections («ربط») & chat through the HTTP API (buildApp + inject, isolated database). Owner: connections role.
//   * accept opens exactly one connection (also under concurrent accepts); realm separation
//   * privacy: accept reveals the display name only; phone only while shared; precise location only while a share is
//     active; every endpoint 404s for a third user, 401s when logged out
//   * chat: idempotent clientMsgId, 1000-char limit, keyset pages with exact totals, read receipts,
//     grouped "رسائل جديدة" notifications (one unread per connection)
//   * block / unblock / close / report
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Client, electricianSpec, extraApp, harness, mkPersona, seedIntents, sleep, type Harness } from './server-helpers.ts';
import connectionsRoutes, { makeConnectionsRoutes } from '../../src/server/routes/connections.ts';
import accountRoutes from '../../src/server/routes/account.ts';
import { endExpiredShares } from '../../src/connections/repo.ts';

let h: Harness;
const extra: FastifyInstance[] = [];
before(async () => {
  h = await harness(`conn_api_${process.pid}`, { routes: [connectionsRoutes, accountRoutes], featureRoutes: false });
});
after(async () => { for (const a of extra) await a.close(); await h?.close(); });

let ipSeq = 10;
const client = () => new Client(h, `10.44.0.${ipSeq++}`);
const q = (sql: string, params: unknown[] = []) => h.db.pool.query(sql, params);

async function registerWith(c: Client, displayName: string, phone?: string): Promise<{ id: string; publicId: string }> {
  const r = await c.post('/api/auth/register', phone ? { displayName, phone } : { displayName });
  assert.equal(r.status, 200, r.raw);
  const { rows } = await q('SELECT id FROM users WHERE public_id = $1', [r.body.user.publicId]);
  return { id: String(rows[0].id), publicId: r.body.user.publicId };
}

async function matchBetween(aUserId: string, bUserId: string): Promise<string> {
  const { rows } = await q(
    `SELECT r.public_id FROM matches m JOIN match_refs r ON r.vertical_id = m.vertical_id AND r.match_id = m.id
      WHERE (m.a_user_id = $1 AND m.b_user_id = $2) OR (m.a_user_id = $2 AND m.b_user_id = $1) ORDER BY m.id DESC LIMIT 1`, [aUserId, bUserId]);
  assert.ok(rows[0], 'a match exists between the two users');
  return rows[0].public_id;
}

interface Pair { A: Client; C: Client; a: { id: string; publicId: string }; c: { id: string; publicId: string }; aName: string; cName: string; matchId: string; aIntent: string; cIntent: string }

/** A (seeker, no phone) and C (provider, with phone) whose intents match. */
async function makePair(tag: string, opts: { aPhone?: string; cPhone?: string } = {}): Promise<Pair> {
  const A = client(); const C = client();
  const aName = `أمل ${tag}`; const cName = `كريم ${tag}`;
  const a = await registerWith(A, aName, opts.aPhone);
  const c = await registerWith(C, cName, opts.cPhone ?? '+90 555 000 0101');
  const ra = await A.dialogue('بدي شقة للإيجار بإعزاز حد أقصى 200 دولار بالشهر');
  assert.equal(ra.action, 'saved', JSON.stringify(ra));
  const rc = await C.dialogue('عندي شقة للإيجار بإعزاز بسعر 150 دولار بالشهر');
  assert.equal(rc.action, 'saved', JSON.stringify(rc));
  assert.equal((await C.post(`/api/intents/${rc.intent.id}/match`)).status, 200);
  return { A, C, a, c, aName, cName, matchId: await matchBetween(a.id, c.id), aIntent: ra.intent.id, cIntent: rc.intent.id };
}

/** C asks, A accepts → the connection's public id. */
async function connect(p: Pair): Promise<string> {
  const cr = await p.C.post(`/api/matches/${p.matchId}/contact`, {});
  assert.equal(cr.status, 200, cr.raw);
  const acc = await p.A.post(`/api/contact-requests/${cr.body.contactRequest.id}/respond`, { accept: true });
  assert.equal(acc.status, 200, acc.raw);
  assert.match(acc.body.connection.id, /^[0-9a-f-]{36}$/);
  return acc.body.connection.id;
}

const send = (c: Client, conn: string, text: string, clientMsgId: string = randomUUID()) => c.post(`/api/connections/${conn}/messages`, { text, clientMsgId });
const connCount = async (matchPublicId: string) => Number((await q(
  'SELECT count(*) FROM connections c JOIN match_refs r ON r.vertical_id = c.vertical_id AND r.match_id = c.match_id WHERE r.public_id = $1', [matchPublicId])).rows[0].count);

// ───────────── lifecycle ─────────────

test('accept opens exactly one connection: concurrent accepts of both sides, parallel double accepts', async () => {
  const p = await makePair('تزامن');
  // both sides ask each other on the same match, then both accept at the same moment
  const cr1 = await p.C.post(`/api/matches/${p.matchId}/contact`, {});
  const cr2 = await p.A.post(`/api/matches/${p.matchId}/contact`, {});
  assert.equal(cr1.status, 200); assert.equal(cr2.status, 200);
  assert.equal((await p.A.get(`/api/matches/${p.matchId}`)).body.match.connection, undefined, 'no connection before an accept');
  const [r1, r2] = await Promise.all([
    p.A.post(`/api/contact-requests/${cr1.body.contactRequest.id}/respond`, { accept: true }),
    p.C.post(`/api/contact-requests/${cr2.body.contactRequest.id}/respond`, { accept: true }),
  ]);
  assert.equal(r1.status, 200, r1.raw); assert.equal(r2.status, 200, r2.raw);
  assert.equal(r1.body.connection.id, r2.body.connection.id, 'both accepts return the same connection');
  assert.equal(await connCount(p.matchId), 1);
  assert.equal(r1.body.connection.status, 'open');

  // one request answered 6× in parallel → one 200, five 404, still one connection
  const p2 = await makePair('ستة');
  const cr = await p2.C.post(`/api/matches/${p2.matchId}/contact`, {});
  const answers = await Promise.all(Array.from({ length: 6 }, () => p2.A.post(`/api/contact-requests/${cr.body.contactRequest.id}/respond`, { accept: true })));
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 404, 404, 404, 404, 404]);
  assert.equal(await connCount(p2.matchId), 1);
  // both sides see it in their list and on the match card
  const conn = answers.find((r) => r.status === 200)!.body.connection.id;
  for (const who of [p2.A, p2.C]) {
    const list = await who.get('/api/connections');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((x: any) => x.id === conn), 'listed for both participants');
    const m = (await who.get(`/api/matches/${p2.matchId}`)).body.match;
    assert.equal(m.connection.id, conn);
    assert.equal(m.connection.status, 'open');
  }
  // the requester was told, with the connection id; the texts promise the name only
  const n = (await p2.C.get('/api/notifications')).body.items.find((x: any) => x.kind === 'contact_accepted');
  assert.equal(n.payload.connectionId, conn);
  assert.match(n.bodyAr, /الاسم فقط/);
  const req = (await p2.A.get('/api/notifications')).body.items.find((x: any) => x.kind === 'contact_request');
  assert.ok(!/ورقم كل منكما/.test(req.bodyAr), 'the request no longer promises a phone exchange');
});

test('privacy: accept reveals the display name only; the phone shows only while shared and hides again after unshare', async () => {
  const p = await makePair('هاتف');
  const conn = await connect(p);
  const aView = async () => ({
    match: (await p.A.get(`/api/matches/${p.matchId}`)).body.match,
    list: (await p.A.get('/api/matches?state=all')).body,
    conn: (await p.A.get(`/api/connections/${conn}`)).body.connection,
    conns: (await p.A.get('/api/connections')).body,
  });
  let v = await aView();
  assert.equal(v.match.contact.status, 'accepted');
  assert.equal(v.match.contact.counterpart.displayName, p.cName, 'the name is revealed by the accept');
  assert.equal(v.match.contact.counterpart.phone, undefined);
  assert.equal(v.conn.counterpart.displayName, p.cName);
  assert.equal(v.conn.counterpart.phone, undefined);
  assert.equal(v.conn.them.phoneShared, false);
  for (const blob of [v.match, v.list, v.conn, v.conns]) assert.ok(!JSON.stringify(blob).includes('0101'), 'no phone anywhere before C shares it');
  // C shares → A sees it everywhere
  const on = await p.C.post(`/api/connections/${conn}/phone`, { share: true });
  assert.equal(on.status, 200, on.raw);
  assert.equal(on.body.connection.me.phoneShared, true);
  v = await aView();
  assert.equal(v.conn.counterpart.phone, '+90 555 000 0101');
  assert.equal(v.conn.them.phoneShared, true);
  assert.equal(v.match.contact.counterpart.phone, '+90 555 000 0101');
  assert.equal(v.conns.items.find((x: any) => x.id === conn).counterpart.phone, '+90 555 000 0101');
  // C sees only its own share state, never a phone of A (A has none)
  const cConn = (await p.C.get(`/api/connections/${conn}`)).body.connection;
  assert.equal(cConn.counterpart.phone, undefined);
  // C unshares → hidden again
  assert.equal((await p.C.post(`/api/connections/${conn}/phone`, { share: false })).status, 200);
  v = await aView();
  for (const blob of [v.match, v.list, v.conn, v.conns]) assert.ok(!JSON.stringify(blob).includes('0101'), 'hidden again after unshare');
  // A has no phone: sharing needs one; giving it here stores it and shares it
  const noPhone = await p.A.post(`/api/connections/${conn}/phone`, { share: true });
  assert.equal(noPhone.status, 409);
  assert.equal(noPhone.body.error, 'no_phone');
  assert.equal((await p.A.post(`/api/connections/${conn}/phone`, { share: true, phone: 'abc' })).status, 400);
  assert.equal((await p.A.post(`/api/connections/${conn}/phone`, { share: true, phone: '+963 944 222 333' })).status, 200);
  assert.equal((await p.C.get(`/api/connections/${conn}`)).body.connection.counterpart.phone, '+963 944 222 333');
  // closing hides every phone (shares are switched off)
  assert.equal((await p.C.post(`/api/connections/${conn}/close`, {})).status, 200);
  assert.ok(!JSON.stringify((await p.C.get(`/api/connections/${conn}`)).body).includes('222 333'));
  assert.ok(!JSON.stringify((await p.C.get(`/api/matches/${p.matchId}`)).body).includes('222 333'));
});

test('isolation: a third user gets 404 on every connection endpoint (and sees nothing in lists); anonymous gets 401', async () => {
  const p = await makePair('عزل');
  const conn = await connect(p);
  assert.equal((await send(p.C, conn, 'مرحبا، الشقة لسا متاحة؟')).status, 200);
  assert.equal((await p.C.post(`/api/connections/${conn}/location/start`, { minutes: 15 })).status, 200);
  assert.equal((await p.C.post(`/api/connections/${conn}/location`, { lat: 36.586, lng: 37.044 })).status, 200);
  const B = client();
  await registerWith(B, 'باسل الغريب');
  const probes: [string, (x: Client) => Promise<{ status: number }>][] = [
    ['GET detail', (x) => x.get(`/api/connections/${conn}`)],
    ['GET messages', (x) => x.get(`/api/connections/${conn}/messages`)],
    ['GET messages after', (x) => x.get(`/api/connections/${conn}/messages?after=0`)],
    ['GET location', (x) => x.get(`/api/connections/${conn}/location`)],
    ['POST message', (x) => send(x, conn, 'تجربة')],
    ['POST read', (x) => x.post(`/api/connections/${conn}/read`, { seq: 1 })],
    ['POST phone', (x) => x.post(`/api/connections/${conn}/phone`, { share: true, phone: '+1 555 0000' })],
    ['POST location/start', (x) => x.post(`/api/connections/${conn}/location/start`, { minutes: 15 })],
    ['POST location/stop', (x) => x.post(`/api/connections/${conn}/location/stop`, {})],
    ['POST location', (x) => x.post(`/api/connections/${conn}/location`, { lat: 1, lng: 1 })],
    ['POST close', (x) => x.post(`/api/connections/${conn}/close`, {})],
    ['POST block', (x) => x.post(`/api/connections/${conn}/block`, {})],
    ['POST unblock', (x) => x.post(`/api/connections/${conn}/unblock`, {})],
    ['POST report', (x) => x.post(`/api/connections/${conn}/report`, { reason: 'spam' })],
  ];
  for (const [name, fn] of probes) {
    const r = await fn(B);
    assert.equal(r.status, 404, `${name}: a stranger gets 404`);
  }
  const anon = client();
  for (const [name, fn] of probes) assert.equal((await fn(anon)).status, 401, `${name}: anonymous gets 401`);
  assert.equal((await anon.get('/api/connections')).status, 401);
  assert.equal((await B.get('/api/connections/not-a-uuid')).status, 400, 'malformed id → 400 bad_id');
  // nothing of the pair appears in B's views
  const blob = JSON.stringify([(await B.get('/api/connections?status=all')).body, (await B.get('/api/notifications')).body, (await B.get('/api/matches?state=all')).body]);
  for (const s of [conn, p.cName, p.aName, '36.586', 'الشقة لسا متاحة']) assert.ok(!blob.includes(s), `B sees nothing of «${s}»`);
  // and the probes changed nothing
  const d = (await p.A.get(`/api/connections/${conn}`)).body.connection;
  assert.equal(d.status, 'open');
  assert.equal(d.messageCount, 1);
  assert.equal(d.them.location.active, true);
  assert.equal(Number((await q('SELECT count(*) FROM connection_reports rp JOIN connections c ON c.id = rp.connection_id WHERE c.public_id = $1', [conn])).rows[0].count), 0, 'no report stored');
  assert.equal(Number((await q('SELECT count(*) FROM user_blocks WHERE blocker_id = (SELECT id FROM users WHERE display_name = $1)', ['باسل الغريب'])).rows[0].count), 0);
});

// ───────────── chat ─────────────

test('messages: idempotent clientMsgId (sequential and parallel retries → one row), 1000-character limit, closed → 409', async () => {
  const p = await makePair('رسائل');
  const conn = await connect(p);
  const id = randomUUID();
  const first = await send(p.A, conn, '  مرحبا! متى فيني شوف الشقة؟  ', id);
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.message.seq, 1);
  assert.equal(first.body.message.text, 'مرحبا! متى فيني شوف الشقة؟', 'trimmed');
  assert.equal(first.body.message.clientMsgId, id);
  const again = await send(p.A, conn, 'مرحبا! متى فيني شوف الشقة؟', id);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.message.seq, 1);
  const id2 = randomUUID();
  const par = await Promise.all(Array.from({ length: 8 }, () => send(p.A, conn, 'رسالة مكررة بالشبكة', id2)));
  assert.ok(par.every((r) => r.status === 200), JSON.stringify(par.map((r) => r.status)));
  assert.equal(new Set(par.map((r) => r.body.message.seq)).size, 1, 'every retry returns the same message');
  assert.equal(par.filter((r) => !r.body.duplicate).length, 1, 'exactly one stored');
  const rows = await q('SELECT count(*)::int AS n FROM connection_messages m JOIN connections c ON c.id = m.connection_id WHERE c.public_id = $1', [conn]);
  assert.equal(rows.rows[0].n, 2);
  assert.equal((await send(p.A, conn, 'نص آخر', id)).status, 409, 'same clientMsgId with another text');
  // the other side may reuse "the same" uuid: idempotency is per sender
  assert.equal((await send(p.C, conn, 'أهلا', id)).body.duplicate, false);
  // limits: 1000 code points (emoji count once), not 1001; empty / whitespace refused; bad uuid refused
  assert.equal((await send(p.A, conn, '😀'.repeat(1000))).status, 200);
  const long = await send(p.A, conn, 'ب'.repeat(1001));
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'message_too_long');
  assert.equal((await send(p.A, conn, '   \n ')).status, 400);
  assert.equal((await p.A.post(`/api/connections/${conn}/messages`, { text: 'x', clientMsgId: 'nope' })).status, 400);
  // the text is stored, not logged (server log assertions live in server-ops; here: never in notifications)
  const notes = JSON.stringify((await p.C.get('/api/notifications')).body);
  assert.ok(!notes.includes('متى فيني شوف'), 'notifications never carry message text');
  // after close: no new message, but a retry of an old one is still answered idempotently
  assert.equal((await p.C.post(`/api/connections/${conn}/close`, {})).status, 200);
  const closed = await send(p.A, conn, 'بعد الإغلاق');
  assert.equal(closed.status, 409);
  assert.equal(closed.body.error, 'connection_not_open');
  assert.equal((await send(p.A, conn, 'مرحبا! متى فيني شوف الشقة؟', id)).body.duplicate, true);
  // history stays readable for both
  assert.equal((await p.A.get(`/api/connections/${conn}/messages`)).body.total, 4);
  assert.equal((await p.A.get(`/api/connections/${conn}`)).body.connection.status, 'closed');
  assert.equal((await p.A.get(`/api/connections/${conn}`)).body.connection.canSend, false);
});

test('messages: keyset pages (newest first) with exact totals and ranges, prev/next round trip, "after" for live updates', async () => {
  const p = await makePair('صفحات');
  const conn = await connect(p);
  const N = 47;
  for (let i = 1; i <= N; i++) assert.equal((await send(i % 2 ? p.A : p.C, conn, `رسالة رقم ${i}`)).status, 200);
  const seen: number[] = [];
  let page = (await p.A.get(`/api/connections/${conn}/messages?limit=20`)).body;
  assert.equal(page.total, N);
  assert.deepEqual([page.rangeStart, page.rangeEnd], [1, 20]);
  assert.equal(page.items[0].seq, N, 'newest first');
  assert.equal(page.prevCursor, null);
  const pages = [page];
  while (page.nextCursor) {
    page = (await p.A.get(`/api/connections/${conn}/messages?limit=20&cursor=${page.nextCursor}`)).body;
    pages.push(page);
  }
  for (const pg of pages) for (const m of pg.items) seen.push(m.seq);
  assert.deepEqual(seen, Array.from({ length: N }, (_, i) => N - i), 'every message exactly once, in order');
  assert.deepEqual(pages.map((x) => [x.rangeStart, x.rangeEnd, x.total]), [[1, 20, N], [21, 40, N], [41, 47, N]]);
  // back from the last page
  const back = (await p.A.get(`/api/connections/${conn}/messages?limit=20&dir=prev&cursor=${pages[2].prevCursor}`)).body;
  assert.deepEqual([back.rangeStart, back.rangeEnd], [21, 40]);
  assert.deepEqual(back.items.map((m: any) => m.seq), pages[1].items.map((m: any) => m.seq));
  // mine flags are per viewer
  assert.equal(pages[0].items.find((m: any) => m.seq === 47).mine, true);
  assert.equal((await p.C.get(`/api/connections/${conn}/messages?limit=1`)).body.items[0].mine, false);
  // live updates: everything after seq 44, oldest first
  const aft = (await p.C.get(`/api/connections/${conn}/messages?after=44`)).body;
  assert.deepEqual(aft.items.map((m: any) => m.seq), [45, 46, 47]);
  assert.equal(aft.more, false);
  assert.equal(aft.total, N);
  // a bad cursor is a 400 bad_cursor before any SQL
  const bad = await p.A.get(`/api/connections/${conn}/messages?cursor=${Buffer.from(JSON.stringify({ k: 'x', id: '1' })).toString('base64url')}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_cursor');
});

test('read receipts + grouped "رسائل جديدة" notifications: one unread per connection, refreshed, cleared by reading', async () => {
  const p = await makePair('تنبيهات');
  const conn = await connect(p);
  const msgNotes = async (c: Client) => (await c.get('/api/notifications?limit=100')).body.items.filter((n: any) => n.kind === 'connection_message' && n.payload.connectionId === conn);
  for (const t of ['مرحبا', 'الشقة متاحة؟', 'بدي شوفها بكرا']) assert.equal((await send(p.C, conn, t)).status, 200);
  let notes = await msgNotes(p.A);
  assert.equal(notes.length, 1, 'three messages → one notification');
  assert.equal(notes[0].readAt, null);
  assert.equal(notes[0].titleAr, `رسائل جديدة من ${p.cName}`);
  assert.equal(notes[0].bodyAr, '3 رسائل جديدة');
  assert.equal((await p.A.get('/api/me')).body.counts.unread >= 1, true);
  let d = (await p.A.get(`/api/connections/${conn}`)).body.connection;
  assert.equal(d.unread, 3);
  assert.equal(d.me.lastReadSeq, 0);
  // A reads up to seq 2: receipt moves, notification stays (still one unread message)
  assert.deepEqual((await p.A.post(`/api/connections/${conn}/read`, { seq: 2 })).body, { ok: true, lastReadSeq: 2, unread: 1 });
  assert.equal((await p.C.get(`/api/connections/${conn}`)).body.connection.them.lastReadSeq, 2, 'C sees how far A read');
  assert.equal((await msgNotes(p.A))[0].readAt, null);
  // reading everything (asking beyond the end is clamped) marks it read
  const unreadBefore = (await p.A.get('/api/me')).body.counts.unread;
  assert.deepEqual((await p.A.post(`/api/connections/${conn}/read`, { seq: 999 })).body, { ok: true, lastReadSeq: 3, unread: 0 });
  notes = await msgNotes(p.A);
  assert.notEqual(notes[0].readAt, null);
  assert.equal((await p.A.get('/api/me')).body.counts.unread, unreadBefore - 1);
  // receipts never go backwards
  assert.equal((await p.A.post(`/api/connections/${conn}/read`, { seq: 1 })).body.lastReadSeq, 3);
  // two more → the SAME notification is unread again and refreshed
  for (const t of ['؟', 'رد علي لما تقدر']) await send(p.C, conn, t);
  notes = await msgNotes(p.A);
  assert.equal(notes.length, 1, 'still one notification for this connection');
  assert.equal(notes[0].readAt, null);
  assert.equal(notes[0].bodyAr, 'رسالتان جديدتان');
  assert.equal(Number((await q("SELECT count(*) FROM notifications WHERE dedupe_key = $1", [`conn-msg:${conn}`])).rows[0].count), 1, 'one row ever (per recipient)');
  // A replies → A's own grouped notification is cleared (A has obviously read), C now gets one
  await send(p.A, conn, 'تمام، بكرا الساعة ٥');
  assert.notEqual((await msgNotes(p.A))[0].readAt, null);
  assert.equal((await msgNotes(p.C)).length, 1);
  assert.equal((await p.A.get(`/api/connections/${conn}`)).body.connection.me.lastReadSeq, 6);
});

// ───────────── block / unblock / report / close ─────────────

test('block: freezes the connection, refuses messages and new contact requests both ways; the blocked side only sees "closed"', async () => {
  const p = await makePair('حظر');
  const conn = await connect(p);
  assert.equal((await p.C.post(`/api/connections/${conn}/phone`, { share: true })).status, 200);
  // a second match between the same two people, with a pending request from C
  const [aSeek] = await seedIntents(h, p.a.id, 'real', 1, { spec: electricianSpec(h, 'seek') });
  const [cOffer] = await seedIntents(h, p.c.id, 'real', 1, { spec: electricianSpec(h, 'provide') });
  assert.equal((await p.C.post(`/api/intents/${cOffer}/match`)).status, 200);
  const m2 = (await q(
    `SELECT r.public_id FROM matches m JOIN match_refs r ON r.vertical_id = m.vertical_id AND r.match_id = m.id
       JOIN intent_refs ia ON ia.vertical_id = m.vertical_id AND ia.intent_id = m.a_intent_id WHERE ia.public_id = $1`, [aSeek])).rows[0].public_id;
  const pending = await p.C.post(`/api/matches/${m2}/contact`, {});
  assert.equal(pending.status, 200);

  const blk = await p.A.post(`/api/connections/${conn}/block`, {});
  assert.equal(blk.status, 200, blk.raw);
  assert.equal(blk.body.connection.status, 'blocked');
  assert.equal(blk.body.connection.blockedByMe, true);
  const cView = (await p.C.get(`/api/connections/${conn}`)).body.connection;
  assert.equal(cView.status, 'closed', 'the blocked side is not told it was blocked');
  assert.equal(cView.blockedByMe, false);
  assert.equal(cView.canSend, false);
  // messages refused both ways; phones gone
  for (const who of [p.A, p.C]) {
    const r = await send(who, conn, 'مرحبا؟');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'connection_not_open');
  }
  assert.equal((await p.A.get(`/api/connections/${conn}`)).body.connection.counterpart.phone, undefined);
  // the pending request was cancelled; new ones are refused in both directions
  assert.equal((await p.A.post(`/api/contact-requests/${pending.body.contactRequest.id}/respond`, { accept: true })).status, 404);
  for (const who of [p.C, p.A]) {
    const r = await who.post(`/api/matches/${m2}/contact`, {});
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, 'contact_unavailable');
  }
  assert.ok(!JSON.stringify((await p.C.post(`/api/matches/${m2}/contact`, {})).body).includes('حظر'), 'the refusal does not say "blocked"');
  // idempotent; listed under "closed" for both
  assert.equal((await p.A.post(`/api/connections/${conn}/block`, {})).status, 200);
  assert.ok((await p.C.get('/api/connections?status=closed')).body.items.some((x: any) => x.id === conn));
  assert.ok(!(await p.C.get('/api/connections')).body.items.some((x: any) => x.id === conn), 'not among open ones');
  // only the blocker can lift it; then contact is possible again (on the other match), the old connection stays closed
  assert.equal((await p.C.post(`/api/connections/${conn}/unblock`, {})).status, 200, 'C has no block to lift (no-op, no leak)');
  assert.equal((await p.C.post(`/api/matches/${m2}/contact`, {})).status, 409, 'still blocked by A');
  const ub = await p.A.post(`/api/connections/${conn}/unblock`, {});
  assert.equal(ub.status, 200);
  assert.equal(ub.body.connection.status, 'closed');
  assert.equal((await send(p.A, conn, 'هل رجعنا؟')).status, 409, 'unblocking does not reopen');
  const again = await p.C.post(`/api/matches/${m2}/contact`, {});
  assert.equal(again.status, 200, again.raw);
  // contact on the first match: its connection ended → refused
  const ended = await p.C.post(`/api/matches/${p.matchId}/contact`, {});
  assert.equal(ended.status, 409);
});

test('report: stored for review (reason + note), one per reporter (updated), nobody is auto-banned', async () => {
  const p = await makePair('بلاغ');
  const conn = await connect(p);
  assert.equal((await p.A.post(`/api/connections/${conn}/report`, { reason: 'nope' })).status, 400);
  const r = await p.A.post(`/api/connections/${conn}/report`, { reason: 'scam', note: 'طلب دفعة مقدمة' });
  assert.equal(r.status, 200);
  assert.match(r.body.noteAr, /لا يُعاقَب أحد تلقائيًا/);
  assert.equal((await p.A.post(`/api/connections/${conn}/report`, { reason: 'abuse' })).status, 200);
  const rows = (await q(
    `SELECT rp.reason, rp.note, rp.status, rp.reporter_id::text, rp.reported_id::text FROM connection_reports rp JOIN connections c ON c.id = rp.connection_id WHERE c.public_id = $1`, [conn])).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { reason: 'abuse', note: null, status: 'open', reporter_id: p.a.id, reported_id: p.c.id });
  assert.equal((await p.A.get(`/api/connections/${conn}`)).body.connection.reportedByMe, true);
  assert.equal((await p.C.get(`/api/connections/${conn}`)).body.connection.reportedByMe, false, 'the reported side is not told');
  // no automatic consequence: C can still chat and log in
  assert.equal((await send(p.C, conn, 'مرحبا')).status, 200);
  assert.equal((await p.C.get('/api/me')).status, 200);
});

// ───────────── live location ─────────────

test('location: only within a connection, only while a share is active; stop erases the position; both sides notified', async () => {
  const p = await makePair('موقع');
  // before any connection: no way to see a precise position (and match cards never carry coordinates)
  assert.ok(!/36\.58/.test(JSON.stringify((await p.A.get('/api/matches?state=all')).body)));
  const conn = await connect(p);
  const noShare = await p.C.post(`/api/connections/${conn}/location`, { lat: 36.58612, lng: 37.04411 });
  assert.equal(noShare.status, 409);
  assert.equal(noShare.body.error, 'share_not_active');
  assert.equal((await p.C.post(`/api/connections/${conn}/location/start`, { minutes: 20 })).status, 400, 'only 15 / 30 / 60');
  const st = await p.C.post(`/api/connections/${conn}/location/start`, { minutes: 15 });
  assert.equal(st.status, 200, st.raw);
  assert.equal(st.body.share.active, true);
  const ms = Date.parse(st.body.share.expiresAt) - Date.parse(st.body.share.startedAt);
  assert.ok(Math.abs(ms - 15 * 60_000) < 2000, `15 minutes (${ms} ms)`);
  let a = (await p.A.get(`/api/connections/${conn}/location`)).body;
  assert.equal(a.theirs.active, true);
  assert.equal(a.theirs.position, null, 'no position until the device sends one');
  assert.equal((await p.C.post(`/api/connections/${conn}/location`, { lat: 36.58612, lng: 37.04411, accuracyM: 18.4 })).status, 200);
  a = (await p.A.get(`/api/connections/${conn}/location`)).body;
  assert.deepEqual([a.theirs.position.lat, a.theirs.position.lng, a.theirs.position.accuracyM], [36.58612, 37.04411, 18]);
  assert.equal(a.mine.active, false);
  assert.equal((await p.A.get(`/api/connections/${conn}`)).body.connection.them.location.position.lat, 36.58612);
  // the sharer does not get its own coordinates echoed back as "theirs"
  const c = (await p.C.get(`/api/connections/${conn}/location`)).body;
  assert.equal(c.mine.active, true);
  assert.equal(c.theirs.active, false);
  assert.equal(c.mine.position, undefined);
  const started = (await p.A.get('/api/notifications')).body.items.find((n: any) => n.kind === 'location_share_started');
  assert.ok(started, 'A was told the share started');
  assert.match(started.titleAr, new RegExp(p.cName));
  assert.ok(!/36\.58/.test(JSON.stringify(started)), 'notifications never carry coordinates');
  // stop → nothing to read, coordinates erased from the database, A told it ended
  assert.equal((await p.C.post(`/api/connections/${conn}/location/stop`, {})).status, 200);
  a = (await p.A.get(`/api/connections/${conn}/location`)).body;
  assert.equal(a.theirs.active, false);
  assert.equal(a.theirs.position, null);
  const row = (await q('SELECT lat, lng, end_reason FROM connection_location_shares s JOIN connections c ON c.id = s.connection_id WHERE c.public_id = $1', [conn])).rows[0];
  assert.deepEqual(row, { lat: null, lng: null, end_reason: 'stopped' });
  assert.ok((await p.A.get('/api/notifications')).body.items.some((n: any) => n.kind === 'location_share_ended'));
  assert.equal((await p.C.post(`/api/connections/${conn}/location`, { lat: 1, lng: 1 })).status, 409, 'pings after stop are refused');
  assert.equal((await p.C.post(`/api/connections/${conn}/location/stop`, {})).status, 200, 'stop is idempotent');
  // closing the connection ends an active share at once
  assert.equal((await p.A.post(`/api/connections/${conn}/location/start`, { minutes: 60 })).status, 200);
  assert.equal((await p.A.post(`/api/connections/${conn}/location`, { lat: 36.2, lng: 37.1 })).status, 200);
  assert.equal((await p.C.post(`/api/connections/${conn}/close`, {})).status, 200);
  assert.equal((await p.C.get(`/api/connections/${conn}/location`)).body.theirs.position, null);
  assert.equal((await q('SELECT count(*)::int AS n FROM connection_location_shares s JOIN connections c ON c.id = s.connection_id WHERE c.public_id = $1 AND (s.lat IS NOT NULL OR s.ended_at IS NULL)', [conn])).rows[0].n, 0, 'close erased the coordinates');
  assert.equal((await p.A.post(`/api/connections/${conn}/location/start`, { minutes: 15 })).status, 409, 'no sharing in a closed connection');
});

test('location: a share expires on its own (short test duration) — unreadable at once, ended + notified by the expiry job', async () => {
  const fast = await extraApp(h, { routes: [makeConnectionsRoutes({ shareDurationMs: () => 1200 }), accountRoutes], featureRoutes: false });
  extra.push(fast);
  const p = await makePair('انتهاء');
  const conn = await connect(p);
  const A = p.A.on(fast); const C = p.C.on(fast);
  const st = await C.post(`/api/connections/${conn}/location/start`, { minutes: 15 });
  assert.equal(st.status, 200);
  assert.equal((await C.post(`/api/connections/${conn}/location`, { lat: 36.5, lng: 37.0 })).status, 200);
  assert.equal((await A.get(`/api/connections/${conn}/location`)).body.theirs.position.lat, 36.5);
  // the expiry job was scheduled for the share's end
  const job = (await q("SELECT run_at, payload FROM jobs WHERE kind = 'conn_location_end' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.ok(Math.abs(new Date(job.run_at).getTime() - Date.parse(st.body.share.expiresAt)) < 5, 'job runs at expiry');
  await sleep(1400);
  const a = (await A.get(`/api/connections/${conn}/location`)).body;
  assert.equal(a.theirs.active, false, 'expired shares are not shown even before any job ran');
  assert.equal(a.theirs.position, null);
  assert.equal((await C.post(`/api/connections/${conn}/location`, { lat: 36.6, lng: 37.1 })).status, 409);
  assert.equal(await endExpiredShares(h.db.pool, job.payload.shareId), 1);
  assert.equal(await endExpiredShares(h.db.pool, job.payload.shareId), 0, 'once');
  const ended = (await p.A.get('/api/notifications')).body.items.filter((n: any) => n.kind === 'location_share_ended');
  assert.equal(ended.length, 1);
  assert.match(ended[0].bodyAr, /انتهت المدة/);
  const row = (await q('SELECT lat, end_reason FROM connection_location_shares WHERE share_id = $1', [job.payload.shareId])).rows[0];
  assert.deepEqual(row, { lat: null, end_reason: 'expired' });
});

// ───────────── realms ─────────────

test('realm separation: a real and a synthetic user can never connect (contact and accept refused); synthetic pairs can', async () => {
  const A = client();
  const a = await registerWith(A, 'حقيقي');
  const sid = await mkPersona(h.db.pool, `conn_syn_${process.pid % 100000}`);
  const S = client();
  assert.equal((await S.post('/api/auth/demo-login', { handle: `conn_syn_${process.pid % 100000}` })).status, 200);
  const [aSeek] = await seedIntents(h, a.id, 'real', 1, { spec: electricianSpec(h, 'seek') });
  const [sOffer] = await seedIntents(h, sid, 'synthetic', 1, { spec: electricianSpec(h, 'provide') });
  // the engine never pairs realms — build such a match by hand to prove the connection layer refuses it too
  const ia = (await q('SELECT vertical_id, intent_id FROM intent_refs WHERE public_id = $1', [aSeek])).rows[0];
  const is = (await q('SELECT vertical_id, intent_id FROM intent_refs WHERE public_id = $1', [sOffer])).rows[0];
  const m = (await q(
    `INSERT INTO matches (vertical_id, kind, a_intent_id, b_intent_id, a_user_id, b_user_id, state, score, a_version, b_version, eval_seq)
     VALUES ($1, 'exchange', $2, $3, $4, $5, 'confirmed', 9000, 1, 1, nextval('match_eval_seq')) RETURNING id, public_id`,
    [ia.vertical_id, ia.intent_id, is.intent_id, a.id, sid])).rows[0];
  await q('INSERT INTO match_refs (public_id, vertical_id, match_id) VALUES ($1, $2, $3)', [m.public_id, ia.vertical_id, m.id]);
  const r = await S.post(`/api/matches/${m.public_id}/contact`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'realm_mismatch');
  const cr = (await q('INSERT INTO contact_requests (vertical_id, match_id, requester_id, recipient_id) VALUES ($1,$2,$3,$4) RETURNING public_id', [ia.vertical_id, m.id, sid, a.id])).rows[0];
  const acc = await A.post(`/api/contact-requests/${cr.public_id}/respond`, { accept: true });
  assert.equal(acc.status, 409);
  assert.equal(acc.body.error, 'realm_mismatch');
  assert.equal(await connCount(m.public_id), 0);
  assert.equal((await q('SELECT status FROM contact_requests WHERE public_id = $1', [cr.public_id])).rows[0].status, 'pending', 'rolled back');
  // two synthetic personas connect normally; the connection is labeled synthetic
  const s2 = await mkPersona(h.db.pool, `conn_syn2_${process.pid % 100000}`);
  const S2 = client();
  assert.equal((await S2.post('/api/auth/demo-login', { handle: `conn_syn2_${process.pid % 100000}` })).status, 200);
  const [s2Seek] = await seedIntents(h, s2, 'synthetic', 1, { spec: electricianSpec(h, 'seek') });
  assert.equal((await S.post(`/api/intents/${sOffer}/match`)).status, 200);
  const ms = (await q(
    `SELECT r.public_id FROM matches m JOIN match_refs r ON r.vertical_id = m.vertical_id AND r.match_id = m.id
       JOIN intent_refs i ON i.vertical_id = m.vertical_id AND i.intent_id = m.a_intent_id WHERE i.public_id = $1`, [s2Seek])).rows[0].public_id;
  const c2 = await S.post(`/api/matches/${ms}/contact`, {});
  assert.equal(c2.status, 200, c2.raw);
  const ok = await S2.post(`/api/contact-requests/${c2.body.contactRequest.id}/respond`, { accept: true });
  assert.equal(ok.status, 200);
  assert.equal((await S2.get(`/api/connections/${ok.body.connection.id}`)).body.connection.synthetic, true);
});

test('list: filters (open / closed / archived / all), newest activity first, exact totals', async () => {
  const p = await makePair('قائمة');
  const conn = await connect(p);
  const before = (await p.A.get('/api/connections?status=all')).body.total;
  assert.ok(before >= 1);
  const open = (await p.A.get('/api/connections?limit=1')).body;
  assert.equal(open.limit, 1);
  assert.equal(open.items[0].id, conn, 'newest activity first');
  assert.equal(open.items[0].unread, 0);
  await send(p.C, conn, 'مرحبا');
  assert.equal((await p.A.get('/api/connections?limit=1')).body.items[0].unread, 1);
  assert.equal((await p.A.get('/api/connections?status=nope')).status, 400);
  assert.equal((await p.A.get('/api/connections?cursor=%%%')).status, 400);
  await p.A.post(`/api/connections/${conn}/close`, {});
  assert.ok(!(await p.A.get('/api/connections')).body.items.some((x: any) => x.id === conn));
  assert.ok((await p.A.get('/api/connections?status=closed')).body.items.some((x: any) => x.id === conn));
  assert.equal((await p.A.get('/api/connections?status=all')).body.total, before);
});
