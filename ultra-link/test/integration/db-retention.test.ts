// Retention job (src/db/retention.ts) on an isolated database: exactly the rows past their policy are deleted, in
// bounded id windows; the newest match run of every intent survives; a dry run counts the same rows and deletes none.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { withTx } from '../../src/db/pool.ts';
import { createIntent } from '../../src/repo/intents.ts';
import { runRetention } from '../../src/db/retention.ts';

let db: TestDb;
before(async () => { db = await freshDb(`r5_retention_${process.pid}`); });
after(async () => {
  await db?.close();
  if (!db) return;
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`); } finally { await a.end(); }
});

const ago = (days: number) => `now() - interval '${days} days'`;

test('retention deletes exactly what the policy says, in windows, and a dry run matches it without deleting', async () => {
  const p = db.pool;
  const u = await mkUser(p, 'retention');
  // notifications: 250 read & 100 days old (deleted, spans several 100-id windows), unread 100 days (kept),
  // unread 200 days (deleted), read 10 days (kept)
  await p.query(`INSERT INTO notifications (recipient_id, kind, title_ar, dedupe_key, created_at, read_at)
                 SELECT $1, 'k', 't', 'old-read-' || g, ${ago(100)}, ${ago(99)} FROM generate_series(1, 250) g`, [u]);
  await p.query(`INSERT INTO notifications (recipient_id, kind, title_ar, dedupe_key, created_at, read_at) VALUES
                 ($1, 'k', 't', 'old-unread', ${ago(100)}, NULL), ($1, 'k', 't', 'ancient-unread', ${ago(200)}, NULL), ($1, 'k', 't', 'recent-read', ${ago(10)}, ${ago(9)})`, [u]);
  // jobs
  await p.query(`INSERT INTO jobs (kind, status, created_at, finished_at) VALUES
                 ('a', 'done', ${ago(12)}, ${ago(10)}), ('b', 'done', ${ago(3)}, ${ago(2)}), ('c', 'superseded', ${ago(9)}, NULL),
                 ('d', 'failed', ${ago(41)}, ${ago(40)}), ('e', 'failed', ${ago(11)}, ${ago(10)}), ('f', 'pending', ${ago(90)}, NULL)`);
  // match runs: three old runs of one intent (the newest of them must survive) + one recent run of another
  const mk = async (t: string) => withTx(p, (tx) => createIntent(tx, db.reg, { userId: u, realm: 'synthetic', titleAr: t, sourceText: null, conversationId: null,
    spec: { side: 'provide', categoryCode: 'vehicles.car', deal: 'sale', place: { pointPlaceId: null, scopePlaceIds: [], scopeStrength: 'required' }, price: null, when: null, attrs: {}, constraints: [] } }));
  const [i1, i2] = [await mk('a'), await mk('b')];
  for (const [k, days] of [[1, 50], [2, 45], [3, 40]] as const) {
    await p.query(`INSERT INTO match_runs (vertical_id, intent_id, intent_version, eval_seq, candidates, confirmed, possible, excluded, trigger, created_at)
                   VALUES ($1, $2, 1, $3, 0, 0, 0, 0, 'job', ${ago(days)})`, [i1.verticalId, i1.id, k]);
  }
  await p.query(`INSERT INTO match_runs (vertical_id, intent_id, intent_version, eval_seq, candidates, confirmed, possible, excluded, trigger, created_at)
                 VALUES ($1, $2, 1, 9, 0, 0, 0, 0, 'job', ${ago(5)})`, [i2.verticalId, i2.id]);
  // extraction runs and sessions
  await p.query(`INSERT INTO extraction_runs (engine, input_hash, output, validated, created_at) VALUES
                 ('rules', sha256('a'::bytea), '{}', true, ${ago(200)}), ('rules', sha256('b'::bytea), '{}', true, ${ago(10)})`);
  await p.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES
                 (sha256('s1'::bytea), $1, ${ago(2)}), (sha256('s2'::bytea), $1, now() - interval '1 hour'), (sha256('s3'::bytea), $1, now() + interval '5 days')`, [u]);

  const count = async () => (await p.query(`SELECT (SELECT count(*) FROM notifications)::int AS n, (SELECT count(*) FROM jobs)::int AS j,
      (SELECT count(*) FROM match_runs)::int AS m, (SELECT count(*) FROM extraction_runs)::int AS e, (SELECT count(*) FROM sessions)::int AS s`)).rows[0];
  const before = await count();
  const dry = await runRetention(p, { dryRun: true, batch: 100 });
  assert.deepEqual(await count(), before, 'dry run deletes nothing');
  const real = await runRetention(p, { batch: 100 });
  const deleted = Object.fromEntries(real.map((r) => [r.table, r.deleted]));
  assert.deepEqual(deleted, { notifications: 251, jobs: 3, match_runs: 2, extraction_runs: 1, sessions: 1 });
  assert.deepEqual(Object.fromEntries(dry.map((r) => [r.table, r.deleted])), deleted, 'dry run counts the same rows');
  assert.ok(real.find((r) => r.table === 'notifications')!.windows >= 3, 'walked in several id windows');

  const left = (sql: string) => p.query(sql).then((r) => r.rows.map((x) => Object.values(x)[0]));
  assert.deepEqual((await left('SELECT dedupe_key FROM notifications ORDER BY dedupe_key')), ['old-unread', 'recent-read']);
  assert.deepEqual((await left('SELECT kind FROM jobs ORDER BY kind')), ['b', 'e', 'f']);
  assert.deepEqual((await left('SELECT eval_seq::int FROM match_runs ORDER BY eval_seq')), [3, 9], 'newest run of each intent kept');
  assert.equal((await count()).s, 2);
  // idempotent
  assert.ok((await runRetention(p, { batch: 100 })).every((r) => r.deleted === 0));
});
