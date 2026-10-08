// Live-position sharing from the browser (V2.1 location; server side: src/server/routes/geo.ts, docs/GEO.md).
//
//   const s = createLiveSharing({ api, intentId, onStatus });   // api: { post(path, body), del?(path, body) }
//   await s.start();   // the browser asks for location permission (consent) the first time
//   s.status           // { state, labelAr, noteAr, sent, startedAt, lastSentAt, errorAr, hidden }
//   await s.stop();
//
// Honest limits (shown to the user as noteAr): a web page can only follow the position while it is OPEN
// (navigator.geolocation.watchPosition). With the screen off or the tab in the background, browsers slow or stop
// updates; following a car in the background needs a native app (a later step). The server marks a position that
// was not refreshed for 10 minutes as «غير متصل», so nobody is shown a stale position as live.
//
// Sending policy: at most one update per 15 s, or sooner once moved ≥ 50 m (never faster than the server's 10 s
// floor); a stationary phone re-sends its last fix every 60 s to stay «متصل»; fixes coarser than 3 km are not sent;
// sharing stops by itself after 2 hours. No coordinates are ever logged or rendered by this module.

export const LIVE_NOTE_AR = 'المشاركة المباشرة تعمل فقط ما دامت هذه الصفحة مفتوحة. للمتابعة والشاشة مطفأة أو في الخلفية يلزم تطبيق للهاتف (لاحقًا).';
export const LIVE_DEFAULTS = Object.freeze({
  minIntervalMs: 15_000,
  minMoveM: 50,
  serverFloorMs: 10_000,
  heartbeatMs: 60_000,
  retryMs: 15_000,
  maxDurationMs: 2 * 3600_000,
  maxAccuracyM: 3000,
});
export const LIVE_LABELS_AR = Object.freeze({
  idle: 'مشاركة الموقع متوقفة',
  starting: 'جارٍ تحديد موقعك…',
  sharing: 'موقعك المباشر مُشارَك الآن',
  stopped: 'توقفت مشاركة الموقع',
  denied: 'لم تسمح بتحديد الموقع — يمكنك تفعيله من إعدادات المتصفح',
  unavailable: 'تحديد الموقع غير متاح في هذا المتصفح',
  error: 'تعذّرت مشاركة الموقع',
});

/** Distance in metres between two {lat,lng} (haversine). */
export function metresBetween(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * @param {object} o
 * @param {{post: Function, del?: Function}} o.api        JSON client (public/js/api.js); errors carry {status, messageAr}
 * @param {string} o.intentId                            public id of a provide / join intent owned by the user
 * @param {(status: object) => void} [o.onStatus]
 * @param {Geolocation} [o.geolocation]                  injectable for tests (default navigator.geolocation)
 * @param {() => number} [o.now]
 * @param {Function} [o.setTimer] @param {Function} [o.clearTimer]
 * @param {Document} [o.doc]                             visibility changes (default document)
 * @param {Function} [o.keepaliveFetch]                  best-effort stop when the page is closed (default fetch keepalive)
 * @param {object} [o.options]                           overrides of LIVE_DEFAULTS
 */
export function createLiveSharing({
  api, intentId, onStatus = () => {}, geolocation = globalThis.navigator?.geolocation, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), doc = globalThis.document,
  keepaliveFetch = defaultKeepalive, options = {},
}) {
  if (!api || typeof api.post !== 'function') throw new TypeError('createLiveSharing: api.post is required');
  if (!/^[0-9a-f-]{36}$/i.test(String(intentId))) throw new TypeError('createLiveSharing: intentId must be a public id');
  const cfg = { ...LIVE_DEFAULTS, ...options };
  const path = `/api/intents/${intentId}/live`;
  let state = 'idle';
  let watchId = null;
  let startedAt = null;
  let last = null; // last fix the server accepted { lat, lng, t }
  let pending = null; // newest fix not sent yet
  let inflight = false;
  let sent = 0;
  let errorAr = null;
  let hidden = false;
  let timer = null; // next send attempt (throttle / retry / heartbeat)
  let stopTimer = null;

  const status = () => ({
    state, labelAr: LIVE_LABELS_AR[state], noteAr: LIVE_NOTE_AR, sent, startedAt, lastSentAt: last ? last.t : null, errorAr, hidden,
    autoStopAt: startedAt === null ? null : startedAt + cfg.maxDurationMs,
  });
  const emit = () => { try { onStatus(status()); } catch { /* a view error must not stop sharing */ } };
  const set = (s, err = errorAr) => { state = s; errorAr = err; emit(); };
  const active = () => state === 'starting' || state === 'sharing';

  function schedule(ms) {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; tick(); }, Math.max(0, ms));
  }

  function tick() {
    if (!active()) return;
    // nothing new from the GPS: re-send the last fix so the server keeps us «متصل»
    if (!pending && last && now() - last.t >= cfg.heartbeatMs) pending = { ...last, t: now() };
    void flush();
  }

  /** Is `fix` worth sending now? → 0, else ms to wait. */
  function waitFor(fix) {
    if (!last) return 0;
    const dt = now() - last.t;
    if (dt >= cfg.minIntervalMs) return 0;
    if (dt >= cfg.serverFloorMs && metresBetween(last, fix) >= cfg.minMoveM) return 0;
    return metresBetween(last, fix) >= cfg.minMoveM ? cfg.serverFloorMs - dt : cfg.minIntervalMs - dt;
  }

  async function flush() {
    if (!active() || inflight || !pending) { if (active() && !inflight && last) schedule(cfg.heartbeatMs - (now() - last.t)); return; }
    const wait = waitFor(pending);
    if (wait > 0) { schedule(wait); return; }
    const fix = pending;
    pending = null;
    inflight = true;
    try {
      await api.post(path, { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, heading: fix.heading, speedKmh: fix.speedKmh });
      last = { lat: fix.lat, lng: fix.lng, t: now() };
      sent++;
      inflight = false;
      if (active()) set('sharing', null);
    } catch (e) {
      inflight = false;
      const st = e && e.status;
      if (st === 429) {
        // the server's 10 s floor (another tab of the same intent?) — keep the newest fix and try again shortly
        if (!pending) pending = fix;
        schedule(cfg.serverFloorMs);
        return;
      }
      if (st === 404 || st === 409 || st === 422 || st === 401 || st === 403) {
        await stop({ reason: 'error', errorAr: (e && e.messageAr) || LIVE_LABELS_AR.error, notifyServer: false });
        return;
      }
      if (!pending) pending = fix;
      if (active()) set(state, 'تعذّر إرسال الموقع — سنحاول مجددًا');
      schedule(cfg.retryMs);
      return;
    }
    void flush();
  }

  function onFix(pos) {
    if (!active()) return;
    const c = (pos && pos.coords) || {};
    if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
    const accuracyM = Math.round(Number.isFinite(c.accuracy) ? c.accuracy : 0);
    if (accuracyM > cfg.maxAccuracyM) {
      set(state, 'دقة الموقع ضعيفة الآن (أكثر من 3 كم) — جرّب في مكان مفتوح');
      return;
    }
    pending = {
      lat: c.latitude, lng: c.longitude, accuracyM,
      heading: Number.isFinite(c.heading) ? Math.round(c.heading) % 360 : null,
      speedKmh: Number.isFinite(c.speed) && c.speed >= 0 ? Math.min(400, Math.round(c.speed * 3.6)) : null,
      t: now(),
    };
    void flush();
  }

  function onError(err) {
    if (!active()) return;
    if (err && err.code === 1) { void stop({ reason: 'denied' }); return; }
    set(state, err && err.code === 3 ? 'تأخر تحديد الموقع — ما زلنا نحاول' : 'تعذّر تحديد الموقع الآن — ما زلنا نحاول');
  }

  function onVisibility() {
    hidden = !!doc && doc.visibilityState === 'hidden';
    emit();
  }
  function onPageHide() {
    // the page is going away: tell the server right away (best effort), otherwise it expires within 10 minutes
    if (sent > 0) keepaliveFetch(`${path}/stop`);
  }

  async function start() {
    if (active()) return status();
    if (!geolocation || typeof geolocation.watchPosition !== 'function') { set('unavailable', LIVE_LABELS_AR.unavailable); return status(); }
    startedAt = now();
    last = null; pending = null; sent = 0; errorAr = null;
    set('starting', null);
    watchId = geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 });
    stopTimer = setTimer(() => { void stop({ reason: 'timeout' }); }, cfg.maxDurationMs);
    if (doc && doc.addEventListener) { doc.addEventListener('visibilitychange', onVisibility); hidden = doc.visibilityState === 'hidden'; }
    if (globalThis.addEventListener) globalThis.addEventListener('pagehide', onPageHide);
    return status();
  }

  /**
   * @param {{reason?: 'user'|'timeout'|'denied'|'error', errorAr?: string, notifyServer?: boolean}} [o]
   */
  async function stop({ reason = 'user', errorAr: err = null, notifyServer = true } = {}) {
    const wasSending = sent > 0 || inflight;
    if (watchId !== null && geolocation) geolocation.clearWatch(watchId);
    watchId = null;
    if (timer !== null) clearTimer(timer);
    if (stopTimer !== null) clearTimer(stopTimer);
    timer = null; stopTimer = null; pending = null;
    if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
    if (globalThis.removeEventListener) globalThis.removeEventListener('pagehide', onPageHide);
    const next = reason === 'denied' ? 'denied' : reason === 'error' ? 'error' : 'stopped';
    const msg = reason === 'timeout' ? 'توقفت المشاركة تلقائيًا بعد ساعتين — شغّلها من جديد إن أردت' : err;
    set(next, msg);
    if (notifyServer && wasSending) {
      try {
        if (typeof api.del === 'function') await api.del(path, {});
        else await api.post(`${path}/stop`, {});
      } catch { /* the position expires on the server within 10 minutes anyway */ }
    }
    return status();
  }

  return { start, stop, get status() { return status(); } };
}

function defaultKeepalive(url) {
  try {
    if (typeof fetch !== 'function') return;
    void fetch(url, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  } catch { /* best effort */ }
}
