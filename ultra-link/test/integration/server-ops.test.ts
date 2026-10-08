// Hardening & operations through buildApp() + inject: token-bucket rate limits (429 + Retry-After), strict
// query/body validation (incl. the optional turn `geo`), privacy-safe logs, /api/health, local-only
// /api/metrics, lazy expired-session cleanup, feature route plugins, and the trusted-proxy (Codespaces) mode.
import './server-env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Client, electricianSpec, extraApp, harness, logSink, seedIntents, type Harness } from './server-helpers.ts';
import { buildApp, defineRoutes, sameOrigin, trustProxyFromEnv } from '../../src/server/app.ts';
import { rateLimitConfig, TokenBuckets } from '../../src/server/ratelimit.ts';
import { TurnBody } from '../../src/server/validate.ts';
import { safeErr } from '../../src/server/ops.ts';
import { FEATURE_ROUTES } from '../../src/server/routes/index.ts';
import { enqueue } from '../../src/repo/jobs.ts';
import { encodeCursor } from '../../src/repo/paging.ts';

let h: Harness;
let A: Client;
const extra: FastifyInstance[] = [];
const app = async (opts: Parameters<typeof extraApp>[1]) => { const a = await extraApp(h, opts); extra.push(a); return a; };

before(async () => {
  h = await harness('ops', { rateLimits: { turns: null, auth: null, simulate: null }, sessionCleanupMs: 0 });
  A = new Client(h);
  await A.register('مشغّل');
});
after(async () => {
  for (const a of extra) await a.close();
  await h?.close();
});

// ───────────── rate limits ─────────────

test('rate limits (defaults): turns 30/min/session, auth 20/min/IP, simulate 10/min/session → 429 + Retry-After', async () => {
  const d = rateLimitConfig();
  assert.deepEqual([d.turns?.capacity, d.auth?.capacity, d.simulate?.capacity], [30, 20, 10]);
  assert.ok([d.turns, d.auth, d.simulate].every((r) => r?.windowMs === 60_000));
  const rl = await app({}); // env defaults
  // auth: per client IP
  const ip1 = '10.9.0.1';
  for (let i = 0; i < 20; i++) assert.equal((await new Client({ app: rl, db: h.db }, ip1).post('/api/auth/register', { displayName: `مستخدم ${i}` })).status, 200, `register ${i}`);
  const blocked = await new Client({ app: rl, db: h.db }, ip1).post('/api/auth/register', { displayName: 'زائد' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(blocked.body.messageAr);
  const ra = Number(blocked.headers['retry-after']);
  assert.ok(ra >= 1 && ra <= 60, `Retry-After ${ra}`);
  assert.equal((await new Client({ app: rl, db: h.db }, '10.9.0.2').post('/api/auth/register', { displayName: 'آخر' })).status, 200, 'other IPs unaffected');
  // turns: per session; a refused turn is not processed
  const T = A.on(rl, '10.9.0.3');
  const conv = await T.newConversation();
  for (let i = 0; i < 30; i++) assert.equal((await T.say(conv, 'مرحبا')).status, 200, `turn ${i}`);
  const t31 = await T.say(conv, 'مرحبا');
  assert.equal(t31.status, 429);
  assert.ok(Number(t31.headers['retry-after']) >= 1);
  const msgs = await h.db.pool.query("SELECT count(*)::int AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.public_id = $1 AND m.role = 'user'", [conv]);
  assert.equal(msgs.rows[0].n, 30, 'the 31st turn never reached the engine');
  const U = new Client({ app: rl, db: h.db }, '10.9.0.4'); await U.register('مستخدم ثاني');
  assert.equal((await U.say(await U.newConversation(), 'مرحبا')).status, 200, 'another session has its own bucket');
  // simulate: per session, counted before the realm check
  for (let i = 0; i < 10; i++) assert.equal((await U.post('/api/demo/simulate', { scenario: 'later_match' })).status, 403);
  const s11 = await U.post('/api/demo/simulate', { scenario: 'later_match' });
  assert.equal(s11.status, 429);
  const m = (await new Client({ app: rl, db: h.db }).get('/api/metrics')).body;
  assert.deepEqual([m.process.rateLimited.auth, m.process.rateLimited.turns, m.process.rateLimited.simulate], [1, 1, 1]);
});

test('token buckets refill continuously and stay bounded in memory', () => {
  let now = 0;
  const b = new TokenBuckets({ now: () => now, maxKeys: 100 });
  const rule = { capacity: 3, windowMs: 60_000 };
  for (let i = 0; i < 3; i++) assert.equal(b.take('k', rule).ok, true);
  const r = b.take('k', rule);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.retryAfterMs, 20_000);
  now += 20_000;
  assert.equal(b.take('k', rule).ok, true, 'one token back after windowMs/capacity');
  for (let i = 0; i < 1000; i++) b.take(`key${i}`, rule);
  assert.ok(b.size <= 100, `size ${b.size}`);
});

// ───────────── validation ─────────────

test('query and path validation: malformed input is 400 {error, messageAr}, never 500', async () => {
  const badTs = encodeCursor('not a timestamp', '1');
  const cases: [string, string][] = [
    ['/api/intents?limit=0', 'bad_query'], ['/api/intents?limit=101', 'bad_query'], ['/api/intents?limit=abc', 'bad_query'],
    ['/api/intents?limit=1.5', 'bad_query'], ['/api/intents?limit=10&limit=20', 'bad_query'], ['/api/intents?side=everything', 'bad_query'],
    ['/api/intents?status=active,bogus', 'bad_query'], ["/api/intents?status=active'%20OR%201=1--", 'bad_query'], ['/api/intents?dir=sideways', 'bad_query'],
    ['/api/intents?cursor=!!!', 'bad_cursor'], [`/api/intents?cursor=${badTs}`, 'bad_cursor'],
    [`/api/intents?cursor=${Buffer.from('{"k":"2026-01-01 00:00:00+00","id":"1;DROP"}').toString('base64url')}`, 'bad_cursor'],
    [`/api/intents?cursor=${encodeCursor('2026-02-30 00:00:00+00', '5')}`, 'bad_cursor'],
    ['/api/matches?intent=not-a-uuid', 'bad_query'], ['/api/matches?state=weird', 'bad_query'],
    [`/api/matches?cursor=${encodeCursor('2026-01-01 00:00:00+00', '5')}`, 'bad_cursor'],
    ['/api/notifications?unread=maybe', 'bad_query'], ['/api/notifications?limit=9999', 'bad_query'],
    ['/api/intents/not-a-uuid', 'bad_id'], [`/api/matches/${'f'.repeat(36)}`, 'bad_id'],
  ];
  for (const [url, code] of cases) {
    const r = await A.get(url);
    assert.equal(r.status, 400, `${url} → ${r.status} ${r.raw}`);
    assert.equal(r.body.error, code, url);
    assert.ok(r.body.messageAr, url);
  }
  for (const url of ['/api/intents?status=all', '/api/intents?status=active,paused', '/api/intents?limit=&cursor=', `/api/intents?cursor=${encodeCursor('2026-01-01 00:00:00.123456+00', '5')}`,
    `/api/matches?cursor=${encodeCursor(9500, '7')}&state=all`, '/api/notifications?unread=1&limit=100', `/api/matches?intent=${randomUUID().toUpperCase()}`]) {
    const r = await A.get(url);
    assert.ok(r.status === 200 || (r.status === 404 && url.includes('intent=')), `${url} → ${r.status} ${r.raw}`);
  }
  assert.equal((await A.post(`/api/notifications/xyz/read`)).body.error, 'bad_id');
  // bodies
  assert.equal((await A.post('/api/conversations', '{"broken":')).status, 400);
  assert.equal((await A.post('/api/conversations', '"x".repeat', { 'content-type': 'application/json' })).status, 400);
  const big = await A.post('/api/auth/register', JSON.stringify({ displayName: 'x'.repeat(70 * 1024) }));
  assert.equal(big.status, 413);
  assert.equal((await A.post('/api/conversations', '{"__proto__":{"admin":true}}')).status, 400, 'prototype poisoning refused');
});

test('turn body: optional geo is validated and passed through; unknown optional fields are not rejected', async () => {
  const conv = await A.newConversation();
  const send = (extra: Record<string, unknown>) => A.post(`/api/conversations/${conv}/turns`, { text: 'مرحبا', modality: 'text', clientTurnId: randomUUID(), ...extra });
  for (const geo of [{ lat: 36.37, lng: 37.52 }, { lat: -90, lng: 180, accuracyM: 0 }, { lat: 36.2, lng: 37.1, accuracyM: 25.5 }, null]) {
    assert.equal((await send({ geo })).status, 200, JSON.stringify(geo));
  }
  for (const geo of [{ lat: 91, lng: 0 }, { lat: 0, lng: -180.5 }, { lat: '36', lng: 37 }, { lat: 36 }, { lat: 1, lng: 1, accuracyM: -5 }, { lat: 1, lng: 1, accuracyM: 1e9 }, 'here', [36, 37]]) {
    const r = await send({ geo });
    assert.equal(r.status, 400, JSON.stringify(geo));
    assert.equal(r.body.error, 'bad_request');
  }
  assert.equal((await send({ chipSlot: 'deal', futureField: { a: 1 } })).status, 200, 'unknown optional fields accepted');
  assert.equal((await send({ text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await send({ clientTurnId: 'not-a-uuid' })).status, 400);
  assert.equal((await send({ modality: 'telepathy' })).status, 400);
  // what the route hands to handleTurn(): geo parsed, extra fields kept, defaults applied
  const parsed = TurnBody.parse({ text: 'بدي تكسي', geo: { lat: 36.5, lng: 37.0, accuracyM: 12 }, chipSlot: 'deal' });
  assert.deepEqual(parsed, { text: 'بدي تكسي', modality: 'text', clientTurnId: '', geo: { lat: 36.5, lng: 37.0, accuracyM: 12 }, chipSlot: 'deal' });
  assert.equal(TurnBody.parse({ text: 'x', geo: null }).geo, undefined);
});

// ───────────── logs ─────────────

test('logs: no bodies, cookies, query strings, phone numbers or utterances — even on errors', async () => {
  const sink = logSink();
  const boom = defineRoutes('boom', async (a) => {
    a.get('/api/test/boom', async () => { throw new Error('insert failed: duplicate key value "بدي شقة سرية-٨٨٨" for phone \'+963944555666\''); });
  });
  const la = await app({ logStream: sink.stream, logLevel: 'info', routes: [boom] });
  const L = new Client({ app: la, db: h.db }, '10.7.0.1');
  const reg = await L.post('/api/auth/register', { displayName: 'اسم-سري-٤٤', phone: '+963 944 111 222' });
  assert.equal(reg.status, 200);
  const token = L.cookie.split('=')[1]!;
  const conv = await L.newConversation();
  assert.equal((await L.say(conv, 'بدي شقة بإعزاز سرية-٧٧٣')).status, 200);
  await L.get('/api/intents?cursor=TOPSECRETCURSOR&side=requests');
  await L.post(`/api/conversations/${conv}/turns`, '{"text":"سرية-٩٩٩", "oops"');
  const e = await L.get('/api/test/boom');
  assert.equal(e.status, 500);
  assert.deepEqual(Object.keys(e.body).sort(), ['error', 'messageAr']);
  const text = sink.text();
  const lines = sink.lines();
  assert.ok(lines.some((l) => l.msg === 'incoming request' && l.req?.url === `/api/conversations/${conv}/turns`), 'request logging is on');
  assert.ok(lines.some((l) => l.msg === 'unhandled' && l.err?.message.includes('‹')), 'the error is logged, sanitized');
  for (const secret of [token, 'سرية', 'سري', '944', '963', 'TOPSECRETCURSOR', 'cursor=', 'cookie', 'ul_session=', 'oops']) {
    assert.ok(!text.includes(secret), `logs must not contain "${secret}"`);
  }
  assert.ok(!/[؀-ۿ]/.test(text), 'no Arabic text (user utterances, names) in logs at all');
});

test('safeErr strips quoted values, Arabic text and long messages', () => {
  const s = safeErr(Object.assign(new Error(`duplicate key value violates unique constraint "users_handle_key" DETAIL: Key (handle)=('secret_h') — بدي شقة ${'x'.repeat(500)}`), { code: '23505' }));
  assert.equal(s.code, '23505');
  assert.ok(!s.message.includes('secret_h') && !s.message.includes('users_handle_key') && !/[؀-ۿ]/.test(s.message));
  assert.ok(s.message.length <= 300);
  assert.equal(safeErr('plain').message, 'plain');
});

// ───────────── health & metrics ─────────────

test('/api/health: db latency, queue depth, worker heartbeat age, Jev summary; 503 when draining', async () => {
  await h.db.pool.query('DELETE FROM worker_heartbeats');
  let r = await A.get('/api/health');
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.ok, true);
  assert.equal(b.db, true);
  assert.ok(typeof b.dbLatencyMs === 'number' && b.dbLatencyMs >= 0);
  assert.deepEqual(b.worker, { lastBeatAt: null, ageMs: null, alive: false });
  assert.equal(b.status, 'degraded');
  assert.ok(b.degraded.includes('worker'));
  for (const k of ['pending', 'due', 'running', 'failed']) assert.equal(typeof b.queue[k], 'number', k);
  assert.equal(b.jev.mode, 'rules');
  assert.equal(typeof b.jev.labelAr, 'string');
  assert.equal(b.version, 'test');
  assert.equal(b.events, null, 'LISTEN disabled in this app');
  // a fresh heartbeat → alive; a long-overdue job → queue_lag
  await h.db.pool.query("INSERT INTO worker_heartbeats (worker_id, beat_at) VALUES ('test-worker', now() - interval '2 seconds')");
  const pendingBefore = b.queue.pending;
  await enqueue(h.db.pool, 'expire_sweep', {}, { runAt: new Date(Date.now() - 10 * 60_000), dedupeKey: `lag:${randomUUID()}` });
  r = await A.get('/api/health');
  assert.equal(r.body.worker.alive, true);
  assert.ok(r.body.worker.ageMs >= 1500 && r.body.worker.ageMs < 10_000, `age ${r.body.worker.ageMs}`);
  assert.equal(r.body.queue.pending, pendingBefore + 1);
  assert.ok(r.body.queue.due >= 1);
  assert.ok(r.body.queue.oldestDueAgeMs >= 9 * 60_000);
  assert.deepEqual(r.body.degraded, ['queue_lag']);
  await h.db.pool.query("UPDATE jobs SET status = 'done' WHERE kind = 'expire_sweep'");
  assert.equal((await A.get('/api/health')).body.status, 'ok');
  h.app.ul.draining = true;
  try {
    r = await A.get('/api/health');
    assert.equal(r.status, 503);
    assert.equal(r.body.status, 'draining');
  } finally { h.app.ul.draining = false; }
});

test('database down: health 503 "down", API 503 + Retry-After (not 500)', async () => {
  const dead = new pg.Pool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
  dead.on('error', () => {});
  const down = await buildApp({ pool: dead, reg: h.db.reg, databaseUrl: 'postgres://127.0.0.1:1/none', version: 'test', listen: false, logLevel: 'fatal', sessionCleanupMs: 3_600_000 });
  try {
    const hr = await down.inject({ method: 'GET', url: '/api/health' });
    assert.equal(hr.statusCode, 503);
    assert.equal(hr.json().status, 'down');
    assert.equal(hr.json().db, false);
    const me = await down.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'ul_session=abc' } });
    assert.equal(me.statusCode, 503);
    assert.equal(me.json().error, 'unavailable');
    assert.equal(me.headers['retry-after'], '5');
  } finally {
    await down.close();
    await dead.end();
  }
});

test('/api/metrics: turns, saves, match-run p50/p95 from match_runs, jobs by status, notifications — loopback only', async () => {
  const P = new Client(h); const pid = (await P.register('مقاييس')).id;
  await seedIntents(h, pid, 'real', 1, { spec: electricianSpec(h, 'provide') });
  const saved = await A.dialogue('بدي كهربجي', 'الباب');
  for (let i = 0; i < 3; i++) await A.post(`/api/intents/${saved.intent.id}/match`);
  const m = (await A.get('/api/metrics')).body;
  const db = m.db;
  const q = async (sql: string) => (await h.db.pool.query(sql)).rows[0];
  const truth = await q(`SELECT (SELECT count(*) FROM conversation_messages WHERE role = 'user')::int AS turns,
      (SELECT count(*) FROM conversations WHERE state = 'saved')::int AS saves,
      (SELECT count(*) FROM match_runs)::int AS runs,
      (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FROM match_runs) AS p50,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FROM match_runs) AS p95,
      (SELECT count(*) FROM notifications)::int AS notes,
      (SELECT count(*) FROM jobs WHERE status = 'pending')::int AS pending`);
  assert.equal(db.turns.total, truth.turns);
  assert.equal(db.saves.total, truth.saves);
  assert.ok(truth.runs >= 1);
  assert.equal(db.matchRuns.total, truth.runs);
  assert.equal(db.matchRuns.durationMs.p50, truth.p50);
  assert.equal(db.matchRuns.durationMs.p95, truth.p95);
  assert.equal(db.notifications.sent, truth.notes);
  assert.ok(db.notifications.sent >= 1, 'P was notified about the match');
  assert.equal(db.jobs.pending, truth.pending);
  for (const k of ['pending', 'running', 'done', 'failed', 'superseded']) assert.equal(typeof db.jobs[k], 'number');
  assert.equal(typeof db.sessions.active, 'number');
  assert.ok(m.process.turns.ok >= 2);
  assert.ok(m.process.turns.byEngine.rules >= 2);
  assert.ok(m.process.http['2xx'] > 0);
  assert.equal(typeof m.process.pool.total, 'number');
  assert.equal(m.process.jev.mode, 'rules');
  assert.ok(!JSON.stringify(m).match(/[؀-ۿ]/), 'no user text in metrics');
  // not for the outside world: other addresses, or anything that came through a proxy
  for (const [ip, headers] of [['10.0.0.9', {}], ['203.0.113.5', {}], ['127.0.0.1', { 'x-forwarded-for': '203.0.113.5' }], ['127.0.0.1', { forwarded: 'for=203.0.113.5' }], ['127.0.0.1', { 'x-real-ip': '203.0.113.5' }]] as const) {
    const r = await new Client(h, ip).get('/api/metrics', headers);
    assert.equal(r.status, 404, `${ip} ${JSON.stringify(headers)}`);
  }
  assert.equal((await new Client(h, '::1').get('/api/metrics')).status, 200);
});

// ───────────── sessions ─────────────

test('lazy session cleanup: expired sessions are deleted in batches by ordinary traffic; expired cookies are 401', async () => {
  const { rows: [u] } = await h.db.pool.query("INSERT INTO users (display_name) VALUES ('منتهي') RETURNING id");
  await h.db.pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) SELECT sha256(('old' || g)::bytea), $1, now() - interval '1 day' FROM generate_series(1, 2500) g", [u.id]);
  const count = async () => (await h.db.pool.query('SELECT count(*) FILTER (WHERE expires_at <= now())::int AS expired, count(*) FILTER (WHERE expires_at > now())::int AS active FROM sessions')).rows[0];
  const activeBefore = (await count()).active;
  const cleanedBefore = h.app.ul.counters.sessionsCleaned;
  assert.equal((await A.get('/api/me')).status, 200); // any request may trigger the janitor (interval 0 here)
  for (let i = 0; i < 100 && (await count()).expired > 0; i++) { await h.app.ul.janitor.maybeRun(); await new Promise((r) => setTimeout(r, 20)); }
  const c = await count();
  assert.equal(c.expired, 0);
  assert.equal(c.active, activeBefore, 'live sessions untouched');
  assert.ok(h.app.ul.counters.sessionsCleaned - cleanedBefore >= 2500);
  // an expired session's cookie no longer authenticates, even before cleanup
  const E = new Client(h); await E.register('ينتهي');
  await h.db.pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM users WHERE display_name = 'ينتهي')");
  assert.equal((await E.get('/api/me')).status, 401);
});

// ───────────── extension point ─────────────

test('feature route plugins inherit auth, CSRF, rate limits, validation and the error format', async () => {
  assert.ok(Array.isArray(FEATURE_ROUTES));
  const probe = defineRoutes('probe', async (a, ctx) => {
    a.get('/api/probe/me', async (req) => ({ me: ctx.user(req).publicId }));
    a.get('/api/probe/public', { config: { public: true } }, async (req) => ({ anon: ctx.maybeUser(req) === null }));
    a.post('/api/probe/echo', { config: { rateLimit: { name: 'probe_echo', perMinute: 2 } } }, async (req) => ctx.body(z.object({ n: z.number().int() }), req));
    a.get('/api/probe/item/:id', async (req) => { ctx.uuidParam((req.params as { id: string }).id); throw new ctx.HttpError(404, 'not_found', 'غير موجود'); });
    a.get('/api/probe/q', async (req) => ctx.parseQuery(z.object({ k: z.enum(['a', 'b']) }), req.query));
    a.post('/api/probe/manual', async (req, reply) => {
      if (!ctx.rateLimit(req, reply, { name: 'probe_manual', perMinute: 1, by: 'ip' })) return reply;
      return { ok: true };
    });
    a.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, b, done) => done(null, b));
    a.post('/api/probe/upload', { config: { contentTypes: ['application/octet-stream'] }, bodyLimit: 1024 * 1024 }, async (req) => ({ bytes: (req.body as Buffer).length }));
  });
  const pa = await app({ routes: [probe] });
  const anon = new Client({ app: pa, db: h.db });
  const me = A.on(pa);
  assert.equal((await anon.get('/api/probe/me')).status, 401);
  assert.equal((await me.get('/api/probe/me')).body.me.length, 36);
  assert.deepEqual((await anon.get('/api/probe/public')).body, { anon: true });
  assert.deepEqual((await me.get('/api/probe/public')).body, { anon: false });
  assert.equal((await me.post('/api/probe/echo', { n: 'x' })).body.error, 'bad_request');
  assert.deepEqual((await me.post('/api/probe/echo', { n: 2 })).body, { n: 2 });
  const third = await me.post('/api/probe/echo', { n: 3 });
  assert.equal(third.status, 429, 'route-config bucket: 2/min');
  assert.ok(Number(third.headers['retry-after']) >= 1);
  assert.equal((await me.post('/api/probe/echo', { n: 1 }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await me.post('/api/probe/echo', 'n=1', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await me.get('/api/probe/item/zzz')).body.error, 'bad_id');
  assert.deepEqual((await me.get(`/api/probe/item/${randomUUID()}`)).body, { error: 'not_found', messageAr: 'غير موجود' });
  assert.equal((await me.get('/api/probe/q?k=z')).body.error, 'bad_query');
  assert.equal((await me.post('/api/probe/manual', {})).status, 200);
  assert.equal((await me.post('/api/probe/manual', {})).status, 429, 'in-handler bucket');
  const up = await pa.inject({ method: 'POST', url: '/api/probe/upload', payload: Buffer.alloc(200_000, 1), headers: { 'content-type': 'application/octet-stream', cookie: A.cookie } });
  assert.equal(up.statusCode, 200);
  assert.deepEqual(up.json(), { bytes: 200_000 });
  const upEvil = await pa.inject({ method: 'POST', url: '/api/probe/upload', payload: Buffer.alloc(10), headers: { 'content-type': 'application/octet-stream', cookie: A.cookie, origin: 'http://evil.example' } });
  assert.equal(upEvil.statusCode, 403, 'extra content types still need our origin');
  assert.equal((await A.post('/api/conversations', Buffer.alloc(4).toString(), { 'content-type': 'application/octet-stream' })).status, 415, 'only on the routes that opt in');
  const m = (await new Client({ app: pa, db: h.db }).get('/api/metrics')).body;
  assert.equal(m.process.rateLimited.probe_echo, 1);
  // a broken plugin fails app start loudly, naming the plugin
  const dup = defineRoutes('dup', async (a) => { a.get('/api/health', async () => ({})); });
  await assert.rejects(buildApp({ pool: h.db.pool, reg: h.db.reg, databaseUrl: h.db.url, version: 't', listen: false, logLevel: 'fatal', routes: [dup] }).then((x) => x.ready()), /route plugin "dup"|already declared|health/);
  assert.throws(() => defineRoutes('Bad Name!', async () => {}));
});

// ───────────── reverse proxy (GitHub Codespaces port forwarding) ─────────────

test('UL_TRUST_PROXY: Codespaces origin accepted via X-Forwarded-Host, Secure cookie over https; strict mode unchanged', async () => {
  assert.deepEqual(['1', '', undefined, '0', 'true', '2', 'abc', '-1'].map(trustProxyFromEnv), [1, 0, 0, 0, 1, 2, 0, 0]);
  const pub = 'ul-demo-8080.app.github.dev';
  const cs = { host: 'localhost:8080', origin: `https://${pub}`, 'x-forwarded-host': pub, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7', 'sec-fetch-site': 'same-origin' };
  // unit: both modes
  assert.equal(sameOrigin({ headers: cs }, true), true);
  assert.equal(sameOrigin({ headers: cs }, false), false);
  assert.equal(sameOrigin({ headers: { ...cs, 'x-forwarded-host': `${pub}, internal.local` } }, true), true, 'first X-Forwarded-Host value');
  assert.equal(sameOrigin({ headers: { ...cs, 'x-forwarded-host': `${pub}:443` } }, true), true, 'default port is the same origin');
  assert.equal(sameOrigin({ headers: { ...cs, origin: 'https://evil.example' } }, true), false);
  assert.equal(sameOrigin({ headers: { ...cs, 'x-forwarded-host': `evil.example, ${pub}` } }, true), false, 'only the first value counts');
  assert.equal(sameOrigin({ headers: { ...cs, origin: `http://${pub}:8443` } }, true), false, 'scheme/port must match');
  assert.equal(sameOrigin({ headers: { host: 'localhost:8080', origin: 'http://localhost:8080' } }, true), true, 'local use still works behind the flag');

  const proxied = await app({ trustProxy: 1, rateLimits: { auth: { capacity: 2, windowMs: 60_000 }, turns: null, simulate: null } });
  const strict = await app({ trustProxy: 0 });
  // proxied mode: register over https → Secure cookie, then mutations with the same headers work
  const r = await proxied.inject({ method: 'POST', url: '/api/auth/register', payload: { displayName: 'كودسبيس' }, headers: cs });
  assert.equal(r.statusCode, 200, r.body);
  const sc = String(r.headers['set-cookie']);
  assert.match(sc, /HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=/);
  const cookie = /ul_session=[^;]+/.exec(sc)![0];
  const conv = await proxied.inject({ method: 'POST', url: '/api/conversations', payload: {}, headers: { ...cs, cookie } });
  assert.equal(conv.statusCode, 200, conv.body);
  const turn = await proxied.inject({ method: 'POST', url: `/api/conversations/${conv.json().conversation.id}/turns`, payload: { text: 'بدي شقة', clientTurnId: randomUUID() }, headers: { ...cs, cookie } });
  assert.equal(turn.statusCode, 200);
  assert.equal((await proxied.inject({ method: 'POST', url: '/api/conversations', payload: {}, headers: { ...cs, cookie, origin: 'https://evil.example' } })).statusCode, 403);
  const out = await proxied.inject({ method: 'POST', url: '/api/auth/logout', payload: {}, headers: { ...cs, cookie } });
  assert.match(String(out.headers['set-cookie']), /Secure; Max-Age=0/);
  // client IP = what the trusted proxy saw (right-most X-Forwarded-For), so a forged left part cannot dodge the auth limit
  const regFrom = (xff: string) => proxied.inject({ method: 'POST', url: '/api/auth/register', payload: { displayName: 'ع' }, headers: { ...cs, 'x-forwarded-for': xff } });
  assert.equal((await regFrom('1.1.1.1, 198.51.100.9')).statusCode, 200);
  assert.equal((await regFrom('2.2.2.2, 198.51.100.9')).statusCode, 200);
  assert.equal((await regFrom('3.3.3.3, 198.51.100.9')).statusCode, 429);
  assert.equal((await regFrom('198.51.100.10')).statusCode, 200, 'another real client');
  assert.equal((await proxied.inject({ method: 'GET', url: '/api/metrics', headers: cs })).statusCode, 404, 'metrics never through the proxy');
  // plain local http behind the flag: no Secure attribute
  const local = await proxied.inject({ method: 'POST', url: '/api/auth/register', payload: { displayName: 'محلي' }, headers: { host: 'localhost:8080', origin: 'http://localhost:8080', 'x-forwarded-for': '198.51.100.11' } });
  assert.equal(local.statusCode, 200);
  assert.doesNotMatch(String(local.headers['set-cookie']), /Secure/);
  // strict mode (UL_TRUST_PROXY unset): the forwarded origin is refused, forwarded proto ignored
  assert.equal((await strict.inject({ method: 'POST', url: '/api/auth/register', payload: { displayName: 'س' }, headers: cs })).statusCode, 403);
  const plain = await strict.inject({ method: 'POST', url: '/api/auth/register', payload: { displayName: 'س' }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': pub, origin: 'http://localhost' } });
  assert.equal(plain.statusCode, 200);
  assert.doesNotMatch(String(plain.headers['set-cookie']), /Secure/);
});
