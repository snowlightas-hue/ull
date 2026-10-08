// Mock Web Speech API (SpeechRecognition + speechSynthesis + permissions) installed in the page with
// page.addInitScript(installMockVoice, cfg). SIMULATION ONLY — proves wiring/timing, not a human voice.
// Extracted unchanged from voice-harness.spec.ts so other specs can reuse it.
// ---------------------------------------------------------------- in-page mock (runs in the browser)
export type Step = { after: number; do: 'start' | 'audiostart' | 'interim' | 'final' | 'error' | 'end'; text?: string; error?: string };
export interface MockCfg {
  permission: 'granted' | 'prompt' | 'denied';
  sessions: Step[][];
  unsupportedLangs?: string[];
  speakMsPerChar?: number;
  speakMinMs?: number;
  voicesDelayMs?: number;
}

export function installMockVoice(cfg: MockCfg) {
  const w = window as any;
  const log: any[] = [];
  const now = () => performance.now();
  const add = (type: string, data: Record<string, unknown> = {}) => log.push({ t: Math.round(now() * 10) / 10, type, ...data });
  const M: any = (w.__mockVoice = { log, cfg, sessions: cfg.sessions.map((s) => s.slice()), recs: [] as any[], permission: cfg.permission, violations: [] as any[] });
  const fire = (target: any, type: string, extra?: Record<string, unknown>) => {
    const ev: any = new Event(type);
    if (extra) for (const k of Object.keys(extra)) Object.defineProperty(ev, k, { value: extra[k] });
    try {
      if (typeof target['on' + type] === 'function') target['on' + type](ev);
    } catch (e) {
      console.error(e);
    }
    if (typeof target.dispatchEvent === 'function') target.dispatchEvent(ev);
  };

  // ---------- speechSynthesis ----------
  const st = { speaking: false, pending: false, paused: false };
  let current: any = null;
  let timers: any[] = [];
  let voices: any[] = [];
  const VOICES = [
    { name: 'Mock English', lang: 'en-US', localService: true, default: true, voiceURI: 'mock-en' },
    { name: 'Mock Arabic (ar-SA)', lang: 'ar-SA', localService: true, default: false, voiceURI: 'mock-ar-sa' },
  ];
  const vcl = new Set<any>();
  class MockUtterance extends EventTarget {
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
      super();
      this.text = text;
    }
  }
  const capturing = () => M.recs.some((r: any) => r.capturing);
  const synth: any = {
    get speaking() {
      return st.speaking;
    },
    get pending() {
      return st.pending;
    },
    get paused() {
      return st.paused;
    },
    onvoiceschanged: null,
    getVoices: () => voices.slice(),
    addEventListener(type: string, fn: any) {
      if (type === 'voiceschanged') vcl.add(fn);
    },
    removeEventListener(type: string, fn: any) {
      if (type === 'voiceschanged') vcl.delete(fn);
    },
    speak(u: any) {
      add('synth.speak', { text: u.text, lang: u.lang, rate: u.rate, voice: u.voice ? u.voice.name : null, micCapturing: capturing() });
      if (capturing()) M.violations.push({ t: now(), what: 'speak() while the microphone is capturing' });
      current = u;
      st.pending = true;
      const dur = Math.max(cfg.speakMinMs ?? 500, (u.text.length * (cfg.speakMsPerChar ?? 30)) / (u.rate || 1));
      timers.push(
        setTimeout(() => {
          if (current !== u) return;
          st.pending = false;
          st.speaking = true;
          add('synth.start');
          fire(u, 'start');
          timers.push(
            setTimeout(() => {
              if (current !== u) return;
              st.speaking = false;
              current = null;
              add('synth.end');
              fire(u, 'end');
            }, dur),
          );
        }, 20),
      );
    },
    cancel() {
      add('synth.cancel', { active: !!current });
      for (const t of timers) clearTimeout(t);
      timers = [];
      const u = current;
      current = null;
      st.speaking = false;
      st.pending = false;
      if (u) {
        add('synth.end', { cancelled: true });
        fire(u, 'error', { error: 'interrupted' });
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
  setTimeout(() => {
    voices = VOICES;
    add('synth.voiceschanged');
    for (const fn of vcl) fn(new Event('voiceschanged'));
    if (typeof synth.onvoiceschanged === 'function') synth.onvoiceschanged(new Event('voiceschanged'));
  }, cfg.voicesDelayMs ?? 150);
  Object.defineProperty(w, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(w, 'SpeechSynthesisUtterance', { value: MockUtterance, configurable: true, writable: true });

  // ---------- SpeechRecognition ----------
  class MockRecognition extends EventTarget {
    lang = '';
    continuous = true;
    interimResults = false;
    maxAlternatives = 5;
    onstart: any = null;
    onaudiostart: any = null;
    onresult: any = null;
    onerror: any = null;
    onend: any = null;
    id: number;
    started = false;
    active = false;
    capturing = false;
    timers: any[] = [];
    results: Array<{ text: string; final: boolean }> = [];
    constructor() {
      super();
      M.recs.push(this);
      this.id = M.recs.length;
    }
    start() {
      const synthBusy = st.speaking || st.pending;
      add('rec.start', { id: this.id, lang: this.lang, synthBusy, continuous: this.continuous, interimResults: this.interimResults, maxAlternatives: this.maxAlternatives });
      if (synthBusy) M.violations.push({ t: now(), what: 'recognition.start() while speechSynthesis is busy' });
      if (this.started) throw new DOMException('recognition has already started', 'InvalidStateError');
      this.started = true;
      this.active = true;
      const steps: Step[] = (cfg.unsupportedLangs || []).includes(this.lang)
        ? [
            { after: 10, do: 'error', error: 'language-not-supported' },
            { after: 15, do: 'end' },
          ]
        : M.sessions.shift() || [
            { after: 30, do: 'start' },
            { after: 50, do: 'audiostart' },
          ];
      for (const s of steps) this.timers.push(setTimeout(() => this.step(s), s.after));
    }
    step(s: Step) {
      if (!this.active) return;
      switch (s.do) {
        case 'start':
          this.capturing = true;
          add('rec.onstart', { id: this.id });
          fire(this, 'start');
          break;
        case 'audiostart':
          this.capturing = true;
          fire(this, 'audiostart');
          break;
        case 'interim':
          this.results = [{ text: s.text || '', final: false }];
          this.emitResults();
          break;
        case 'final':
          this.results = [{ text: s.text || '', final: true }];
          this.emitResults();
          break;
        case 'error':
          add('rec.error', { id: this.id, error: s.error });
          fire(this, 'error', { error: s.error, message: '' });
          break;
        case 'end':
          this.finish();
          break;
      }
    }
    emitResults() {
      const list: any = this.results.map((r) => {
        const res: any = [{ transcript: r.text, confidence: 0.9 }];
        res.isFinal = r.final;
        res.item = (i: number) => res[i];
        return res;
      });
      list.item = (i: number) => list[i];
      add('rec.result', { id: this.id, final: this.results.some((r) => r.final), len: this.results.map((r) => r.text).join(' ').length });
      fire(this, 'result', { resultIndex: 0, results: list });
    }
    stop() {
      add('rec.stop', { id: this.id });
      this.capturing = false;
      for (const t of this.timers) clearTimeout(t);
      setTimeout(() => {
        if (!this.active) return;
        if (this.results.length && !this.results[this.results.length - 1].final) {
          this.results = this.results.map((r) => ({ ...r, final: true }));
          this.emitResults();
        }
        this.finish();
      }, 40);
    }
    abort() {
      add('rec.abort', { id: this.id });
      this.capturing = false;
      for (const t of this.timers) clearTimeout(t);
      setTimeout(() => {
        if (!this.active) return;
        fire(this, 'error', { error: 'aborted', message: '' });
        this.finish();
      }, 20);
    }
    finish() {
      if (!this.active) return;
      this.active = false;
      this.capturing = false;
      for (const t of this.timers) clearTimeout(t);
      add('rec.end', { id: this.id });
      fire(this, 'end');
    }
  }
  Object.defineProperty(w, 'SpeechRecognition', { value: MockRecognition, configurable: true, writable: true });
  Object.defineProperty(w, 'webkitSpeechRecognition', { value: MockRecognition, configurable: true, writable: true });

  // ---------- permissions ----------
  const status: any = new EventTarget();
  Object.defineProperty(status, 'state', { get: () => M.permission });
  status.name = 'microphone';
  status.onchange = null;
  M.setPermission = (s: string) => {
    M.permission = s;
    fire(status, 'change');
  };
  const perms: any = navigator.permissions;
  if (perms) {
    const orig = perms.query.bind(perms);
    perms.query = async (d: any) => (d && d.name === 'microphone' ? status : orig(d));
  }
}
