// Live chat delivery over the existing SSE hub (real socket, LISTEN/NOTIFY) and the per-session message rate limit.
// Owner: connections role. The hub carries only event names + counts: clients fetch the new messages themselves
// (GET …/messages?after=seq), so no message text or coordinates ever travel through NOTIFY.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { Client, electricianSpec, harness, seedIntents, sleep, type Harness } from './server-helpers.ts';
import connectionsRoutes from '../../src/server/routes/connections.ts';
import accountRoutes from '../../src/server/routes/account.ts';

let h: Harness;
let base: string;
before(async () => {
  h = await harness(`conn_live_${process.pid}`, { routes: [connectionsRoutes, accountRoutes], featureRoutes: false, listen: true, sse: { heartbeatMs: 1000 } });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.app.server.address() as { port: number }).port}`;
  const t0 = Date.now();
  while (!h.app.ul.events.stats.connected) { if (Date.now() - t0 > 3000) throw new Error('LISTEN not connected'); await sleep(20); }
});
after(async () => { await h?.close(); });

let ipSeq = 10;
const client = () => new Client(h, `10.48.0.${ipSeq++}`);

function stream(cookie: string): Promise<{ text: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/events`, { headers: { cookie, accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      resolve({ text: () => buf, close: () => req.destroy() });
    });
    req.on('error', (e) => { if ((e as { code?: string }).code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}
async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
}

async function connected(): Promise<{ A: Client; C: Client; B: Client; conn: string }> {
  const A = client(); const C = client(); const B = client();
  const a = await A.register('سارة'); const c = await C.register('خالد'); await B.register('غريب');
  await seedIntents(h, a.id, 'real', 1, { spec: electricianSpec(h, 'seek') });
  const [offer] = await seedIntents(h, c.id, 'real', 1, { spec: electricianSpec(h, 'provide') });
  await C.post(`/api/intents/${offer}/match`);
  const m = (await h.db.pool.query(`SELECT r.public_id FROM matches m JOIN match_refs r ON r.vertical_id = m.vertical_id AND r.match_id = m.id WHERE m.a_user_id = $1 AND m.b_user_id = $2`, [a.id, c.id])).rows[0].public_id;
  const cr = await C.post(`/api/matches/${m}/contact`, {});
  const acc = await A.post(`/api/contact-requests/${cr.body.contactRequest.id}/respond`, { accept: true });
  return { A, C, B, conn: acc.body.connection.id };
}

test('SSE: a message reaches the counterpart live (conn_message + counts), read receipts and pings too; strangers get nothing', async () => {
  const { A, C, B, conn } = await connected();
  const sa = await stream(A.cookie); const sc = await stream(C.cookie); const sb = await stream(B.cookie);
  try {
    await until(() => sa.text().includes('event: counts') && sc.text().includes('event: counts') && sb.text().includes('event: counts'), 'initial counts');
    const text = 'نص سري لا يمر عبر الإشعارات';
    assert.equal((await C.post(`/api/connections/${conn}/messages`, { text, clientMsgId: randomUUID() })).status, 200);
    await until(() => sa.text().includes('event: conn_message'), 'A gets conn_message');
    // the event carries counts only — A then fetches the message
    assert.ok(!sa.text().includes(text), 'no message text on the event stream');
    const got = (await A.get(`/api/connections/${conn}/messages?after=0`)).body.items;
    assert.equal(got[0].text, text);
    // A reads → C's stream gets conn_update (its "read" ticks)
    await A.post(`/api/connections/${conn}/read`, { seq: 1 });
    await until(() => sc.text().includes('event: conn_update'), 'C gets the read receipt event');
    // a position ping → conn_location for A, without coordinates in the stream
    await C.post(`/api/connections/${conn}/location/start`, { minutes: 15 });
    await C.post(`/api/connections/${conn}/location`, { lat: 36.58612, lng: 37.04411 });
    await until(() => sa.text().includes('event: conn_location'), 'A gets conn_location');
    assert.ok(!sa.text().includes('36.586'), 'no coordinates on the event stream');
    await sleep(150);
    assert.ok(!/conn_(message|update|location)/.test(sb.text()), 'the stranger receives none of it');
  } finally { sa.close(); sc.close(); sb.close(); }
});

test('rate limit: 30 messages per minute per session → 429 + Retry-After; a refused message is not stored', async () => {
  const { A, conn } = await connected();
  for (let i = 0; i < 30; i++) assert.equal((await A.post(`/api/connections/${conn}/messages`, { text: `رسالة ${i}`, clientMsgId: randomUUID() })).status, 200, `message ${i}`);
  const r = await A.post(`/api/connections/${conn}/messages`, { text: 'كثير', clientMsgId: randomUUID() });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'rate_limited');
  assert.ok(Number(r.headers['retry-after']) >= 1);
  assert.equal((await A.get(`/api/connections/${conn}/messages?limit=1`)).body.total, 30);
});
