// Jev client tests against the local SIMULATION mock (the real API is unreachable from CI/containers).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { inspect } from 'node:util';
import { backoffDelayMs, createJevClient, JevError, MAX_CHOICE_LABELS, parseRetryAfter } from '../../src/ai/jev-client.ts';
import type { JevClientOptions, JevQuestions } from '../../src/ai/jev-client.ts';
import { startJevMock } from '../mocks/jev-mock-server.ts';
import type { JevMock } from '../mocks/jev-mock-server.ts';

const KEY = 'sk-ULTRA-SECRET-0123456789abcdefXYZ';
const UTTER = 'بدي شقة بإعزاز لعائلتي السرية';
const Q = {
  side: { type: 'choice', instructions: 'role?', criteria: { seek: 'looking for', provide: 'offering', join: 'activity' } },
  strict: { type: 'noul', instructions: 'only this place?', criteria: { true: 'only', false: 'preference' } },
} satisfies JevQuestions;

let mock: JevMock;
before(async () => {
  mock = await startJevMock({ token: KEY });
});
after(async () => {
  await mock.close();
});
beforeEach(() => mock.reset());

function client(extra: Partial<JevClientOptions> = {}) {
  return createJevClient({ apiKey: KEY, baseUrl: mock.url, backoffInitialMs: 20, backoffMaxMs: 100, timeoutMs: 2000, budgetMs: 5000, ...extra });
}

async function rejects(p: Promise<unknown>): Promise<JevError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof JevError, `expected JevError, got ${String(e)}`);
    return e;
  }
  assert.fail('expected the call to reject');
}

async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('systemOne happy path', () => {
  it('sends the SDK wire shape and validates the response', async () => {
    const r = await client().systemOne({ utterance: UTTER, language: 'ar' }, Q);
    assert.equal(r.model, 'jev-sim');
    assert.equal(r.answers.side.type, 'choice');
    assert.ok(['seek', 'provide', 'join'].includes(r.answers.side.choice));
    assert.equal(r.answers.strict.type, 'noul');
    assert.ok(r.answers.strict.noul >= 0 && r.answers.strict.noul <= 1);
    assert.match(r.requestId ?? '', /^sim-\d+$/);
    assert.ok(typeof r.usage.inputTokens === 'number' && r.usage.inputTokens > 0);
    assert.ok(r.latencyMs >= 0);
    assert.equal(r.attempts, 1);
    const req = mock.requests[0]!;
    assert.equal(req.path, '/v1/systemone');
    assert.equal(req.authorized, true);
    assert.equal(req.contentType, 'application/json');
    assert.equal(req.retryCount, null);
    assert.deepEqual(Object.keys(req.body as object).sort(), ['model', 'questions', 'state']);
    assert.equal((req.body as { model: string }).model, 'jev-latest');
  });

  it('listModels returns validated models', async () => {
    const r = await client().listModels();
    assert.equal(r.models[0]!.name, 'jev-latest');
    assert.match(r.models[0]!.description, /SIMULATION/);
  });

  it('listModels rejects a malformed models payload', async () => {
    mock.setFaults([{ kind: 'status', status: 200, body: { models: 'nope' } }]);
    const e = await rejects(client().listModels());
    assert.equal(e.kind, 'bad_response');
  });
});

describe('retries and backoff (SDK semantics)', () => {
  it('honors retry-after-ms on 429 and sends X-TypeSafe-Retry-Count', async () => {
    mock.setFaults([{ kind: 'rate_limit', retryAfterMs: 250 }]);
    const delays: number[] = [];
    const t0 = Date.now();
    const r = await client({ sleep: (ms) => (delays.push(ms), new Promise((res) => setTimeout(res, ms))) }).systemOne(UTTER, Q);
    assert.equal(r.attempts, 2);
    assert.deepEqual(delays, [250]);
    assert.ok(Date.now() - t0 >= 240, 'waited for retry-after-ms');
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1]!.retryCount, '1');
  });

  it('honors retry-after (seconds) header', async () => {
    mock.setFaults([{ kind: 'rate_limit', retryAfterSec: 0 }]);
    const delays: number[] = [];
    await client({ sleep: async (ms) => void delays.push(ms) }).systemOne(UTTER, Q);
    assert.deepEqual(delays, [0]);
  });

  it('parseRetryAfter: ms wins, seconds, HTTP date, negatives and garbage', () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    assert.equal(parseRetryAfter(h({ 'retry-after-ms': '120', 'retry-after': '9' })), 120);
    assert.equal(parseRetryAfter(h({ 'retry-after': '2' })), 2000);
    assert.equal(parseRetryAfter(h({ 'retry-after': '1.5' })), 1500);
    const now = Date.parse('2026-10-08T12:00:00Z');
    assert.equal(parseRetryAfter(h({ 'retry-after': 'Thu, 08 Oct 2026 12:00:03 GMT' }), now), 3000);
    assert.equal(parseRetryAfter(h({ 'retry-after': '-1' })), null);
    assert.equal(parseRetryAfter(h({ 'retry-after-ms': '-5' })), null);
    assert.equal(parseRetryAfter(h({ 'retry-after': 'soon' })), null);
    assert.equal(parseRetryAfter(h({})), null);
  });

  it('backoff doubles from 0.5 s, caps at 5 s, jitter only subtracts', () => {
    assert.equal(backoffDelayMs(1, 500, 5000, 0.25, () => 0), 500);
    assert.equal(backoffDelayMs(2, 500, 5000, 0.25, () => 0), 1000);
    assert.equal(backoffDelayMs(4, 500, 5000, 0.25, () => 0), 4000);
    assert.equal(backoffDelayMs(5, 500, 5000, 0.25, () => 0), 5000);
    assert.equal(backoffDelayMs(9, 500, 5000, 0.25, () => 0), 5000);
    assert.equal(backoffDelayMs(1, 500, 5000, 0.25, () => 1), 375);
    assert.equal(backoffDelayMs(1, 0, 5000, 0.25), 0);
  });

  it('retries 5xx with exponential backoff and then succeeds', async () => {
    mock.setFaults([{ kind: 'server_error' }, { kind: 'server_error', status: 503 }]);
    const delays: number[] = [];
    const r = await client({ random: () => 0, sleep: async (ms) => void delays.push(ms) }).systemOne(UTTER, Q);
    assert.equal(r.attempts, 3);
    assert.deepEqual(delays, [20, 40]);
    assert.deepEqual(mock.requests.map((x) => x.retryCount), [null, '1', '2']);
  });

  it('gives up after maxRetries (2) with kind server', async () => {
    mock.setFaults([{ kind: 'server_error' }, { kind: 'server_error' }, { kind: 'server_error' }, { kind: 'server_error' }]);
    const e = await rejects(client({ sleep: async () => {} }).systemOne(UTTER, Q));
    assert.equal(e.kind, 'server');
    assert.equal(e.status, 500);
    assert.equal(e.attempts, 3);
    assert.equal(mock.requests.length, 3);
    assert.match(e.requestId ?? '', /^sim-/);
  });

  it('treats 408 as a retryable timeout', async () => {
    mock.setFaults([{ kind: 'status', status: 408 }]);
    const r = await client({ sleep: async () => {} }).systemOne(UTTER, Q);
    assert.equal(r.attempts, 2);
  });

  it('does not retry 401 (auth)', async () => {
    mock.setFaults([{ kind: 'unauthorized' }]);
    const e = await rejects(client().systemOne(UTTER, Q));
    assert.equal(e.kind, 'auth');
    assert.equal(e.status, 401);
    assert.equal(mock.requests.length, 1);
  });

  it('a wrong key is an auth error', async () => {
    const e = await rejects(createJevClient({ apiKey: 'sk-wrong-key-123', baseUrl: mock.url }).systemOne(UTTER, Q));
    assert.equal(e.kind, 'auth');
    assert.equal(mock.requests.length, 1);
  });

  it('does not retry 422 (validation) and reports only safe parts of the detail', async () => {
    mock.setFaults([
      { kind: 'status', status: 422, body: { detail: [{ loc: ['body', 'questions', 'side', 'criteria'], msg: 'Field required', type: 'missing', input: UTTER }] } },
    ]);
    const e = await rejects(client().systemOne(UTTER, Q));
    assert.equal(e.kind, 'validation');
    assert.equal(e.status, 422);
    assert.equal(mock.requests.length, 1);
    assert.match(e.message, /questions\.side\.criteria \[missing\] Field required/);
  });

  it('the mock itself answers 422 for a bad request shape (like the real API)', async () => {
    const res = await fetch(`${mock.url}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', questions: { a: { type: 'choice' } } }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as { detail: { loc: unknown[]; type: string }[] };
    assert.deepEqual(body.detail.map((d) => d.type).sort(), ['missing', 'missing']);
    assert.ok(body.detail.some((d) => JSON.stringify(d.loc) === JSON.stringify(['body', 'state'])));
    assert.ok(body.detail.some((d) => JSON.stringify(d.loc) === JSON.stringify(['body', 'questions', 'a', 'choice', 'criteria'])));
  });

  it('client-side validation rejects bad questions without any request', async () => {
    const c = client();
    assert.equal((await rejects(c.systemOne(UTTER, {}))).kind, 'validation');
    const many = Object.fromEntries(Array.from({ length: MAX_CHOICE_LABELS + 1 }, (_, i) => [`l${i}`, null]));
    assert.equal((await rejects(c.systemOne(UTTER, { big: { type: 'choice', criteria: many } }))).kind, 'validation');
    assert.equal((await rejects(c.systemOne(UTTER, { s: { type: 'score', criteria: [] } }))).kind, 'validation');
    assert.equal((await rejects(c.systemOne(UTTER, { 'bad name!': { type: 'noul' } }))).kind, 'validation');
    assert.equal(mock.requests.length, 0);
  });
});

describe('timeouts and network errors', () => {
  it('per-attempt timeout -> kind timeout', async () => {
    mock.setFaults([{ kind: 'hang' }]);
    const t0 = Date.now();
    const e = await rejects(client({ timeoutMs: 150, maxRetries: 0 }).systemOne(UTTER, Q));
    assert.equal(e.kind, 'timeout');
    assert.ok(Date.now() - t0 < 1500);
  });

  it('timeouts are retried and a later attempt can succeed', async () => {
    mock.setFaults([{ kind: 'hang' }]);
    const r = await client({ timeoutMs: 150, sleep: async () => {} }).systemOne(UTTER, Q);
    assert.equal(r.attempts, 2);
  });

  it('the total budget caps retries', async () => {
    mock.setFaults([{ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' }]);
    const t0 = Date.now();
    const e = await rejects(client({ timeoutMs: 200, budgetMs: 450, maxRetries: 5, backoffInitialMs: 10 }).systemOne(UTTER, Q));
    const took = Date.now() - t0;
    assert.equal(e.kind, 'timeout');
    assert.ok(took < 900, `took ${took} ms`);
    assert.ok(mock.requests.length <= 3);
  });

  it('a retry-after longer than the remaining budget stops immediately', async () => {
    mock.setFaults([{ kind: 'rate_limit', retryAfterMs: 60_000 }]);
    const t0 = Date.now();
    const e = await rejects(client({ budgetMs: 1000 }).systemOne(UTTER, Q));
    assert.equal(e.kind, 'rate_limited');
    assert.equal(e.retryAfterMs, 60_000);
    assert.ok(Date.now() - t0 < 500);
    assert.equal(mock.requests.length, 1);
  });

  it('connection refused -> kind network (retried)', async () => {
    const port = await closedPort();
    const c = createJevClient({ apiKey: KEY, baseUrl: `http://127.0.0.1:${port}`, sleep: async () => {} });
    const e = await rejects(c.systemOne(UTTER, Q));
    assert.equal(e.kind, 'network');
    assert.equal(e.attempts, 3);
    assert.equal(e.status, undefined);
  });

  it('a dropped connection -> kind network', async () => {
    mock.setFaults([{ kind: 'drop' }]);
    const e = await rejects(client({ maxRetries: 0 }).systemOne(UTTER, Q));
    assert.equal(e.kind, 'network');
  });

  it('caller abort is reported and not retried', async () => {
    mock.setFaults([{ kind: 'hang' }]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const e = await rejects(client().systemOne(UTTER, Q, { signal: ac.signal }));
    assert.equal(e.kind, 'timeout');
    assert.match(e.message, /aborted by caller/);
    assert.equal(mock.requests.length, 1);
  });
});

describe('response validation', () => {
  const cases = [
    ['wrong_label', /not one of the 3 offered labels/],
    ['missing_answer', /missing answer for question 'side'/],
    ['wrong_type', /expected 'choice'/],
    ['out_of_range', /invalid at confidence/],
    ['malformed', /not valid JSON/],
  ] as const;
  for (const [kind, msg] of cases) {
    it(`${kind} -> bad_response, not retried`, async () => {
      mock.setFaults([{ kind } as never]);
      const e = await rejects(client().systemOne(UTTER, Q));
      assert.equal(e.kind, 'bad_response');
      assert.match(e.message, msg);
      assert.equal(mock.requests.length, 1);
    });
  }

  it('rejects a noul probability outside [0,1]', async () => {
    mock.setFaults([{ kind: 'out_of_range', question: 'strict' }]);
    const e = await rejects(client().systemOne(UTTER, Q));
    assert.equal(e.kind, 'bad_response');
    assert.match(e.message, /answer 'strict' invalid at noul/);
  });

  it('rejects probabilities for labels that were not offered', async () => {
    mock.setFaults([
      { kind: 'status', status: 200, body: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, answers: { side: { type: 'choice', choice: 'seek', confidence: 0.9, probabilities: { seek: 0.9, hacker: 0.1 } }, strict: { type: 'noul', noul: 0.3 } } } },
    ]);
    const e = await rejects(client().systemOne(UTTER, Q));
    assert.equal(e.kind, 'bad_response');
    assert.match(e.message, /label that was not offered/);
  });

  it('accepts usage with null token counts (SDK tolerance) and ignores extra answers', async () => {
    mock.setFaults([
      { kind: 'status', status: 200, body: { model: 'm', usage: { input_tokens: null }, answers: { extra: { type: 'future' }, side: { type: 'choice', choice: 'join', confidence: 0.6, probabilities: { join: 0.6 } }, strict: { type: 'noul', noul: 0.3 } } } },
    ]);
    const r = await client().systemOne(UTTER, Q);
    assert.deepEqual(r.usage, { inputTokens: null, outputTokens: null });
    assert.equal(r.answers.side.choice, 'join');
    assert.equal('extra' in r.answers, false);
  });
});

describe('circuit breaker', () => {
  it('opens after 3 consecutive failures, short-circuits for 60 s, then half-opens and closes on success', async () => {
    let t = 1_000_000;
    const c = client({ now: () => t, maxRetries: 0 });
    mock.setFaults([{ kind: 'server_error' }, { kind: 'server_error' }, { kind: 'server_error' }]);
    for (let i = 0; i < 3; i++) assert.equal((await rejects(c.systemOne(UTTER, Q))).kind, 'server');
    assert.equal(c.circuit().state, 'open');
    const e = await rejects(c.systemOne(UTTER, Q));
    assert.equal(e.kind, 'circuit_open');
    assert.equal(mock.requests.length, 3, 'no request while open');
    t += 59_000;
    assert.equal((await rejects(c.systemOne(UTTER, Q))).kind, 'circuit_open');
    t += 1_001;
    assert.equal(c.circuit().state, 'half-open');
    const r = await c.systemOne(UTTER, Q);
    assert.equal(r.model, 'jev-sim');
    assert.deepEqual(c.circuit(), { state: 'closed', consecutiveFailures: 0, openUntil: null });
    assert.equal(mock.requests.length, 4);
  });

  it('a failed half-open trial re-opens the circuit; only one trial at a time', async () => {
    let t = 5_000_000;
    const c = client({ now: () => t, maxRetries: 0, circuitOpenMs: 1000 });
    mock.setFaults([{ kind: 'unauthorized' }, { kind: 'unauthorized' }, { kind: 'unauthorized' }, { kind: 'server_error' }]);
    for (let i = 0; i < 3; i++) await rejects(c.systemOne(UTTER, Q));
    t += 1001;
    assert.equal((await rejects(c.systemOne(UTTER, Q))).kind, 'server', 'trial reached the server and failed');
    assert.equal(c.circuit().state, 'open');
    assert.equal((await rejects(c.systemOne(UTTER, Q))).kind, 'circuit_open');
    assert.equal(mock.requests.length, 4);

    t += 1001;
    mock.setFaults([{ kind: 'latency', ms: 150 }]);
    const trial = c.systemOne(UTTER, Q);
    const concurrent = await rejects(c.systemOne(UTTER, Q));
    assert.equal(concurrent.kind, 'circuit_open');
    await trial;
    assert.equal(c.circuit().state, 'closed');
  });

  it('successes reset the consecutive-failure count', async () => {
    const c = client({ maxRetries: 0 });
    mock.setFaults([{ kind: 'server_error' }, { kind: 'server_error' }]);
    await rejects(c.systemOne(UTTER, Q));
    await rejects(c.systemOne(UTTER, Q));
    await c.systemOne(UTTER, Q);
    mock.setFaults([{ kind: 'server_error' }, { kind: 'server_error' }]);
    await rejects(c.systemOne(UTTER, Q));
    await rejects(c.systemOne(UTTER, Q));
    assert.equal(c.circuit().state, 'closed');
  });

  it('client-side validation errors do not touch the circuit', async () => {
    const c = client({ maxRetries: 0 });
    for (let i = 0; i < 5; i++) await rejects(c.systemOne(UTTER, {}));
    assert.equal(c.circuit().state, 'closed');
  });
});

describe('secrets never leak', () => {
  it('no API key and no user text in errors, logs or console output', async () => {
    const captured: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const grab = (...a: unknown[]) => void captured.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 5 }))).join(' '));
    console.log = console.warn = console.error = console.info = console.debug = grab;
    process.stdout.write = ((chunk: unknown) => (captured.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (captured.push(String(chunk)), true)) as typeof process.stderr.write;
    const errors: JevError[] = [];
    try {
      // 6 counted failures (validation does not count) -> the 8th call is short-circuited
      const c = client({ log: (l) => console.warn(l), maxRetries: 0, timeoutMs: 150, circuitThreshold: 6, onOutcome: (o) => console.info(o) });
      mock.setFaults([
        { kind: 'status', status: 422, body: { detail: [{ loc: ['body', 'state'], msg: `bad ${KEY} ${UTTER}`, type: 'value_error', input: { utterance: UTTER, key: KEY } }] } },
        { kind: 'status', status: 500, body: `oops Bearer ${KEY} — ${UTTER}` },
        { kind: 'status', status: 401, body: { error: { message: `invalid key ${KEY}` } } },
        { kind: 'wrong_label' },
        { kind: 'malformed' },
        { kind: 'hang' },
        { kind: 'drop' },
      ]);
      for (let i = 0; i < 7; i++) {
        try {
          await c.systemOne({ utterance: UTTER }, Q);
        } catch (e) {
          errors.push(e as JevError);
        }
      }
      // circuit is open now
      try {
        await c.systemOne({ utterance: UTTER }, Q);
      } catch (e) {
        errors.push(e as JevError);
      }
      try {
        createJevClient({ apiKey: `${KEY} with space`, baseUrl: mock.url });
      } catch (e) {
        errors.push(e as JevError);
      }
    } finally {
      Object.assign(console, orig);
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    assert.deepEqual(
      errors.map((e) => e.kind),
      ['validation', 'server', 'auth', 'bad_response', 'bad_response', 'timeout', 'network', 'circuit_open', 'no_key'],
    );
    const texts = [
      ...errors.flatMap((e) => [String(e), e.message, e.stack ?? '', JSON.stringify(e), inspect(e, { depth: 5 }), e.short]),
      ...captured,
    ];
    assert.ok(captured.length > 0, 'logs were produced');
    const secretBits = [KEY, KEY.slice(3, 20), UTTER, 'شقة', 'السرية'];
    for (const t of texts) for (const s of secretBits) assert.ok(!t.includes(s), `leaked ${s === KEY ? 'API key' : 'user text'} in: ${t.slice(0, 80)}`);
    assert.ok(errors[0]!.message.includes('***'), 'key was redacted, not silently dropped');
  });
});

describe('construction', () => {
  it('missing or malformed key -> no_key', () => {
    for (const k of ['', '   ', 'has space', 'ключ']) {
      assert.throws(() => createJevClient({ apiKey: k }), (e: unknown) => e instanceof JevError && e.kind === 'no_key');
    }
  });

  it('refuses plain http to a non-loopback host (key would travel in clear text)', () => {
    assert.throws(() => createJevClient({ apiKey: KEY, baseUrl: 'http://api.typesafe.ai' }), (e: unknown) => e instanceof JevError && e.kind === 'validation');
  });

  it('engine/official flags derive from the base URL', () => {
    const real = createJevClient({ apiKey: KEY });
    assert.equal(real.baseUrl, 'https://api.typesafe.ai');
    assert.equal(real.engine, 'jev');
    assert.equal(real.official, true);
    assert.equal(real.model, 'jev-latest');
    const sim = client();
    assert.equal(sim.engine, 'jev-sim');
    assert.equal(sim.official, false);
  });

  it('does not follow redirects (the Authorization header never leaves the base URL)', async () => {
    mock.setFaults([{ kind: 'status', status: 307, headers: { location: 'https://evil.example/steal' } }]);
    const e = await rejects(client().systemOne(UTTER, Q));
    assert.equal(e.kind, 'bad_response');
    assert.equal(e.status, 307);
    assert.equal(mock.requests.length, 1);
  });
});
