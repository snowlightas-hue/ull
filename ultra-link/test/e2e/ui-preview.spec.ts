// UI preview e2e (Role 2 — Design & UX). Plain Node script: `node test/e2e/ui-preview.spec.ts`
// Serves public/ with a tiny static server on a random port, drives public/ui-preview.html in
// Chromium (playwright-core) and checks layout, RTL, keyboard tabs, contrast, reduced motion,
// dialog focus trap and pagination. Screenshots go to test/e2e/artifacts/ui/.
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../../public');
const OUT = path.resolve(HERE, 'artifacts/ui');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

// ── tiny static server ──
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(PUBLIC, '.' + rel);
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end('forbidden'); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

// ── tiny check runner ──
type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];
async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || undefined });
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail: msg });
    console.log(`FAIL  ${name}  — ${msg}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const VIEWPORTS = [
  { name: '360x640', width: 360, height: 640 },
  { name: '390x844', width: 390, height: 844 },
  { name: '1280x800', width: 1280, height: 800 },
];

const ALL_STATES = [
  'ready', 'listening', 'reviewing', 'processing', 'asking', 'speaking', 'awaiting_answer', 'awaiting_answer_tap',
  'conflict', 'saving', 'searching', 'results', 'saved_no_results', 'error',
  'requests', 'requests_first', 'requests_last', 'offers', 'offers_empty', 'offers_loading', 'offers_error',
  'matches', 'notifications', 'editor', 'toast',
];
// every state is screenshotted at 390×844; these also at 360×640 and 1280×800
const KEY_STATES = new Set(['ready', 'listening', 'reviewing', 'awaiting_answer_tap', 'results', 'saved_no_results', 'error', 'requests', 'matches', 'notifications', 'editor']);
const FULL_PAGE = new Set(['results', 'saved_no_results', 'requests', 'matches', 'notifications', 'offers']);

const pageErrors: string[] = [];

async function openPreview(ctx: BrowserContext, base: string, state = 'ready'): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) pageErrors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${base}/ui-preview.html?chrome=0&state=${state}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__preview?.ready === true, null, { timeout: 10000 });
  return page;
}

async function show(page: Page, state: string): Promise<void> {
  await page.evaluate((s) => (window as any).__preview.show(s), state);
  await page.waitForTimeout(60);
}

async function overflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number; offenders: string[] }> {
  return page.evaluate(() => {
    const se = document.scrollingElement as HTMLElement;
    const innerWidth = window.innerWidth;
    const offenders: string[] = [];
    if (se.scrollWidth > innerWidth) {
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const r = el.getBoundingClientRect();
        if ((r.right > innerWidth + 0.5 || r.left < -0.5) && r.width > 0 && !el.closest('.tablist, .list-filter, .sheet-backdrop')) {
          offenders.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').split(' ').join('.')} [${Math.round(r.left)}..${Math.round(r.right)}]`);
          if (offenders.length > 6) break;
        }
      }
    }
    return { scrollWidth: se.scrollWidth, innerWidth, offenders };
  });
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`static server: ${base}  (serving ${PUBLIC})`);

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const browser: Browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--font-render-hinting=none'] });
  try {
    // ── 1. layout at three viewports, every state ──
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.width < 500 ? 2 : 1, locale: 'ar-SY' });
      const page = await openPreview(ctx, base);

      await check(`[${vp.name}] html has dir="rtl" and lang="ar"`, async () => {
        const attrs = await page.evaluate(() => ({ dir: document.documentElement.getAttribute('dir'), lang: document.documentElement.getAttribute('lang'), cs: getComputedStyle(document.body).direction }));
        assert(attrs.dir === 'rtl' && attrs.lang === 'ar' && attrs.cs === 'rtl', JSON.stringify(attrs));
        return JSON.stringify(attrs);
      });

      const states = vp.name === '390x844' ? ALL_STATES : ALL_STATES.filter((s) => KEY_STATES.has(s));
      const overflowFailures: string[] = [];
      const leakFailures: string[] = [];
      for (const st of ALL_STATES) {
        await show(page, st);
        const settle = ['results', 'saved_no_results', 'requests', 'matches', 'notifications', 'offers', 'editor', 'toast', 'asking', 'awaiting_answer', 'awaiting_answer_tap', 'conflict', 'reviewing', 'error'].includes(st) ? 900 : 350;
        await page.waitForTimeout(settle);
        const leaked = await page.evaluate(() => {
          const text = document.body.innerText;
          const m = text.match(/\b(null|undefined|NaN)\b|\[object Object\]/);
          return m ? m[0] : null;
        });
        if (leaked) leakFailures.push(`${st}: "${leaked}"`);
        const o = await overflow(page);
        if (o.scrollWidth > o.innerWidth) overflowFailures.push(`${st}: scrollWidth ${o.scrollWidth} > ${o.innerWidth} ${o.offenders.join(' ')}`);
        if (states.includes(st)) {
          await page.screenshot({ path: path.join(OUT, `${vp.name}-${st}.png`), fullPage: FULL_PAGE.has(st) });
        }
      }
      await check(`[${vp.name}] no page-level horizontal overflow in ${ALL_STATES.length} states`, async () => {
        assert(overflowFailures.length === 0, overflowFailures.join(' | '));
      });
      await check(`[${vp.name}] no leaked "null"/"undefined"/"NaN" text in any state`, async () => {
        assert(leakFailures.length === 0, leakFailures.join(' | '));
      });
      await ctx.close();
    }

    // ── 2. tabs: ARIA + keyboard (RTL: ArrowLeft = next) ──
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await openPreview(ctx, base);
      await check('tabs are an ARIA tablist with roving tabindex', async () => {
        const info = await page.evaluate(() => {
          const list = document.querySelector('[role="tablist"]');
          const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
          return {
            list: !!list,
            n: tabs.length,
            selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent?.trim()),
            tabbable: tabs.filter((t) => (t as HTMLElement).tabIndex === 0).length,
            controls: tabs.every((t) => document.getElementById(t.getAttribute('aria-controls') || '')?.getAttribute('role') === 'tabpanel'),
          };
        });
        assert(info.list && info.n === 5 && info.selected.length === 1 && info.tabbable === 1 && info.controls, JSON.stringify(info));
        return `${info.n} tabs, selected=${info.selected[0]}`;
      });
      await check('tabs keyboard: ArrowLeft/ArrowRight/Home/End move focus + selection', async () => {
        await page.focus('#ul-tab-home');
        const sel = () => page.evaluate(() => ({
          selected: document.querySelector('[role="tab"][aria-selected="true"]')?.id,
          focused: document.activeElement?.id,
          panelVisible: !(document.getElementById(document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls') || '') as HTMLElement)?.hidden,
        }));
        const steps: [string, string][] = [['ArrowLeft', 'ul-tab-requests'], ['ArrowLeft', 'ul-tab-offers'], ['End', 'ul-tab-notifications'], ['ArrowLeft', 'ul-tab-home'], ['ArrowRight', 'ul-tab-notifications'], ['Home', 'ul-tab-home']];
        const trail: string[] = [];
        for (const [key, want] of steps) {
          await page.keyboard.press(key);
          const s = await sel();
          trail.push(`${key}→${s.selected}`);
          assert(s.selected === want && s.focused === want && s.panelVisible, `${key}: expected ${want}, got ${JSON.stringify(s)}`);
        }
        return trail.join(', ');
      });
      await check('tabs show live counters (requests/offers/matches/unread)', async () => {
        const counts = await page.evaluate(() => Array.from(document.querySelectorAll('.tab-count')).map((c) => `${(c as HTMLElement).dataset.kind}=${(c as HTMLElement).hidden ? '-' : c.textContent}`));
        assert(counts.join(',') === 'requests=٩٩+,offers=٦,matches=٣٧,unread=٥', counts.join(','));
        return counts.join(', ');
      });

      // ── 3. composer works with Enter ──
      await check('text composer submits on Enter (onTextSubmit)', async () => {
        await show(page, 'ready');
        await page.fill('.composer-input', 'عندي سيارة للبيع');
        await page.press('.composer-input', 'Enter');
        const last = await page.evaluate(() => (window as any).__preview.log.filter((e: unknown[]) => e[0] === 'onTextSubmit').pop());
        const value = await page.inputValue('.composer-input');
        assert(last && last[1] === 'عندي سيارة للبيع' && value === '', JSON.stringify({ last, value }));
        return 'onTextSubmit("عندي سيارة للبيع"), input cleared';
      });

      // ── 4. pagination ──
      await check('pagination: "٢١–٤٠ من ٢٥٠", next → "٤١–٦٠", prev disabled on first page', async () => {
        await show(page, 'requests');
        const r1 = await page.textContent('.pager-range');
        assert(r1 === '٢١–٤٠ من ٢٥٠', `range was ${r1}`);
        await page.click('.pager-btn[data-dir="next"]');
        const r2 = await page.textContent('.pager-range');
        assert(r2 === '٤١–٦٠ من ٢٥٠', `after next: ${r2}`);
        const focused = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.dir);
        assert(focused === 'next', `focus after paging: ${focused}`);
        await show(page, 'requests_first');
        const prevDisabled = await page.getAttribute('.pager-btn[data-dir="prev"]', 'aria-disabled');
        const nextDisabled = await page.getAttribute('.pager-btn[data-dir="next"]', 'aria-disabled');
        assert(prevDisabled === 'true' && nextDisabled === 'false', `first page prev=${prevDisabled} next=${nextDisabled}`);
        await show(page, 'requests_last');
        const r3 = await page.textContent('.pager-range');
        const lastNext = await page.getAttribute('.pager-btn[data-dir="next"]', 'aria-disabled');
        assert(r3 === '٢٤١–٢٥٠ من ٢٥٠' && lastNext === 'true', `last page ${r3} next=${lastNext}`);
        return `${r1} → ${r2}; last page ${r3}`;
      });

      // ── 5. editor dialog: aria-modal, focus trap, Esc closes, focus restored ──
      await check('intent editor: role=dialog aria-modal, focus trapped, Esc closes, focus restored', async () => {
        await show(page, 'requests_first');
        const opener = page.locator('.intent-card .btn', { hasText: 'تعديل' }).first();
        await opener.focus();
        await opener.press('Enter');
        await page.waitForSelector('[role="dialog"][aria-modal="true"]');
        await page.waitForTimeout(100);
        const outside: string[] = [];
        for (let i = 0; i < 40; i += 1) {
          await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
          const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
          if (!inside) outside.push(String(i));
        }
        assert(outside.length === 0, `focus escaped the dialog at steps ${outside.join(',')}`);
        const bgInert = await page.evaluate(() => (document.getElementById('app') as HTMLElement).inert);
        assert(bgInert, 'background #app should be inert while the dialog is open');
        await page.keyboard.press('Escape');
        await page.waitForSelector('[role="dialog"]', { state: 'detached' });
        const restored = await page.evaluate(() => document.activeElement?.textContent?.includes('تعديل'));
        assert(restored, 'focus was not restored to the opener');
        return 'Tab×40 stayed inside; background inert; Esc closed; focus back on "تعديل"';
      });
      await check('intent editor: saves only changed fields as Partial<IntentSpec> (BigInt money)', async () => {
        await show(page, 'editor');
        await page.waitForSelector('[role="dialog"]');
        const amount = page.locator('[role="dialog"] input[inputmode="decimal"]').first();
        await amount.fill('١٬٢٥٠٫٥');
        await page.locator('[role="dialog"] button[type="submit"]').click();
        await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 3000 });
        const saved = await page.evaluate(() => (window as any).__preview.log.filter((e: unknown[]) => e[0] === 'onSave').pop()?.[1]);
        assert(saved && Object.keys(saved).join() === 'price' && saved.price.hi === '125050' && saved.price.lo === null && saved.price.op === 'lte', JSON.stringify(saved));
        return `changes=${JSON.stringify(saved)}`;
      });

      // ── 5b. app.js re-renders on every machine update: identical calls must be no-ops ──
      await check('repeated showQuestion/showReview/showError calls keep focus, countdown and DOM', async () => {
        await show(page, 'asking');
        await page.waitForTimeout(500);
        await page.focus('.q-options .chip-btn');
        const q = await page.evaluate(() => {
          const P = (window as any).__preview;
          const before = document.querySelector('.q-card');
          P.home.setPhase('speaking');
          P.home.showQuestion(P.fixtures.QUESTION, { canAutoListen: true });
          P.home.setPhase('awaiting_answer');
          P.home.showQuestion(P.fixtures.QUESTION, { canAutoListen: true });
          return { same: before === document.querySelector('.q-card'), focus: document.activeElement?.classList.contains('chip-btn') };
        });
        assert(q.same && q.focus, `question re-render: ${JSON.stringify(q)}`);
        await show(page, 'reviewing');
        await page.waitForTimeout(1300);
        const r = await page.evaluate(() => {
          const P = (window as any).__preview;
          const n1 = document.querySelector('.countdown-num')?.textContent;
          P.home.setPhase('reviewing');
          P.home.showReview({ text: P.fixtures.SPOKEN, seconds: 5 });
          return { n1, n2: document.querySelector('.countdown-num')?.textContent };
        });
        assert(r.n1 === r.n2 && r.n1 !== '٥', `countdown restarted: ${JSON.stringify(r)}`);
        await show(page, 'error');
        const e = await page.evaluate(() => {
          const P = (window as any).__preview;
          const before = document.querySelector('.notice-error');
          P.home.setPhase('error');
          P.home.showError('انقطع الاتصال بالخادم أثناء التحليل. ما قلته محفوظ، ويمكنك إعادة المحاولة.');
          return before === document.querySelector('.notice-error');
        });
        assert(e, 'error alert was re-inserted (would be re-announced)');
        return `question kept + focus kept; countdown ${r.n1}→${r.n2}; role=alert not re-inserted`;
      });
      await check('intent list status filter is a radio group and filters', async () => {
        await show(page, 'requests_first');
        const radios = await page.locator('#ul-panel-requests .list-filter input[type="radio"]').count();
        await page.locator('#ul-panel-requests .list-filter label', { hasText: 'تمت تلبيتها' }).click();
        const range = await page.textContent('#ul-panel-requests .pager-range');
        const statuses = await page.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('#ul-panel-requests .intent-card')).map((c) => (c as HTMLElement).dataset.status))));
        assert(radios === 5 && statuses.join() === 'fulfilled', JSON.stringify({ radios, statuses, range }));
        return `5 options; "تمت تلبيتها" → ${range}`;
      });

      // ── 6. toasts use a polite live region ──
      await check('toasts render inside an aria-live="polite" region', async () => {
        await show(page, 'toast');
        const info = await page.evaluate(() => {
          const r = document.querySelector('.toast-region');
          return { live: r?.getAttribute('aria-live'), role: r?.getAttribute('role'), n: r?.querySelectorAll('.toast').length };
        });
        assert(info.live === 'polite' && info.role === 'status' && (info.n ?? 0) >= 1, JSON.stringify(info));
        return JSON.stringify(info);
      });

      // ── 7. state-bound motion: idle has no infinite animation; listening does ──
      await check('ready (idle) has no continuous animation; listening has pulse rings', async () => {
        await show(page, 'ready');
        await page.waitForTimeout(500);
        const idle = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length);
        await show(page, 'listening');
        await page.waitForTimeout(100);
        const listening = await page.evaluate(() => ({
          infinite: document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length,
          name: getComputedStyle(document.querySelector('.mic-pulse') as Element).animationName,
        }));
        assert(idle === 0, `idle infinite animations: ${idle}`);
        assert(listening.infinite >= 3 && listening.name === 'ul-pulse', JSON.stringify(listening));
        await show(page, 'awaiting_answer');
        await page.waitForTimeout(600);
        const awaiting = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length);
        assert(awaiting === 0, `awaiting_answer infinite animations: ${awaiting}`);
        return `idle=0, awaiting_answer=0, listening=${listening.infinite} (${listening.name})`;
      });

      // ── 8. contrast ──
      await check('text contrast ≥ 4.5:1 (body + key components)', async () => {
        await show(page, 'results');
        await page.waitForTimeout(900);
        const rows = await page.evaluate(() => {
          const parse = (c: string): number[] => {
            const m = c.match(/rgba?\(([^)]+)\)/);
            if (!m) return [0, 0, 0, 0];
            const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
            return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
          };
          const lum = ([r, g, b]: number[]) => {
            const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          };
          const over = (top: number[], bottom: number[]) => {
            const a = top[3];
            return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
          };
          const bgOf = (el: Element | null): number[] => {
            const stack: number[][] = [];
            for (let n = el; n; n = n.parentElement) stack.push(parse(getComputedStyle(n).backgroundColor));
            let c = parse(getComputedStyle(document.documentElement).backgroundColor);
            if (c[3] === 0) c = [255, 255, 255, 1];
            for (let i = stack.length - 1; i >= 0; i -= 1) if (stack[i][3] > 0) c = over(stack[i], c);
            return c;
          };
          const ratio = (el: Element) => {
            const bg = bgOf(el);
            const fg = over(parse(getComputedStyle(el).color), bg);
            const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
            return (a + 0.05) / (b + 0.05);
          };
          const targets: [string, string][] = [
            ['body text', 'body'], ['status label', '.phase-label'], ['hint (muted)', '.phase-hint'],
            ['brand', '.brand-name'], ['tab (inactive)', '.tab[aria-selected="false"] .tab-label'], ['tab (active)', '.tab[aria-selected="true"] .tab-label'],
            ['AI badge', '.badge-ai .badge-text'], ['realm badge', '.badge-realm .badge-text'], ['unread counter', '.tab-count[data-kind="unread"]'],
            ['card title', '.match-card .card-title'], ['fact text', '.match-card .fact dd'], ['reason text', '.reason-text'],
            ['state badge confirmed', '.state-confirmed'], ['state badge possible', '.state-possible'], ['chip value', '.chip-value'], ['chip label', '.chip-label'],
            ['exclusion text', '.exclusions p'], ['suggestion', '.suggestion'], ['primary button', '.btn-primary'], ['composer placeholder host', '.composer-input'],
            ['contact hint', '.contact-hint'], ['counterpart note', '.counterpart-note'],
          ];
          return targets.map(([label, sel]) => {
            const el = document.querySelector(sel);
            return el ? { label, ratio: Math.round(ratio(el) * 100) / 100 } : { label, ratio: -1 };
          });
        });
        const bad = rows.filter((r) => r.ratio !== -1 && r.ratio < 4.5);
        const missing = rows.filter((r) => r.ratio === -1).map((r) => r.label);
        assert(bad.length === 0, `low contrast: ${JSON.stringify(bad)}`);
        assert(rows[0].ratio >= 4.5, 'body contrast missing');
        return rows.filter((r) => r.ratio !== -1).map((r) => `${r.label} ${r.ratio}`).join('; ') + (missing.length ? ` (not on screen: ${missing.join(', ')})` : '');
      });
      await check('visible focus ring on mic and tabs', async () => {
        await show(page, 'ready');
        await page.focus('#ul-tab-home');
        await page.keyboard.press('Tab'); // leaves tablist (roving) → next focusable
        const mic = await page.evaluate(() => {
          (document.querySelector('.mic') as HTMLElement).focus();
          const cs = getComputedStyle(document.querySelector('.mic') as Element);
          return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
        });
        assert(mic.style === 'solid' && parseFloat(mic.width) >= 2, JSON.stringify(mic));
        return `mic outline ${mic.width} ${mic.style} ${mic.color}`;
      });
      await ctx.close();
    }

    // ── 9. prefers-reduced-motion ──
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      const page = await openPreview(ctx, base);
      await check('prefers-reduced-motion: listening pulse disabled, no infinite animations in any phase', async () => {
        const perPhase: string[] = [];
        for (const st of ['listening', 'processing', 'speaking', 'searching', 'saving', 'results']) {
          await show(page, st);
          await page.waitForTimeout(200);
          const r = await page.evaluate(() => ({
            infinite: document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length,
            pulse: getComputedStyle(document.querySelector('.mic-pulse') as Element).animationName,
            pulseOpacity: getComputedStyle(document.querySelector('.mic-pulse') as Element).opacity,
            moving: document.getAnimations().filter((a) => {
              const kf = (a.effect as KeyframeEffect | null)?.getKeyframes?.() || [];
              return kf.some((k) => 'transform' in k);
            }).length,
          }));
          perPhase.push(`${st}: infinite=${r.infinite} transformAnims=${r.moving}`);
          assert(r.infinite === 0, `${st}: ${r.infinite} infinite animations under reduced motion`);
          assert(r.moving === 0, `${st}: ${r.moving} transform animations under reduced motion`);
          if (st === 'listening') assert(r.pulse === 'none' && Number(r.pulseOpacity) > 0, `listening pulse should be static & visible: ${JSON.stringify(r)}`);
        }
        await show(page, 'listening');
        await page.screenshot({ path: path.join(OUT, '390x844-listening-reduced-motion.png') });
        return perPhase.join('; ');
      });
      await ctx.close();
    }

    await check('no JS errors in the preview', async () => {
      assert(pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
    });
  } finally {
    await browser.close();
    server.close();
  }

  const shots = (await readdir(OUT)).filter((f) => f.endsWith('.png')).sort();
  console.log(`\nScreenshots (${shots.length}) in ${path.relative(process.cwd(), OUT) || OUT}:`);
  for (const s of shots) console.log(`  ${s}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exitCode = 1;
});
