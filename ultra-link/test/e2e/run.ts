// Runs every browser E2E spec, one after the other, and prints one summary table.
//   npm run test:e2e        (= node test/e2e/run.ts)
//   E2E_ONLY=app-scenarios,app-a11y node test/e2e/run.ts      run a subset (substring match on the spec name)
//   E2E_VIEWPORTS=desktop|390|360                               narrows app-scenarios.spec.ts
//
// Never touches the live demo on :8080: the app specs start their own isolated stacks (fresh DB + seed + server +
// worker, see app-lib.ts), and integration-voice.spec.ts — which needs a running app — is pointed at an isolated
// stack started here and torn down afterwards. ui-preview / voice-harness serve public/ with their own static server.
//
// Honesty labels: voice specs drive a MOCK Web Speech API inside Chromium. They are SIMULATED voice, not a test
// with a human voice or a real recognizer. The app specs use typed text and quick-answer chips only.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, startStack, type Stack } from './app-lib.ts';

interface Spec { name: string; file: string; kind: string; needsStack?: boolean; summary: RegExp }
const SPECS: Spec[] = [
  { name: 'ui-preview', file: 'test/e2e/ui-preview.spec.ts', kind: 'UI views with fake data (no server)', summary: /^\d+\/\d+ checks passed/m },
  { name: 'voice-harness', file: 'test/e2e/voice-harness.spec.ts', kind: 'SIMULATED voice (mock Web Speech API), harness page', summary: /SIMULATED VOICE TESTS:.*$/m },
  { name: 'app-scenarios', file: 'test/e2e/app-scenarios.spec.ts', kind: 'real app, 6 README scenarios, 3 viewports (typed text + chips)', summary: /^ \d+\/\d+ scenario runs passed.*$/m },
  { name: 'app-a11y', file: 'test/e2e/app-a11y.spec.ts', kind: 'real app: keyboard, focus, mobile layout, contrast, reduced motion', summary: /^ \d+\/\d+ scenario runs passed.*$/m },
  { name: 'connections', file: 'test/e2e/connections.spec.ts', kind: 'real app, two browsers: contact → chat, phone/location sharing, recovery', summary: /\d+\/\d+ scenario runs passed.*$/m },
  { name: 'catalog', file: 'test/e2e/catalog.spec.ts', kind: 'real app: «متجري», bulk import preview/confirm, photos, 3 viewports', summary: /\d+\/\d+ scenario runs passed.*$/m },
  { name: 'integration-voice', file: 'test/e2e/integration-voice.spec.ts', kind: 'SIMULATED voice against the real app (isolated stack)', needsStack: true, summary: /(all checks passed.*|\d+ check\(s\) FAILED)$/m },
];

const LOG_DIR = path.join(ROOT, 'test/e2e/artifacts/run');
mkdirSync(LOG_DIR, { recursive: true });

const only = process.env.E2E_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
const selected = only?.length ? SPECS.filter((s) => only.some((o) => s.name.includes(o))) : SPECS;

let current: ReturnType<typeof spawn> | null = null;
let stack: Stack | null = null;
const cleanup = async () => {
  try { current?.kill('SIGTERM'); } catch { /* gone */ }
  if (stack) { const s = stack; stack = null; await s.stop().catch(() => {}); }
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void cleanup().finally(() => process.exit(130)); });

function runSpec(spec: Spec, args: string[]): Promise<{ code: number; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const log = createWriteStream(path.join(LOG_DIR, `${spec.name}.log`));
    let out = '';
    const p = spawn(process.execPath, [spec.file, ...args], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    current = p;
    const onData = (b: Buffer) => { const s = b.toString(); out += s; process.stdout.write(s); log.write(s); };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', onData);
    p.on('exit', (code, signal) => { current = null; log.end(); resolve({ code: code ?? (signal ? 1 : 0), out, ms: Date.now() - t0 }); });
  });
}

const rows: { spec: Spec; code: number; summary: string; ms: number }[] = [];
const t0 = Date.now();
for (const spec of selected) {
  console.log(`\n${'#'.repeat(110)}\n# ${spec.name} — ${spec.kind}\n# node ${spec.file}\n${'#'.repeat(110)}`);
  const args: string[] = [];
  if (spec.needsStack) {
    try {
      stack = await startStack('e2e_run_intvoice');
      console.log(`# isolated stack for ${spec.name}: ${stack.base} (db ${stack.dbName})`);
      args.push(stack.base);
    } catch (e) {
      rows.push({ spec, code: 1, summary: `stack failed: ${(e as Error).message}`, ms: 0 });
      continue;
    }
  }
  const r = await runSpec(spec, args);
  if (stack) { const s = stack; stack = null; await s.stop(); }
  const m = spec.summary.exec(r.out);
  rows.push({ spec, code: r.code, summary: (m?.[0] ?? '(no summary line found)').trim(), ms: r.ms });
}

console.log(`\n${'='.repeat(110)}\n E2E SUMMARY (${Math.round((Date.now() - t0) / 1000)} s) — Chromium ${process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium'}, playwright-core\n${'='.repeat(110)}`);
for (const r of rows) {
  console.log(` ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.spec.name.padEnd(18)} ${String(Math.round(r.ms / 1000)).padStart(4)} s  ${r.summary}`);
  console.log(`        ${r.spec.kind}`);
}
console.log(`\n Voice: every voice check above is SIMULATED (mock SpeechRecognition / speechSynthesis in Chromium).`);
console.log(' It proves wiring, timing and half-duplex ordering — NOT recognition of a human voice. A real-microphone');
console.log(' check by a person (public/js/conversation/README.md §7) is still required.');
console.log(` Logs: ${path.relative(ROOT, LOG_DIR)}/<spec>.log   Screenshots: test/e2e/artifacts/{ui,voice,app,integration-voice}/`);
const failed = rows.filter((r) => r.code !== 0);
console.log(` ${rows.length - failed.length}/${rows.length} specs passed${failed.length ? ` — FAILED: ${failed.map((r) => r.spec.name).join(', ')}` : ''}`);
console.log('='.repeat(110));
await cleanup();
process.exit(failed.length ? 1 : 0);
