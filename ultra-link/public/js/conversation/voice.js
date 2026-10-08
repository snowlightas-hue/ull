// Ultra Link — Web Speech API wrapper (speech recognition + speech synthesis).
// Plain browser ES module, no dependencies. Nothing touches window/DOM at import time:
// everything happens inside createVoice({window}) so the module can be unit-tested in Node.
//
// HALF-DUPLEX INVARIANT: recognition.start() is never called while speechSynthesis is speaking or
// has pending utterances; speak() first aborts any active recognition; after speech ends we wait
// `guardMs` (default 400 ms) before opening the microphone, so the app never records its own voice.

export const DEFAULT_LANGS = Object.freeze(['ar-SY', 'ar-LB', 'ar-JO', 'ar-SA', 'ar']);
export const LANG_STORAGE_KEY = 'ul.voice.recLang';

const ENABLE_MIC_AR = 'لتفعيله: اضغط على رمز القفل بجانب عنوان الموقع، ثم اختر «السماح» للميكروفون وأعد تحميل الصفحة.';

/** Error catalogue: code → {recoverable, messageAr}. `offerText` is always true: typing always works. */
export const VOICE_ERRORS = Object.freeze({
  'not-allowed': {
    recoverable: false,
    messageAr: `لم يُسمح للموقع باستخدام الميكروفون. ${ENABLE_MIC_AR} ويمكنك كتابة طلبك بدلًا من التحدث.`,
  },
  'service-not-allowed': {
    recoverable: false,
    messageAr: `خدمة التعرّف على الكلام غير مسموحة في هذا المتصفح. ${ENABLE_MIC_AR} أو اكتب طلبك بدلًا من ذلك.`,
  },
  'audio-capture': {
    recoverable: false,
    messageAr: 'لم نجد ميكروفونًا يعمل. تأكد من توصيله وأنه غير مستخدم في تطبيق آخر، أو اكتب طلبك.',
  },
  network: {
    recoverable: true,
    messageAr:
      'التعرّف على الكلام يحتاج اتصالًا بالإنترنت (المتصفح يرسل الصوت إلى خدمة خارجية لتحويله إلى نص). تحقّق من الاتصال وأعد المحاولة، أو اكتب طلبك.',
  },
  'no-speech': {
    recoverable: true,
    messageAr: 'لم نسمع شيئًا. اضغط على الميكروفون وتحدّث مرة أخرى، أو اكتب طلبك.',
  },
  aborted: {
    recoverable: true,
    messageAr: 'توقف الاستماع. اضغط على الميكروفون للمحاولة مرة أخرى.',
  },
  'language-not-supported': {
    recoverable: false,
    messageAr: 'المتصفح لا يدعم التعرّف على الكلام بالعربية. اكتب طلبك بدلًا من ذلك.',
  },
  'bad-grammar': {
    recoverable: true,
    messageAr: 'حدث خطأ في التعرّف على الكلام. حاول مرة أخرى أو اكتب طلبك.',
  },
  unsupported: {
    recoverable: false,
    messageAr: 'متصفحك لا يدعم التعرّف على الكلام. استخدم Chrome أو Edge أو Safari، أو اكتب طلبك.',
  },
  'start-failed': {
    recoverable: true,
    messageAr: 'تعذّر تشغيل الميكروفون. حاول مرة أخرى أو اكتب طلبك.',
  },
  busy: {
    recoverable: true,
    messageAr: 'ما زال التطبيق يتكلم. انتظر لحظة ثم اضغط على الميكروفون.',
  },
  unknown: {
    recoverable: true,
    messageAr: 'حدث خطأ في التعرّف على الكلام. حاول مرة أخرى أو اكتب طلبك.',
  },
});

/** Build the error object delivered to onError: {code, recoverable, messageAr, offerText, ...extra}. */
export function describeVoiceError(code, extra = {}) {
  const known = Object.prototype.hasOwnProperty.call(VOICE_ERRORS, code) ? code : 'unknown';
  const info = VOICE_ERRORS[known];
  const out = { code: known === 'unknown' ? String(code || 'unknown') : known, recoverable: info.recoverable, messageAr: info.messageAr, offerText: true, ...extra };
  if (extra.offline) {
    out.messageAr = 'لا يوجد اتصال بالإنترنت، والتعرّف على الكلام في المتصفح يحتاج الإنترنت. اكتب طلبك، أو أعد المحاولة بعد عودة الاتصال.';
  }
  return out;
}

/** 'ar_SA' / 'AR-sa' → 'ar-sa' (for comparisons only). */
export function normLang(lang) {
  return String(lang || '').replace(/_/g, '-').toLowerCase();
}

/**
 * Pick the best Arabic voice: first by the preferred language list (exact tag), preferring
 * on-device voices (no network stall), then any voice whose lang starts with 'ar'.
 */
export function pickArabicVoice(voices, prefs = DEFAULT_LANGS) {
  const ar = (voices || []).filter((v) => v && normLang(v.lang).startsWith('ar'));
  if (!ar.length) return null;
  const best = (list) => list.find((v) => v.localService) || list[0];
  for (const p of prefs) {
    const exact = ar.filter((v) => normLang(v.lang) === normLang(p));
    if (exact.length) return best(exact);
  }
  return best(ar);
}

/**
 * Join the results of a SpeechRecognitionEvent into {finalText, interimText}.
 * Recomputed from the full result list each time (robust to resultIndex quirks).
 */
export function readRecognitionResults(ev) {
  const finals = [];
  const interims = [];
  const results = ev && ev.results;
  const n = results ? results.length : 0;
  for (let i = 0; i < n; i++) {
    const r = results[i];
    if (!r) continue;
    const alt = r[0] || (typeof r.item === 'function' ? r.item(0) : null);
    const t = alt && typeof alt.transcript === 'string' ? alt.transcript : '';
    if (r.isFinal) finals.push(t);
    else interims.push(t);
  }
  const tidy = (parts) => parts.join(' ').replace(/\s+/g, ' ').trim();
  return { finalText: tidy(finals), interimText: tidy(interims) };
}

function defaultClock(win) {
  const g = globalThis;
  const perf = (win && win.performance) || g.performance;
  return {
    now: () => (perf && typeof perf.now === 'function' ? perf.now() : Date.now()),
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (id) => g.clearTimeout(id),
    setInterval: (fn, ms) => g.setInterval(fn, ms),
    clearInterval: (id) => g.clearInterval(id),
  };
}

function safeStorage(win) {
  return {
    get(key) {
      try {
        return win && win.localStorage ? win.localStorage.getItem(key) : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (win && win.localStorage) {
          if (value == null) win.localStorage.removeItem(key);
          else win.localStorage.setItem(key, value);
        }
      } catch {
        /* storage may be blocked (private mode); remembering the language is only a convenience */
      }
    },
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.lang]         preferred recognition language (tried before the defaults)
 * @param {string[]} [options.langs]      recognition preference list (default DEFAULT_LANGS)
 * @param {object} [options.window]       window-like object (default globalThis.window)
 * @param {object} [options.clock]        {now,setTimeout,clearTimeout,setInterval,clearInterval}
 * @param {number} [options.guardMs=400]  silence after speech before the mic may open
 * @param {number} [options.rate=0.95]    speech rate
 * @param {boolean|'auto'} [options.keepalive='auto']  Chrome long-utterance pause/resume workaround
 */
export function createVoice(options = {}) {
  const win = options.window !== undefined ? options.window : typeof window !== 'undefined' ? window : undefined;
  const nav = win ? win.navigator : undefined;
  const clock = options.clock || defaultClock(win);
  const guardMs = options.guardMs ?? 400;
  const rate = options.rate ?? 0.95;
  const keepaliveMs = options.keepaliveMs ?? 10000;
  const maxListenMs = options.maxListenMs ?? 20000;
  const endWatchdogMs = options.endWatchdogMs ?? 4000;
  const startWatchdogMs = options.startWatchdogMs ?? 8000;
  const voicesWaitMs = options.voicesWaitMs ?? 1500;
  const speakStartTimeoutMs = options.speakStartTimeoutMs ?? 4000;
  const busyWaitMs = options.busyWaitMs ?? 2000;
  const langs = [...new Set([options.lang, ...(options.langs || DEFAULT_LANGS)].filter(Boolean))];
  const storage = safeStorage(win);
  const ua = (nav && nav.userAgent) || '';
  const keepalive = options.keepalive === undefined || options.keepalive === 'auto' ? /Chrome\//.test(ua) && !/Android/i.test(ua) : !!options.keepalive;

  const Rec = win ? win.SpeechRecognition || win.webkitSpeechRecognition : undefined;
  const synth = win ? win.speechSynthesis : undefined;
  const Utter = win ? win.SpeechSynthesisUtterance : undefined;
  const support = Object.freeze({
    recognition: typeof Rec === 'function',
    synthesis: !!synth && typeof synth.speak === 'function' && typeof Utter === 'function',
  });

  let permission = 'unknown'; // 'granted' | 'denied' | 'prompt' | 'unknown'
  let permissionSource = 'none'; // 'query' | 'error' | 'none'
  let permStatusHooked = false;
  let micMissing = false;
  let serviceBlocked = false;
  let recLang = null; // language known to work (remembered)
  const failedLangs = new Set();
  let voices = [];
  let voicesLoaded = false;
  let arabicVoice = null;
  let session = null; // active listening session
  let sessionSeq = 0;
  let speakJob = null; // active speak() job
  let lastSpeechEndAt = -Infinity;
  let prevRecEnded = null; // promise resolved when the previous recognition instance fired 'end'
  const liveUtterances = new Set(); // strong refs (Chrome GC bug: onend never fires otherwise)
  const statusListeners = new Set();
  const timeline = [];
  const cleanups = [];

  const stored = storage.get(LANG_STORAGE_KEY);
  if (stored && langs.includes(stored)) recLang = stored;

  function record(type, data) {
    timeline.push({ t: Math.round(clock.now() * 10) / 10, type, ...(data || {}) });
    if (timeline.length > 500) timeline.shift();
  }

  function sleep(ms) {
    return new Promise((resolve) => clock.setTimeout(resolve, Math.max(0, ms)));
  }

  function isOnline() {
    return !(nav && nav.onLine === false);
  }

  function synthBusy() {
    if (!support.synthesis) return false;
    try {
      return !!(synth.speaking || synth.pending);
    } catch {
      return false;
    }
  }

  function isSpeaking() {
    return !!speakJob || synthBusy();
  }

  function canAutoListen() {
    return support.recognition && permission === 'granted' && isOnline() && !micMissing && !serviceBlocked && pickLang() !== null;
  }

  function canSpeak() {
    if (!support.synthesis) return false;
    // voices known and none is Arabic → an English voice would read gibberish; show text only.
    if (voicesLoaded && voices.length > 0 && !arabicVoice) return false;
    return true;
  }

  function status() {
    return {
      recognition: support.recognition,
      synthesis: support.synthesis,
      permission,
      permissionSource,
      online: isOnline(),
      voicesLoaded,
      hasArabicVoice: !!arabicVoice,
      voiceName: arabicVoice ? arabicVoice.name : null,
      voiceLang: arabicVoice ? arabicVoice.lang : null,
      recLang: recLang || pickLang(),
      listening: !!session,
      speaking: isSpeaking(),
      canAutoListen: canAutoListen(),
      canSpeak: canSpeak(),
    };
  }

  function emitStatus() {
    if (!statusListeners.size) return;
    const s = status();
    for (const fn of [...statusListeners]) {
      try {
        fn(s);
      } catch {
        /* listener errors must not break voice handling */
      }
    }
  }

  function setPermission(state, source) {
    const next = state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown';
    if (next === permission && source === permissionSource) return;
    permission = next;
    permissionSource = source;
    record('permission', { state: next, source });
    emitStatus();
  }

  async function refreshPermission() {
    const perms = nav && nav.permissions;
    if (!perms || typeof perms.query !== 'function') return permission;
    try {
      const st = await perms.query({ name: 'microphone' });
      if (st && st.state) {
        // a 'denied' learned from a not-allowed error is only overridden by an explicit 'granted'
        if (!(permissionSource === 'error' && permission === 'denied' && st.state === 'prompt')) setPermission(st.state, 'query');
        if (!permStatusHooked) {
          permStatusHooked = true;
          const onChange = () => setPermission(st.state, 'query');
          try {
            if (typeof st.addEventListener === 'function') st.addEventListener('change', onChange);
            else st.onchange = onChange;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      // Firefox and older Safari throw for 'microphone' → stay 'unknown' (tap-to-answer UI).
    }
    return permission;
  }

  // ---------- voices ----------
  function loadVoices() {
    if (!support.synthesis) return;
    let list = [];
    try {
      list = Array.from(synth.getVoices() || []);
    } catch {
      list = [];
    }
    voices = list;
    if (list.length) voicesLoaded = true;
    const before = arabicVoice;
    arabicVoice = pickArabicVoice(list, langs);
    if (before !== arabicVoice || list.length) record('voices', { count: list.length, arabic: arabicVoice ? arabicVoice.name : null });
  }

  const voiceWaiters = new Set();
  function onVoicesChanged() {
    loadVoices();
    for (const w of [...voiceWaiters]) w();
    emitStatus();
  }

  function waitForVoices(ms) {
    if (voicesLoaded || !support.synthesis) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        voiceWaiters.delete(done);
        if (timer !== null) clock.clearTimeout(timer);
        resolve();
      };
      voiceWaiters.add(done);
      timer = clock.setTimeout(() => {
        loadVoices();
        done();
      }, ms);
    });
  }

  // ---------- recognition ----------
  function pickLang() {
    if (recLang && !failedLangs.has(recLang)) return recLang;
    for (const l of langs) if (!failedLangs.has(l)) return l;
    return null;
  }

  function rememberLang(lang) {
    if (!lang || recLang === lang) return;
    recLang = lang;
    storage.set(LANG_STORAGE_KEY, lang);
    record('lang:remember', { lang });
  }

  function normalizeHandlers(h) {
    const noop = () => {};
    return {
      onStart: typeof h.onStart === 'function' ? h.onStart : noop,
      onInterim: typeof h.onInterim === 'function' ? h.onInterim : noop,
      onFinal: typeof h.onFinal === 'function' ? h.onFinal : noop,
      onEnd: typeof h.onEnd === 'function' ? h.onEnd : noop,
      onError: typeof h.onError === 'function' ? h.onError : noop,
    };
  }

  function deliverError(s, code, extra) {
    if (s.notified) return;
    s.errored = true;
    const err = describeVoiceError(code, extra);
    record('rec:error', { code: err.code, session: s.id });
    try {
      s.h.onError(err);
    } catch {
      /* ignore */
    }
  }

  function notifyEnd(s, reason) {
    if (s.notified) return;
    s.notified = true;
    record('rec:session-end', { reason, session: s.id });
    try {
      s.h.onEnd(reason);
    } catch {
      /* ignore */
    }
  }

  function clearSessionTimers(s) {
    for (const t of s.timers) clock.clearTimeout(t);
    s.timers = [];
  }

  function trackRecEnd(s) {
    let resolveEnd;
    s.endPromise = new Promise((r) => (resolveEnd = r));
    s.resolveEnd = resolveEnd;
    prevRecEnded = s.endPromise;
  }

  function finishSession(s, reason) {
    clearSessionTimers(s);
    if (session === s) session = null;
    notifyEnd(s, reason);
    emitStatus();
  }

  function abortSession(s, reason) {
    if (!s || s.notified) return;
    s.aborted = true;
    s.abortReason = reason;
    record('rec:abort', { reason, session: s.id });
    if (s.rec && !s.recEnded) {
      try {
        s.rec.abort();
      } catch {
        /* ignore */
      }
    }
    finishSession(s, 'aborted');
    // if 'end' never comes, unblock the next start anyway (not in s.timers: finishSession clears those)
    if (s.rec && !s.recEnded) clock.setTimeout(() => s.resolveEnd && s.resolveEnd(), 800);
  }

  function onRecEnd(s) {
    if (s.recEnded) return;
    s.recEnded = true;
    record('rec:end', { session: s.id });
    if (s.resolveEnd) s.resolveEnd();
    if (s.notified) return; // already finished (aborted/superseded)
    if (s.retryLang) {
      s.retryLang = false;
      const next = pickLang();
      if (next && session === s) {
        s.recEnded = false;
        clearSessionTimers(s);
        record('rec:lang-fallback', { from: s.lang, to: next, session: s.id });
        // restart outside the 'end' handler; startRecognition re-checks the half-duplex invariant
        s.timers.push(
          clock.setTimeout(() => {
            if (session === s && !s.notified) startRecognition(s, next);
          }, 30),
        );
        return;
      }
      deliverError(s, 'language-not-supported');
      finishSession(s, 'error');
      return;
    }
    if (s.errored) return finishSession(s, 'error');
    if (s.aborted) return finishSession(s, 'aborted');
    // Chrome may end without marking the last result final: fall back to the interim text.
    const text = (s.finalText || s.interimText || '').trim();
    if (text) {
      record('rec:final', { len: text.length, session: s.id, fromInterim: !s.finalText });
      session = null; // the final callback may start a new session
      clearSessionTimers(s);
      try {
        s.h.onFinal(text);
      } catch {
        /* ignore */
      }
      notifyEnd(s, 'final');
      emitStatus();
      return;
    }
    // Chrome sometimes fires 'end' with neither a result nor an error.
    deliverError(s, 'no-speech', { silentEnd: true });
    finishSession(s, 'no-speech');
  }

  function startRecognition(s, lang) {
    let rec;
    try {
      rec = new Rec();
    } catch {
      deliverError(s, 'unsupported');
      finishSession(s, 'error');
      return { started: false, reason: 'unsupported' };
    }
    s.rec = rec;
    s.lang = lang;
    s.langsTried.push(lang);
    try {
      rec.lang = lang;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
    } catch {
      /* some engines expose read-only props; defaults are acceptable */
    }
    rec.onstart = () => {
      if (s.rec !== rec) return;
      s.started = true;
      record('rec:onstart', { lang, session: s.id });
    };
    rec.onaudiostart = () => {
      if (s.rec !== rec || s.notified) return;
      s.audio = true;
      micMissing = false; // a microphone works (it may have been plugged in after an audio-capture error)
      rememberLang(lang);
      if (permission !== 'granted') refreshPermission();
      try {
        s.h.onStart({ lang });
      } catch {
        /* ignore */
      }
      emitStatus();
    };
    rec.onresult = (ev) => {
      if (s.rec !== rec || s.notified) return;
      const { finalText, interimText } = readRecognitionResults(ev);
      s.finalText = finalText;
      s.interimText = interimText;
      rememberLang(lang);
      const display = [finalText, interimText].filter(Boolean).join(' ');
      if (display) {
        try {
          s.h.onInterim(display, { finalText, interimText });
        } catch {
          /* ignore */
        }
      }
    };
    rec.onerror = (ev) => {
      if (s.rec !== rec || s.notified) return;
      const code = (ev && ev.error) || 'unknown';
      record('rec:onerror', { code, session: s.id, lang });
      if (code === 'aborted' && s.aborted) return; // our own abort
      if (code === 'language-not-supported') {
        failedLangs.add(lang);
        if (recLang === lang) {
          recLang = null;
          storage.set(LANG_STORAGE_KEY, null);
        }
        s.retryLang = true; // 'end' follows; onRecEnd restarts with the next language
        return;
      }
      if (code === 'no-speech' && (s.finalText || s.interimText)) return; // we heard something: finalize on end
      if (code === 'not-allowed') setPermission('denied', 'error');
      if (code === 'service-not-allowed') serviceBlocked = true;
      if (code === 'audio-capture') micMissing = true;
      deliverError(s, code, code === 'network' && !isOnline() ? { offline: true } : undefined);
    };
    rec.onend = () => {
      if (s.rec !== rec) return;
      onRecEnd(s);
    };
    trackRecEnd(s);
    // Final invariant check right before opening the mic.
    if (isSpeaking()) {
      record('rec:start-blocked', { session: s.id });
      deliverError(s, 'busy');
      finishSession(s, 'error');
      return { started: false, reason: 'busy' };
    }
    try {
      record('rec:start', { lang, session: s.id });
      rec.start();
    } catch (e) {
      record('rec:start-failed', { session: s.id, name: e && e.name });
      if (s.resolveEnd) s.resolveEnd();
      deliverError(s, 'start-failed');
      finishSession(s, 'error');
      return { started: false, reason: 'start-failed' };
    }
    s.timers.push(
      clock.setTimeout(() => {
        if (session === s && !s.started && !s.recEnded && !s.notified) {
          record('rec:start-watchdog', { session: s.id });
          abortSessionWithError(s, 'start-failed');
        }
      }, startWatchdogMs),
    );
    s.timers.push(
      clock.setTimeout(() => {
        if (session === s && !s.recEnded) stopSession(s, 'max-duration');
      }, maxListenMs),
    );
    emitStatus();
    return { started: true, lang };
  }

  function abortSessionWithError(s, code) {
    deliverError(s, code);
    s.aborted = true;
    try {
      s.rec && s.rec.abort();
    } catch {
      /* ignore */
    }
    finishSession(s, 'error');
  }

  function stopSession(s, why) {
    if (!s || s.notified) return;
    record('rec:stop', { why, session: s.id });
    if (!s.rec) {
      abortSession(s, why);
      return;
    }
    try {
      s.rec.stop();
    } catch {
      /* ignore */
    }
    // Guard: some engines never fire 'end' after stop().
    s.timers.push(
      clock.setTimeout(() => {
        if (!s.recEnded) {
          record('rec:end-watchdog', { session: s.id });
          onRecEnd(s);
        }
      }, endWatchdogMs),
    );
  }

  /**
   * Start listening. Handlers: onStart({lang}), onInterim(text), onFinal(text), onEnd(reason), onError(err).
   * onEnd reasons: 'final' | 'no-speech' | 'error' | 'aborted'. Exactly one onEnd per call.
   * Resolves {started, lang?, reason?} once recognition.start() was called (or refused).
   */
  async function listen(handlers = {}) {
    const s = {
      id: ++sessionSeq,
      h: normalizeHandlers(handlers),
      rec: null,
      lang: null,
      langsTried: [],
      finalText: '',
      interimText: '',
      started: false,
      audio: false,
      errored: false,
      aborted: false,
      notified: false,
      recEnded: false,
      retryLang: false,
      timers: [],
    };
    if (session) abortSession(session, 'superseded');
    session = s;
    record('listen', { session: s.id });
    if (!support.recognition) {
      deliverError(s, 'unsupported');
      finishSession(s, 'error');
      return { started: false, reason: 'unsupported' };
    }
    if (!isOnline()) {
      // never assume the recognition service works offline (Chrome streams audio to a server)
      deliverError(s, 'network', { offline: true });
      finishSession(s, 'error');
      return { started: false, reason: 'offline' };
    }
    if (permission === 'denied') {
      deliverError(s, 'not-allowed', { proactive: true });
      finishSession(s, 'error');
      return { started: false, reason: 'denied' };
    }
    // HALF-DUPLEX: barge-in — stop our own speech, then wait until the synthesizer is silent.
    if (isSpeaking()) stopSpeaking();
    const busyDeadline = clock.now() + busyWaitMs;
    while (synthBusy() && clock.now() < busyDeadline) {
      await sleep(25);
      if (session !== s || s.notified) return { started: false, reason: 'superseded' };
    }
    if (synthBusy()) {
      deliverError(s, 'busy');
      finishSession(s, 'error');
      return { started: false, reason: 'busy' };
    }
    const wait = lastSpeechEndAt + guardMs - clock.now();
    if (wait > 0) {
      record('listen:guard', { ms: Math.round(wait), session: s.id });
      await sleep(wait);
    }
    if (session !== s || s.notified) return { started: false, reason: 'superseded' };
    // Chrome: wait for the previous instance's 'end' before starting a new one.
    if (prevRecEnded) {
      const prev = prevRecEnded;
      await Promise.race([prev, sleep(600)]);
      if (session !== s || s.notified) return { started: false, reason: 'superseded' };
    }
    const lang = pickLang();
    if (!lang) {
      deliverError(s, 'language-not-supported');
      finishSession(s, 'error');
      return { started: false, reason: 'language-not-supported' };
    }
    return startRecognition(s, lang);
  }

  /** Stop gracefully: the engine finalizes what it heard (→ onFinal or no-speech). */
  function stopListening() {
    if (session) stopSession(session, 'user');
  }

  /** Abort without a result (→ onEnd('aborted')). */
  function abortListening(reason = 'abort') {
    if (session) abortSession(session, reason);
  }

  // ---------- synthesis ----------
  function stopSpeaking() {
    const job = speakJob;
    const busy = synthBusy();
    if (!job && !busy) return;
    record('speak:stop', { busy });
    if (support.synthesis) {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    }
    if (job) job.finish('cancelled');
    lastSpeechEndAt = clock.now();
  }

  /**
   * Speak Arabic text. Always resolves (never rejects):
   * {ok, reason:'end'|'cancelled'|'error'|'timeout'|'unsupported'|'empty'|'no-arabic-voice', startedAt, endedAt, voice}
   */
  function speak(text, opts = {}) {
    const str = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!str) return Promise.resolve({ ok: false, reason: 'empty' });
    if (!support.synthesis) return Promise.resolve({ ok: false, reason: 'unsupported' });
    // HALF-DUPLEX: speaking first aborts any active recognition.
    abortListening('speak');
    const hadBusy = synthBusy() || !!speakJob;
    if (speakJob) speakJob.finish('cancelled');
    try {
      synth.cancel(); // cancel before speak (clears stuck queues)
    } catch {
      /* ignore */
    }
    let resolveFn;
    const promise = new Promise((r) => (resolveFn = r));
    const job = { done: false, utter: null, timers: [], interval: null, startedAt: null, voice: null };
    job.finish = (reason, extra = {}) => {
      if (job.done) return;
      job.done = true;
      for (const t of job.timers) clock.clearTimeout(t);
      if (job.interval !== null) clock.clearInterval(job.interval);
      if (job.utter) liveUtterances.delete(job.utter);
      if (speakJob === job) speakJob = null;
      const endedAt = clock.now();
      if (job.utter) lastSpeechEndAt = Math.max(lastSpeechEndAt, endedAt);
      record('speak:done', { reason });
      resolveFn({ ok: reason === 'end', reason, startedAt: job.startedAt, endedAt, voice: job.voice, ...extra });
      emitStatus();
    };
    speakJob = job;
    emitStatus();
    (async () => {
      if (!voicesLoaded) await waitForVoices(voicesWaitMs);
      if (job.done) return;
      if (hadBusy) await sleep(60); // Chrome drops speak() issued right after cancel()
      if (job.done) return;
      const voice = arabicVoice;
      if (!voice && voicesLoaded && voices.length > 0 && !opts.allowNonArabic) {
        job.finish('no-arabic-voice');
        return;
      }
      const u = new Utter(str);
      job.utter = u;
      job.voice = voice ? { name: voice.name, lang: voice.lang } : null;
      liveUtterances.add(u);
      try {
        if (voice) u.voice = voice;
        u.lang = (voice && voice.lang) || opts.lang || 'ar-SA';
        u.rate = opts.rate ?? rate;
        u.pitch = 1;
        u.volume = 1;
      } catch {
        /* ignore */
      }
      u.onstart = () => {
        if (job.done) return;
        job.startedAt = clock.now();
        record('speak:onstart', { lang: u.lang });
        if (keepalive) {
          // Chrome cuts long utterances after ~15 s; a pause/resume keeps the engine alive.
          job.interval = clock.setInterval(() => {
            try {
              if (synth.speaking && !synth.paused) {
                synth.pause();
                synth.resume();
                record('speak:keepalive');
              }
            } catch {
              /* ignore */
            }
          }, keepaliveMs);
        }
      };
      u.onend = () => job.finish('end');
      u.onerror = (e) => {
        const code = e && e.error;
        job.finish(code === 'interrupted' || code === 'canceled' ? 'cancelled' : 'error', { error: code || 'unknown' });
      };
      const chars = str.length;
      const expected = Math.max(3000, (chars * 110) / (u.rate || 1));
      job.timers.push(
        clock.setTimeout(() => {
          if (job.done) return;
          record('speak:timeout');
          job.finish('timeout'); // resolve first: cancel() fires onerror('interrupted') synchronously in some engines
          try {
            synth.cancel();
          } catch {
            /* ignore */
          }
        }, expected + 5000),
      );
      job.timers.push(
        clock.setTimeout(() => {
          // speech never started (no engine / queue stuck in 'pending'): don't block the conversation.
          // If the engine reports speaking (audio playing without an onstart event) we leave it alone.
          let audible = false;
          try {
            audible = !!synth.speaking;
          } catch {
            audible = false;
          }
          if (!job.done && job.startedAt === null && !audible) {
            record('speak:no-start');
            job.finish('timeout', { neverStarted: true });
            try {
              synth.cancel();
            } catch {
              /* ignore */
            }
          }
        }, speakStartTimeoutMs),
      );
      try {
        if (synth.paused) synth.resume();
      } catch {
        /* ignore */
      }
      record('speak', { len: chars, voice: voice ? voice.name : null });
      synth.speak(u);
    })().catch((e) => job.finish('error', { error: String((e && e.message) || e) }));
    return promise;
  }

  // ---------- wiring ----------
  if (support.synthesis) {
    loadVoices();
    try {
      if (typeof synth.addEventListener === 'function') {
        synth.addEventListener('voiceschanged', onVoicesChanged);
        cleanups.push(() => synth.removeEventListener('voiceschanged', onVoicesChanged));
      } else {
        const prev = synth.onvoiceschanged;
        synth.onvoiceschanged = (ev) => {
          if (typeof prev === 'function') prev(ev);
          onVoicesChanged();
        };
      }
    } catch {
      /* ignore */
    }
  }
  if (win && typeof win.addEventListener === 'function') {
    const onNet = () => {
      record(isOnline() ? 'online' : 'offline');
      emitStatus();
    };
    win.addEventListener('online', onNet);
    win.addEventListener('offline', onNet);
    cleanups.push(() => {
      win.removeEventListener('online', onNet);
      win.removeEventListener('offline', onNet);
    });
  }
  const permissionReady = refreshPermission();

  return {
    support,
    /** Resolves after the first permission query (or immediately if unsupported). */
    ready: Promise.all([permissionReady, waitForVoices(voicesWaitMs)]).then(() => status()),
    status,
    subscribe(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    refreshPermission,
    permissionState: () => permission,
    hasArabicVoice: () => !!arabicVoice,
    canAutoListen,
    canSpeak,
    isOnline,
    isListening: () => !!session,
    isSpeaking,
    listen,
    stopListening,
    abortListening,
    speak,
    stopSpeaking,
    /** Debug timeline (no transcripts, only lengths). */
    debugLog: () => timeline.slice(),
    destroy() {
      abortListening('destroy');
      stopSpeaking();
      for (const c of cleanups) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
      statusListeners.clear();
    },
  };
}
