// Unit tests for public/js/conversation/voice.js using a fake window (fake Web Speech API).
// These are SIMULATED: no real microphone, recognizer or TTS engine is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoice, describeVoiceError, pickArabicVoice, readRecognitionResults, LANG_STORAGE_KEY } from '../../public/js/conversation/voice.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => performance.now();

type LogEntry = { t: number; type: string; [k: string]: unknown };
type FakeVoice = { name: string; lang: string; localService: boolean; default: boolean; voiceURI: string };

const AR_VOICES: FakeVoice[] = [
  { name: 'English', lang: 'en-US', localService: true, default: true, voiceURI: 'en' },
  { name: 'Arabic SA local', lang: 'ar-SA', localService: true, default: false, voiceURI: 'ar-sa' },
  { name: 'Arabic EG remote', lang: 'ar_EG', localService: false, default: false, voiceURI: 'ar-eg' },
];

interface FakeOpts {
  voices?: FakeVoice[];
  voicesLater?: number; // ms until voiceschanged fires (getVoices() empty before)
  speakMs?: number;
  speakNeverStarts?: boolean;
  permission?: 'granted' | 'denied' | 'prompt' | 'throws' | 'none';
  online?: boolean;
  noRecognition?: boolean;
  noSynthesis?: boolean;
  prefixedOnly?: boolean;
  unsupportedLangs?: string[];
  ua?: string;
}

function fakeWindow(opts: FakeOpts = {}) {
  const log: LogEntry[] = [];
  const add = (type: string, data: Record<string, unknown> = {}) => log.push({ t: now(), type, ...data });
  const storage = new Map<string, string>();
  // ---- synthesis ----
  const st = { speaking: false, pending: false, paused: false };
  let current: any = null;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let voices: FakeVoice[] = opts.voicesLater ? [] : (opts.voices ?? AR_VOICES);
  const vcListeners: Array<() => void> = [];
  class Utter {
    text: string;
    lang = '';
    voice: any = null;
    rate = 1;
    pitch = 1;
    volume = 1;
    onstart: any = null;
    onend: any = null;
    onerror: any = null;
    constructor(text: string) {
      this.text = text;
    }
  }
  const recs: any[] = [];
  const recActive = () => recs.some((r) => r.active);
  const synth = {
    get speaking() {
      return st.speaking;
    },
    get pending() {
      return st.pending;
    },
    get paused() {
      return st.paused;
    },
    getVoices: () => voices,
    addEventListener(type: string, fn: () => void) {
      if (type === 'voiceschanged') vcListeners.push(fn);
    },
    removeEventListener() {},
    speak(u: any) {
      add('synth.speak', { recActive: recActive(), lang: u.lang, rate: u.rate, voice: u.voice && u.voice.name });
      current = u;
      st.pending = true;
      if (opts.speakNeverStarts) return;
      setTimeout(() => {
        if (current !== u) return;
        st.pending = false;
        st.speaking = true;
        add('synth.start');
        u.onstart && u.onstart({});
        endTimer = setTimeout(() => {
          if (current !== u) return;
          st.speaking = false;
          current = null;
          add('synth.end');
          u.onend && u.onend({});
        }, opts.speakMs ?? 60);
      }, 5);
    },
    cancel() {
      add('synth.cancel', { hadCurrent: !!current });
      if (endTimer) clearTimeout(endTimer);
      st.pending = false;
      st.speaking = false;
      if (current) {
        const u = current;
        current = null;
        add('synth.end', { cancelled: true });
        u.onerror && u.onerror({ error: 'interrupted' });
      }
    },
    pause() {
      add('synth.pause');
      st.paused = true;
    },
    resume() {
      add('synth.resume');
      st.paused = false;
    },
  };
  // ---- recognition ----
  class Rec {
    lang = '';
    continuous = true;
    interimResults = false;
    maxAlternatives = 5;
    onstart: any = null;
    onaudiostart: any = null;
    onresult: any = null;
    onerror: any = null;
    onend: any = null;
    started = false;
    active = false;
    results: any[] = [];
    constructor() {
      recs.push(this);
    }
    start() {
      add('rec.start', { lang: this.lang, synthBusy: st.speaking || st.pending });
      if (this.started) {
        const e = new Error('already started');
        e.name = 'InvalidStateError';
        throw e;
      }
      this.started = true;
      this.active = true;
      if ((opts.unsupportedLangs ?? []).includes(this.lang)) {
        setTimeout(() => {
          this.fireError('language-not-supported');
          this.end();
        }, 5);
        return;
      }
      setTimeout(() => {
        if (!this.active) return;
        this.onstart && this.onstart({});
        this.onaudiostart && this.onaudiostart({});
      }, 2);
    }
    stop() {
      add('rec.stop');
      setTimeout(() => {
        // finalize what was heard
        for (const r of this.results) r.isFinal = true;
        if (this.results.length) this.emit();
        this.end();
      }, 5);
    }
    abort() {
      add('rec.abort');
      setTimeout(() => {
        this.fireError('aborted');
        this.end();
      }, 2);
    }
    // ---- test drivers ----
    say(text: string, isFinal = false) {
      this.results = [Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal })];
      this.emit();
    }
    emit() {
      this.onresult && this.onresult({ resultIndex: 0, results: this.results });
    }
    fireError(code: string) {
      this.onerror && this.onerror({ error: code });
    }
    end() {
      if (!this.active) return;
      this.active = false;
      add('rec.end');
      this.onend && this.onend({});
    }
  }
  const listeners: Record<string, Array<() => void>> = {};
  let permState: any = null;
  const nav: any = {
    onLine: opts.online ?? true,
    userAgent: opts.ua ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0 Safari/537.36',
  };
  if (opts.permission !== 'none') {
    nav.permissions = {
      async query(desc: { name: string }) {
        if (opts.permission === 'throws' || desc.name !== 'microphone') throw new TypeError('not supported');
        permState = permState || {
          state: opts.permission ?? 'granted',
          _l: [] as Array<() => void>,
          addEventListener(_t: string, fn: () => void) {
            this._l.push(fn);
          },
        };
        return permState;
      },
    };
  }
  const win: any = {
    navigator: nav,
    performance,
    localStorage: {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => storage.set(k, String(v)),
      removeItem: (k: string) => storage.delete(k),
    },
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
  };
  if (!opts.noSynthesis) {
    win.speechSynthesis = synth;
    win.SpeechSynthesisUtterance = Utter;
  }
  if (!opts.noRecognition) {
    win.webkitSpeechRecognition = Rec;
    if (!opts.prefixedOnly) win.SpeechRecognition = Rec;
  }
  if (opts.voicesLater) {
    setTimeout(() => {
      voices = opts.voices ?? AR_VOICES;
      for (const fn of vcListeners) fn();
    }, opts.voicesLater);
  }
  return {
    win,
    log,
    recs,
    storage,
    lastRec: () => recs[recs.length - 1],
    setOnline(v: boolean) {
      nav.onLine = v;
      for (const fn of listeners[v ? 'online' : 'offline'] || []) fn();
    },
    setPermission(s: string) {
      if (permState) {
        permState.state = s;
        for (const fn of permState._l) fn();
      }
    },
  };
}

function collector() {
  const ev: Array<{ type: string; value?: any; t: number }> = [];
  return {
    ev,
    handlers: {
      onStart: (v: any) => ev.push({ type: 'start', value: v, t: now() }),
      onInterim: (v: string) => ev.push({ type: 'interim', value: v, t: now() }),
      onFinal: (v: string) => ev.push({ type: 'final', value: v, t: now() }),
      onEnd: (v: string) => ev.push({ type: 'end', value: v, t: now() }),
      onError: (v: any) => ev.push({ type: 'error', value: v, t: now() }),
    },
    types: () => ev.map((e) => e.type),
    get: (type: string) => ev.filter((e) => e.type === type),
  };
}

async function until(cond: () => boolean, ms = 2000) {
  const end = now() + ms;
  while (!cond()) {
    if (now() > end) throw new Error('timeout waiting for condition');
    await sleep(3);
  }
}

// ---------------- tests ----------------

test('pure helpers: error catalogue, voice picking, result joining', () => {
  const na = describeVoiceError('not-allowed');
  assert.equal(na.recoverable, false);
  assert.match(na.messageAr, /القفل/);
  assert.equal(na.offerText, true);
  assert.equal(describeVoiceError('no-speech').recoverable, true);
  assert.equal(describeVoiceError('network').recoverable, true);
  assert.match(describeVoiceError('network').messageAr, /الإنترنت/);
  assert.equal(describeVoiceError('audio-capture').recoverable, false);
  assert.equal(describeVoiceError('service-not-allowed').recoverable, false);
  assert.equal(describeVoiceError('language-not-supported').recoverable, false);
  assert.equal(describeVoiceError('weird-new-code').code, 'weird-new-code');
  assert.equal(pickArabicVoice(AR_VOICES)?.name, 'Arabic SA local');
  assert.equal(pickArabicVoice([AR_VOICES[0]]), null);
  assert.equal(pickArabicVoice([AR_VOICES[0], AR_VOICES[2]])?.name, 'Arabic EG remote', "accepts 'ar_EG' (Android style)");
  const r = readRecognitionResults({
    results: [Object.assign([{ transcript: 'بدي شقة' }], { isFinal: true }), Object.assign([{ transcript: ' بإعزاز' }], { isFinal: false })],
  });
  assert.deepEqual(r, { finalText: 'بدي شقة', interimText: 'بإعزاز' });
});

test('feature detection: no window / prefixed only / no synthesis', async () => {
  const none = createVoice({ window: null });
  assert.deepEqual({ ...none.support }, { recognition: false, synthesis: false });
  assert.equal(none.canAutoListen(), false);
  const c = collector();
  const r = await none.listen(c.handlers);
  assert.equal(r.started, false);
  assert.deepEqual(c.types(), ['error', 'end']);
  assert.equal(c.get('error')[0].value.code, 'unsupported');
  assert.equal((await none.speak('مرحبا')).reason, 'unsupported');

  const f = fakeWindow({ prefixedOnly: true, noSynthesis: true });
  const v = createVoice({ window: f.win });
  assert.equal(v.support.recognition, true);
  assert.equal(v.support.synthesis, false);
  assert.equal(v.canSpeak(), false);
});

test('listen: recognition settings, interim → final on end, exactly one onEnd', async () => {
  const f = fakeWindow();
  const v = createVoice({ window: f.win, guardMs: 10 });
  await v.ready;
  const c = collector();
  const r = await v.listen(c.handlers);
  assert.equal(r.started, true);
  const rec = f.lastRec();
  assert.equal(rec.lang, 'ar-SY');
  assert.equal(rec.continuous, false);
  assert.equal(rec.interimResults, true);
  assert.equal(rec.maxAlternatives, 1);
  await until(() => c.get('start').length === 1);
  rec.say('بدي');
  rec.say('بدي شقة');
  rec.say('بدي شقة بإعزاز', true);
  assert.deepEqual(c.get('interim').map((e) => e.value), ['بدي', 'بدي شقة', 'بدي شقة بإعزاز']);
  assert.equal(c.get('final').length, 0, 'final is delivered on end');
  rec.end();
  assert.deepEqual(c.types().slice(-2), ['final', 'end']);
  assert.equal(c.get('final')[0].value, 'بدي شقة بإعزاز');
  assert.equal(c.get('end')[0].value, 'final');
  assert.equal(v.isListening(), false);
});

test("Chrome guards: 'end' with only interim text → final; 'end' with nothing → no-speech", async () => {
  const f = fakeWindow();
  const v = createVoice({ window: f.win, guardMs: 0 });
  await v.ready;
  const c1 = collector();
  await v.listen(c1.handlers);
  f.lastRec().say('بدي سيارة', false);
  f.lastRec().end();
  assert.equal(c1.get('final')[0]?.value, 'بدي سيارة');

  const c2 = collector();
  await v.listen(c2.handlers);
  f.lastRec().end();
  assert.deepEqual(c2.types(), ['error', 'end']);
  assert.equal(c2.get('error')[0].value.code, 'no-speech');
  assert.equal(c2.get('error')[0].value.recoverable, true);
  assert.equal(c2.get('end')[0].value, 'no-speech');
});

test('stopListening() finalizes what was heard', async () => {
  const f = fakeWindow();
  const v = createVoice({ window: f.win, guardMs: 0 });
  await v.ready;
  const c = collector();
  await v.listen(c.handlers);
  f.lastRec().say('بدي شقة', false);
  v.stopListening();
  await until(() => c.get('end').length === 1);
  assert.equal(c.get('final')[0].value, 'بدي شقة');
  assert.equal(c.get('end')[0].value, 'final');
});

test('not-allowed: permission becomes denied, canAutoListen false, next listen fails proactively', async () => {
  const f = fakeWindow({ permission: 'prompt' });
  const v = createVoice({ window: f.win, guardMs: 0 });
  await v.ready;
  assert.equal(v.permissionState(), 'prompt');
  assert.equal(v.canAutoListen(), false, "'prompt' is not known-granted");
  const c = collector();
  await v.listen(c.handlers);
  f.lastRec().fireError('not-allowed');
  f.lastRec().end();
  assert.deepEqual(c.types(), ['error', 'end']);
  const err = c.get('error')[0].value;
  assert.equal(err.code, 'not-allowed');
  assert.equal(err.recoverable, false);
  assert.equal(err.offerText, true);
  assert.equal(v.permissionState(), 'denied');
  const recsBefore = f.recs.length;
  const c2 = collector();
  const r2 = await v.listen(c2.handlers);
  assert.equal(r2.started, false);
  assert.equal(f.recs.length, recsBefore, 'no recognition started while denied');
  assert.equal(c2.get('error')[0].value.code, 'not-allowed');
});

test('permission states: granted → canAutoListen; unsupported query → unknown; change events propagate', async () => {
  const g = fakeWindow({ permission: 'granted' });
  const vg = createVoice({ window: g.win });
  await vg.ready;
  assert.equal(vg.canAutoListen(), true);
  const statuses: boolean[] = [];
  vg.subscribe((s) => statuses.push(s.canAutoListen));
  g.setPermission('denied');
  assert.equal(vg.canAutoListen(), false);
  assert.ok(statuses.includes(false));
  // offline → cannot auto listen
  g.setPermission('granted');
  g.setOnline(false);
  assert.equal(vg.canAutoListen(), false);

  const t = fakeWindow({ permission: 'throws' });
  const vt = createVoice({ window: t.win });
  await vt.ready;
  assert.equal(vt.permissionState(), 'unknown');
  assert.equal(vt.canAutoListen(), false);

  const n = fakeWindow({ permission: 'none' });
  const vn = createVoice({ window: n.win });
  await vn.ready;
  assert.equal(vn.permissionState(), 'unknown');
  assert.equal(vn.canAutoListen(), false);
});

test('offline: network error is reported proactively without starting recognition', async () => {
  const f = fakeWindow({ online: false });
  const v = createVoice({ window: f.win });
  const c = collector();
  const r = await v.listen(c.handlers);
  assert.equal(r.started, false);
  assert.equal(f.recs.length, 0);
  const err = c.get('error')[0].value;
  assert.equal(err.code, 'network');
  assert.equal(err.offline, true);
  assert.equal(err.recoverable, true);
  assert.match(err.messageAr, /الإنترنت/);
});

test('error mapping during a session: network, audio-capture, no-speech, aborted (external)', async () => {
  for (const code of ['network', 'audio-capture', 'no-speech', 'service-not-allowed']) {
    const f = fakeWindow();
    const v = createVoice({ window: f.win, guardMs: 0 });
    await v.ready;
    const c = collector();
    await v.listen(c.handlers);
    f.lastRec().fireError(code);
    f.lastRec().end();
    assert.deepEqual(c.types().filter((x) => x !== 'start'), ['error', 'end'], code);
    assert.equal(c.get('error')[0].value.code, code);
    assert.equal(c.get('error')[0].value.recoverable, describeVoiceError(code).recoverable);
    if (code === 'audio-capture' || code === 'service-not-allowed') assert.equal(v.canAutoListen(), false, `${code} disables auto-listen`);
  }
});

test('language fallback: language-not-supported → next language, remembered for next time', async () => {
  const f = fakeWindow({ unsupportedLangs: ['ar-SY'] });
  const v = createVoice({ window: f.win, guardMs: 0 });
  await v.ready;
  const c = collector();
  await v.listen(c.handlers);
  await until(() => f.recs.length === 2 && c.get('start').length === 1);
  assert.deepEqual(f.recs.map((r) => r.lang), ['ar-SY', 'ar-LB']);
  assert.equal(c.get('error').length, 0, 'fallback is transparent');
  f.lastRec().say('بدي شقة', true);
  f.lastRec().end();
  assert.equal(c.get('final')[0].value, 'بدي شقة');
  assert.equal(f.storage.get(LANG_STORAGE_KEY), 'ar-LB');
  // a new voice instance on the same storage starts directly with the working language
  const v2 = createVoice({ window: f.win, guardMs: 0 });
  await v2.ready;
  await v2.listen(collector().handlers);
  assert.equal(f.lastRec().lang, 'ar-LB');

  const all = fakeWindow({ unsupportedLangs: ['ar-SY', 'ar-LB', 'ar-JO', 'ar-SA', 'ar'] });
  const va = createVoice({ window: all.win, guardMs: 0 });
  await va.ready;
  const ca = collector();
  await va.listen(ca.handlers);
  await until(() => ca.get('end').length === 1);
  assert.equal(ca.get('error')[0].value.code, 'language-not-supported');
  assert.equal(all.recs.length, 5);
});

test('synthesis: waits for async voiceschanged, picks an Arabic voice, rate 0.95, cancel before speak', async () => {
  const f = fakeWindow({ voicesLater: 40 });
  const v = createVoice({ window: f.win });
  assert.equal(v.hasArabicVoice(), false, 'voices not loaded yet');
  const r = await v.speak('بدك الشقة للبيع، ولا للإيجار؟');
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'end');
  assert.equal(v.hasArabicVoice(), true);
  const s = f.log.find((e) => e.type === 'synth.speak')!;
  assert.equal(s.voice, 'Arabic SA local');
  assert.equal(s.lang, 'ar-SA');
  assert.equal(s.rate, 0.95);
  const iCancel = f.log.findIndex((e) => e.type === 'synth.cancel');
  const iSpeak = f.log.findIndex((e) => e.type === 'synth.speak');
  assert.ok(iCancel >= 0 && iCancel < iSpeak, 'cancel() before speak()');
});

test('no Arabic voice installed → do not read Arabic with an English voice', async () => {
  const f = fakeWindow({ voices: [AR_VOICES[0]] });
  const v = createVoice({ window: f.win });
  await v.ready;
  assert.equal(v.hasArabicVoice(), false);
  assert.equal(v.canSpeak(), false);
  const r = await v.speak('مرحبا');
  assert.equal(r.reason, 'no-arabic-voice');
  assert.equal(f.log.filter((e) => e.type === 'synth.speak').length, 0);
});

test('Chrome long-utterance keepalive: pause/resume while speaking', async () => {
  const f = fakeWindow({ speakMs: 120 });
  const v = createVoice({ window: f.win, keepalive: true, keepaliveMs: 25 });
  await v.ready;
  await v.speak('سؤال طويل جدًا '.repeat(5));
  assert.ok(f.log.filter((e) => e.type === 'synth.pause').length >= 2);
  assert.ok(f.log.filter((e) => e.type === 'synth.resume').length >= 2);
  // Android: no keepalive (pause cancels speech there)
  const a = fakeWindow({ speakMs: 120, ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/141.0 Mobile' });
  const va = createVoice({ window: a.win, keepaliveMs: 25 });
  await va.ready;
  await va.speak('سؤال');
  assert.equal(a.log.filter((e) => e.type === 'synth.pause').length, 0);
});

test('speak() resolves on timeout when the engine never starts', async () => {
  const f = fakeWindow({ speakNeverStarts: true });
  const v = createVoice({ window: f.win, speakStartTimeoutMs: 50 });
  await v.ready;
  // a stuck engine keeps pending=true and never fires onstart: resolve after the start timeout
  const t0 = now();
  const r: any = await Promise.race([v.speak('مرحبا'), sleep(3000).then(() => ({ reason: 'hung' }))]);
  assert.equal(r.reason, 'timeout');
  assert.equal(r.neverStarted, true);
  assert.ok(now() - t0 < 1000, `took ${Math.round(now() - t0)}ms`);
  assert.equal(v.isSpeaking(), false, 'stuck queue was cancelled');
});

test('HALF-DUPLEX: listen() after speech waits for the end + guard; start() never while speaking', async () => {
  const GUARD = 80;
  const f = fakeWindow({ speakMs: 100 });
  const v = createVoice({ window: f.win, guardMs: GUARD });
  await v.ready;
  await v.speak('بدك الشقة للبيع ولا للإيجار؟');
  const c = collector();
  await v.listen(c.handlers);
  const synthEnd = f.log.filter((e) => e.type === 'synth.end').pop()!;
  const recStart = f.log.filter((e) => e.type === 'rec.start').pop()!;
  assert.equal(recStart.synthBusy, false);
  assert.ok(recStart.t - synthEnd.t >= GUARD - 2, `gap ${(recStart.t - synthEnd.t).toFixed(1)}ms < guard ${GUARD}ms`);
});

test('HALF-DUPLEX: barge-in — listen() while speaking cancels speech first, then waits the guard', async () => {
  const GUARD = 60;
  const f = fakeWindow({ speakMs: 2000 });
  const v = createVoice({ window: f.win, guardMs: GUARD });
  await v.ready;
  const spoken = v.speak('سؤال طويل');
  await until(() => f.log.some((e) => e.type === 'synth.start'));
  assert.equal(v.isSpeaking(), true);
  await v.listen(collector().handlers);
  const r = await spoken;
  assert.equal(r.reason, 'cancelled');
  const cancel = f.log.filter((e) => e.type === 'synth.cancel').pop()!;
  const start = f.log.filter((e) => e.type === 'rec.start').pop()!;
  assert.equal(start.synthBusy, false);
  assert.ok(start.t - cancel.t >= GUARD - 2, `gap ${(start.t - cancel.t).toFixed(1)}`);
  for (const s of f.log.filter((e) => e.type === 'rec.start')) assert.equal(s.synthBusy, false);
});

test('HALF-DUPLEX: speak() while listening aborts recognition before speaking', async () => {
  const f = fakeWindow({ speakMs: 30 });
  const v = createVoice({ window: f.win, guardMs: 0 });
  await v.ready;
  const c = collector();
  await v.listen(c.handlers);
  await until(() => c.get('start').length === 1);
  const p = v.speak('سؤال');
  // the listening session ended (aborted) synchronously from the caller's point of view
  assert.deepEqual(c.types().slice(-1), ['end']);
  assert.equal(c.get('end')[0].value, 'aborted');
  await p;
  const iAbort = f.log.findIndex((e) => e.type === 'rec.abort');
  const iSpeak = f.log.findIndex((e) => e.type === 'synth.speak');
  assert.ok(iAbort >= 0 && iAbort < iSpeak);
  // a cancel during the guard delay prevents the mic from opening at all
  const f2 = fakeWindow({ speakMs: 30 });
  const v2 = createVoice({ window: f2.win, guardMs: 100 });
  await v2.ready;
  await v2.speak('سؤال');
  const c2 = collector();
  const pending = v2.listen(c2.handlers);
  v2.abortListening('cancel');
  const res = await pending;
  assert.equal(res.started, false);
  assert.equal(f2.recs.length, 0);
  assert.deepEqual(c2.types(), ['end']);
});

test('a new listen() supersedes the previous session (old handlers get aborted, no double start)', async () => {
  const f = fakeWindow();
  const v = createVoice({ window: f.win, guardMs: 0 });
  await v.ready;
  const a = collector();
  const b = collector();
  await v.listen(a.handlers);
  await v.listen(b.handlers);
  assert.equal(a.get('end')[0].value, 'aborted');
  assert.equal(f.recs.length, 2);
  f.lastRec().say('نعم', true);
  f.lastRec().end();
  assert.equal(b.get('final')[0].value, 'نعم');
  assert.equal(a.get('final').length, 0);
});
