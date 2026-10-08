// Provider failure & fallback, proven end to end through the HTTP API (buildApp + inject):
// JEV_MODE=off, JEV_MODE=simulate against the local mock, and injected faults (500, hang, malformed,
// wrong answers, 401, dropped sockets, slow answers, 429). Turns must always succeed via the rule parser,
// within UL_JEV_BUDGET_MS, with understanding.engine and /api/ai/status telling the truth.
import './server-env.ts';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Client, harness, sleep, type Harness } from './server-helpers.ts';
import { startJevMock, type JevMock, type JevMockFault } from '../mocks/jev-mock-server.ts';
import { defaultJevCache, getJev, getJevStatus, resetJevRuntime, SIM_TOKEN } from '../../src/ai/index.ts';
import { _resetJevGate, jevUsable } from '../../src/conversation/jev-gate.ts';

const BUDGET = Number(process.env.UL_JEV_BUDGET_MS);
const SLACK_MS = 150; // parse + bookkeeping after the Jev call returns/aborts
/** Rules alone leave the place strictness open here; the simulation resolves it ("قريب" → preferred). */
const JEV_UTTERANCE = 'بدي كهربجي قريب من الباب';
const FALLBACK_NOTE = 'تعذّر الوصول إلى Jev — استُخدم المحلّل المحلي';

let h: Harness;
let mock: JevMock;
let a: Client;

before(async () => {
  mock = await startJevMock({ token: SIM_TOKEN }); // the mock rejects anything but the local simulation token
  h = await harness('jev');
  a = new Client(h);
  await a.register('مختبر Jev');
});
after(async () => {
  process.env.JEV_MODE = 'off';
  resetJevRuntime();
  await h?.close();
  await mock?.close();
});
beforeEach(() => { mock.reset(); });

/** Fresh client + status + cache + health gate, as after a restart with this env. */
async function configure(mode: 'off' | 'simulate' | 'live', baseUrl = mock.url, openGate = true): Promise<void> {
  process.env.JEV_MODE = mode;
  process.env.TYPESAFE_BASE_URL = baseUrl;
  resetJevRuntime();
  defaultJevCache.clear();
  _resetJevGate();
  const rt = getJev();
  if (rt.client && openGate) {
    jevUsable(rt.client); // background probe (GET /v1/models)
    for (let i = 0; i < 200 && !jevUsable(rt.client); i++) await sleep(10);
    assert.ok(jevUsable(rt.client), 'health gate opened after a successful probe');
  }
  mock.reset();
}

async function turn(text = JEV_UTTERANCE) {
  const conv = await a.newConversation();
  const r = await a.say(conv, text);
  assert.equal(r.status, 200, `turn must succeed: ${r.raw}`);
  return r;
}

const systemOneCalls = () => mock.requests.filter((r) => r.path === '/v1/systemone').length;

test('JEV_MODE=off: rules only, the provider is never contacted, status says so', async () => {
  await configure('off');
  const r = await turn();
  assert.equal(r.body.understanding.engine, 'rules');
  assert.equal(r.body.understanding.notesAr, undefined);
  assert.equal(mock.requests.length, 0, 'no request to any Jev endpoint');
  const s = (await a.get('/api/ai/status')).body;
  assert.equal(s.mode, 'rules');
  assert.equal(s.verified, false);
  assert.match(s.labelAr, /المحلّل المحلي فقط/);
  const hl = (await a.get('/api/health')).body;
  assert.equal(hl.jev.mode, 'rules');
});

test('JEV_MODE=simulate: the mock answers, engine=jev-sim, recorded in extraction_runs, never "verified"', async () => {
  await configure('simulate');
  const r = await turn();
  assert.equal(r.body.understanding.engine, 'jev-sim');
  assert.ok(r.body.understanding.notesAr.some((n: string) => n.includes('محاكاة Jev')), 'note names the simulation');
  assert.ok(r.body.understanding.latencyMs <= BUDGET + SLACK_MS);
  assert.equal(systemOneCalls(), 1, 'one batched System One call');
  assert.ok(mock.requests.every((q) => q.authorized), 'only the local simulation token is sent (real key never leaves)');
  const { rows } = await h.db.pool.query("SELECT engine, model FROM extraction_runs ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].engine, 'jev-sim');
  const s = (await a.get('/api/ai/status')).body;
  assert.equal(s.mode, 'jev-sim');
  assert.equal(s.verified, false, 'a simulation never counts as verified');
  assert.match(s.labelAr, /محاكاة/);
  assert.equal(s.lastError, null);
  assert.ok(s.lastSuccessAt);
});

test('simulate: one transient 500 is retried inside the budget and Jev still answers', async () => {
  await configure('simulate');
  mock.setFaults([{ kind: 'server_error' }]);
  const r = await turn();
  assert.equal(r.body.understanding.engine, 'jev-sim');
  assert.equal(systemOneCalls(), 2, 'first attempt 500, retry succeeded');
  assert.ok(r.body.understanding.latencyMs <= BUDGET + SLACK_MS, `latency ${r.body.understanding.latencyMs} ms within budget ${BUDGET}`);
});

const FAULTS: { name: string; faults: JevMockFault[]; budgetBug?: boolean }[] = [
  { name: 'hang (no answer at all)', faults: [{ kind: 'hang' }] },
  { name: 'slow answer (3 s)', faults: [{ kind: 'latency', ms: 3000 }] },
  { name: 'malformed JSON', faults: [{ kind: 'malformed' }] },
  { name: 'answer of the wrong type', faults: [{ kind: 'wrong_label' }] },
  { name: 'missing answer', faults: [{ kind: 'missing_answer' }] },
  { name: 'out-of-range probability', faults: [{ kind: 'out_of_range' }] },
  { name: '401 unauthorized', faults: [{ kind: 'unauthorized' }] },
  { name: 'dropped socket ×3', faults: [{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }], budgetBug: true },
  { name: 'persistent 500 ×3', faults: [{ kind: 'server_error' }, { kind: 'server_error' }, { kind: 'server_error' }], budgetBug: true },
  { name: '429 with retry-after 3 s', faults: [{ kind: 'rate_limit', retryAfterMs: 3000 }], budgetBug: true },
];

for (const f of FAULTS) {
  test(`simulate + ${f.name}: turn succeeds via rules, engine=rules, status honest`, async () => {
    await configure('simulate');
    mock.setFaults(f.faults);
    const r = await turn();
    assert.equal(r.body.understanding.engine, 'rules', 'engine reflects that the rules decided');
    assert.ok(r.body.understanding.notesAr?.includes(FALLBACK_NOTE), 'the fallback is disclosed');
    assert.ok(systemOneCalls() >= 1, 'Jev really was attempted');
    assert.ok(r.body.action === 'saved' || r.body.action === 'ask', 'the conversation moved on');
    if (!f.budgetBug) {
      assert.ok(r.body.understanding.latencyMs <= BUDGET + SLACK_MS, `latency ${r.body.understanding.latencyMs} ms within budget ${BUDGET}`);
      assert.ok(r.ms <= BUDGET + 1000, `wall time ${Math.round(r.ms)} ms`);
    } else {
      assert.ok(r.body.understanding.latencyMs <= 3000 + BUDGET, `bounded (${r.body.understanding.latencyMs} ms)`);
    }
    const s = (await a.get('/api/ai/status')).body;
    assert.equal(s.mode, 'rules', 'status no longer promises Jev');
    assert.match(s.labelAr, /لا تستجيب/);
    assert.ok(s.lastError, 'last error is reported');
    assert.ok(!/[؀-ۿ]/.test(s.lastError), 'no user text in the error');
    assert.equal(s.verified, false);
    // the gate is now closed: the next turn does not wait on the failing provider at all
    mock.reset();
    const r2 = await turn('بدي شقة بإعزاز ياريت');
    assert.equal(r2.body.understanding.engine, 'rules');
    assert.equal(systemOneCalls(), 0, 'no provider call while the gate is closed');
    assert.ok(r2.body.understanding.latencyMs < 300, `fast fallback (${r2.body.understanding.latencyMs} ms)`);
  });
}

// Regression: the retry backoff / retry-after sleep must end when the caller's AbortSignal fires, so a 429 with a
// long retry-after (or 5xx/socket-drop backoff) never overruns UL_JEV_BUDGET_MS.
for (const f of FAULTS.filter((x) => x.budgetBug)) {
  test(`simulate + ${f.name}: first failing turn stays within UL_JEV_BUDGET_MS`, async () => {
    await configure('simulate');
    mock.setFaults(f.faults);
    const r = await turn();
    assert.equal(r.body.understanding.engine, 'rules');
    assert.ok(r.body.understanding.latencyMs <= BUDGET + SLACK_MS, `latency ${r.body.understanding.latencyMs} ms > budget ${BUDGET}`);
  });
}

test('simulate: provider recovers → status and engine return to jev-sim after the next good probe', async () => {
  await configure('simulate');
  mock.setFaults([{ kind: 'malformed' }]);
  assert.equal((await turn()).body.understanding.engine, 'rules');
  assert.equal((await a.get('/api/ai/status')).body.mode, 'rules');
  // a successful probe (what the gate does every 2 min) re-opens the gate
  _resetJevGate();
  const c = getJev().client!;
  jevUsable(c);
  for (let i = 0; i < 200 && !jevUsable(c); i++) await sleep(10);
  defaultJevCache.clear();
  const r = await turn();
  assert.equal(r.body.understanding.engine, 'jev-sim');
  assert.equal((await a.get('/api/ai/status')).body.mode, 'jev-sim');
});

test('simulate with the mock unreachable: probe fails, turns use rules without waiting', async () => {
  const port = await new Promise<number>((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
  await configure('simulate', `http://127.0.0.1:${port}`, false);
  const c = getJev().client!;
  jevUsable(c); // background probe → ECONNREFUSED (retried inside the probe's own 3 s budget)
  // the turn does not wait for the probe: the gate only opens after a successful one
  const r = await turn();
  assert.equal(r.body.understanding.engine, 'rules');
  assert.ok(r.body.understanding.latencyMs < 300, `fast (${r.body.understanding.latencyMs} ms)`);
  assert.equal(mock.requests.length, 0);
  // once the probe has given up, the status says so (no promise of a simulation that cannot answer)
  for (let i = 0; i < 600 && getJevStatus().mode !== 'rules'; i++) await sleep(10);
  const s = (await a.get('/api/ai/status')).body;
  assert.equal(s.mode, 'rules');
  assert.match(s.labelAr, /لا تستجيب/);
  assert.ok(s.lastError);
  assert.ok(!/[؀-ۿ]/.test(s.lastError), 'no user text in the error');
});

test('JEV_MODE=live refuses a loopback URL: rules only, labelled misconfigured, mock never called', async () => {
  await configure('live', mock.url, false);
  const r = await turn();
  assert.equal(r.body.understanding.engine, 'rules');
  assert.equal(mock.requests.length, 0);
  const s = (await a.get('/api/ai/status')).body;
  assert.equal(s.mode, 'rules');
  assert.equal(s.verified, false);
  assert.match(s.labelAr, /المحلّل المحلي فقط/);
});
