// Location views (V2.1): the «شارك موقعي المباشر» toggle for offers, connection chips, and the «الأقرب أولًا»
// distance chip on match cards. Plain ES module, no innerHTML, CSP-safe (styles in /css/geo.css).
//
// PRIVACY: nothing here ever renders coordinates. Distances come from the server's reasons (already rounded:
// «أقل من 1 كم», «≈ 2.5 كم») and connection states from card.live.labelAr («متصل الآن», «غير متصل منذ 25 د»).
//
// Wiring (app.js, integrator) — after a list page or the results view is rendered:
//   import { decorateIntentCards, decorateMatchCards, stopAllLiveSharing } from './ui/geo.js';
//   renderIntentPage(el, page, handlers); decorateIntentCards(el, page.items, { api });
//   renderMatchPage(el, page, handlers);  decorateMatchCards(el, page.items);
//   on logout: await stopAllLiveSharing();
// Sharing sessions survive list re-renders (one per intent, kept in this module).

import { h, mount } from './dom.js';
import { ar } from './format.js';
import { icon } from './icons.js';
import { createLiveSharing, LIVE_NOTE_AR } from '../geo/live.js';

/** Offers and activities that are active may share a live position (requests never do). */
export function canShareLive(intent) {
  return !!intent && (intent.side === 'provide' || intent.side === 'join') && intent.status === 'active';
}

/** Connection chip («متصل الآن» / «آخر تحديث قبل 3 د» / «غير متصل منذ 25 د») or null. */
export function liveChip(live) {
  if (!live || !live.labelAr) return null;
  return h('span', { class: ['geo-chip', 'geo-live-chip', live.fresh ? 'is-fresh' : 'is-stale'], dataset: { fresh: String(!!live.fresh) } },
    h('span', { class: 'geo-dot', 'aria-hidden': 'true' }), ar(live.labelAr));
}

/**
 * The rounded distance carried by a match's reasons (code 'distance': «على بعد ≈ 2.5 كم — الموقع تقريبي …»).
 * → { textAr: '≈ 2.5 كم', approximate: boolean } | null
 */
export function distanceFromReasons(reasons) {
  const r = (reasons || []).find((x) => x && x.code === 'distance' && typeof x.text === 'string');
  if (!r) return null;
  const m = /^على بعد (?:حوالي )?(.+?)(?: — (.+))?$/.exec(r.text);
  if (!m) return null;
  const legacy = /^\d+ كم$/.test(m[1]); // place-centroid distance from before V2.1 («على بعد حوالي 17 كم»)
  return { textAr: legacy ? `≈ ${m[1]}` : m[1], approximate: legacy || !!m[2] };
}

/** «الأقرب أولًا · ≈ ٢٫٥ كم» chip for a match card (null when the match has no distance). */
export function distanceChip(match, { nearestFirst = true } = {}) {
  const d = distanceFromReasons(match && match.reasons);
  if (!d) return null;
  const text = `${nearestFirst ? 'الأقرب أولًا · ' : ''}${d.textAr}${d.approximate ? ' (تقريبًا)' : ''}`;
  return h('span', { class: ['geo-chip', 'geo-distance-chip'], title: 'المسافة تقريبية ولا تكشف الموقع الدقيق' }, icon('pin', { size: 14 }), ar(text));
}

// ───────────── live-sharing toggle ─────────────
const sessions = new Map(); // intentId → { sharing, listeners: Set<(status) => void> }

function sessionFor(intentId, api, factory) {
  let s = sessions.get(intentId);
  if (!s) {
    const listeners = new Set();
    const sharing = factory({ api, intentId, onStatus: (st) => { for (const fn of [...listeners]) fn(st); } });
    s = { sharing, listeners };
    sessions.set(intentId, s);
  }
  return s;
}

/**
 * liveToggle(intent, { api, createSharing? }) → <div class="geo-live">
 * A button with aria-pressed, a polite status line and the honest note about the open page.
 */
export function liveToggle(intent, { api, createSharing = createLiveSharing } = {}) {
  const s = sessionFor(intent.id, api, createSharing);
  const btn = h('button', { type: 'button', class: ['btn', 'btn-sm', 'geo-live-btn'], 'aria-pressed': 'false' });
  const line = h('p', { class: 'geo-live-status', role: 'status', 'aria-live': 'polite' });
  const note = h('p', { class: 'geo-live-note' }, LIVE_NOTE_AR);
  const box = h('div', { class: 'geo-live', dataset: { state: 'idle' } }, btn, line, note);
  const paint = (st) => {
    const on = st.state === 'starting' || st.state === 'sharing';
    box.dataset.state = st.state;
    btn.setAttribute('aria-pressed', String(on));
    mount(btn, icon('pin', { size: 16 }), on ? 'أوقف مشاركة موقعي' : 'شارك موقعي المباشر');
    const extra = st.hidden && on ? 'الصفحة في الخلفية — قد يتوقف التحديث حتى تعود إليها' : st.errorAr;
    mount(line, ar(st.labelAr), extra ? h('span', { class: 'geo-live-extra' }, ` — ${ar(extra)}`) : null);
    if (!on && intent.live && intent.live.sharing && st.state === 'idle') {
      // the server still shows a position from an earlier page visit (expires within 10 minutes)
      mount(line, ar(`${intent.live.labelAr} — شغّل المشاركة من جديد لتحديث موقعك`));
    }
  };
  const listener = (st) => { if (!box.isConnected && box.dataset.mounted === '1') { s.listeners.delete(listener); return; } paint(st); };
  s.listeners.add(listener);
  btn.addEventListener('click', async () => {
    box.dataset.mounted = '1';
    btn.disabled = true;
    try {
      const st = s.sharing.status;
      if (st.state === 'starting' || st.state === 'sharing') await s.sharing.stop();
      else await s.sharing.start();
    } finally { btn.disabled = false; }
  });
  paint(s.sharing.status);
  queueMicrotask(() => { box.dataset.mounted = '1'; });
  return box;
}

/** Stop every sharing session started from this page (logout, account switch). */
export async function stopAllLiveSharing() {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.sharing.stop().catch(() => {})));
}

// ───────────── decorators for already-rendered cards (cards carry data-id) ─────────────
const byId = (root, id) => [...root.querySelectorAll('article[data-id]')].find((el) => el.dataset.id === id) || null;

/** Add connection chips to intent cards and the sharing toggle to shareable ones (idempotent per render). */
export function decorateIntentCards(root, items, { api, createSharing } = {}) {
  if (!root || !Array.isArray(items)) return;
  for (const it of items) {
    const card = byId(root, it.id);
    if (!card || card.dataset.geo === '1') continue;
    card.dataset.geo = '1';
    const head = card.querySelector('.card-head');
    const chip = liveChip(it.live);
    if (head && chip) head.append(chip);
    if (api && canShareLive(it)) {
      const toggle = liveToggle(it, { api, createSharing });
      const footer = card.querySelector('.card-actions');
      if (footer) card.insertBefore(toggle, footer); else card.append(toggle);
    }
  }
}

/** Add the «الأقرب أولًا» distance chip and the counterpart's connection chip to match cards. */
export function decorateMatchCards(root, items, { nearestFirst = true } = {}) {
  if (!root || !Array.isArray(items)) return;
  for (const m of items) {
    const card = byId(root, m.id);
    if (!card || card.dataset.geo === '1') continue;
    card.dataset.geo = '1';
    const head = card.querySelector('.card-head');
    if (!head) continue;
    const chips = [distanceChip(m, { nearestFirst }), liveChip(m.other && m.other.live)].filter(Boolean);
    const score = head.querySelector('.score');
    for (const c of chips) { if (score) head.insertBefore(c, score); else head.append(c); }
  }
}
