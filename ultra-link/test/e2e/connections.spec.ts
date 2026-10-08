// Browser E2E for V2.2 connections («ربط») — two browser contexts chatting on an ISOLATED stack (never :8080).
//   register (recovery code screen) → requests via the API from inside each page → contact → accept (name only) →
//   «فتح المحادثة» (dialog, focus) → live messages both ways over SSE → «شارك رقمي» → live location share (mocked
//   browser geolocation) → stop → Esc returns focus → logout warning → recover with the code → same account.
// The stack: fresh database (freshDb) + buildApp() in this process with the connections/account plugins and a live
// LISTEN connection. Understanding engine: rules only (JEV_MODE=off). Screenshots: test/e2e/artifacts/connections/.
//
// Run: node test/e2e/connections.spec.ts
process.env.JEV_MODE = 'off';
process.env.UL_LOG_LEVEL ??= 'warn';

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { horizontalOverflow, launch, newContext, openTab, press, printSummary, ROOT, runScenario, sleep, VIEWPORTS, watchNoise, type ScenarioResult, type Viewport } from './app-lib.ts';
import { freshDb } from '../helpers/testdb.ts';

const ART = path.join(ROOT, 'test/e2e/artifacts/connections');
mkdirSync(ART, { recursive: true });
const shot = async (page: Page, name: string) => { await sleep(450); await page.screenshot({ path: path.join(ART, `${name}.png`) }).catch(() => {}); }; // after sheet/toast entrance

const { buildApp } = await import('../../src/server/app.ts');
const connectionsRoutes = (await import('../../src/server/routes/connections.ts')).default;
const accountRoutes = (await import('../../src/server/routes/account.ts')).default;
const pg = (await import('pg')).default;

const db = await freshDb('e2e_connections');
const app = await buildApp({ pool: db.pool, reg: db.reg, databaseUrl: db.url, version: 'e2e', listen: true, logLevel: 'warn', routes: [connectionsRoutes, accountRoutes], featureRoutes: false });
await app.listen({ port: 0, host: '127.0.0.1' });
const BASE = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
for (let t0 = Date.now(); !app.ul.events.stats.connected; await sleep(20)) if (Date.now() - t0 > 5000) throw new Error('LISTEN not connected');
console.log(`isolated stack: ${BASE} (db ${db.name})`);

const results: ScenarioResult[] = [];
const MOBILE = VIEWPORTS.find((v) => v.name.startsWith('mobile-390'))!;
const DESKTOP = VIEWPORTS.find((v) => v.name.startsWith('desktop'))!;
const NARROW = VIEWPORTS.find((v) => v.name.startsWith('mobile-360'))!;

/** JSON API call from inside the page (same origin, its cookie, CSRF-correct). */
async function call(page: Page, method: string, url: string, body?: unknown): Promise<any> {
  return page.evaluate(async ([m, u, b]) => {
    const r = await fetch(u as string, { method: m as string, headers: m === 'GET' ? {} : { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, url, body]);
}
async function dialogue(page: Page, ...texts: string[]): Promise<any> {
  const conv = (await call(page, 'POST', '/api/conversations')).body.conversation.id;
  let last: any = null;
  for (const text of texts) last = (await call(page, 'POST', `/api/conversations/${conv}/turns`, { text, modality: 'text', clientTurnId: crypto.randomUUID() })).body;
  return last;
}

async function registerThroughUi(page: Page, vp: Viewport, name: string, phone: string | null, s: { check: (n: string, ok: boolean, d?: unknown) => boolean }, tag: string): Promise<string> {
  await page.goto(BASE);
  await page.locator('#reg-name').waitFor();
  await page.locator('#reg-name').fill(name);
  if (phone) await page.locator('#reg-phone').fill(phone);
  await press(page.getByRole('button', { name: 'ابدأ' }), vp.mobile);
  const dlg = page.getByRole('dialog', { name: 'احفظ هذا الرمز' });
  await dlg.waitFor({ timeout: 10_000 });
  const code = (await dlg.locator('.cx-code').textContent())?.trim() ?? '';
  s.check(`${tag}: the recovery code is shown once after registering (4×4)`, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(code), code.replace(/\w/g, '•'));
  const cont = dlg.getByRole('button', { name: 'حفظته، تابع' });
  s.check(`${tag}: «حفظته، تابع» stays disabled until the user confirms saving it`, await cont.isDisabled());
  s.check(`${tag}: Esc does not dismiss the code screen`, await (async () => { await page.keyboard.press('Escape'); return dlg.isVisible(); })());
  await shot(page, `${vp.name}-${tag}-recovery-code`);
  await press(dlg.getByRole('button', { name: 'نسخ الرمز' }), vp.mobile);
  await dlg.locator('.cx-check').check();
  await press(cont, vp.mobile);
  await page.waitForSelector('.composer-input', { timeout: 15_000 });
  return code;
}

const browser = await launch();
let ctxA: BrowserContext | null = null;
let ctxB: BrowserContext | null = null;
try {
  ctxA = await newContext(browser, MOBILE);
  ctxB = await newContext(browser, DESKTOP);
  await ctxB.grantPermissions(['geolocation'], { origin: BASE });
  await ctxB.setGeolocation({ latitude: 36.58612, longitude: 37.04411, accuracy: 12 });
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  const noiseA = watchNoise(A); const noiseB = watchNoise(B);
  let codeA = '';
  let matchId = '';

  await runScenario(results, 'C1 register shows the recovery code; requests match', 'A:390 + B:1280', A, async (s) => {
    codeA = await registerThroughUi(A, MOBILE, 'أمل', null, s, 'A');
    await registerThroughUi(B, DESKTOP, 'كريم المؤجر', '+90 555 000 0101', s, 'B');
    const ra = await dialogue(A, 'بدي شقة للإيجار بإعزاز حد أقصى 200 دولار بالشهر');
    const rb = await dialogue(B, 'عندي شقة للإيجار بإعزاز بسعر 150 دولار بالشهر');
    s.check('both requests saved', ra?.action === 'saved' && rb?.action === 'saved', [ra?.action, rb?.action]);
    const run = await call(B, 'POST', `/api/intents/${rb.intent.id}/match`);
    matchId = run.body?.page?.items?.[0]?.id ?? '';
    s.check('they match', run.body?.totals?.confirmed === 1, run.body?.totals);
  });

  await runScenario(results, 'C2 contact → accept reveals the name only → «فتح المحادثة»', 'A:390 + B:1280', A, async (s) => {
    await B.reload();
    await B.waitForSelector('.composer-input');
    await openTab(B, 'المطابقات', false);
    const ask = B.getByRole('button', { name: 'طلب تواصل' }).first();
    await ask.waitFor();
    await press(ask, false);
    await B.getByText('بانتظار موافقة الطرف الآخر').first().waitFor();
    await A.reload();
    await A.waitForSelector('.composer-input');
    await openTab(A, 'المطابقات', true);
    const accept = A.getByRole('button', { name: 'قبول', exact: true }).first();
    await accept.waitFor();
    s.check('the accept button no longer says it shares the phone', (await A.getByRole('button', { name: 'قبول ومشاركة رقمي' }).count()) === 0);
    await press(accept, true);
    const openBtn = A.locator('.cx-open-chat').first();
    await openBtn.waitFor({ timeout: 10_000 });
    const card = await A.locator('.match-card').first().innerText();
    s.check('after accept A sees B’s name', card.includes('كريم المؤجر'));
    s.check('…but not B’s phone (needs B’s explicit share)', !card.includes('0101') && card.includes('الرقم يظهر فقط إذا شاركه صاحبه'));
    await shot(A, `${MOBILE.name}-A-accepted-card`);
  });

  await runScenario(results, 'C3 chat dialog: focus, live messages both ways over SSE, read receipts', 'A:390 + B:1280', A, async (s) => {
    const openBtn = A.locator('.cx-open-chat').first();
    await press(openBtn, true);
    const dlgA = A.getByRole('dialog', { name: /المحادثة مع كريم المؤجر/ });
    await dlgA.waitFor();
    s.check('dialog is modal (aria-modal) and labelled', (await dlgA.getAttribute('aria-modal')) === 'true');
    s.check('focus moves into the dialog (its title)', await A.evaluate(() => !!document.activeElement?.closest('[role=dialog]')));
    const input = dlgA.getByLabel('رسالتك');
    await input.fill('مرحبا، الشقة لسا متاحة؟');
    await press(dlgA.getByRole('button', { name: 'إرسال' }), true);
    await dlgA.locator('.cx-mine .cx-text', { hasText: 'الشقة لسا متاحة' }).waitFor();
    // B gets it: open B's chat from the card (the card refreshes on the live event)
    await openTab(B, 'المطابقات', false);
    await B.reload();
    await B.waitForSelector('.composer-input');
    await openTab(B, 'المطابقات', false);
    const bOpen = B.locator('.cx-open-chat').first();
    await bOpen.waitFor({ timeout: 10_000 });
    s.check('B’s card shows an unread badge', (await bOpen.locator('.cx-unread').count()) === 1, await bOpen.innerText());
    await press(bOpen, false);
    const dlgB = B.getByRole('dialog', { name: /المحادثة مع أمل/ });
    await dlgB.locator('.cx-theirs .cx-text', { hasText: 'الشقة لسا متاحة' }).waitFor();
    // B replies with Enter (desktop) → A's OPEN dialog receives it live
    const t0 = Date.now();
    await dlgB.getByLabel('رسالتك').fill('أهلين! إي متاحة، بتحب تشوفها بكرا؟');
    await dlgB.getByLabel('رسالتك').press('Enter');
    await dlgA.locator('.cx-theirs .cx-text', { hasText: 'بتحب تشوفها بكرا' }).waitFor({ timeout: 10_000 });
    s.check('the reply reaches A’s open chat live (SSE) within 10 s', true, { ms: Date.now() - t0 });
    // A had the chat open → it was marked read → B sees the read tick on its first message? (B sees A's read of B's msg)
    await dlgB.locator('.cx-mine .cx-read').first().waitFor({ timeout: 10_000 });
    s.check('B sees «قُرئت» on its message once A has read it', true);
    const over = await horizontalOverflow(A);
    s.check('A (390 px): no horizontal scroll with the chat open', !over.overflow, over);
    await shot(A, `${MOBILE.name}-A-chat`);
    await shot(B, `${DESKTOP.name}-B-chat`);
  });

  await runScenario(results, 'C4 «شارك رقمي» and live location (15 min) — visible only while shared', 'A:390 + B:1280', A, async (s) => {
    const dlgA = A.getByRole('dialog', { name: /المحادثة مع كريم المؤجر/ });
    const dlgB = B.getByRole('dialog', { name: /المحادثة مع أمل/ });
    await press(dlgB.getByRole('button', { name: 'الهاتف والموقع والخيارات' }), false);
    await press(dlgA.getByRole('button', { name: 'الهاتف والموقع والخيارات' }), true);
    s.check('before sharing A sees no phone', !(await dlgA.innerText()).includes('0101'));
    const sw = dlgB.getByRole('switch', { name: 'شارك رقمي' });
    await press(sw, false);
    await dlgB.getByRole('switch', { name: 'شارك رقمي', checked: true }).waitFor();
    await dlgA.locator('.cx-their-phone a[href^="tel:"]').waitFor({ timeout: 10_000 });
    s.check('A sees B’s phone live after B shares it', (await dlgA.locator('.cx-their-phone').innerText()).includes('+90 555 000 0101'));
    // live location from B (Chromium geolocation is mocked at 36.58612, 37.04411)
    await press(dlgB.getByRole('button', { name: '١٥ دقيقة' }), false);
    await dlgB.getByRole('button', { name: 'إيقاف مشاركة موقعي' }).waitFor();
    await dlgA.locator('.cx-coords').waitFor({ timeout: 15_000 });
    s.check('A sees B’s precise position while the share is active', (await dlgA.locator('.cx-coords').innerText()).includes('36.58612, 37.04411'));
    s.check('…with an «افتح في الخريطة» link', (await dlgA.getByRole('link', { name: 'افتح في الخريطة' }).getAttribute('href'))?.includes('mlat=36.586120') ?? false);
    await shot(A, `${MOBILE.name}-A-location`);
    await press(dlgB.getByRole('button', { name: 'إيقاف مشاركة موقعي' }), false);
    await dlgA.locator('.cx-coords').waitFor({ state: 'detached', timeout: 10_000 });
    s.check('after B stops, A no longer sees the position', (await dlgA.locator('.cx-coords').count()) === 0);
    await press(sw, false);
    await dlgA.locator('.cx-their-phone').waitFor({ state: 'detached', timeout: 10_000 });
    s.check('after B unshares, the phone disappears for A', !(await dlgA.innerText()).includes('0101'));
  });

  await runScenario(results, 'C5 Esc closes and returns focus; 360 px layout; touch targets', 'A:390/360', A, async (s) => {
    await A.keyboard.press('Escape');
    await A.getByRole('dialog').waitFor({ state: 'detached' });
    s.check('focus returns to «فتح المحادثة»', await A.evaluate(() => document.activeElement?.classList.contains('cx-open-chat') ?? false));
    await A.setViewportSize({ width: NARROW.width, height: NARROW.height });
    await press(A.locator('.cx-open-chat').first(), true);
    const dlg = A.getByRole('dialog', { name: /المحادثة مع/ });
    await dlg.waitFor();
    await press(dlg.getByRole('button', { name: 'الهاتف والموقع والخيارات' }), true);
    const over = await horizontalOverflow(A);
    s.check('360 px: no horizontal scroll with chat + tools open', !over.overflow, over);
    const small = await A.evaluate(() => [...document.querySelectorAll('[role=dialog] button, [role=dialog] a.btn')]
      .filter((b) => (b as HTMLElement).offsetParent !== null && !b.classList.contains('cx-retry'))
      .map((b) => { const r = b.getBoundingClientRect(); return { t: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((x) => x.h < 44 || x.w < 44));
    s.check('every visible control in the chat is ≥ 44×44 px', small.length === 0, small);
    await shot(A, `${NARROW.name}-A-chat-tools`);
    await A.keyboard.press('Escape');
    await A.setViewportSize({ width: MOBILE.width, height: MOBILE.height });
  });

  await runScenario(results, 'C6 logout warns about the recovery code; recover → same account', 'A:390', A, async (s) => {
    await press(A.getByRole('button', { name: 'خروج' }), true);
    const dlg = A.getByRole('dialog', { name: 'تأكيد الخروج' });
    await dlg.waitFor();
    s.check('the warning mentions the recovery code', (await dlg.innerText()).includes('رمز الاسترداد'));
    await shot(A, `${MOBILE.name}-A-logout-confirm`);
    await press(dlg.getByRole('button', { name: 'خروج', exact: true }), true);
    await A.locator('#reg-name').waitFor({ timeout: 10_000 });
    const codeInput = A.getByRole('textbox', { name: 'رمز الاسترداد' });
    const before = noiseA.errors.length;
    await codeInput.fill('WRONG-CODE-0000-0000');
    await press(A.getByRole('button', { name: 'ارجع إلى حسابي' }), true);
    await A.getByText('رمز الاسترداد غير صحيح').waitFor();
    s.check('a wrong code is refused with a clear message', true);
    // Chromium logs every non-2xx fetch; the deliberate wrong code's 401 is expected, not noise
    const added = noiseA.errors.splice(before);
    noiseA.ignored.push(...added.filter((e) => /status of 401/.test(e)));
    noiseA.errors.push(...added.filter((e) => !/status of 401/.test(e)));
    await codeInput.fill(codeA.toLowerCase());
    await press(A.getByRole('button', { name: 'ارجع إلى حسابي' }), true);
    await A.waitForSelector('.composer-input', { timeout: 15_000 });
    const me = await call(A, 'GET', '/api/me');
    s.check('recovered: same user, same request', me.body?.user?.displayName === 'أمل' && me.body?.counts?.requests === 1, me.body);
    const conns = await call(A, 'GET', '/api/connections');
    s.check('…and the same connection', conns.body?.total === 1);
    await shot(A, `${MOBILE.name}-A-recovered`);
  });

  await runScenario(results, 'C7 console and network clean', 'A+B', null, async (s) => {
    s.check('A: no console errors / failed requests / 5xx', noiseA.errors.length === 0, noiseA.errors);
    s.check('B: no console errors / failed requests / 5xx', noiseB.errors.length === 0, noiseB.errors);
  });
  void matchId;
} finally {
  await ctxA?.close().catch(() => {});
  await ctxB?.close().catch(() => {});
  await browser.close().catch(() => {});
  await app.close().catch(() => {});
  await db.close().catch(() => {});
  const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`).catch(() => {});
  await admin.end();
}

const ok = printSummary('CONNECTIONS E2E — two browser contexts on an isolated stack', results);
console.log(` screenshots: ${path.relative(ROOT, ART)}/`);
process.exit(ok ? 0 : 1);
