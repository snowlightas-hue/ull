// App shell: header (brand + AI status + realm), ARIA tablist with live counters, and tab panels.
import { h, uid } from './dom.js';
import { icon, logoMark } from './icons.js';
import { formatBadge, formatNumber, formatRelativeTime, ar } from './format.js';

/** Tab definitions (order = visual order, start → end). `count` = key in setCounts(). */
export const TABS = [
  { name: 'home', labelAr: 'الرئيسية', icon: 'home', count: null },
  { name: 'requests', labelAr: 'طلباتي', icon: 'search', count: 'requests' },
  { name: 'offers', labelAr: 'عروضي', icon: 'tag', count: 'offers' },
  { name: 'matches', labelAr: 'المطابقات', icon: 'link', count: 'matches' },
  { name: 'notifications', labelAr: 'التنبيهات', icon: 'bell', count: 'unread' },
];

const PANEL_TITLES = {
  requests: { titleAr: 'طلباتي', hintAr: 'ما تبحث عنه أو تحتاجه' },
  offers: { titleAr: 'عروضي', hintAr: 'ما تقدّمه للآخرين' },
  matches: { titleAr: 'المطابقات', hintAr: 'من يناسبك، مع الأسباب' },
  notifications: { titleAr: 'التنبيهات', hintAr: 'آخر ما حدث على طلباتك وعروضك' },
};

const COUNT_SR = {
  requests: 'العدد',
  offers: 'العدد',
  matches: 'العدد',
  unread: 'غير المقروء',
};

/**
 * mountShell(root) → {
 *   el, header, main,
 *   tabs: { list: HTMLElement, buttons: Record<TabName, HTMLButtonElement> },
 *   views: { home, requests, offers, matches, notifications },   // containers to render into
 *   setCounts(counts), setActiveTab(name, { silent?, focus? }), getActiveTab(),
 *   onTabChange(cb) → unsubscribe, setAiStatus(status), setRealm(realm, displayName)
 * }
 */
export function mountShell(root) {
  if (!root) throw new Error('mountShell: root element is required');
  root.replaceChildren();
  root.classList.remove('boot');
  root.classList.add('ul-app');

  // ── Header ──
  const aiText = h('span', { class: 'badge-text' }, 'الذكاء: جارٍ الفحص…');
  const aiBadge = h('span', { class: 'badge badge-ai', dataset: { state: 'unknown' }, title: 'حالة محرك الفهم' },
    h('span', { class: 'status-dot', 'aria-hidden': 'true' }), aiText);

  const realmBadge = h('span', { class: 'badge badge-realm', hidden: true, title: 'حساب تجريبي — البيانات غير حقيقية' },
    icon('flask', { size: 15 }), h('span', { class: 'badge-text' }, 'وضع تجريبي'));

  const userName = h('span', { class: 'user-name' });
  const userChip = h('span', { class: 'user-chip', hidden: true }, icon('user', { size: 15 }), userName);

  const skip = h('a', { class: 'skip-link', href: '#ul-main' }, 'تخطَّ إلى المحتوى');

  // ── Tabs ──
  const buttons = {};
  const counts = {};
  const panels = {};
  const views = {};
  const listId = uid('tablist');

  for (const t of TABS) {
    const tabId = `ul-tab-${t.name}`;
    const panelId = `ul-panel-${t.name}`;
    const countEl = t.count
      ? h('span', { class: 'tab-count', dataset: { kind: t.count }, hidden: true, 'aria-hidden': 'true' })
      : null;
    const countSr = t.count ? h('span', { class: 'sr-only tab-count-sr' }) : null;
    buttons[t.name] = h('button', {
      type: 'button', role: 'tab', id: tabId, class: 'tab', 'aria-controls': panelId,
      'aria-selected': 'false', tabIndex: -1, dataset: { tab: t.name },
    },
    h('span', { class: 'tab-icon' }, icon(t.icon, { size: 22 })),
    h('span', { class: 'tab-label' }, t.labelAr),
    countEl,
    countSr);
    counts[t.name] = { el: countEl, sr: countSr, key: t.count };

    if (t.name === 'home') {
      const body = h('div', { class: 'panel-body panel-body-home' });
      panels.home = h('section', { role: 'tabpanel', id: panelId, class: 'panel panel-home', 'aria-labelledby': tabId, tabIndex: -1 },
        h('h1', { class: 'sr-only' }, 'الرئيسية — قل ما تحتاجه'), body);
      views.home = body;
    } else {
      const meta = PANEL_TITLES[t.name];
      const total = h('span', { class: 'panel-total', hidden: true });
      const body = h('div', { class: 'panel-body', 'aria-live': 'off' });
      panels[t.name] = h('section', { role: 'tabpanel', id: panelId, class: `panel panel-list panel-${t.name}`, 'aria-labelledby': tabId, tabIndex: -1, hidden: true },
        h('header', { class: 'panel-head' },
          h('h1', { class: 'panel-title' }, meta.titleAr, total),
          h('p', { class: 'panel-hint' }, meta.hintAr)),
        body);
      panels[t.name]._total = total;
      views[t.name] = body;
    }
  }

  const tablist = h('div', { role: 'tablist', id: listId, class: 'tablist', 'aria-label': 'أقسام ألترا لينك' },
    TABS.map((t) => buttons[t.name]));

  const header = h('header', { class: 'app-header' },
    h('div', { class: 'app-header-inner' },
      h('div', { class: 'brand' }, logoMark({ size: 30 }), h('span', { class: 'brand-name' }, 'ألترا لينك')),
      h('div', { class: 'status-badges' }, aiBadge, realmBadge, userChip)),
    h('nav', { class: 'tabbar', 'aria-label': 'التنقل الرئيسي' }, tablist));

  const main = h('main', { id: 'ul-main', class: 'app-main', tabIndex: -1 }, TABS.map((t) => panels[t.name]));
  root.append(skip, header, main);

  // Keep --header-h in sync so sticky/fixed elements (toasts, home height) never hide behind it.
  const syncHeader = () => root.style.setProperty('--header-h', `${Math.round(header.getBoundingClientRect().height)}px`);
  syncHeader();
  if (typeof ResizeObserver === 'function') new ResizeObserver(syncHeader).observe(header);

  // ── Behaviour ──
  const listeners = new Set();
  let active = null;

  function setActiveTab(name, { silent = false, focus = false } = {}) {
    if (!buttons[name]) return;
    const changed = active !== name;
    active = name;
    for (const t of TABS) {
      const on = t.name === name;
      buttons[t.name].setAttribute('aria-selected', on ? 'true' : 'false');
      buttons[t.name].tabIndex = on ? 0 : -1;
      panels[t.name].hidden = !on;
    }
    root.dataset.tab = name;
    const btn = buttons[name];
    if (focus) btn.focus();
    // keep the selected tab visible inside the (possibly scrolling) tab bar — never the page
    const lr = tablist.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (br.left < lr.left || br.right > lr.right) {
      tablist.scrollLeft += br.left < lr.left ? br.left - lr.left - 12 : br.right - lr.right + 12;
    }
    if (changed && !silent) for (const cb of listeners) cb(name);
  }

  tablist.addEventListener('click', (e) => {
    const btn = e.target.closest('[role="tab"]');
    if (btn) setActiveTab(btn.dataset.tab, { focus: true });
  });

  tablist.addEventListener('keydown', (e) => {
    const names = TABS.map((t) => t.name);
    const idx = names.indexOf(active);
    const rtl = getComputedStyle(tablist).direction === 'rtl';
    let next = null;
    switch (e.key) {
      case 'ArrowLeft': next = rtl ? idx + 1 : idx - 1; break;
      case 'ArrowRight': next = rtl ? idx - 1 : idx + 1; break;
      case 'Home': next = 0; break;
      case 'End': next = names.length - 1; break;
      default: return;
    }
    e.preventDefault();
    next = (next + names.length) % names.length;
    setActiveTab(names[next], { focus: true });
  });

  function setCounts(c = {}) {
    for (const t of TABS) {
      const slot = counts[t.name];
      if (!slot.key || !(slot.key in c)) continue;
      const n = Math.max(0, Math.trunc(Number(c[slot.key]) || 0));
      slot.el.textContent = formatBadge(n);
      slot.el.hidden = n <= 0;
      slot.sr.textContent = n > 0 ? `، ${COUNT_SR[slot.key]} ${formatNumber(n)}` : '';
      const panel = panels[t.name];
      if (panel?._total && slot.key !== 'unread') {
        panel._total.textContent = formatNumber(n);
        panel._total.hidden = n <= 0;
      }
    }
  }

  function setAiStatus(status) {
    let state = 'unknown';
    let label = 'الذكاء: جارٍ الفحص…';
    if (status) {
      if (status.lastError && !status.verified && status.mode === 'jev') state = 'error';
      else if (status.mode === 'jev' && status.verified) state = 'ok';
      else if (status.mode === 'jev') state = 'pending';
      else if (status.mode === 'jev-sim') state = 'sim';
      else if (status.mode === 'rules') state = 'rules';
      const derived = {
        ok: 'الذكاء متصل', pending: 'الذكاء: قيد التحقق', error: 'الذكاء غير متاح — فهم محلي',
        sim: 'ذكاء محاكى', rules: 'فهم بالقواعد', unknown: 'الذكاء: غير معروف',
      }[state];
      label = status.labelAr ? ar(status.labelAr) : derived;
    }
    aiBadge.dataset.state = state;
    aiText.textContent = label;
    const details = [];
    if (status?.model) details.push(`النموذج: ${status.model}`);
    if (status?.lastSuccessAt) details.push(`آخر نجاح: ${formatRelativeTime(status.lastSuccessAt)}`);
    if (status?.lastError) details.push(`آخر خطأ: ${ar(status.lastError)}`);
    aiBadge.title = details.length ? `${label} — ${details.join('، ')}` : label;
  }

  function setRealm(realm, displayName) {
    realmBadge.hidden = realm !== 'synthetic';
    root.dataset.realm = realm || '';
    const name = displayName ? String(displayName) : '';
    userName.textContent = name;
    userChip.hidden = !name;
    userChip.title = name;
    realmBadge.title = `حساب تجريبي${name ? `: ${name}` : ''} — البيانات غير حقيقية`;
  }

  setActiveTab('home', { silent: true });

  return {
    el: root,
    header,
    main,
    tabs: { list: tablist, buttons },
    views,
    panels,
    setCounts,
    setActiveTab,
    getActiveTab: () => active,
    onTabChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setAiStatus,
    setRealm,
  };
}

