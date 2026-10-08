// Job queue (isolated DB): dedupe while pending, SKIP LOCKED exclusivity, lease recovery and fencing,
// exponential backoff, max_attempts → failed (also for workers that crash every time), superseded jobs,
// and the worker iteration (processNext) that ties claim → run → complete / fail together.
import { after, before, test } from 'node:test';
import pg from 'pg';
import assert from 'node:assert/strict';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { withTx } from '../../src/db/pool.ts';
import { backoffSeconds, claim, complete, enqueue, fail, type Job } from '../../src/repo/jobs.ts';
import { createIntent } from '../../src/repo/intents.ts';
import { processNext, runJob } from '../../src/worker/main.ts';

let db: TestDb;
// per-process database name: a concurrent run of the whole suite cannot drop ours
before(async () => { db = await freshDb(`r6_jobs_${process.pid}`); });
after(async () => {
  await db?.close();
  if (!db) return;
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`); } finally { await a.end(); }
});

const job = async (id: string) => (await db.pool.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
const expireLease = (id: string) => db.pool.query("UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1", [id]);
const makeDue = (id: string) => db.pool.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1", [id]);
// every test claims only its own kind, so tests never steal each other's jobs
const K = (name: string) => `test_${name}`;

test('dedupe: a pending or running job with the same key is not enqueued twice; a finished one is', async () => {
  const kind = K('dedupe');
  const a = await enqueue(db.pool, kind, { n: 1 }, { dedupeKey: 'dk-1' });
  assert.ok(a);
  assert.equal(await enqueue(db.pool, kind, { n: 2 }, { dedupeKey: 'dk-1' }), null);
  const c = await claim(db.pool, 'w1', 60, [kind]);
  assert.equal(c?.id, a);
  assert.equal(await enqueue(db.pool, kind, { n: 3 }, { dedupeKey: 'dk-1' }), null, 'still deduped while running');
  assert.ok(await complete(db.pool, c!, 'done'));
  const b = await enqueue(db.pool, kind, { n: 4 }, { dedupeKey: 'dk-1' });
  assert.ok(b && b !== a);
  assert.ok(await enqueue(db.pool, kind, { n: 5 }), 'no key → never deduped');
  assert.ok(await enqueue(db.pool, kind, { n: 6 }));
});

test('SKIP LOCKED: concurrent workers never claim the same job', async () => {
  const kind = K('concurrent');
  const ids = new Set<string>();
  for (let i = 0; i < 40; i++) ids.add((await enqueue(db.pool, kind, { i }))!);
  const claimed: string[] = [];
  await Promise.all(Array.from({ length: 8 }, async (_, w) => {
    for (;;) {
      const j = await claim(db.pool, `w${w}`, 60, [kind]);
      if (!j) break;
      claimed.push(j.id);
      await complete(db.pool, j, 'done');
    }
  }));
  assert.equal(claimed.length, 40);
  assert.deepEqual(new Set(claimed), ids);
});

test('lease recovery: an expired running job is reclaimed, and the old holder can no longer finish it', async () => {
  const kind = K('lease');
  const id = (await enqueue(db.pool, kind, {}))!;
  const first = (await claim(db.pool, 'crashed', 30, [kind]))!;
  assert.equal(first.attempts, 1);
  assert.equal(await claim(db.pool, 'other', 30, [kind]), null, 'leased job is not claimable');
  await expireLease(id);
  const second = (await claim(db.pool, 'rescuer', 30, [kind]))!;
  assert.equal(second.id, id);
  assert.equal(second.attempts, 2);
  assert.equal((await job(id)).locked_by, 'rescuer');
  // the first worker wakes up late: fenced out
  assert.equal(await complete(db.pool, first, 'done'), false);
  assert.equal(await fail(db.pool, first, new Error('late')), false);
  assert.equal((await job(id)).status, 'running');
  assert.ok(await complete(db.pool, second, 'done', { ok: true }));
  const fin = await job(id);
  assert.equal(fin.status, 'done');
  assert.deepEqual(fin.result, { ok: true });
  assert.equal(fin.locked_by, null);
});

test('retry backoff is exponential and a job is not claimable before run_at', async () => {
  const kind = K('backoff');
  assert.deepEqual([1, 2, 3, 4, 8, 9, 20].map(backoffSeconds), [2, 4, 8, 16, 256, 300, 300]);
  const id = (await enqueue(db.pool, kind, {}))!;
  let j = (await claim(db.pool, 'w', 60, [kind]))!;
  assert.ok(await fail(db.pool, j, new Error('boom 1')));
  let row = await job(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.last_error, 'boom 1');
  const delay1 = (new Date(row.run_at).getTime() - Date.now()) / 1000;
  assert.ok(delay1 > 0.5 && delay1 <= 2.5, `first retry after ~2 s, got ${delay1}`);
  assert.equal(await claim(db.pool, 'w', 60, [kind]), null, 'not due yet');
  await makeDue(id);
  j = (await claim(db.pool, 'w', 60, [kind]))!;
  assert.equal(j.attempts, 2);
  await fail(db.pool, j, new Error('boom 2'));
  row = await job(id);
  const delay2 = (new Date(row.run_at).getTime() - Date.now()) / 1000;
  assert.ok(delay2 > 2.5 && delay2 <= 4.5, `second retry after ~4 s, got ${delay2}`);
});

test('max_attempts → failed (explicit failures)', async () => {
  const kind = K('max');
  const id = (await enqueue(db.pool, kind, {}, { maxAttempts: 2 }))!;
  for (let i = 1; i <= 2; i++) {
    await makeDue(id);
    const j = (await claim(db.pool, 'w', 60, [kind]))!;
    assert.equal(j.attempts, i);
    await fail(db.pool, j, new Error(`e${i}`));
  }
  const row = await job(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.last_error, 'e2');
  assert.ok(row.finished_at);
  await makeDue(id);
  assert.equal(await claim(db.pool, 'w', 60, [kind]), null);
});

test('max_attempts → failed (a worker that crashes every time: only leases expire)', async () => {
  const kind = K('crashloop');
  const id = (await enqueue(db.pool, kind, {}, { maxAttempts: 2 }))!;
  for (let i = 1; i <= 2; i++) {
    const j = (await claim(db.pool, `crash${i}`, 30, [kind]))!;
    assert.equal(j.attempts, i);
    await expireLease(id); // the worker died without complete()/fail()
  }
  assert.equal(await claim(db.pool, 'w', 30, [kind]), null);
  const row = await job(id);
  assert.equal(row.status, 'failed');
  assert.match(row.last_error, /lease expired after 2 attempts/);
});

test('worker: match_intent for an old version is superseded; the current one runs once', async () => {
  const reg = db.reg;
  const u1 = await mkUser(db.pool, 'باحث');
  const u2 = await mkUser(db.pool, 'مؤجر');
  const azaz = reg.placeByCode.get('sy.aleppo.azaz')!.id;
  const s = await withTx(db.pool, (tx) => createIntent(tx, reg, { userId: u1, realm: 'synthetic', titleAr: 'بدي شقة', sourceText: null, conversationId: null, spec: {
    side: 'seek', categoryCode: 'real_estate.apartment', deal: 'rent', place: { pointPlaceId: null, scopePlaceIds: [azaz], scopeStrength: 'required', excludePlaceIds: [] },
    price: { op: 'lte', lo: null, hi: '20000', currency: 'USD', unit: 'month', strength: 'required' }, when: null, attrs: {}, constraints: [] } }));
  await withTx(db.pool, (tx) => createIntent(tx, reg, { userId: u2, realm: 'synthetic', titleAr: 'شقة', sourceText: null, conversationId: null, spec: {
    side: 'provide', categoryCode: 'real_estate.apartment', deal: 'rent', place: { pointPlaceId: azaz, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] },
    price: { op: 'eq', lo: '20000', hi: '20000', currency: 'USD', unit: 'month', strength: 'required' }, when: null, attrs: {}, constraints: [] } }));
  const kind = 'match_intent';
  const key = `match:${s.verticalId}:${s.id}:${s.version}`;
  const id = (await enqueue(db.pool, kind, { verticalId: s.verticalId, intentId: s.id, version: s.version, trigger: 'job' }, { dedupeKey: key }))!;
  assert.equal(await enqueue(db.pool, kind, { verticalId: s.verticalId, intentId: s.id, version: s.version, trigger: 'job' }, { dedupeKey: key }), null);
  const j = (await claim(db.pool, 'w', 60, [kind]))!;
  assert.equal(j.id, id);
  assert.equal(await runJob(db.pool, reg, j), 'done');
  assert.ok(await complete(db.pool, j, 'done'));
  assert.equal(Number((await db.pool.query("SELECT count(*) n FROM matches WHERE a_intent_id = $1 AND state = 'confirmed'", [s.id])).rows[0].n), 1);
  const runs = async () => Number((await db.pool.query('SELECT count(*) n FROM match_runs WHERE intent_id = $1', [s.id])).rows[0].n);
  assert.equal(await runs(), 1);
  assert.equal(await runJob(db.pool, reg, j), 'done', 'repeat is a no-op');
  assert.equal(await runs(), 1);
  // a newer version makes the old job superseded
  await db.pool.query('UPDATE intents SET version = version + 1 WHERE id = $1', [s.id]);
  const old: Job = { ...j, id: (await enqueue(db.pool, kind, { verticalId: s.verticalId, intentId: s.id, version: s.version, trigger: 'job' }))! };
  const c = (await claim(db.pool, 'w', 60, [kind]))!;
  assert.equal(c.id, old.id);
  const status = await runJob(db.pool, reg, c);
  assert.equal(status, 'superseded');
  assert.ok(await complete(db.pool, c, status));
  assert.equal((await job(old.id)).status, 'superseded');
  assert.equal(await runs(), 1);
  await assert.rejects(runJob(db.pool, reg, { ...c, kind: 'nope' }), /unknown job kind/);
});

test('worker iteration: success completes with a result; a throwing job backs off, retries and ends failed at max_attempts', async () => {
  // success (expire_sweep with nothing to expire)
  const okId = (await enqueue(db.pool, 'expire_sweep', {}, { dedupeKey: 'test-expire-sweep' }))!;
  const p1 = (await processNext(db.pool, db.reg, 'w-ok', { kinds: ['expire_sweep'] }))!;
  assert.equal(p1.job.id, okId);
  assert.equal(p1.outcome, 'done');
  const done = await job(okId);
  assert.equal(done.status, 'done');
  assert.equal(typeof done.result.ms, 'number');
  assert.equal(await processNext(db.pool, db.reg, 'w-ok', { kinds: ['expire_sweep'] }), null, 'nothing left');

  // failure: runJob throws for an unknown kind → retry with exponential backoff → failed at max_attempts
  const kind = K('worker_boom');
  const id = (await enqueue(db.pool, kind, {}, { maxAttempts: 3 }))!;
  for (let i = 1; i <= 3; i++) {
    await makeDue(id);
    const p = (await processNext(db.pool, db.reg, `w${i}`, { kinds: [kind] }))!;
    assert.equal(p.job.id, id);
    assert.equal(p.job.attempts, i);
    assert.equal(p.outcome, i < 3 ? 'retry' : 'failed');
    assert.match(p.error!, /unknown job kind/);
    const row = await job(id);
    assert.equal(row.status, i < 3 ? 'pending' : 'failed');
    assert.match(row.last_error, /unknown job kind/);
    assert.equal(row.locked_by, null);
    if (i < 3) {
      const delay = (new Date(row.run_at).getTime() - Date.now()) / 1000;
      assert.ok(delay > backoffSeconds(i) - 1.5 && delay <= backoffSeconds(i) + 0.5, `attempt ${i}: retry after ~${backoffSeconds(i)} s, got ${delay}`);
      assert.equal(await processNext(db.pool, db.reg, 'eager', { kinds: [kind] }), null, 'not claimable during backoff');
    } else {
      assert.ok(row.finished_at);
    }
  }
  await makeDue(id);
  assert.equal(await processNext(db.pool, db.reg, 'w', { kinds: [kind] }), null, 'a failed job is never claimed again');
});
