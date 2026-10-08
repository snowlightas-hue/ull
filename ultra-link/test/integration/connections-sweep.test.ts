// Auto-archive sweep and connection jobs (worker path). Owner: connections role.
//   archive 14 days after both intents ended, or after 30 days without messages; blocked stays blocked; a fresh
//   message wins over a stale candidate; the sweep job runs through the worker's runJob and reschedules itself.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, electricianSpec, harness, seedIntents, type Harness } from './server-helpers.ts';
import connectionsRoutes from '../../src/server/routes/connections.ts';
import accountRoutes from '../../src/server/routes/account.ts';
import { sweepConnections, CONN_SWEEP_KIND } from '../../src/connections/jobs.ts';
import { processNext } from '../../src/worker/main.ts';
import { enqueue } from '../../src/repo/jobs.ts';

let h: Harness;
before(async () => { h = await harness(`conn_sweep_${process.pid}`, { routes: [connectionsRoutes, accountRoutes], featureRoutes: false }); });
after(async () => { await h?.close(); });

let ipSeq = 10;
const client = () => new Client(h, `10.47.0.${ipSeq++}`);
const q = (sql: string, params: unknown[] = []) => h.db.pool.query(sql, params);

interface Conn { id: string; A: Client; C: Client; aIntent: string; cIntent: string }

/** Two real users with an electrician request/offer (direct inserts), contact asked by C, accepted by A. */
async function makeConnection(tag: string): Promise<Conn> {
  const A = client(); const C = client();
  const a = await A.register(`طالب ${tag}`);
  const c = await C.register(`كهربجي ${tag}`);
  const [aIntent] = await seedIntents(h, a.id, 'real', 1, { spec: electricianSpec(h, 'seek') });
  const [cIntent] = await seedIntents(h, c.id, 'real', 1, { spec: electricianSpec(h, 'provide') });
  assert.equal((await C.post(`/api/intents/${cIntent}/match`)).status, 200);
  const m = (await q(
    `SELECT r.public_id FROM matches m JOIN match_refs r ON r.vertical_id = m.vertical_id AND r.match_id = m.id
      WHERE m.a_user_id = $1 AND m.b_user_id = $2`, [a.id, c.id])).rows[0].public_id;
  const cr = await C.post(`/api/matches/${m}/contact`, {});
  const acc = await A.post(`/api/contact-requests/${cr.body.contactRequest.id}/respond`, { accept: true });
  assert.equal(acc.status, 200, acc.raw);
  return { id: acc.body.connection.id, A, C, aIntent: aIntent!, cIntent: cIntent! };
}

const status = async (id: string) => (await q('SELECT status, status_reason FROM connections WHERE public_id = $1', [id])).rows[0];
const backdate = (id: string, days: number) => q(`UPDATE connections SET activity_at = now() - make_interval(days => $2) WHERE public_id = $1`, [id, days]);
async function endIntent(c: Client, intentId: string, action: 'close' | 'fulfill', daysAgo: number) {
  assert.equal((await c.post(`/api/intents/${intentId}/status`, { action })).status, 200);
  await q('UPDATE intents i SET closed_at = now() - make_interval(days => $2) FROM intent_refs r WHERE r.public_id = $1 AND i.vertical_id = r.vertical_id AND i.id = r.intent_id', [intentId, daysAgo]);
}

test('accepting a contact schedules the archive sweep (next slot, deduplicated)', async () => {
  await makeConnection('جدولة');
  await makeConnection('جدولة٢');
  const jobs = (await q("SELECT dedupe_key, run_at FROM jobs WHERE kind = $1 AND status = 'pending'", [CONN_SWEEP_KIND])).rows;
  assert.equal(jobs.length, 1, 'one pending sweep however many connections open');
  assert.ok(new Date(jobs[0].run_at).getTime() > Date.now(), 'in the future');
});

test('auto-archive: 14 days after both intents ended, or 30 days without messages; otherwise untouched', async () => {
  const idle = await makeConnection('خامل');           await backdate(idle.id, 31);
  const notIdle = await makeConnection('نشط');        await backdate(notIdle.id, 29);
  const bothDone = await makeConnection('منتهي');
  await endIntent(bothDone.A, bothDone.aIntent, 'fulfill', 15); await endIntent(bothDone.C, bothDone.cIntent, 'close', 16);
  const oneDone = await makeConnection('نصف');
  await endIntent(oneDone.A, oneDone.aIntent, 'close', 40);
  const tooRecent = await makeConnection('حديث');
  await endIntent(tooRecent.A, tooRecent.aIntent, 'close', 20); await endIntent(tooRecent.C, tooRecent.cIntent, 'close', 13);
  const blocked = await makeConnection('محظور');
  assert.equal((await blocked.A.post(`/api/connections/${blocked.id}/block`, {})).status, 200);
  await backdate(blocked.id, 90);
  const closedIdle = await makeConnection('مغلق');
  assert.equal((await closedIdle.C.post(`/api/connections/${closedIdle.id}/close`, {})).status, 200);
  await backdate(closedIdle.id, 45);
  // a live share in the idle one is ended with it
  assert.equal((await idle.A.post(`/api/connections/${idle.id}/location/start`, { minutes: 30 })).status, 200);
  assert.equal((await idle.A.post(`/api/connections/${idle.id}/location`, { lat: 36.1, lng: 37.2 })).status, 200);

  const r = await sweepConnections(h.db.pool);
  assert.ok(r.archived >= 3, JSON.stringify(r));
  assert.deepEqual(await status(idle.id), { status: 'archived', status_reason: 'idle' });
  assert.deepEqual(await status(bothDone.id), { status: 'archived', status_reason: 'intents_done' });
  assert.deepEqual(await status(closedIdle.id), { status: 'archived', status_reason: 'idle' });
  assert.equal((await status(notIdle.id)).status, 'open');
  assert.equal((await status(oneDone.id)).status, 'open');
  assert.equal((await status(tooRecent.id)).status, 'open');
  assert.deepEqual(await status(blocked.id), { status: 'blocked', status_reason: 'blocked_by_user' });
  // archived: readable, listed under "archived", nothing can be sent or shared; the share is gone
  const d = (await idle.C.get(`/api/connections/${idle.id}`)).body.connection;
  assert.equal(d.status, 'archived');
  assert.equal(d.canSend, false);
  assert.equal(d.them.location.active, false);
  assert.equal((await q('SELECT lat FROM connection_location_shares s JOIN connections c ON c.id = s.connection_id WHERE c.public_id = $1', [idle.id])).rows[0].lat, null);
  assert.equal((await idle.A.post(`/api/connections/${idle.id}/messages`, { text: 'مرحبا', clientMsgId: randomUUID() })).status, 409);
  assert.ok((await idle.A.get('/api/connections?status=archived')).body.items.some((x: any) => x.id === idle.id));
  // idempotent
  const again = await sweepConnections(h.db.pool);
  assert.equal(again.archived, 0);
});

test('a message that arrives after the connection became a candidate keeps it open (conditions re-checked in the UPDATE)', async () => {
  const c = await makeConnection('رسالة');
  await backdate(c.id, 31);
  assert.equal((await c.A.post(`/api/connections/${c.id}/messages`, { text: 'لسا مهتم؟', clientMsgId: randomUUID() })).status, 200);
  await sweepConnections(h.db.pool);
  assert.equal((await status(c.id)).status, 'open');
});

test('worker: conn_sweep runs through runJob/processNext and schedules the next slot; unknown conn_ kinds fail loudly', async () => {
  const c = await makeConnection('عامل');
  await backdate(c.id, 60);
  await q("UPDATE jobs SET status = 'done' WHERE kind = $1 AND status = 'pending'", [CONN_SWEEP_KIND]);
  await enqueue(h.db.pool, CONN_SWEEP_KIND, {}, { dedupeKey: 'conn_sweep:test-now' });
  const p = await processNext(h.db.pool, h.db.reg, 'test-worker', { kinds: [CONN_SWEEP_KIND] });
  assert.ok(p, 'claimed');
  assert.equal(p!.outcome, 'done', p!.error);
  assert.equal((await status(c.id)).status, 'archived');
  const next = (await q("SELECT dedupe_key, run_at FROM jobs WHERE kind = $1 AND status = 'pending'", [CONN_SWEEP_KIND])).rows;
  assert.equal(next.length, 1, 'rescheduled itself while connections remain');
  assert.ok(new Date(next[0].run_at).getTime() > Date.now());
  await enqueue(h.db.pool, 'conn_unknown', {}, { maxAttempts: 1 });
  const bad = await processNext(h.db.pool, h.db.reg, 'test-worker', { kinds: ['conn_unknown'] });
  assert.equal(bad!.outcome, 'failed');
  assert.match(bad!.error!, /unknown job kind/);
});

test('worker: conn_location_end ends the share at expiry (coordinates erased, counterpart told once)', async () => {
  const c = await makeConnection('مدة');
  assert.equal((await c.C.post(`/api/connections/${c.id}/location/start`, { minutes: 15 })).status, 200);
  assert.equal((await c.C.post(`/api/connections/${c.id}/location`, { lat: 36.3, lng: 37.3 })).status, 200);
  const share = (await q("SELECT s.share_id FROM connection_location_shares s JOIN connections c ON c.id = s.connection_id WHERE c.public_id = $1", [c.id])).rows[0].share_id;
  // time passes: the share is now past its end, and its job is due
  await q("UPDATE connection_location_shares SET started_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute' WHERE share_id = $1", [share]);
  await q("UPDATE jobs SET run_at = now() WHERE kind = 'conn_location_end' AND payload->>'shareId' = $1", [share]);
  const p = await processNext(h.db.pool, h.db.reg, 'test-worker', { kinds: ['conn_location_end'] });
  assert.equal(p!.outcome, 'done', p!.error);
  const row = (await q('SELECT lat, end_reason FROM connection_location_shares WHERE share_id = $1', [share])).rows[0];
  assert.deepEqual(row, { lat: null, end_reason: 'expired' });
  const notes = (await c.A.get('/api/notifications')).body.items.filter((n: any) => n.kind === 'location_share_ended');
  assert.equal(notes.length, 1);
  // a stale job for a share that was restarted meanwhile is a no-op
  assert.equal((await c.C.post(`/api/connections/${c.id}/location/start`, { minutes: 15 })).status, 200);
  await enqueue(h.db.pool, 'conn_location_end', { shareId: share }, { dedupeKey: `stale:${share}` });
  const p2 = await processNext(h.db.pool, h.db.reg, 'test-worker', { kinds: ['conn_location_end'] });
  assert.equal(p2!.outcome, 'done');
  assert.equal((await c.A.get(`/api/connections/${c.id}/location`)).body.theirs.active, true, 'the new share is untouched');
});
