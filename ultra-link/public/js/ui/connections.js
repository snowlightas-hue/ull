// Connections («ربط») UI: the chat sheet opened from a match card, and the account-recovery screens.
// Owner: connections role. Rules as in ./README.md: text only through text nodes (h()), no inline styles except
// via the CSSOM, RTL, keyboard + focus management, reduced motion, 44px touch targets.
//
// Unlike the pure views in this folder, the chat is a small controller: app.js injects the `api` module
// (get/post), so this file still never builds a URL to another origin or touches cookies.
//
//   createConnections({ api }) → {
//     openChat(connectionId, { opener? }) → Promise<void>   // accessible dialog; focus returns to `opener`
//     onEvent(type)                                         // SSE: 'conn_message' | 'conn_update' | 'conn_location'
//     isOpen() → boolean, stopAllSharing()
//   }
//   showRecoveryCode(code, { titleAr?, introAr? }) → Promise<void>   // «احفظ هذا الرمز» (once), copy button
//   confirmLogout({ onLogout, onNewCode }) → void                     // warning for real accounts
//   recoverSection({ onRecover(code) → Promise }) → <section>         // login page: «ارجع إلى حسابك»
import { h, mount, uid, focusableWithin, prefersReducedMotion, srOnly } from './dom.js';
import { icon } from './icons.js';
import { ar, formatRelativeTime, formatDateTime, telHref, toArabicDigits } from './format.js';
import { toast } from './toast.js';

const MAX_CHARS = 1000;
const PING_MIN_MS = 15_000;   // send a position at most every 15 s …
const PING_MOVE_M = 50;       // … or sooner (≥ 5 s) after moving 50 m
const PING_FLOOR_MS = 5_000;

// ───────────────────────── modal sheet (same mechanics as editor.js) ─────────────────────────
function openSheet({ labelledBy, describedBy, className, children, onDismiss, dismissible = true, opener = document.activeElement }) {
  const sheet = h('div', { class: ['sheet', className], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy, 'aria-describedby': describedBy || null }, children);
  const backdrop = h('div', { class: 'sheet-backdrop cx-backdrop' }, sheet);
  const inerted = [];
  for (const child of Array.from(document.body.children)) {
    if (child.classList.contains('toast-region') || child.inert) continue;
    child.inert = true;
    inerted.push(child);
  }
  document.documentElement.classList.add('ul-modal-open');
  document.body.append(backdrop);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && dismissible) onDismiss?.(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (dismissible) onDismiss?.();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusableWithin(sheet);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  let closed = false;
  const close = () => new Promise((resolve) => {
    if (closed) { resolve(); return; }
    closed = true;
    const finish = () => {
      backdrop.remove();
      for (const el of inerted) el.inert = false;
      if (!document.querySelector('.sheet-backdrop')) document.documentElement.classList.remove('ul-modal-open');
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      resolve();
    };
    backdrop.dataset.closing = 'true';
    if (prefersReducedMotion()) { finish(); return; }
    let done = false;
    const once = () => { if (!done) { done = true; finish(); } };
    sheet.addEventListener('animationend', once, { once: true });
    setTimeout(once, 260);
  });
  return { sheet, backdrop, close };
}

/** A button that needs a second press within 4 s (destructive actions), like the intent card's «إغلاق». */
function armedButton(label, armedLabel, onConfirm, extraClass = 'btn-danger') {
  let timer = null;
  const btn = h('button', { type: 'button', class: ['btn', 'btn-sm', extraClass] }, label);
  btn.addEventListener('click', async () => {
    if (btn.dataset.armed !== 'true') {
      btn.dataset.armed = 'true';
      btn.textContent = armedLabel;
      timer = setTimeout(() => { btn.dataset.armed = 'false'; btn.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.dataset.armed = 'false';
    btn.disabled = true;
    try { await onConfirm(); } finally { btn.disabled = false; btn.textContent = label; }
  });
  return btn;
}

const minutesLabel = (m) => (m === 60 ? 'ساعة' : `${toArabicDigits(m)} دقيقة`);
const STATUS_NOTE = {
  closed: 'أُغلقت هذه المحادثة. يمكنك قراءة الرسائل فقط.',
  blocked: 'حظرت هذا الشخص. لا رسائل ولا طلبات تواصل بينكما.',
  archived: 'أُرشفت هذه المحادثة تلقائيًا. يمكنك قراءة الرسائل فقط.',
};
const REPORT_REASONS = [
  ['scam', 'احتيال أو طلب مال'], ['abuse', 'إساءة أو تهديد'], ['inappropriate', 'محتوى غير لائق'],
  ['spam', 'رسائل مزعجة'], ['fake', 'حساب أو عرض وهمي'], ['other', 'سبب آخر'],
];

function metersBetween(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// ───────────────────────── controller ─────────────────────────
export function createConnections({ api }) {
  /** connectionId → { watchId, last: {lat,lng,t}|null, until: ms, timer } */
  const sharing = new Map();
  const resumed = new Set(); // connections whose active share we already tried to resume after a reload
  let chat = null; // the open chat (one at a time)

  // ── live location (sharer side): watchPosition, throttled, stops at expiry ──
  function startWatching(connId, expiresAt) {
    stopWatching(connId);
    if (!('geolocation' in navigator)) { toast('تحديد الموقع غير متاح في هذا المتصفح.', { kind: 'error' }); return false; }
    const until = Date.parse(expiresAt);
    const s = { watchId: null, last: null, until, timer: null };
    s.timer = setTimeout(() => stopWatching(connId), Math.max(0, until - Date.now()) + 500);
    s.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now() };
        if (Date.now() > s.until) { stopWatching(connId); return; }
        const since = s.last ? p.t - s.last.t : Infinity;
        const moved = s.last ? metersBetween(s.last, p) : Infinity;
        if (!(since >= PING_MIN_MS || (moved >= PING_MOVE_M && since >= PING_FLOOR_MS))) return;
        s.last = p;
        api.post(`/api/connections/${connId}/location`, { lat: p.lat, lng: p.lng, accuracyM: Math.round(pos.coords.accuracy || 0) })
          .catch((e) => { if (e?.status === 409 || e?.status === 404) stopWatching(connId); });
      },
      (err) => {
        stopWatching(connId);
        toast(err.code === 1 ? 'لم تسمح بتحديد الموقع، فأُوقفت المشاركة.' : 'تعذّر تحديد موقعك، فأُوقفت المشاركة.', { kind: 'error' });
        api.post(`/api/connections/${connId}/location/stop`, {}).catch(() => {}).finally(() => chat?.id === connId && chat.refresh());
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    sharing.set(connId, s);
    return true;
  }
  function stopWatching(connId) {
    const s = sharing.get(connId);
    if (!s) return;
    if (s.watchId !== null) navigator.geolocation?.clearWatch(s.watchId);
    clearTimeout(s.timer);
    sharing.delete(connId);
  }

  async function openChat(connectionId, { opener } = {}) {
    if (chat) await chat.close();
    chat = buildChat(connectionId, opener ?? document.activeElement);
    await chat.load();
  }

  function buildChat(id, opener) {
    const titleId = uid('chat-title');
    const subId = uid('chat-sub');
    const st = { detail: null, items: [], olderCursor: null, lastSeq: 0, theirRead: 0, loadingNew: false, again: false, readSent: 0, tick: null, toolsDirty: false };

    const title = h('h2', { class: 'sheet-title cx-title', id: titleId, tabIndex: -1 }, 'المحادثة');
    const sub = h('p', { class: 'sheet-sub cx-sub', id: subId });
    const closeX = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'إغلاق المحادثة', onClick: () => close() }, icon('close', { size: 20 }));
    const statusNote = h('p', { class: 'cx-status-note', role: 'status', hidden: true });
    const tools = h('div', { class: 'cx-tools' });
    const toolsToggle = h('button', { type: 'button', class: 'btn btn-sm btn-ghost cx-tools-toggle', 'aria-expanded': 'false' }, icon('chevronDown', { size: 16 }), 'الهاتف والموقع والخيارات');
    const toolsWrap = h('section', { class: 'cx-tools-wrap', 'aria-label': 'الهاتف والموقع والخيارات' }, toolsToggle, tools);
    tools.hidden = true;
    toolsToggle.addEventListener('click', () => {
      tools.hidden = !tools.hidden;
      toolsToggle.setAttribute('aria-expanded', String(!tools.hidden));
    });
    const olderBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost cx-older', hidden: true, onClick: () => loadOlder() }, 'عرض رسائل أقدم');
    const list = h('ol', { class: 'cx-messages', role: 'list' });
    // the list is re-rendered freely; screen readers hear new incoming messages through `announcer` only
    const log = h('section', { class: 'cx-log', 'aria-label': 'الرسائل', tabIndex: 0 }, olderBtn, list);
    const announcer = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    const empty = h('p', { class: 'cx-empty muted' }, 'لا رسائل بعد. ابدأ بالسلام وعرّف بنفسك باختصار.');

    const inputId = uid('chat-input');
    const counter = h('span', { class: 'cx-counter', 'aria-live': 'off' }, '');
    const input = h('textarea', { class: 'input cx-input', id: inputId, rows: 1, maxLength: 4000, dir: 'auto', placeholder: 'اكتب رسالتك…', autocomplete: 'off' });
    const sendBtn = h('button', { type: 'submit', class: 'btn btn-primary cx-send', 'aria-label': 'إرسال' }, icon('send', { size: 18 }), h('span', { class: 'cx-send-label' }, 'إرسال'));
    const compose = h('form', { class: 'cx-compose', novalidate: true },
      h('label', { class: 'sr-only', for: inputId }, 'رسالتك'), input, h('div', { class: 'cx-compose-side' }, sendBtn, counter));
    const closedBar = h('p', { class: 'cx-closed muted', hidden: true });

    const updateCounter = () => {
      const n = [...input.value].length;
      counter.textContent = n > MAX_CHARS * 0.8 ? `${toArabicDigits(n)}/${toArabicDigits(MAX_CHARS)}` : '';
      counter.dataset.over = n > MAX_CHARS ? 'true' : 'false';
      input.setAttribute('aria-invalid', n > MAX_CHARS ? 'true' : 'false');
      input.style.setProperty('height', 'auto');
      input.style.setProperty('height', `${Math.min(input.scrollHeight, 140)}px`);
    };
    input.addEventListener('input', updateCounter);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); compose.requestSubmit(); }
    });
    compose.addEventListener('submit', (e) => { e.preventDefault(); void submit(); });

    const { close: closeSheet } = openSheet({
      labelledBy: titleId, describedBy: subId, className: 'cx-sheet', opener,
      onDismiss: () => close(),
      children: [
        h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
        h('header', { class: 'sheet-head' }, title, closeX),
        sub, statusNote, toolsWrap, log, empty, closedBar, compose, announcer,
      ],
    });

    const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const toBottom = () => { log.scrollTop = log.scrollHeight; };

    function bubble(m, { pending = false, failed = false } = {}) {
      const read = m.mine && m.seq && m.seq <= st.theirRead;
      const li = h('li', { class: ['cx-msg', m.mine ? 'cx-mine' : 'cx-theirs', pending && 'cx-pending', failed && 'cx-failed'], dataset: { seq: m.seq ?? '', cid: m.clientMsgId ?? '' } },
        srOnly(m.mine ? 'أنت: ' : `${st.detail?.counterpart?.displayName ?? 'الطرف الآخر'}: `),
        h('p', { class: 'cx-text', dir: 'auto' }, m.text),
        h('p', { class: 'cx-meta' },
          m.createdAt ? h('time', { datetime: m.createdAt, title: formatDateTime(m.createdAt) }, formatRelativeTime(m.createdAt)) : null,
          m.mine ? h('span', { class: ['cx-receipt', read && 'cx-read'] },
            icon(failed ? 'alert' : read ? 'checkAll' : pending ? 'clock' : 'check', { size: 14 }),
            srOnly(failed ? 'لم تُرسل' : read ? 'قُرئت' : pending ? 'جارٍ الإرسال' : 'أُرسلت')) : null));
      if (failed) {
        li.append(h('button', { type: 'button', class: 'link-btn cx-retry', onClick: () => retry(m) }, 'إعادة المحاولة'));
      }
      return li;
    }

    function renderMessages({ keepScroll = false, stick = false } = {}) {
      const prevH = log.scrollHeight;
      const prevTop = log.scrollTop;
      const atBottom = nearBottom();
      mount(list, st.items.map((m) => bubble(m, m._state ?? {})));
      empty.hidden = st.items.length > 0;
      olderBtn.hidden = !st.olderCursor;
      if (keepScroll) log.scrollTop = prevTop + (log.scrollHeight - prevH);
      else if (stick || atBottom) toBottom();
    }

    function renderHeader() {
      const d = st.detail;
      if (!d) return;
      title.textContent = `المحادثة مع ${ar(d.counterpart.displayName)}`;
      mount(sub,
        d.synthetic ? h('span', { class: 'demo-tag' }, 'تجريبي') : null,
        d.titles?.otherAr ? `بخصوص: «${ar(d.titles.otherAr)}»` : null);
      const note = d.status === 'open' ? '' : d.status === 'blocked' ? STATUS_NOTE.blocked : d.status === 'archived' ? STATUS_NOTE.archived : STATUS_NOTE.closed;
      statusNote.hidden = !note;
      statusNote.textContent = note;
      compose.hidden = !d.canSend;
      closedBar.hidden = d.canSend;
      closedBar.textContent = d.canSend ? '' : 'لا يمكن إرسال رسائل في هذه المحادثة.';
    }

    function renderTools() {
      const d = st.detail;
      if (!d) return;
      // never rebuild under a half-filled report form; catch up when it closes
      if (tools.querySelector('.cx-report:not([hidden])')) { st.toolsDirty = true; return; }
      st.toolsDirty = false;
      const focusKey = document.activeElement?.closest?.('[data-key]')?.dataset.key ?? null;
      const name = ar(d.counterpart.displayName);
      const open = d.status === 'open';
      // phone
      const theirPhone = d.counterpart.phone;
      const phoneSwitch = h('button', { type: 'button', class: ['btn', 'btn-sm', 'cx-switch'], role: 'switch', 'aria-checked': String(!!d.me.phoneShared), dataset: { key: 'phone' }, disabled: !open },
        h('span', { class: 'cx-switch-knob', 'aria-hidden': 'true' }), 'شارك رقمي');
      const phoneInput = h('input', { class: 'input cx-phone-input', type: 'tel', inputMode: 'tel', maxLength: 30, dir: 'ltr', placeholder: '+963 9xx xxx xxx', 'aria-label': 'رقم هاتفك', dataset: { key: 'phone-input' } });
      const phoneRow = h('div', { class: 'cx-row' });
      const needPhone = !d.me.hasPhone;
      phoneSwitch.addEventListener('click', async () => {
        const share = !d.me.phoneShared;
        if (share && needPhone && !phoneInput.value.trim()) { phoneInput.hidden = false; phoneInput.focus(); toast('اكتب رقمك أولًا ثم اضغط «شارك رقمي».', { kind: 'info' }); return; }
        phoneSwitch.disabled = true;
        try {
          const r = await api.post(`/api/connections/${id}/phone`, share && needPhone ? { share, phone: phoneInput.value.trim() } : { share });
          st.detail = r.connection;
          renderTools();
          toast(share ? `صار رقمك ظاهرًا لـ${name}.` : 'أخفيت رقمك.', { kind: 'success' });
        } catch (e) { toast(e.messageAr ?? 'تعذّر التغيير', { kind: 'error' }); phoneSwitch.disabled = false; }
      });
      phoneInput.hidden = !needPhone || !!d.me.phoneShared;
      mount(phoneRow,
        h('p', { class: 'cx-row-title' }, icon('phone', { size: 16 }), 'الهاتف'),
        theirPhone
          ? h('p', { class: 'cx-their-phone' }, `رقم ${name}: `, h('a', { class: 'phone', href: telHref(theirPhone), dir: 'ltr' }, String(theirPhone)))
          : h('p', { class: 'muted cx-hint' }, `لم يشارك ${name} رقمه. لا يظهر أي رقم إلا بقرار صاحبه.`),
        h('div', { class: 'cx-actions' }, phoneSwitch, needPhone && !d.me.phoneShared ? phoneInput : null),
        h('p', { class: 'muted cx-hint' }, d.me.phoneShared ? `رقمك ظاهر لـ${name} الآن. أطفئ المفتاح لإخفائه.` : 'رقمك مخفي. شاركه فقط إذا أردت.'));

      // location
      const them = d.them.location;
      const mine = d.me.location;
      const locRow = h('div', { class: 'cx-row' }, h('p', { class: 'cx-row-title' }, icon('pin', { size: 16 }), 'الموقع المباشر'));
      if (them?.active) {
        const p = them.position;
        locRow.append(h('div', { class: 'cx-their-loc', dataset: { key: 'their-loc' } },
          h('p', null, `${name} يشارك موقعه الآن`, them.expiresAt ? ` — ينتهي ${formatRelativeTime(them.expiresAt)}` : ''),
          p
            ? [
              h('p', { class: 'cx-coords', dir: 'ltr' }, `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`),
              h('p', { class: 'muted cx-hint' }, `آخر تحديث ${formatRelativeTime(p.at)}`, p.accuracyM != null ? ` — الدقة ±${toArabicDigits(p.accuracyM)} م` : ''),
              h('a', { class: 'btn btn-sm', href: `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(6)}&mlon=${p.lng.toFixed(6)}#map=17/${p.lat.toFixed(6)}/${p.lng.toFixed(6)}`, target: '_blank', rel: 'noopener noreferrer' }, icon('pin', { size: 16 }), 'افتح في الخريطة'),
            ]
            : h('p', { class: 'muted cx-hint' }, 'بانتظار أول تحديث لموقعه…')));
      }
      if (mine?.active) {
        const stop = h('button', { type: 'button', class: 'btn btn-sm btn-danger', dataset: { key: 'loc-stop' } }, 'إيقاف مشاركة موقعي');
        stop.addEventListener('click', async () => {
          stop.disabled = true;
          try { await api.post(`/api/connections/${id}/location/stop`, {}); stopWatching(id); toast('أوقفت مشاركة موقعك.', { kind: 'success' }); await refresh(); }
          catch (e) { toast(e.messageAr ?? 'تعذّر الإيقاف', { kind: 'error' }); stop.disabled = false; }
        });
        locRow.append(h('p', { class: 'cx-sharing' }, h('span', { class: 'cx-live-dot', 'aria-hidden': 'true' }), `تشارك موقعك مع ${name} — ينتهي ${formatRelativeTime(mine.expiresAt)}`),
          h('div', { class: 'cx-actions' }, stop));
        if (!sharing.has(id) && !resumed.has(id)) { resumed.add(id); startWatching(id, mine.expiresAt); } // resume after a reload
      } else if (open) {
        const group = h('div', { class: 'cx-actions', role: 'group', 'aria-label': 'شارك موقعي لمدة' },
          [15, 30, 60].map((m) => {
            const b = h('button', { type: 'button', class: 'btn btn-sm', dataset: { key: `loc-${m}` } }, minutesLabel(m));
            b.addEventListener('click', async () => {
              if (!('geolocation' in navigator)) { toast('تحديد الموقع غير متاح في هذا المتصفح.', { kind: 'error' }); return; }
              b.disabled = true;
              try {
                const r = await api.post(`/api/connections/${id}/location/start`, { minutes: m });
                startWatching(id, r.share.expiresAt);
                toast(`بدأت مشاركة موقعك مع ${name} لمدة ${minutesLabel(m)}.`, { kind: 'success' });
                await refresh();
              } catch (e) { toast(e.messageAr ?? 'تعذّر بدء المشاركة', { kind: 'error' }); b.disabled = false; }
            });
            return b;
          }));
        locRow.append(h('p', { class: 'cx-hint' }, 'شارك موقعي المباشر لمدة:'), group,
          h('p', { class: 'muted cx-hint' }, `يرى ${name} موقعك الدقيق فقط أثناء المشاركة، وتتوقف تلقائيًا. أبقِ الصفحة مفتوحة ليتحدّث الموقع.`));
      } else if (!them?.active) {
        locRow.append(h('p', { class: 'muted cx-hint' }, 'لا مشاركة موقع في محادثة مغلقة.'));
      }

      // close / block / report
      const actions = h('div', { class: 'cx-row' }, h('p', { class: 'cx-row-title' }, icon('info', { size: 16 }), 'خيارات'));
      const btns = h('div', { class: 'cx-actions' });
      if (open) {
        btns.append(armedButton('إغلاق المحادثة', 'اضغط مرة ثانية للإغلاق', async () => {
          try { const r = await api.post(`/api/connections/${id}/close`, {}); st.detail = r.connection; stopWatching(id); renderAll(); toast('أُغلقت المحادثة.', { kind: 'success' }); }
          catch (e) { toast(e.messageAr ?? 'تعذّر الإغلاق', { kind: 'error' }); }
        }, 'btn-ghost'));
      }
      if (d.blockedByMe) {
        btns.append(armedButton('إلغاء الحظر', 'اضغط مرة ثانية لإلغاء الحظر', async () => {
          try { const r = await api.post(`/api/connections/${id}/unblock`, {}); st.detail = r.connection; renderAll(); toast('ألغيت الحظر. المحادثة تبقى مغلقة.', { kind: 'success' }); }
          catch (e) { toast(e.messageAr ?? 'تعذّر إلغاء الحظر', { kind: 'error' }); }
        }, 'btn-ghost'));
      } else {
        btns.append(armedButton('حظر', 'اضغط مرة ثانية للحظر', async () => {
          try { const r = await api.post(`/api/connections/${id}/block`, {}); st.detail = r.connection; stopWatching(id); renderAll(); toast(`حظرت ${name}. لن تصلك منه رسائل ولا طلبات تواصل.`, { kind: 'success' }); }
          catch (e) { toast(e.messageAr ?? 'تعذّر الحظر', { kind: 'error' }); }
        }));
      }
      const reportBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-expanded': 'false', dataset: { key: 'report' } }, d.reportedByMe ? 'تعديل البلاغ' : 'إبلاغ');
      const reportForm = reportFormEl(d, () => {
        reportForm.hidden = true;
        reportBtn.setAttribute('aria-expanded', 'false');
        if (st.toolsDirty) renderTools();
        tools.querySelector('[data-key="report"]')?.focus();
      });
      reportForm.hidden = true;
      reportBtn.addEventListener('click', () => {
        reportForm.hidden = !reportForm.hidden;
        reportBtn.setAttribute('aria-expanded', String(!reportForm.hidden));
        if (!reportForm.hidden) reportForm.querySelector('select')?.focus();
      });
      btns.append(reportBtn);
      actions.append(btns, reportForm);

      mount(tools, phoneRow, locRow, actions);
      if (focusKey) tools.querySelector(`[data-key="${focusKey}"]`)?.focus();
    }

    function reportFormEl(d, done) {
      const selId = uid('report-reason');
      const noteId = uid('report-note');
      const sel = h('select', { class: 'select', id: selId }, REPORT_REASONS.map(([v, l]) => h('option', { value: v }, l)));
      const note = h('textarea', { class: 'input cx-report-note', id: noteId, rows: 2, maxLength: 500, dir: 'auto', placeholder: 'تفاصيل (اختياري)' });
      const form = h('form', { class: 'cx-report', novalidate: true },
        h('label', { class: 'field-label', for: selId }, 'سبب البلاغ'), sel,
        h('label', { class: 'field-label', for: noteId }, 'ملاحظة'), note,
        h('p', { class: 'muted cx-hint' }, 'يراجع فريقنا البلاغ. لا يُعاقَب أحد تلقائيًا، ولا يُخبَر الطرف الآخر.'),
        h('div', { class: 'cx-actions' }, h('button', { type: 'submit', class: 'btn btn-sm btn-primary' }, 'إرسال البلاغ')));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const r = await api.post(`/api/connections/${id}/report`, { reason: sel.value, note: note.value.trim() || null });
          toast(r.noteAr ?? 'وصلنا بلاغك.', { kind: 'success' });
          st.detail = { ...d, reportedByMe: true };
          done();
        } catch (err) { toast(err.messageAr ?? 'تعذّر إرسال البلاغ', { kind: 'error' }); }
      });
      return form;
    }

    function renderAll() { renderHeader(); renderTools(); renderMessages(); }

    async function refresh() {
      try {
        const r = await api.get(`/api/connections/${id}`);
        st.detail = r.connection;
        st.theirRead = r.connection.them.lastReadSeq;
        renderHeader();
        renderTools();
        renderMessages();
      } catch (e) {
        if (e?.status === 404) { toast('لم تعد هذه المحادثة متاحة.', { kind: 'error' }); close(); }
      }
    }

    async function markRead() {
      if (!st.lastSeq || st.lastSeq <= st.readSent || document.visibilityState === 'hidden') return;
      st.readSent = st.lastSeq;
      api.post(`/api/connections/${id}/read`, { seq: st.lastSeq }).catch(() => { st.readSent = 0; });
    }

    async function load() {
      try {
        const [d, page] = await Promise.all([api.get(`/api/connections/${id}`), api.get(`/api/connections/${id}/messages?limit=30`)]);
        st.detail = d.connection;
        st.items = page.items.slice().reverse();
        st.olderCursor = page.nextCursor;
        st.lastSeq = st.items.length ? st.items[st.items.length - 1].seq : 0;
        st.theirRead = page.lastReadSeq?.theirs ?? d.connection.them.lastReadSeq;
        renderHeader();
        renderTools();
        renderMessages({ stick: true });
        title.focus();
        void markRead();
        // relative times ("قبل دقيقة", "ينتهي بعد ١٢ دقيقة") stay current; tools only while a share is live
        st.tick = setInterval(() => {
          if (!st.detail) return;
          renderMessages();
          if ((st.detail.me.location.active || st.detail.them.location.active) && !tools.contains(document.activeElement)) renderTools();
        }, 30_000);
      } catch (e) {
        toast(e.messageAr ?? 'تعذّر فتح المحادثة', { kind: 'error' });
        close();
      }
    }

    async function loadOlder() {
      if (!st.olderCursor) return;
      olderBtn.disabled = true;
      try {
        const page = await api.get(`/api/connections/${id}/messages?limit=30&cursor=${encodeURIComponent(st.olderCursor)}`);
        st.items = page.items.slice().reverse().concat(st.items);
        st.olderCursor = page.nextCursor;
        renderMessages({ keepScroll: true });
      } catch (e) { toast(e.messageAr ?? 'تعذّر التحميل', { kind: 'error' }); }
      finally { olderBtn.disabled = false; (olderBtn.hidden ? log : olderBtn).focus(); }
    }

    async function loadNew() {
      if (st.loadingNew) { st.again = true; return; }
      st.loadingNew = true;
      try {
        const incoming = [];
        for (;;) {
          const r = await api.get(`/api/connections/${id}/messages?after=${st.lastSeq}&limit=100`);
          for (const m of r.items) {
            if (st.items.some((x) => x.seq === m.seq)) continue;
            // my own message sent from this tab is already on screen (pending): match it by clientMsgId
            const i = m.mine ? st.items.findIndex((x) => x.clientMsgId && x.clientMsgId === m.clientMsgId) : -1;
            if (i >= 0) st.items[i] = m; else { st.items.push(m); if (!m.mine) incoming.push(m); }
          }
          if (r.items.length) st.lastSeq = Math.max(st.lastSeq, ...r.items.map((m) => m.seq));
          st.theirRead = r.lastReadSeq?.theirs ?? st.theirRead;
          if (!r.more) break;
        }
        // keep server order; unsent (no seq yet) stay last
        st.items.sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity));
        renderMessages();
        if (incoming.length) {
          const who = st.detail?.counterpart?.displayName ?? 'الطرف الآخر';
          const last = incoming[incoming.length - 1];
          announcer.textContent = incoming.length === 1 ? `رسالة من ${who}: ${last.text}` : `${toArabicDigits(incoming.length)} رسائل جديدة من ${who}. آخرها: ${last.text}`;
        }
        void markRead();
      } catch { /* the next event retries */ }
      finally {
        st.loadingNew = false;
        if (st.again) { st.again = false; void loadNew(); }
      }
    }

    async function deliver(m) {
      m._state = { pending: true };
      renderMessages({ stick: true });
      try {
        const r = await api.post(`/api/connections/${id}/messages`, { text: m.text, clientMsgId: m.clientMsgId });
        const i = st.items.indexOf(m);
        const done = r.message;
        if (i >= 0) st.items[i] = done;
        st.lastSeq = Math.max(st.lastSeq, done.seq);
        st.readSent = Math.max(st.readSent, done.seq);
        renderMessages();
      } catch (e) {
        m._state = { failed: true };
        renderMessages();
        if (e?.status === 409 && e.code === 'connection_not_open') { toast(e.messageAr, { kind: 'error' }); await refresh(); }
        else if (e?.status === 429) toast(e.messageAr ?? 'رسائل كثيرة بسرعة. انتظر قليلًا.', { kind: 'warning' });
      }
    }

    function retry(m) { void deliver(m); }

    async function submit() {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      if ([...text].length > MAX_CHARS) { toast(`الرسالة طويلة. الحد ${toArabicDigits(MAX_CHARS)} حرف.`, { kind: 'error' }); input.focus(); return; }
      const m = { mine: true, text, clientMsgId: newId(), createdAt: new Date().toISOString() };
      st.items.push(m);
      input.value = '';
      updateCounter();
      input.focus();
      await deliver(m);
    }

    const onVisible = () => { if (document.visibilityState === 'visible') void markRead(); };
    document.addEventListener('visibilitychange', onVisible);

    let closing = null;
    function close() {
      if (closing) return closing;
      clearInterval(st.tick);
      document.removeEventListener('visibilitychange', onVisible);
      if (chat?.id === id) chat = null;
      closing = closeSheet();
      return closing;
    }

    return {
      id, load, close, refresh,
      onMessage: () => loadNew(),
      onLocation: async () => {
        try {
          const loc = await api.get(`/api/connections/${id}/location`);
          if (st.detail) { st.detail = { ...st.detail, me: { ...st.detail.me, location: loc.mine }, them: { ...st.detail.them, location: loc.theirs } }; renderTools(); }
        } catch { /* ignore */ }
      },
    };
  }

  return {
    openChat,
    isOpen: () => !!chat,
    /** SSE events (they carry no ids: refresh what is open, or tell the user about the newest unread chat) */
    async onEvent(type) {
      if (type === 'conn_message') {
        if (chat) { await chat.onMessage(); return; }
        try {
          const page = await api.get('/api/connections?limit=1');
          const c = page.items[0];
          if (c && c.unread > 0) toast(`رسالة جديدة من ${ar(c.counterpart.displayName)}`, { kind: 'info', actionLabel: 'فتح', onAction: () => openChat(c.id) });
        } catch { /* ignore */ }
      } else if (type === 'conn_location') {
        await chat?.onLocation();
      } else if (type === 'conn_update') {
        if (chat) { await chat.refresh(); return; }
        // a location share that started/ended has a notification: show IT (with «فتح المحادثة») instead of a generic toast
        try {
          const page = await api.get('/api/notifications?unread=1&limit=1');
          const n = page.items[0];
          if (n && /^location_share_/.test(n.kind) && n.payload?.connectionId && Date.now() - Date.parse(n.createdAt) < 30_000) {
            toast(ar(n.titleAr), { kind: 'info', actionLabel: 'فتح المحادثة', onAction: () => openChat(n.payload.connectionId) });
          }
        } catch { /* ignore */ }
      }
    },
    stopAllSharing() { for (const id of [...sharing.keys()]) stopWatching(id); },
  };
}

// ───────────────────────── account recovery screens ─────────────────────────

/** «احفظ هذا الرمز»: shown once after registration (or a regeneration). Resolves when the user confirms. */
export function showRecoveryCode(code, { titleAr = 'احفظ هذا الرمز', introAr } = {}) {
  return new Promise((resolve) => {
    const titleId = uid('rc-title');
    const descId = uid('rc-desc');
    const codeEl = h('p', { class: 'cx-code', dir: 'ltr', tabIndex: 0, 'aria-label': `الرمز: ${code.split('').join(' ')}` }, code);
    const copied = h('p', { class: 'cx-copied', role: 'status' });
    const copyBtn = h('button', { type: 'button', class: 'btn btn-sm' }, icon('checkAll', { size: 16 }), 'نسخ الرمز');
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); copied.textContent = 'نُسخ الرمز. ألصقه في مكان آمن.'; }
      catch {
        const r = document.createRange(); r.selectNodeContents(codeEl);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        copied.textContent = 'حدّدنا الرمز — انسخه يدويًا.';
      }
    });
    const checkId = uid('rc-ok');
    const check = h('input', { type: 'checkbox', id: checkId, class: 'cx-check' });
    const doneBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, 'حفظته، تابع');
    check.addEventListener('change', () => { doneBtn.disabled = !check.checked; });
    const { close } = openSheet({
      labelledBy: titleId, describedBy: descId, className: 'cx-sheet cx-code-sheet', dismissible: false,
      children: [
        h('header', { class: 'sheet-head' }, h('h2', { class: 'sheet-title', id: titleId }, titleAr)),
        h('p', { class: 'sheet-sub', id: descId }, introAr ?? 'هذا رمز الاسترداد: طريقتك الوحيدة للرجوع إلى حسابك بعد الخروج أو على جهاز آخر. لن نعرضه مرة ثانية.'),
        codeEl,
        h('div', { class: 'cx-actions' }, copyBtn),
        copied,
        h('ul', { class: 'cx-tips' },
          h('li', null, 'اكتبه على ورقة أو احفظه في ملاحظات هاتفك.'),
          h('li', null, 'لا تعطه لأحد: من يملكه يدخل إلى حسابك.'),
          h('li', null, 'إذا ضاع، أنشئ رمزًا جديدًا من «خروج» ما دمت داخل حسابك.')),
        h('div', { class: 'cx-check-row' }, check, h('label', { for: checkId }, 'كتبت الرمز أو حفظته في مكان آمن')),
        h('footer', { class: 'sheet-foot' }, doneBtn),
      ],
    });
    doneBtn.addEventListener('click', async () => { await close(); resolve(); });
    copyBtn.focus();
  });
}

/** Logout of a REAL account: warn that the recovery code is needed to come back. */
export function confirmLogout({ onLogout, onNewCode }) {
  const titleId = uid('lo-title');
  const descId = uid('lo-desc');
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, 'إلغاء');
  const out = h('button', { type: 'button', class: 'btn btn-danger' }, 'خروج');
  const newCode = h('button', { type: 'button', class: 'btn' }, 'أنشئ رمز استرداد جديد أولًا');
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const { close } = openSheet({
    labelledBy: titleId, describedBy: descId, className: 'cx-sheet cx-confirm', onDismiss: () => close(),
    children: [
      h('header', { class: 'sheet-head' }, h('h2', { class: 'sheet-title', id: titleId }, 'تأكيد الخروج')),
      h('p', { class: 'sheet-sub cx-warn', id: descId }, icon('alert', { size: 18 }),
        'لتعود إلى حسابك وطلباتك بعد الخروج ستحتاج رمز الاسترداد الذي حفظته عند التسجيل. بدونه لا يمكن الرجوع.'),
      err,
      h('footer', { class: 'sheet-foot cx-confirm-foot' }, out, newCode, cancel),
    ],
  });
  cancel.addEventListener('click', () => close());
  out.addEventListener('click', async () => {
    out.disabled = true;
    try { await onLogout(); } catch (e) { err.hidden = false; err.textContent = e?.messageAr ?? 'تعذّر الخروج'; out.disabled = false; }
  });
  newCode.addEventListener('click', async () => {
    newCode.disabled = true;
    try { await close(); await onNewCode(); } catch (e) { toast(e?.messageAr ?? 'تعذّر إنشاء رمز جديد', { kind: 'error' }); }
  });
  cancel.focus();
}

/** Login page section: come back to a real account with its recovery code. */
export function recoverSection({ onRecover }) {
  const headId = uid('rec-h');
  const codeId = uid('rec-code');
  const nameId = uid('rec-name');
  const code = h('input', { class: 'input cx-code-input', id: codeId, dir: 'ltr', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, maxLength: 40, placeholder: 'XXXX-XXXX-XXXX-XXXX', required: true });
  const name = h('input', { class: 'input', id: nameId, autocomplete: 'nickname', maxLength: 80, placeholder: 'اختياري' });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'ارجع إلى حسابي');
  const form = h('form', { class: 'editor-form', novalidate: true },
    h('label', { class: 'field-label', for: codeId }, 'رمز الاسترداد'), code,
    h('label', { class: 'field-label', for: nameId }, 'اسمك كما سجّلته (اختياري)'), name,
    err, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!code.value.trim()) { code.focus(); return; }
    submit.disabled = true;
    try { await onRecover({ code: code.value.trim(), displayName: name.value.trim() || undefined }); }
    catch (ex) {
      err.hidden = false;
      err.textContent = ex?.messageAr ?? 'تعذّر الدخول';
      code.setAttribute('aria-invalid', 'true');
      code.focus();
    } finally { submit.disabled = false; }
  });
  return h('section', { class: 'panel', 'aria-labelledby': headId },
    h('h2', { class: 'panel-title', id: headId }, 'عندك حساب؟ ارجع إليه برمز الاسترداد'),
    h('p', { class: 'panel-hint' }, 'الرمز الذي ظهر لك عند التسجيل (١٦ حرفًا ورقمًا). يمكنك كتابته بالأرقام العربية أو الإنجليزية.'),
    form);
}
