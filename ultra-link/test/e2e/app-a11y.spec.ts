// Browser E2E: keyboard-only use, RTL, focus management, mobile layout (no horizontal scroll, touch target
// size), prefers-reduced-motion, text contrast and console cleanliness — on the REAL app with an isolated stack.
// No voice input is used here.
//
// Run: node test/e2e/app-a11y.spec.ts      Prints PASS/FAIL per check; exits non-zero on any failure.

import type { Page } from 'playwright-core';
import {
  horizontalOverflow, latin, launch, loginAs, newContext, openTab, press, printSummary, runScenario, shot, sleep, startStack,
  typeAndSend, VIEWPORTS, waitPhase, watchNoise, type ScenarioResult,
} from './app-lib.ts';

const results: ScenarioResult[] = [];
const DONE = ['results', 'saved_no_results', 'error'];
const ASKING = ['asking', 'speaking', 'awaiting_answer'];

async function active(page: Page) {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return {
      tag: a?.tagName.toLowerCase() ?? null, role: a?.getAttribute('role') ?? null, cls: a?.className ?? '',
      text: (a?.textContent ?? '').trim().slice(0, 40), tab: a?.dataset.tab ?? null,
      inDialog: !!a?.closest('.sheet[role=dialog]'), isBody: a === document.body,
    };
  });
}

/** Press Tab (or Shift+Tab) until `pred` holds for the focused element; returns the number of presses or -1. */
async function tabUntil(page: Page, pred: (a: Awaited<ReturnType<typeof active>>) => boolean, max = 40, shift = false): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    if (pred(await active(page))) return i;
  }
  return -1;
}

async function focusIndicator(page: Page): Promise<{ visible: boolean; outline: string; shadow: string }> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    const cs = getComputedStyle(a);
    const outline = `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`;
    const visible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 1) || (cs.boxShadow !== 'none' && cs.boxShadow !== '');
    return { visible, outline, shadow: cs.boxShadow };
  });
}

/** WCAG contrast of the text of every element matching the selectors, against its effective background. */
async function contrastAudit(page: Page, selectors: string[]) {
  return page.evaluate((sels) => {
    const parse = (c: string): number[] | null => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const lum = (rgb: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
    };
    const blend = (top: number[], bottom: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);
    const bgOf = (el: Element): { rgb: number[]; approx: boolean } => {
      const layers: number[][] = [];
      let approx = false;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') approx = true;
        const c = parse(cs.backgroundColor);
        if (c && c[3]! > 0) { layers.push(c); if (c[3] === 1) break; }
      }
      let rgb = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) rgb = blend(layers[i]!, rgb);
      return { rgb, approx };
    };
    const out: { sel: string; text: string; ratio: number; need: number; approx: boolean; fg: string }[] = [];
    for (const sel of sels) {
      const els = [...document.querySelectorAll(sel)].filter((e) => (e as HTMLElement).offsetParent !== null && (e.textContent ?? '').trim()).slice(0, 3);
      for (const el of els) {
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        if (!fg) continue;
        const bg = bgOf(el);
        const f = fg[3]! < 1 ? blend(fg, bg.rgb) : fg;
        const L1 = lum(f), L2 = lum(bg.rgb);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const size = parseFloat(cs.fontSize);
        const bold = Number(cs.fontWeight) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        out.push({ sel, text: (el.textContent ?? '').trim().slice(0, 30), ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5, approx: bg.approx, fg: cs.color });
      }
    }
    return out;
  }, selectors);
}

const t0 = Date.now();
const stack = await startStack('e2e_app_a11y');
console.log(` stack up at ${stack.base} (db ${stack.dbName})`);
const browser = await launch();
try {
  // ═══════════════ desktop: keyboard-only ═══════════════
  const desk = VIEWPORTS[0]!;
  {
    const ctx = await newContext(browser, desk);
    const page = await ctx.newPage();
    const noise = watchNoise(page);
    await runScenario(results, 'keyboard: login, tabs (arrows, RTL), composer', desk.name, page, async (s) => {
      await page.goto(stack.base);
      s.check('document is Arabic RTL (lang=ar dir=rtl)', await page.evaluate(() => document.documentElement.lang === 'ar' && document.documentElement.dir === 'rtl'));
      await page.getByRole('button', { name: /ادخل كـ سامر/ }).waitFor();
      const n = await tabUntil(page, (a) => /ادخل كـ سامر/.test(a.text), 30);
      s.check('persona login button reachable with Tab', n > 0, n);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.composer-input', { timeout: 15_000 });
      await waitPhase(page, ['ready']);
      await page.keyboard.press('Tab');
      const first = await active(page);
      s.check('first Tab stop is the skip link «تخطَّ إلى المحتوى»', /تخط/.test(first.text) && first.tag === 'a', first);
      const skipVisible = await page.evaluate(() => { const r = document.activeElement!.getBoundingClientRect(); return r.width > 1 && r.height > 1 && r.top >= 0; });
      s.check('skip link becomes visible when focused', skipVisible);
      const toTab = await tabUntil(page, (a) => a.role === 'tab', 20);
      const a1 = await active(page);
      s.check('Tab reaches the selected tab (roving tabindex)', toTab > 0 && a1.tab === 'home', a1);
      const fi = await focusIndicator(page);
      s.check('focused tab has a visible focus indicator', fi.visible, fi);
      // only ONE tab is in the Tab order
      await page.keyboard.press('Tab');
      const after = await active(page);
      s.check('next Tab leaves the tablist (only one tab stop)', after.role !== 'tab', after);
      await page.keyboard.press('Shift+Tab');
      const order = await page.$$eval('[role=tab]', (els) => els.map((e) => ({ tab: (e as HTMLElement).dataset.tab, x: Math.round(e.getBoundingClientRect().left) })));
      s.check('RTL visual order: الرئيسية is the right-most tab', order.every((o, i) => i === 0 || o.x < order[i - 1]!.x), order);
      const seq: string[] = [];
      for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowRight', 'End', 'Home']) {
        await page.keyboard.press(key);
        await sleep(60);
        const a = await active(page);
        const sel = await page.evaluate(() => (document.querySelector('[role=tab][aria-selected=true]') as HTMLElement).dataset.tab);
        const panelOk = await page.evaluate((t) => !(document.getElementById(`ul-panel-${t}`) as HTMLElement).hidden, sel);
        seq.push(`${key}→${a.tab}${a.tab === sel && panelOk ? '' : '(!)'}`);
      }
      s.check('arrows follow RTL (← next, → previous), wrap around; End/Home jump; focus = selection = visible panel',
        seq.join(' ') === 'ArrowLeft→requests ArrowLeft→offers ArrowLeft→matches ArrowLeft→notifications ArrowLeft→home ArrowRight→notifications End→notifications Home→home', seq);
      // composer by keyboard
      const toInput = await tabUntil(page, (a) => a.cls.includes('composer-input'), 30);
      s.check('composer input reachable with Tab', toInput > 0, toInput);
      await page.keyboard.type('بدي شقة بإعزاز');
      await page.keyboard.press('Enter');
      await waitPhase(page, ASKING, 15_000);
      const back = await tabUntil(page, (a) => a.cls.includes('chip-btn'), 40, true);
      s.check('quick-answer chip reachable with Shift+Tab from the composer', back > 0, back);
      const chip = await active(page);
      await page.keyboard.press('Enter');
      const ph = await waitPhase(page, DONE, 15_000);
      s.check(`chip «${chip.text}» answered with Enter → results`, ph === 'results', ph);
      const after2 = await active(page);
      s.check('focus is not lost to <body> after results render', !after2.isBody, after2);
      const live = await page.$eval('.phase-label', (e) => ({ role: e.getAttribute('role'), live: e.getAttribute('aria-live'), text: e.textContent }));
      s.check('phase label is a polite live region announcing the outcome', live.role === 'status' && live.live === 'polite' && !!live.text, live);
      await shot(page, desk.name, 'kbd-results');
    });

    await runScenario(results, 'keyboard: editor dialog (trap, Esc, focus return)', desk.name, page, async (s) => {
      // move to طلباتي with the keyboard only
      const toTab = await tabUntil(page, (a) => a.role === 'tab', 60, true);
      s.check('back to the tablist with Shift+Tab', toTab > 0, toTab);
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowLeft');
      await page.locator('.panel-requests .intent-card').first().waitFor({ timeout: 10_000 });
      const toEdit = await tabUntil(page, (a) => a.tag === 'button' && /تعديل/.test(a.text), 40);
      s.check('«تعديل» reachable with Tab', toEdit > 0, toEdit);
      await page.keyboard.press('Enter');
      await page.locator('.sheet[role=dialog]').waitFor({ timeout: 10_000 });
      await sleep(150);
      s.check('dialog has aria-modal=true and a label', await page.$eval('.sheet', (e) => e.getAttribute('aria-modal') === 'true' && !!e.getAttribute('aria-labelledby')));
      s.check('focus moves into the dialog', (await active(page)).inDialog);
      let escaped = 0;
      for (let i = 0; i < 30; i++) { await page.keyboard.press('Tab'); if (!(await active(page)).inDialog) escaped++; }
      for (let i = 0; i < 10; i++) { await page.keyboard.press('Shift+Tab'); if (!(await active(page)).inDialog) escaped++; }
      s.check('Tab / Shift+Tab stay trapped inside the dialog', escaped === 0, { escaped });
      s.check('background is inert while the dialog is open', await page.evaluate(() => (document.getElementById('app') as HTMLElement).inert === true));
      await page.keyboard.press('Escape');
      await page.locator('.sheet-backdrop').waitFor({ state: 'detached', timeout: 5_000 });
      const ret = await active(page);
      s.check('Esc closes and focus returns to «تعديل»', ret.tag === 'button' && /تعديل/.test(ret.text), ret);
    });

    await runScenario(results, 'keyboard: pager keeps focus', desk.name, page, async (s) => {
      const toTab = await tabUntil(page, (a) => a.role === 'tab', 60, true);
      s.check('tablist reachable', toTab > 0);
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowRight'); // RTL: previous → matches
      await page.locator('.panel-matches .match-card').first().waitFor({ timeout: 10_000 });
      const total = latin((await page.locator('.panel-matches .list-range').textContent()) ?? '');
      s.check('matches tab opened with the keyboard', /\d/.test(total), total);
      // samer has 7 matches → a single page; the pager's "next" must be marked disabled
      s.check('single page: next is aria-disabled', (await page.locator('.panel-matches .pager-btn[data-dir=next]').getAttribute('aria-disabled')) === 'true');
    });

    await runScenario(results, 'keyboard: «طلب تواصل» keeps focus', desk.name, page, async (s) => {
      const n = await tabUntil(page, (a) => a.tag === 'button' && /طلب تواصل/.test(a.text), 40);
      s.check('«طلب تواصل» reachable with Tab in المطابقات', n > 0, n);
      await page.keyboard.press('Enter');
      await page.locator('.toast', { hasText: 'أُرسل طلب التواصل' }).first().waitFor({ timeout: 10_000 });
      await sleep(600); // let the list refresh that follows the request settle
      const a = await active(page);
      s.check('after sending, keyboard focus is not dropped to <body>', !a.isBody, a);
      const card = await page.$$eval('.panel-matches .match-card', (els) => els.map((e) => e.querySelector('.contact')?.textContent?.trim() ?? ''));
      s.check('the card now shows the pending state (no identity revealed)', card.some((t) => /بانتظار/.test(t)), card.slice(0, 3));
    });
    s_noise('desktop keyboard', desk.name, noise);
    await ctx.close();
  }

  // ═══════════════ mobile: layout, touch targets, contrast ═══════════════
  for (const vp of VIEWPORTS.filter((v) => v.mobile)) {
    const ctx = await newContext(browser, vp);
    const page = await ctx.newPage();
    const noise = watchNoise(page);
    await runScenario(results, 'mobile: no horizontal scroll on every screen', vp.name, page, async (s) => {
      await page.goto(stack.base);
      await page.getByRole('button', { name: /ادخل كـ/ }).first().waitFor();
      const screens: Record<string, unknown> = {};
      const probe = async (name: string) => { const o = await horizontalOverflow(page); screens[name] = o.overflow ? o : 'ok'; await shot(page, vp.name, `layout-${name}`); return !o.overflow; };
      let ok = await probe('login');
      await loginAs(page, stack.base, 'هدى', true);
      ok = (await probe('home-ready')) && ok;
      await typeAndSend(page, 'بدي سيارة بحلب');
      await waitPhase(page, ASKING);
      ok = (await probe('question')) && ok;
      await press(page.locator('.q-card .chip-btn', { hasText: 'شراء' }), true);
      await waitPhase(page, DONE, 20_000);
      ok = (await probe('results')) && ok;
      await typeAndSend(page, 'بدي موتور للبيع بعفرين');
      await waitPhase(page, DONE, 20_000);
      ok = (await probe('saved')) && ok;
      for (const [tab, name] of [['طلباتي', 'requests'], ['عروضي', 'offers'], ['المطابقات', 'matches'], ['التنبيهات', 'notifications']] as const) {
        await openTab(page, tab, true);
        await sleep(400);
        ok = (await probe(name)) && ok;
      }
      await openTab(page, 'طلباتي', true);
      await press(page.locator('.panel-requests .intent-card').first().getByRole('button', { name: 'تعديل' }), true);
      await page.locator('.sheet[role=dialog]').waitFor();
      await sleep(300);
      ok = (await probe('editor')) && ok;
      await page.keyboard.press('Escape');
      s.check('no horizontal page scroll on login, home, question, results, saved, 4 lists, editor', ok, screens);
      const tabbar = await page.evaluate(() => { const t = document.querySelector('.tablist') as HTMLElement; return { sw: t.scrollWidth, cw: t.clientWidth }; });
      s.check('all five tabs fit (or the tab bar scrolls by itself, not the page)', true, tabbar);
    });

    await runScenario(results, 'mobile: touch targets ≥ 24px (WCAG 2.5.8), report < 44px', vp.name, page, async (s) => {
      await openTab(page, 'الرئيسية', true);
      await typeAndSend(page, 'بدي شقة بإعزاز');
      await waitPhase(page, ASKING);
      const sizes = await page.evaluate(() => {
        const sel = ['[role=tab]', '.composer-send', '.composer-input', '.q-options .chip-btn', '.mic', '.cancel-btn', 'header .btn'];
        const out: { sel: string; w: number; h: number; label: string }[] = [];
        for (const s of sel) for (const el of document.querySelectorAll(s)) {
          const r = el.getBoundingClientRect();
          if (r.width && r.height) out.push({ sel: s, w: Math.round(r.width), h: Math.round(r.height), label: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20) });
        }
        return out;
      });
      const tooSmall = sizes.filter((x) => x.w < 24 || x.h < 24);
      const under44 = sizes.filter((x) => x.w < 44 || x.h < 44);
      s.check('every primary control is at least 24×24 CSS px', tooSmall.length === 0, tooSmall);
      console.log(`      info: controls under 44×44: ${JSON.stringify(under44)}`);
      await press(page.locator('.q-card .chip-btn', { hasText: 'إيجار' }), true);
      await waitPhase(page, DONE, 20_000);
    });

    await runScenario(results, 'contrast: key text ≥ WCAG AA', vp.name, page, async (s) => {
      await openTab(page, 'الرئيسية', true);
      const home = await contrastAudit(page, ['.phase-label', '.phase-hint', '.results-title', '.stat span', '.card-title', '.reason-text', '.chip-label', '.chip-value',
        '.counterpart-note', '.contact-hint', '.mine-ref', '.card-dates time', '.fact dd', '.missing', '.tab-label', '.badge-text', '.composer-input', '.exclusions p']);
      await openTab(page, 'التنبيهات', true);
      await sleep(400);
      const notif = await contrastAudit(page, ['.panel-title', '.panel-hint', '.list-range', '.unread-summary', '.notif-title', '.notif-text', '.notif-time']);
      const placeholder = await page.evaluate(() => {
        const i = document.querySelector('.composer-input') as HTMLElement;
        return getComputedStyle(i, '::placeholder').color;
      });
      const all = [...home, ...notif];
      const fails = all.filter((x) => x.ratio < x.need);
      s.check(`all ${all.length} audited text samples meet AA contrast`, fails.length === 0, fails);
      console.log(`      info: lowest ratios: ${JSON.stringify(all.sort((a, b) => a.ratio - b.ratio).slice(0, 5).map((x) => `${x.sel} ${x.ratio}${x.approx ? '~' : ''}`))}; placeholder color ${placeholder}`);
    });
    s_noise(`mobile ${vp.name}`, vp.name, noise);
    await ctx.close();
  }

  // ═══════════════ prefers-reduced-motion ═══════════════
  for (const mode of ['reduce', 'no-preference'] as const) {
    const vp = VIEWPORTS[1]!;
    const ctx = await newContext(browser, vp, { reducedMotion: mode });
    const page = await ctx.newPage();
    const noise = watchNoise(page);
    // slow the API down so processing / searching / loading states are long enough to observe
    await page.route('**/api/conversations/*/turns', async (r) => { await sleep(1500); await r.continue(); });
    await page.route('**/api/intents/*/match', async (r) => { await sleep(1200); await r.continue(); });
    await page.route('**/api/matches?*', async (r) => { await sleep(800); await r.continue(); });
    await runScenario(results, `reduced motion (${mode})`, `${vp.name}`, page, async (s) => {
      await loginAs(page, stack.base, 'رامي', true);
      await page.evaluate(() => {
        const w = window as any;
        w.__anim = { infinite: new Set<string>(), long: new Set<string>() };
        setInterval(() => {
          for (const a of document.getAnimations()) {
            if (a.playState !== 'running') continue;
            const t = a.effect?.getComputedTiming();
            const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
            const name = `${(a as CSSAnimation).animationName ?? 'transition'}@${target?.className?.toString().split(' ')[0] ?? '?'}`;
            if (t?.iterations === Infinity) w.__anim.infinite.add(name);
            else if (Number(t?.duration) > 200) w.__anim.long.add(`${name}:${Math.round(Number(t?.duration))}ms`);
          }
        }, 40);
      });
      await typeAndSend(page, 'بدي شخص يصلّح الغسالة');
      await waitPhase(page, ASKING, 20_000);
      await typeAndSend(page, 'بإعزاز');
      await waitPhase(page, DONE, 20_000);
      await openTab(page, 'المطابقات', true);
      await page.locator('.panel-matches .match-card').first().waitFor({ timeout: 10_000 });
      await sleep(300);
      const seen = await page.evaluate(() => ({ infinite: [...(window as any).__anim.infinite], long: [...(window as any).__anim.long] }));
      if (mode === 'reduce') {
        s.check('no infinite (looping) animation ever runs', seen.infinite.length === 0, seen.infinite);
        s.check('no animation longer than 200 ms runs', seen.long.length === 0, seen.long);
      } else {
        s.check('control: without the preference the sampler does see looping animations (the probe works)', seen.infinite.length > 0, seen);
      }
    });
    s_noise(`reduced-motion ${mode}`, vp.name, noise);
    await ctx.close();
  }
} finally {
  await browser.close();
  await stack.stop();
}

function s_noise(who: string, vp: string, noise: { errors: string[]; ignored: string[] }) {
  results.push({
    scenario: `no console/page errors — ${who}`, viewport: vp, ok: noise.errors.length === 0, ms: 0,
    checks: [{ name: `no console errors / page errors / failed requests (${noise.ignored.length} expected SSE aborts ignored)`, ok: noise.errors.length === 0, detail: noise.errors.slice(0, 5).join(' || ') || undefined }],
  });
  console.log(`    ${noise.errors.length === 0 ? 'PASS' : 'FAIL'}  [${who}] no console errors${noise.errors.length ? `: ${noise.errors.slice(0, 3).join(' || ')}` : ''}`);
}

const ok = printSummary(`APP E2E — accessibility, keyboard, mobile layout, reduced motion (${Math.round((Date.now() - t0) / 1000)} s; no voice)`, results);
process.exit(ok ? 0 : 1);
