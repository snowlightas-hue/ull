// SIMULATED voice test of the REAL app (public/index.html + app.js + server API), not the harness page.
// A mock Web Speech API "speaks" for the user: this proves the app wiring (listen → review → auto-send →
// spoken question → auto-listen → answer to the same conversation → save → search → results) and the
// half-duplex invariant. It is NOT a test with a human voice or a real recognizer.
//
// Usage: node test/e2e/integration-voice.spec.ts <baseUrl>   (normally started by test/e2e/run.ts on an isolated stack)
// The base URL is required on purpose: this spec writes requests, so it must never default to the live demo.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { installMockVoice, type MockCfg } from './mock-voice.ts';

const BASE = process.argv[2];
if (!BASE) {
  console.error('usage: node test/e2e/integration-voice.spec.ts <baseUrl>  (use an isolated stack, e.g. via test/e2e/run.ts)');
  process.exit(2);
}
const OUT = new URL('./artifacts/integration-voice/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// step times are absolute offsets (ms) from recognition.start()
const say = (text: string) => [
  { after: 30, do: 'start' as const },
  { after: 60, do: 'audiostart' as const },
  { after: 300, do: 'interim' as const, text: text.split(' ').slice(0, 2).join(' ') },
  { after: 600, do: 'final' as const, text },
  { after: 700, do: 'end' as const },
];

const cfg: MockCfg = {
  permission: 'granted',
  sessions: [say('بدي شخص يصلّح الغسالة'), say('بإعزاز')],
  speakMsPerChar: 20,
  speakMinMs: 400,
};

let failures = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

console.log('SIMULATED VOICE (mock Web Speech API) against the real app at', BASE);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const vp of [{ w: 390, h: 844, tag: 'mobile' }, { w: 1280, h: 800, tag: 'desktop' }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, locale: 'ar' });
  await ctx.addInitScript(installMockVoice, cfg);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE);
  await page.evaluate(() => fetch('/api/auth/demo-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'rami' }) }));
  await page.reload();
  await page.waitForSelector('.mic');
  await page.waitForTimeout(400);

  await page.locator('button.mic').click();
  await page.waitForSelector('.q-card, .q-text', { timeout: 15_000 });
  const qText = (await page.locator('.q-text').first().textContent())?.trim() ?? '';
  check(qText.includes('وين'), `${vp.tag}: one clarifying question shown after the spoken request («${qText}»)`);
  await page.screenshot({ path: `${OUT}${vp.tag}-question.png` });

  // the app speaks the question, then auto-listens for the answer (second mock session)
  await page.waitForSelector('.results-title, .saved-title', { timeout: 25_000 });
  const title = (await page.locator('.results-title, .saved-title').first().textContent())?.trim();
  check(!!title, `${vp.tag}: request saved and searched → «${title}»`);
  await page.screenshot({ path: `${OUT}${vp.tag}-result.png`, fullPage: true });

  const log = (await page.evaluate(() => (window as any).__mockVoice.log)) as { t: number; type: string }[];
  const violations = (await page.evaluate(() => (window as any).__mockVoice.violations)) as unknown[];
  const synthEnd = log.find((e) => e.type === 'synth.end')?.t;
  const recStarts = log.filter((e) => e.type === 'rec.start').map((e) => e.t);
  check(log.some((e) => e.type === 'synth.speak'), `${vp.tag}: the question was spoken (speechSynthesis.speak called)`);
  check(recStarts.length >= 2, `${vp.tag}: microphone opened twice (request + answer): ${recStarts.length}`);
  check(synthEnd !== undefined && recStarts[1] !== undefined && recStarts[1]! > synthEnd, `${vp.tag}: answer mic opened only after speech ended (Δ=${synthEnd && recStarts[1] ? Math.round(recStarts[1] - synthEnd) : '?'} ms)`);
  check(violations.length === 0, `${vp.tag}: no half-duplex violations (app never records its own voice)`);
  check(errors.length === 0, `${vp.tag}: no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await ctx.close();
}
await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed (SIMULATED voice)');
process.exit(failures ? 1 : 0);
