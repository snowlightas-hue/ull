// SIMULATED voice end-to-end tests for public/voice-harness.html.
//
// A MOCK SpeechRecognition + speechSynthesis + navigator.permissions is injected into the page
// (page.addInitScript). These tests prove the client wiring, timing and half-duplex ordering of
// public/js/conversation/*. They do NOT exercise a real microphone, a real recognizer, a real TTS
// engine or a human voice.
//
// Run: node test/e2e/voice-harness.spec.ts
// Artifacts: test/e2e/artifacts/voice/*.png, timeline-*.json, report.json

import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ART = path.join(ROOT, 'test/e2e/artifacts/voice');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const GUARD_MS = 400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------- static server
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// ---------------------------------------------------------------- in-page mock (runs in the browser)
type Step = { after: number; do: 'start' | 'audiostart' | 'interim' | 'final' | 'error' | 'end'; text?: string; error?: string };
interface MockCfg {
  permission: 'granted' | 'prompt' | 'denied';
  sessions: Step[][];
  unsupportedLangs?: string[];
  speakMsPerChar?: number;
  speakMinMs?: number;
  voicesDelayMs?: number;
}

function installMockVoice(cfg: MockCfg) {
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

// ---------------------------------------------------------------- harness helpers
interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
interface ScenarioResult {
  name: string;
  title: string;
  ms: number;
  checks: Check[];
  timeline?: any[];
  printTimeline?: boolean;
}
const results: ScenarioResult[] = [];

const SESSION_REQUEST: Step[] = [
  { after: 30, do: 'start' },
  { after: 50, do: 'audiostart' },
  { after: 300, do: 'interim', text: 'بدي' },
  { after: 600, do: 'interim', text: 'بدي شقة' },
  { after: 900, do: 'final', text: 'بدي شقة بإعزاز' },
  { after: 950, do: 'end' },
];
const SESSION_ANSWER: Step[] = [
  { after: 30, do: 'start' },
  { after: 50, do: 'audiostart' },
  { after: 250, do: 'interim', text: 'للإي' },
  { after: 500, do: 'final', text: 'للإيجار' },
  { after: 540, do: 'end' },
];
const QUESTION_TEXT = 'بدك الشقة للبيع ولا للإيجار؟';
const QUESTION_SPOKEN = 'بِدَّك الشّقة للبيع، ولا للإيجار؟';

let browser: Browser;
let base = '';

async function open(query: string, mock: MockCfg): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ locale: 'ar', viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript(installMockVoice, mock);
  await page.goto(`${base}/voice-harness.html?${query}`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 5000 });
  return { ctx, page, errors };
}

const state = (page: Page) => page.evaluate(() => (window as any).__harness.machine.state as string);
const waitState = (page: Page, s: string, timeout = 8000) =>
  page.waitForFunction((x) => (window as any).__harness.machine.state === x, s, { timeout, polling: 10 });
const statesSeq = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = ['ready'];
    for (const s of (window as any).__harness.states) if (out[out.length - 1] !== s.state) out.push(s.state);
    return out;
  });
const stateTimes = (page: Page) => page.evaluate(() => (window as any).__harness.states.map((s: any) => ({ t: s.t, state: s.state, event: s.event })) as Array<{ t: number; state: string; event: string }>);
const mockLog = (page: Page) => page.evaluate(() => (window as any).__mockVoice.log as any[]);
const violations = (page: Page) => page.evaluate(() => (window as any).__mockVoice.violations as any[]);
const apiCalls = (page: Page) => page.evaluate(() => (window as any).__harness.apiCalls as any[]);
const ctxOf = (page: Page) => page.evaluate(() => (window as any).__harness.machine.context);
const voiceStatus = (page: Page) => page.evaluate(() => (window as any).__harness.voice.status());
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(ART, `${name}.png`), fullPage: true });
const visible = (page: Page, sel: string) => page.isVisible(sel);

async function scenario(name: string, title: string, fn: (expect: (ok: unknown, label: string, detail?: unknown) => void, r: ScenarioResult) => Promise<void>) {
  const r: ScenarioResult = { name, title, ms: 0, checks: [] };
  const expect = (ok: unknown, label: string, detail?: unknown) =>
    r.checks.push({ name: label, ok: !!ok, detail: detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail) });
  const t0 = Date.now();
  try {
    await fn(expect, r);
  } catch (e: any) {
    r.checks.push({ name: 'scenario ran without exception', ok: false, detail: String((e && e.stack) || e).split('\n').slice(0, 4).join(' | ') });
  }
  r.ms = Date.now() - t0;
  results.push(r);
  const failed = r.checks.filter((c) => !c.ok);
  console.log(`\n[${failed.length ? 'FAIL' : 'PASS'}] ${name} — ${title} (${r.ms} ms, ${r.checks.length - failed.length}/${r.checks.length} checks)`);
  for (const c of r.checks) console.log(`   ${c.ok ? 'ok ' : 'XX '} ${c.name}${c.detail && (!c.ok || c.detail.length < 140) ? `  [${c.detail}]` : ''}`);
  if (r.timeline && r.printTimeline) {
    console.log('   timeline excerpt (ms relative to first event; speech vs. microphone):');
    for (const e of r.timeline) {
      if (/^(synth\.(speak|start|end|cancel)|rec\.(start|end|abort)|state:(speaking|awaiting_answer|listening|reviewing))$/.test(e.what) && !(e.what === 'state:listening' && e.event === 'INTERIM')) {
        console.log(`     ${String(e.rel.toFixed(1)).padStart(8)}  ${e.what}${e.synthBusy !== undefined ? `  (synthBusy=${e.synthBusy})` : ''}${e.cancelled ? '  (cancelled)' : ''}`);
      }
    }
  }
  if (r.timeline) await writeFile(path.join(ART, `timeline-${name}.json`), JSON.stringify(r.timeline, null, 2));
}

/** Relative timeline of speech/recognition events + state changes, for the report. */
async function buildTimeline(page: Page) {
  const log = await mockLog(page);
  const st = await stateTimes(page);
  const all = [
    ...log.filter((e) => /^(synth\.(speak|start|end|cancel)|rec\.(start|onstart|end|abort|stop|error))$/.test(e.type)).map((e) => ({ t: e.t, what: e.type, ...e })),
    ...st.map((s) => ({ t: Math.round(s.t * 10) / 10, what: `state:${s.state}`, event: s.event })),
  ].sort((a, b) => a.t - b.t);
  const t0 = all.length ? all[0].t : 0;
  return all.map((e) => ({ ...e, rel: Math.round((e.t - t0) * 10) / 10 }));
}

/** Intervals where speech was audible vs. the microphone was open; returns overlaps (must be empty). */
function overlaps(log: any[]) {
  const speech: Array<[number, number]> = [];
  const mic: Array<[number, number]> = [];
  let sStart: number | null = null;
  const recOpen = new Map<number, number>();
  for (const e of log) {
    if (e.type === 'synth.speak' && sStart === null) sStart = e.t; // pending counts as busy
    if (e.type === 'synth.end' && sStart !== null) {
      speech.push([sStart, e.t]);
      sStart = null;
    }
    if (e.type === 'rec.start') recOpen.set(e.id, e.t);
    if ((e.type === 'rec.end' || e.type === 'rec.abort' || e.type === 'rec.stop') && recOpen.has(e.id)) {
      mic.push([recOpen.get(e.id)!, e.t]);
      recOpen.delete(e.id);
    }
  }
  if (sStart !== null) speech.push([sStart, Infinity]);
  for (const [, t] of recOpen) mic.push([t, Infinity]);
  const out: string[] = [];
  for (const [a1, a2] of speech) for (const [b1, b2] of mic) if (a1 < b2 && b1 < a2) out.push(`speech[${a1}-${a2}] ∩ mic[${b1}-${b2}]`);
  return out;
}

// ---------------------------------------------------------------- scenarios
async function main() {
  await mkdir(ART, { recursive: true });
  const srv = await startServer();
  base = srv.base;
  browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox'] });
  console.log('=====================================================================================');
  console.log(' SIMULATED VOICE TESTS — mock SpeechRecognition / speechSynthesis / permissions are');
  console.log(' injected into the page. This is NOT a human voice test: no real microphone, speech');
  console.log(' recognizer or TTS engine is used. It verifies the client state machine, timing and');
  console.log(' half-duplex ordering of public/js/conversation/* in real Chromium.');
  console.log(`  chromium: ${CHROMIUM} (${browser.version()})   server: ${base}`);
  console.log('=====================================================================================');

  await scenario('interim-final-autosend', 'mic → interim → final → review countdown → auto-send → saved → results', async (expect, r) => {
    const { ctx, page, errors } = await open('flow=saved&matches=2', { permission: 'granted', sessions: [SESSION_REQUEST] });
    await page.click('#mic');
    await page.waitForFunction(() => document.getElementById('transcript')!.textContent === 'بدي شقة', null, { timeout: 3000 });
    expect(true, "live interim transcript rendered ('بدي شقة') while listening");
    expect((await state(page)) === 'listening', 'state is listening during interim');
    await shot(page, '01-listening-interim');
    await waitState(page, 'reviewing');
    expect((await page.textContent('#transcript')) === 'بدي شقة بإعزاز', 'final transcript shown in review');
    expect(await visible(page, '#countdown'), 'countdown bar visible');
    expect(await visible(page, '#send-now'), "'send now' visible");
    expect(await visible(page, '#edit'), "'edit' visible");
    expect(await visible(page, '#cancel'), "'cancel' visible");
    await shot(page, '02-reviewing-countdown');
    await waitState(page, 'results', 6000);
    await shot(page, '03-results');
    const seq = await statesSeq(page);
    expect(JSON.stringify(seq) === JSON.stringify(['ready', 'listening', 'reviewing', 'processing', 'saving', 'searching', 'results']), 'state sequence', seq.join(' → '));
    const times = await stateTimes(page);
    const tReview = times.find((s) => s.state === 'reviewing')!.t;
    const tProc = times.find((s) => s.state === 'processing')!.t;
    expect(tProc - tReview >= 1550 && tProc - tReview <= 1900, 'auto-send after ~1600 ms of review', `${Math.round(tProc - tReview)} ms`);
    const calls = await apiCalls(page);
    const turn = calls.find((c) => c.fn === 'sendTurn');
    expect(turn && turn.text === 'بدي شقة بإعزاز' && turn.modality === 'voice', "sendTurn{text:'بدي شقة بإعزاز', modality:'voice'}", turn);
    expect(turn && UUID_RE.test(turn.clientTurnId), 'clientTurnId is a v4 UUID', turn && turn.clientTurnId);
    const start = (await mockLog(page)).find((e) => e.type === 'rec.start');
    expect(start.lang === 'ar-SY' && start.continuous === false && start.interimResults === true && start.maxAlternatives === 1, 'recognition config ar-SY / continuous=false / interim=true / maxAlternatives=1', start);
    expect((await page.textContent('#notice')) === 'وجدنا مطابقتين لطلبك.', 'results notice (Arabic dual form)', await page.textContent('#notice'));
    expect((await page.locator('#results li').count()) === 2, 'two matches listed');
    expect(errors.length === 0, 'no page errors', errors);
    r.timeline = await buildTimeline(page);
    await ctx.close();
  });

  await scenario('clarify-speak-then-listen', 'server asks ONE question → shown centred + spoken → auto-listen after guard → answer to SAME conversation', async (expect, r) => {
    const { ctx, page, errors } = await open('flow=ask&matches=0', { permission: 'granted', sessions: [SESSION_REQUEST, SESSION_ANSWER] });
    await page.click('#mic');
    await waitState(page, 'speaking', 6000);
    expect((await page.textContent('#question')) === QUESTION_TEXT, 'question text displayed', await page.textContent('#question'));
    expect((await page.locator('#options button').count()) === 2, 'quick-answer chips displayed');
    await shot(page, '04-speaking-question');
    await waitState(page, 'saved_no_results', 12000);
    await shot(page, '05-saved-no-results');
    const seq = await statesSeq(page);
    const expected = ['ready', 'listening', 'reviewing', 'processing', 'asking', 'speaking', 'awaiting_answer', 'listening', 'reviewing', 'processing', 'saving', 'searching', 'saved_no_results'];
    expect(JSON.stringify(seq) === JSON.stringify(expected), 'state sequence', seq.join(' → '));
    const log = await mockLog(page);
    const speak = log.find((e) => e.type === 'synth.speak');
    expect(speak && speak.text === QUESTION_SPOKEN, 'spoken text = diacritized speech variant + pause, same letters as display', speak && speak.text);
    expect(speak && speak.voice === 'Mock Arabic (ar-SA)' && speak.lang === 'ar-SA', 'Arabic voice selected after async voiceschanged', speak);
    expect(speak && Math.abs(speak.rate - 0.95) < 1e-9, 'speech rate 0.95', speak && speak.rate);
    const synthEnd = log.filter((e) => e.type === 'synth.end').pop();
    const recStarts = log.filter((e) => e.type === 'rec.start');
    expect(recStarts.length === 2, 'two recognition sessions (request + answer)', recStarts.length);
    const gap = recStarts[1].t - synthEnd.t;
    expect(gap >= GUARD_MS - 5, `answer mic opened ≥ ${GUARD_MS} ms after speech ended`, `${gap.toFixed(1)} ms`);
    expect(recStarts.every((e) => e.synthBusy === false), 'recognition.start() never called while synthesis busy');
    const ov = overlaps(log);
    expect(ov.length === 0, 'no overlap between speech and open microphone', ov);
    expect((await violations(page)).length === 0, 'mock recorded no half-duplex violations', await violations(page));
    const calls = await apiCalls(page);
    const turns = calls.filter((c) => c.fn === 'sendTurn');
    expect(calls.filter((c) => c.fn === 'ensureConversation').length === 1, 'one conversation for request + answer');
    expect(turns.length === 2 && turns[0].id === turns[1].id, 'answer sent to the SAME conversation', turns.map((t) => t.id));
    expect(turns[1] && turns[1].text === 'للإيجار' && turns[1].modality === 'voice', "answer turn {text:'للإيجار', modality:'voice'}");
    expect(turns.length === 2 && turns[0].clientTurnId !== turns[1].clientTurnId, 'new clientTurnId per user turn');
    expect((await page.textContent('#notice')) === 'تم حفظ طلبك، سنخبرك عند ظهور مطابقات مناسبة', 'saved message shown', await page.textContent('#notice'));
    expect(errors.length === 0, 'no page errors', errors);
    r.timeline = await buildTimeline(page);
    r.printTimeline = true;
    await ctx.close();
  });

  await scenario('tap-to-answer', "permission 'prompt' → no auto-listen; clear tap button; answer still to the same conversation", async (expect) => {
    const { ctx, page, errors } = await open('flow=ask&matches=1', { permission: 'prompt', sessions: [SESSION_REQUEST, SESSION_ANSWER] });
    await page.click('#mic');
    await waitState(page, 'awaiting_answer', 8000);
    await page.waitForTimeout(1500);
    expect((await state(page)) === 'awaiting_answer', 'still awaiting_answer 1.5 s after the question (no auto-listen)');
    expect((await mockLog(page)).filter((e) => e.type === 'rec.start').length === 1, 'microphone not opened automatically');
    expect(await visible(page, '#tap-answer'), "tap-to-answer button visible ('اضغط للإجابة بصوتك')");
    expect(await visible(page, '#tap-hint'), 'explanation why auto-listen is off is visible');
    expect((await voiceStatus(page)).canAutoListen === false, 'voice.canAutoListen() === false');
    await shot(page, '06-tap-to-answer');
    await page.click('#tap-answer');
    await waitState(page, 'results', 8000);
    const turns = (await apiCalls(page)).filter((c) => c.fn === 'sendTurn');
    expect(turns.length === 2 && turns[0].id === turns[1].id, 'tapped answer sent to the same conversation');
    expect(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  });

  await scenario('no-speech', "no-speech → recoverable error with retry; retry listens again; cancel during review sends nothing", async (expect) => {
    const { ctx, page, errors } = await open('flow=saved', {
      permission: 'granted',
      sessions: [
        [
          { after: 30, do: 'start' },
          { after: 50, do: 'audiostart' },
          { after: 700, do: 'error', error: 'no-speech' },
          { after: 720, do: 'end' },
        ],
        [
          { after: 30, do: 'start' },
          { after: 50, do: 'audiostart' },
          { after: 300, do: 'final', text: 'بدي سيارة' },
          { after: 330, do: 'end' },
        ],
      ],
    });
    await page.click('#mic');
    await waitState(page, 'error');
    const c = await ctxOf(page);
    expect(c.error.code === 'no-speech' && c.error.recoverable === true, 'error {code:no-speech, recoverable:true}', c.error);
    expect(await visible(page, '#retry'), 'retry button visible');
    expect(/لم نسمع/.test((await page.textContent('#error')) || ''), 'Arabic message "لم نسمع شيئًا…"', await page.textContent('#error'));
    expect(!(await page.isDisabled('#text-input')), 'text input available');
    await shot(page, '07-no-speech');
    await page.click('#retry');
    await waitState(page, 'reviewing');
    expect((await page.textContent('#transcript')) === 'بدي سيارة', 'retry recorded a new utterance');
    await page.click('#cancel');
    expect((await state(page)) === 'ready', 'cancel during review → ready');
    await page.waitForTimeout(2000);
    expect((await apiCalls(page)).filter((x) => x.fn === 'sendTurn').length === 0, 'nothing sent after cancel (countdown cleared)');
    expect(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  });

  await scenario('not-allowed', 'permission denied → explain how to enable, no retry loop, text input works', async (expect) => {
    const { ctx, page, errors } = await open('flow=saved&matches=0', {
      permission: 'prompt',
      sessions: [
        [
          { after: 40, do: 'error', error: 'not-allowed' },
          { after: 50, do: 'end' },
        ],
      ],
    });
    await page.click('#mic');
    await waitState(page, 'error');
    const c = await ctxOf(page);
    expect(c.error.code === 'not-allowed' && c.error.recoverable === false, 'error {code:not-allowed, recoverable:false}', c.error);
    expect(/القفل/.test((await page.textContent('#error')) || '') && /اكتب|كتابة/.test((await page.textContent('#error')) || ''), 'message explains how to enable the mic and offers typing', await page.textContent('#error'));
    expect(!(await visible(page, '#retry')), 'no retry button (retry cannot fix a denied permission)');
    const vs = await voiceStatus(page);
    expect(vs.permission === 'denied' && vs.canAutoListen === false, 'voice status permission=denied, canAutoListen=false', vs);
    await shot(page, '08-not-allowed');
    const before = (await mockLog(page)).filter((e) => e.type === 'rec.start').length;
    await page.click('#mic');
    await page.waitForTimeout(200);
    expect((await state(page)) === 'error', 'pressing the mic again reports the same error immediately');
    expect((await mockLog(page)).filter((e) => e.type === 'rec.start').length === before, 'no new recognition attempt while denied (proactive)');
    await page.fill('#text-input', 'بدي شقة للإيجار بإعزاز');
    await page.click('#text-send');
    await waitState(page, 'saved_no_results', 6000);
    const turn = (await apiCalls(page)).find((x) => x.fn === 'sendTurn');
    expect(turn && turn.modality === 'text' && turn.text === 'بدي شقة للإيجار بإعزاز', 'typed request sent with modality text', turn);
    await shot(page, '09-typed-after-denied');
    expect(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  });

  await scenario('network', 'network error → explain that recognition needs internet; offline → reported proactively', async (expect) => {
    const { ctx, page, errors } = await open('flow=saved', {
      permission: 'granted',
      sessions: [
        [
          { after: 30, do: 'start' },
          { after: 50, do: 'audiostart' },
          { after: 200, do: 'interim', text: 'بدي' },
          { after: 400, do: 'error', error: 'network' },
          { after: 420, do: 'end' },
        ],
      ],
    });
    await page.click('#mic');
    await waitState(page, 'error');
    let c = await ctxOf(page);
    expect(c.error.code === 'network' && c.error.recoverable === true, 'error {code:network, recoverable:true}', c.error);
    expect(/الإنترنت/.test((await page.textContent('#error')) || ''), 'message says speech recognition needs the internet', await page.textContent('#error'));
    await shot(page, '10-network');
    const before = (await mockLog(page)).filter((e) => e.type === 'rec.start').length;
    await ctx.setOffline(true);
    await page.waitForFunction(() => navigator.onLine === false);
    expect((await voiceStatus(page)).canAutoListen === false, 'offline → canAutoListen false');
    await page.click('#mic');
    await page.waitForTimeout(150);
    c = await ctxOf(page);
    expect((await state(page)) === 'error' && c.error.code === 'network' && c.error.offline === true, 'offline: network error reported without trying', c.error);
    expect((await mockLog(page)).filter((e) => e.type === 'rec.start').length === before, 'no recognition.start() while offline');
    await shot(page, '11-offline');
    await ctx.setOffline(false);
    expect(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  });

  await scenario('barge-in', 'mic pressed while the question is being spoken → speech cancelled first, mic opens after the guard', async (expect, r) => {
    const { ctx, page, errors } = await open('flow=ask&matches=1', { permission: 'granted', speakMsPerChar: 150, sessions: [SESSION_REQUEST, SESSION_ANSWER] });
    await page.click('#mic');
    await waitState(page, 'speaking', 6000);
    await page.waitForFunction(() => (window as any).__mockVoice.log.some((e: any) => e.type === 'synth.start'));
    await page.waitForTimeout(400);
    await page.click('#mic'); // barge-in
    await waitState(page, 'results', 10000);
    const log = await mockLog(page);
    const cancel = log.find((e) => e.type === 'synth.cancel' && e.active);
    const recStarts = log.filter((e) => e.type === 'rec.start');
    expect(!!cancel, 'speech cancelled on barge-in');
    expect(recStarts.length === 2 && recStarts[1].t > cancel.t, 'recognition started after the cancel');
    expect(recStarts.length === 2 && recStarts[1].t - cancel.t >= GUARD_MS - 5, `guard ≥ ${GUARD_MS} ms after cancel`, recStarts[1] && `${(recStarts[1].t - cancel.t).toFixed(1)} ms`);
    expect(recStarts.every((e) => e.synthBusy === false), 'recognition.start() never while synthesis busy');
    expect(overlaps(log).length === 0, 'no overlap between speech and open microphone', overlaps(log));
    expect((await violations(page)).length === 0, 'mock recorded no violations');
    const turns = (await apiCalls(page)).filter((c) => c.fn === 'sendTurn');
    expect(turns.length === 2 && turns[0].id === turns[1].id, 'barge-in answer goes to the same conversation');
    expect(errors.length === 0, 'no page errors', errors);
    r.timeline = await buildTimeline(page);
    r.printTimeline = true;
    await ctx.close();
  });

  await scenario('language-fallback', "'language-not-supported' for ar-SY → retried transparently with ar-LB, remembered", async (expect) => {
    const { ctx, page, errors } = await open('flow=saved', { permission: 'granted', unsupportedLangs: ['ar-SY'], sessions: [SESSION_REQUEST] });
    await page.click('#mic');
    await waitState(page, 'reviewing', 5000);
    const langs = (await mockLog(page)).filter((e) => e.type === 'rec.start').map((e) => e.lang);
    expect(JSON.stringify(langs) === JSON.stringify(['ar-SY', 'ar-LB']), 'languages tried ar-SY → ar-LB', langs);
    expect((await page.evaluate(() => localStorage.getItem('ul.voice.recLang'))) === 'ar-LB', 'working language remembered (localStorage)');
    expect((await statesSeq(page)).indexOf('error') === -1, 'no error shown to the user');
    await page.click('#cancel');
    expect(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  });

  await scenario('retry-same-turn', 'server error → retry resends the same turn with the SAME clientTurnId', async (expect) => {
    const { ctx, page, errors } = await open('flow=saved&failTurns=1&matches=1', { permission: 'granted', sessions: [] });
    await page.fill('#text-input', 'بدي شقة بإعزاز');
    await page.click('#text-send');
    await waitState(page, 'error');
    expect((await page.textContent('#error')) === 'الخادم مشغول مؤقتًا. أعد المحاولة.', "server's messageAr shown", await page.textContent('#error'));
    await shot(page, '12-turn-error');
    await page.click('#retry');
    await waitState(page, 'results');
    const turns = (await apiCalls(page)).filter((c) => c.fn === 'sendTurn');
    expect(turns.length === 2 && turns[0].clientTurnId === turns[1].clientTurnId && turns[0].id === turns[1].id, 'same clientTurnId and conversation on retry', turns.map((t) => [t.id, t.clientTurnId]));
    expect(errors.length === 0, 'no page errors', errors);
    await ctx.close();
  });

  await browser.close();
  await srv.close();

  const total = results.reduce((n, r) => n + r.checks.length, 0);
  const failed = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.name}: ${c.name}`));
  await writeFile(
    path.join(ART, 'report.json'),
    JSON.stringify({ kind: 'SIMULATED voice tests (mock Web Speech API) — not a human voice test', chromium: CHROMIUM, at: new Date().toISOString(), scenarios: results.map(({ timeline, ...r }) => r) }, null, 2),
  );
  console.log('\n=====================================================================================');
  console.log(` SIMULATED VOICE TESTS: ${results.length} scenarios, ${total - failed.length}/${total} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  for (const f of failed) console.log(`   FAILED: ${f}`);
  console.log(` artifacts: ${path.relative(ROOT, ART)}/ (screenshots, timeline-*.json, report.json)`);
  console.log(' Reminder: simulated input only. A real-microphone check by a human is still required.');
  console.log('=====================================================================================');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(async (e) => {
  console.error(e);
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
