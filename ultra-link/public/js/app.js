// Ultra Link — client integration: session, shell/tabs, conversation machine ↔ home view, lists,
// live events (SSE), editor, contact flow, demo tools. Pure wiring; views live in ./ui, voice in ./conversation.
import * as api from './api.js';
import { h, clear } from './ui/dom.js';
import { mountShell } from './ui/shell.js';
import { mountHome } from './ui/home.js';
import { renderIntentPage, renderMatchPage, renderNotificationPage, renderLoading, renderListError } from './ui/lists.js';
import { openIntentEditor } from './ui/editor.js';
import { toast } from './ui/toast.js';
import { createVoice } from './conversation/voice.js';
import { createConversationMachine } from './conversation/machine.js';

const root = document.getElementById('app');
const state = { me: null, shell: null, home: null, machine: null, taxonomy: null, lists: {}, events: null, lastIntent: null };

boot().catch((e) => {
  console.error(e);
  root.replaceChildren(h('div', { class: 'boot-screen', role: 'alert' }, h('p', { class: 'boot-name' }, 'ألترا لينك'), h('p', { class: 'boot-note' }, e.messageAr ?? 'تعذّر تشغيل التطبيق. أعد تحميل الصفحة.')));
});

async function boot() {
  const session = await api.get('/api/session');
  if (!session.user) return showLogin();
  const me = await api.get('/api/me');
  state.me = me;
  startApp();
}

// ───────────── login (demo personas are clearly synthetic; real accounts are local-only) ─────────────
async function showLogin() {
  root.classList.remove('boot');
  const personas = await api.get('/api/personas').catch(() => ({ items: [] }));
  const nameInput = h('input', { class: 'input', id: 'reg-name', autocomplete: 'nickname', maxLength: 80, placeholder: 'اسمك', required: true });
  const phoneInput = h('input', { class: 'input', id: 'reg-phone', inputMode: 'tel', maxLength: 30, placeholder: 'رقم للتواصل (اختياري — لا يظهر إلا بعد موافقتك)' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const login = async (fn) => { err.textContent = ''; try { await fn(); location.reload(); } catch (e) { err.textContent = e.messageAr ?? 'تعذّر الدخول'; } };
  root.replaceChildren(
    h('main', { class: 'app-main login', style: { maxWidth: '640px', margin: '0 auto', padding: '24px 16px' } },
      h('header', { class: 'panel-head' }, h('h1', { class: 'panel-title' }, 'ألترا لينك'), h('p', { class: 'panel-hint' }, 'قل ما تحتاجه أو ما تقدّمه، ونربطك بمن يناسبك.')),
      h('section', { class: 'panel', 'aria-labelledby': 'demo-h' },
        h('h2', { class: 'panel-title', id: 'demo-h' }, 'جرّب بحساب تجريبي'),
        h('p', { class: 'panel-hint' }, 'بيانات اصطناعية معلَّمة بوضوح — لا تختلط ببيانات المستخدمين الحقيقيين.'),
        h('ul', { class: 'panel-list', role: 'list' }, ...personas.items.map((p) =>
          h('li', { class: 'card' },
            h('div', { class: 'card-head' }, h('strong', { class: 'card-title' }, p.displayName), h('span', { class: 'demo-tag' }, 'تجريبي')),
            h('p', { class: 'muted' }, p.descriptionAr),
            h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: () => login(() => api.post('/api/auth/demo-login', { handle: p.handle })) }, `ادخل كـ ${p.displayName}`))))),
      h('section', { class: 'panel', 'aria-labelledby': 'reg-h' },
        h('h2', { class: 'panel-title', id: 'reg-h' }, 'أو أنشئ حسابًا محليًا'),
        h('form', { class: 'editor-form', onSubmit: (ev) => { ev.preventDefault(); if (!nameInput.value.trim()) { nameInput.focus(); return; } login(() => api.post('/api/auth/register', { displayName: nameInput.value.trim(), phone: phoneInput.value.trim() || undefined })); } },
          h('label', { class: 'field-label', for: 'reg-name' }, 'الاسم'), nameInput,
          h('label', { class: 'field-label', for: 'reg-phone' }, 'رقم التواصل'), phoneInput,
          err,
          h('button', { type: 'submit', class: 'btn btn-primary' }, 'ابدأ'))),
    ),
  );
}

// ───────────── app ─────────────
function startApp() {
  const shell = (state.shell = mountShell(root));
  shell.setRealm(state.me.user.realm, state.me.user.displayName);
  shell.setCounts(state.me.counts);
  refreshAiStatus();
  setInterval(refreshAiStatus, 60_000);

  const home = (state.home = mountHome(shell.views.home, {
    onMicPress: () => state.machine.pressMic(),
    onTextSubmit: (text) => state.machine.submitText(text),
    onSendNow: (text) => state.machine.sendNow(text),
    onEditTranscript: () => { state.machine.edit(); home.setTextValue(state.machine.context.transcript); home.focusText(); },
    onCancel: () => state.machine.cancel(),
    onOption: (value) => {
      const q = state.machine.context.question;
      const opt = q?.options?.find((o) => o.value === value) ?? { value, label: String(value) };
      state.machine.chooseOption(opt);
    },
    onAnswerTap: () => state.machine.startListening(),
    onRetry: () => state.machine.retry(),
    onOpenRequests: () => shell.setActiveTab(state.lastIntent?.side === 'provide' ? 'offers' : 'requests'),
    onSuggestion: () => { if (state.lastIntent) editIntent(state.lastIntent.id); },
    onContact: (m) => requestContact(m),
    onRespond: (m, accept) => respondContact(m, accept),
    onOpenMatches: () => shell.setActiveTab('matches'),
    onNewRequest: () => state.machine.reset(),
  }));

  const voice = createVoice();
  const machine = (state.machine = createConversationMachine({
    voice,
    autoSendMs: 1600,
    optionText: (o) => o.label,
    api: {
      ensureConversation: async () => (await api.post('/api/conversations')).conversation,
      sendTurn: (id, body) => api.post(`/api/conversations/${id}/turns`, body),
      runMatch: (intentId) => api.post(`/api/intents/${intentId}/match`),
      cancelConversation: (id) => api.post(`/api/conversations/${id}/cancel`),
    },
  }));
  machine.subscribe((st, ctx) => renderMachine(st, ctx));
  renderMachine(machine.state, machine.context);

  // restore an unfinished conversation (draft + pending question survive reloads)
  api.get('/api/conversations/current').then(({ conversation }) => {
    if (conversation?.question) machine.resume({ id: conversation.id }, conversation.question);
    if (conversation?.summary) home.showSummary(conversation.summary);
  }).catch(() => {});

  shell.onTabChange((tab) => loadTab(tab));
  connectEvents();
  addAccountTools();
}

function renderMachine(st, ctx) {
  const home = state.home;
  home.setPhase(st);
  if (st === 'listening') home.showTranscript(ctx.interim || ctx.transcript, { interim: true });
  else if (ctx.transcript && ['processing', 'asking', 'speaking', 'awaiting_answer'].includes(st)) home.showTranscript(ctx.transcript, { interim: false });
  if (st === 'reviewing' && ctx.review) home.showReview({ text: ctx.transcript, seconds: Math.max(1, Math.round((ctx.review.deadline ? ctx.review.deadline - Date.now() : ctx.review.autoSendMs) / 1000)) });
  if (ctx.question && ['asking', 'speaking', 'awaiting_answer'].includes(st)) home.showQuestion(ctx.question, { canAutoListen: ctx.canAutoListen });
  else if (!['listening', 'reviewing', 'processing'].includes(st) || !ctx.question) home.hideQuestion();
  if (ctx.lastTurn?.summary) home.showSummary(ctx.lastTurn.summary);
  if (ctx.intent) state.lastIntent = ctx.intent;
  if (st === 'results') home.showResults(ctx.matchRun);
  if (st === 'saved_no_results') home.showSavedNoResults(ctx.intent, ctx.matchRun?.suggestionsAr ?? [], ctx.matchRun);
  if (st === 'error' && ctx.error) home.showError(ctx.error.messageAr);
  if (['results', 'saved_no_results'].includes(st)) refreshCounts();
}

async function refreshAiStatus() {
  try { state.shell.setAiStatus(await api.get('/api/ai/status')); } catch { /* ignore */ }
}
async function refreshCounts() {
  try { const me = await api.get('/api/me'); state.me = me; state.shell.setCounts(me.counts); } catch { /* ignore */ }
}

// ───────────── tabs & lists (real pages with exact totals) ─────────────
const LIST = {
  requests: { url: '/api/intents', params: { side: 'requests' } },
  offers: { url: '/api/intents', params: { side: 'offers' } },
  matches: { url: '/api/matches', params: { state: 'active' } },
  notifications: { url: '/api/notifications', params: {} },
};

async function loadTab(tab, cursor = null, dir = 'next') {
  if (tab === 'home') return;
  const cfg = LIST[tab];
  const el = state.shell.views[tab];
  const ls = (state.lists[tab] ??= { filter: tab === 'matches' ? 'active' : 'active', intent: null });
  if (!el || !cfg) return;
  if (!cursor) renderLoading(el);
  const params = { ...cfg.params, limit: 20, cursor, dir: cursor ? dir : undefined };
  if (tab === 'requests' || tab === 'offers') params.status = ls.filter === 'all' ? undefined : ls.filter === 'active' ? 'active,paused' : ls.filter;
  if (tab === 'matches') { params.state = ls.filter; if (ls.intent) params.intent = ls.intent; }
  try {
    const page = await api.get(cfg.url + api.qs(params));
    const onPage = (d, c) => loadTab(tab, c, d);
    if (tab === 'requests' || tab === 'offers') {
      renderIntentPage(el, page, {
        onPage, filter: ls.filter, onFilter: (f) => { ls.filter = f; loadTab(tab); },
        onEdit: (intent) => editIntent(intent.id),
        onStatus: (intent, action) => changeStatus(intent, action, tab),
        onOpenMatches: (intent) => { state.lists.matches = { filter: 'active', intent: intent.id }; state.shell.setActiveTab('matches'); },
        emptyTextAr: tab === 'requests' ? 'لا توجد طلبات بعد. اضغط الميكروفون وقل ما تحتاجه.' : 'لا توجد عروض بعد. قل مثلًا: «عندي سيارة للبيع».',
        emptyActionLabelAr: 'ابدأ من الرئيسية', onEmptyAction: () => state.shell.setActiveTab('home'),
      });
      if (state.me.user.realm === 'synthetic' && tab === 'requests') el.prepend(demoTools());
    } else if (tab === 'matches') {
      renderMatchPage(el, page, {
        onPage, filter: ls.filter, onFilter: (f) => { ls.filter = f; loadTab(tab); },
        onContact: (m) => requestContact(m, () => loadTab('matches')),
        onRespond: (m, accept) => respondContact(m, accept, () => loadTab('matches')),
        emptyTextAr: ls.intent ? 'لا مطابقات لهذا الطلب حاليًا.' : 'لا مطابقات بعد. سنخبرك فور ظهور طرف مناسب.',
      });
      if (ls.intent) el.prepend(h('div', { class: 'notice' }, h('span', { class: 'notice-body' }, 'تعرض مطابقات طلب واحد. '), h('button', { type: 'button', class: 'link-btn', onClick: () => { ls.intent = null; loadTab('matches'); } }, 'عرض كل المطابقات')));
    } else if (tab === 'notifications') {
      renderNotificationPage(el, page, {
        onPage,
        onRead: async (n) => { await api.post(`/api/notifications/${n.id}/read`); refreshCounts(); },
        onReadAll: async () => { await api.post('/api/notifications/read-all'); refreshCounts(); loadTab('notifications'); },
        onOpen: (n) => { if (n.payload?.matchId) { state.lists.matches = { filter: 'active', intent: null }; state.shell.setActiveTab('matches'); } },
      });
    }
  } catch (e) {
    renderListError(el, e.messageAr ?? 'تعذّر التحميل', () => loadTab(tab, cursor, dir));
  }
}

async function ensureTaxonomy() {
  state.taxonomy ??= await api.get('/api/taxonomy');
  return state.taxonomy;
}

async function editIntent(id) {
  try {
    const [{ intent }, tax] = await Promise.all([api.get(`/api/intents/${id}`), ensureTaxonomy()]);
    openIntentEditor(intent, {
      choices: { categories: tax.categories, places: tax.places },
      onSave: async (changes) => {
        const res = await api.patch(`/api/intents/${id}`, { expectedVersion: intent.version, changes });
        const t = res.run?.totals;
        toast(t ? `تم التعديل. ${t.confirmed} مؤكدة، ${t.possible} محتملة${res.run.invalidated ? `، ${res.run.invalidated} لم تعد مطابقة` : ''}.` : 'تم التعديل', { kind: 'success' });
        refreshCounts();
        const tab = state.shell.getActiveTab();
        if (tab !== 'home') loadTab(tab);
      },
    });
  } catch (e) { toast(e.messageAr ?? 'تعذّر فتح التعديل', { kind: 'error' }); }
}

async function changeStatus(intent, action, tab) {
  try {
    const res = await api.post(`/api/intents/${intent.id}/status`, { action });
    const msg = { pause: 'أُوقفت المتابعة مؤقتًا', resume: 'استُؤنفت المتابعة', fulfill: 'رائع! أُغلق الطلب بعد تلبية الحاجة', close: 'أُغلق' }[action];
    toast(`${msg}${res.run?.invalidated ? ` — ${res.run.invalidated} مطابقة لم تعد فعّالة` : ''}`, { kind: 'success' });
    refreshCounts();
    loadTab(tab);
  } catch (e) { toast(e.messageAr ?? 'تعذّر التنفيذ', { kind: 'error' }); }
}

async function requestContact(m, after) {
  try {
    await api.post(`/api/matches/${m.id}/contact`, {});
    toast('أُرسل طلب التواصل. لن تظهر بياناتكما إلا بعد موافقة الطرف الآخر.', { kind: 'success' });
    after?.();
  } catch (e) { toast(e.messageAr ?? 'تعذّر إرسال الطلب', { kind: 'error' }); throw e; }
}

async function respondContact(m, accept, after) {
  try {
    if (!m.contact?.requestId) return;
    await api.post(`/api/contact-requests/${m.contact.requestId}/respond`, { accept });
    toast(accept ? 'تمت الموافقة. يمكنكما الآن رؤية بيانات التواصل.' : 'رُفض الطلب.', { kind: accept ? 'success' : 'info' });
    after?.();
  } catch (e) { toast(e.messageAr ?? 'تعذّر الرد', { kind: 'error' }); throw e; }
}

// ───────────── live events ─────────────
function connectEvents() {
  if (!('EventSource' in window)) { setInterval(refreshCounts, 15_000); return; }
  const es = (state.events = new EventSource('/api/events'));
  let lastUnread = state.me.counts.unread;
  es.addEventListener('counts', (ev) => {
    const c = JSON.parse(ev.data);
    state.shell.setCounts(c);
    if (c.unread > lastUnread) {
      toast('وصلك تنبيه جديد — قد تكون مطابقة مناسبة', { kind: 'match', actionLabel: 'عرض', onAction: () => state.shell.setActiveTab('notifications') });
    }
    lastUnread = c.unread;
  });
  es.addEventListener('match_update', () => { const t = state.shell.getActiveTab(); if (t === 'matches' || t === 'requests' || t === 'offers') loadTab(t); });
  es.onerror = () => { /* EventSource reconnects automatically */ };
}

// ───────────── account & demo tools ─────────────
function addAccountTools() {
  const header = state.shell.header;
  const logout = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: async () => { await api.post('/api/auth/logout').catch(() => {}); location.reload(); } }, 'خروج');
  header?.querySelector('.app-header-inner')?.append(logout);
}

function demoTools() {
  const btn = h('button', {
    type: 'button', class: 'btn btn-sm',
    onClick: async () => {
      btn.disabled = true;
      try {
        const r = await api.post('/api/demo/simulate', { scenario: 'later_match' });
        toast(r.noteAr, { kind: 'info' });
      } catch (e) { toast(e.messageAr ?? 'تعذّرت المحاكاة', { kind: 'error' }); }
      finally { btn.disabled = false; }
    },
  }, 'محاكاة: وصول عرض مطابق لاحقًا');
  return h('div', { class: 'notice' },
    h('span', { class: 'notice-body' }, 'أداة تجريبية: تضيف عرضًا اصطناعيًا يطابق أحدث طلب لك بلا مطابقات، ثم يطابقه العامل في الخلفية ويصلك تنبيه. '),
    btn);
}

void clear;
