// Browser E2E: the six product scenarios through the REAL UI (login screen → composer/chips → results,
// طلباتي, المطابقات, التنبيهات), on desktop 1280×800 and mobile 390×844 + 360×640, Arabic locale, Syria time.
//
// Each viewport gets its own isolated stack (fresh DB + seeded synthetic personas + server + worker), so
// scenarios never see each other's data across viewports and the live demo on :8080 is never touched.
// Input is typed text and tapped chips — there is NO voice in this spec (voice is covered, SIMULATED, by
// test/e2e/voice-harness.spec.ts).
//
// Run: node test/e2e/app-scenarios.spec.ts      (E2E_VIEWPORTS=desktop|390|360 to narrow)
// Prints PASS/FAIL per check and per scenario; exits non-zero if any check fails.

import type { Page } from 'playwright-core';
import {
  installQuestionRecorder, horizontalOverflow, latin, launch, loginAs, newContext, openTab, press, printSummary, runScenario,
  selectedViewports, shot, sleep, startStack, typeAndSend, waitPhase, watchNoise, type ScenarioResult, type Viewport,
} from './app-lib.ts';

const SAVED_MSG = 'تم حفظ طلبك، سنخبرك عند ظهور مطابقات مناسبة';
const results: ScenarioResult[] = [];

const ASKING = ['asking', 'speaking', 'awaiting_answer'];
const DONE = ['results', 'saved_no_results', 'error'];

async function rangeText(page: Page): Promise<string> {
  return (await page.locator('.panel-matches .pager-range').textContent())?.trim() ?? '';
}

async function cardIds(page: Page, panel: string): Promise<string[]> {
  return page.$$eval(`${panel} .match-card`, (els) => els.map((e) => (e as HTMLElement).dataset.id ?? ''));
}

async function cardScores(page: Page, panel: string): Promise<number[]> {
  const txt = await page.$$eval(`${panel} .match-card .score`, (els) => els.map((e) => e.textContent ?? ''));
  return txt.map((t) => Number(latin(t).replace(/[^0-9.]/g, '')));
}

/** Answer clarifying questions with the first quick-answer chip until the flow finishes (max n). */
async function answerWithChips(page: Page, mobile: boolean, max = 3): Promise<string[]> {
  const asked: string[] = [];
  for (let i = 0; i < max; i++) {
    const phase = await waitPhase(page, [...ASKING, ...DONE], 20_000);
    if (!ASKING.includes(phase)) return asked;
    const card = page.locator('.q-card').first();
    const field = (await card.getAttribute('data-field')) ?? '?';
    asked.push(field);
    const chip = card.locator('.q-options .chip-btn').first();
    if (!(await chip.count())) throw new Error(`question "${field}" has no quick-answer chip`);
    await press(chip, mobile);
    await page.waitForFunction((f) => {
      const p = document.querySelector('.home')?.getAttribute('data-phase');
      const c = document.querySelector('.q-card') as HTMLElement | null;
      return p === 'processing' || p === 'saving' || p === 'searching' || ['results', 'saved_no_results', 'error'].includes(p ?? '') || (c && c.dataset.field !== f);
    }, field, { timeout: 20_000 });
  }
  return asked;
}

async function runViewport(vp: Viewport): Promise<void> {
  console.log(`\n${'-'.repeat(100)}\n Viewport ${vp.name}: starting isolated stack…`);
  const stack = await startStack(`e2e_app_${vp.name.replace(/[^a-z0-9]/gi, '_')}`);
  console.log(` stack up at ${stack.base} (db ${stack.dbName})`);
  const browser = await launch();
  const m = vp.mobile;
  try {
    // ═══════════════ huda: (f) browse > 100 results, then (b) saved request gets a match later ═══════════════
    {
      const ctx = await newContext(browser, vp);
      const page = await ctx.newPage();
      const noise = watchNoise(page);
      await runScenario(results, '(f) browse 250 results, paginate', vp.name, page, async (s) => {
        await loginAs(page, stack.base, 'هدى', m);
        await installQuestionRecorder(page);
        await typeAndSend(page, 'بدي سيارة بحلب');
        const asked = await answerWithChips(page, m);
        s.check('asked exactly one question (deal) and answered it with the chip «شراء»', asked.length === 1 && asked[0] === 'deal', asked);
        const phase = await waitPhase(page, DONE, 20_000);
        s.check('reaches results', phase === 'results', phase);
        const title = (await page.locator('.results-title').textContent()) ?? '';
        s.check('results title counts 250 matches', latin(title).includes('250'), title);
        await shot(page, vp.name, 'f1-results');
        const more = page.getByRole('button', { name: /عرض كل المطابقات/ });
        s.check('"show all matches" button shows the exact total (٢٥٠)', latin((await more.textContent()) ?? '').includes('250'), await more.textContent());
        await press(more, m);
        await page.waitForSelector('.panel-matches .pager-range');
        const seen = new Map<string, number>();
        const pages: string[][] = [];
        const scores: number[] = [];
        const ranges: string[] = [];
        let dupes = 0;
        let badSize = 0;
        const flipMs: number[] = [];
        for (let p = 1; p <= 13; p++) {
          const r = await rangeText(page);
          ranges.push(r);
          const ids = await cardIds(page, '.panel-matches');
          pages.push(ids);
          scores.push(...(await cardScores(page, '.panel-matches')));
          for (const id of ids) { if (seen.has(id)) dupes++; seen.set(id, p); }
          if (ids.length !== (p < 13 ? 20 : 10)) badSize++;
          if (p === 7) {
            s.check('page 7 range text is «١٢١–١٤٠ من ٢٥٠»', r === '١٢١–١٤٠ من ٢٥٠', r);
            await shot(page, vp.name, 'f2-page7');
          }
          if (p < 13) {
            const next = page.locator('.panel-matches .pager-btn[data-dir=next]');
            const tFlip = Date.now();
            await press(next, m);
            await page.waitForFunction((prev) => document.querySelector('.panel-matches .pager-range')?.textContent?.trim() !== prev, r, { timeout: 10_000 });
            flipMs.push(Date.now() - tFlip);
          }
        }
        s.check('13 pages: 12 × 20 + 1 × 10 cards', badSize === 0, pages.map((x) => x.length));
        s.check('no duplicates across pages', dupes === 0, { dupes });
        s.check('250 distinct matches seen in total', seen.size === 250, seen.size);
        s.check('total stays ٢٥٠ on every page', ranges.every((r) => r.endsWith('من ٢٥٠')), ranges);
        s.check('last page range «٢٤١–٢٥٠ من ٢٥٠»', ranges[12] === '٢٤١–٢٥٠ من ٢٥٠', ranges[12]);
        s.check('ranking is stable: scores never increase across pages', scores.every((x, i) => i === 0 || x <= scores[i - 1]!), scores.slice(0, 5));
        const nextDisabled = await page.locator('.panel-matches .pager-btn[data-dir=next]').getAttribute('aria-disabled');
        s.check('next is disabled on the last page', nextDisabled === 'true', nextDisabled);
        const sorted = [...flipMs].sort((a, b) => a - b);
        console.log(`      perf (measured, not asserted): page flip click→new range median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms over ${sorted.length} flips`);
        await shot(page, vp.name, 'f3-last-page');
        // backwards: the previous pages must be exactly the pages we saw going forward
        for (const back of [12, 11]) {
          const before = await rangeText(page);
          await press(page.locator('.panel-matches .pager-btn[data-dir=prev]'), m);
          await page.waitForFunction((prev) => document.querySelector('.panel-matches .pager-range')?.textContent?.trim() !== prev, before, { timeout: 10_000 });
          const ids = await cardIds(page, '.panel-matches');
          s.check(`prev → page ${back} shows the same 20 matches as before`, JSON.stringify(ids) === JSON.stringify(pages[back - 1]), { got: ids.length });
        }
        const ov = await horizontalOverflow(page);
        s.check('no horizontal page scroll (matches list)', !ov.overflow, ov);
      });

      await runScenario(results, '(b) saved request → match arrives later', vp.name, page, async (s) => {
        await openTab(page, 'الرئيسية', m);
        await typeAndSend(page, 'بدي موتور للبيع بعفرين');
        const asked = await answerWithChips(page, m);
        const phase = await waitPhase(page, DONE, 20_000);
        s.check('request saved with no results yet (saved_no_results)', phase === 'saved_no_results', { phase, asked });
        const saved = ((await page.locator('.saved-title').textContent()) ?? '').trim();
        s.check(`shows «${SAVED_MSG}»`, saved === SAVED_MSG, saved);
        await shot(page, vp.name, 'b1-saved');
        const unreadBefore = Number(latin((await page.locator('.tab-count[data-kind=unread]').textContent()) || '0')) || 0;
        await press(page.getByRole('button', { name: 'اذهب إلى طلباتي' }), m);
        await page.waitForFunction(() => document.querySelector('#ul-tab-requests')?.getAttribute('aria-selected') === 'true');
        const sim = page.getByRole('button', { name: 'محاكاة: وصول عرض مطابق لاحقًا' });
        await sim.waitFor({ timeout: 10_000 });
        s.check('demo simulate button is in طلباتي (synthetic user)', await sim.isVisible());
        await press(sim, m);
        const t0 = Date.now();
        await page.locator('.toast', { hasText: 'أُضيف عرض تجريبي' }).waitFor({ timeout: 5_000 });
        let badgeAt = 0;
        let toastAt = 0;
        while (Date.now() - t0 < 10_000 && (!badgeAt || !toastAt)) {
          const unread = Number(latin((await page.locator('.tab-count[data-kind=unread]').textContent()) || '0')) || 0;
          const hidden = await page.locator('.tab-count[data-kind=unread]').evaluate((e) => (e as HTMLElement).hidden);
          if (!badgeAt && !hidden && unread > unreadBefore) badgeAt = Date.now() - t0;
          if (!toastAt && (await page.locator('.toast', { hasText: 'وصلك تنبيه جديد' }).count())) toastAt = Date.now() - t0;
          await sleep(100);
        }
        s.check('unread badge on «التنبيهات» increments within 10 s', badgeAt > 0, { badgeAtMs: badgeAt || null });
        s.check('live toast «وصلك تنبيه جديد» appears within 10 s', toastAt > 0, { toastAtMs: toastAt || null });
        await shot(page, vp.name, 'b2-toast');
        await openTab(page, 'التنبيهات', m);
        const first = page.locator('.panel-notifications .notif').first();
        await first.waitFor({ timeout: 10_000 });
        const title = ((await first.locator('.notif-title').textContent()) ?? '').trim();
        const body = ((await first.locator('.notif-text').textContent()) ?? '').trim();
        s.check('notification is a new-match notice', /مطابقة جديدة مناسبة/.test(title), title);
        s.check('notification lists the match (offer «…» fits my request «…»)', /دراجة نارية/.test(body) && /محاكاة/.test(body) && /يناسب/.test(body), body);
        s.check('notification is unread', (await first.getAttribute('data-unread')) === 'true');
        await shot(page, vp.name, 'b3-notifications');
        const open = first.locator('.notif-open');
        if (await open.count()) {
          await press(open, m);
          await page.waitForFunction(() => document.querySelector('#ul-tab-matches')?.getAttribute('aria-selected') === 'true');
          const card = page.locator('.panel-matches .match-card', { hasText: 'محاكاة' });
          await card.first().waitFor({ timeout: 10_000 });
          s.check('«عرض» opens المطابقات with the new match visible', await card.first().isVisible());
        } else s.check('notification has an «عرض» action', false);
        const ov = await horizontalOverflow(page);
        s.check('no horizontal page scroll', !ov.overflow, ov);
      });
      s_noise(vp, 'huda', noise);
      await ctx.close();
    }

    // ═══════════════ samer: (a) instant match, then (e) editing invalidates an old match ═══════════════
    {
      const ctx = await newContext(browser, vp);
      const page = await ctx.newPage();
      const noise = watchNoise(page);
      await runScenario(results, '(a) instant match with reasons', vp.name, page, async (s) => {
        await loginAs(page, stack.base, 'سامر', m);
        await installQuestionRecorder(page);
        await typeAndSend(page, 'بدي شقة للإيجار بإعزاز فقط حد أقصى 200 دولار بالشهر، يفضل طابق أول');
        const phase = await waitPhase(page, DONE, 20_000);
        s.check('reaches results immediately', phase === 'results', phase);
        const qlog = await page.evaluate(() => (window as any).__qlog);
        s.check('no clarifying question needed (everything was said)', qlog.length === 0, qlog);
        const cards = page.locator('.results .match-card');
        const n = await cards.count();
        s.check('at least one match card', n >= 1, n);
        // README scenario 1: two confirmed (180 $ first floor on top, then 150 $), four possible (other currency,
        // yearly rent, no price, «للعائلات فقط»), and «استُبعد: ٢ خارج المكان الذي اشترطته، ١ أعلى من حد السعر».
        const byState = await cards.evaluateAll((els) => els.map((e) => ({ state: (e as HTMLElement).dataset.state, title: e.querySelector('.card-title')?.textContent?.trim() ?? '' })));
        const confirmed = byState.filter((c) => c.state === 'confirmed').map((c) => c.title);
        const possible = byState.filter((c) => c.state === 'possible').map((c) => c.title);
        s.check('README: exactly 2 confirmed — 180 $ first floor on top, then 150 $', confirmed.length === 2 && /3 غرف طابق أول/.test(latin(confirmed[0] ?? '')) && /غرفتين/.test(confirmed[1] ?? ''), confirmed);
        s.check('README: exactly 4 possible — TRY, yearly, no price, families only', possible.length === 4
          && [/التركية/, /سنوي/, /بدون سعر/, /للعائلات فقط/].every((re) => possible.some((t) => re.test(t))), possible);
        s.check('confirmed cards are listed before possible ones (ranking)', byState.findIndex((c) => c.state === 'possible') > byState.map((c) => c.state).lastIndexOf('confirmed'), byState.map((c) => c.state));
        const possibleWhy = await page.$$eval('.results .match-card[data-state=possible]', (els) => els.map((e) => [...e.querySelectorAll('.reason')].map((r) => r.textContent ?? '').join(' | ')));
        s.check('every possible card says what is unknown or not comparable', possibleWhy.length === 4 && possibleWhy.every((t) => /(عملة مختلفة|وحدة السعر|غير معروف|يحتاج تأكيد)/.test(t)), possibleWhy);
        const first = cards.first();
        s.check('top match is confirmed («مؤكدة»)', (await first.getAttribute('data-state')) === 'confirmed', await first.getAttribute('data-state'));
        const reasons = await first.locator('.reason').allTextContents();
        s.check('top match explains why: place reason', reasons.some((r) => /إعزاز كما طلبت/.test(r)), reasons);
        s.check('top match explains why: price within the cap', reasons.some((r) => /ضمن حدك/.test(r)), reasons);
        s.check('top match explains the preference (طابق)', reasons.some((r) => /الطابق/.test(r)), reasons);
        const allHaveReasons = await cards.evaluateAll((els) => els.every((e) => e.querySelectorAll('.reason').length >= 2));
        s.check('every match card shows at least two reasons', allHaveReasons);
        // confirmed cards must satisfy the hard constraints that the user said: Azaz only, ≤ 200 USD per month
        const facts = await page.$$eval('.results .match-card[data-state=confirmed]', (els) => els.map((e) => ({
          place: e.querySelector('.counterpart .facts .fact:nth-child(2) dd')?.textContent ?? '',
          price: e.querySelector('.counterpart .facts .fact:nth-child(3) dd')?.textContent ?? '',
        })));
        const bad = facts.filter((f) => !/إعزاز/.test(f.place) || !(Number(latin(f.price).replace(/[^0-9]/g, '')) <= 200) || !/(\$|دولار)/.test(f.price) || !/(شهري|بالشهر)/.test(f.price));
        s.check('every confirmed match is in إعزاز, in USD, monthly, ≤ 200', facts.length > 0 && bad.length === 0, { facts, bad });
        const ex = ((await page.locator('.results .exclusions').textContent()) ?? '').trim();
        s.check('exclusion summary is shown («استُبعد …»)', /استُبعد/.test(ex), ex);
        s.check('README: «٢ خارج المكان الذي اشترطته» and «١ أعلى من حد السعر»', ex.includes('٢ خارج المكان الذي اشترطته') && ex.includes('١ أعلى من حد السعر'), ex);
        // the UI writes "<count> <textAr>" — the server's textAr must therefore not carry the count again
        s.check('exclusion summary does not repeat each count («٢ ٢ خارج…»)', !/([0-9٠-٩]+)\s+\1\s/.test(ex), ex);
        // privacy: no identity before consent (Layla owns the top offer)
        const txt = (await page.locator('.results').textContent()) ?? '';
        s.check('no counterpart identity before contact is accepted', !/ليلى/.test(txt) && !(await page.locator('.results a.phone').count()), { hasLayla: /ليلى/.test(txt) });
        await shot(page, vp.name, 'a1-results');
        await shot(page, vp.name, 'a1-results-full', true);
        // the fixed composer must not hide the last actionable button when scrolled to the bottom
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await sleep(150);
        const overlap = await page.evaluate(() => {
          const comp = document.querySelector('.composer')?.getBoundingClientRect();
          const btns = [...document.querySelectorAll('.results .match-card .card-actions .btn')];
          const last = btns[btns.length - 1]?.getBoundingClientRect();
          if (!comp || !last) return null;
          return { overlaps: last.bottom > comp.top && last.top < comp.bottom, btnBottom: Math.round(last.bottom), composerTop: Math.round(comp.top) };
        });
        s.check('fixed composer does not cover the last «طلب تواصل» button at the bottom of the page', overlap !== null && !overlap.overlaps, overlap);
        const ov = await horizontalOverflow(page);
        s.check('no horizontal page scroll (results)', !ov.overflow, ov);
      });

      await runScenario(results, '(e) edit request invalidates an old match', vp.name, page, async (s) => {
        await openTab(page, 'طلباتي', m);
        const card = page.locator('.panel-requests .intent-card', { hasText: 'شقة للإيجار في إعزاز' }).first();
        await card.waitFor({ timeout: 10_000 });
        const counts = ((await card.locator('.ic-matches').textContent()) ?? '').trim();
        s.check('request card shows its match counts', /مؤكدة/.test(counts), counts);
        await press(card.getByRole('button', { name: 'تعديل' }), m);
        const dialog = page.locator('.sheet[role=dialog]');
        await dialog.waitFor({ timeout: 10_000 });
        await sleep(100);
        s.check('editor opens as a modal dialog and takes focus', await page.evaluate(() => !!document.activeElement?.closest('.sheet[role=dialog]')));
        const amount = dialog.getByLabel('المبلغ', { exact: true });
        const before = await amount.inputValue();
        s.check('editor is prefilled with the current cap (200)', latin(before) === '200', before);
        await shot(page, vp.name, 'e1-editor');
        const ov1 = await horizontalOverflow(page);
        s.check('no horizontal page scroll (editor)', !ov1.overflow, ov1);
        await amount.fill('160');
        await press(dialog.getByRole('button', { name: 'حفظ التعديلات' }), m);
        await dialog.waitFor({ state: 'detached', timeout: 10_000 });
        const toast = page.locator('.toast', { hasText: 'تم التعديل' });
        await toast.first().waitFor({ timeout: 10_000 });
        const toastText = (await toast.first().textContent()) ?? '';
        s.check('save confirms and says how many matches are no longer valid', /لم تعد مطابقة/.test(toastText), toastText);
        await openTab(page, 'المطابقات', m);
        await page.locator('.panel-matches .seg-filter').waitFor({ timeout: 10_000 });
        await press(page.locator('.panel-matches .seg-filter label', { hasText: 'لم تعد مطابقة' }), m);
        const inv = page.locator('.panel-matches .match-card[data-state=invalidated]', { hasText: /شقة (3|٣) غرف طابق أول مفروشة/ });
        await inv.first().waitFor({ timeout: 10_000 });
        const reason = ((await inv.first().locator('.invalid-reason').textContent()) ?? '').trim();
        s.check('the 180 $ match is listed under «لم تعد مطابقة»', await inv.first().isVisible());
        s.check('invalidated match shows why (price above the new cap 160)', /أعلى من/.test(reason) && latin(reason).includes('160'), reason);
        s.check('invalidated match offers no contact button', (await inv.first().locator('.contact .btn').count()) === 0);
        await shot(page, vp.name, 'e2-invalidated');
        await press(page.locator('.panel-matches .seg-filter label', { hasText: /^الكل$/ }), m);
        await page.waitForFunction(() => {
          const body = document.querySelector('.panel-matches .panel-body');
          const checked = (body?.querySelector('.seg-filter input:checked') as HTMLInputElement | null)?.value;
          return checked === 'active' && body?.getAttribute('aria-busy') !== 'true' && !body?.querySelector('.loading')
            && body!.querySelectorAll('.match-card').length > 0 && !body!.querySelector('.match-card[data-state=invalidated]');
        }, null, { timeout: 10_000 });
        const active = await page.locator('.panel-matches .match-card .card-title').allTextContents();
        s.check('active list keeps the 150 $ match and drops the 180 $ one', active.some((t) => /غرفتين طابق ثالث/.test(t)) && !active.some((t) => /3 غرف طابق أول مفروشة/.test(latin(t))), active);
      });
      s_noise(vp, 'samer', noise);
      await ctx.close();
    }

    // ═══════════════ nour: (c) exclusion by a hard condition is visible ═══════════════
    {
      const ctx = await newContext(browser, vp);
      const page = await ctx.newPage();
      const noise = watchNoise(page);
      await runScenario(results, '(c) hard-condition exclusions visible', vp.name, page, async (s) => {
        await loginAs(page, stack.base, 'نور', m);
        await typeAndSend(page, 'بدي شقة للإيجار بعفرين فقط حد أقصى 100 دولار بالشهر');
        const phase = await waitPhase(page, DONE, 20_000);
        s.check('nothing satisfies Afrin-only ≤ 100 $ → saved, no results', phase === 'saved_no_results', phase);
        const ex = ((await page.locator('.saved .exclusions').textContent()) ?? '').trim();
        s.check('exclusions mention offers outside the required place', /خارج المكان/.test(ex), ex);
        s.check('exclusions mention offers above the price cap', /أعلى من حد السعر/.test(ex), ex);
        s.check('exclusion summary does not repeat each count', !/([0-9٠-٩]+)\s+\1\s/.test(ex), ex);
        const sugg = await page.locator('.saved .suggestion').allTextContents();
        s.check('widening is only suggested (not applied): suggestions offered', sugg.length >= 1, sugg);
        s.check('note says the request changes only if the user picks a suggestion', (await page.locator('.saved .suggestions-note').count()) === 1);
        await shot(page, vp.name, 'c1-exclusions');
        await openTab(page, 'المطابقات', m);
        await page.locator('.panel-matches .empty').waitFor({ timeout: 10_000 });
        s.check('no match was created that violates a required condition', (await page.locator('.panel-matches .match-card').count()) === 0);
      });

      // README scenario 3 verbatim: an exact price is a hard condition
      await runScenario(results, '(c) README 3: exact price (بالضبط)', vp.name, page, async (s) => {
        await openTab(page, 'الرئيسية', m);
        await typeAndSend(page, 'بدي شقة للإيجار بإعزاز بسعر 150 دولار بالشهر بالضبط');
        const phase = await waitPhase(page, DONE, 20_000);
        s.check('reaches results', phase === 'results', phase);
        const cards = await page.$$eval('.results .match-card', (els) => els.map((e) => ({
          state: (e as HTMLElement).dataset.state, title: e.querySelector('.card-title')?.textContent?.trim() ?? '',
          reasons: [...e.querySelectorAll('.reason')].map((r) => r.textContent?.trim() ?? ''),
          price: e.querySelector('.counterpart .facts .fact:nth-child(3) dd')?.textContent ?? '',
        })));
        const conf = cards.filter((c) => c.state === 'confirmed');
        s.check('exactly one confirmed match', conf.length === 1, cards.map((c) => `${c.state}: ${c.title}`));
        s.check('it says «السعر مطابق تمامًا: ١٥٠$ بالشهر»', conf[0]?.reasons.some((r) => r.includes('السعر مطابق تمامًا: ١٥٠$ بالشهر')) ?? false, conf[0]?.reasons);
        const ex = ((await page.locator('.results .exclusions').textContent()) ?? '').trim();
        s.check('«استُبعد: ٣ السعر لا يساوي المطلوب بالضبط، ٢ خارج المكان الذي اشترطته»', ex.includes('٣ السعر لا يساوي المطلوب بالضبط') && ex.includes('٢ خارج المكان الذي اشترطته'), ex);
        const other = cards.filter((c) => /التركية|سنوي/.test(c.title));
        s.check('offers in another currency / unit are «محتملة», never «مؤكدة»', other.length === 2 && other.every((c) => c.state === 'possible'), other.map((c) => `${c.state}: ${c.title}`));
        s.check('no confirmed card has a price other than 150 $ monthly', conf.every((c) => latin(c.price).includes('150') && /(شهري|بالشهر)/.test(c.price)), conf.map((c) => c.price));
        await shot(page, vp.name, 'c2-exact-price');
        const ov = await horizontalOverflow(page);
        s.check('no horizontal page scroll', !ov.overflow, ov);
      });
      s_noise(vp, 'nour', noise);
      await ctx.close();
    }

    // ═══════════════ rami: (d) one clarification, answered once, never asked again ═══════════════
    {
      const ctx = await newContext(browser, vp);
      const page = await ctx.newPage();
      const noise = watchNoise(page);
      await runScenario(results, '(d) one clarification, never re-asked', vp.name, page, async (s) => {
        await loginAs(page, stack.base, 'رامي', m);
        await installQuestionRecorder(page);
        await typeAndSend(page, 'بدي شخص يصلّح الغسالة');
        await waitPhase(page, ASKING, 20_000);
        const q = page.locator('.q-card');
        s.check('exactly one question card is shown', (await q.count()) === 1, await q.count());
        s.check('the question asks where (place)', (await q.getAttribute('data-field')) === 'place', await q.locator('.q-text').textContent());
        await shot(page, vp.name, 'd1-question');
        await typeAndSend(page, 'بإعزاز');
        const phase = await waitPhase(page, DONE, 20_000);
        s.check('after the answer: results', phase === 'results', phase);
        const top = ((await page.locator('.results .match-card .card-title').first().textContent()) ?? '').trim();
        s.check('the washing-machine technician in إعزاز is matched', /غسالات/.test(top) && /إعزاز/.test(top), top);
        await sleep(300);
        const qlog = await page.evaluate(() => ({ log: (window as any).__qlog, max: (window as any).__qmaxVisible }));
        const qids = [...new Set(qlog.log.map((x: any) => x.qid))];
        s.check('only one question was ever asked (place:1), never re-asked', qids.length === 1 && qids[0] === 'place:1', qlog.log);
        s.check('never more than one question visible at a time', qlog.max <= 1, qlog.max);
        await shot(page, vp.name, 'd2-results');
        await page.reload();
        await page.waitForSelector('.composer-input');
        await sleep(500);
        s.check('after reload the saved conversation is not re-opened (no question)', (await page.locator('.q-card').count()) === 0);
      });
      s_noise(vp, 'rami', noise);
      await ctx.close();
    }

    // ═══════════════ omar: (g) a pending question survives a reload (draft persistence) ═══════════════
    {
      const ctx = await newContext(browser, vp);
      const page = await ctx.newPage();
      const noise = watchNoise(page);
      await runScenario(results, '(g) pending question survives reload', vp.name, page, async (s) => {
        await loginAs(page, stack.base, 'عمر', m);
        await typeAndSend(page, 'بدي شقة بإعزاز');
        await waitPhase(page, ASKING, 20_000);
        const qid = await page.locator('.q-card').getAttribute('data-qid');
        s.check('asks the deal (rent or buy)', qid === 'deal:1', qid);
        await page.reload();
        await page.locator('.q-card').waitFor({ timeout: 10_000 });
        s.check('same question restored after reload', (await page.locator('.q-card').getAttribute('data-qid')) === 'deal:1');
        const chips = await page.locator('.summary .chip').allTextContents();
        s.check('the understood draft (place) is restored too', chips.some((c) => /إعزاز/.test(c)), chips);
        await press(page.locator('.q-card .chip-btn', { hasText: 'إيجار' }), m);
        const phase = await waitPhase(page, DONE, 20_000);
        s.check('answer after reload completes the same request', phase === 'results', phase);
        const reqCount = await page.evaluate(async () => (await (await fetch('/api/intents?side=requests')).json()).total);
        s.check('exactly one request saved (no duplicate from the reload)', reqCount === 1, reqCount);
      });
      s_noise(vp, 'omar', noise);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await stack.stop();
  }
}

/** Console/page errors per persona session are reported as their own check row. */
function s_noise(vp: Viewport, who: string, noise: { errors: string[]; ignored: string[] }) {
  results.push({
    scenario: `(z) no console/page errors — ${who}`, viewport: vp.name, ok: noise.errors.length === 0, ms: 0,
    checks: [{ name: `no console errors / page errors / failed requests (${noise.ignored.length} expected SSE aborts ignored)`, ok: noise.errors.length === 0, detail: noise.errors.slice(0, 5).join(' || ') || undefined }],
  });
  console.log(`    ${noise.errors.length === 0 ? 'PASS' : 'FAIL'}  [${who}] no console errors${noise.errors.length ? `: ${noise.errors.slice(0, 3).join(' || ')}` : ''}`);
}

const t0 = Date.now();
for (const vp of selectedViewports()) {
  try { await runViewport(vp); } catch (e) {
    results.push({ scenario: '(setup) stack', viewport: vp.name, ok: false, ms: 0, checks: [], error: (e as Error).message });
    console.log(`  FAIL [${vp.name}] setup: ${(e as Error).message}`);
  }
}
const ok = printSummary(`APP E2E — product scenarios through the real UI (${Math.round((Date.now() - t0) / 1000)} s; input = typed text + chips, no voice)`, results);
process.exit(ok ? 0 : 1);
