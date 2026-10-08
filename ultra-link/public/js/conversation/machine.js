// Ultra Link — conversation state machine (client side).
// Pure and framework-free: no DOM, no window, no fetch. The API, the voice layer and the clock
// are injected, so the whole flow runs in Node tests with fakes.
//
// States (docs/CONTRACTS.md): ready → listening → reviewing → processing → asking → speaking →
// awaiting_answer → listening … → saving → searching → results | saved_no_results; any → error.

import { speakableText } from './speech-text.js';

export const STATES = Object.freeze([
  'ready',
  'listening',
  'reviewing',
  'processing',
  'asking',
  'speaking',
  'awaiting_answer',
  'saving',
  'searching',
  'results',
  'saved_no_results',
  'error',
]);

/**
 * Explicit transition table: state → event → allowed target states.
 * Anything not listed is rejected (and recorded in the event log with ok:false).
 */
export const TRANSITIONS = Object.freeze({
  ready: {
    LISTEN: ['listening'],
    SUBMIT_TEXT: ['processing'],
    RESUME: ['ready', 'awaiting_answer'],
    RESET: ['ready'],
  },
  listening: {
    INTERIM: ['listening'],
    STOP: ['listening'],
    LISTEN: ['listening'], // restart (re-record)
    FINAL: ['reviewing'],
    VOICE_EMPTY: ['ready', 'awaiting_answer'],
    VOICE_ERROR: ['error'],
    SUBMIT_TEXT: ['processing'], // e.g. quick-answer chip tapped while auto-listening
    CANCEL: ['ready', 'awaiting_answer'],
    RESET: ['ready'],
  },
  reviewing: {
    EDIT: ['reviewing'],
    EDIT_TEXT: ['reviewing'],
    SEND: ['processing'],
    SUBMIT_TEXT: ['processing'],
    LISTEN: ['listening'], // correct by speaking again
    CANCEL: ['ready', 'awaiting_answer'],
    RESET: ['ready'],
  },
  processing: {
    TURN_ASK: ['asking'],
    TURN_SAVED: ['saving'],
    TURN_CANCELLED: ['ready'],
    TURN_FAILED: ['error'],
    CANCEL: ['ready', 'awaiting_answer'],
    RESET: ['ready'],
  },
  asking: {
    SPEAK: ['speaking'],
    SPEAK_SKIPPED: ['awaiting_answer'],
    LISTEN: ['listening'],
    SUBMIT_TEXT: ['processing'],
    CANCEL: ['ready'],
    RESET: ['ready'],
  },
  speaking: {
    SPOKEN: ['awaiting_answer'],
    LISTEN: ['listening'], // barge-in: stop speaking, then listen
    SUBMIT_TEXT: ['processing'],
    CANCEL: ['ready'],
    RESET: ['ready'],
  },
  awaiting_answer: {
    LISTEN: ['listening'],
    SUBMIT_TEXT: ['processing'],
    REPEAT: ['speaking'],
    CANCEL: ['ready'],
    RESET: ['ready'],
  },
  saving: {
    SEARCH: ['searching'],
    RESET: ['ready'],
  },
  searching: {
    MATCH_DONE: ['results', 'saved_no_results'],
    MATCH_FAILED: ['error'],
    RESET: ['ready'],
  },
  results: {
    LISTEN: ['listening'],
    SUBMIT_TEXT: ['processing'],
    RESET: ['ready'],
  },
  saved_no_results: {
    LISTEN: ['listening'],
    SUBMIT_TEXT: ['processing'],
    RESET: ['ready'],
  },
  error: {
    RETRY: ['processing', 'searching', 'listening'],
    LISTEN: ['listening'],
    SUBMIT_TEXT: ['processing'],
    DISMISS: ['ready', 'awaiting_answer', 'saved_no_results'],
    RESET: ['ready'],
  },
});

export const MESSAGES_AR = Object.freeze({
  savedNoResults: 'تم حفظ طلبك، سنخبرك عند ظهور مطابقات مناسبة',
  unclear: 'لم أفهم طلبك تمامًا. قل ما تحتاجه بكلمات أخرى، مثلًا: بدي شقة للإيجار بإعزاز.',
  turnFailed: 'تعذّر إرسال طلبك. تحقّق من الاتصال ثم أعد المحاولة.',
  matchFailed: 'تم حفظ طلبك، لكن تعذّر البحث عن مطابقات الآن. أعد المحاولة.',
  offline: 'لا يوجد اتصال بالإنترنت. أعد المحاولة بعد عودة الاتصال.',
  unauthorized: 'انتهت جلستك. سجّل الدخول من جديد ثم أعد المحاولة.',
  badResponse: 'وصل رد غير متوقع من الخادم. أعد المحاولة.',
  voiceUnavailable: 'التحدث غير متاح في هذا المتصفح. اكتب طلبك بدلًا من ذلك.',
});

/** Arabic count phrase for the results announcement (correct dual/plural forms). */
export function resultsMessageAr(n) {
  if (n === 1) return 'وجدنا مطابقة واحدة لطلبك.';
  if (n === 2) return 'وجدنا مطابقتين لطلبك.';
  if (n >= 3 && n <= 10) return `وجدنا ${n} مطابقات لطلبك.`;
  return `وجدنا ${n} مطابقة لطلبك.`;
}

export function randomUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID(); // requires a secure context in browsers
    } catch {
      /* fall through */
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function defaultClock() {
  const g = globalThis;
  return {
    now: () => (g.performance && typeof g.performance.now === 'function' ? g.performance.now() : Date.now()),
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (id) => g.clearTimeout(id),
  };
}

const ANSWER_STATES = new Set(['asking', 'speaking', 'awaiting_answer']);

/**
 * @param {object} deps
 * @param {{ensureConversation: () => Promise<{id: string}>, sendTurn: (id: string, body: {text: string, modality: 'voice'|'text', clientTurnId: string}) => Promise<any>, runMatch: (intentId: string) => Promise<any>, cancelConversation?: (id: string) => Promise<any>}} deps.api
 * @param {ReturnType<import('./voice.js').createVoice> | null} [deps.voice]
 * @param {{now: () => number, setTimeout: Function, clearTimeout: Function}} [deps.clock]
 * @param {number} [deps.autoSendMs=1600]  review countdown before auto-send
 */
export function createConversationMachine(deps = {}) {
  const api = deps.api;
  if (!api || typeof api.sendTurn !== 'function' || typeof api.runMatch !== 'function' || typeof api.ensureConversation !== 'function') {
    throw new TypeError('createConversationMachine: api.ensureConversation, api.sendTurn and api.runMatch are required');
  }
  const voice = deps.voice || null;
  const clock = deps.clock || defaultClock();
  const autoSendMs = deps.autoSendMs ?? 1600;
  const savingMs = deps.savingMs ?? 600;
  const autoListen = deps.autoListen !== false;
  const autoListenAfterText = !!deps.autoListenAfterText;
  const speakQuestions = deps.speakQuestions !== false;
  const announce = deps.announce ?? 'voice'; // 'voice' | 'always' | 'never'
  const optionText = typeof deps.optionText === 'function' ? deps.optionText : (o) => (o && (o.label || o.value)) || '';
  const uuid = typeof deps.uuid === 'function' ? deps.uuid : randomUuid;
  const logLimit = deps.logLimit ?? 300;
  const isOffline = typeof deps.isOffline === 'function' ? deps.isOffline : () => globalThis.navigator?.onLine === false;

  let state = 'ready';
  const ctx = {
    conversationId: null,
    transcript: '',
    interim: '',
    question: null,
    lastTurn: null,
    intent: null,
    matchRun: null,
    error: null,
    seq: 0,
    // extras for the UI
    origin: 'ready', // where cancel / an empty recording returns to: 'ready' | 'awaiting_answer'
    review: null, // {deadline, autoSendMs, editing, original, modality}
    pendingTurn: null, // {text, modality, clientTurnId} — kept for retry
    modality: null, // modality of the latest user turn
    micLive: false, // recognition actually capturing audio
    speech: null, // {status, text, reason?} for the last question
    notice: null, // {kind, messageAr}
    canAutoListen: false,
    savedConversationId: null,
  };

  const subs = new Set();
  const log = [];
  let logIndex = 0;
  let reviewTimer = null;
  let savingTimer = null;
  let listenToken = 0;
  let speakToken = 0;
  let destroyed = false;
  const emitQueue = [];
  let emitting = false;

  const voiceCanAutoListen = () => {
    try {
      return !!(voice && typeof voice.canAutoListen === 'function' && voice.canAutoListen());
    } catch {
      return false;
    }
  };
  const voiceCanSpeak = () => {
    if (!voice || typeof voice.speak !== 'function') return false;
    try {
      return typeof voice.canSpeak === 'function' ? !!voice.canSpeak() : true;
    } catch {
      return false;
    }
  };
  const voiceIsSpeaking = () => {
    try {
      return !!(voice && typeof voice.isSpeaking === 'function' && voice.isSpeaking());
    } catch {
      return false;
    }
  };
  const voiceCall = (name, ...args) => {
    if (voice && typeof voice[name] === 'function') {
      try {
        return voice[name](...args);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  function record(entry) {
    log.push({ i: ++logIndex, t: Math.round(clock.now()), seq: ctx.seq, ...entry });
    if (log.length > logLimit) log.shift();
  }

  function snapshot() {
    return Object.freeze({ ...ctx, review: ctx.review ? { ...ctx.review } : null, error: ctx.error ? { ...ctx.error } : null });
  }

  function emit(event) {
    ctx.canAutoListen = voiceCanAutoListen();
    emitQueue.push([state, snapshot(), event]);
    if (emitting) return; // nested transition from inside a subscriber: delivered in order afterwards
    emitting = true;
    try {
      while (emitQueue.length) {
        const [s, c, e] = emitQueue.shift();
        for (const fn of [...subs]) {
          try {
            fn(s, c, e);
          } catch (err) {
            record({ event: 'SUBSCRIBER_ERROR', from: s, to: null, ok: false, reason: String((err && err.message) || err) });
          }
        }
      }
    } finally {
      emitting = false;
    }
  }

  function can(event) {
    return !destroyed && !!TRANSITIONS[state] && !!TRANSITIONS[state][event];
  }

  function reject(event, reason = 'invalid_transition') {
    record({ event, from: state, to: null, ok: false, reason });
    return false;
  }

  /** The only place `state` changes. */
  function transition(event, to, patch, info) {
    const from = state;
    const allowed = TRANSITIONS[from] && TRANSITIONS[from][event];
    if (destroyed || !allowed || !allowed.includes(to)) {
      record({ event, from, to, ok: false, reason: destroyed ? 'destroyed' : 'invalid_transition' });
      return false;
    }
    if (patch) Object.assign(ctx, patch);
    state = to;
    record({ event, from, to, ok: true, ...(info ? { info } : {}) });
    emit({ type: event, from, to, ...(info ? { info } : {}) });
    return true;
  }

  function clearReviewTimer() {
    if (reviewTimer !== null) {
      clock.clearTimeout(reviewTimer);
      reviewTimer = null;
    }
  }
  function clearSavingTimer() {
    if (savingTimer !== null) {
      clock.clearTimeout(savingTimer);
      savingTimer = null;
    }
  }

  /** Is the next user input an answer to an open question in the current conversation? */
  function answering() {
    return !!(ctx.conversationId && ctx.question);
  }

  function clearRequest() {
    return { conversationId: null, question: null, intent: null, matchRun: null, lastTurn: null, pendingTurn: null, speech: null };
  }

  // ---------------- listening ----------------

  function startListening(event = 'LISTEN') {
    if (!can(event)) return reject(event);
    const from = state;
    clearReviewTimer();
    const fresh = from === 'results' || from === 'saved_no_results';
    const patch = fresh ? clearRequest() : {};
    // half-duplex: barge-in stops our own speech before the mic opens (voice.listen also waits a guard delay)
    speakToken++;
    if (voiceIsSpeaking()) voiceCall('stopSpeaking');
    const token = ++listenToken;
    const origin = !fresh && (ANSWER_STATES.has(from) || answering()) ? 'awaiting_answer' : 'ready';
    if (!transition(event, 'listening', { ...patch, origin, transcript: '', interim: '', micLive: false, error: null, notice: null, review: null })) return false;
    if (!voice || typeof voice.listen !== 'function') {
      onVoiceError(token, { code: 'unsupported', recoverable: false, messageAr: MESSAGES_AR.voiceUnavailable, offerText: true });
      return true;
    }
    const handlers = {
      onStart: () => {
        if (token !== listenToken || state !== 'listening') return;
        ctx.micLive = true;
        emit({ type: 'MIC_LIVE', from: state, to: state });
      },
      onInterim: (text) => {
        if (token !== listenToken || state !== 'listening') return;
        transition('INTERIM', 'listening', { interim: String(text || '') }, { len: String(text || '').length });
      },
      onFinal: (text) => {
        if (token !== listenToken || state !== 'listening') return;
        const t = String(text || '').trim();
        if (!t) return onVoiceError(token, { code: 'no-speech', recoverable: true, messageAr: 'لم نسمع شيئًا. حاول مرة أخرى.', offerText: true });
        listenToken++; // this recording is over; ignore late callbacks
        enterReview(t, 'voice');
      },
      onError: (err) => onVoiceError(token, err),
      onEnd: (reason) => {
        if (token !== listenToken) return;
        ctx.micLive = false;
        if (state === 'listening') {
          // ended with neither a result nor an error (e.g. aborted by the browser)
          listenToken++;
          transition('VOICE_EMPTY', ctx.origin, { interim: '' }, { reason });
        }
      },
    };
    const startFailed = (e) =>
      onVoiceError(token, { code: 'start-failed', recoverable: true, messageAr: 'تعذّر تشغيل الميكروفون. حاول مرة أخرى أو اكتب طلبك.', offerText: true, detail: String(e) });
    // Called synchronously (after the transition) so a cancel can always reach the voice session.
    try {
      Promise.resolve(voice.listen(handlers)).catch(startFailed);
    } catch (e) {
      startFailed(e);
    }
    return true;
  }

  function onVoiceError(token, err) {
    if (token !== listenToken || state !== 'listening') return;
    if (err && err.code === 'aborted') return; // our own abort; onEnd handles the rest
    listenToken++;
    const e = { kind: 'voice', code: 'unknown', recoverable: true, messageAr: '', offerText: true, ...(err || {}), origin: ctx.origin };
    transition('VOICE_ERROR', 'error', { error: e, micLive: false, interim: '' }, { code: e.code });
  }

  function stopListening() {
    if (state !== 'listening') return reject('STOP');
    voiceCall('stopListening');
    return transition('STOP', 'listening');
  }

  function enterReview(text, modality) {
    clearReviewTimer();
    const deadline = autoSendMs > 0 ? clock.now() + autoSendMs : null;
    if (!transition('FINAL', 'reviewing', { transcript: text, interim: '', micLive: false, review: { deadline, autoSendMs, editing: false, original: text, modality } }, { len: text.length })) return;
    if (autoSendMs <= 0) return void send('auto');
    reviewTimer = clock.setTimeout(() => {
      reviewTimer = null;
      if (state === 'reviewing' && ctx.review && !ctx.review.editing) send('auto');
    }, autoSendMs);
  }

  function send(trigger, overrideText) {
    if (state !== 'reviewing') return reject('SEND');
    const text = String(overrideText ?? ctx.transcript ?? '').trim();
    if (!text) return cancel();
    clearReviewTimer();
    const review = ctx.review || { modality: 'voice', original: text, editing: false };
    // a transcript the user changed by typing is a text turn; an untouched one keeps its modality
    const modality = text !== review.original ? 'text' : review.modality || 'voice';
    return beginTurn('SEND', text, modality, { trigger });
  }

  // ---------------- turns ----------------

  function beginTurn(event, text, modality, info) {
    const from = state;
    const fresh = from === 'results' || from === 'saved_no_results';
    const base = fresh ? clearRequest() : {};
    const origin = !fresh && answering() ? 'awaiting_answer' : 'ready';
    const turn = { text, modality, clientTurnId: uuid() };
    const ok = transition(
      event,
      'processing',
      { ...base, origin, pendingTurn: turn, transcript: text, interim: '', review: null, error: null, notice: null, micLive: false, modality },
      { ...(info || {}), modality, len: text.length },
    );
    if (ok) dispatchTurn(turn);
    return ok;
  }

  function dispatchTurn(turn) {
    const mySeq = ++ctx.seq;
    const stale = (where) => {
      record({ event: 'STALE_RESPONSE', from: state, to: null, ok: false, reason: 'stale', info: { where, requestSeq: mySeq, currentSeq: ctx.seq } });
    };
    (async () => {
      try {
        let convId = ctx.conversationId;
        if (!convId) {
          const conv = await api.ensureConversation();
          if (mySeq !== ctx.seq || state !== 'processing') return stale('ensureConversation');
          convId = conv && (conv.id || (conv.conversation && conv.conversation.id));
          if (!convId) throw Object.assign(new Error('ensureConversation returned no id'), { code: 'bad_response' });
          ctx.conversationId = convId;
        }
        const res = await api.sendTurn(convId, { text: turn.text, modality: turn.modality, clientTurnId: turn.clientTurnId });
        if (mySeq !== ctx.seq || state !== 'processing') return stale('sendTurn');
        handleTurnResult(res);
      } catch (e) {
        if (mySeq !== ctx.seq || state !== 'processing') return stale('sendTurn:error');
        const err = apiError(e, 'turn');
        if (err.status === 404) ctx.conversationId = null; // conversation gone: retry opens a new one (same clientTurnId)
        transition('TURN_FAILED', 'error', { error: { ...err, origin: ctx.origin } }, { code: err.code, status: err.status });
      }
    })();
  }

  function apiError(e, kind) {
    const status = Number((e && (e.status ?? e.statusCode)) || 0);
    const offline = isOffline();
    const code = String((e && (e.code || e.error)) || (offline ? 'offline' : status ? `http_${status}` : 'network'));
    const recoverable = !(status === 400 || status === 401 || status === 403 || status === 422 || code === 'bad_response_contract');
    let messageAr = (e && typeof e.messageAr === 'string' && e.messageAr) || '';
    if (kind === 'match') messageAr = MESSAGES_AR.matchFailed;
    else if (!messageAr) messageAr = offline ? MESSAGES_AR.offline : status === 401 ? MESSAGES_AR.unauthorized : code === 'bad_response' ? MESSAGES_AR.badResponse : MESSAGES_AR.turnFailed;
    return { kind, code, status, recoverable, messageAr, offerText: true, detailAr: e && e.messageAr && kind === 'match' ? e.messageAr : undefined };
  }

  function handleTurnResult(res) {
    if (!res || typeof res !== 'object' || !res.action) {
      return transition('TURN_FAILED', 'error', { error: { ...apiError({ code: 'bad_response' }, 'turn'), origin: ctx.origin } }, { code: 'bad_response' });
    }
    if (res.conversation && res.conversation.id) ctx.conversationId = res.conversation.id;
    ctx.lastTurn = res;
    switch (res.action) {
      case 'ask':
      case 'unclear': {
        // the server says what exactly is missing (or greets); the generic text is only a fallback
        const unclearAr = typeof res.messageAr === 'string' && res.messageAr.trim() ? res.messageAr : MESSAGES_AR.unclear;
        const q = res.question || {
          id: 'client.unclear',
          field: 'unclear',
          text: unclearAr,
          speech: unclearAr,
          options: [],
          attempt: (ctx.question && ctx.question.attempt ? ctx.question.attempt : 0) + 1,
          client: true,
        };
        if (!transition('TURN_ASK', 'asking', { question: q, pendingTurn: null, notice: res.action === 'unclear' ? { kind: 'unclear', messageAr: res.action === 'unclear' && typeof res.messageAr === 'string' && res.messageAr.trim() ? res.messageAr : MESSAGES_AR.unclear } : null }, { action: res.action, field: q.field })) return;
        afterAsk();
        return;
      }
      case 'saved': {
        if (!res.intent || !res.intent.id) {
          return transition('TURN_FAILED', 'error', { error: { ...apiError({ code: 'bad_response' }, 'turn'), origin: ctx.origin } }, { code: 'bad_response' });
        }
        // the conversation is finished: the next utterance starts a NEW request
        if (!transition('TURN_SAVED', 'saving', { intent: res.intent, question: null, pendingTurn: null, savedConversationId: ctx.conversationId, conversationId: null }, { intentId: res.intent.id })) return;
        clearSavingTimer();
        savingTimer = clock.setTimeout(() => {
          savingTimer = null;
          if (state === 'saving' && transition('SEARCH', 'searching', { matchRun: null })) runMatch();
        }, savingMs);
        return;
      }
      case 'cancelled':
        transition('TURN_CANCELLED', 'ready', { ...clearRequest(), transcript: '' });
        return;
      default:
        transition('TURN_FAILED', 'error', { error: { ...apiError({ code: 'bad_response' }, 'turn'), origin: ctx.origin } }, { code: 'bad_response', action: String(res.action) });
    }
  }

  // ---------------- question: speak, then listen ----------------

  function afterAsk() {
    if (state !== 'asking') return;
    const text = speakableText(ctx.question);
    if (!speakQuestions || !text || !voiceCanSpeak()) {
      const reason = !speakQuestions ? 'disabled' : !text ? 'empty' : 'unavailable';
      if (transition('SPEAK_SKIPPED', 'awaiting_answer', { speech: { status: 'skipped', reason, text } }, { reason })) maybeAutoListen();
      return;
    }
    speakQuestion('SPEAK', text);
  }

  function speakQuestion(event, text) {
    // half-duplex: make sure no recognition is running before we speak (voice.speak also aborts it)
    listenToken++;
    voiceCall('abortListening', 'speak');
    const token = ++speakToken;
    if (!transition(event, 'speaking', { speech: { status: 'speaking', text }, micLive: false })) return false;
    let p;
    try {
      p = Promise.resolve(voice.speak(text));
    } catch (e) {
      p = Promise.resolve({ ok: false, reason: 'error', error: String(e) });
    }
    p.then(
      (r) => onSpoken(token, r || { ok: false, reason: 'unknown' }),
      (e) => onSpoken(token, { ok: false, reason: 'error', error: String(e) }),
    );
    return true;
  }

  function onSpoken(token, r) {
    if (token !== speakToken || state !== 'speaking') return;
    if (!transition('SPOKEN', 'awaiting_answer', { speech: { ...(ctx.speech || {}), status: r.ok ? 'spoken' : r.reason || 'failed' } }, { reason: r.reason })) return;
    maybeAutoListen();
  }

  function maybeAutoListen() {
    if (state !== 'awaiting_answer') return;
    const userUsesVoice = ctx.modality === 'voice' || autoListenAfterText;
    if (autoListen && userUsesVoice && voiceCanAutoListen()) {
      startListening('LISTEN');
    } else {
      record({ event: 'AUTO_LISTEN_SKIPPED', from: state, to: null, ok: true, info: { canAutoListen: voiceCanAutoListen(), modality: ctx.modality } });
    }
  }

  // ---------------- matching ----------------

  function runMatch() {
    const mySeq = ++ctx.seq;
    const intentId = ctx.intent && ctx.intent.id;
    Promise.resolve()
      .then(() => api.runMatch(intentId))
      .then(
        (mr) => {
          if (mySeq !== ctx.seq || state !== 'searching') {
            record({ event: 'STALE_RESPONSE', from: state, to: null, ok: false, reason: 'stale', info: { where: 'runMatch', requestSeq: mySeq, currentSeq: ctx.seq } });
            return;
          }
          const totals = (mr && mr.totals) || {};
          const n = (Number(totals.confirmed) || 0) + (Number(totals.possible) || 0);
          const to = n > 0 ? 'results' : 'saved_no_results';
          const notice = to === 'saved_no_results' ? { kind: 'saved', messageAr: MESSAGES_AR.savedNoResults } : { kind: 'results', messageAr: resultsMessageAr(n) };
          if (transition('MATCH_DONE', to, { matchRun: mr, notice }, { total: n, status: mr && mr.status })) announceOutcome(notice.messageAr);
        },
        (e) => {
          if (mySeq !== ctx.seq || state !== 'searching') {
            record({ event: 'STALE_RESPONSE', from: state, to: null, ok: false, reason: 'stale', info: { where: 'runMatch:error' } });
            return;
          }
          const err = apiError(e, 'match');
          transition('MATCH_FAILED', 'error', { error: { ...err, recoverable: true, origin: 'saved_no_results' } }, { code: err.code });
        },
      );
  }

  function announceOutcome(text) {
    const should = announce === 'always' || (announce === 'voice' && ctx.modality === 'voice');
    if (!should || !voiceCanSpeak()) return;
    speakToken++; // not a question: no auto-listen afterwards
    Promise.resolve()
      .then(() => voice.speak(text))
      .catch(() => {});
  }

  // ---------------- public commands ----------------

  function pressMic() {
    if (state === 'listening') return stopListening();
    return startListening('LISTEN');
  }

  function edit() {
    if (state !== 'reviewing') return reject('EDIT');
    clearReviewTimer();
    return transition('EDIT', 'reviewing', { review: { ...(ctx.review || {}), editing: true, deadline: null } });
  }

  function updateDraft(text) {
    if (state !== 'reviewing') return reject('EDIT_TEXT');
    clearReviewTimer();
    const t = String(text ?? '');
    return transition('EDIT_TEXT', 'reviewing', { transcript: t, review: { ...(ctx.review || {}), editing: true, deadline: null } }, { len: t.length });
  }

  function sendNow(text) {
    return send('user', text);
  }

  function submitText(text) {
    const t = String(text ?? '').trim();
    if (!t) return reject('SUBMIT_TEXT', 'empty');
    if (!can('SUBMIT_TEXT')) return reject('SUBMIT_TEXT');
    if (state === 'listening') {
      listenToken++;
      voiceCall('abortListening', 'text');
    }
    if (state === 'reviewing') clearReviewTimer();
    if (state === 'speaking' || state === 'asking') {
      speakToken++;
      voiceCall('stopSpeaking');
    }
    return beginTurn('SUBMIT_TEXT', t, 'text');
  }

  function chooseOption(option) {
    return submitText(optionText(option));
  }

  function cancel() {
    switch (state) {
      case 'listening':
        listenToken++;
        voiceCall('abortListening', 'cancel');
        return transition('CANCEL', ctx.origin === 'awaiting_answer' ? 'awaiting_answer' : 'ready', { transcript: '', interim: '', micLive: false });
      case 'reviewing':
        clearReviewTimer();
        return transition('CANCEL', ctx.origin === 'awaiting_answer' ? 'awaiting_answer' : 'ready', { transcript: '', review: null });
      case 'processing': {
        ctx.seq++; // any in-flight response is now stale and will be ignored
        const back = ctx.origin === 'awaiting_answer' && ctx.question ? 'awaiting_answer' : 'ready';
        if (back === 'ready') {
          // abandoning the whole (first) request: close it server-side, best effort
          const id = ctx.conversationId;
          const ok = transition('CANCEL', 'ready', { ...clearRequest(), transcript: '' });
          if (ok && id) cancelServerConversation(id);
          return ok;
        }
        return transition('CANCEL', back, { pendingTurn: null, transcript: '' });
      }
      case 'asking':
      case 'speaking':
      case 'awaiting_answer': {
        // cancel the whole request in progress
        speakToken++;
        listenToken++;
        voiceCall('stopSpeaking');
        const id = ctx.conversationId;
        const ok = transition('CANCEL', 'ready', { ...clearRequest(), transcript: '', notice: null });
        if (ok && id) cancelServerConversation(id);
        return ok;
      }
      default:
        return reject('CANCEL');
    }
  }

  function cancelServerConversation(id) {
    if (typeof api.cancelConversation !== 'function') return;
    Promise.resolve()
      .then(() => api.cancelConversation(id))
      .catch(() => record({ event: 'CANCEL_SERVER_FAILED', from: state, to: null, ok: false, reason: 'api_error' }));
  }

  function retry() {
    if (state !== 'error') return reject('RETRY');
    const err = ctx.error || {};
    if (err.recoverable === false) return reject('RETRY', 'not_recoverable');
    if (err.kind === 'turn' && ctx.pendingTurn) {
      // same text, same clientTurnId → the server dedupes if the first attempt actually landed
      if (!transition('RETRY', 'processing', { error: null }, { kind: 'turn' })) return false;
      dispatchTurn(ctx.pendingTurn);
      return true;
    }
    if (err.kind === 'match' && ctx.intent) {
      if (!transition('RETRY', 'searching', { error: null }, { kind: 'match' })) return false;
      runMatch();
      return true;
    }
    if (err.kind === 'voice') return startListening('RETRY');
    return reject('RETRY', 'nothing_to_retry');
  }

  function dismissError() {
    if (state !== 'error') return reject('DISMISS');
    const err = ctx.error || {};
    const to = err.kind === 'match' ? 'saved_no_results' : answering() ? 'awaiting_answer' : 'ready';
    const notice = to === 'saved_no_results' ? { kind: 'saved', messageAr: MESSAGES_AR.savedNoResults } : null;
    return transition('DISMISS', to, { error: null, notice });
  }

  function repeatQuestion() {
    if (state !== 'awaiting_answer' || !ctx.question) return reject('REPEAT');
    const text = speakableText(ctx.question);
    if (!text || !voiceCanSpeak()) return reject('REPEAT', 'cannot_speak');
    return speakQuestion('REPEAT', text);
  }

  function reset() {
    clearReviewTimer();
    clearSavingTimer();
    listenToken++;
    speakToken++;
    ctx.seq++;
    voiceCall('abortListening', 'reset');
    voiceCall('stopSpeaking');
    return transition('RESET', 'ready', { ...clearRequest(), transcript: '', interim: '', error: null, notice: null, review: null, micLive: false, origin: 'ready' });
  }

  /** Restore an open conversation after a page reload (GET /api/conversations/current). */
  function resume(conversation, question) {
    if (state !== 'ready') return reject('RESUME');
    const id = conversation && (conversation.id || conversation.conversationId);
    if (!id) return reject('RESUME', 'no_conversation');
    const q = question || (conversation && conversation.question) || null;
    return transition('RESUME', q ? 'awaiting_answer' : 'ready', { conversationId: id, question: q, origin: q ? 'awaiting_answer' : 'ready' });
  }

  let unsubscribeVoice = null;
  if (voice && typeof voice.subscribe === 'function') {
    try {
      unsubscribeVoice = voice.subscribe(() => {
        const next = voiceCanAutoListen();
        if (next !== ctx.canAutoListen) emit({ type: 'VOICE_STATUS', from: state, to: state });
      });
    } catch {
      unsubscribeVoice = null;
    }
  }
  ctx.canAutoListen = voiceCanAutoListen();

  return {
    get state() {
      return state;
    },
    get context() {
      return snapshot();
    },
    /** fn(state, context, event) on every transition (and VOICE_STATUS / MIC_LIVE notifications). Returns unsubscribe. */
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** Is `event` allowed from the current state (for enabling buttons)? */
    can,
    pressMic,
    startListening: () => startListening('LISTEN'),
    stopListening,
    sendNow,
    edit,
    updateDraft,
    cancel,
    submitText,
    chooseOption,
    retry,
    dismissError,
    repeatQuestion,
    reset,
    resume,
    /** Debug event log: [{i, t, seq, event, from, to, ok, reason?, info?}] (lengths only, never transcripts). */
    getLog: () => log.map((e) => ({ ...e })),
    destroy() {
      clearReviewTimer();
      clearSavingTimer();
      listenToken++;
      speakToken++;
      voiceCall('abortListening', 'destroy');
      voiceCall('stopSpeaking');
      if (unsubscribeVoice) unsubscribeVoice();
      subs.clear();
      destroyed = true;
    },
  };
}
