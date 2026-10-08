// Home view: the microphone stage. Pure view — it renders phases and forwards user gestures to the
// handlers it was given. It never talks to the network, the microphone or speech synthesis.
import { h, s, uid } from './dom.js';
import { icon } from './icons.js';
import { ar, formatCount, formatNumber, toArabicDigits, NOUNS } from './format.js';
import { matchCard, chipList, intentCard } from './cards.js';

/** Client conversation states (docs/CONTRACTS.md). */
export const PHASES = [
  'ready', 'listening', 'reviewing', 'processing', 'asking', 'speaking', 'awaiting_answer',
  'saving', 'searching', 'results', 'saved_no_results', 'error',
];

const STATUS_AR = {
  ready: 'اضغط على الميكروفون وتكلّم',
  listening: 'أستمع إليك…',
  reviewing: 'هل هذا ما قلته؟',
  processing: 'أحلّل طلبك…',
  asking: 'سؤال واحد للتوضيح',
  speaking: 'أقرأ عليك السؤال…',
  awaiting_answer: 'دورك الآن',
  saving: 'أحفظ طلبك…',
  searching: 'أبحث عن مطابقات…',
  results: 'هذه أفضل المطابقات لطلبك',
  saved_no_results: 'تم الحفظ',
  error: 'تعذّر إكمال هذه الخطوة',
};

const HINT_AR = {
  ready: 'قل ما تحتاجه أو ما تقدّمه بكلماتك، وسأرتّب الباقي',
  listening: 'تكلّم بشكل طبيعي، واضغط مرة أخرى عند الانتهاء',
  reviewing: 'سأرسله تلقائيًا عند انتهاء العدّ',
  processing: 'أستخرج النوع والمكان والسعر والموعد',
  saving: 'لحظة واحدة',
  searching: 'أقارن طلبك بكل ما هو متاح الآن',
};

const MIC_AR = {
  ready: 'ابدأ التحدث',
  listening: 'إنهاء التحدث',
  reviewing: 'سجّل من جديد',
  processing: 'جارٍ التحليل',
  asking: 'أجب بصوتك',
  speaking: 'أجب بصوتك',
  awaiting_answer: 'أجب بصوتك',
  saving: 'جارٍ الحفظ',
  searching: 'جارٍ البحث',
  results: 'طلب جديد بالصوت',
  saved_no_results: 'طلب جديد بالصوت',
  error: 'تحدّث من جديد',
};

const QUESTION_VISIBLE = new Set(['asking', 'speaking', 'awaiting_answer', 'listening', 'reviewing', 'processing']);
const SUMMARY_VISIBLE = new Set(['listening', 'reviewing', 'processing', 'asking', 'speaking', 'awaiting_answer', 'saving', 'searching']);
const TRANSCRIPT_VISIBLE = new Set(['listening', 'reviewing', 'processing']);
const BUSY = new Set(['processing', 'saving', 'searching']);
const CANCELABLE = new Set(['listening', 'processing', 'asking', 'speaking', 'awaiting_answer']);
const RESULT_PHASES = new Set(['results', 'saved_no_results', 'error']);
const CLEAR_QUESTION_ON = new Set(['ready', 'saving', 'searching', 'results', 'saved_no_results']);

export const EXAMPLES_AR = ['بدي شقة بإعزاز', 'عندي سيارة للبيع', 'بدي أطلع رحلة يوم الجمعة'];

/** Exclusion summary line: "استُبعد ٣ عروض: ٢ خارج إعزاز، ١ أعلى من سقف السعر". */
export function exclusionSummary(exclusions, excludedTotal, side) {
  const list = Array.isArray(exclusions) ? exclusions.filter((e) => Number(e?.count) > 0) : [];
  const total = Number(excludedTotal) || list.reduce((a, e) => a + Number(e.count), 0);
  if (!total) return null;
  const noun = side === 'provide' ? NOUNS.request : side === 'join' ? NOUNS.activity : NOUNS.offer;
  const parts = list.map((e) => `${formatNumber(e.count)} ${ar(e.textAr)}`);
  const text = `استُبعد ${formatCount(total, noun)}${parts.length ? `: ${parts.join('، ')}` : ''}`;
  return h('div', { class: 'exclusions' }, icon('info', { size: 18 }), h('p', null, text));
}

/** Suggestions as explicit choices — never applied automatically. */
export function suggestionsBlock(list, onChoose) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const id = uid('sugg');
  const buttons = list.map((sug) => {
    const b = h('button', { type: 'button', class: 'suggestion', 'aria-pressed': 'false' }, icon('plus', { size: 16 }), ar(sug));
    b.addEventListener('click', () => {
      for (const other of buttons) other.setAttribute('aria-pressed', other === b ? 'true' : 'false');
      if (typeof onChoose === 'function') onChoose(sug);
    });
    return b;
  });
  return h('section', { class: 'suggestions', 'aria-labelledby': id },
    h('p', { class: 'suggestions-title', id }, icon('sparkle', { size: 18 }), 'اقتراحات لتوسيع البحث'),
    h('p', { class: 'suggestions-note' }, 'لن يتغيّر طلبك إلا إذا اخترت اقتراحًا بنفسك.'),
    h('div', { class: 'suggestion-list' }, buttons));
}

function checkSvg() {
  return s('svg', { class: 'mic-check', viewBox: '0 0 48 48', 'aria-hidden': 'true', focusable: 'false' },
    s('circle', { class: 'mic-check-circle', cx: 24, cy: 24, r: 19, pathLength: 1 }),
    s('path', { class: 'mic-check-path', d: 'M15 24.5l6.2 6.2L33.5 18', pathLength: 1 }));
}

/**
 * mountHome(el, handlers) → view API (see README.md).
 * handlers: { onMicPress, onTextSubmit(text), onSendNow, onEditTranscript, onCancel, onOption(value),
 *             onAnswerTap, onRetry, onOpenRequests(intent?), onSuggestion(s),
 *             // optional extras
 *             onContact(match), onRespond(match, accept), onOpenMatches(), onNewRequest() }
 */
export function mountHome(el, handlers = {}) {
  if (!el) throw new Error('mountHome: element is required');
  const call = (name, ...args) => {
    const fn = handlers[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  };

  const state = {
    phase: 'ready',
    hasQuestion: false,
    canAutoListen: true,
    hasSummary: false,
    hasTranscript: false,
    reviewing: false,
    countdown: null,
    labelOverride: null,
    hintOverride: undefined,
  };

  // ── Stage elements ──
  const statusEl = h('p', { class: 'phase-label', id: uid('phase'), role: 'status', 'aria-live': 'polite', tabIndex: -1 });
  const hintEl = h('p', { class: 'phase-hint' });

  const micBtn = h('button', {
    type: 'button', class: 'mic', 'aria-pressed': 'false', 'aria-label': MIC_AR.ready, 'aria-describedby': statusEl.id,
  }, h('span', { class: 'mic-glyph' }, icon('mic', { size: 48 })), checkSvg());
  micBtn.addEventListener('click', () => call('onMicPress'));

  const deco = (cls) => h('span', { class: cls, 'aria-hidden': 'true' });
  const micWrap = h('div', { class: 'mic-wrap' },
    deco('mic-halo'),
    deco('mic-ring r1'), deco('mic-ring r2'),
    deco('mic-pulse p1'), deco('mic-pulse p2'), deco('mic-pulse p3'),
    h('span', { class: 'mic-radar', 'aria-hidden': 'true' }, deco('mic-radar-sweep'), deco('mic-radar-blip')),
    h('span', { class: 'mic-orbit', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    micBtn);

  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm cancel-btn', hidden: true },
    icon('close', { size: 16 }), 'إلغاء الطلب');
  cancelBtn.addEventListener('click', () => call('onCancel'));

  // transcript (live / final) and review card share one slot
  const transcriptText = h('p', { class: 'transcript-text' });
  const transcriptCard = h('div', { class: 'transcript' }, transcriptText);
  const transcriptSlot = h('div', { class: 'transcript-slot', hidden: true }, transcriptCard);

  const questionSlot = h('div', { class: 'question-slot', hidden: true });

  const answerBtn = h('button', { type: 'button', class: 'btn btn-primary btn-xl answer-btn', hidden: true },
    icon('mic', { size: 24 }), 'اضغط للإجابة');
  answerBtn.addEventListener('click', () => call('onAnswerTap'));
  // when auto-listen is impossible this block takes the mic's place (one clear action)
  const turnEl = h('div', { class: 'turn', hidden: true }, answerBtn);

  const summarySlot = h('div', { class: 'summary-slot', hidden: true });

  const examples = h('div', { class: 'examples' },
    h('p', { class: 'examples-title' }, 'جرّب أن تقول:'),
    h('ul', { class: 'examples-list', role: 'list' }, EXAMPLES_AR.map((t) =>
      h('li', null, h('button', { type: 'button', class: 'example', onClick: () => { setTextValue(t); focusText(); } }, `«${t}»`)))));

  const resultsSlot = h('div', { class: 'results-slot', hidden: true });

  const stage = h('div', { class: 'home-stage' },
    questionSlot, micWrap, turnEl, statusEl, hintEl, transcriptSlot, summarySlot, cancelBtn, examples, resultsSlot);

  // ── Composer (always reachable) ──
  const inputId = uid('composer');
  const input = h('input', {
    id: inputId, type: 'text', class: 'composer-input', placeholder: 'اكتب طلبك…', autocomplete: 'off',
    enterkeyhint: 'send', dir: 'rtl', spellcheck: 'false', maxlength: 500,
  });
  const sendBtn = h('button', { type: 'submit', class: 'composer-send', 'aria-label': 'إرسال', dataset: { empty: 'true' } },
    icon('send', { size: 22 }));
  const updateSend = () => { sendBtn.dataset.empty = input.value.trim() ? 'false' : 'true'; };
  input.addEventListener('input', updateSend);
  const form = h('form', { class: 'composer', 'aria-label': 'الكتابة بدل الصوت' },
    h('label', { class: 'sr-only', for: inputId }, 'اكتب طلبك أو إجابتك'),
    h('div', { class: 'composer-inner' }, icon('keyboard', { size: 20, className: 'composer-icon' }), input, sendBtn));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    input.value = '';
    updateSend();
    call('onTextSubmit', text);
  });

  el.replaceChildren(h('div', { class: 'home', dataset: { phase: 'ready' } }, stage, form));
  const root = el.firstElementChild;

  // ── Internals ──
  function stopCountdown() {
    if (state.countdown) {
      clearInterval(state.countdown.timer);
      cancelAnimationFrame(state.countdown.raf);
      state.countdown = null;
    }
  }

  // Re-render guards: app.js re-renders on every machine update, so identical calls must be no-ops
  // (no countdown restart, no replayed entrance animation, no repeated role=alert, no focus loss).
  const shown = { review: null, question: null, results: null, saved: null, error: null };
  const keyOf = (v) => { try { return JSON.stringify(v ?? null); } catch { return String(Math.random()); } };
  const isShown = (slot, entry, key) => !!entry && entry.key === key && slot.firstElementChild === entry.el;

  let rescueDepth = 0;
  function focusRescue(fn) {
    if (rescueDepth > 0) { fn(); return; }
    const before = document.activeElement;
    const wasInside = before && root.contains(before);
    rescueDepth += 1;
    try { fn(); } finally { rescueDepth -= 1; }
    if (!wasInside) return;
    const now = document.activeElement;
    const lost = !now || now === document.body || !root.contains(now) || now.closest('[hidden]') || now.disabled;
    if (!lost) return;
    const target = (state.phase === 'results' || state.phase === 'saved_no_results' || state.phase === 'error')
      ? resultsSlot.querySelector('[data-focus-target]')
      : (!questionSlot.hidden && questionSlot.querySelector('.q-text')) || (!micBtn.disabled ? micBtn : statusEl);
    (target || statusEl).focus({ preventScroll: false });
  }

  function apply() {
    const p = state.phase;
    questionSlot.hidden = !(state.hasQuestion && QUESTION_VISIBLE.has(p));
    transcriptSlot.hidden = !(TRANSCRIPT_VISIBLE.has(p) && (p === 'reviewing' ? state.reviewing : state.hasTranscript));
    turnEl.hidden = !(p === 'awaiting_answer' && !state.canAutoListen);
    answerBtn.hidden = state.canAutoListen;
    root.dataset.autolisten = state.canAutoListen ? 'true' : 'false';
    root.dataset.newreq = typeof handlers.onNewRequest === 'function' ? 'true' : 'false';
    let label = STATUS_AR[p];
    let hint = HINT_AR[p] ?? '';
    if (p === 'awaiting_answer') {
      label = state.canAutoListen ? 'دورك — تكلّم الآن، أنا أستمع' : 'دورك — اضغط الزر وأجب';
      hint = state.hasQuestion ? 'أو اختر إجابة جاهزة، أو اكتبها في الأسفل' : 'أو اكتب إجابتك في الأسفل';
    }
    statusEl.textContent = state.labelOverride ?? label;
    hintEl.textContent = state.hintOverride !== undefined ? state.hintOverride : hint;
    hintEl.hidden = !hintEl.textContent;
    summarySlot.hidden = !(state.hasSummary && SUMMARY_VISIBLE.has(p));
    examples.hidden = p !== 'ready';
    resultsSlot.hidden = !RESULT_PHASES.has(p);
    cancelBtn.hidden = !CANCELABLE.has(p);
  }

  function renderError(messageAr) {
    const key = String(messageAr ?? '');
    if (isShown(resultsSlot, shown.error, key)) return;
    const titleId = uid('err');
    const retry = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => call('onRetry') }, icon('refresh', { size: 18 }), 'إعادة المحاولة');
    const restart = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => call('onCancel') }, 'البدء من جديد');
    resultsSlot.replaceChildren(h('section', { class: 'notice notice-error', role: 'alert', 'aria-labelledby': titleId },
      h('span', { class: 'notice-icon', 'aria-hidden': 'true' }, icon('alert', { size: 22 })),
      h('div', { class: 'notice-body' },
        h('h2', { class: 'notice-title', id: titleId, tabIndex: -1, dataset: { focusTarget: '' } }, 'لم ينجح ذلك هذه المرة'),
        h('p', null, ar(messageAr || 'حدث خطأ غير متوقع. لم يضع شيء مما قلته.')),
        h('div', { class: 'notice-actions' }, retry, restart))));
    shown.error = { key, el: resultsSlot.firstElementChild };
  }

  // ── Public API ──
  function setPhase(phase, detail = {}) {
    if (!PHASES.includes(phase)) {
      console.warn('[ui/home] unknown phase', phase);
      return;
    }
    focusRescue(() => {
      const prev = state.phase;
      state.phase = phase;
      root.dataset.phase = phase;
      if (phase !== 'reviewing') { stopCountdown(); state.reviewing = false; }
      if (phase === 'ready') {
        state.hasTranscript = false;
        transcriptText.textContent = '';
        state.hasSummary = false;
        summarySlot.replaceChildren();
        resultsSlot.replaceChildren();
      }
      if (CLEAR_QUESTION_ON.has(phase)) {
        state.hasQuestion = false;
        questionSlot.replaceChildren();
      }
      if (phase === 'listening' && (prev === 'results' || prev === 'saved_no_results')) {
        state.hasSummary = false;
        summarySlot.replaceChildren();
        resultsSlot.replaceChildren();
        state.hasTranscript = false;
        transcriptText.textContent = '';
      }
      if (phase === 'listening') {
        // review card → back to the live transcript card
        if (transcriptSlot.firstElementChild !== transcriptCard) transcriptSlot.replaceChildren(transcriptCard);
      }
      if (phase === 'processing' && transcriptSlot.firstElementChild !== transcriptCard) {
        transcriptSlot.replaceChildren(transcriptCard);
      }
      if (phase === 'error' && (detail.messageAr || !resultsSlot.firstElementChild)) renderError(detail.messageAr);

      state.labelOverride = detail.labelAr ? ar(detail.labelAr) : null;
      state.hintOverride = detail.hintAr !== undefined ? ar(detail.hintAr) : undefined;

      micBtn.setAttribute('aria-pressed', phase === 'listening' ? 'true' : 'false');
      micBtn.setAttribute('aria-label', MIC_AR[phase]);
      micBtn.disabled = BUSY.has(phase);
      transcriptCard.classList.toggle('is-interim', phase === 'listening');
      input.placeholder = (phase === 'asking' || phase === 'speaking' || phase === 'awaiting_answer') ? 'اكتب إجابتك…' : 'اكتب طلبك…';
      apply();
    });
  }

  function showTranscript(text, { interim = false } = {}) {
    const t = String(text ?? '').trim();
    state.hasTranscript = t.length > 0;
    transcriptText.textContent = ar(t);
    transcriptCard.classList.toggle('is-interim', !!interim);
    if (transcriptSlot.firstElementChild !== transcriptCard && state.phase !== 'reviewing') transcriptSlot.replaceChildren(transcriptCard);
    apply();
  }

  function showReview({ text = '', seconds = 5 } = {}) {
    if (state.phase === 'reviewing' && isShown(transcriptSlot, shown.review, String(text))) return;
    focusRescue(() => renderReview(text, seconds));
  }

  function renderReview(text, seconds) {
    stopCountdown();
    const total = Math.max(1, Math.round(Number(seconds) || 5));
    const numEl = h('span', { class: 'countdown-num' }, toArabicDigits(total));
    const timerEl = h('div', { class: 'countdown', role: 'timer', 'aria-label': `يُرسل تلقائيًا خلال ${formatCount(total, NOUNS.second, { acc: true })}`, style: { '--p': '0' } },
      s('svg', { class: 'countdown-ring', viewBox: '0 0 52 52', 'aria-hidden': 'true', focusable: 'false' },
        s('circle', { class: 'countdown-track', cx: 26, cy: 26, r: 22 }),
        s('circle', { class: 'countdown-progress', cx: 26, cy: 26, r: 22, pathLength: 1 })),
      numEl);
    const titleId = uid('review');
    const sendNow = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => { stopCountdown(); call('onSendNow', text); } }, icon('send', { size: 18 }), 'إرسال الآن');
    const edit = h('button', { type: 'button', class: 'btn', onClick: () => { stopCountdown(); call('onEditTranscript', text); } }, icon('edit', { size: 18 }), 'تعديل');
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => { stopCountdown(); call('onCancel'); } }, 'إلغاء');
    const card = h('section', { class: 'review', 'aria-labelledby': titleId },
      h('div', { class: 'review-body' },
        timerEl,
        h('blockquote', { class: 'review-text', id: titleId }, ar(String(text))),
      ),
      h('div', { class: 'review-actions' }, sendNow, edit, cancel));
    transcriptSlot.replaceChildren(card);
    shown.review = { key: String(text), el: card };
    state.reviewing = true;
    state.hasTranscript = !!String(text).trim();
    transcriptText.textContent = ar(String(text));
    setPhase('reviewing');
    state.reviewing = true;
    apply();

    const cd = { remaining: total, timer: 0, raf: 0 };
    state.countdown = cd;
    const setP = (v) => timerEl.style.setProperty('--p', String(Math.min(1, v)));
    // two frames so the 0 → 1/total transition actually animates
    cd.raf = requestAnimationFrame(() => { cd.raf = requestAnimationFrame(() => setP(1 / total)); });
    cd.timer = setInterval(() => {
      cd.remaining -= 1;
      numEl.textContent = toArabicDigits(Math.max(0, cd.remaining));
      timerEl.setAttribute('aria-label', `يُرسل تلقائيًا خلال ${formatCount(Math.max(0, cd.remaining), NOUNS.second, { acc: true })}`);
      if (cd.remaining <= 0) { clearInterval(cd.timer); return; }
      setP((total - cd.remaining + 1) / total);
    }, 1000);
  }

  function showQuestion(q, { canAutoListen = true } = {}) {
    if (!q) { hideQuestion(); return; }
    const key = keyOf(q);
    if (state.hasQuestion && isShown(questionSlot, shown.question, key)) {
      state.canAutoListen = canAutoListen !== false;
      if (!QUESTION_VISIBLE.has(state.phase)) setPhase('asking'); else apply();
      return;
    }
    focusRescue(() => renderQuestion(q, canAutoListen, key));
  }

  function renderQuestion(q, canAutoListen, key) {
    const sameQuestion = questionSlot.firstElementChild?.dataset.qid === String(q.id ?? '');
    state.hasQuestion = true;
    state.canAutoListen = canAutoListen !== false;
    const textId = uid('q');
    const opts = Array.isArray(q.options) ? q.options : [];
    const optionButtons = opts.map((o) => {
      const b = h('button', { type: 'button', class: 'chip-btn', dataset: { value: o.value } }, ar(o.label));
      b.addEventListener('click', () => {
        // disabling the focused chip would drop focus to <body>; focusRescue moves it to the question text
        focusRescue(() => { for (const other of optionButtons) { other.disabled = true; other.dataset.chosen = other === b ? 'true' : 'false'; } });
        call('onOption', o.value);
      });
      return b;
    });
    const card = h('article', { class: ['q-card', sameQuestion && 'no-enter'], 'aria-labelledby': textId, dataset: { qid: q.id ?? '', field: q.field ?? '' } },
      h('div', { class: 'q-head' },
        h('span', { class: 'q-speaking', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i')),
        h('span', { class: 'q-kicker' }, Number(q.attempt) > 1 ? 'لم أفهم تمامًا — مرة أخرى' : 'سؤال')),
      h('h2', { class: 'q-text', id: textId, tabIndex: -1 }, ar(q.text)),
      q.conflict
        ? h('div', { class: 'q-conflict' },
          h('p', null, h('span', { class: 'muted' }, 'قلت سابقًا: '), h('strong', null, ar(q.conflict.existing))),
          h('p', null, h('span', { class: 'muted' }, 'والآن: '), h('strong', null, ar(q.conflict.incoming))))
        : null,
      optionButtons.length ? h('div', { class: 'q-options', role: 'group', 'aria-label': 'إجابات سريعة' }, optionButtons) : null);
    questionSlot.replaceChildren(card);
    shown.question = { key, el: card };
    if (!QUESTION_VISIBLE.has(state.phase)) setPhase('asking');
    else apply();
  }

  function hideQuestion() {
    state.hasQuestion = false;
    focusRescue(() => { questionSlot.replaceChildren(); apply(); });
  }

  function showSummary(summary) {
    const chips = Array.isArray(summary?.chips) ? summary.chips : [];
    if (!summary || (!summary.titleAr && chips.length === 0)) {
      state.hasSummary = false;
      summarySlot.replaceChildren();
      apply();
      return;
    }
    state.hasSummary = true;
    summarySlot.replaceChildren(h('section', { class: 'summary', 'aria-label': 'ما فهمته حتى الآن' },
      summary.titleAr
        ? h('p', { class: 'summary-title' }, h('span', { class: 'summary-kicker' }, 'فهمت: '), h('strong', null, ar(summary.titleAr)))
        : null,
      chipList(chips.map((c) => ({ labelAr: c.labelAr, valueAr: c.valueAr })), { compact: true })));
    apply();
  }

  function showResults(run) {
    const key = keyOf(run);
    const label = resultsLabel(run);
    if (isShown(resultsSlot, shown.results, key)) { setPhase('results', { labelAr: label }); return; }
    focusRescue(() => renderResults(run, key, label));
  }

  function resultsLabel(run) {
    const t = run?.totals || {};
    return (Number(t.confirmed) || 0) + (Number(t.possible) || 0) > 0 ? STATUS_AR.results : 'لم أجد ما يطابق تمامًا بعد';
  }

  function renderResults(run, key, label) {
    const r = run || {};
    const items = Array.isArray(r.page?.items) ? r.page.items : [];
    const totals = r.totals || {};
    const confirmed = Number(totals.confirmed) || 0;
    const possible = Number(totals.possible) || 0;
    const side = items[0]?.mine?.side;
    const titleId = uid('results');
    const total = confirmed + possible;
    const title = total > 0 ? `وجدت ${formatCount(total, NOUNS.match, { acc: true })}` : 'لا توجد مطابقات مؤكدة بعد';

    const stats = h('ul', { class: 'result-stats', role: 'list' },
      h('li', { class: 'stat stat-confirmed' }, h('span', { class: 'stat-num' }, formatNumber(confirmed)), h('span', null, 'مؤكدة')),
      h('li', { class: 'stat stat-possible' }, h('span', { class: 'stat-num' }, formatNumber(possible)), h('span', null, 'محتملة')),
      Number(totals.candidates) > 0
        ? h('li', { class: 'stat stat-checked' }, h('span', { class: 'stat-num' }, formatNumber(totals.candidates)), h('span', null, 'فُحصت'))
        : null);

    const pageTotal = Number(r.page?.total) || items.length;
    const more = pageTotal > items.length && typeof handlers.onOpenMatches === 'function'
      ? h('button', { type: 'button', class: 'btn btn-wide', onClick: () => call('onOpenMatches') }, `عرض كل المطابقات (${formatNumber(pageTotal)})`, icon('chevronLeft', { size: 18 }))
      : null;

    const cardHandlers = {
      onContact: handlers.onContact ? (m) => call('onContact', m) : undefined,
      onRespond: (m, accept) => call('onRespond', m, accept),
      onOpenIntent: handlers.onOpenIntent ? (i) => call('onOpenIntent', i) : undefined,
    };

    resultsSlot.replaceChildren(h('section', { class: 'results', 'aria-labelledby': titleId },
      h('h2', { class: 'results-title', id: titleId, tabIndex: -1, dataset: { focusTarget: '' } }, title),
      stats,
      r.status === 'queued'
        ? h('p', { class: 'results-note' }, icon('hourglass', { size: 16 }), 'ما زال البحث جاريًا في الخلفية، وسنخبرك بأي جديد.')
        : null,
      exclusionSummary(r.exclusions, totals.excluded, side),
      suggestionsBlock(r.suggestionsAr, (sug) => call('onSuggestion', sug)),
      items.length
        ? h('ol', { class: 'match-list', role: 'list' }, items.map((m, i) =>
          h('li', { class: 'card-enter', style: { '--i': String(i) } }, matchCard(m, cardHandlers))))
        : null,
      r.truncated ? h('p', { class: 'results-note' }, icon('info', { size: 16 }), 'تُعرض أفضل النتائج فقط.') : null,
      more));
    shown.results = { key, el: resultsSlot.firstElementChild };
    setPhase('results', { labelAr: label });
  }

  function showSavedNoResults(intent, suggestions, run) {
    const key = keyOf([intent, suggestions, run?.exclusions, run?.totals]);
    if (isShown(resultsSlot, shown.saved, key)) { setPhase('saved_no_results'); return; }
    focusRescue(() => renderSaved(intent, suggestions, run, key));
  }

  function renderSaved(intent, suggestions, run, key) {
    const side = intent?.side;
    const titleId = uid('saved');
    const msg = side === 'provide'
      ? 'تم حفظ عرضك، سنخبرك عند ظهور طلبات مناسبة'
      : side === 'join'
        ? 'تم حفظ نشاطك، سنخبرك عند انضمام أشخاص مناسبين'
        : 'تم حفظ طلبك، سنخبرك عند ظهور مطابقات مناسبة';
    const listLabel = side === 'provide' ? 'عروضي' : 'طلباتي';
    resultsSlot.replaceChildren(h('section', { class: 'saved', 'aria-labelledby': titleId },
      h('span', { class: 'saved-icon', 'aria-hidden': 'true' }, icon('check', { size: 30 })),
      h('h2', { class: 'saved-title', id: titleId, tabIndex: -1, dataset: { focusTarget: '' } }, msg),
      h('p', { class: 'saved-note' }, 'لا داعي للانتظار هنا — سيصلك تنبيه في «التنبيهات».'),
      run ? exclusionSummary(run.exclusions, run.totals?.excluded, side) : null,
      intent ? h('div', { class: 'saved-intent' }, intentCard(intent)) : null,
      suggestionsBlock(suggestions, (sug) => call('onSuggestion', sug)),
      h('div', { class: 'saved-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: () => call('onOpenRequests', intent) }, icon(side === 'provide' ? 'tag' : 'search', { size: 18 }), `اذهب إلى ${listLabel}`),
        typeof handlers.onNewRequest === 'function'
          ? h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => call('onNewRequest') }, icon('mic', { size: 18 }), 'طلب جديد')
          : null)));
    shown.saved = { key, el: resultsSlot.firstElementChild };
    setPhase('saved_no_results');
  }

  function showError(messageAr) {
    focusRescue(() => { renderError(messageAr); setPhase('error'); });
  }

  function setTextValue(text) {
    input.value = String(text ?? '');
    updateSend();
  }

  function focusText() {
    input.focus();
    const n = input.value.length;
    try { input.setSelectionRange(n, n); } catch { /* not all input types support selection */ }
  }

  setPhase('ready');

  return {
    el: root,
    get phase() { return state.phase; },
    setPhase,
    showTranscript,
    showReview,
    showQuestion,
    hideQuestion,
    showSummary,
    showResults,
    showSavedNoResults,
    showError,
    setTextValue,
    focusText,
  };
}
