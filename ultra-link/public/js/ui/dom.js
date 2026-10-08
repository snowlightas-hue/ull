// Tiny DOM helpers for Ultra Link views.
// Rule: untrusted text is ALWAYS inserted as text nodes. Nothing in /js/ui ever uses innerHTML,
// outerHTML, insertAdjacentHTML or document.write. Inline styles are only set through the CSSOM
// (el.style.setProperty), which keeps the pages compatible with a strict `style-src 'self'` CSP.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Attributes that must be assigned as DOM properties (not attributes) on HTML elements. */
const PROPS = new Set([
  'value', 'checked', 'selected', 'disabled', 'hidden', 'indeterminate', 'multiple',
  'readOnly', 'required', 'tabIndex', 'open', 'inert', 'defaultValue', 'defaultChecked',
]);

/**
 * Create an HTML element.
 *   h('button', { class: ['btn', isPrimary && 'btn-primary'], onClick: fn, 'aria-label': 'إرسال' }, 'نص', childNode)
 * attrs (all optional):
 *   class | className : string | Array<string|false|null>
 *   style             : object of CSS properties; keys starting with `--` become custom properties
 *   dataset           : object → data-* attributes
 *   on                : { eventName: handler }
 *   onXxx             : function → addEventListener('xxx')
 *   true / false / null / undefined values: true → empty attribute, false/null/undefined → omitted
 * children: strings, numbers, bigints (→ text nodes), Nodes, nested arrays, null/false (skipped).
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  return build(document.createElement(tag), attrs, children, false);
}

/** Same as h() but creates an SVG element (namespace-aware). */
export function s(tag, attrs, ...children) {
  return build(document.createElementNS(SVG_NS, tag), attrs, children, true);
}

function build(el, attrs, children, isSvg) {
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const key of Object.keys(attrs)) setAttr(el, key, attrs[key], isSvg);
  }
  append(el, children);
  return el;
}

function setAttr(el, key, value, isSvg) {
  if (value === undefined || value === null || value === false) {
    if (key === 'hidden' && !isSvg) el.hidden = false;
    return;
  }
  if (key === 'class' || key === 'className') {
    const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    if (cls) el.setAttribute('class', cls);
    return;
  }
  if (key === 'style') {
    if (typeof value !== 'object') throw new TypeError('h(): style must be an object (CSP-safe CSSOM only)');
    for (const prop of Object.keys(value)) {
      const v = value[prop];
      if (v === null || v === undefined || v === false) continue;
      if (prop.startsWith('--') || prop.includes('-')) el.style.setProperty(prop, String(v));
      else el.style[prop] = String(v);
    }
    return;
  }
  if (key === 'dataset') {
    for (const k of Object.keys(value)) {
      if (value[k] !== null && value[k] !== undefined && value[k] !== false) el.dataset[k] = String(value[k]);
    }
    return;
  }
  if (key === 'on') {
    for (const ev of Object.keys(value)) if (typeof value[ev] === 'function') el.addEventListener(ev, value[ev]);
    return;
  }
  if (key.length > 2 && key.startsWith('on') && key[2] === key[2].toUpperCase() && typeof value === 'function') {
    el.addEventListener(key.slice(2).toLowerCase(), value);
    return;
  }
  if (!isSvg && PROPS.has(key)) {
    el[key] = value;
    return;
  }
  el.setAttribute(key, value === true ? '' : String(value));
}

/** Append children (same child rules as h()). Returns the parent. */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

/** Replace all children of `el` (safe: text stays text). Returns el. */
export function mount(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/** Remove all children. */
export function clear(el) {
  el.replaceChildren();
  return el;
}

/** Set the text of an element safely. */
export function setText(el, text) {
  el.textContent = text === null || text === undefined ? '' : String(text);
  return el;
}

let uidCounter = 0;
/** Unique, stable-per-page id for aria-* wiring. */
export function uid(prefix = 'ul') {
  uidCounter += 1;
  return `${prefix}-${uidCounter.toString(36)}`;
}

/** addEventListener that returns an unsubscribe function. */
export function on(el, type, fn, opts) {
  el.addEventListener(type, fn, opts);
  return () => el.removeEventListener(type, fn, opts);
}

/** true when the user asked the OS/browser for reduced motion. */
export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Elements that can receive keyboard focus inside `root` (visible ones only). */
export function focusableWithin(root) {
  const sel = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(root.querySelectorAll(sel)).filter(
    (el) => !el.closest('[hidden],[inert]') && el.getClientRects().length > 0,
  );
}

/** Visually hidden text for screen readers. */
export function srOnly(text) {
  return h('span', { class: 'sr-only' }, text);
}
