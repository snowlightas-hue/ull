// Cards: IntentCard and MatchCard renderers (pure view; all actions go through handlers).
import { h, uid, srOnly, append } from './dom.js';
import { icon } from './icons.js';
import { ar, formatRelativeTime, formatDateTime, formatNumber, formatScore, telHref } from './format.js';

export const STATUS_AR = {
  active: 'نشط',
  paused: 'موقوف مؤقتًا',
  fulfilled: 'تمت التلبية',
  closed: 'مغلق',
  expired: 'منتهي الصلاحية',
};

export const SIDE_AR = {
  seek: { labelAr: 'أبحث عن', icon: 'search' },
  provide: { labelAr: 'أعرض', icon: 'tag' },
  join: { labelAr: 'نشاط مشترك', icon: 'people' },
};

export const MATCH_STATE_AR = {
  confirmed: { labelAr: 'مؤكدة', icon: 'check' },
  possible: { labelAr: 'محتملة — تحتاج تأكيد', icon: 'question' },
  invalidated: { labelAr: 'لم تعد مطابقة', icon: 'minus' },
};

export const POLARITY_AR = {
  plus: { icon: 'check', srAr: 'متوافق:' },
  minus: { icon: 'minus', srAr: 'غير متوافق:' },
  unknown: { icon: 'question', srAr: 'غير معروف بعد:' },
  info: { icon: 'info', srAr: 'معلومة:' },
};

export const STRENGTH_AR = { required: 'شرط أساسي', preferred: 'تفضيل' };

const MISSING_AR = 'غير محدد';

/** Metadata separator: a drawn bar, not "·" (which reads like the Arabic-Indic zero "٠"). */
export function sep() {
  return h('span', { class: 'sep', 'aria-hidden': 'true' });
}

/** <time> with a relative label and the absolute date as tooltip. */
export function timeEl(iso, prefixAr = '') {
  if (!iso) return null;
  const rel = formatRelativeTime(iso);
  if (!rel) return null;
  return h('time', { datetime: String(iso), title: formatDateTime(iso) }, prefixAr ? `${prefixAr} ${rel}` : rel);
}

/** A single fact row (icon + sr label + value or a "missing" marker). */
function fact(iconName, labelAr, value) {
  const has = value !== null && value !== undefined && String(value).trim() !== '';
  return h('div', { class: ['fact', !has && 'fact-missing'] },
    h('dt', null, icon(iconName, { size: 16 }), srOnly(labelAr)),
    h('dd', null, has ? ar(value) : h('span', { class: 'missing', title: `${labelAr}: ${MISSING_AR}` }, `${labelAr}: ${MISSING_AR}`)));
}

/** Chips list from IntentCard.chips (with required/preferred marker). */
export function chipList(chips, { compact = false } = {}) {
  if (!Array.isArray(chips) || chips.length === 0) return null;
  return h('ul', { class: ['chips', compact && 'chips-compact'], role: 'list' },
    chips.map((c) => {
      const strength = c.strength === 'required' || c.strength === 'preferred' ? c.strength : null;
      return h('li', { class: ['chip', strength && `chip-${strength}`] },
        c.labelAr ? h('span', { class: 'chip-label' }, ar(c.labelAr)) : null,
        h('span', { class: 'chip-value' }, ar(c.valueAr ?? '')),
        strength ? h('span', { class: 'chip-strength' }, STRENGTH_AR[strength]) : null);
    }));
}

/** Run a handler; if it returns a promise, show a busy state on `btn` until it settles. */
function runAction(btn, fn, busyLabelAr) {
  if (typeof fn !== 'function') return;
  if (btn.dataset.busy === 'true') return;
  const result = fn();
  if (result && typeof result.then === 'function') {
    const prev = Array.from(btn.childNodes);
    // aria-disabled (not `disabled`) keeps keyboard focus on the button while busy, so dialogs can return focus to it
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
    btn.dataset.busy = 'true';
    if (busyLabelAr) btn.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabelAr);
    result.then(
      () => { if (btn.isConnected) restore(); },
      () => restore(),
    );
    function restore() {
      btn.removeAttribute('aria-busy');
      btn.removeAttribute('aria-disabled');
      delete btn.dataset.busy;
      btn.replaceChildren(...prev);
    }
  }
  return result;
}

/**
 * Two-step confirm for terminal actions (fulfil / close): first press arms the button for 4 s.
 */
function confirmButton({ labelAr, confirmAr, iconName, className, onConfirm }) {
  let armed = false;
  let timer = 0;
  const label = h('span', null, labelAr);
  const btn = h('button', { type: 'button', class: ['btn', 'btn-sm', className] }, icon(iconName, { size: 16 }), label);
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.dataset.armed = 'true';
      label.textContent = confirmAr;
      clearTimeout(timer);
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    runAction(btn, onConfirm, 'جارٍ التنفيذ…');
  });
  btn.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== btn) disarm(); }, 150));
  function disarm() {
    armed = false;
    clearTimeout(timer);
    delete btn.dataset.armed;
    label.textContent = labelAr;
  }
  return btn;
}

/**
 * intentCard(intent: IntentCard, handlers?) → <article>
 * handlers: { onEdit(intent), onStatus(intent, 'pause'|'resume'|'fulfill'|'close'), onOpenMatches?(intent) }
 * Handlers may return a Promise; the pressed button shows a busy state until it settles.
 */
export function intentCard(intent, handlers = {}) {
  const i = intent || {};
  const titleId = uid('intent-title');
  const side = SIDE_AR[i.side] ?? SIDE_AR.seek;
  const status = String(i.status || 'active');
  const statusAr = STATUS_AR[status] ?? ar(status);
  const live = status === 'active' || status === 'paused';

  const confirmed = Number(i.matchCounts?.confirmed) || 0;
  const possible = Number(i.matchCounts?.possible) || 0;
  let matches = null;
  if (confirmed + possible > 0) {
    const text = [
      confirmed ? `${formatNumber(confirmed)} مؤكدة` : null,
      possible ? `${formatNumber(possible)} محتملة` : null,
    ].filter(Boolean).join('، ');
    matches = typeof handlers.onOpenMatches === 'function'
      ? h('button', { type: 'button', class: 'link-btn ic-matches', onClick: () => handlers.onOpenMatches(i) }, icon('link', { size: 16 }), `المطابقات: ${text}`)
      : h('p', { class: 'ic-matches' }, icon('link', { size: 16 }), `المطابقات: ${text}`);
  } else if (live) {
    matches = h('p', { class: 'ic-matches ic-matches-none' }, icon('bell', { size: 16 }), 'لا مطابقات بعد — سننبهك عند ظهورها');
  }

  const actions = [];
  if (live && typeof handlers.onEdit === 'function') {
    actions.push(h('button', { type: 'button', class: 'btn btn-sm', onClick: (e) => runAction(e.currentTarget, () => handlers.onEdit(i)) },
      icon('edit', { size: 16 }), 'تعديل'));
  }
  if (typeof handlers.onStatus === 'function') {
    if (status === 'active') {
      actions.push(h('button', { type: 'button', class: 'btn btn-sm', onClick: (e) => runAction(e.currentTarget, () => handlers.onStatus(i, 'pause'), 'جارٍ الإيقاف…') },
        icon('pause', { size: 16 }), 'إيقاف'));
    } else if (status === 'paused') {
      actions.push(h('button', { type: 'button', class: 'btn btn-sm', onClick: (e) => runAction(e.currentTarget, () => handlers.onStatus(i, 'resume'), 'جارٍ الاستئناف…') },
        icon('play', { size: 16 }), 'استئناف'));
    }
    if (live) {
      actions.push(confirmButton({ labelAr: 'تمت تلبية الحاجة', confirmAr: 'تأكيد: تمت التلبية؟', iconName: 'check', className: 'btn-ok', onConfirm: () => handlers.onStatus(i, 'fulfill') }));
      actions.push(confirmButton({ labelAr: 'إغلاق', confirmAr: 'تأكيد الإغلاق؟', iconName: 'close', className: 'btn-danger', onConfirm: () => handlers.onStatus(i, 'close') }));
    }
  }

  const dates = [
    timeEl(i.createdAt, 'أُضيف'),
    i.updatedAt && i.updatedAt !== i.createdAt ? timeEl(i.updatedAt, 'عُدّل') : null,
    i.expiresAt && live ? timeEl(i.expiresAt, 'ينتهي') : null,
  ].filter(Boolean);

  return h('article', { class: 'card intent-card', dataset: { status, side: i.side || 'seek', id: i.id }, 'aria-labelledby': titleId },
    h('header', { class: 'card-head' },
      h('span', { class: ['side-tag', `side-${i.side || 'seek'}`] }, icon(side.icon, { size: 15 }), side.labelAr),
      h('span', { class: ['status-chip', `status-${status}`] }, statusAr),
      i.synthetic ? h('span', { class: 'demo-tag', title: 'بيانات تجريبية' }, 'تجريبي') : null),
    h('h3', { class: 'card-title', id: titleId }, ar(i.titleAr || 'طلب بدون عنوان')),
    h('dl', { class: 'facts' },
      fact('grid', 'الفئة', [i.categoryAr, i.dealAr].filter(Boolean).join('، ') || null),
      fact('pin', 'المكان', i.placeAr),
      fact('money', 'السعر', i.priceAr),
      fact('calendar', 'الموعد', i.whenAr)),
    chipList(i.chips),
    matches,
    dates.length ? h('p', { class: 'card-dates' }, dates.flatMap((d, k) => (k ? [sep(), d] : [d]))) : null,
    actions.length ? h('footer', { class: 'card-actions' }, actions) : null);
}

/** Group reasons: required first, then preferred, then everything else. */
function reasonGroups(reasons) {
  const req = [];
  const pref = [];
  const other = [];
  for (const r of reasons || []) {
    if (r.strength === 'required') req.push(r);
    else if (r.strength === 'preferred') pref.push(r);
    else other.push(r);
  }
  return [
    { titleAr: 'الشروط الأساسية', items: req, strength: 'required' },
    { titleAr: 'التفضيلات', items: pref, strength: 'preferred' },
    { titleAr: 'ملاحظات', items: other, strength: null },
  ].filter((g) => g.items.length);
}

function reasonItem(r) {
  const pol = POLARITY_AR[r.polarity] ?? POLARITY_AR.info;
  return h('li', { class: 'reason', dataset: { polarity: r.polarity || 'info' } },
    h('span', { class: 'reason-icon' }, icon(pol.icon, { size: 14 })),
    h('span', { class: 'reason-text' }, srOnly(pol.srAr + ' '), ar(r.text)));
}

/** Compact counterpart (the "other" IntentCard) block. */
function counterpart(other, contact) {
  const o = other || {};
  const accepted = contact?.status === 'accepted';
  return h('section', { class: 'counterpart', 'aria-label': 'الطرف الآخر' },
    h('div', { class: 'counterpart-head' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, icon(accepted ? 'user' : 'lock', { size: 18 })),
      h('div', { class: 'counterpart-who' },
        h('p', { class: 'counterpart-name' }, accepted && contact.counterpart?.displayName
          ? ar(contact.counterpart.displayName)
          : (o.side === 'seek' ? 'صاحب الطلب' : o.side === 'join' ? 'مشارك في النشاط' : 'صاحب العرض')),
        h('p', { class: 'counterpart-note' }, accepted ? 'تم قبول التواصل' : 'تظهر الهوية بعد قبول طلب التواصل'))),
    h('dl', { class: 'facts facts-compact' },
      fact('grid', 'الفئة', [o.categoryAr, o.dealAr].filter(Boolean).join('، ') || null),
      fact('pin', 'المكان', o.placeAr),
      fact('money', 'السعر', o.priceAr),
      fact('calendar', 'الموعد', o.whenAr)),
    chipList(o.chips, { compact: true }));
}

function contactBlock(m, handlers, card) {
  const c = m.contact || { status: 'none' };
  if (m.state === 'invalidated') return null;
  switch (c.status) {
    case 'pending_out':
      return h('div', { class: 'contact contact-pending' },
        h('p', { class: 'contact-status', role: 'status' }, icon('hourglass', { size: 16 }), 'أُرسل طلب التواصل — بانتظار موافقة الطرف الآخر'));
    case 'pending_in': {
      const respond = (accept) => (e) => runAction(e.currentTarget, () => handlers.onRespond?.(m, accept), accept ? 'جارٍ القبول…' : 'جارٍ الرفض…');
      return h('div', { class: 'contact contact-incoming' },
        h('p', { class: 'contact-status' }, icon('bell', { size: 16 }), 'الطرف الآخر يطلب التواصل معك'),
        h('div', { class: 'contact-actions' },
          h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: respond(true) }, icon('check', { size: 16 }), 'قبول ومشاركة رقمي'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: respond(false) }, 'رفض')));
    }
    case 'accepted': {
      const cp = c.counterpart || {};
      const href = telHref(cp.phone);
      return h('div', { class: 'contact contact-accepted' },
        h('p', { class: 'contact-status' }, icon('check', { size: 16 }), 'تم قبول التواصل'),
        h('div', { class: 'contact-person' },
          h('span', { class: 'avatar avatar-ok', 'aria-hidden': 'true' }, icon('user', { size: 18 })),
          h('div', null,
            h('p', { class: 'contact-name' }, ar(cp.displayName || 'الطرف الآخر')),
            cp.phone
              ? h('a', { class: 'phone', href, dir: 'ltr' }, String(cp.phone))
              : h('p', { class: 'muted' }, 'لم يشارك رقم هاتف بعد')),
          href ? h('a', { class: 'btn btn-primary btn-sm', href }, icon('phone', { size: 16 }), 'اتصال') : null));
    }
    case 'declined':
      return h('div', { class: 'contact contact-declined' },
        h('p', { class: 'contact-status' }, icon('info', { size: 16 }), 'اعتذر الطرف الآخر عن التواصل'));
    default: {
      if (typeof handlers.onContact !== 'function') return null;
      const btn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('link', { size: 18 }), 'طلب تواصل');
      btn.addEventListener('click', () => {
        const res = runAction(btn, () => handlers.onContact(m), 'جارٍ الإرسال…');
        if (res && typeof res.then === 'function') {
          res.then((updated) => {
            if (updated && typeof updated === 'object' && updated.id === m.id && card.isConnected) {
              card.replaceWith(matchCard(updated, handlers));
            }
          }, (err) => {
            const msg = err?.messageAr || 'تعذّر إرسال طلب التواصل، حاول مرة أخرى.';
            const errEl = card.querySelector('.contact-error') || h('p', { class: 'contact-error', role: 'alert' });
            errEl.textContent = ar(msg);
            btn.after(errEl);
          });
        }
      });
      return h('div', { class: 'contact contact-none' },
        btn,
        h('p', { class: 'contact-hint' }, m.state === 'possible'
          ? 'الخطوة التالية: تواصل لتأكيد المعلومات الناقصة. لا تظهر بياناتك إلا بعد موافقتك.'
          : 'الخطوة التالية: أرسل طلب تواصل. لا تظهر بياناتك إلا بعد موافقة الطرفين.'));
    }
  }
}

/**
 * matchCard(match: MatchCard, handlers?) → <article>
 * handlers: { onContact(match) → Promise<MatchCard|void>?, onRespond(match, accept:boolean), onOpenIntent?(intent) }
 * If onContact resolves with an updated MatchCard (same id) the card re-renders itself in place.
 */
export function matchCard(match, handlers = {}) {
  const m = match || {};
  const state = MATCH_STATE_AR[m.state] ? m.state : 'possible';
  const st = MATCH_STATE_AR[state];
  const titleId = uid('match-title');
  const card = h('article', { class: ['card', 'match-card', `match-${state}`], dataset: { state, id: m.id }, 'aria-labelledby': titleId });

  const groups = reasonGroups(m.reasons);
  const missing = Array.isArray(m.missing) && m.missing.length ? m.missing.map(ar) : null;
  const kindAr = m.kind === 'peer' ? 'نشاط مشترك' : null;

  append(card, [
    h('header', { class: 'card-head' },
      h('span', { class: ['state-badge', `state-${state}`] }, icon(st.icon, { size: 15 }), st.labelAr),
      kindAr ? h('span', { class: 'side-tag side-join' }, icon('people', { size: 15 }), kindAr) : null,
      Number.isFinite(Number(m.score)) && state !== 'invalidated'
        ? h('span', { class: 'score', title: 'درجة التطابق' }, srOnly('درجة التطابق '), formatScore(m.score))
        : null),
    h('h3', { class: 'card-title', id: titleId }, ar(m.other?.titleAr || 'مطابقة')),
    state === 'invalidated' && m.invalidReasonAr
      ? h('p', { class: 'invalid-reason' }, icon('info', { size: 16 }), ar(m.invalidReasonAr))
      : null,
    counterpart(m.other, m.contact),
    groups.length
      ? h('section', { class: 'reasons-block', 'aria-label': 'أسباب المطابقة' },
        h('h4', { class: 'reasons-title' }, state === 'invalidated' ? 'ما الذي تغيّر؟' : state === 'possible' ? 'لماذا قد تناسبك؟' : 'لماذا تناسبك؟'),
        groups.map((g) => h('div', { class: 'reason-group', dataset: { strength: g.strength || 'none' } },
          h('p', { class: 'reason-group-title' }, g.titleAr),
          h('ul', { class: 'reasons', role: 'list' }, g.items.map(reasonItem)))))
      : null,
    missing
      ? h('p', { class: 'missing-facts' }, icon('question', { size: 16 }), h('span', null, h('strong', null, 'ناقص للتأكيد: '), missing.join('، ')))
      : null,
    m.mine
      ? h('p', { class: 'mine-ref' },
        m.mine.side === 'provide' ? 'لعرضك: ' : m.mine.side === 'join' ? 'لنشاطك: ' : 'لطلبك: ',
        typeof handlers.onOpenIntent === 'function'
          ? h('button', { type: 'button', class: 'link-btn', onClick: () => handlers.onOpenIntent(m.mine) }, `«${ar(m.mine.titleAr)}»`)
          : h('span', { class: 'mine-title' }, `«${ar(m.mine.titleAr)}»`),
        m.updatedAt ? [sep(), timeEl(m.updatedAt, 'حُدّثت')] : null)
      : null,
  ]);
  const contact = contactBlock(m, handlers, card);
  if (contact) card.append(h('footer', { class: 'card-actions card-actions-match' }, contact));
  return card;
}
