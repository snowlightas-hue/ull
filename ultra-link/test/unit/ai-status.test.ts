// Status tracker + env wiring (getJev). Live calls are simulated with an injected fetch; nothing here
// touches the real network.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { getJev, resetJevRuntime, SIM_TOKEN } from '../../src/ai/index.ts';
import { LABELS_AR, JevStatusTracker } from '../../src/ai/status.ts';
import { startJevMock } from '../mocks/jev-mock-server.ts';
import type { JevMock } from '../mocks/jev-mock-server.ts';

const KEY = 'sk-REAL-KEY-never-for-the-mock-42';
const Q = { probe: { type: 'noul' as const, instructions: 'test?' } };

const okFetch = (model = 'jev-2026-09-15') =>
  (async () =>
    new Response(JSON.stringify({ model, answers: { probe: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-typesafe-request-id': 'req-real-1' },
    })) as typeof fetch;
const failFetch = (async () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED Bearer ${KEY}`), { code: 'ECONNREFUSED' }) });
}) as typeof fetch;

let mock: JevMock;
before(async () => {
  mock = await startJevMock({ token: SIM_TOKEN });
});
after(async () => {
  await mock.close();
});
afterEach(() => resetJevRuntime());

describe('getJev + status', () => {
  it('no key (auto) -> rules only', () => {
    const status = new JevStatusTracker();
    const rt = getJev({}, { status });
    assert.equal(rt.client, null);
    assert.equal(rt.setting, 'off');
    assert.deepEqual(status.snapshot(), {
      mode: 'rules', keyConfigured: false, verified: false, lastSuccessAt: null, lastError: null, lastLatencyMs: null, model: 'jev-latest', labelAr: LABELS_AR.rulesOnly,
    });
  });

  it('JEV_MODE=off with a key -> rules, says Jev is disabled', () => {
    const status = new JevStatusTracker();
    const rt = getJev({ TYPESAFE_API_KEY: KEY, JEV_MODE: 'off' }, { status });
    assert.equal(rt.client, null);
    const s = status.snapshot();
    assert.equal(s.mode, 'rules');
    assert.equal(s.keyConfigured, true);
    assert.equal(s.labelAr, LABELS_AR.rulesOnlyDisabled);
  });

  it('JEV_MODE=live without a key -> rules with a no_key reason', () => {
    const status = new JevStatusTracker();
    getJev({ JEV_MODE: 'live' }, { status });
    const s = status.snapshot();
    assert.equal(s.mode, 'rules');
    assert.match(s.lastError ?? '', /no_key/);
    assert.equal(s.labelAr, LABELS_AR.rulesOnly);
  });

  it('simulate: talks to the mock with the SIM token (never the real key); jev-sim, never verified', async () => {
    const status = new JevStatusTracker();
    const rt = getJev({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: mock.url, JEV_MODE: 'simulate' }, { status });
    assert.equal(rt.engine, 'jev-sim');
    await rt.client!.systemOne('x', Q);
    assert.equal(mock.requests.at(-1)!.authorized, true, 'mock only accepts SIM_TOKEN');
    const s = status.snapshot();
    assert.equal(s.mode, 'jev-sim');
    assert.equal(s.verified, false);
    assert.equal(s.labelAr, LABELS_AR.simulation);
    assert.equal(s.model, 'jev-sim');
    assert.ok(s.lastSuccessAt);
  });

  it('auto + loopback base URL -> simulate', () => {
    const rt = getJev({ TYPESAFE_BASE_URL: mock.url }, { status: new JevStatusTracker() });
    assert.equal(rt.setting, 'simulate');
    assert.equal(rt.engine, 'jev-sim');
  });

  it('simulate refuses a non-loopback base URL', () => {
    const status = new JevStatusTracker();
    const rt = getJev({ TYPESAFE_API_KEY: KEY, JEV_MODE: 'simulate' }, { status });
    assert.equal(rt.client, null);
    assert.equal(status.snapshot().labelAr, LABELS_AR.rulesOnlyMisconfigured);
  });

  it('live refuses a loopback base URL', () => {
    const status = new JevStatusTracker();
    const rt = getJev({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: mock.url, JEV_MODE: 'live' }, { status });
    assert.equal(rt.client, null);
    assert.equal(status.snapshot().mode, 'rules');
  });

  it('live: untested -> failing (rules fallback, sanitized error) -> connected & verified', async () => {
    const status = new JevStatusTracker();
    let fetchImpl: typeof fetch = failFetch;
    const rt = getJev({ TYPESAFE_API_KEY: KEY }, { status, fetchImpl: ((...a: Parameters<typeof fetch>) => fetchImpl(...a)) as typeof fetch, maxRetries: 0 });
    assert.equal(rt.setting, 'live');
    let s = status.snapshot();
    assert.equal(s.mode, 'jev');
    assert.equal(s.verified, false);
    assert.equal(s.labelAr, LABELS_AR.keyUntested);

    await assert.rejects(rt.client!.systemOne('x', Q));
    s = status.snapshot();
    assert.equal(s.mode, 'rules');
    assert.equal(s.labelAr, LABELS_AR.keyFailing);
    assert.match(s.lastError ?? '', /^network: network error ECONNREFUSED/);
    assert.ok(!(s.lastError ?? '').includes(KEY));

    fetchImpl = okFetch();
    await rt.client!.systemOne('x', Q);
    s = status.snapshot();
    assert.equal(s.mode, 'jev');
    assert.equal(s.verified, true, 'success from the official base URL');
    assert.equal(s.labelAr, LABELS_AR.connected);
    assert.equal(s.model, 'jev-2026-09-15');
    assert.ok(s.lastSuccessAt && s.lastLatencyMs !== null);
  });

  it('a custom https base URL can connect but is never "verified"', async () => {
    const status = new JevStatusTracker();
    const rt = getJev({ TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'https://jev.example.com' }, { status, fetchImpl: okFetch() });
    await rt.client!.systemOne('x', Q);
    const s = status.snapshot();
    assert.equal(s.mode, 'jev');
    assert.equal(s.verified, false);
    assert.equal(s.labelAr, LABELS_AR.connectedCustom);
  });

  it('memoizes per env signature and accepts TYPESAFE_DEFAULT_MODEL (SDK name)', () => {
    const env = { TYPESAFE_API_KEY: KEY, TYPESAFE_DEFAULT_MODEL: 'jev-x' };
    const a = getJev(env);
    assert.equal(getJev(env), a);
    assert.equal(a.client!.model, 'jev-x');
    assert.notEqual(getJev({ ...env, TYPESAFE_MODEL: 'jev-y' }), a);
  });
});
