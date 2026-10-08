// Driver for public/ui-preview.html: mounts the real UI modules with fake data and can show every
// phase/state. Exposes window.__preview for the e2e script. Dev only — not imported by the app.
import { h } from './dom.js';
import { mountShell } from './shell.js';
import { mountHome } from './home.js';
import { renderIntentPage, renderMatchPage, renderNotificationPage, renderEmpty, renderLoading, renderListError } from './lists.js';
import { openIntentEditor } from './editor.js';
import { toast } from './toast.js';
import * as D from './preview-data.js';

const params = new URLSearchParams(location.search);
const log = [];
const timers = new Set();
const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
const clearTimers = () => { for (const t of timers) clearTimeout(t); timers.clear(); };

const data = {
  requests: D.makeRequests(250),
  offers: D.makeOffers(),
  matches: D.makeMatches(37),
  notifications: D.makeNotifications(63),
};
const cursors = { requests: '20', offers: null, matches: null, notifications: null };
const intentFilter = { requests: 'active', offers: 'active' };
const byFilter = (arr, f) => (f === 'all' ? arr : f === 'active' ? arr.filter((x) => x.status === 'active' || x.status === 'paused') : arr.filter((x) => x.status === f));
let matchFilter = 'active';
let offersMode = 'list';

const shell = mountShell(document.getElementById('app'));
shell.setAiStatus({ mode: 'jev', verified: true, keyConfigured: true, model: 'jev-structured-1', lastSuccessAt: D.ago(2), lastError: null, labelAr: 'الذكاء متصل' });
shell.setRealm('synthetic', 'سارة (تجريبي)');
updateCounts();

function updateCounts() {
  shell.setCounts({
    requests: data.requests.length,
    offers: offersMode === 'empty' ? 0 : data.offers.length,
    matches: data.matches.length,
    unread: data.notifications.filter((n) => !n.readAt).length,
  });
}

// ── Home with a small simulated conversation (so the preview is clickable) ──
const home = mountHome(shell.views.home, {
  onMicPress() {
    log.push(['onMicPress']);
    const p = home.phase;
    clearTimers();
    if (p === 'listening') { home.showReview({ text: D.SPOKEN, seconds: 5 }); later(5000, sendNow); return; }
    if (['processing', 'saving', 'searching'].includes(p)) return;
    listen();
  },
  onTextSubmit(text) {
    log.push(['onTextSubmit', text]);
    if (['asking', 'speaking', 'awaiting_answer'].includes(home.phase)) { answer(text); return; }
    home.setPhase('ready');
    home.showTranscript(text);
    sendNow();
  },
  onSendNow() { log.push(['onSendNow']); sendNow(); },
  onEditTranscript(text) { log.push(['onEditTranscript', text]); clearTimers(); home.setPhase('ready'); home.setTextValue(text); home.focusText(); },
  onCancel() { log.push(['onCancel']); clearTimers(); home.setPhase('ready'); toast('أُلغي الطلب. لم يُحفظ شيء.', { kind: 'info' }); },
  onOption(value) { log.push(['onOption', value]); answer(value); },
  onAnswerTap() { log.push(['onAnswerTap']); listen(); },
  onRetry() { log.push(['onRetry']); sendNow(); },
  onOpenRequests(intent) { log.push(['onOpenRequests', intent?.id]); shell.setActiveTab(intent?.side === 'provide' ? 'offers' : 'requests', { focus: true }); },
  onSuggestion(s) { log.push(['onSuggestion', s]); toast(`اخترت: «${s}». سنعيد البحث بعد موافقتك.`, { kind: 'info' }); },
  onContact(m) { log.push(['onContact', m.id]); return new Promise((res) => setTimeout(() => res({ ...m, contact: { status: 'pending_out', requestId: 'cr-x' } }), 600)); },
  onRespond(m, accept) { log.push(['onRespond', m.id, accept]); toast(accept ? 'قبلت طلب التواصل.' : 'رفضت طلب التواصل.', { kind: accept ? 'success' : 'info' }); },
  onOpenMatches() { log.push(['onOpenMatches']); shell.setActiveTab('matches', { focus: true }); },
  onNewRequest() { log.push(['onNewRequest']); home.setPhase('ready'); },
});

function listen() {
  home.setPhase('listening');
  const words = D.SPOKEN.split(' ');
  let n = 0;
  const step = () => {
    n += 1;
    home.showTranscript(words.slice(0, n).join(' '), { interim: true });
    if (n < words.length) later(260, step);
  };
  later(500, step);
}
function sendNow() {
  clearTimers();
  home.setPhase('processing');
  later(1400, () => {
    home.showSummary(D.SUMMARY);
    home.showQuestion(D.QUESTION, { canAutoListen: false });
    home.setPhase('speaking');
    later(1800, () => home.setPhase('awaiting_answer'));
  });
}
function answer() {
  clearTimers();
  home.setPhase('saving');
  later(1000, () => { home.setPhase('searching'); later(2000, () => home.showResults(D.makeRun())); });
}

// ── Lists ──
const intentHandlers = (kind) => ({
  onPage(dir, cursor) { log.push(['onPage', kind, dir, cursor]); cursors[kind] = cursor; render(kind); },
  onEdit(intent) { log.push(['onEdit', intent.id]); openEditor(intent); },
  onStatus(intent, action) {
    log.push(['onStatus', intent.id, action]);
    return new Promise((res) => setTimeout(() => {
      const next = { pause: 'paused', resume: 'active', fulfill: 'fulfilled', close: 'closed' }[action];
      const arr = data[kind];
      const idx = arr.findIndex((x) => x.id === intent.id);
      if (idx >= 0) arr[idx] = { ...arr[idx], status: next, updatedAt: new Date().toISOString() };
      render(kind);
      toast(`تم: ${{ pause: 'أُوقف مؤقتًا', resume: 'استُؤنف', fulfill: 'تمت تلبية الحاجة', close: 'أُغلق' }[action]}`, { kind: 'success' });
      res();
    }, 400));
  },
  onOpenMatches(intent) { log.push(['onOpenMatches', intent.id]); shell.setActiveTab('matches', { focus: true }); },
  filter: intentFilter[kind],
  onFilter(f) { log.push(['onFilter', kind, f]); intentFilter[kind] = f; cursors[kind] = null; render(kind); },
  emptyTextAr: kind === 'offers' ? 'لم تضف أي عرض بعد. قل مثلًا: «عندي سيارة للبيع».' : undefined,
  emptyActionLabelAr: 'ابدأ بالميكروفون',
  onEmptyAction: () => { shell.setActiveTab('home', { focus: true }); },
});

function render(kind) {
  const el = shell.views[kind];
  if (kind === 'requests' || kind === 'offers') {
    if (kind === 'offers' && offersMode === 'empty') { renderIntentPage(el, D.pageOf([], null), intentHandlers('offers')); return; }
    if (kind === 'offers' && offersMode === 'loading') { renderLoading(el); return; }
    if (kind === 'offers' && offersMode === 'error') { renderListError(el, 'انقطع الاتصال بالخادم.', () => { offersMode = 'list'; render('offers'); }); return; }
    renderIntentPage(el, D.pageOf(intentFilter[kind] === 'all' && kind === 'requests' ? data[kind] : byFilter(data[kind], intentFilter[kind]), cursors[kind]), intentHandlers(kind));
  } else if (kind === 'matches') {
    const all = matchFilter === 'active' ? data.matches : data.matches.filter((m) => m.state === matchFilter);
    renderMatchPage(el, D.pageOf(all, cursors.matches, 10), {
      onPage(dir, cursor) { log.push(['onPage', 'matches', dir, cursor]); cursors.matches = cursor; render('matches'); },
      onContact: (m) => { log.push(['onContact', m.id]); return new Promise((res) => setTimeout(() => res({ ...m, contact: { status: 'pending_out' } }), 600)); },
      onRespond: (m, accept) => { log.push(['onRespond', m.id, accept]); },
      onFilter: (f) => { matchFilter = f; cursors.matches = null; render('matches'); },
      filter: matchFilter,
    });
  } else if (kind === 'notifications') {
    const page = { ...D.pageOf(data.notifications, cursors.notifications), unread: data.notifications.filter((n) => !n.readAt).length };
    renderNotificationPage(shell.views.notifications, page, {
      onPage(dir, cursor) { log.push(['onPage', 'notifications', dir, cursor]); cursors.notifications = cursor; render('notifications'); },
      onRead(n) { log.push(['onRead', n.id]); const x = data.notifications.find((y) => y.id === n.id); if (x) x.readAt = new Date().toISOString(); updateCounts(); return Promise.resolve(); },
      onReadAll() { log.push(['onReadAll']); for (const x of data.notifications) x.readAt ||= new Date().toISOString(); updateCounts(); return Promise.resolve(); },
      onOpen(n) { log.push(['onOpen', n.id]); shell.setActiveTab('matches', { focus: true }); },
    });
  }
}

shell.onTabChange((name) => { log.push(['tab', name]); if (name !== 'home') render(name); });

function openEditor(intent) {
  return openIntentEditor({ ...intent, spec: intent.id === 'req-1' || intent.id === 'req-main' ? D.EDIT_SPEC : undefined, choices: D.EDIT_CHOICES }, {
    onSave(changes) {
      log.push(['onSave', changes]);
      return new Promise((res) => setTimeout(() => { toast('حُفظت التعديلات.', { kind: 'success' }); res(); }, 500));
    },
    onCancel() { log.push(['onEditorCancel']); },
  });
}

// ── State gallery ──
const STATES = {
  ready: () => { shell.setActiveTab('home'); home.setPhase('ready'); },
  listening: () => { STATES.ready(); home.setPhase('listening'); home.showTranscript('بدي شقة بإعزاز بحدود ميتين دولار', { interim: true }); },
  reviewing: () => { STATES.ready(); home.showReview({ text: D.SPOKEN, seconds: 5 }); },
  processing: () => { STATES.ready(); home.showTranscript(D.SPOKEN); home.setPhase('processing'); },
  asking: () => { STATES.ready(); home.showSummary(D.SUMMARY); home.showQuestion(D.QUESTION, { canAutoListen: true }); home.setPhase('asking'); },
  speaking: () => { STATES.asking(); home.setPhase('speaking'); },
  awaiting_answer: () => { STATES.asking(); home.setPhase('awaiting_answer'); },
  awaiting_answer_tap: () => { STATES.ready(); home.showSummary(D.SUMMARY); home.showQuestion(D.QUESTION, { canAutoListen: false }); home.setPhase('awaiting_answer'); },
  conflict: () => { STATES.ready(); home.showSummary(D.SUMMARY); home.showQuestion(D.CONFLICT_QUESTION, { canAutoListen: true }); home.setPhase('awaiting_answer'); },
  saving: () => { STATES.ready(); home.showSummary(D.SUMMARY); home.setPhase('saving'); },
  searching: () => { STATES.ready(); home.showSummary(D.SUMMARY); home.setPhase('searching'); },
  results: () => { STATES.ready(); home.showResults(D.makeRun()); },
  saved_no_results: () => { STATES.ready(); home.showSavedNoResults(D.SAVED_INTENT, ['جرّب يوم السبت أيضًا', 'وسّع المكان إلى محافظة حلب'], D.SAVED_RUN); },
  error: () => { STATES.ready(); home.showError('انقطع الاتصال بالخادم أثناء التحليل. ما قلته محفوظ، ويمكنك إعادة المحاولة.'); },
  requests: () => { cursors.requests = '20'; intentFilter.requests = 'all'; shell.setActiveTab('requests', { silent: true }); render('requests'); },
  requests_first: () => { cursors.requests = null; intentFilter.requests = 'all'; shell.setActiveTab('requests', { silent: true }); render('requests'); },
  requests_last: () => { cursors.requests = '240'; intentFilter.requests = 'all'; shell.setActiveTab('requests', { silent: true }); render('requests'); },
  offers: () => { offersMode = 'list'; updateCounts(); shell.setActiveTab('offers', { silent: true }); render('offers'); },
  offers_empty: () => { offersMode = 'empty'; updateCounts(); shell.setActiveTab('offers', { silent: true }); render('offers'); },
  offers_loading: () => { offersMode = 'loading'; shell.setActiveTab('offers', { silent: true }); render('offers'); },
  offers_error: () => { offersMode = 'error'; shell.setActiveTab('offers', { silent: true }); render('offers'); },
  matches: () => { matchFilter = 'active'; cursors.matches = null; shell.setActiveTab('matches', { silent: true }); render('matches'); },
  notifications: () => { cursors.notifications = null; shell.setActiveTab('notifications', { silent: true }); render('notifications'); },
  editor: () => { STATES.requests_first(); const btn = shell.views.requests.querySelector('.intent-card .btn'); btn?.focus(); openEditor(data.requests[0]); },
  toast: () => {
    STATES.ready();
    toast('شقة ٣ غرف قرب دوار الكف الأخضر تطابق طلبك.', { kind: 'match', titleAr: 'مطابقة جديدة', timeoutMs: 0, actionLabelAr: 'عرض', onAction: () => shell.setActiveTab('matches') });
    toast('تم قبول طلب التواصل — يمكنك الاتصال الآن.', { kind: 'success', timeoutMs: 0 });
  },
};

function show(name) {
  clearTimers();
  document.querySelectorAll('.sheet-backdrop').forEach((el) => el.remove());
  document.querySelectorAll('[inert]').forEach((el) => { el.inert = false; });
  document.documentElement.classList.remove('ul-modal-open');
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  if (!STATES[name]) throw new Error(`unknown preview state ${name}`);
  STATES[name]();
  document.documentElement.dataset.previewState = name;
  window.scrollTo(0, 0);
}

// ── Preview control panel (not part of the product UI) ──
if (params.get('chrome') !== '0') {
  const list = h('div', { class: 'pv-states' }, Object.keys(STATES).map((k) =>
    h('button', { type: 'button', class: 'pv-btn', onClick: () => show(k) }, k)));
  const ai = h('select', { class: 'pv-select', 'aria-label': 'حالة الذكاء', onChange: (e) => {
    const v = e.target.value;
    shell.setAiStatus({
      ok: { mode: 'jev', verified: true, labelAr: 'الذكاء متصل' },
      sim: { mode: 'jev-sim', verified: true },
      rules: { mode: 'rules', verified: false },
      error: { mode: 'jev', verified: false, lastError: 'انتهت مهلة الاتصال' },
    }[v]);
  } }, ['ok', 'sim', 'rules', 'error'].map((v) => h('option', { value: v }, `AI: ${v}`)));
  const realm = h('select', { class: 'pv-select', 'aria-label': 'نوع الحساب', onChange: (e) => {
    if (e.target.value === 'synthetic') shell.setRealm('synthetic', 'سارة (تجريبي)'); else shell.setRealm('real', 'محمد');
  } }, h('option', { value: 'synthetic' }, 'realm: synthetic'), h('option', { value: 'real' }, 'realm: real'));
  document.body.append(h('details', { class: 'pv-panel', dir: 'ltr' },
    h('summary', null, 'UI preview states'),
    h('div', { class: 'pv-row' }, ai, realm),
    list));
}

const initial = params.get('state') || 'ready';
show(initial);

window.__preview = { ready: true, show, states: Object.keys(STATES), log, shell, home, data, fixtures: D };
