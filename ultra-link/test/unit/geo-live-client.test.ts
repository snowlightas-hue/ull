// public/js/geo/live.js with a fake geolocation, API and clock: consent / denial, throttling (≥ 15 s or ≥ 50 m, never
// under the server's 10 s floor), heartbeat while stationary, 429 retry, fatal errors stop, coarse fixes skipped,
// stop() tells the server, auto-stop after 2 h, and the honest "page must stay open" note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSharing, LIVE_NOTE_AR, metresBetween, type LiveStatus } from '../../public/js/geo/live.js';

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const AZAZ = { lat: 36.5866, lng: 37.0463 };
const north = (m: number) => ({ lat: AZAZ.lat + m / 111_195, lng: AZAZ.lng });

function rig(opts: { failWith?: (n: number) => { status: number; messageAr?: string } | null; withDel?: boolean; geolocation?: boolean } = {}) {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let seq = 0;
  const calls: { method: string; path: string; body: any; at: number }[] = [];
  let posts = 0;
  const api: any = {
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body, at: t });
      if (path.endsWith('/live')) {
        const f = opts.failWith?.(posts++);
        if (f) throw Object.assign(new Error(f.messageAr ?? 'x'), f);
      }
      return { live: { sharing: true } };
    },
  };
  if (opts.withDel) api.del = async (path: string, body: any) => { calls.push({ method: 'DELETE', path, body, at: t }); return { ok: true }; };
  let watcher: { ok: Function; err: Function } | null = null;
  let cleared = 0;
  const geolocation = opts.geolocation === false ? null : {
    watchPosition: (ok: Function, err: Function) => { watcher = { ok, err }; return 7; },
    clearWatch: (id: number) => { assert.equal(id, 7); cleared++; watcher = null; },
  };
  const statuses: LiveStatus[] = [];
  const s = createLiveSharing({
    api, intentId: ID, onStatus: (x) => statuses.push(x), geolocation: geolocation as any, now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    doc: null, keepaliveFetch: () => {},
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return {
    s, calls, statuses, get cleared() { return cleared; }, get watching() { return !!watcher; },
    fix: async (p: { lat: number; lng: number }, accuracy = 8, extra: Record<string, number> = {}) => { watcher!.ok({ coords: { latitude: p.lat, longitude: p.lng, accuracy, ...extra } }); await flush(); },
    fail: async (code: number) => { watcher!.err({ code }); await flush(); },
    /** advance the clock, running due timers in order */
    advance: async (ms: number) => {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
    sentLive: () => calls.filter((c) => c.method === 'POST' && c.path === `/api/intents/${ID}/live`),
  };
}

test('consent → first fix sent at once; then ≥ 15 s, or ≥ 50 m but never under 10 s', async () => {
  const r = rig();
  assert.equal((await r.s.start()).state, 'starting');
  assert.equal(r.s.status.noteAr, LIVE_NOTE_AR);
  assert.match(LIVE_NOTE_AR, /فقط ما دامت هذه الصفحة مفتوحة/);
  await r.fix(AZAZ, 8, { heading: 359.6, speed: 10 });
  assert.equal(r.sentLive().length, 1);
  assert.deepEqual(r.sentLive()[0]!.body, { lat: AZAZ.lat, lng: AZAZ.lng, accuracyM: 8, heading: 0, speedKmh: 36 });
  assert.equal(r.s.status.state, 'sharing');
  // moved 120 m after 4 s: waits for the 10 s floor, then sends the newest fix
  await r.advance(4000);
  await r.fix(north(120));
  assert.equal(r.sentLive().length, 1);
  await r.advance(5900);
  assert.equal(r.sentLive().length, 1);
  await r.advance(200);
  assert.equal(r.sentLive().length, 2);
  assert.ok(Math.abs(metresBetween(r.sentLive()[1]!.body, north(120))) < 0.01);
  // small moves (10 m) wait for 15 s
  await r.advance(3000);
  await r.fix(north(130));
  await r.advance(11_000);
  assert.equal(r.sentLive().length, 2, 'not before 15 s');
  await r.advance(1100);
  assert.equal(r.sentLive().length, 3);
  // intervals between accepted sends are never under the 10 s floor
  const at = r.sentLive().map((c) => c.at);
  for (let i = 1; i < at.length; i++) assert.ok(at[i]! - at[i - 1]! >= 10_000, `gap ${at[i]! - at[i - 1]!}`);
});

test('stationary phone: re-sends its last fix every 60 s to stay «متصل»', async () => {
  const r = rig();
  await r.s.start();
  await r.fix(AZAZ);
  await r.advance(59_000);
  assert.equal(r.sentLive().length, 1);
  await r.advance(2000);
  assert.equal(r.sentLive().length, 2);
  await r.advance(60_000);
  assert.equal(r.sentLive().length, 3);
});

test('429 → retried after the server floor; a coarse fix is not sent; network errors retry', async () => {
  const r = rig({ failWith: (n) => (n === 0 ? { status: 429 } : n === 1 ? { status: 0, messageAr: 'network' } : null) });
  await r.s.start();
  await r.fix(AZAZ);
  assert.equal(r.sentLive().length, 1);
  assert.equal(r.s.status.state, 'starting');
  await r.advance(10_000);
  assert.equal(r.sentLive().length, 2, 'retried after 10 s');
  assert.match(r.s.status.errorAr ?? '', /سنحاول مجددًا/);
  await r.advance(15_000);
  assert.equal(r.sentLive().length, 3);
  assert.equal(r.s.status.state, 'sharing');
  assert.equal(r.s.status.errorAr, null);
  await r.advance(20_000);
  await r.fix(north(500), 5000);
  assert.equal(r.sentLive().length, 3, 'coarse fix skipped');
  assert.match(r.s.status.errorAr ?? '', /دقة الموقع ضعيفة/);
});

test('fatal answers stop sharing (no server call needed); permission denied → denied', async () => {
  const r = rig({ failWith: () => ({ status: 409, messageAr: 'العرض غير نشط — استأنفه أولًا لمشاركة موقعك' }) });
  await r.s.start();
  await r.fix(AZAZ);
  assert.equal(r.s.status.state, 'error');
  assert.equal(r.s.status.errorAr, 'العرض غير نشط — استأنفه أولًا لمشاركة موقعك');
  assert.equal(r.cleared, 1);
  assert.equal(r.calls.filter((c) => c.path.endsWith('/stop')).length, 0);
  const d = rig();
  await d.s.start();
  await d.fail(1);
  assert.equal(d.s.status.state, 'denied');
  assert.equal(d.cleared, 1);
  const t = rig();
  await t.s.start();
  await t.fail(3);
  assert.equal(t.s.status.state, 'starting', 'a timeout keeps trying');
  assert.match(t.s.status.errorAr ?? '', /تأخر/);
});

test('stop() clears the watch and tells the server (DELETE when available, else POST …/live/stop); auto-stop after 2 h', async () => {
  const a = rig({ withDel: true });
  await a.s.start();
  await a.fix(AZAZ);
  const st = await a.s.stop();
  assert.equal(st.state, 'stopped');
  assert.equal(a.cleared, 1);
  assert.deepEqual(a.calls.at(-1)!.method + ' ' + a.calls.at(-1)!.path, `DELETE /api/intents/${ID}/live`);
  await a.advance(120_000);
  assert.equal(a.sentLive().length, 1, 'nothing after stop');
  const b = rig();
  await b.s.start();
  await b.fix(AZAZ);
  await b.advance(2 * 3600_000 + 1000);
  assert.equal(b.s.status.state, 'stopped');
  assert.match(b.s.status.errorAr ?? '', /بعد ساعتين/);
  assert.equal(b.calls.at(-1)!.path, `/api/intents/${ID}/live/stop`);
  const sends = b.sentLive().length;
  await b.advance(600_000);
  assert.equal(b.sentLive().length, sends);
  // never started sending → no server call on stop
  const c = rig();
  await c.s.start();
  await c.s.stop();
  assert.equal(c.calls.length, 0);
});

test('no geolocation → unavailable; bad arguments throw', async () => {
  const r = rig({ geolocation: false });
  assert.equal((await r.s.start()).state, 'unavailable');
  assert.throws(() => createLiveSharing({ api: { post: async () => ({}) }, intentId: '123' }), /public id/);
  assert.throws(() => createLiveSharing({ api: null as any, intentId: ID }), /api.post/);
});
