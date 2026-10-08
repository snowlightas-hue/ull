// Browser E2E for «متجري» (V2.3) through the REAL UI on an isolated stack (fresh DB → seed.ts → seedDemoStores →
// test/e2e/catalog-server.ts with photos in a temp dir). Never touches the live demo on :8080.
//
// Scenarios per viewport (desktop 1280×800, mobile 390×844, 360×640):
//   open «عروضي» → «متجري» (heading focused) → store card «أبو أحمد للموبايلات (تجريبي)» with 25 products, pages «١–٢٠ من ٢٥»
//   → inline price edit → photo upload with progress (PNG) + a renamed text file refused with a clear message
//   → bulk import: paste 5 lines → preview (3 ready, 2 need fixing) → fix the currency of one → «حفظ ٤ منتجات» → 29
//   → pause / resume the store. Checks: no horizontal overflow, no console errors, no leaked null/undefined/NaN,
//   44px touch targets in the store screens, Arabic-Indic digits. Screenshots: test/e2e/artifacts/catalog/.
//
// Run: node test/e2e/catalog.spec.ts   (E2E_VIEWPORTS=desktop|390|360 to narrow)

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { Locator, Page } from 'playwright-core';
import { freshDb } from '../helpers/testdb.ts';
import { loadRegistry } from '../../src/seed/reference.ts';
import { seedDemoStores } from '../../src/seed/stores-demo.ts';
import { horizontalOverflow, latin, launch, loginAs, newContext, openTab, press, printSummary, ROOT, runScenario, selectedViewports, sleep, watchNoise, type ScenarioResult, type Viewport } from './app-lib.ts';
import { plainPng } from '../fixtures/catalog-images.ts';

const ART = path.join(ROOT, 'test/e2e/artifacts/catalog');
mkdirSync(path.join(ART, 'logs'), { recursive: true });
const results: ScenarioResult[] = [];

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, log: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(log, { flags: 'a' });
    const p = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.pipe(out); p.stderr.pipe(out);
    p.on('error', reject); p.on('exit', (c) => resolve(c ?? 1));
  });
}

async function startCatalogStack(tag: string) {
  const db = await freshDb(tag);
  const url = db.url, name = db.name;
  const logs = path.join(ART, 'logs', tag);
  mkdirSync(logs, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, JEV_MODE: 'off', UL_LOG_LEVEL: 'warn' };
  delete env.UL_PIDFILE;
  const code = await run(process.execPath, ['src/seed/seed.ts'], { ...env, DATABASE_URL: url }, path.join(logs, 'seed.log'));
  if (code !== 0) throw new Error(`seed failed (exit ${code}) — see ${logs}/seed.log`);
  const reg = await loadRegistry(db.pool);
  const seeded = await seedDemoStores(db.pool, reg, () => {});
  await db.close();
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'ul-e2e-catalog-'));
  const port = await freePort();
  const out = createWriteStream(path.join(logs, 'server.log'), { flags: 'a' });
  const server: ChildProcess = spawn(process.execPath, ['test/e2e/catalog-server.ts'], { cwd: ROOT, env: { ...env, UL_DATABASE_URL: url, PORT: String(port), UL_MEDIA_DIR: mediaDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout!.pipe(out); server.stderr!.pipe(out);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).status < 600) break; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error(`catalog stack did not start — see ${logs}`);
    await sleep(200);
  }
  return {
    base, seeded,
    stop: async () => {
      await new Promise<void>((r) => { const t = setTimeout(() => { server.kill('SIGKILL'); r(); }, 5000); server.once('exit', () => { clearTimeout(t); r(); }); server.kill('SIGTERM'); });
      rmSync(mediaDir, { recursive: true, force: true });
      const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
      try { await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } catch { /* best effort */ } finally { await a.end().catch(() => {}); }
    },
  };
}

/** press() that survives a re-render between locating and clicking (live updates may refresh the screen). */
async function tap(loc: Locator, mobile: boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await press(loc, mobile); return; } catch (e) {
      if (attempt >= 4 || !/not attached|detached/i.test((e as Error).message)) throw e;
      await sleep(150);
    }
  }
}
const shot = (page: Page, vp: string, name: string, fullPage = false) => page.screenshot({ path: path.join(ART, `${vp}-${name}.png`), fullPage }).catch(() => {});
const text = (page: Page, sel: string) => page.locator(sel).first().textContent().then((t) => (t ?? '').trim());
async function leaked(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const w = document.createTreeWalker(document.querySelector('.st-root') ?? document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (/\b(null|undefined|NaN)\b/.test(n.textContent ?? '')) out.push((n.textContent ?? '').trim().slice(0, 60));
    return out;
  });
}
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('.st-root button, .st-root select, .st-root input:not([type=file]):not([type=checkbox]):not([type=radio]), .st-root .st-check')]
    .filter((e) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 43.5 || r.width < 43.5); })
    .map((e) => `${e.tagName.toLowerCase()}.${(e as HTMLElement).className} ${Math.round((e as HTMLElement).getBoundingClientRect().width)}×${Math.round((e as HTMLElement).getBoundingClientRect().height)}`));
}
async function waitToast(page: Page, re: RegExp, timeout = 15_000) {
  await page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent ?? '')), re.source, { timeout });
}

async function runViewport(vp: Viewport) {
  const tag = `e2e_catalog_${vp.name.replace(/[^a-z0-9]/gi, '_')}`;
  console.log(`\n${'-'.repeat(100)}\n Viewport ${vp.name}: starting isolated stack…`);
  const stack = await startCatalogStack(tag);
  console.log(` stack up at ${stack.base} (${stack.seeded.products} synthetic products)`);
  const browser = await launch();
  const m = vp.mobile;
  try {
    const ctx = await newContext(browser, vp);
    const page = await ctx.newPage();
    const noise = watchNoise(page);
    await runScenario(results, '«متجري»: store, pages, price edit, photos, bulk import, pause', vp.name, page, async (s) => {
      await loginAs(page, stack.base, 'أبو أحمد', m);
      await openTab(page, 'عروضي', m);
      const entry = page.locator('.st-entry');
      await entry.waitFor({ timeout: 15_000 });
      s.check('«متجري» entry card on «عروضي» (no request until opened)', /اعرض محلك كله/.test(await text(page, '.st-entry-sub')), await text(page, '.st-entry-sub'));
      await shot(page, vp.name, '1-offers-entry');
      await tap(page.getByRole('button', { name: 'افتح متجري' }), m);
      await page.locator('.st-store').waitFor();
      s.check('the screen heading «متجري» gets focus', await page.evaluate(() => document.activeElement?.classList.contains('st-title') ?? false));
      s.check('store card: name + «تجريبي» tag + active', (await text(page, '.st-store-name')) === 'أبو أحمد للموبايلات' && (await page.locator('.st-store .demo-tag').count()) === 1 && /نشط/.test(await text(page, '.st-store .status-chip')));
      s.check('exact total and first page «١–٢٠ من ٢٥»', (await text(page, '.st-products .list-range')) === '١–٢٠ من ٢٥', await text(page, '.st-products .list-range'));
      s.check('20 product cards on page 1', (await page.locator('.st-item').count()) === 20);
      s.check('prices in Arabic-Indic digits', /٥٢٠/.test(await text(page, '.st-item .st-price-text')), await text(page, '.st-item .st-price-text'));
      const ov1 = await horizontalOverflow(page);
      s.check('no horizontal overflow (store home)', !ov1.overflow, ov1);
      s.check('touch targets ≥ 44px in the store screen', (await smallTargets(page)).length === 0, await smallTargets(page));
      await shot(page, vp.name, '2-store-home', true);
      await tap(page.locator('.pager-btn[data-dir="next"], .st-products .pager-btn').last(), m);
      await page.waitForFunction(() => document.querySelector('.st-products .list-range')?.textContent?.trim() === '٢١–٢٥ من ٢٥');
      s.check('next page «٢١–٢٥ من ٢٥» (keyset)', (await page.locator('.st-item').count()) === 5);
      await tap(page.locator('.st-products .pager-btn').first(), m);
      await page.waitForFunction(() => document.querySelector('.st-products .list-range')?.textContent?.trim() === '١–٢٠ من ٢٥');

      // inline price edit
      const first = page.locator('.st-item').first();
      await tap(first.getByRole('button', { name: /تعديل سعر/ }), m);
      const amount = first.locator('input.st-amount');
      await amount.waitFor();
      s.check('price editor opens with the amount focused', await amount.evaluate((e) => document.activeElement === e));
      await amount.fill('٤٩٩');
      await tap(first.getByRole('button', { name: 'حفظ السعر' }), m);
      await waitToast(page, /حُدّث السعر/);
      await page.waitForFunction(() => /٤٩٩/.test(document.querySelector('.st-item .st-price-text')?.textContent ?? ''));
      s.check('price updated in place to ٤٩٩$', /٤٩٩\$/.test(await text(page, '.st-item .st-price-text')), await text(page, '.st-item .st-price-text'));
      await shot(page, vp.name, '3-price-edited');

      // photo upload (PNG) with progress → thumbnail
      const item = page.locator('.st-item').first();
      await item.locator('input.st-file').setInputFiles({ name: 'iphone.png', mimeType: 'image/png', buffer: plainPng(96, 96, 4) });
      await page.waitForFunction(() => { const img = document.querySelector('.st-item .st-thumb img') as HTMLImageElement | null; return !!img && img.complete && img.naturalWidth > 0; }, null, { timeout: 15_000 });
      s.check('uploaded photo shows as a thumbnail (decoded by the browser)', true);
      await waitToast(page, /أُضيفت الصورة/);
      // a text file renamed to .jpg → clear error, nothing added
      await page.locator('.st-item').first().locator('input.st-file').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('هذا ملف نصي وليس صورة', 'utf8') });
      await page.locator('.st-item .st-upload-error').first().waitFor({ timeout: 10_000 });
      s.check('renamed text file refused: «الملف ليس صورة JPEG أو PNG أو WebP.»', /ليس صورة JPEG أو PNG أو WebP/.test(await text(page, '.st-upload-error')), await text(page, '.st-upload-error'));
      s.check('still exactly one photo', (await page.locator('.st-item').first().locator('.st-thumb').count()) === 1);
      // too large (client-side check, before any upload)
      await page.locator('.st-item').first().locator('input.st-file').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 10) });
      await page.waitForFunction(() => /أكبر من ٥ ميغابايت/.test(document.querySelector('.st-upload-error')?.textContent ?? ''));
      s.check('a photo over 5 MB gets a clear size message', true);
      await shot(page, vp.name, '4-photo');

      // bulk import
      await tap(page.getByRole('button', { name: 'إضافة منتجات' }), m);
      const area = page.locator('textarea.st-import-text');
      await area.waitFor();
      await area.fill(['شاحن ايفون سريع 12$', 'ماوس لاسلكي للكمبيوتر ٨ دولار', 'كيلو بندورة ٥ ليرات', 'سماعات سامسونج بـ٢٠٠ ليرة', 'ايباد ميني 5 مستعمل 210 دولار'].join('\n'));
      s.check('line counter «٥ سطر من ٢٠٠»', /٥ سطر من ٢٠٠/.test(await text(page, '.st-import .field-hint:not([id$="-hint"])')), await text(page, '.st-import .field-hint:not([id$="-hint"])'));
      await tap(page.getByRole('button', { name: 'معاينة' }), m);
      await page.locator('.st-preview-summary').waitFor();
      const summary = await text(page, '.st-preview-summary');
      s.check('preview: 5 lines, 3 ready, 2 need fixing', /فهمنا ٥ منتجات: ٣ جاهز، و٢ يحتاج تصحيحًا/.test(summary), summary);
      s.check('preview rows: problems listed for «بندورة» (unknown) and «ليرة» (currency)', (await page.locator('.st-prow.has-problems').count()) === 2 && /ما عرفنا نوع المنتج/.test(await text(page, '.st-prow.has-problems .st-problems')));
      const ov2 = await horizontalOverflow(page);
      s.check('no horizontal overflow (preview)', !ov2.overflow, ov2);
      s.check('touch targets ≥ 44px in the preview', (await smallTargets(page)).length === 0, await smallTargets(page));
      await shot(page, vp.name, '5-import-preview', true);
      // fix the lira line: choose «ليرة تركية» (auto-includes it), keep «بندورة» unchecked
      const liraRow = page.locator('.st-prow.has-problems', { hasText: 'سماعات سامسونج' });
      await liraRow.locator('select').nth(1).selectOption('TRY');
      s.check('save button counts 4 products', /حفظ ٤ منتجات/.test(await text(page, '[data-key="confirm"]')), await text(page, '[data-key="confirm"]'));
      await tap(page.locator('[data-key="confirm"]'), m);
      await waitToast(page, /أُضيفت ٤ منتجات/);
      await page.locator('.st-store').waitFor();
      await page.waitForFunction(() => /٢٩/.test(document.querySelector('.st-counts')?.textContent ?? ''));
      s.check('back on the store: ٢٩ منتجًا', /٢٩ منتجًا/.test(await text(page, '.st-counts')), await text(page, '.st-counts'));
      await shot(page, vp.name, '6-after-import');

      // pause / resume the store
      await tap(page.getByRole('button', { name: 'إيقاف المتجر مؤقتًا' }), m);
      await waitToast(page, /أُوقف المتجر مؤقتًا/);
      await page.waitForFunction(() => /موقوف/.test(document.querySelector('.st-store .status-chip')?.textContent ?? ''));
      s.check('store paused: chip + note + every product paused', /موقوف/.test(await text(page, '.st-store .status-chip')) && (await page.locator('.st-store .st-note').count()) === 1 && /٢٩ موقوف/.test(await text(page, '.st-counts')), await text(page, '.st-counts'));
      await shot(page, vp.name, '7-paused');
      await tap(page.getByRole('button', { name: 'استئناف المتجر' }), m);
      await waitToast(page, /استُؤنف المتجر/);
      await page.waitForFunction(() => /نشط/.test(document.querySelector('.st-store .status-chip')?.textContent ?? ''));
      s.check('store resumed', /٢٩ نشط/.test(await text(page, '.st-counts')), await text(page, '.st-counts'));
      s.check('no leaked null/undefined/NaN in the store screens', (await leaked(page)).length === 0, await leaked(page));
      // back to «عروضي»
      await tap(page.locator('.st-back'), m);
      await page.locator('.st-entry').waitFor();
      s.check('«عروضي» list is back; the entry card now names the store and its 29 products', (await page.locator('.st-entry').count()) === 1 && /أبو أحمد للموبايلات \(تجريبي\): ٢٩ منتجًا/.test(await text(page, '.st-entry-sub')), await text(page, '.st-entry-sub'));
      // justified exclusion: Chrome logs the deliberate 415 (the renamed text file above) as a failed resource load
      const errors = noise.errors.filter((e) => !/status of 415 \(Unsupported Media Type\)/.test(e));
      s.check('no console errors / failed requests / 5xx (except the one deliberate 415)', errors.length === 0 && noise.errors.length - errors.length === 1, noise.errors);
    });
    await ctx.close();
  } finally {
    await browser.close();
    await stack.stop();
  }
}

const vps = selectedViewports();
for (const vp of vps) await runViewport(vp);
const ok = printSummary('«متجري» E2E (V2.3 stores & catalog)', results);
console.log(` screenshots: ${path.relative(ROOT, ART)}/`);
process.exit(ok ? 0 : 1);
void latin;
