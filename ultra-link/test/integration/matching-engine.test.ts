// Engine integration (isolated DB): versioned writes, stale jobs, out-of-order commits, notification
// de-duplication under repetition and concurrency, pause/close/expire/resume, and retrieval completeness.
import { after, before, test } from 'node:test';
import pg from 'pg';
import assert from 'node:assert/strict';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { withTx } from '../../src/db/pool.ts';
import type { Registry } from '../../src/domain/registry.ts';
import type { IntentSpec, PriceSpec } from '../../src/domain/types.ts';
import { createIntent, intentToSpec, loadIntent, rowToMatchable, setIntentStatus, updateIntent, type StatusAction } from '../../src/repo/intents.ts';
import { invalidatePairs, MATCH_NOTE_BUDGET, matchIntent, matchIntentTx, nextEvalSeq, retrieveCandidates, upsertPairs, type PairWrite } from '../../src/matching/engine.ts';
import { evaluatePair } from '../../src/matching/evaluate.ts';
import { runJob } from '../../src/worker/main.ts';

let db: TestDb;
let reg: Registry;
const P = (code: string) => reg.placeByCode.get(code)!.id;
const usd = (n: number, unit: PriceSpec['unit'] = 'month', op: PriceSpec['op'] = 'eq'): PriceSpec =>
  op === 'lte' ? { op, lo: null, hi: String(n * 100), currency: 'USD', unit, strength: 'required' } : { op, lo: String(n * 100), hi: String(n * 100), currency: 'USD', unit, strength: 'required' };
// every test uses its own city so that tests sharing this database never see each other's intents
const seekFlat = (maxUsd: number, extra: Partial<IntentSpec> = {}, place = 'sy.aleppo.azaz'): IntentSpec => ({
  side: 'seek', categoryCode: 'real_estate.apartment', deal: 'rent',
  place: { pointPlaceId: null, scopePlaceIds: [P(place)], scopeStrength: 'required', excludePlaceIds: [] },
  price: usd(maxUsd, 'month', 'lte'), when: null, attrs: {}, constraints: [], ...extra,
});
const offerFlat = (askUsd: number, place = 'sy.aleppo.azaz', extra: Partial<IntentSpec> = {}): IntentSpec => ({
  side: 'provide', categoryCode: 'real_estate.apartment', deal: 'rent',
  place: { pointPlaceId: P(place), scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] },
  price: usd(askUsd), when: null, attrs: { rooms: 2 }, constraints: [], ...extra,
});
async function mk(userId: string, spec: IntentSpec, title = 'عنوان', createdAt?: Date) {
  return withTx(db.pool, (tx) => createIntent(tx, reg, { userId, realm: 'synthetic', spec, titleAr: title, sourceText: null, conversationId: null, createdAt }));
}
async function edit(v: number, id: string, userId: string, change: (s: IntentSpec) => IntentSpec) {
  const row = (await loadIntent(db.pool, v, id))!;
  const r = await withTx(db.pool, (tx) => updateIntent(tx, reg, v, id, userId, row.version, change(intentToSpec(reg, row)), row.title_ar));
  assert.ok(r.ok);
  return r.version;
}
async function status(v: number, id: string, action: StatusAction) {
  const r = await withTx(db.pool, (tx) => setIntentStatus(tx, reg, v, id, null, action));
  assert.ok(r.ok, `${action} failed`);
  return r.version;
}
async function pair(a: string, b: string) {
  return (await db.pool.query('SELECT * FROM matches WHERE a_intent_id = $1 AND b_intent_id = $2', [a, b])).rows[0] ?? null;
}
const count = async (sql: string, params: unknown[] = []) => Number((await db.pool.query(sql, params)).rows[0].n);

// per-process database names: a concurrent run of the whole suite (another agent, CI) cannot drop ours
const TAG = `r6_match_${process.pid}`;
async function dropDb(name: string) {
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.end(); }
}
before(async () => {
  db = await freshDb(TAG);
  reg = db.reg;
});
after(async () => { await db?.close(); if (db) await dropDb(db.name); });

test('matchIntent writes guarded rows, refs, one notification per side and a run record', async () => {
  const u1 = await mkUser(db.pool, 'باحث');
  const u2 = await mkUser(db.pool, 'مؤجر');
  const s = await mk(u1, seekFlat(200), 'بدي شقة');
  const o = await mk(u2, offerFlat(150), 'شقة بإعزاز');
  const r = await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, version: s.version, trigger: 'job' });
  assert.equal(r.status, 'done');
  assert.equal(r.totals.confirmed, 1);
  assert.equal(r.newMatches, 1);
  const m = await pair(s.id, o.id);
  assert.equal(m.state, 'confirmed');
  assert.equal(m.a_version, 1); assert.equal(m.b_version, 1);
  assert.ok(m.reasons.some((x: { code: string }) => x.code === 'price_within_max'));
  assert.equal(await count('SELECT count(*) n FROM match_refs WHERE match_id = $1', [m.id]), 1);
  const notes = (await db.pool.query("SELECT recipient_id, kind, body_ar FROM notifications WHERE dedupe_key = $1 ORDER BY recipient_id", [`match:${s.verticalId}:${s.id}:${o.id}`])).rows;
  assert.deepEqual(notes.map((n) => String(n.recipient_id)).sort(), [u1, u2].sort());
  assert.ok(notes.every((n) => n.kind === 'match_new' && n.body_ar.includes('«')));
  assert.equal(await count('SELECT count(*) n FROM match_runs WHERE intent_id = $1 AND intent_version = 1', [s.id]), 1);
  // the counterpart's own run sees the same pair: no new row, no new notification
  const r2 = await matchIntent(db.pool, reg, { verticalId: o.verticalId, intentId: o.id, trigger: 'job' });
  assert.equal(r2.newMatches, 0);
  assert.equal(await count('SELECT count(*) n FROM notifications WHERE dedupe_key = $1', [`match:${s.verticalId}:${s.id}:${o.id}`]), 2);
});

test('interactive runs do not notify the viewer; the later job for the same version is a no-op', async () => {
  const u1 = await mkUser(db.pool, 'ناظر');
  const u2 = await mkUser(db.pool, 'مالك');
  const o = await mk(u2, offerFlat(100, 'sy.aleppo.afrin'));
  const s = await mk(u1, seekFlat(120, { place: { pointPlaceId: null, scopePlaceIds: [P('sy.aleppo.afrin')], scopeStrength: 'required', excludePlaceIds: [] } }));
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, version: 1, trigger: 'interactive' });
  const key = `match:${s.verticalId}:${s.id}:${o.id}`;
  assert.deepEqual((await db.pool.query('SELECT recipient_id FROM notifications WHERE dedupe_key = $1', [key])).rows.map((x) => String(x.recipient_id)), [u2]);
  const runsBefore = await count('SELECT count(*) n FROM match_runs WHERE intent_id = $1', [s.id]);
  assert.equal(await runJob(db.pool, reg, { id: '0', kind: 'match_intent', payload: { verticalId: s.verticalId, intentId: s.id, version: 1, trigger: 'job' }, attempts: 1, max_attempts: 5 }), 'done');
  assert.equal(await count('SELECT count(*) n FROM match_runs WHERE intent_id = $1', [s.id]), runsBefore);
});

test('a stale job (version bumped) is superseded and writes nothing', async () => {
  const u1 = await mkUser(db.pool, 'أ');
  const u2 = await mkUser(db.pool, 'ب');
  const s = await mk(u1, seekFlat(300, {}, 'sy.aleppo.al_bab'));
  const o = await mk(u2, offerFlat(250, 'sy.aleppo.al_bab'));
  const v2 = await edit(o.verticalId, o.id, u2, (sp) => ({ ...sp, price: usd(260) }));
  assert.equal(v2, 2);
  const before = { m: await count('SELECT count(*) n FROM matches'), r: await count('SELECT count(*) n FROM match_runs'), n: await count('SELECT count(*) n FROM notifications') };
  const job = { id: '0', kind: 'match_intent', payload: { verticalId: o.verticalId, intentId: o.id, version: 1, trigger: 'job' }, attempts: 1, max_attempts: 5 };
  assert.equal(await runJob(db.pool, reg, job), 'superseded');
  const direct = await matchIntent(db.pool, reg, { verticalId: o.verticalId, intentId: o.id, version: 1, trigger: 'job' });
  assert.equal(direct.status, 'superseded');
  assert.deepEqual({ m: await count('SELECT count(*) n FROM matches'), r: await count('SELECT count(*) n FROM match_runs'), n: await count('SELECT count(*) n FROM notifications') }, before);
  assert.equal(await pair(s.id, o.id), null);
});

test('an older evaluation that commits last never overwrites the newer one (eval_seq + version guards)', async () => {
  const u1 = await mkUser(db.pool, 'ج');
  const u2 = await mkUser(db.pool, 'د');
  const s = await mk(u1, seekFlat(200, {}, 'sy.aleppo.jarabulus'));
  const o = await mk(u2, offerFlat(180, 'sy.aleppo.jarabulus'));
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' });
  assert.equal((await pair(s.id, o.id)).state, 'confirmed');

  // T1 starts: takes its eval_seq and reads the offer at version 1 (confirmed) ...
  const t1 = await db.pool.connect();
  try {
    await t1.query('BEGIN');
    const seq1 = await nextEvalSeq(t1);
    const sRow = rowToMatchable(reg, (await loadIntent(t1, s.verticalId, s.id))!);
    const oRow = rowToMatchable(reg, (await loadIntent(t1, o.verticalId, o.id))!);
    const stale = evaluatePair(reg, sRow, oRow);
    assert.equal(stale.verdict, 'match');
    // ... meanwhile the owner raises the price above the max and T2 (newer) commits the invalidation
    await edit(o.verticalId, o.id, u2, (sp) => ({ ...sp, price: usd(201) }));
    const t2 = await matchIntent(db.pool, reg, { verticalId: o.verticalId, intentId: o.id, trigger: 'edit' });
    assert.equal(t2.invalidated, 1);
    const newer = await pair(s.id, o.id);
    assert.equal(newer.state, 'invalidated');
    assert.match(newer.invalid_reason_ar, /أعلى/);
    // T1 finally writes its (older) result and commits LAST
    const w: PairWrite = { kind: 'exchange', a: sRow, b: oRow, state: 'confirmed', score: stale.score, reasons: stale.reasons, missing: [] };
    assert.deepEqual(await upsertPairs(t1, s.verticalId, seq1, [w]), []);
    assert.deepEqual(await invalidatePairs(t1, s.verticalId, seq1, [{ a: sRow, b: oRow, reasonAr: 'قديم' }]), []);
    await t1.query('COMMIT');
    const fin = await pair(s.id, o.id);
    assert.equal(fin.state, 'invalidated');
    assert.equal(fin.eval_seq, newer.eval_seq, 'the older transaction changed nothing');
    assert.equal(fin.b_version, 2);
    // same intent versions: only eval_seq decides — a lower one never overwrites a higher one
    const sNow = rowToMatchable(reg, (await loadIntent(db.pool, s.verticalId, s.id))!);
    const oNow = rowToMatchable(reg, (await loadIntent(db.pool, o.verticalId, o.id))!);
    const seqA = await nextEvalSeq(db.pool);
    const seqB = await nextEvalSeq(db.pool);
    const later: PairWrite = { kind: 'exchange', a: sNow, b: oNow, state: 'possible', score: 1234, reasons: [], missing: ['price'] };
    assert.equal((await upsertPairs(db.pool, s.verticalId, seqB, [later])).length, 1);
    assert.deepEqual(await upsertPairs(db.pool, s.verticalId, seqA, [{ ...later, state: 'confirmed', score: 9999 }]), []);
    assert.deepEqual(await invalidatePairs(db.pool, s.verticalId, seqA, [{ a: sNow, b: oNow, reasonAr: 'قديم' }]), []);
    assert.equal((await pair(s.id, o.id)).score, 1234);
    // a HIGHER eval_seq carrying OLDER intent versions is refused too (version guard)
    assert.deepEqual(await upsertPairs(db.pool, s.verticalId, await nextEvalSeq(db.pool), [w]), []);
    assert.equal((await pair(s.id, o.id)).state, 'possible');
  } finally {
    t1.release();
  }
});

test('a run that read an intent before it was paused cannot resurrect its pairs, even already-invalidated ones', async () => {
  const u1 = await mkUser(db.pool, 'هـ');
  const u2 = await mkUser(db.pool, 'و');
  const u3 = await mkUser(db.pool, 'ز');
  const s = await mk(u1, seekFlat(200, {}, 'sy.aleppo.manbij'));
  const o1 = await mk(u2, offerFlat(150, 'sy.aleppo.manbij'));
  const o2 = await mk(u3, offerFlat(199, 'sy.aleppo.manbij'));
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' });
  // o2 becomes too expensive → invalidated
  await edit(o2.verticalId, o2.id, u3, (sp) => ({ ...sp, price: usd(500) }));
  await matchIntent(db.pool, reg, { verticalId: o2.verticalId, intentId: o2.id, trigger: 'edit' });
  assert.equal((await pair(s.id, o2.id)).state, 'invalidated');

  const stale = await db.pool.connect();
  try {
    await stale.query('BEGIN');
    const seq = await nextEvalSeq(stale);
    const sv = rowToMatchable(reg, (await loadIntent(stale, s.verticalId, s.id))!); // active, version 1
    await status(s.verticalId, s.id, 'pause');
    const run = await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'status' });
    assert.equal(run.status, 'inactive');
    assert.equal(run.invalidated, 1); // only o1 changed state; o2 was already invalidated (fenced only)
    assert.equal((await pair(s.id, o1.id)).invalid_reason_ar, 'الطلب موقوف مؤقتًا');
    for (const o of [o1, o2]) {
      const ov = rowToMatchable(reg, (await loadIntent(stale, o.verticalId, o.id))!);
      const w: PairWrite = { kind: 'exchange', a: sv, b: ov, state: 'confirmed', score: 7000, reasons: [], missing: [] }; // exactly what the stale run read
      assert.deepEqual(await upsertPairs(stale, s.verticalId, seq, [w]), []);
    }
    await stale.query('COMMIT');
  } finally {
    stale.release();
  }
  assert.equal((await pair(s.id, o1.id)).state, 'invalidated');
  assert.equal((await pair(s.id, o2.id)).state, 'invalidated');
});

test('pause / close / expire invalidate with a reason; resume restores; nothing is notified twice', async () => {
  const u1 = await mkUser(db.pool, 'ح');
  const u2 = await mkUser(db.pool, 'ط');
  const s = await mk(u1, seekFlat(200, {}, 'sy.aleppo.tal_rifaat'));
  const o = await mk(u2, offerFlat(170, 'sy.aleppo.tal_rifaat'));
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' });
  const key = `match:${s.verticalId}:${s.id}:${o.id}`;
  const notes = () => count('SELECT count(*) n FROM notifications WHERE dedupe_key = $1', [key]);
  assert.equal(await notes(), 2);

  // the counterpart pauses → invalidated (seen from both runs)
  await status(o.verticalId, o.id, 'pause');
  await matchIntent(db.pool, reg, { verticalId: o.verticalId, intentId: o.id, trigger: 'status' });
  let m = await pair(s.id, o.id);
  assert.equal(m.state, 'invalidated');
  assert.equal(m.invalid_reason_ar, 'الطلب موقوف مؤقتًا');
  assert.equal(await count('SELECT count(*) n FROM intent_scopes WHERE intent_id = $1', [o.id]), 0);
  // re-running the seeker keeps it invalidated with a reason (the counterpart is inactive)
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' });
  assert.equal((await pair(s.id, o.id)).state, 'invalidated');

  // resume → restored, reason cleared, still exactly one notification per side
  await status(o.verticalId, o.id, 'resume');
  const back = await matchIntent(db.pool, reg, { verticalId: o.verticalId, intentId: o.id, trigger: 'status' });
  assert.equal(back.totals.confirmed, 1);
  m = await pair(s.id, o.id);
  assert.equal(m.state, 'confirmed');
  assert.equal(m.invalid_reason_ar, null);
  assert.equal(await notes(), 2);

  // close the seeker
  await status(s.verticalId, s.id, 'close');
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'status' });
  m = await pair(s.id, o.id);
  assert.equal(m.state, 'invalidated');
  assert.equal(m.invalid_reason_ar, 'الطلب مغلق');

  // expiry through the expire_sweep job
  const u3 = await mkUser(db.pool, 'ي');
  const s2 = await mk(u3, seekFlat(200, {}, 'sy.aleppo.tal_rifaat'));
  await matchIntent(db.pool, reg, { verticalId: s2.verticalId, intentId: s2.id, trigger: 'job' });
  assert.equal((await pair(s2.id, o.id)).state, 'confirmed');
  await db.pool.query("UPDATE intents SET expires_at = now() - interval '1 minute' WHERE id = $1", [s2.id]);
  const sweep = { id: '0', kind: 'expire_sweep', payload: {}, attempts: 1, max_attempts: 5 };
  assert.equal(await runJob(db.pool, reg, sweep), 'done');
  const row = (await loadIntent(db.pool, s2.verticalId, s2.id))!;
  assert.equal(row.status, 'expired');
  m = await pair(s2.id, o.id);
  assert.equal(m.state, 'invalidated');
  assert.equal(m.invalid_reason_ar, 'انتهت صلاحية الطلب');
  const expiredKey = `expired:${s2.verticalId}:${s2.id}:${row.version}`;
  assert.equal(await count('SELECT count(*) n FROM notifications WHERE dedupe_key = $1 AND recipient_id = $2', [expiredKey, u3]), 1);
  // the safety-net job was enqueued in the same transaction and is a no-op now; a second sweep changes nothing
  const job = (await db.pool.query("SELECT payload FROM jobs WHERE kind = 'match_intent' AND dedupe_key = $1", [`match:${s2.verticalId}:${s2.id}:${row.version}`])).rows[0];
  assert.ok(job, 'versioned re-match job enqueued');
  assert.equal(await runJob(db.pool, reg, { id: '0', kind: 'match_intent', payload: job.payload, attempts: 1, max_attempts: 5 }), 'done');
  assert.equal(await runJob(db.pool, reg, sweep), 'done');
  assert.equal(await count("SELECT count(*) n FROM notifications WHERE kind = 'intent_expired' AND recipient_id = $1", [u3]), 1);
  // an intent resumed before the sweep commits is not expired (the row is re-checked under a lock)
  const s3 = await mk(u3, seekFlat(200, {}, 'sy.aleppo.tal_rifaat'));
  await db.pool.query("UPDATE intents SET expires_at = now() + interval '1 day' WHERE id = $1", [s3.id]);
  await runJob(db.pool, reg, sweep);
  assert.equal((await loadIntent(db.pool, s3.verticalId, s3.id))!.status, 'active');
});

test('repeated and concurrent runs never duplicate matches or notifications', async () => {
  const seeker = await mkUser(db.pool, 'متزامن');
  const s = await mk(seeker, seekFlat(400, { place: { pointPlaceId: null, scopePlaceIds: [P('sy.aleppo.marea')], scopeStrength: 'required', excludePlaceIds: [] } }));
  const offers = [];
  for (let i = 0; i < 8; i++) offers.push(await mk(await mkUser(db.pool, `مالك ${i}`), offerFlat(300 + i, 'sy.aleppo.marea')));
  for (let i = 0; i < 3; i++) await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' });
  const runs = [];
  for (let k = 0; k < 4; k++) {
    runs.push(matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' }));
    for (const o of offers) runs.push(matchIntent(db.pool, reg, { verticalId: o.verticalId, intentId: o.id, trigger: 'job' }));
  }
  const out = await Promise.all(runs);
  assert.ok(out.every((r) => r.status === 'done'));
  assert.equal(await count('SELECT count(*) n FROM matches WHERE a_intent_id = $1', [s.id]), offers.length);
  assert.equal(await count('SELECT count(*) n FROM match_refs r JOIN matches m ON m.vertical_id = r.vertical_id AND m.id = r.match_id WHERE m.a_intent_id = $1', [s.id]), offers.length);
  assert.equal(await count("SELECT count(*) n FROM matches WHERE a_intent_id = $1 AND state = 'confirmed'", [s.id]), offers.length);
  const dup = await db.pool.query('SELECT recipient_id, dedupe_key, count(*) c FROM notifications GROUP BY 1, 2 HAVING count(*) > 1');
  assert.equal(dup.rowCount, 0);
  // the seeker: MATCH_NOTE_BUDGET individual alerts + one summary carrying the rest (coalescing, matching-notes.test.ts)
  const seekerRows = MATCH_NOTE_BUDGET + 1;
  assert.equal(await count('SELECT count(*) n FROM notifications WHERE recipient_id = $1', [seeker]), seekerRows);
  assert.equal(await count("SELECT (count(*) FILTER (WHERE kind <> 'match_more') + coalesce(sum((payload->>'count')::int) FILTER (WHERE kind = 'match_more'), 0)) n FROM notifications WHERE recipient_id = $1", [seeker]), offers.length, 'every pair announced exactly once to the seeker');
  // every owner hears about their pair exactly once
  for (const o of offers) assert.equal(await count('SELECT count(*) n FROM notifications WHERE dedupe_key = $1 AND recipient_id <> $2', [`match:${s.verticalId}:${s.id}:${o.id}`, seeker]), 1);
  // concurrent runs of the same intent inside caller transactions also serialize (advisory lock)
  await Promise.all([1, 2, 3].map(() => withTx(db.pool, (tx) => matchIntentTx(tx, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' }))));
  assert.equal(await count('SELECT count(*) n FROM notifications WHERE recipient_id = $1', [seeker]), seekerRows);
});

// ───────────── retrieval completeness against brute force ─────────────
function rnd(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('retrieval: RANGE / PROBE / BROAD never miss a non-excluded counterpart (brute force over ~400 random intents)', async () => {
  const fresh = await freshDb(`${TAG}_retrieval`);
  try {
    const r = rnd(4242);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const chance = (p: number) => r() < p;
    const R = fresh.reg;
    const pl = (c: string) => R.placeByCode.get(c)!.id;
    const POINTS = ['sy.aleppo.azaz', 'sy.aleppo.afrin', 'sy.aleppo.marea', 'sy.aleppo', 'sy.idlib.sarmada', 'sy.idlib', 'tr.gaziantep', 'online', 'sy'].map(pl);
    const SCOPES = [...POINTS, pl('world'), pl('tr')];
    const users: string[] = [];
    for (let i = 0; i < 25; i++) users.push(await mkUser(fresh.pool, `u${i}`, i < 22 ? 'synthetic' : 'real'));
    const exchangeCats = ['real_estate', 'real_estate.apartment', 'real_estate.villa', 'vehicles.car', 'services.plumbing', 'services'];
    const peerCats = ['activities', 'activities.trip', 'activities.sports'];
    const days = ['2026-10-09', '2026-10-10', '2026-10-11'];
    const specs: { user: string; spec: IntentSpec }[] = [];
    for (let i = 0; i < 400; i++) {
      const peer = chance(0.3);
      const cat = peer ? pick(peerCats) : pick(exchangeCats);
      const deals = R.categoryByCode.get(cat)!.deals;
      const side = peer ? 'join' : chance(0.5) ? 'seek' : 'provide';
      const point = chance(side === 'seek' ? 0.3 : 0.8) ? pick(POINTS) : null;
      const scope = chance(0.6) ? [...new Set([pick(SCOPES), ...(chance(0.2) ? [pick(SCOPES)] : [])])] : [];
      const day = pick(days);
      const spec: IntentSpec = {
        side, categoryCode: cat, deal: pick(deals),
        place: { pointPlaceId: point, scopePlaceIds: scope.filter((p) => p !== R.rootPlaceId || chance(0.5)), scopeStrength: chance(0.7) ? 'required' : 'preferred', excludePlaceIds: chance(0.08) ? [pick(POINTS)] : [] },
        price: !peer && chance(0.6) ? { op: side === 'seek' ? pick(['lte', 'eq', 'between'] as const) : 'eq', lo: '10000', hi: String(10000 + Math.floor(r() * 3) * 5000), currency: chance(0.9) ? 'USD' : 'TRY', unit: chance(0.8) ? 'month' : 'total', strength: chance(0.8) ? 'required' : 'preferred' } : null,
        when: chance(peer ? 0.8 : 0.1) ? { from: `${day}T00:00:00+03:00`, to: `${day}T23:00:00+03:00`, strength: chance(0.7) ? 'required' : 'preferred' } : null,
        attrs: {}, constraints: [],
      };
      if (spec.price?.op === 'eq' || spec.price?.op === 'lte') spec.price.lo = spec.price.op === 'eq' ? spec.price.hi : null;
      specs.push({ user: pick(users), spec });
    }
    const ids: { verticalId: number; id: string; version: number }[] = [];
    for (const x of specs) {
      const realm = users.indexOf(x.user) >= 22 ? 'real' : 'synthetic';
      ids.push(await withTx(fresh.pool, (tx) => createIntent(tx, R, { userId: x.user, realm, spec: x.spec, titleAr: 't', sourceText: null, conversationId: null })));
    }
    // a few inactive ones
    for (const x of ids.slice(0, 15)) await withTx(fresh.pool, (tx) => setIntentStatus(tx, R, x.verticalId, x.id, null, 'pause'));
    const rows = await Promise.all(ids.map((x) => loadIntent(fresh.pool, x.verticalId, x.id)));
    const all = rows.map((row) => ({ row: row!, m: rowToMatchable(R, row!) }));
    let checked = 0;
    let truncated = 0;
    let expectedPairs = 0;
    const misses: string[] = [];
    for (const me of all) {
      if (me.m.status !== 'active') continue;
      const got = await retrieveCandidates(fresh.pool, R, me.row, me.m);
      if (got.truncated) { truncated++; continue; }
      for (const other of all) {
        if (other.m.id === me.m.id || other.row.vertical_id !== me.row.vertical_id) continue;
        const v = evaluatePair(R, me.m, other.m);
        if (v.verdict === 'excluded') continue;
        expectedPairs++;
        if (!got.ids.has(other.m.id)) misses.push(`${me.m.id}(${me.m.side} ${me.m.categoryCode} pt=${me.m.pointPlaceId} sc=${me.m.scopePlaceIds}${me.m.scopeStrength[0]}) missed ${other.m.id}(${other.m.side} ${other.m.categoryCode} pt=${other.m.pointPlaceId} sc=${other.m.scopePlaceIds}${other.m.scopeStrength[0]}) → ${v.verdict} via ${got.directions}`);
      }
      checked++;
    }
    assert.deepEqual(misses.slice(0, 5), []);
    assert.ok(checked > 300 && truncated === 0, `checked ${checked}, truncated ${truncated}`);
    assert.ok(expectedPairs > 200, `only ${expectedPairs} non-excluded pairs — generator too sparse`);

    // end to end: after every intent ran once, the stored rows equal the brute-force verdicts
    for (const x of ids) await matchIntent(fresh.pool, R, { verticalId: x.verticalId, intentId: x.id, trigger: 'seed' });
    const stored = new Map<string, string>();
    for (const m of (await fresh.pool.query('SELECT a_intent_id, b_intent_id, state FROM matches')).rows) stored.set(`${m.a_intent_id}:${m.b_intent_id}`, m.state);
    const wrong: string[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [x, y] = [all[i]!.m, all[j]!.m];
        if (all[i]!.row.vertical_id !== all[j]!.row.vertical_id) continue;
        const v = evaluatePair(R, x, y);
        const peer = x.side === 'join';
        const [a, b] = peer ? (BigInt(x.id) < BigInt(y.id) ? [x, y] : [y, x]) : x.side === 'seek' ? [x, y] : [y, x];
        const want = v.verdict === 'match' ? 'confirmed' : v.verdict === 'possible' ? 'possible' : undefined;
        const have = stored.get(`${a.id}:${b.id}`);
        if (want !== (have === 'invalidated' ? undefined : have)) wrong.push(`${a.id}:${b.id} want ${want} have ${have}`);
      }
    }
    assert.deepEqual(wrong.slice(0, 5), []);
  } finally {
    await fresh.close();
    await dropDb(fresh.name);
  }
});

test('exclusion stats: textAr is the reason label only (the UI prefixes the count); outside-scope counterparts are counted', async () => {
  const u1 = await mkUser(db.pool, 'إحصاء');
  const s = await mk(u1, seekFlat(200, {}, 'sy.aleppo.atarib'));
  await mk(await mkUser(db.pool, 'غالي 1'), offerFlat(300, 'sy.aleppo.atarib'));
  await mk(await mkUser(db.pool, 'غالي 2'), offerFlat(201, 'sy.aleppo.atarib'));
  await mk(await mkUser(db.pool, 'بعيد'), offerFlat(100, 'sy.aleppo.daret_azza'));
  const run = await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'interactive' });
  const byCode = new Map(run.exclusions.map((e) => [e.code, e] as const));
  assert.deepEqual(byCode.get('price_above_max'), { code: 'price_above_max', count: 2, textAr: 'أعلى من حد السعر' });
  assert.ok((byCode.get('place_out_of_scope')?.count ?? 0) >= 1);
  assert.equal(byCode.get('place_out_of_scope')?.textAr, 'خارج المكان الذي اشترطته');
  for (const e of run.exclusions) assert.ok(!/\d/.test(e.textAr), `no count inside textAr: ${e.textAr}`);
  assert.equal(run.totals.confirmed, 0);
  assert.ok(run.directions.includes('range'));
});

test('retrieval: broader (region) points and scopes, and point-less counterparts, are found and are only "possible"', async () => {
  const region = P('sy.aleppo');
  const car = (side: 'seek' | 'provide', place: IntentSpec['place']): IntentSpec => ({
    side, categoryCode: 'vehicles.car', deal: 'sale', place, when: null, attrs: {}, constraints: [],
    price: side === 'seek' ? { op: 'lte', lo: null, hi: '900000', currency: 'USD', unit: 'total', strength: 'required' } : { op: 'eq', lo: '500000', hi: '500000', currency: 'USD', unit: 'total', strength: 'required' },
  });
  const ids = async (i: { verticalId: number; id: string }) => {
    const row = (await loadIntent(db.pool, i.verticalId, i.id))!;
    return (await retrieveCandidates(db.pool, reg, row, rowToMatchable(reg, row))).ids;
  };
  const verdict = async (x: { verticalId: number; id: string }, y: { verticalId: number; id: string }) =>
    evaluatePair(reg, rowToMatchable(reg, (await loadIntent(db.pool, x.verticalId, x.id))!), rowToMatchable(reg, (await loadIntent(db.pool, y.verticalId, y.id))!));
  // UP: "only Qabasin" vs a car somewhere in rural Aleppo (point = the region)
  const seekCity = await mk(await mkUser(db.pool, 'قباسين'), car('seek', { pointPlaceId: null, scopePlaceIds: [P('sy.aleppo.qabasin')], scopeStrength: 'required', excludePlaceIds: [] }));
  const provRegion = await mk(await mkUser(db.pool, 'ريف'), car('provide', { pointPlaceId: region, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] }));
  const v = await verdict(seekCity, provRegion);
  assert.equal(v.verdict, 'possible');
  assert.ok(v.reasons.some((r) => r.code === 'place_unknown'));
  assert.ok((await ids(seekCity)).has(provRegion.id), 'RANGE finds a broader point (ancestor of the scope)');
  // DOWN: the region-point provider must find the city-scoped seeker (its scope lies inside my point)
  assert.ok((await ids(provRegion)).has(seekCity.id), 'PROBE finds scopes inside a region point');
  // a provider with a hard service area and a point finds point-less seekers whose scope reaches it
  const plumb = (side: 'seek' | 'provide', place: IntentSpec['place']): IntentSpec => ({ side, categoryCode: 'services.plumbing', deal: 'service', place, price: null, when: null, attrs: {}, constraints: [] });
  const provArea = await mk(await mkUser(db.pool, 'سباك'), plumb('provide', { pointPlaceId: P('sy.aleppo.akhtarin'), scopePlaceIds: [region], scopeStrength: 'required', excludePlaceIds: [] }));
  const seekNoPoint = await mk(await mkUser(db.pool, 'بيت'), plumb('seek', { pointPlaceId: null, scopePlaceIds: [P('sy.aleppo.akhtarin')], scopeStrength: 'required', excludePlaceIds: [] }));
  assert.equal((await verdict(provArea, seekNoPoint)).verdict, 'possible');
  assert.ok((await ids(provArea)).has(seekNoPoint.id), 'point-less counterpart found by probing my point');
  // end to end: stored as possible, with the unknown place in `missing`
  await matchIntent(db.pool, reg, { verticalId: seekCity.verticalId, intentId: seekCity.id, trigger: 'job' });
  const m = await pair(seekCity.id, provRegion.id);
  assert.equal(m.state, 'possible');
  assert.deepEqual(m.missing, ['place']);
});
