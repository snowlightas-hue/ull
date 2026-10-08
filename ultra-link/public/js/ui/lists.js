// Paginated lists rendered from Page<T> (docs/CONTRACTS.md). Pure view: paging, filters and actions
// are forwarded to handlers; the caller fetches the next Page and calls the renderer again.
import { h, uid, mount, append } from './dom.js';
import { icon } from './icons.js';
import { ar, formatRange, formatNumber, formatCount, NOUNS } from './format.js';
import { intentCard, matchCard, timeEl } from './cards.js';

/** Remember which pager button was pressed so focus can be restored after the caller re-renders. */
const pendingFocus = new WeakMap();

function pager(el, page, handlers) {
  const p = page || {};
  const total = Number(p.total) || 0;
  const prevOk = p.prevCursor !== null && p.prevCursor !== undefined && p.prevCursor !== '';
  const nextOk = p.nextCursor !== null && p.nextCursor !== undefined && p.nextCursor !== '';
  const rangeText = formatRange(p.rangeStart, p.rangeEnd, total);

  const mk = (dir) => {
    const ok = dir === 'prev' ? prevOk : nextOk;
    const btn = h('button', {
      type: 'button', class: 'btn btn-sm pager-btn', dataset: { dir },
      'aria-disabled': ok ? 'false' : 'true',
      'aria-label': dir === 'prev' ? 'الصفحة السابقة' : 'الصفحة التالية',
    },
    dir === 'prev' ? icon('chevronRight', { size: 18 }) : null,
    h('span', { class: 'pager-btn-text' }, dir === 'prev' ? 'السابق' : 'التالي'),
    dir === 'next' ? icon('chevronLeft', { size: 18 }) : null);
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-disabled') === 'true' || typeof handlers.onPage !== 'function') return;
      pendingFocus.set(el, dir);
      el.setAttribute('aria-busy', 'true');
      handlers.onPage(dir, dir === 'prev' ? p.prevCursor : p.nextCursor, p);
    });
    return btn;
  };

  return h('nav', { class: 'pager', 'aria-label': 'التنقل بين الصفحات' },
    mk('prev'),
    h('p', { class: 'pager-range', tabIndex: -1, 'aria-live': 'polite' }, rangeText),
    mk('next'));
}

function restoreFocus(el) {
  const dir = pendingFocus.get(el);
  el.removeAttribute('aria-busy');
  if (!dir) return;
  pendingFocus.delete(el);
  const btn = el.querySelector(`.pager-btn[data-dir="${dir}"]`);
  const target = btn && btn.getAttribute('aria-disabled') !== 'true' ? btn : el.querySelector('.pager-range');
  // bring the top of the new page into view, then keep keyboard focus on the pager
  const top = el.querySelector('.list-toolbar') || el;
  top.scrollIntoView({ block: 'start', behavior: 'auto' });
  target?.focus({ preventScroll: true });
}

function toolbar(page, extra) {
  const total = Number(page?.total) || 0;
  return h('div', { class: 'list-toolbar' },
    h('p', { class: 'list-range' }, total > 0 ? formatRange(page.rangeStart, page.rangeEnd, total) : ''),
    extra || null);
}

/**
 * renderEmpty(el, textAr, { actionLabelAr?, onAction?, icon? }) — calm empty state.
 */
export function renderEmpty(el, textAr, opts = {}) {
  el.removeAttribute('aria-busy');
  el.replaceChildren(h('div', { class: 'empty' },
    h('span', { class: 'empty-art', 'aria-hidden': 'true' },
      h('span', { class: 'empty-ring' }), h('span', { class: 'empty-ring' }), icon(opts.icon || 'inbox', { size: 28 })),
    h('p', { class: 'empty-text' }, ar(textAr || 'لا يوجد شيء هنا بعد')),
    typeof opts.onAction === 'function' && opts.actionLabelAr
      ? h('button', { type: 'button', class: 'btn btn-primary', onClick: opts.onAction }, icon('mic', { size: 18 }), ar(opts.actionLabelAr))
      : null));
  return el;
}

/** renderLoading(el, textAr?) — skeleton placeholder while a page loads. */
export function renderLoading(el, textAr = 'جارٍ التحميل…') {
  el.setAttribute('aria-busy', 'true');
  el.replaceChildren(h('div', { class: 'loading', role: 'status' },
    h('span', { class: 'sr-only' }, textAr),
    [0, 1, 2].map(() => h('div', { class: 'skeleton', 'aria-hidden': 'true' },
      h('span', { class: 'sk-line sk-short' }), h('span', { class: 'sk-line' }), h('span', { class: 'sk-line sk-mid' })))));
  return el;
}

/** renderListError(el, messageAr, onRetry) — recoverable error inside a list view. */
export function renderListError(el, messageAr, onRetry) {
  el.removeAttribute('aria-busy');
  el.replaceChildren(h('div', { class: 'notice notice-error', role: 'alert' },
    h('span', { class: 'notice-icon', 'aria-hidden': 'true' }, icon('alert', { size: 22 })),
    h('div', { class: 'notice-body' },
      h('p', { class: 'notice-title' }, 'تعذّر التحميل'),
      h('p', null, ar(messageAr || 'تحقق من الاتصال ثم حاول مرة أخرى.')),
      typeof onRetry === 'function'
        ? h('div', { class: 'notice-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onClick: onRetry }, icon('refresh', { size: 18 }), 'إعادة المحاولة'))
        : null)));
  return el;
}

const INTENT_FILTERS = [
  { value: 'active', labelAr: 'الحالية' },
  { value: 'fulfilled', labelAr: 'تمت تلبيتها' },
  { value: 'closed', labelAr: 'المغلقة' },
  { value: 'expired', labelAr: 'المنتهية' },
  { value: 'all', labelAr: 'الكل' },
];

/** Scroll the checked filter option into view inside its strip (never scrolls the page). */
function revealChecked(root) {
  const strip = root.querySelector('.list-filter');
  const checked = strip?.querySelector('input:checked')?.parentElement;
  if (!strip || !checked) return;
  requestAnimationFrame(() => {
    const sr = strip.getBoundingClientRect();
    const cr = checked.getBoundingClientRect();
    if (cr.left < sr.left) strip.scrollLeft += cr.left - sr.left - 8;
    else if (cr.right > sr.right) strip.scrollLeft += cr.right - sr.right + 8;
  });
}

/** Segmented radio filter (native radios → arrow-key support for free). */
function segFilter(options, current, legendAr, onChange) {
  const name = uid('filter');
  return h('fieldset', { class: 'seg-field' },
    h('legend', { class: 'sr-only' }, legendAr),
    h('div', { class: 'seg seg-filter' }, options.map((f) => {
      const input = h('input', { type: 'radio', name, value: f.value, checked: f.value === current });
      input.addEventListener('change', () => { if (input.checked) onChange(f.value); });
      return h('label', null, input, h('span', null, f.labelAr));
    })));
}

/**
 * renderIntentPage(el, page: Page<IntentCard>, handlers)
 * handlers: { onPage(dir, cursor, page), onEdit(intent), onStatus(intent, action), onOpenMatches?(intent),
 *             onFilter?(status), filter?: 'active'|'fulfilled'|'closed'|'expired'|'all',
 *             emptyTextAr?, emptyActionLabelAr?, onEmptyAction? }
 */
export function renderIntentPage(el, page, handlers = {}) {
  const items = Array.isArray(page?.items) ? page.items : [];
  const filter = typeof handlers.onFilter === 'function'
    ? h('div', { class: 'list-filter' }, segFilter(INTENT_FILTERS, handlers.filter || 'active', 'تصفية حسب الحالة', handlers.onFilter))
    : null;
  if (items.length === 0 && !(Number(page?.total) > 0)) {
    const filtered = handlers.filter && handlers.filter !== 'active' && handlers.filter !== 'all';
    renderEmpty(el, filtered ? 'لا شيء بهذه الحالة.' : (handlers.emptyTextAr || 'لا يوجد شيء هنا بعد. اضغط على الميكروفون وقل ما تحتاجه.'), {
      actionLabelAr: filtered ? undefined : handlers.emptyActionLabelAr, onAction: filtered ? undefined : handlers.onEmptyAction, icon: 'inbox',
    });
    if (filter) el.prepend(filter);
    return el;
  }
  mount(el,
    filter,
    toolbar(page),
    h('ol', { class: 'card-list', role: 'list' }, items.map((it, i) =>
      h('li', { class: 'list-enter', style: { '--i': String(Math.min(i, 8)) } }, intentCard(it, handlers)))),
    pager(el, page, handlers));
  restoreFocus(el);
  revealChecked(el);
  return el;
}

const MATCH_FILTERS = [
  { value: 'active', labelAr: 'الكل' },
  { value: 'confirmed', labelAr: 'مؤكدة' },
  { value: 'possible', labelAr: 'محتملة' },
  { value: 'invalidated', labelAr: 'لم تعد مطابقة' },
];

function matchFilter(handlers) {
  if (typeof handlers.onFilter !== 'function') return null;
  return segFilter(MATCH_FILTERS, handlers.filter || 'active', 'تصفية المطابقات', handlers.onFilter);
}

/**
 * renderMatchPage(el, page: Page<MatchCard>, handlers)
 * handlers: { onPage, onContact(match), onRespond(match, accept), onOpenIntent?(intent),
 *             onFilter?(state), filter?: 'active'|'confirmed'|'possible'|'invalidated', emptyTextAr? }
 */
export function renderMatchPage(el, page, handlers = {}) {
  const items = Array.isArray(page?.items) ? page.items : [];
  const filter = matchFilter(handlers);
  if (items.length === 0 && !(Number(page?.total) > 0)) {
    renderEmpty(el, handlers.emptyTextAr || 'لا مطابقات بعد. سننبهك فور ظهور من يناسبك.', { icon: 'link' });
    if (filter) el.prepend(h('div', { class: 'list-filter' }, filter));
    return el;
  }
  mount(el,
    filter ? h('div', { class: 'list-filter' }, filter) : null,
    toolbar(page),
    h('ol', { class: 'card-list', role: 'list' }, items.map((m, i) =>
      h('li', { class: 'list-enter', style: { '--i': String(Math.min(i, 8)) } }, matchCard(m, handlers)))),
    pager(el, page, handlers));
  restoreFocus(el);
  revealChecked(el);
  return el;
}

const NOTIF_ICON = {
  match_new: 'link', new_match: 'link', match: 'link', match_possible: 'question', match_more: 'link',
  match_invalidated: 'alert', invalidated: 'alert',
  contact_request: 'phone', contact_requested: 'phone',
  contact_accepted: 'check', contact_declined: 'info',
  expiring: 'clock', intent_expiring: 'clock', intent_expired: 'clock',
};

function isUnread(n) {
  if (typeof n.read === 'boolean') return !n.read;
  if ('readAt' in n) return !n.readAt;
  if (typeof n.unread === 'boolean') return n.unread;
  return false;
}

/**
 * renderNotificationPage(el, page: Page<Notification> & { unread?: number }, handlers)
 * Notification (tolerant): { id, kind?, titleAr?, bodyAr?|textAr?|messageAr?, createdAt, readAt?|read? }
 * handlers: { onPage, onRead(notification) → Promise?, onReadAll() → Promise?, onOpen?(notification) }
 * Mark-as-read is optimistic; if the handler's promise rejects the item is restored.
 */
export function renderNotificationPage(el, page, handlers = {}) {
  const items = Array.isArray(page?.items) ? page.items : [];
  let unread = Number.isFinite(Number(page?.unread)) ? Number(page.unread) : items.filter(isUnread).length;

  const unreadText = h('p', { class: 'unread-summary', 'aria-live': 'polite' });
  const readAllBtn = h('button', { type: 'button', class: 'btn btn-sm' }, icon('checkAll', { size: 16 }), 'تحديد الكل كمقروء');
  const syncUnread = () => {
    unreadText.textContent = unread > 0 ? `غير المقروءة: ${formatNumber(unread)}` : 'لا تنبيهات غير مقروءة';
    readAllBtn.setAttribute('aria-disabled', unread > 0 ? 'false' : 'true');
  };
  syncUnread();

  if (items.length === 0 && !(Number(page?.total) > 0)) {
    renderEmpty(el, handlers.emptyTextAr || 'لا تنبيهات بعد. سنخبرك هنا عند ظهور مطابقة أو طلب تواصل.', { icon: 'bell' });
    return el;
  }

  const rows = items.map((n) => notificationItem(n));

  function notificationItem(n) {
    const titleId = uid('notif');
    const unreadNow = isUnread(n);
    const li = h('li', { class: 'notif', dataset: { unread: unreadNow ? 'true' : 'false', id: n.id, kind: n.kind || '' }, 'aria-labelledby': titleId });
    const body = n.bodyAr ?? n.textAr ?? n.messageAr ?? '';
    const readBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost notif-read' }, icon('check', { size: 16 }), 'تحديد كمقروء');
    readBtn.addEventListener('click', () => {
      if (li.dataset.unread !== 'true') return;
      setRead(true);
      const res = typeof handlers.onRead === 'function' ? handlers.onRead(n) : null;
      if (res && typeof res.then === 'function') res.catch(() => setRead(false));
    });
    function setRead(read) {
      const was = li.dataset.unread === 'true';
      li.dataset.unread = read ? 'false' : 'true';
      readBtn.hidden = read;
      srState.textContent = read ? '' : 'غير مقروء: ';
      if (was && read) unread = Math.max(0, unread - 1);
      if (!was && !read) unread += 1;
      syncUnread();
      if (read && document.activeElement === readBtn) li.querySelector('.notif-open, .notif-title')?.focus();
    }
    const srState = h('span', { class: 'sr-only' }, unreadNow ? 'غير مقروء: ' : '');
    readBtn.hidden = !unreadNow;
    const target = n.matchId || n.intentId || n.url || n.payload?.matchId || n.payload?.intentId || n.payload?.requestId;
    const openBtn = typeof handlers.onOpen === 'function' && target
      ? h('button', { type: 'button', class: 'btn btn-sm notif-open', onClick: () => { if (li.dataset.unread === 'true') setRead(true); handlers.onOpen(n); } }, 'عرض', icon('chevronLeft', { size: 16 }))
      : null;
    append(li, [
      h('span', { class: 'notif-icon', 'aria-hidden': 'true' }, icon(NOTIF_ICON[n.kind] || 'bell', { size: 18 }), h('span', { class: 'unread-dot' })),
      h('div', { class: 'notif-body' },
        h('p', { class: 'notif-title', id: titleId, tabIndex: -1 }, srState, ar(n.titleAr || body || 'تنبيه')),
        n.titleAr && body ? h('p', { class: 'notif-text' }, ar(body)) : null,
        h('p', { class: 'notif-time' }, timeEl(n.createdAt))),
      h('div', { class: 'notif-actions' }, readBtn, openBtn)]);
    return li;
  }

  readAllBtn.addEventListener('click', () => {
    if (readAllBtn.getAttribute('aria-disabled') === 'true') return;
    const changed = rows.filter((li) => li.dataset.unread === 'true');
    const prevUnread = unread;
    for (const li of changed) { li.dataset.unread = 'false'; li.querySelector('.notif-read').hidden = true; li.querySelector('.notif-title .sr-only').textContent = ''; }
    unread = 0;
    syncUnread();
    const res = typeof handlers.onReadAll === 'function' ? handlers.onReadAll() : null;
    if (res && typeof res.then === 'function') {
      res.catch(() => {
        for (const li of changed) { li.dataset.unread = 'true'; li.querySelector('.notif-read').hidden = false; li.querySelector('.notif-title .sr-only').textContent = 'غير مقروء: '; }
        unread = prevUnread;
        syncUnread();
      });
    }
  });

  mount(el,
    h('div', { class: 'list-toolbar list-toolbar-notif' },
      h('div', null, h('p', { class: 'list-range' }, formatRange(page.rangeStart, page.rangeEnd, page.total)), unreadText),
      readAllBtn),
    h('ol', { class: 'notif-list', role: 'list' }, rows),
    pager(el, page, handlers));
  restoreFocus(el);
  return el;
}

/** Plural helper re-exported for list headers ("٢٥٠ طلبًا"). */
export function countLabel(n, kind) {
  return formatCount(n, NOUNS[kind] || NOUNS.result);
}
