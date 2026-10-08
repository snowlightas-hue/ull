// Toasts for live notifications. One polite live region (role=status, aria-live=polite) is created
// once and reused, so screen readers announce each toast without stealing focus.
import { h } from './dom.js';
import { icon } from './icons.js';
import { ar } from './format.js';

const KIND_ICON = { info: 'bell', success: 'check', warning: 'alert', error: 'alert', match: 'link' };
const MAX_VISIBLE = 3;
let region = null;

function ensureRegion() {
  if (region && region.isConnected) return region;
  region = document.querySelector('.toast-region');
  if (!region) {
    region = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false', 'aria-relevant': 'additions' });
    document.body.append(region);
  }
  return region;
}

// Create the live region as soon as the module loads so the very first toast is announced too.
if (typeof document !== 'undefined') {
  if (document.body) ensureRegion();
  else document.addEventListener('DOMContentLoaded', ensureRegion, { once: true });
}

/**
 * toast(textAr, { kind = 'info'|'success'|'warning'|'error'|'match', timeoutMs = 5000, titleAr?,
 *                 actionLabelAr?, onAction? }) → { el, dismiss() }
 * timeoutMs: 0 keeps it until dismissed. Hover/focus pauses the timer.
 */
export function toast(textAr, opts = {}) {
  const { kind = 'info', timeoutMs = 5000, titleAr, onAction } = opts;
  const actionLabelAr = opts.actionLabelAr ?? opts.actionLabel; // `actionLabel` accepted as an alias
  const r = ensureRegion();
  let timer = 0;
  let remaining = timeoutMs;
  let started = 0;

  const closeBtn = h('button', { type: 'button', class: 'icon-btn toast-close', 'aria-label': 'إغلاق التنبيه' }, icon('close', { size: 18 }));
  const action = typeof onAction === 'function' && actionLabelAr
    ? h('button', { type: 'button', class: 'btn btn-sm toast-action' }, ar(actionLabelAr))
    : null;
  const el = h('div', { class: ['toast', `toast-${kind}`] },
    h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, icon(KIND_ICON[kind] || 'bell', { size: 18 })),
    h('div', { class: 'toast-body' },
      titleAr ? h('p', { class: 'toast-title' }, ar(titleAr)) : null,
      h('p', { class: 'toast-text' }, ar(textAr))),
    action, closeBtn);

  function dismiss() {
    clearTimeout(timer);
    if (!el.isConnected || el.dataset.leaving) return;
    el.dataset.leaving = 'true';
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { el.remove(); return; }
    let done = false;
    const fin = () => { if (!done) { done = true; el.remove(); } };
    el.addEventListener('animationend', fin, { once: true });
    setTimeout(fin, 320);
  }
  function arm() {
    if (!timeoutMs) return;
    started = Date.now();
    timer = setTimeout(dismiss, remaining);
  }
  function pause() {
    if (!timeoutMs) return;
    clearTimeout(timer);
    remaining = Math.max(1200, remaining - (Date.now() - started));
  }

  closeBtn.addEventListener('click', dismiss);
  if (action) action.addEventListener('click', () => { onAction(); dismiss(); });
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', arm);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) arm(); });

  r.append(el);
  const live = Array.from(r.children).filter((c) => !c.dataset.leaving);
  for (const old of live.slice(0, Math.max(0, live.length - MAX_VISIBLE))) old.remove();
  arm();
  return { el, dismiss };
}

/** Remove every toast (e.g. on logout). */
export function clearToasts() {
  if (region) region.replaceChildren();
}
