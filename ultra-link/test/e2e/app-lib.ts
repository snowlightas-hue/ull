// Shared harness for the browser E2E specs of the real app (test/e2e/app-*.spec.ts).
//
// Every spec runs against its OWN isolated stack — never the live demo on :8080:
//   freshDb(tag)  → node src/seed/seed.ts (synthetic demo personas)  → server + worker as child processes.
// The stack is torn down (processes killed, database dropped) at the end.
//
// Understanding engine: JEV_MODE=off (rules only), so results are deterministic and no request ever leaves
// the machine. Jev behaviour (reachable / unreachable) is covered by test/integration/flows-*.test.ts.
//
// Voice: these specs drive the app through the TEXT composer and the quick-answer chips. They contain no
// voice tests. (Simulated-voice coverage lives in test/e2e/voice-harness.spec.ts and is labeled SIMULATED.)

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Locator, type Page } from 'playwright-core';
import { freshDb } from '../helpers/testdb.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ART = path.join(ROOT, 'test/e2e/artifacts/app');
export const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
mkdirSync(path.join(ART, 'logs'), { recursive: true });

// ───────────────────────────── viewports ─────────────────────────────
export interface Viewport { name: string; width: number; height: number; mobile: boolean }
export const VIEWPORTS: Viewport[] = [
  { name: 'desktop-1280x800', width: 1280, height: 800, mobile: false },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
  { name: 'mobile-360x640', width: 360, height: 640, mobile: true },
];
export function selectedViewports(): Viewport[] {
  const want = process.env.E2E_VIEWPORTS?.split(',').map((s) => s.trim()).filter(Boolean);
  return want?.length ? VIEWPORTS.filter((v) => want.some((w) => v.name.includes(w))) : VIEWPORTS;
}

// ───────────────────────────── isolated stack ─────────────────────────────
export interface Stack { base: string; dbUrl: string; dbName: string; logs: string; stop: () => Promise<void> }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(logFile, { flags: 'a' });
    const p = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.pipe(out);
    p.stderr.pipe(out);
    p.on('error', reject);
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

function startProc(script: string, env: NodeJS.ProcessEnv, logFile: string): ChildProcess {
  const out = createWriteStream(logFile, { flags: 'a' });
  const p = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  return p;
}

async function stopProc(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 5000);
    p.once('exit', () => { clearTimeout(t); resolve(); });
    p.kill('SIGTERM');
  });
}

/** Fresh DB + seeded synthetic personas + server + worker on a free port. */
export async function startStack(tag: string, extraEnv: Record<string, string> = {}): Promise<Stack> {
  const db = await freshDb(tag);
  const dbUrl = db.url;
  const dbName = db.name;
  await db.close();
  const logs = path.join(ART, 'logs', tag);
  mkdirSync(logs, { recursive: true });
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, JEV_MODE: 'off', UL_LOG_LEVEL: 'warn', ...extraEnv };
  delete baseEnv.UL_PIDFILE;
  const code = await run(process.execPath, ['src/seed/seed.ts'], { ...baseEnv, DATABASE_URL: dbUrl }, path.join(logs, 'seed.log'));
  if (code !== 0) throw new Error(`seed failed (exit ${code}) — see ${logs}/seed.log`);
  const port = await freePort();
  const server = startProc('src/server/main.ts', { ...baseEnv, UL_DATABASE_URL: dbUrl, PORT: String(port), HOST: '127.0.0.1' }, path.join(logs, 'server.log'));
  const worker = startProc('src/worker/main.ts', { ...baseEnv, UL_DATABASE_URL: dbUrl }, path.join(logs, 'worker.log'));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const h = await (await fetch(`${base}/api/health`)).json() as { ok: boolean; worker: { alive: boolean } };
      if (h.ok && h.worker.alive) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`stack ${tag} did not become healthy — see ${logs}`);
    await sleep(200);
  }
  return {
    base, dbUrl, dbName, logs,
    stop: async () => {
      await stopProc(worker);
      await stopProc(server);
      const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
      try {
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } catch { /* best effort */ } finally { await admin.end().catch(() => {}); }
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── reporting ─────────────────────────────
export interface CheckResult { name: string; ok: boolean; detail?: string }
export interface ScenarioResult { scenario: string; viewport: string; ok: boolean; checks: CheckResult[]; error?: string; ms: number }

export class Scenario {
  checks: CheckResult[] = [];
  error?: string;
  id: string;
  viewport: string;
  constructor(id: string, viewport: string) { this.id = id; this.viewport = viewport; }
  check(name: string, ok: boolean, detail?: unknown): boolean {
    const d = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail);
    this.checks.push({ name, ok: !!ok, detail: d });
    console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}${d ? `  [${d.length > 400 ? d.slice(0, 400) + '…' : d}]` : ''}`);
    return !!ok;
  }
  get ok() { return !this.error && this.checks.length > 0 && this.checks.every((c) => c.ok); }
}

export async function runScenario(results: ScenarioResult[], id: string, viewport: string, page: Page | null, fn: (s: Scenario) => Promise<void>): Promise<ScenarioResult> {
  const s = new Scenario(id, viewport);
  const t0 = Date.now();
  console.log(`\n  ▶ [${viewport}] ${id}`);
  try {
    await fn(s);
  } catch (e) {
    s.error = (e as Error).message.split('\n').slice(0, 6).join(' | ');
    console.log(`    FAIL  exception: ${s.error}`);
    if (page) await shot(page, viewport, `${id.split(' ')[0]}-EXCEPTION`).catch(() => {});
  }
  const r: ScenarioResult = { scenario: id, viewport, ok: s.ok, checks: s.checks, error: s.error, ms: Date.now() - t0 };
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'} [${viewport}] ${id} (${r.ms} ms, ${s.checks.filter((c) => c.ok).length}/${s.checks.length} checks${s.error ? ', exception' : ''})`);
  results.push(r);
  return r;
}

export function printSummary(title: string, results: ScenarioResult[]): boolean {
  const viewports = [...new Set(results.map((r) => r.viewport))];
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  console.log(`\n${'='.repeat(100)}\n ${title}\n${'='.repeat(100)}`);
  const w = Math.max(...scenarios.map((s) => s.length), 10);
  console.log(` ${'scenario'.padEnd(w)}  ${viewports.map((v) => v.padEnd(18)).join(' ')}`);
  for (const sc of scenarios) {
    const cells = viewports.map((v) => {
      const r = results.find((x) => x.scenario === sc && x.viewport === v);
      if (!r) return '—'.padEnd(18);
      const n = `${r.checks.filter((c) => c.ok).length}/${r.checks.length}`;
      return `${r.ok ? 'PASS' : 'FAIL'} ${n}`.padEnd(18);
    });
    console.log(` ${sc.padEnd(w)}  ${cells.join(' ')}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n Failed checks:');
    for (const r of failed) {
      for (const c of r.checks.filter((x) => !x.ok)) console.log(`  - [${r.viewport}] ${r.scenario} :: ${c.name}${c.detail ? ` [${c.detail.slice(0, 300)}]` : ''}`);
      if (r.error) console.log(`  - [${r.viewport}] ${r.scenario} :: exception: ${r.error}`);
    }
  }
  const total = results.reduce((a, r) => a + r.checks.length, 0);
  const ok = results.reduce((a, r) => a + r.checks.filter((c) => c.ok).length, 0);
  console.log(`\n ${results.filter((r) => r.ok).length}/${results.length} scenario runs passed, ${ok}/${total} checks passed`);
  console.log(` artifacts: ${path.relative(ROOT, ART)}/\n${'='.repeat(100)}`);
  return failed.length === 0;
}

// ───────────────────────────── browser helpers ─────────────────────────────
export async function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--lang=ar'] });
}

export async function newContext(browser: Browser, vp: Viewport, opts: { reducedMotion?: 'reduce' | 'no-preference' } = {}): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    deviceScaleFactor: vp.mobile ? 2 : 1,
    locale: 'ar-SY',
    timezoneId: 'Asia/Damascus', // Syria: UTC+3 all year
    reducedMotion: opts.reducedMotion ?? 'no-preference',
  });
}

/** Console errors, uncaught page errors and failed requests, with justified exclusions. */
export interface Noise { errors: string[]; ignored: string[] }
export function watchNoise(page: Page): Noise {
  const n: Noise = { errors: [], ignored: [] };
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') n.errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => n.errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? '';
    // EventSource (/api/events) is aborted by the browser on reload/close — expected, not an app error.
    if (r.url().includes('/api/events') && /ERR_ABORTED/.test(f)) { n.ignored.push(`${r.url()} ${f}`); return; }
    n.errors.push(`requestfailed: ${r.method()} ${r.url()} ${f}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) n.errors.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`);
  });
  return n;
}

export async function shot(page: Page, vp: string, name: string, fullPage = false): Promise<void> {
  await page.screenshot({ path: path.join(ART, `${vp}-${name}.png`), fullPage }).catch(() => {});
}

/** Tap on touch viewports, click elsewhere. */
export async function press(loc: Locator, mobile: boolean): Promise<void> {
  await loc.scrollIntoViewIfNeeded();
  if (mobile) await loc.tap(); else await loc.click();
}

/** Log in through the real login screen (persona card button). */
export async function loginAs(page: Page, base: string, displayNamePrefix: string, mobile: boolean): Promise<void> {
  await page.goto(base);
  const btn = page.getByRole('button', { name: new RegExp(`ادخل كـ ${displayNamePrefix}`) });
  await btn.waitFor({ timeout: 15_000 });
  await press(btn, mobile);
  await page.waitForSelector('.composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('.home')?.getAttribute('data-phase') === 'ready');
}

/** Type a request (or an answer) into the composer and send it with Enter. */
export async function typeAndSend(page: Page, text: string): Promise<void> {
  const input = page.locator('.composer-input');
  await input.fill(text);
  await input.press('Enter');
}

/** Wait until the home stage reaches one of the given phases. Returns the phase. */
export async function waitPhase(page: Page, phases: string[], timeout = 15_000): Promise<string> {
  const h = await page.waitForFunction((ps) => {
    const p = document.querySelector('.home')?.getAttribute('data-phase');
    return p && ps.includes(p) ? p : null;
  }, phases, { timeout });
  return (await h.jsonValue()) as string;
}

export async function openTab(page: Page, label: string, mobile: boolean): Promise<void> {
  const tab = page.locator('[role=tab]', { has: page.locator('.tab-label', { hasText: new RegExp(`^${label}$`) }) });
  await press(tab, mobile);
  await page.waitForFunction((l) => {
    const t = [...document.querySelectorAll('[role=tab]')].find((x) => x.querySelector('.tab-label')?.textContent === l);
    return t?.getAttribute('aria-selected') === 'true';
  }, label);
}

/** document is not horizontally scrollable (1px tolerance for sub-pixel rounding). */
export async function horizontalOverflow(page: Page): Promise<{ overflow: boolean; scrollWidth: number; clientWidth: number; widest: string | null }> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const sw = Math.max(de.scrollWidth, document.body.scrollWidth);
    const cw = de.clientWidth;
    let widest: string | null = null;
    if (sw > cw + 1) {
      let best = 0;
      for (const el of document.querySelectorAll('body *')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        const over = Math.max(r.right - cw, -r.left);
        if (over > best && r.width > 0) { best = over; widest = `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`.slice(0, 80) + ` (+${Math.round(over)}px)`; }
      }
    }
    return { overflow: sw > cw + 1, scrollWidth: sw, clientWidth: cw, widest };
  });
}

/** Record every question card that is ever rendered (MutationObserver), to prove "one question at a time". */
export async function installQuestionRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__qlog) return;
    w.__qlog = [] as { qid: string; field: string; text: string; t: number }[];
    w.__qmaxVisible = 0;
    const seen = new Set<Element>();
    const scan = () => {
      const cards = [...document.querySelectorAll('.q-card')] as HTMLElement[];
      const visible = cards.filter((c) => !c.closest('[hidden]'));
      w.__qmaxVisible = Math.max(w.__qmaxVisible, visible.length);
      for (const c of cards) {
        if (seen.has(c)) continue;
        seen.add(c);
        w.__qlog.push({ qid: c.dataset.qid ?? '', field: c.dataset.field ?? '', text: c.querySelector('.q-text')?.textContent ?? '', t: Date.now() });
      }
    };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    scan();
  });
}

/** Arabic-Indic digits → Latin (for numeric assertions on UI text). */
export function latin(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/٬/g, ',').replace(/٫/g, '.');
}
