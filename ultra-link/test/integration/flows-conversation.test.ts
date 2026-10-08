// Conversation flows on a fresh, isolated database (Role 8 — independent tests).
//   * repeated-question guard over EVERY dialogue of test/corpus/dialogues.json, through handleTurn (the real
//     service: DB-persisted drafts, pending questions, revisions)
//   * racing turns on one conversation (no lost update, never two intents)
//   * retry with the same clientTurnId (sequential, concurrent, after the conversation was saved)
//   * draft persistence across a "reload" (nothing kept in memory between turns)
//   * provider failure fallback: with Jev failing in every way the mock can fail, every dialogue ends exactly as
//     with JEV_MODE=off (the rules decide; the failure is disclosed; nothing waits on the provider)
// JEV_MODE is 'off' unless a test switches it to 'simulate' against the LOCAL mock. No request leaves the machine.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import pg from 'pg';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { cancelConversation, currentConversation, handleTurn, HttpError, startConversation, type TurnResult } from '../../src/conversation/service.ts';
import type { SessionUser } from '../../src/repo/users.ts';
import { defaultJevCache, getJev, resetJevRuntime, SIM_TOKEN } from '../../src/ai/index.ts';
import { _resetJevGate, jevUsable } from '../../src/conversation/jev-gate.ts';
import { startJevMock, type JevMock, type JevMockFault } from '../mocks/jev-mock-server.ts';

interface DialogueTurn { user: string; expectAsk: string | null }
interface Dialogue { id: string; turns: DialogueTurn[]; final: Record<string, unknown>; tags: string[] }
const DIALOGUES: Dialogue[] = JSON.parse(readFileSync(new URL('../corpus/dialogues.json', import.meta.url), 'utf8'));

const TAG = `r8_flows_conv_${process.pid}`;
let db: TestDb;

before(async () => { db = await freshDb(TAG); });
after(async () => {
  process.env.JEV_MODE = 'off';
  resetJevRuntime();
  await db?.close();
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`); } finally { await a.end(); }
});

async function sessionUser(name: string, realm: 'real' | 'synthetic' = 'real'): Promise<SessionUser> {
  const id = await mkUser(db.pool, name, realm);
  const { rows } = await db.pool.query('SELECT public_id FROM users WHERE id = $1', [id]);
  return { id, publicId: rows[0].public_id, displayName: name, realm, handle: null };
}
const turn = (u: SessionUser, conv: string, text: string, clientTurnId: string = randomUUID()) =>
  handleTurn(db.pool, db.reg, u, conv, { text, modality: 'text', clientTurnId });
async function convRow(publicId: string) {
  return (await db.pool.query('SELECT id, state, draft, pending_question, revision FROM conversations WHERE public_id = $1', [publicId])).rows[0];
}
const count = async (sql: string, params: unknown[]) => Number((await db.pool.query(sql, params)).rows[0].n);

interface Step { i: number; text: string; action: TurnResult['action']; field: string | null; qid: string | null; expect: string | null; resolvedAfter: string[]; asked: Record<string, number> }

/** Run one corpus dialogue through the real service; stops at 'saved'. Every turn re-reads state from the DB. */
async function runDialogue(u: SessionUser, d: Dialogue): Promise<{ steps: Step[]; result: TurnResult | null; convId: string }> {
  const conv = await startConversation(db.pool, u);
  const steps: Step[] = [];
  let result: TurnResult | null = null;
  for (let i = 0; i < d.turns.length; i++) {
    const t = d.turns[i]!;
    result = await turn(u, conv.id, t.user);
    const row = await convRow(conv.id);
    steps.push({ i, text: t.user, action: result.action, field: result.question?.field ?? null, qid: result.question?.id ?? null, expect: t.expectAsk, resolvedAfter: row.draft.resolved ?? [], asked: row.draft.asked ?? {} });
    if (result.action === 'saved') break;
  }
  return { steps, result, convId: conv.id };
}

// ───────────────────────────── repeated-question guard ─────────────────────────────
test(`repeated-question guard over all ${DIALOGUES.length} corpus dialogues (handleTurn, DB-backed drafts)`, async () => {
  const u = await sessionUser('حارس الأسئلة');
  const invariant: string[] = [];
  const reasked: string[] = [];
  let agree = 0;
  let total = 0;
  let saved = 0;
  for (const d of DIALOGUES) {
    const { steps } = await runDialogue(u, d);
    const everResolved = new Set<string>();
    const perField = new Map<string, number>();
    const qids = new Set<string>();
    for (const s of steps) {
      total++;
      if ((s.action === 'ask' ? s.field : null) === s.expect) agree++;
      if (s.action === 'saved') saved++;
      if (s.action === 'ask') {
        // (1) one question, with a stable id and quick answers only for closed questions
        if (!s.field || !s.qid) invariant.push(`${d.id}#${s.i}: ask without field/id`);
        // (2) a field the draft marked as resolved (answered, even "ما بعرف") is NEVER asked again
        if (s.field !== 'conflict' && (everResolved.has(s.field!) || s.resolvedAfter.includes(s.field!))) {
          invariant.push(`${d.id}#${s.i}: asked «${s.field}» although it was resolved (${[...everResolved].join(',')})`);
        }
        // (3) the same question id is never sent twice (a re-ask is a new attempt), and a field is asked at most 3×
        if (qids.has(s.qid!)) invariant.push(`${d.id}#${s.i}: question id ${s.qid} repeated`);
        qids.add(s.qid!);
        perField.set(s.field!, (perField.get(s.field!) ?? 0) + 1);
        if (perField.get(s.field!)! > 3) invariant.push(`${d.id}#${s.i}: «${s.field}» asked ${perField.get(s.field!)} times`);
        // (4) user's view: we asked F, the user answered (the corpus does not expect F again), and we ask F again
        const prev = steps[s.i - 1];
        if (prev?.action === 'ask' && prev.field === s.field && s.expect !== s.field) {
          reasked.push(`${d.id}#${s.i}: «${s.field}» re-asked after the answer «${s.text}»`);
        }
      }
      for (const f of s.resolvedAfter) everResolved.add(f);
    }
  }
  console.log(`      info: corpus agreement on the next question ${agree}/${total} turns (${(100 * agree / total).toFixed(1)}%), ${saved}/${DIALOGUES.length} dialogues saved`);
  if (reasked.length) console.log(`      re-asked after an answer (${reasked.length}):\n        ${reasked.join('\n        ')}`);
  assert.deepEqual(invariant, [], 'engine invariants: resolved fields are never re-asked, ids unique, ≤ 3 attempts per field');
  assert.deepEqual(reasked, [], 'a question the user just answered (per the corpus labels) is never asked again');
});

test('the pending question is asked once per turn, persisted with the draft, and survives a "reload"', async () => {
  const u = await sessionUser('مستخدم يعيد التحميل');
  const conv = await startConversation(db.pool, u);
  const r1 = await turn(u, conv.id, 'بدي شقة بإعزاز');
  assert.equal(r1.action, 'ask');
  assert.equal(r1.question?.field, 'deal');
  // a reload keeps nothing in memory: everything comes back from the DB
  const cur = await currentConversation(db.pool, db.reg, u);
  assert.ok(cur, 'an open conversation is restored');
  assert.equal(cur!.id, conv.id);
  assert.equal(cur!.question?.id, r1.question!.id, 'the same pending question');
  assert.ok(cur!.summary.chips.some((c) => /إعزاز/.test(c.valueAr)), 'the understood place is restored');
  const r2 = await turn(u, conv.id, 'إيجار');
  assert.equal(r2.action, 'saved');
  const { rows } = await db.pool.query('SELECT i.deal_type_id, i.scope_place_ids, i.conversation_id FROM intents i JOIN conversations c ON c.id = i.conversation_id WHERE c.public_id = $1', [conv.id]);
  assert.equal(rows.length, 1);
  assert.equal(db.reg.dealById.get(rows[0].deal_type_id)!.code, 'rent', 'the answer after the reload merged into the same draft');
  assert.deepEqual(rows[0].scope_place_ids, [db.reg.placeByCode.get('sy.aleppo.azaz')!.id]);
  assert.equal(await currentConversation(db.pool, db.reg, u), null, 'a saved conversation is not re-opened');
  // starting a new request closes an unfinished draft (one current conversation, never ambiguous)
  const c3 = await startConversation(db.pool, u);
  await turn(u, c3.id, 'عندي سيارة للبيع');
  const c4 = await startConversation(db.pool, u);
  await assert.rejects(turn(u, c3.id, 'بإعزاز'), (e: HttpError) => e.status === 409 && e.code === 'conversation_closed');
  assert.equal((await currentConversation(db.pool, db.reg, u))?.id ?? null, null, 'the new (empty) conversation is collecting; the old one is cancelled');
  assert.equal((await convRow(c3.id)).state, 'cancelled');
  await cancelConversation(db.pool, u, c4.id);
  await assert.rejects(cancelConversation(db.pool, u, c4.id), (e: HttpError) => e.status === 404);
});

// ───────────────────────────── retries & races ─────────────────────────────
test('retry with the same clientTurnId: identical result, one stored turn, one intent — even after the conversation is saved', async () => {
  const u = await sessionUser('مستخدم يعيد الإرسال');
  const conv = await startConversation(db.pool, u);
  const id1 = randomUUID();
  const a = await turn(u, conv.id, 'بدي شقة بإعزاز', id1);
  const b = await turn(u, conv.id, 'بدي شقة بإعزاز', id1); // the network dropped the first response
  assert.deepEqual(b, a);
  const id2 = randomUUID();
  const s1 = await turn(u, conv.id, 'إيجار', id2);
  assert.equal(s1.action, 'saved');
  const s2 = await turn(u, conv.id, 'إيجار', id2); // conversation is 'saved' now: the retry still gets its answer, not 409
  assert.deepEqual(s2, s1);
  const s3 = await turn(u, conv.id, 'شراء', id2); // same id, different text: the stored answer wins, nothing re-processed
  assert.deepEqual(s3, s1);
  const row = await convRow(conv.id);
  assert.equal(await count("SELECT count(*) AS n FROM conversation_messages WHERE conversation_id = $1 AND role = 'user'", [row.id]), 2);
  assert.equal(await count('SELECT count(*) AS n FROM intents WHERE conversation_id = $1', [row.id]), 1);
  assert.equal(row.draft.turns, 2);
});

test('concurrent duplicates of one clientTurnId all get the same answer; exactly one turn and one intent are stored', async () => {
  const u = await sessionUser('مستخدم بنقرات متكررة');
  const conv = await startConversation(db.pool, u);
  const id = randomUUID();
  const rs = await Promise.allSettled(Array.from({ length: 5 }, () => turn(u, conv.id, 'بدي شقة للإيجار بإعزاز', id)));
  const ok = rs.filter((r): r is PromiseFulfilledResult<TurnResult> => r.status === 'fulfilled').map((r) => r.value);
  const errs = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as HttpError);
  assert.ok(ok.length >= 1, 'at least one caller got the answer');
  for (const e of errs) assert.ok(e instanceof HttpError && e.status === 409, `only a retryable 409 is acceptable, got ${e}`);
  for (const r of ok) assert.deepEqual(r, ok[0], 'every duplicate sees the same TurnResult');
  const row = await convRow(conv.id);
  assert.equal(await count("SELECT count(*) AS n FROM conversation_messages WHERE conversation_id = $1 AND role = 'user'", [row.id]), 1);
  assert.equal(await count('SELECT count(*) AS n FROM intents WHERE conversation_id = $1', [row.id]), ok[0]!.action === 'saved' ? 1 : 0);
  assert.equal(row.draft.turns, 1);
  console.log(`      info: 5 concurrent duplicates → ${ok.length} answered, ${errs.length} × 409`);
});

test('racing different answers to the same question: one wins, the other is told to retry/restart, never two intents', async () => {
  const u = await sessionUser('مستخدم بجوابين');
  for (let round = 0; round < 6; round++) {
    const conv = await startConversation(db.pool, u);
    const q = await turn(u, conv.id, 'بدي شقة بإعزاز');
    assert.equal(q.question?.field, 'deal');
    const rs = await Promise.allSettled([turn(u, conv.id, 'إيجار'), turn(u, conv.id, 'شراء')]);
    const ok = rs.filter((r): r is PromiseFulfilledResult<TurnResult> => r.status === 'fulfilled').map((r) => r.value);
    const errs = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as HttpError);
    for (const e of errs) assert.ok(e instanceof HttpError && e.status === 409 && ['busy', 'conversation_closed'].includes(e.code), `unexpected ${e?.code ?? e}`);
    const savedResults = ok.filter((r) => r.action === 'saved');
    assert.equal(savedResults.length, 1, `round ${round}: exactly one answer saved the request (${ok.map((r) => r.action)} / ${errs.map((e) => e.code)})`);
    const row = await convRow(conv.id);
    const { rows } = await db.pool.query('SELECT deal_type_id FROM intents WHERE conversation_id = $1', [row.id]);
    assert.equal(rows.length, 1, 'never two intents for one conversation');
    assert.equal(savedResults[0]!.intent!.deal, db.reg.dealById.get(rows[0].deal_type_id)!.code, 'the stored intent is the one the winner was told about');
    assert.equal(await count("SELECT count(*) AS n FROM conversation_messages WHERE conversation_id = $1 AND role = 'user'", [row.id]), 1 + ok.length, 'only accepted turns are stored');
  }
});

test('many concurrent turns on one open conversation: no lost update (draft.turns == stored turns == accepted turns)', async () => {
  const u = await sessionUser('مستخدم سريع جدًا');
  const conv = await startConversation(db.pool, u);
  await turn(u, conv.id, 'بدي حدا يصلحلي شي'); // vague: stays open and keeps asking
  const texts = ['ممم', 'يعني', 'لحظة', 'شو؟', 'طيب', 'آه', 'خليني فكر', 'تمام'];
  const rs = await Promise.allSettled(texts.map((t) => turn(u, conv.id, t)));
  const ok = rs.filter((r) => r.status === 'fulfilled').length;
  const errs = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as HttpError);
  for (const e of errs) assert.ok(e instanceof HttpError && e.status === 409, `only 409 busy/closed is acceptable: ${e}`);
  const row = await convRow(conv.id);
  const stored = await count("SELECT count(*) AS n FROM conversation_messages WHERE conversation_id = $1 AND role = 'user'", [row.id]);
  assert.equal(stored, 1 + ok, 'every accepted turn is stored exactly once');
  assert.equal(row.draft.turns, stored, 'the draft counted every stored turn (no lost update)');
  assert.ok(await count('SELECT count(*) AS n FROM intents WHERE conversation_id = $1', [row.id]) <= 1);
  console.log(`      info: ${texts.length} concurrent turns → ${ok} accepted, ${errs.length} × 409 (${[...new Set(errs.map((e) => e.code))].join(',') || '-'})`);
});

// ───────────────────────────── provider failure fallback ─────────────────────────────
const FALLBACK_NOTE = 'تعذّر الوصول إلى Jev — استُخدم المحلّل المحلي';
let mock: JevMock | null = null;

async function configureJev(mode: 'off' | 'simulate', baseUrl: string): Promise<void> {
  process.env.JEV_MODE = mode;
  process.env.TYPESAFE_BASE_URL = baseUrl;
  resetJevRuntime();
  defaultJevCache.clear();
  _resetJevGate();
}
/** Open the health gate with a good probe, then arm `faults` for the System One calls of the next turn. */
async function armFaults(faults: JevMockFault[]): Promise<void> {
  const rt = getJev();
  assert.ok(rt.client, 'simulate client configured');
  mock!.setFaults([]);
  _resetJevGate();
  jevUsable(rt.client!);
  for (let i = 0; i < 300 && !jevUsable(rt.client!); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(jevUsable(rt.client!), 'gate open after a successful probe');
  defaultJevCache.clear();
  mock!.setFaults(faults);
}

/** Sample: dialogues whose turns leave something open for Jev (side / deal / place strictness / price op). */
const SAMPLE = DIALOGUES.filter((_, i) => i % 3 === 0).slice(0, 18);
const outcomeOf = (steps: Step[], r: TurnResult | null) => JSON.stringify({ path: steps.map((s) => `${s.action}:${s.field ?? ''}`), intent: r?.intent ? { t: r.intent.titleAr, p: r.intent.priceAr, w: r.intent.whenAr, pl: r.intent.placeAr, chips: r.intent.chips } : null });

test('provider failure fallback: with Jev failing on every call, every dialogue ends exactly as with JEV_MODE=off', { timeout: 240_000 }, async () => {
  mock = await startJevMock({ token: SIM_TOKEN });
  try {
    const u = await sessionUser('مستخدم بلا Jev');
    // baseline: rules only
    await configureJev('off', mock.url);
    const baseline = new Map<string, string>();
    for (const d of SAMPLE) {
      const r = await runDialogue(u, d);
      baseline.set(d.id, outcomeOf(r.steps, r.result));
    }
    assert.equal(mock.requests.length, 0, 'JEV_MODE=off never contacts the provider');

    const FAULTS: { name: string; faults: JevMockFault[] }[] = [
      { name: 'malformed JSON', faults: Array.from({ length: 4 }, () => ({ kind: 'malformed' as const })) },
      { name: '401 unauthorized', faults: Array.from({ length: 4 }, () => ({ kind: 'unauthorized' as const })) },
      { name: 'answer of the wrong type', faults: Array.from({ length: 4 }, () => ({ kind: 'wrong_type' as const })) },
      { name: 'dropped socket', faults: Array.from({ length: 4 }, () => ({ kind: 'drop' as const })) },
    ];
    for (const f of FAULTS) {
      await configureJev('simulate', mock.url);
      let attempted = 0;
      let disclosed = 0;
      for (const d of SAMPLE) {
        const conv = await startConversation(db.pool, u);
        const steps: Step[] = [];
        let result: TurnResult | null = null;
        for (let i = 0; i < d.turns.length; i++) {
          await armFaults(f.faults);
          const before = mock.requests.filter((q) => q.path === '/v1/systemone').length;
          result = await turn(u, conv.id, d.turns[i]!.user);
          const calls = mock.requests.filter((q) => q.path === '/v1/systemone').length - before;
          if (calls > 0) {
            attempted++;
            assert.equal(result.understanding.engine, 'rules', `${f.name} ${d.id}#${i}: a failed provider never decides`);
            if (result.understanding.notesAr?.includes(FALLBACK_NOTE)) disclosed++;
          }
          assert.ok(result.understanding.latencyMs < Number(process.env.UL_JEV_BUDGET_MS) + 1500, `${f.name}: bounded latency (${result.understanding.latencyMs} ms)`);
          const row = await convRow(conv.id);
          steps.push({ i, text: d.turns[i]!.user, action: result.action, field: result.question?.field ?? null, qid: result.question?.id ?? null, expect: null, resolvedAfter: row.draft.resolved ?? [], asked: row.draft.asked ?? {} });
          if (result.action === 'saved') break;
        }
        assert.equal(outcomeOf(steps, result), baseline.get(d.id), `${f.name}: ${d.id} ends exactly as with rules only`);
      }
      console.log(`      info: ${f.name}: Jev attempted on ${attempted} turns, fallback disclosed on ${disclosed}`);
      assert.ok(attempted > 0, `${f.name}: the sample really exercised the provider path`);
      assert.equal(disclosed, attempted, `${f.name}: every failed attempt is disclosed to the user`);
    }
    // unreachable provider (nothing listens): the health gate never opens, turns never wait
    const dead = await new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
    await configureJev('simulate', `http://127.0.0.1:${dead}`);
    for (const d of SAMPLE.slice(0, 6)) {
      const r = await runDialogue(u, d);
      assert.equal(outcomeOf(r.steps, r.result), baseline.get(d.id), `unreachable: ${d.id} ends exactly as with rules only`);
    }
  } finally {
    await configureJev('off', 'http://127.0.0.1:9');
    await mock.close();
    mock = null;
  }
});
