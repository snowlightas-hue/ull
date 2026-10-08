// «متجري» — stores & catalog (V2.3, docs/CATALOG.md). Store profile, product list (keyset pages, exact totals),
// inline price edit, pause/resume/delete, bulk import (textarea → preview → confirm), photo upload with progress.
// Plain ES module, CSP-safe: DOM only through h()/s(), no innerHTML, inline styles only via the CSSOM (one custom
// property for the upload progress). Styles: /css/store.css. Network: the injected `api` client (JSON) and one
// XMLHttpRequest for photo uploads (fetch has no upload progress).
//
// Wiring (app.js, «عروضي» tab):
//   import { createStoreUi } from './ui/store.js';
//   const storeUi = createStoreUi({ api, toast, onExit: () => loadTab('offers'), onChange: () => refreshCounts() });
//   in loadTab: if (tab === 'offers' && storeUi.isOpen()) return storeUi.refresh();   … after renderIntentPage:
//               if (tab === 'offers') el.prepend(storeUi.entry(el));
// Match lists (integrator): storeGroupLabel(card.store), storeBadge(card), groupMatchesByStore(items), matchPhotos(card).

import { h, s, mount, uid } from './dom.js';
import { icon } from './icons.js';
import { ar, formatCount, formatRange, formatNumber, minorToInput, NOUNS, parseAmountToMinor, toLatinDigits } from './format.js';

const matchesAr = (n) => formatCount(Number(n) || 0, NOUNS.match);
const PRODUCT = { one: 'منتج واحد', two: 'منتجان', few: 'منتجات', many: 'منتجًا', other: 'منتج', zero: 'لا منتجات' };
const PHOTO_MAX = 5 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const CURRENCIES = [['USD', 'دولار'], ['TRY', 'ليرة تركية'], ['SYP', 'ليرة سورية'], ['EUR', 'يورو']];
const RENT_UNITS = [['month', 'بالشهر'], ['day', 'باليوم'], ['week', 'بالأسبوع'], ['year', 'بالسنة']];
const STATUS_AR = { active: 'نشط', paused: 'موقوف', expired: 'منتهي الصلاحية', fulfilled: 'مُباع' };
const FILTERS = [['all', 'الكل'], ['active', 'نشطة'], ['paused', 'موقوفة']];

/** «٣ منتجات» with Arabic agreement and Arabic-Indic digits. */
export function productCount(n) {
  const k = Number(n) || 0;
  if (k === 0) return PRODUCT.zero;
  if (k === 1) return PRODUCT.one;
  if (k === 2) return PRODUCT.two;
  const r = k % 100;
  return `${formatNumber(k)} ${r >= 3 && r <= 10 ? PRODUCT.few : r >= 11 ? PRODUCT.many : PRODUCT.other}`;
}

/** «٣ منتجات من متجر أبو أحمد (تجريبي)» for a MatchCard.store (server field groupLabelAr, digits localised). */
export function storeGroupLabel(store) {
  if (!store) return '';
  return ar(store.groupLabelAr || `${productCount(store.requestMatches || 1)} من ${store.labelAr || store.nameAr || ''}`);
}

/** Small badge for a match card whose counterpart is a store product. */
export function storeBadge(card) {
  const st = card && card.store;
  if (!st) return null;
  return h('p', { class: 'st-badge' }, storeGlyph(16), h('span', null, ar(`من ${st.labelAr}`)), st.synthetic ? h('span', { class: 'demo-tag' }, 'تجريبي') : null);
}

/** Photos of the counterpart product on a match card (only present while the match is live). */
export function matchPhotos(card) {
  const ph = card && card.other && Array.isArray(card.other.photos) ? card.other.photos : [];
  if (!ph.length) return null;
  return h('ul', { class: 'st-thumbs st-thumbs-match', role: 'list', 'aria-label': 'صور المنتج' },
    ph.slice(0, 6).map((p, i) => h('li', null, h('img', { src: p.url, alt: `صورة المنتج ${formatNumber(i + 1)}`, width: p.width, height: p.height, loading: 'lazy', decoding: 'async' }))));
}

/**
 * Group a page of MatchCards: consecutive cards for the same request (mine.id) and the same store become one group.
 * → [{ kind: 'store', store, mineId, items: MatchCard[] } | { kind: 'single', item }]
 */
export function groupMatchesByStore(items) {
  const out = [];
  const byKey = new Map();
  for (const m of items || []) {
    if (m && m.store && m.mine) {
      const key = `${m.mine.id}|${m.store.id}`;
      const g = byKey.get(key);
      if (g) { g.items.push(m); continue; }
      const ng = { kind: 'store', store: m.store, mineId: m.mine.id, items: [m] };
      byKey.set(key, ng);
      out.push(ng);
    } else out.push({ kind: 'single', item: m });
  }
  return out;
}

/**
 * Decorate rendered match cards (lists and home results): store badge + product photos on each card, and a
 * «٣ منتجات من متجر …» heading before the first card of a group (same request, same store). Idempotent.
 */
export function decorateStoreMatches(root, items) {
  if (!root) return;
  const cardOf = (m) => root.querySelector(`[data-id="${CSS.escape(String(m.id))}"]`);
  for (const g of groupMatchesByStore(items)) {
    const list = g.kind === 'store' ? g.items : [g.item];
    for (const m of list) {
      const card = m && cardOf(m);
      if (!card || card.dataset.storeDecorated) continue;
      card.dataset.storeDecorated = '1';
      const title = card.querySelector('.card-title') ?? card.firstElementChild;
      const photos = matchPhotos(m);
      const badge = storeBadge(m);
      if (photos) title?.after(photos);
      if (badge) title?.after(badge);
    }
    if (g.kind === 'store' && g.items.length > 1) {
      const first = cardOf(g.items[0]);
      if (first && !first.previousElementSibling?.classList.contains('st-group-head')) {
        first.before(h('p', { class: 'st-group-head' }, storeGlyph(18), h('span', null, storeGroupLabel(g.store))));
      }
    }
  }
}

function storeGlyph(size = 22) {
  return s('svg', { class: 'icon st-glyph', viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    s('path', { d: 'M4 9.5 5.5 4h13L20 9.5' }), s('path', { d: 'M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0' }),
    s('path', { d: 'M5.5 11.5V20h13v-8.5' }), s('path', { d: 'M10 20v-5h4v5' }));
}

const minorToAmount = (minor) => {
  const v = BigInt(minor);
  const f = v % 100n;
  return `${v / 100n}${f ? '.' + f.toString().padStart(2, '0') : ''}`;
};
const sizeMb = (bytes) => ar((Math.ceil((bytes / 1048576) * 10) / 10).toString().replace('.', '٫')); // rounded UP: «5.0» for 5 MB + 10 bytes would contradict «أكبر من ٥»

/** JSON POST that keeps the whole error body (a 422 import answer carries per-line problems in `lines`). */
export async function postJsonFull(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body ?? {}) });
  } catch {
    throw Object.assign(new Error('network'), { status: 0, code: 'network', messageAr: 'تعذّر الاتصال بالخادم. تحقّق من الشبكة وحاول مجددًا.' });
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw Object.assign(new Error(data?.error ?? 'http'), { status: res.status, code: data?.error ?? `http_${res.status}`, messageAr: data?.messageAr ?? 'حدث خطأ غير متوقع.', lines: data?.lines });
  return data;
}

/** RFC 4122 v4 id for the import's idempotency key (crypto.randomUUID needs a secure context; this does not). */
export function uuid4() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** POST a file with upload progress → {status, body}. Never reads the file; the server decides the real type. */
export function xhrUpload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', PHOTO_TYPES.includes(file.type) ? file.type : 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => { let body = null; try { body = JSON.parse(xhr.responseText); } catch { /* empty */ } resolve({ status: xhr.status, body }); };
    xhr.onerror = () => reject(Object.assign(new Error('network'), { messageAr: 'تعذّر الاتصال بالخادم. تحقّق من الشبكة وحاول مجددًا.' }));
    xhr.send(file);
  });
}

export function createStoreUi({ api, toast = () => {}, onExit = () => {}, onChange = () => {}, upload = xhrUpload, postFull = postJsonFull }) {
  const st = {
    el: null, open: false, screen: 'home', stores: null, storeId: null, taxonomy: null,
    filter: 'all', cursor: null, dir: 'next', page: null, editing: null, uploads: new Map(), formError: '',
    importText: '', importCurrency: '', preview: null, rows: [], importId: null, importError: '', busy: false, seq: 0,
  };
  const store = () => (st.stores || []).find((x) => x.id === st.storeId) || null;
  const notify = (text, kind = 'success') => toast(ar(text), { kind });
  const errText = (e, fallback) => ar((e && e.messageAr) || fallback);

  async function taxonomy() {
    st.taxonomy ??= await api.get('/api/taxonomy');
    return st.taxonomy;
  }
  async function loadStores() {
    const r = await api.get('/api/stores');
    st.stores = r.items;
    if (!st.stores.some((x) => x.id === st.storeId)) st.storeId = st.stores[0]?.id ?? null;
  }
  async function loadItems() {
    const seq = ++st.seq;
    const q = new URLSearchParams({ limit: '20' });
    if (st.filter !== 'all') q.set('status', st.filter);
    if (st.cursor) { q.set('cursor', st.cursor); q.set('dir', st.dir); }
    const page = await api.get(`/api/stores/${st.storeId}/items?${q}`);
    if (seq === st.seq) st.page = page;
  }

  // ───────────── entry card in «عروضي» ─────────────
  function entry(el) {
    st.el = el;
    const titleId = uid('st-entry');
    // no request here: «عروضي» renders often, and the summary below needs none until the store screen was opened once
    const known = st.stores;
    const sub = h('p', { class: 'st-entry-sub' }, known && known.length
      ? ar(known.map((x) => `${x.labelAr}: ${productCount(x.counts.total)}${x.status === 'paused' ? ' (موقوف)' : ''}`).join(' — '))
      : 'اعرض محلك كله: منتجات بأسعارها وصورها، وكل منتج يُطابَق مع من يحتاجه.');
    const btn = h('button', { type: 'button', class: 'btn btn-primary st-entry-btn', onClick: () => open() }, storeGlyph(18), known && !known.length ? 'أنشئ متجرك' : 'افتح متجري');
    return h('section', { class: 'card st-entry', 'aria-labelledby': titleId },
      h('div', { class: 'st-entry-head' }, storeGlyph(), h('h2', { class: 'st-entry-title', id: titleId }, 'متجري')), sub, btn);
  }

  // ───────────── open / refresh / close ─────────────
  async function open(screen = 'home') {
    st.open = true;
    st.screen = screen;
    st.cursor = null;
    if (!st.el) return;
    renderBusy();
    try {
      await Promise.all([loadStores(), taxonomy()]);
      if (!st.stores.length) st.screen = 'form-new';
      else if (st.screen === 'home') await loadItems();
      render({ focusHeading: true });
    } catch (e) { renderError(errText(e, 'تعذّر فتح المتجر')); }
  }
  /** Re-fetch and re-render the store home. Overlapping calls (SSE bursts) coalesce into one extra run; an identical
   *  result is not re-rendered, so focus, open menus and running uploads are left alone. */
  let inflight = null;
  let again = false;
  let lastSig = '';
  async function refresh() {
    if (!st.open || !st.el || st.screen !== 'home') return; // never wipe a form or an import in progress
    if (inflight) { again = true; return inflight; }
    inflight = (async () => {
      do {
        again = false;
        const focus = captureFocus();
        try {
          await loadStores();
          if (st.storeId) await loadItems();
          if (st.screen !== 'home') break;
          const sig = signature();
          if (sig !== lastSig || !st.el.querySelector('.st-store')) { render(); restoreFocus(focus); }
        } catch (e) { renderError(errText(e, 'تعذّر التحميل')); }
      } while (again);
    })().finally(() => { inflight = null; });
    return inflight;
  }
  const signature = () => JSON.stringify([st.storeId, st.stores, st.page, st.editing, st.filter, [...st.uploads]]);
  function close() { st.open = false; st.screen = 'home'; st.preview = null; st.rows = []; onExit(); }

  function captureFocus() {
    const a = document.activeElement;
    return a && st.el && st.el.contains(a) ? a.dataset.key || null : null;
  }
  function restoreFocus(key) {
    if (!key || !st.el) return;
    const t = st.el.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (t) t.focus({ preventScroll: true });
  }

  function renderBusy() { mount(st.el, h('div', { class: 'st-root', 'aria-busy': 'true' }, h('p', { class: 'muted', role: 'status' }, 'جارٍ تحميل متجرك…'))); }
  function renderError(msg) {
    mount(st.el, h('div', { class: 'st-root' }, topBar('متجري'),
      h('div', { class: 'notice notice-error', role: 'alert' }, h('div', { class: 'notice-body' }, h('p', null, msg),
        h('div', { class: 'notice-actions' }, h('button', { type: 'button', class: 'btn btn-primary', dataset: { key: 'retry' }, onClick: () => open(st.screen) }, icon('refresh', { size: 18 }), 'إعادة المحاولة'))))));
  }

  function topBar(title) {
    const hid = uid('st-h');
    return h('div', { class: 'st-top' },
      h('button', { type: 'button', class: 'btn btn-ghost st-back', dataset: { key: 'back' }, onClick: () => (st.screen === 'home' || !st.stores?.length ? close() : (st.screen = 'home', open('home'))) },
        icon('chevronRight', { size: 18 }), st.screen === 'home' || !st.stores?.length ? 'عروضي' : 'متجري'),
      h('h2', { class: 'st-title', id: hid, tabIndex: -1 }, title));
  }

  function render(opts = {}) {
    if (!st.el) return;
    lastSig = signature();
    const view = st.screen === 'form-new' ? storeForm(null) : st.screen === 'form-edit' ? storeForm(store()) : st.screen === 'import' ? importScreen() : homeScreen();
    mount(st.el, view);
    if (opts.focusHeading) st.el.querySelector('.st-title')?.focus({ preventScroll: false });
  }

  // ───────────── home: store card + products ─────────────
  function homeScreen() {
    const s0 = store();
    if (!s0) return h('div', { class: 'st-root' }, topBar('متجري'));
    const switcher = st.stores.length > 1 ? h('div', { class: 'seg seg-filter st-switch', role: 'radiogroup', 'aria-label': 'اختر المتجر' },
      st.stores.map((x) => h('label', null,
        h('input', { type: 'radio', name: 'st-store', value: x.id, checked: x.id === st.storeId, onChange: async () => { st.storeId = x.id; st.cursor = null; await loadItems().catch(() => {}); render(); st.el.querySelector(`input[value="${x.id}"]`)?.focus(); } }),
        h('span', null, ar(x.nameAr))))) : null;
    const c = s0.counts;
    const paused = s0.status === 'paused';
    const toggle = h('button', {
      type: 'button', class: ['btn', 'btn-sm', paused ? 'btn-ok' : null], dataset: { key: 'store-status' },
      onClick: () => run(toggle, async () => {
        const r = await api.post(`/api/stores/${s0.id}/status`, { action: paused ? 'resume' : 'pause' });
        notify(paused ? `استُؤنف المتجر — عادت ${productCount(r.changed)} للمطابقة` : `أُوقف المتجر مؤقتًا — ${productCount(r.changed)} لم تعد تظهر لأحد${r.matching?.invalidated ? ` و${matchesAr(r.matching.invalidated)} أُوقفت` : ''}`);
        onChange();
        await refresh();
      }),
    }, icon(paused ? 'play' : 'pause', { size: 16 }), paused ? 'استئناف المتجر' : 'إيقاف المتجر مؤقتًا');
    const storeCard = h('section', { class: ['card', 'st-store', paused && 'is-paused'], 'aria-label': 'بيانات المتجر' },
      h('div', { class: 'card-head' },
        h('h3', { class: 'card-title st-store-name' }, ar(s0.nameAr)),
        s0.synthetic ? h('span', { class: 'demo-tag' }, 'تجريبي') : null,
        h('span', { class: ['status-chip', paused ? 'status-paused' : 'status-active'] }, paused ? 'موقوف مؤقتًا' : 'نشط')),
      s0.descriptionAr ? h('p', { class: 'st-desc' }, ar(s0.descriptionAr)) : null,
      h('p', { class: 'st-meta' }, icon('pin', { size: 16 }), h('span', null, ar(s0.placeAr || '')),
        s0.hoursAr ? [h('span', { class: 'sep', 'aria-hidden': 'true' }), icon('clock', { size: 16 }), h('span', null, ar(s0.hoursAr))] : null),
      h('p', { class: 'st-counts' }, ar(`${productCount(c.total)}`), c.total ? ar(` — ${formatNumber(c.active)} نشط، ${formatNumber(c.paused)} موقوف`) : null),
      paused ? h('p', { class: 'st-note' }, 'المتجر موقوف: منتجاته لا تظهر لأحد ولا تُطابَق حتى تستأنفه.') : null,
      h('div', { class: 'card-actions' },
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { key: 'import' }, onClick: () => { st.screen = 'import'; st.preview = null; st.rows = []; st.importError = ''; render({ focusHeading: true }); } }, icon('plus', { size: 16 }), 'إضافة منتجات'),
        h('button', { type: 'button', class: 'btn btn-sm', dataset: { key: 'edit-store' }, onClick: () => { st.screen = 'form-edit'; st.formError = ''; render({ focusHeading: true }); } }, icon('edit', { size: 16 }), 'تعديل المتجر'),
        toggle,
        st.stores.length < 5 ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { key: 'new-store' }, onClick: () => { st.screen = 'form-new'; st.formError = ''; render({ focusHeading: true }); } }, 'متجر جديد') : null));
    return h('div', { class: 'st-root' }, topBar('متجري'), switcher, storeCard, productsSection(s0));
  }

  function productsSection(s0) {
    const page = st.page || { items: [], total: 0 };
    const listId = uid('st-list');
    const filter = h('div', { class: 'seg seg-filter', role: 'radiogroup', 'aria-label': 'تصفية المنتجات' },
      FILTERS.map(([v, label]) => h('label', null,
        h('input', { type: 'radio', name: `st-filter-${s0.id}`, value: v, checked: st.filter === v, dataset: { key: `filter-${v}` }, onChange: async () => { st.filter = v; st.cursor = null; await loadItems().catch(() => {}); render(); restoreFocus(`filter-${v}`); } }),
        h('span', null, label))));
    const body = page.items.length
      ? h('ol', { class: 'st-items', id: listId, role: 'list' }, page.items.map((it) => productRow(s0, it)))
      : h('div', { class: 'empty st-empty' }, h('p', { class: 'empty-text' }, st.filter === 'all' ? 'لا منتجات بعد. اضغط «إضافة منتجات» والصق قائمتك: سطر لكل منتج مع سعره.' : 'لا منتجات بهذه الحالة.'));
    return h('section', { class: 'st-products', 'aria-label': 'المنتجات' },
      h('div', { class: 'list-toolbar st-toolbar' }, h('h3', { class: 'st-h3' }, 'المنتجات'), h('p', { class: 'list-range', 'aria-live': 'polite' }, page.total ? formatRange(page.rangeStart, page.rangeEnd, page.total) : ''), filter),
      body, pager(page));
  }

  function pager(page) {
    if (!page.total || (!page.nextCursor && !page.prevCursor)) return null;
    const go = (dir, cursor) => async () => { st.cursor = cursor; st.dir = dir; await loadItems().catch(() => {}); render(); restoreFocus(`page-${dir}`); };
    const btn = (dir, cursor, label, ic) => h('button', { type: 'button', class: 'btn btn-sm pager-btn', dataset: { key: `page-${dir}` }, 'aria-disabled': cursor ? 'false' : 'true', onClick: cursor ? go(dir, cursor) : undefined }, dir === 'prev' ? icon(ic, { size: 18 }) : null, label, dir === 'next' ? icon(ic, { size: 18 }) : null);
    return h('nav', { class: 'pager', 'aria-label': 'صفحات المنتجات' },
      btn('prev', page.prevCursor, 'السابق', 'chevronRight'), h('p', { class: 'pager-range' }, formatRange(page.rangeStart, page.rangeEnd, page.total)), btn('next', page.nextCursor, 'التالي', 'chevronLeft'));
  }

  function productRow(s0, it) {
    const k = it.id;
    const titleId = uid('st-item');
    const statusAr = it.pausedByStore && it.status === 'paused' ? 'موقوف مع المتجر' : STATUS_AR[it.status] || it.status;
    const live = it.status === 'active' || it.status === 'paused';
    const matches = (it.matchCounts?.confirmed || 0) + (it.matchCounts?.possible || 0);
    const chips = [it.categoryAr, it.condition === 'new' ? 'جديد' : it.condition === 'used' ? 'مستعمل' : null, it.deal === 'rent' ? 'للإيجار' : null].filter(Boolean);
    const pauseBtn = live ? h('button', {
      type: 'button', class: 'btn btn-sm', dataset: { key: `${k}:status` },
      'aria-disabled': it.status === 'paused' && s0.status === 'paused' ? 'true' : 'false',
      title: it.status === 'paused' && s0.status === 'paused' ? 'استأنف المتجر أولًا' : undefined,
      onClick: (ev) => {
        if (ev.currentTarget.getAttribute('aria-disabled') === 'true') { notify('المتجر موقوف. استأنف المتجر أولًا.', 'warning'); return; }
        run(ev.currentTarget, () => itemAction(s0, it, it.status === 'active' ? 'pause' : 'resume'));
      },
    }, icon(it.status === 'active' ? 'pause' : 'play', { size: 16 }), it.status === 'active' ? 'إيقاف' : 'تفعيل') : null;
    return h('li', { class: ['card', 'st-item', `is-${it.status}`], dataset: { id: k }, 'aria-labelledby': titleId },
      h('div', { class: 'card-head' },
        h('h4', { class: 'card-title st-item-name', id: titleId }, ar(it.nameAr)),
        h('span', { class: ['status-chip', `status-${it.status}`] }, statusAr)),
      chips.length ? h('ul', { class: 'chips chips-compact', role: 'list' }, chips.map((c) => h('li', { class: 'chip' }, ar(c)))) : null,
      priceBlock(s0, it),
      h('p', { class: 'st-item-matches' }, matches ? ar(`${matchesAr(matches)} مع طلبات الناس`) : 'لا مطابقات حاليًا'),
      photosBlock(s0, it),
      live ? h('div', { class: 'card-actions' }, pauseBtn, deleteButton(s0, it)) : h('div', { class: 'card-actions' }, deleteButton(s0, it)));
  }

  function priceBlock(s0, it) {
    const k = it.id;
    if (st.editing !== k) {
      return h('div', { class: 'st-price' },
        h('p', { class: 'st-price-text' }, icon('money', { size: 18 }), h('span', null, it.priceAr ? ar(it.priceAr) : 'بدون سعر')),
        it.status !== 'closed' ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { key: `${k}:price` }, 'aria-label': `تعديل سعر ${it.nameAr}`, onClick: () => { st.editing = k; render(); restoreFocus(`${k}:amount`); } }, icon('edit', { size: 16 }), 'تعديل السعر') : null);
    }
    const p = it.price || { minor: '0', currency: 'USD', unit: 'total' };
    const aid = uid('st-amount');
    const cid = uid('st-cur');
    const err = h('p', { class: 'field-error', role: 'alert' });
    const amount = h('input', { class: 'input st-amount', id: aid, inputMode: 'decimal', autocomplete: 'off', value: minorToInput(p.minor, p.currency || 'USD'), dataset: { key: `${k}:amount` }, 'aria-describedby': `${aid}-hint` });
    const cur = h('select', { class: 'select', id: cid }, CURRENCIES.map(([v, l]) => h('option', { value: v, selected: v === p.currency }, l)));
    const unit = it.deal === 'rent' ? h('select', { class: 'select', 'aria-label': 'وحدة الإيجار' }, RENT_UNITS.map(([v, l]) => h('option', { value: v, selected: v === p.unit }, l))) : null;
    const save = async () => {
      err.textContent = '';
      const minor = parseAmountToMinor(amount.value, cur.value);
      if (minor === null) { err.textContent = 'اكتب السعر بالأرقام (حتى منزلتين بعد الفاصلة).'; amount.setAttribute('aria-invalid', 'true'); amount.focus(); return; }
      try {
        const body = { expectedVersion: it.version, amount: minorToAmount(minor), currency: cur.value };
        if (unit) body.unit = unit.value;
        const r = await api.patch(`/api/stores/${s0.id}/items/${it.id}`, body);
        st.editing = null;
        const inv = r.matching?.invalidated || 0;
        notify(`حُدّث السعر${inv ? ` — ${matchesAr(inv)} لم تعد مناسبة` : ''}${r.matching?.newMatches ? ` — جديد: ${matchesAr(r.matching.newMatches)}` : ''}`);
        await refresh();
        restoreFocus(`${k}:price`);
      } catch (e) {
        err.textContent = errText(e, 'تعذّر حفظ السعر');
        if (e && e.status === 409) { st.editing = null; await refresh(); }
      }
    };
    return h('form', { class: 'st-price-form', onSubmit: (ev) => { ev.preventDefault(); save(); }, onKeydown: (ev) => { if (ev.key === 'Escape') { st.editing = null; render(); restoreFocus(`${k}:price`); } } },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: aid }, 'السعر'), amount, h('p', { class: 'field-hint', id: `${aid}-hint` }, 'أرقام فقط، مثل ٣٠٠ أو ١٢٫٥')),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: cid }, 'العملة'), cur),
      unit ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'الوحدة'), unit) : null,
      err,
      h('div', { class: 'st-row' },
        h('button', { type: 'submit', class: 'btn btn-primary btn-sm' }, icon('check', { size: 16 }), 'حفظ السعر'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { st.editing = null; render(); restoreFocus(`${k}:price`); } }, 'إلغاء')));
  }

  function photosBlock(s0, it) {
    const k = it.id;
    const up = st.uploads.get(k);
    const photos = it.photos || [];
    const input = h('input', {
      type: 'file', class: 'st-file', accept: PHOTO_TYPES.join(','), tabIndex: -1, 'aria-hidden': 'true',
      onChange: (ev) => { const f = ev.currentTarget.files && ev.currentTarget.files[0]; ev.currentTarget.value = ''; if (f) uploadPhoto(s0, it, f); },
    });
    const canAdd = photos.length < 6 && it.status !== 'closed' && !(up && up.pct !== null);
    return h('div', { class: 'st-photos' },
      photos.length ? h('ul', { class: 'st-thumbs', role: 'list', 'aria-label': `صور ${it.nameAr}` }, photos.map((p, i) => h('li', { class: 'st-thumb' },
        h('img', { src: p.url, alt: `صورة ${formatNumber(i + 1)} من ${it.nameAr}`, width: p.width, height: p.height, loading: 'lazy', decoding: 'async' }),
        h('button', { type: 'button', class: 'st-thumb-del', dataset: { key: `${k}:del-${p.id}` }, 'aria-label': `حذف الصورة ${formatNumber(i + 1)}`,
          onClick: (ev) => run(ev.currentTarget, async () => { await api.post(`/api/stores/${s0.id}/items/${it.id}/photos/${p.id}/delete`, {}); notify('حُذفت الصورة'); await refresh(); restoreFocus(`${k}:add`); }) }, icon('close', { size: 16 }))))) : null,
      up && up.pct !== null ? h('div', { class: 'st-progress-wrap', role: 'status' },
        progressBar(up.pct), h('span', { class: 'st-progress-text' }, ar(`جارٍ رفع الصورة… ${Math.round(up.pct * 100)}٪`))) : null,
      up && up.error ? h('p', { class: 'field-error st-upload-error', role: 'alert' }, ar(up.error)) : null,
      canAdd ? h('button', { type: 'button', class: 'btn btn-sm st-add-photo', dataset: { key: `${k}:add` }, 'aria-label': `إضافة صورة لـ ${it.nameAr}`, onClick: () => input.click() },
        icon('plus', { size: 16 }), photos.length ? `صورة أخرى (${ar(String(photos.length))}/٦)` : 'إضافة صورة') : null,
      input,
      photos.length >= 6 ? h('p', { class: 'field-hint' }, 'وصلت للحد: ٦ صور للمنتج.') : null);
  }

  function progressBar(pct) {
    const bar = h('div', { class: 'st-progress', role: 'progressbar', 'aria-label': 'رفع الصورة', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct * 100)) }, h('span', { class: 'st-progress-fill' }));
    bar.style.setProperty('--pct', `${Math.round(pct * 100)}%`);
    return bar;
  }

  async function uploadPhoto(s0, it, file) {
    const k = it.id;
    if (file.size > PHOTO_MAX) { st.uploads.set(k, { pct: null, error: `الصورة أكبر من ٥ ميغابايت (حجمها ${sizeMb(file.size)} ميغابايت). صغّرها أو اختر صورة أخرى.` }); render(); restoreFocus(`${k}:add`); return; }
    if (file.type && !PHOTO_TYPES.includes(file.type)) { st.uploads.set(k, { pct: null, error: 'نوع الملف غير مدعوم. اختر صورة JPEG أو PNG أو WebP.' }); render(); restoreFocus(`${k}:add`); return; }
    st.uploads.set(k, { pct: 0, error: '' });
    render();
    let last = 0;
    try {
      const r = await upload(`/api/stores/${s0.id}/items/${it.id}/photos`, file, (pct) => {
        const cur = st.uploads.get(k);
        if (!cur || pct - last < 0.05) return;
        last = pct;
        cur.pct = pct;
        const bar = st.el?.querySelector(`[data-id="${CSS.escape(k)}"] .st-progress`);
        if (bar) { bar.style.setProperty('--pct', `${Math.round(pct * 100)}%`); bar.setAttribute('aria-valuenow', String(Math.round(pct * 100))); bar.nextSibling.textContent = ar(`جارٍ رفع الصورة… ${Math.round(pct * 100)}٪`); }
      });
      if (r.status >= 200 && r.status < 300) {
        st.uploads.delete(k);
        notify(r.body?.alreadyAttached ? 'هذه الصورة مضافة أصلًا لهذا المنتج' : 'أُضيفت الصورة (أُزيلت بيانات الموقع والكاميرا منها)');
        await refresh();
        restoreFocus(`${k}:add`);
        return;
      }
      const msg = r.status === 415 ? 'الملف ليس صورة JPEG أو PNG أو WebP.' : r.status === 413 ? 'الصورة أكبر من ٥ ميغابايت.' : r.body?.messageAr || 'تعذّر رفع الصورة.';
      st.uploads.set(k, { pct: null, error: msg });
    } catch (e) {
      st.uploads.set(k, { pct: null, error: errText(e, 'تعذّر رفع الصورة.') });
    }
    render();
    restoreFocus(`${k}:add`);
  }

  function deleteButton(s0, it) {
    let armed = false;
    let timer = 0;
    const label = h('span', null, 'حذف');
    const btn = h('button', { type: 'button', class: 'btn btn-sm btn-danger', dataset: { key: `${it.id}:delete` }, 'aria-label': `حذف ${it.nameAr}` }, icon('close', { size: 16 }), label);
    btn.addEventListener('click', () => {
      if (!armed) { armed = true; btn.dataset.armed = 'true'; label.textContent = 'اضغط مجددًا للحذف'; clearTimeout(timer); timer = setTimeout(disarm, 4000); return; }
      disarm();
      run(btn, () => itemAction(s0, it, 'delete'));
    });
    btn.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== btn) disarm(); }, 150));
    function disarm() { armed = false; clearTimeout(timer); delete btn.dataset.armed; label.textContent = 'حذف'; }
    return btn;
  }

  async function itemAction(s0, it, action) {
    const r = await api.post(`/api/stores/${s0.id}/items/${it.id}/status`, { action });
    const inv = r.matching?.invalidated || 0;
    const msg = { pause: 'أُوقف المنتج مؤقتًا', resume: 'عاد المنتج للمطابقة', delete: 'حُذف المنتج' }[action];
    notify(`${msg}${inv ? ` — ${matchesAr(inv)} لم تعد فعّالة` : ''}${r.matching?.newMatches ? ` — جديد: ${matchesAr(r.matching.newMatches)}` : ''}`);
    onChange();
    await refresh();
    if (action === 'delete') st.el?.querySelector('.st-title')?.focus();
  }

  /** run a handler with a busy state on its button (keeps focus: aria-disabled, not disabled) */
  function run(btn, fn) {
    if (!btn || btn.dataset.busy === 'true') return;
    btn.dataset.busy = 'true';
    btn.setAttribute('aria-busy', 'true');
    Promise.resolve().then(fn).catch((e) => notify(errText(e, 'تعذّر التنفيذ'), 'error')).finally(() => { if (btn.isConnected) { delete btn.dataset.busy; btn.removeAttribute('aria-busy'); } });
  }

  // ───────────── store form (create / edit) ─────────────
  function storeForm(s0) {
    const isNew = !s0;
    const ids = { name: uid('st-name'), desc: uid('st-desc'), place: uid('st-place'), hours: uid('st-hours') };
    const places = (st.taxonomy?.places || []).filter((p) => p.kind !== 'world');
    const name = h('input', { class: 'input', id: ids.name, required: true, maxLength: 80, autocomplete: 'organization', value: s0?.nameAr ?? '', placeholder: 'مثلًا: أبو أحمد للموبايلات' });
    const desc = h('textarea', { class: 'input st-textarea', id: ids.desc, maxLength: 500, rows: 3, placeholder: 'ماذا تبيع؟ (اختياري)' });
    desc.value = s0?.descriptionAr ?? '';
    const place = h('select', { class: 'select', id: ids.place, required: true },
      h('option', { value: '' }, 'اختر المدينة'), places.map((p) => h('option', { value: String(p.id), selected: s0?.placeId === p.id }, ar(p.labelAr))));
    const hours = h('input', { class: 'input', id: ids.hours, maxLength: 120, value: s0?.hoursAr ?? '', placeholder: 'مثلًا: من ٩ الصبح للـ ٩ المسا (اختياري)' });
    const pref = s0?.contactPref ?? 'chat';
    const prefField = h('fieldset', { class: 'seg-field' }, h('legend', { class: 'field-label' }, 'التواصل مع الزبائن'),
      h('div', { class: 'seg', role: 'radiogroup' },
        [['chat', 'محادثة داخل التطبيق'], ['chat_then_phone', 'محادثة، ثم رقمي إذا وافقت']].map(([v, l]) => h('label', null, h('input', { type: 'radio', name: 'st-pref', value: v, checked: pref === v }), h('span', null, l)))));
    const err = h('p', { class: 'form-error', role: 'alert', hidden: !st.formError }, st.formError);
    const submit = async (ev) => {
      ev.preventDefault();
      err.hidden = true;
      if (name.value.trim().length < 2) { name.setAttribute('aria-invalid', 'true'); name.focus(); err.textContent = 'اكتب اسم المتجر (حرفان على الأقل).'; err.hidden = false; return; }
      if (!place.value) { place.focus(); err.textContent = 'اختر مدينة المتجر.'; err.hidden = false; return; }
      const body = { nameAr: name.value.trim(), descriptionAr: desc.value.trim() || null, placeId: Number(place.value), hoursAr: hours.value.trim() || null, contactPref: st.el.querySelector('input[name="st-pref"]:checked')?.value ?? 'chat' };
      try {
        if (isNew) {
          const r = await api.post('/api/stores', body);
          st.storeId = r.store.id;
          notify(`أُنشئ المتجر «${r.store.nameAr}». أضف منتجاتك الآن.`);
        } else {
          const r = await api.patch(`/api/stores/${s0.id}`, { expectedVersion: s0.version, ...body });
          notify(r.matching ? `حُفظ المتجر ونُقلت منتجاته إلى ${r.store.placeAr}` : 'حُفظت بيانات المتجر');
        }
        onChange();
        st.screen = 'home';
        await open('home');
      } catch (e) { err.textContent = errText(e, 'تعذّر الحفظ'); err.hidden = false; }
    };
    return h('div', { class: 'st-root' }, topBar(isNew ? 'متجر جديد' : 'تعديل المتجر'),
      isNew && !st.stores?.length ? h('p', { class: 'panel-hint' }, 'المتجر يجمع منتجاتك في مكان واحد. كل منتج يُعرض لمن يحتاجه، والتواصل لا يتم إلا بموافقتك.') : null,
      h('form', { class: 'editor-form st-form card', onSubmit: submit, noValidate: true },
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: ids.name }, 'اسم المتجر'), name),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: ids.place }, 'المدينة'), place, h('p', { class: 'field-hint' }, isNew ? 'منتجاتك تُعرض في هذه المدينة.' : 'تغيير المدينة ينقل كل المنتجات إليها ويعيد مطابقتها.')),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: ids.desc }, 'وصف قصير'), desc),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: ids.hours }, 'أوقات الدوام'), hours),
        prefField, err,
        h('div', { class: 'st-row' },
          h('button', { type: 'submit', class: 'btn btn-primary' }, icon('check', { size: 18 }), isNew ? 'إنشاء المتجر' : 'حفظ'),
          st.stores?.length ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => open('home') }, 'إلغاء') : null)));
  }

  // ───────────── bulk import ─────────────
  function importScreen() {
    const s0 = store();
    const tid = uid('st-import');
    const cid = uid('st-defcur');
    const area = h('textarea', { class: 'input st-textarea st-import-text', id: tid, rows: 9, dataset: { key: 'import-text' }, 'aria-describedby': `${tid}-hint ${tid}-count`, placeholder: 'ايفون 12 مستعمل - 300$\nشاحن سامسونج ١٠ دولار\nبراد سامسونج ١٠ آلاف ليرة تركي' });
    area.value = st.importText;
    const count = h('p', { class: 'field-hint', id: `${tid}-count`, 'aria-live': 'polite' });
    const setCount = () => { const n = area.value.split('\n').filter((l) => l.trim()).length; count.textContent = ar(`${formatNumber(n)} سطر من ٢٠٠`); count.classList.toggle('field-error', n > 200); };
    setCount();
    area.addEventListener('input', () => { st.importText = area.value; setCount(); });
    const cur = h('select', { class: 'select', id: cid }, h('option', { value: '' }, 'بدون (كل سطر يذكر عملته)'), CURRENCIES.map(([v, l]) => h('option', { value: v, selected: st.importCurrency === v }, l)));
    cur.addEventListener('change', () => { st.importCurrency = cur.value; });
    const err = h('p', { class: 'form-error', role: 'alert', hidden: !st.importError }, st.importError);
    const previewBtn = h('button', { type: 'submit', class: 'btn btn-primary', dataset: { key: 'preview' } }, icon('search', { size: 18 }), st.preview ? 'معاينة من جديد' : 'معاينة');
    const doPreview = async (ev) => {
      ev.preventDefault();
      st.importError = '';
      if (!area.value.trim()) { st.importError = 'الصق سطرًا واحدًا على الأقل: اسم المنتج وسعره.'; render(); restoreFocus('import-text'); return; }
      previewBtn.setAttribute('aria-busy', 'true');
      try {
        const r = await api.post(`/api/stores/${s0.id}/import/preview`, { text: area.value, defaultCurrency: st.importCurrency || null });
        st.preview = r;
        st.rows = r.lines.map((l) => ({ line: l, include: l.ok, item: { ...l.item }, problems: l.problems, edited: false }));
        st.importId = uuid4();
        render();
        st.el.querySelector('.st-preview-summary')?.focus();
      } catch (e) { st.importError = errText(e, 'تعذّرت المعاينة'); render(); restoreFocus('preview'); }
    };
    return h('div', { class: 'st-root' }, topBar(`إضافة منتجات — ${ar(s0?.nameAr ?? '')}`),
      h('form', { class: 'card st-import', onSubmit: doPreview, noValidate: true },
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: tid }, 'الصق قائمتك: سطر لكل منتج'),
          h('p', { class: 'field-hint', id: `${tid}-hint` }, 'اكتب اسم المنتج ثم السعر والعملة، مثل «ايفون 12 مستعمل - 300$». لن يُحفظ شيء قبل المعاينة والتأكيد.'),
          area, count),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: cid }, 'العملة إذا لم يذكرها السطر'), cur),
        err, h('div', { class: 'st-row' }, previewBtn)),
      st.preview ? previewSection(s0) : null);
  }

  function previewSection(s0) {
    const sum = st.preview.summary;
    const included = st.rows.filter((r) => r.include).length;
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { key: 'confirm' }, 'aria-disabled': included ? 'false' : 'true', onClick: (ev) => { if (included) run(ev.currentTarget, () => confirm(s0)); } },
      icon('check', { size: 18 }), included ? `حفظ ${productCount(included)}` : 'اختر منتجًا واحدًا على الأقل');
    return h('section', { class: 'st-preview', 'aria-label': 'معاينة' },
      h('p', { class: 'st-preview-summary', tabIndex: -1, role: 'status' },
        ar(`فهمنا ${productCount(sum.total)}: ${formatNumber(sum.ok)} جاهز`), sum.withProblems ? ar(`، و${formatNumber(sum.withProblems)} يحتاج تصحيحًا (غير محدد حتى تصححه)`) : null, '.'),
      st.preview.limits.remaining < sum.total ? h('p', { class: 'st-note' }, ar(`يتسع متجرك لـ ${formatNumber(st.preview.limits.remaining)} منتج إضافي فقط (الحد ١٠٠٠).`)) : null,
      h('ol', { class: 'st-preview-list', role: 'list' }, st.rows.map((r, i) => previewRow(r, i))),
      h('div', { class: 'st-row st-sticky' }, saveBtn, h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => open('home') }, 'رجوع دون حفظ')));
  }

  function previewRow(r, i) {
    const l = r.line;
    const key = `row-${i}`;
    const ids = { inc: uid('st-inc'), name: uid('st-pname'), amount: uid('st-pamount'), cur: uid('st-pcur'), cat: uid('st-pcat'), deal: uid('st-pdeal'), unit: uid('st-punit') };
    const problemCodes = new Set((r.problems || []).map((p) => p.code));
    const mark = () => { r.edited = true; if (!r.include) { r.include = true; const c = st.el.querySelector(`#${ids.inc}`); if (c) c.checked = true; } refreshSaveLabel(); };
    const inc = h('input', { type: 'checkbox', id: ids.inc, checked: r.include, dataset: { key: `${key}:inc` }, onChange: (ev) => { r.include = ev.currentTarget.checked; refreshSaveLabel(); } });
    const name = h('input', { class: 'input', id: ids.name, maxLength: 80, value: r.item.nameAr ?? '', onInput: (ev) => { r.item.nameAr = ev.currentTarget.value; mark(); } });
    const amount = h('input', { class: 'input st-amount', id: ids.amount, inputMode: 'decimal', autocomplete: 'off', value: l.price ? minorToInput(l.price.minor, l.price.currency || 'USD') : '',
      'aria-invalid': problemCodes.has('missing_price') || problemCodes.has('bad_amount') ? 'true' : 'false',
      onInput: (ev) => { const m = parseAmountToMinor(ev.currentTarget.value, r.item.currency || 'USD'); r.item.amount = m === null ? toLatinDigits(ev.currentTarget.value) : minorToAmount(m); mark(); } });
    const cur = h('select', { class: 'select', id: ids.cur, 'aria-invalid': problemCodes.has('missing_currency') || problemCodes.has('ambiguous_lira') ? 'true' : 'false', onChange: (ev) => { r.item.currency = ev.currentTarget.value || undefined; mark(); } },
      h('option', { value: '' }, 'العملة؟'), CURRENCIES.map(([v, lab]) => h('option', { value: v, selected: r.item.currency === v }, lab)));
    const cats = productCategories(l);
    const cat = h('select', { class: 'select', id: ids.cat, 'aria-invalid': problemCodes.has('unknown_category') || problemCodes.has('not_a_product') ? 'true' : 'false', onChange: (ev) => { r.item.categoryCode = ev.currentTarget.value || undefined; mark(); } },
      h('option', { value: '' }, 'الصنف؟'), cats.map((c) => h('option', { value: c.code, selected: r.item.categoryCode === c.code }, ar(c.labelAr))));
    const dealNeeded = problemCodes.has('missing_deal') || l.deal === 'rent' || (r.item.categoryCode && (st.taxonomy?.categories || []).find((c) => c.code === r.item.categoryCode)?.deals?.includes('rent'));
    const deal = dealNeeded ? h('select', { class: 'select', id: ids.deal, onChange: (ev) => { r.item.deal = ev.currentTarget.value || undefined; mark(); } },
      h('option', { value: '' }, 'بيع أم إيجار؟'), h('option', { value: 'sale', selected: r.item.deal === 'sale' }, 'للبيع'), h('option', { value: 'rent', selected: r.item.deal === 'rent' }, 'للإيجار')) : null;
    const unit = r.item.deal === 'rent' || problemCodes.has('missing_unit') ? h('select', { class: 'select', id: ids.unit, onChange: (ev) => { r.item.unit = ev.currentTarget.value || undefined; mark(); } },
      h('option', { value: '' }, 'الوحدة؟'), RENT_UNITS.map(([v, lab]) => h('option', { value: v, selected: r.item.unit === v }, lab))) : null;
    const problems = r.problems || [];
    return h('li', { class: ['card', 'st-prow', problems.length ? 'has-problems' : 'is-ok'], dataset: { id: key } },
      h('div', { class: 'st-prow-head' },
        h('label', { class: 'st-check', for: ids.inc }, inc, h('span', null, 'تضمين')),
        h('p', { class: 'st-prow-line' }, h('span', { class: 'sr-only' }, 'السطر الأصلي: '), ar(l.text)),
        problems.length ? h('span', { class: 'status-chip status-paused' }, 'يحتاج تصحيحًا') : h('span', { class: 'status-chip status-active' }, 'جاهز')),
      h('div', { class: 'st-prow-grid' },
        h('div', { class: 'field st-f-name' }, h('label', { class: 'field-label', for: ids.name }, 'الاسم'), name),
        h('div', { class: 'field st-f-cat' }, h('label', { class: 'field-label', for: ids.cat }, 'الصنف'), cat),
        h('div', { class: 'field st-f-amount' }, h('label', { class: 'field-label', for: ids.amount }, 'السعر'), amount),
        h('div', { class: 'field st-f-cur' }, h('label', { class: 'field-label', for: ids.cur }, 'العملة'), cur),
        deal ? h('div', { class: 'field' }, h('label', { class: 'field-label', for: ids.deal }, 'الصفقة'), deal) : null,
        unit ? h('div', { class: 'field' }, h('label', { class: 'field-label', for: ids.unit }, 'وحدة الإيجار'), unit) : null),
      l.chips?.length ? h('ul', { class: 'chips chips-compact', role: 'list' }, l.chips.map((c) => h('li', { class: 'chip' }, h('span', { class: 'chip-label' }, ar(c.labelAr)), h('span', { class: 'chip-value' }, ar(c.valueAr))))) : null,
      problems.length ? h('ul', { class: 'st-problems', role: 'list' }, problems.map((p) => h('li', null, icon('alert', { size: 16 }), ar(p.messageAr)))) : null,
      l.warnings?.length ? h('ul', { class: 'st-warnings', role: 'list' }, l.warnings.map((w) => h('li', null, icon('info', { size: 16 }), ar(w.messageAr)))) : null,
      r.edited && problems.length ? h('p', { class: 'field-hint' }, 'عدّلت هذا السطر؛ سيُفحص من جديد عند الحفظ.') : null);
  }

  function refreshSaveLabel() {
    const btn = st.el?.querySelector('[data-key="confirm"]');
    if (!btn) return;
    const n = st.rows.filter((r) => r.include).length;
    btn.setAttribute('aria-disabled', n ? 'false' : 'true');
    btn.lastChild.textContent = n ? `حفظ ${productCount(n)}` : 'اختر منتجًا واحدًا على الأقل';
  }

  function productCategories(line) {
    const all = (st.taxonomy?.categories || []).filter((c) => (c.deals || []).some((d) => d === 'sale' || d === 'rent'));
    const alt = new Set((line.alternatives || []).map((a) => a.code));
    return [...all.filter((c) => alt.has(c.code)), ...all.filter((c) => !alt.has(c.code))];
  }

  async function confirm(s0) {
    const chosen = st.rows.map((r, i) => ({ r, i })).filter((x) => x.r.include);
    const items = chosen.map(({ r }) => {
      const it = { line: r.line.text };
      for (const k of ['nameAr', 'categoryCode', 'deal', 'amount', 'currency', 'unit', 'condition', 'negotiable']) if (r.item[k] !== undefined && r.item[k] !== '') it[k] = r.item[k];
      return it;
    });
    try {
      const res = await postFull(`/api/stores/${s0.id}/import/confirm`, { importId: st.importId, items, defaultCurrency: st.importCurrency || null });
      const m = res.matching;
      notify(`${res.replay ? 'حُفظت سابقًا' : 'أُضيفت'} ${productCount(res.created)} إلى متجرك${m && (m.confirmed + m.possible) ? ` — ${matchesAr(m.confirmed + m.possible)} مع طلبات الناس` : ''}${res.storeStatus === 'paused' ? ' (المتجر موقوف: لن تظهر حتى تستأنفه)' : ''}`);
      st.importText = '';
      st.preview = null;
      st.rows = [];
      st.filter = 'all';
      onChange();
      await open('home');
    } catch (e) {
      if (e && e.code === 'import_invalid' && Array.isArray(e.lines)) {
        for (const bad of e.lines) {
          const row = chosen[bad.lineNo - 1]?.r;
          if (row) { row.problems = bad.problems; row.edited = false; }
        }
        render();
        const first = st.el.querySelector('.st-prow.has-problems input:not([type="checkbox"]), .st-prow.has-problems select');
        first?.focus();
        notify('بعض الأسطر ما زالت تحتاج تصحيحًا — لم يُحفظ شيء.', 'warning');
        return;
      }
      if (e && e.code === 'import_id_reused') st.importId = uuid4();
      throw e;
    }
  }

  return { entry, isOpen: () => st.open, open, refresh, close };
}

