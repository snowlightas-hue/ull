// Browser-edition entry: route /api/* to the in-browser backend, provide a local EventSource,
// disable speech RECOGNITION (the published page's frame refuses the microphone), then boot the real app.
import { handle, init, onEvent, resetDemo } from './local-api.ts';

init();

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, initArg?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
  if (!path.startsWith('/api/')) return realFetch(input as RequestInfo, initArg);
  const method = (initArg?.method ?? 'GET').toUpperCase();
  let body: unknown = undefined;
  if (initArg?.body && typeof initArg.body === 'string') { try { body = JSON.parse(initArg.body); } catch { body = undefined; } }
  await new Promise((r) => setTimeout(r, 60)); // keep the UI's state transitions visible, like a real network hop
  const res = await handle(method, path, body);
  return new Response(JSON.stringify(res.json), { status: res.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

class LocalEventSource {
  url: string; readyState = 1; onerror: ((e: unknown) => void) | null = null;
  private handlers = new Map<string, Set<(e: { data: string }) => void>>();
  private off: () => void;
  constructor(url: string) {
    this.url = url;
    this.off = onEvent((type, data) => { for (const h of this.handlers.get(type) ?? []) h({ data: JSON.stringify(data) }); });
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) { const s = this.handlers.get(type) ?? new Set(); s.add(fn); this.handlers.set(type, s); }
  removeEventListener(type: string, fn: (e: { data: string }) => void) { this.handlers.get(type)?.delete(fn); }
  close() { this.off(); this.readyState = 2; }
}
(window as unknown as { EventSource: unknown }).EventSource = LocalEventSource;

// The published page cannot use the microphone; without this the app would show a misleading
// "allow the microphone" error. Typing works; questions are still spoken when an Arabic voice exists.
try {
  Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
} catch { /* ignore */ }

// Demo banner with a data reset (synthetic data lives only in this browser)
function banner() {
  const bar = document.createElement('div');
  bar.className = 'demo-edition-bar';
  bar.setAttribute('role', 'note');
  const text = document.createElement('span');
  text.textContent = 'نسخة تجريبية داخل المتصفح: اكتب طلبك (الميكروفون والموقع غير متاحين في الصفحة المنشورة). بيانات اصطناعية محفوظة على جهازك فقط.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'demo-edition-reset';
  btn.textContent = 'إعادة ضبط البيانات';
  btn.addEventListener('click', () => { resetDemo(); location.reload(); });
  bar.append(text, btn);
  document.body.prepend(bar);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner); else banner();

await import('../public/js/app.js');
