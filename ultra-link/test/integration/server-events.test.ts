// Live events over a real socket: SSE heartbeat, per-user isolation, ≤5 streams per user (429 beyond),
// LISTEN connection auto-reconnect with re-sync, and streams closed cleanly on shutdown.
import './server-env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { Client, harness, sleep, type Harness } from './server-helpers.ts';
import { notify } from '../../src/repo/notifications.ts';

let h: Harness;
let base: string;
let A: Client; let B: Client;
let aId: string; let bId: string;

interface Stream { status: number; headers: IncomingMessage['headers']; text: () => string; ended: () => boolean; close: () => void; body: () => any }

function open(cookie: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/events`, { headers: { cookie, accept: 'text/event-stream' } }, (res) => {
      let buf = '';
      let ended = false;
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { ended = true; });
      res.on('close', () => { ended = true; });
      resolve({ status: res.statusCode!, headers: res.headers, text: () => buf, ended: () => ended, close: () => req.destroy(), body: () => JSON.parse(buf) });
    });
    req.on('error', (e) => { if ((e as { code?: string }).code !== 'ECONNRESET') reject(e); });
    req.end();
  });
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

before(async () => {
  h = await harness('events', { listen: true, sse: { heartbeatMs: 100, reconnectMinMs: 50, reconnectMaxMs: 200 } });
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.app.server.address() as { port: number }).port}`;
  A = new Client(h); B = new Client(h);
  aId = (await A.register('مستمع أ')).id;
  bId = (await B.register('مستمع ب')).id;
  await until(() => h.app.ul.events.stats.connected, 3000, 'LISTEN connection');
});
after(async () => { await h?.close(); });

test('stream: headers, initial counts, heartbeat comments, per-user delivery only', async () => {
  const a = await open(A.cookie);
  const b = await open(B.cookie);
  try {
    assert.equal(a.status, 200);
    assert.match(String(a.headers['content-type']), /^text\/event-stream/);
    assert.equal(a.headers['cache-control'], 'no-cache, no-transform');
    await until(() => a.text().includes('event: counts'), 2000, 'initial counts');
    assert.ok(a.text().startsWith('retry: 3000'));
    await until(() => (a.text().match(/: ping/g) ?? []).length >= 2, 2000, 'two heartbeats');
    await notify(h.db.pool, { recipientId: aId, kind: 'test', titleAr: 'تنبيه', dedupeKey: 'sse:1' });
    await until(() => a.text().includes('event: notification'), 2000, 'notification event');
    const last = a.text().split('event: counts\ndata: ').pop()!.split('\n')[0]!;
    assert.equal(JSON.parse(last).unread, 1, 'counts follow the notification');
    await sleep(150);
    assert.ok(!b.text().includes('event: notification'), 'B never sees A\'s events');
  } finally { a.close(); b.close(); }
});

test('at most 5 concurrent streams per user (429 + Retry-After beyond), freed when one closes', async () => {
  await until(() => h.app.ul.events.openFor(aId) === 0, 2000, 'previous streams released');
  const streams: Stream[] = [];
  try {
    for (let i = 0; i < 5; i++) { const s = await open(A.cookie); assert.equal(s.status, 200, `stream ${i + 1}`); streams.push(s); }
    const sixth = await open(A.cookie);
    await until(() => sixth.ended(), 2000, 'sixth response');
    assert.equal(sixth.status, 429);
    assert.equal(sixth.headers['retry-after'], '30');
    assert.equal(sixth.body().error, 'too_many_streams');
    const other = await open(B.cookie);
    assert.equal(other.status, 200, 'another user is not affected');
    other.close();
    streams.shift()!.close();
    await until(() => h.app.ul.events.openFor(aId) === 4, 2000, 'closed stream released');
    const again = await open(A.cookie);
    assert.equal(again.status, 200);
    streams.push(again);
    const anon = await open('');
    await until(() => anon.ended(), 2000, 'anonymous response');
    assert.equal(anon.status, 401);
  } finally { for (const s of streams) s.close(); }
});

test('LISTEN connection killed → reconnects with backoff, re-syncs open streams, keeps delivering', async () => {
  const a = await open(A.cookie);
  try {
    await until(() => a.text().includes('event: counts'), 2000, 'initial counts');
    const ev = h.app.ul.events;
    const pid = ev.listenerPid;
    assert.ok(pid, 'listener connected');
    const reconnects = ev.stats.reconnects;
    const before = (a.text().match(/event: counts/g) ?? []).length;
    await h.db.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await until(() => ev.stats.reconnects === reconnects + 1 && ev.stats.connected, 5000, 'reconnect');
    assert.notEqual(ev.listenerPid, pid, 'a new backend');
    await until(() => (a.text().match(/event: counts/g) ?? []).length > before, 2000, 'resync after reconnect');
    const hl = (await A.get('/api/health')).body;
    assert.equal(hl.events.connected, true);
    assert.equal(hl.events.reconnects, reconnects + 1);
    await notify(h.db.pool, { recipientId: aId, kind: 'test', titleAr: 'بعد الانقطاع', dedupeKey: 'sse:after-reconnect' });
    await until(() => (a.text().match(/event: notification/g) ?? []).length >= 1, 2000, 'delivery after reconnect');
  } finally { a.close(); }
});

test('shutdown: open streams get "event: shutdown" and end; close() does not hang on them; LISTEN closed', async () => {
  const streams = [await open(A.cookie), await open(A.cookie), await open(B.cookie)];
  await until(() => streams.every((s) => s.text().includes('event: counts')), 2000, 'streams ready');
  const t0 = Date.now();
  await h.app.close();
  const took = Date.now() - t0;
  await until(() => streams.every((s) => s.ended()), 2000, 'streams ended');
  for (const s of streams) assert.ok(s.text().includes('event: shutdown'), 'clients are told to reconnect elsewhere');
  assert.ok(took < 3000, `close took ${took} ms`);
  assert.equal(h.app.ul.events.stats.connected, false);
  assert.equal(h.app.ul.events.listenerPid, null);
  const { rows } = await h.db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'ul-events-listener' AND datname = current_database()");
  await until(async () => (await h.db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'ul-events-listener' AND datname = current_database()")).rows[0].n === 0, 2000, 'listener backend gone');
  assert.ok(rows[0].n <= 1);
  assert.ok(!h.app.ul.events.admit(bId), 'no new streams while closing');
});
