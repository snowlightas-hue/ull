// Unit tests for public/js/conversation/machine.js with fake api / voice / clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationMachine, STATES, TRANSITIONS, MESSAGES_AR } from '../../public/js/conversation/machine.js';
import type { ConversationState, TurnBody } from '../../public/js/conversation/machine.js';
import { skeleton } from '../../public/js/conversation/speech-text.js';

const flush = () => new Promise<void>((r) => setImmediate(r));
async function settle(n = 5) {
  for (let i = 0; i < n; i++) await flush();
}

// ---------------- fakes ----------------

function fakeClock() {
  let now = 0;
  let nextId = 0;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++nextId;
      timers.push({ id, at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id: unknown) {
      timers = timers.filter((t) => t.id !== id);
    },
    pending: () => timers.length,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeApi() {
  const calls: { ensure: number; turns: Array<{ id: string; body: TurnBody; d: Deferred<any> }>; matches: Array<{ intentId: string; d: Deferred<any> }>; cancelled: string[] } = {
    ensure: 0,
    turns: [],
    matches: [],
    cancelled: [],
  };
  let convN = 0;
  return {
    calls,
    async ensureConversation() {
      calls.ensure++;
      return { id: `conv-${++convN}` };
    },
    sendTurn(id: string, body: TurnBody) {
      const d = deferred<any>();
      calls.turns.push({ id, body, d });
      return d.promise;
    },
    runMatch(intentId: string) {
      const d = deferred<any>();
      calls.matches.push({ intentId, d });
      return d.promise;
    },
    async cancelConversation(id: string) {
      calls.cancelled.push(id);
      return { ok: true };
    },
  };
}

function fakeVoice(opts: { autoListen?: boolean; synthesis?: boolean } = {}) {
  let handlers: any = null;
  let finishSpeak: ((reason?: string) => void) | null = null;
  const v = {
    speaking: false,
    autoListen: opts.autoListen ?? true,
    synthesis: opts.synthesis ?? true,
    listenCalls: [] as Array<{ speaking: boolean }>,
    speakCalls: [] as string[],
    violations: [] as string[],
    order: [] as string[],
    stopCalls: 0,
    abortCalls: 0,
    canAutoListen: () => v.autoListen,
    canSpeak: () => v.synthesis,
    isSpeaking: () => v.speaking,
    listen(h: any) {
      // HALF-DUPLEX assertion: the machine must never open the mic while we are speaking
      if (v.speaking) v.violations.push('listen() called while speaking');
      v.listenCalls.push({ speaking: v.speaking });
      v.order.push('listen');
      handlers = h;
      return Promise.resolve({ started: true });
    },
    speak(text: string) {
      if (handlers) v.violations.push('speak() while a listen session is still open');
      v.speaking = true;
      v.speakCalls.push(text);
      v.order.push('speak');
      return new Promise<{ ok: boolean; reason: string }>((res) => {
        finishSpeak = (reason = 'end') => {
          v.speaking = false;
          finishSpeak = null;
          v.order.push(`speak:${reason}`);
          res({ ok: reason === 'end', reason });
        };
      });
    },
    stopSpeaking() {
      v.order.push('stopSpeaking');
      if (finishSpeak) finishSpeak('cancelled');
    },
    stopListening() {
      v.stopCalls++;
    },
    abortListening() {
      v.abortCalls++;
      const h = handlers;
      handlers = null;
      if (h) h.onEnd('aborted');
    },
    // ---- test drivers ----
    endSpeech() {
      assert.ok(finishSpeak, 'not speaking');
      finishSpeak!('end');
    },
    start() {
      handlers.onStart({ lang: 'ar-SY' });
    },
    interim(t: string) {
      handlers.onInterim(t);
    },
    final(t: string) {
      const h = handlers;
      handlers = null;
      h.onFinal(t);
      h.onEnd('final');
    },
    error(code: string, recoverable = true) {
      const h = handlers;
      handlers = null;
      h.onError({ code, recoverable, messageAr: `خطأ ${code}`, offerText: true });
      h.onEnd('error');
    },
    get listening() {
      return !!handlers;
    },
  };
  return v;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const QUESTION = {
  id: 'deal#1',
  field: 'deal',
  text: 'بدك الشقة للبيع ولا للإيجار؟',
  speech: 'بِدَّك الشّقة للبيع ولا للإيجار؟',
  options: [
    { value: 'rent', label: 'للإيجار' },
    { value: 'sale', label: 'للبيع' },
  ],
  attempt: 1,
};
const askResult = (id: string) => ({
  conversation: { id, state: 'asking', turns: 1 },
  action: 'ask',
  question: QUESTION,
  summary: { titleAr: 'شقة في إعزاز', chips: [] },
  understanding: { engine: 'rules', latencyMs: 3 },
});
const savedResult = (id: string, intentId = 'intent-1') => ({
  conversation: { id, state: 'saved', turns: 2 },
  action: 'saved',
  intent: { id: intentId, side: 'seek', status: 'active', version: 1, titleAr: 'شقة للإيجار في إعزاز', matchCounts: { confirmed: 0, possible: 0 } },
  summary: { titleAr: 'شقة للإيجار في إعزاز', chips: [] },
  understanding: { engine: 'rules', latencyMs: 4 },
});
const matchRun = (confirmed: number, possible: number) => ({
  intentId: 'intent-1',
  version: 1,
  status: 'done',
  totals: { confirmed, possible, excluded: 0, candidates: confirmed + possible },
  exclusions: [],
  page: { items: [], total: confirmed + possible, limit: 20, nextCursor: null, prevCursor: null, rangeStart: 0, rangeEnd: 0 },
  suggestionsAr: [],
  truncated: false,
});

function setup(opts: { autoListen?: boolean; synthesis?: boolean; autoSendMs?: number } = {}) {
  const clock = fakeClock();
  const api = fakeApi();
  const voice = fakeVoice(opts);
  const m = createConversationMachine({ api, voice, clock, autoSendMs: opts.autoSendMs ?? 1600, savingMs: 500, announce: 'never' });
  const states: ConversationState[] = [m.state];
  m.subscribe((s, _c, e) => {
    if (e.type === 'MIC_LIVE' || e.type === 'VOICE_STATUS') return;
    if (states[states.length - 1] !== s) states.push(s);
  });
  return { m, clock, api, voice, states };
}

// ---------------- tests ----------------

test('transition table covers every state and only targets known states', () => {
  for (const s of STATES) {
    assert.ok(TRANSITIONS[s], `missing transitions for ${s}`);
    for (const [ev, targets] of Object.entries(TRANSITIONS[s])) {
      for (const t of targets as string[]) assert.ok((STATES as readonly string[]).includes(t), `${s}.${ev} → unknown ${t}`);
    }
  }
  // every state except ready is reachable
  const reachable = new Set<string>();
  for (const s of STATES) for (const targets of Object.values(TRANSITIONS[s])) for (const t of targets as string[]) reachable.add(t);
  for (const s of STATES) assert.ok(reachable.has(s), `${s} unreachable`);
});

test('happy path: mic → interim → final → review countdown → auto-send → saved → search → results', async () => {
  const { m, clock, api, voice, states } = setup();
  assert.equal(m.state, 'ready');
  assert.ok(m.pressMic());
  assert.equal(m.state, 'listening');
  voice.start();
  assert.equal(m.context.micLive, true);
  voice.interim('بدي');
  assert.equal(m.context.interim, 'بدي');
  voice.interim('بدي شقة');
  voice.final('بدي شقة بإعزاز');
  assert.equal(m.state, 'reviewing');
  assert.equal(m.context.transcript, 'بدي شقة بإعزاز');
  assert.equal(m.context.review?.deadline, 1600);
  await clock.advance(1599);
  assert.equal(m.state, 'reviewing', 'not sent before the countdown ends');
  assert.equal(api.calls.turns.length, 0);
  await clock.advance(1);
  assert.equal(m.state, 'processing');
  assert.equal(api.calls.ensure, 1);
  assert.equal(api.calls.turns.length, 1);
  const t = api.calls.turns[0];
  assert.equal(t.id, 'conv-1');
  assert.equal(t.body.text, 'بدي شقة بإعزاز');
  assert.equal(t.body.modality, 'voice');
  assert.match(t.body.clientTurnId, UUID_RE);
  t.d.resolve(savedResult('conv-1'));
  await settle();
  assert.equal(m.state, 'saving');
  assert.equal(m.context.intent.id, 'intent-1');
  assert.equal(m.context.conversationId, null, 'saved conversation is closed; next input starts a new request');
  await clock.advance(500);
  assert.equal(m.state, 'searching');
  assert.equal(api.calls.matches[0].intentId, 'intent-1');
  api.calls.matches[0].d.resolve(matchRun(1, 2));
  await settle();
  assert.equal(m.state, 'results');
  assert.equal(m.context.matchRun.totals.confirmed, 1);
  assert.deepEqual(states, ['ready', 'listening', 'reviewing', 'processing', 'saving', 'searching', 'results']);
  assert.deepEqual(voice.violations, []);
});

test('clarification: question is spoken, then auto-listen, and the answer goes to the SAME conversation', async () => {
  const { m, clock, api, voice, states } = setup();
  m.pressMic();
  voice.final('بدي شقة بإعزاز');
  await clock.advance(1600);
  api.calls.turns[0].d.resolve(askResult('conv-1'));
  await settle();
  assert.equal(m.state, 'speaking');
  assert.deepEqual(m.context.question, QUESTION);
  assert.equal(voice.speakCalls.length, 1);
  assert.equal(skeleton(voice.speakCalls[0]), skeleton(QUESTION.text), 'speaks exactly the displayed words');
  assert.ok(voice.speakCalls[0].includes('بِدَّك'), 'uses the diacritized speech variant');
  assert.equal(voice.listenCalls.length, 1, 'no listening while speaking');
  voice.endSpeech();
  await settle();
  // awaiting_answer → auto-listen (permission granted)
  assert.equal(m.state, 'listening');
  assert.equal(voice.listenCalls.length, 2);
  assert.equal(voice.listenCalls[1].speaking, false);
  voice.final('للإيجار');
  assert.equal(m.state, 'reviewing');
  assert.ok(m.sendNow());
  assert.equal(m.state, 'processing');
  assert.equal(api.calls.turns.length, 2);
  assert.equal(api.calls.ensure, 1, 'no new conversation for the answer');
  assert.equal(api.calls.turns[1].id, 'conv-1', 'answer sent to the same conversation');
  assert.notEqual(api.calls.turns[1].body.clientTurnId, api.calls.turns[0].body.clientTurnId, 'new clientTurnId per user turn');
  api.calls.turns[1].d.resolve(savedResult('conv-1'));
  await settle();
  await clock.advance(500);
  api.calls.matches[0].d.resolve(matchRun(0, 0));
  await settle();
  assert.equal(m.state, 'saved_no_results');
  assert.equal(m.context.notice?.messageAr, MESSAGES_AR.savedNoResults);
  assert.equal(MESSAGES_AR.savedNoResults, 'تم حفظ طلبك، سنخبرك عند ظهور مطابقات مناسبة');
  assert.deepEqual(states, [
    'ready', 'listening', 'reviewing', 'processing', 'asking', 'speaking', 'awaiting_answer',
    'listening', 'reviewing', 'processing', 'saving', 'searching', 'saved_no_results',
  ]);
  assert.deepEqual(voice.violations, []);
  // next utterance after saving is a NEW request
  m.submitText('بدي سيارة');
  await settle();
  assert.equal(api.calls.ensure, 2);
  assert.equal(api.calls.turns[2].id, 'conv-2');
});

test('tap-to-answer when auto-listen is not allowed; answer still goes to the same conversation', async () => {
  const { m, clock, api, voice } = setup({ autoListen: false });
  m.pressMic();
  voice.final('بدي شقة');
  await clock.advance(1600);
  api.calls.turns[0].d.resolve(askResult('conv-1'));
  await settle();
  voice.endSpeech();
  await settle();
  assert.equal(m.state, 'awaiting_answer');
  assert.equal(m.context.canAutoListen, false, 'UI must show the tap-to-answer button');
  assert.equal(voice.listenCalls.length, 1, 'mic not opened automatically');
  await clock.advance(10_000);
  assert.equal(voice.listenCalls.length, 1);
  assert.ok(m.pressMic(), 'user taps to answer');
  assert.equal(m.state, 'listening');
  voice.final('للبيع');
  m.sendNow();
  assert.equal(api.calls.turns[1].id, 'conv-1');
  // quick-answer chip from awaiting_answer also goes to the same conversation
  api.calls.turns[1].d.resolve(askResult('conv-1'));
  await settle();
  voice.endSpeech();
  await settle();
  assert.equal(m.state, 'awaiting_answer');
  assert.ok(m.chooseOption(QUESTION.options[0]));
  assert.equal(api.calls.turns[2].id, 'conv-1');
  assert.equal(api.calls.turns[2].body.text, 'للإيجار');
  assert.equal(api.calls.turns[2].body.modality, 'text');
});

test('cancel during review: nothing is sent, even after the countdown would have expired', async () => {
  const { m, clock, api, voice } = setup();
  m.pressMic();
  voice.final('بدي شقة');
  assert.equal(m.state, 'reviewing');
  await clock.advance(800);
  assert.ok(m.cancel());
  assert.equal(m.state, 'ready');
  assert.equal(m.context.transcript, '');
  await clock.advance(5000);
  assert.equal(api.calls.turns.length, 0);
  assert.equal(api.calls.ensure, 0);
  assert.equal(m.state, 'ready');
});

test('edit stops the countdown; edited text is sent as modality text', async () => {
  const { m, clock, api, voice } = setup();
  m.pressMic();
  voice.final('بدي شقة باعزاز');
  assert.ok(m.edit());
  assert.equal(m.context.review?.editing, true);
  assert.equal(m.context.review?.deadline, null);
  await clock.advance(10_000);
  assert.equal(m.state, 'reviewing', 'no auto-send while editing');
  assert.equal(api.calls.turns.length, 0);
  assert.ok(m.updateDraft('بدي شقة بإعزاز للإيجار'));
  assert.ok(m.sendNow());
  await settle();
  assert.equal(api.calls.turns.length, 1);
  assert.equal(api.calls.turns[0].body.text, 'بدي شقة بإعزاز للإيجار');
  assert.equal(api.calls.turns[0].body.modality, 'text');
});

test('unchanged transcript sent with sendNow keeps modality voice; re-recording from review restarts listening', async () => {
  const { m, voice, api } = setup();
  m.pressMic();
  voice.final('بدي شقة');
  assert.ok(m.pressMic(), 'mic in review = record again');
  assert.equal(m.state, 'listening');
  voice.final('بدي شقة بإعزاز');
  m.sendNow();
  await settle();
  assert.equal(api.calls.turns[0].body.modality, 'voice');
  assert.equal(api.calls.turns[0].body.text, 'بدي شقة بإعزاز');
});

test('stale response after cancel / new turn is ignored', async () => {
  const { m, api } = setup();
  assert.ok(m.submitText('بدي شقة'));
  await settle();
  assert.equal(m.state, 'processing');
  const first = api.calls.turns[0];
  assert.ok(m.cancel());
  assert.equal(m.state, 'ready');
  assert.ok(m.submitText('بدي سيارة'));
  await settle();
  const second = api.calls.turns[1];
  // the OLD response arrives late — must be ignored
  first.d.resolve(askResult(first.id));
  await settle();
  assert.equal(m.state, 'processing', 'stale ask did not move the machine');
  assert.equal(m.context.question, null);
  assert.ok(m.getLog().some((e) => e.event === 'STALE_RESPONSE'), 'stale response recorded in the log');
  second.d.resolve(savedResult(second.id));
  await settle();
  assert.equal(m.state, 'saving');
  // a stale error is ignored too
  const third = setup();
  third.m.submitText('x y');
  await settle();
  third.m.cancel();
  third.api.calls.turns[0].d.reject(Object.assign(new Error('boom'), { status: 503 }));
  await settle();
  assert.equal(third.m.state, 'ready');
});

test('cancelling the first request in processing closes it server-side', async () => {
  const { m, api } = setup();
  m.submitText('بدي شقة');
  await settle();
  m.cancel();
  await settle();
  assert.deepEqual(api.calls.cancelled, ['conv-1']);
  assert.equal(m.context.conversationId, null);
});

test('error → retry() resends the same turn with the SAME clientTurnId', async () => {
  const { m, api } = setup();
  m.submitText('بدي شقة بإعزاز');
  await settle();
  api.calls.turns[0].d.reject(Object.assign(new Error('Service Unavailable'), { status: 503, code: 'upstream', messageAr: 'الخادم مشغول.' }));
  await settle();
  assert.equal(m.state, 'error');
  assert.equal(m.context.error?.kind, 'turn');
  assert.equal(m.context.error?.recoverable, true);
  assert.equal(m.context.error?.messageAr, 'الخادم مشغول.');
  assert.ok(m.retry());
  assert.equal(m.state, 'processing');
  await settle();
  assert.equal(api.calls.turns.length, 2);
  assert.equal(api.calls.turns[1].body.clientTurnId, api.calls.turns[0].body.clientTurnId);
  assert.equal(api.calls.turns[1].body.text, api.calls.turns[0].body.text);
  assert.equal(api.calls.turns[1].id, api.calls.turns[0].id);
  assert.equal(api.calls.ensure, 1);
  api.calls.turns[1].d.resolve(savedResult('conv-1'));
  await settle();
  assert.equal(m.state, 'saving');
});

test('non-recoverable API error (401) cannot be retried; text input still works', async () => {
  const { m, api } = setup();
  m.submitText('بدي شقة');
  await settle();
  api.calls.turns[0].d.reject(Object.assign(new Error('unauthorized'), { status: 401 }));
  await settle();
  assert.equal(m.state, 'error');
  assert.equal(m.context.error?.recoverable, false);
  assert.equal(m.retry(), false);
  assert.equal(m.state, 'error');
  assert.ok(m.submitText('بدي شقة'));
  assert.equal(m.state, 'processing');
});

test('match failure → error kind match; retry re-runs matching (not the turn); dismiss shows saved message', async () => {
  const { m, clock, api } = setup();
  m.submitText('بدي شقة للإيجار بإعزاز');
  await settle();
  api.calls.turns[0].d.resolve(savedResult('conv-1'));
  await settle();
  await clock.advance(500);
  api.calls.matches[0].d.reject(new Error('timeout'));
  await settle();
  assert.equal(m.state, 'error');
  assert.equal(m.context.error?.kind, 'match');
  assert.equal(m.context.error?.messageAr, MESSAGES_AR.matchFailed);
  assert.ok(m.retry());
  assert.equal(m.state, 'searching');
  await settle();
  assert.equal(api.calls.turns.length, 1, 'turn not resent');
  assert.equal(api.calls.matches.length, 2);
  api.calls.matches[1].d.reject(new Error('timeout'));
  await settle();
  assert.ok(m.dismissError());
  assert.equal(m.state, 'saved_no_results');
  assert.equal(m.context.notice?.messageAr, MESSAGES_AR.savedNoResults);
});

test('half-duplex: barge-in while speaking stops speech BEFORE listening; listen never overlaps speech', async () => {
  const { m, clock, api, voice } = setup();
  m.submitText('بدي شقة');
  await settle();
  api.calls.turns[0].d.resolve(askResult('conv-1'));
  await settle();
  assert.equal(m.state, 'speaking');
  assert.equal(voice.speaking, true);
  assert.ok(m.pressMic(), 'barge-in');
  assert.equal(m.state, 'listening');
  assert.equal(voice.speaking, false);
  const iStop = voice.order.indexOf('stopSpeaking');
  const iListen = voice.order.lastIndexOf('listen');
  assert.ok(iStop >= 0 && iStop < iListen, `order: ${voice.order.join(' → ')}`);
  assert.deepEqual(voice.violations, []);
  // the cancelled speak() resolution must not push the machine to awaiting_answer
  await settle();
  assert.equal(m.state, 'listening');
  voice.final('للإيجار');
  m.sendNow();
  assert.equal(api.calls.turns[1].id, 'conv-1');
  // repeat question: speaking again aborts any open mic first
  api.calls.turns[1].d.resolve(askResult('conv-1'));
  await settle();
  voice.endSpeech();
  await settle();
  assert.equal(m.state, 'listening', 'auto-listen');
  // user asks to hear the question again while the mic is open → cancel listening, then repeat
  m.cancel();
  assert.equal(m.state, 'awaiting_answer');
  assert.ok(m.repeatQuestion());
  assert.equal(m.state, 'speaking');
  voice.endSpeech();
  await settle();
  await clock.advance(100);
  assert.deepEqual(voice.violations, []);
  for (const c of voice.listenCalls) assert.equal(c.speaking, false);
});

test('invalid transitions are rejected and logged; state is unchanged', async () => {
  const { m } = setup();
  assert.equal(m.sendNow(), false);
  assert.equal(m.edit(), false);
  assert.equal(m.retry(), false);
  assert.equal(m.dismissError(), false);
  assert.equal(m.stopListening(), false);
  assert.equal(m.cancel(), false);
  assert.equal(m.repeatQuestion(), false);
  assert.equal(m.submitText('   '), false, 'empty text rejected');
  assert.equal(m.state, 'ready');
  const rejected = m.getLog().filter((e) => !e.ok);
  assert.ok(rejected.length >= 8);
  assert.ok(rejected.every((e) => e.from === 'ready' && e.to === null));
  assert.ok(rejected.some((e) => e.event === 'SEND' && e.reason === 'invalid_transition'));
  // busy states reject mic and text
  m.submitText('بدي شقة');
  assert.equal(m.state, 'processing');
  assert.equal(m.pressMic(), false);
  assert.equal(m.submitText('شي تاني'), false);
  assert.equal(m.edit(), false);
  assert.equal(m.state, 'processing');
  assert.equal(m.can('LISTEN'), false);
  assert.equal(m.can('CANCEL'), true);
  // the log never contains user text (only lengths)
  assert.ok(!JSON.stringify(m.getLog()).includes('بدي شقة'));
});

test('no-speech is a recoverable voice error; retry() listens again', async () => {
  const { m, voice } = setup();
  m.pressMic();
  voice.error('no-speech', true);
  assert.equal(m.state, 'error');
  assert.equal(m.context.error?.kind, 'voice');
  assert.equal(m.context.error?.code, 'no-speech');
  assert.equal(m.context.error?.recoverable, true);
  assert.ok(m.retry());
  assert.equal(m.state, 'listening');
  assert.equal(voice.listenCalls.length, 2);
  voice.final('بدي شقة');
  assert.equal(m.state, 'reviewing');
});

test('not-allowed is not retryable but text input works; dismiss returns to the open question', async () => {
  const { m, clock, api, voice } = setup();
  m.submitText('بدي شقة');
  await settle();
  api.calls.turns[0].d.resolve(askResult('conv-1'));
  await settle();
  voice.endSpeech();
  await settle();
  // modality was text → no auto-listen by default
  assert.equal(m.state, 'awaiting_answer');
  m.pressMic();
  voice.error('not-allowed', false);
  assert.equal(m.state, 'error');
  assert.equal(m.retry(), false);
  assert.ok(m.dismissError());
  assert.equal(m.state, 'awaiting_answer', 'question still open');
  m.pressMic();
  voice.error('network', true);
  assert.ok(m.submitText('للإيجار'), 'text answer from the error state');
  await settle();
  assert.equal(api.calls.turns[1].id, 'conv-1', 'answer goes to the same conversation');
  await clock.advance(10);
});

test('voice ending with no result returns to where it started (ready or awaiting_answer)', async () => {
  const { m, api, voice } = setup({ autoListen: false });
  m.pressMic();
  voice.abortListening(); // the engine ended on its own: onEnd('aborted') with neither final nor error
  assert.equal(m.state, 'ready');
  assert.equal(m.getLog().at(-1)?.event, 'VOICE_EMPTY');
  // same while answering a question: back to awaiting_answer, question kept
  m.submitText('بدي شقة');
  await settle();
  api.calls.turns[0].d.resolve(askResult('conv-1'));
  await settle();
  voice.endSpeech();
  await settle();
  assert.equal(m.state, 'awaiting_answer');
  m.pressMic();
  voice.abortListening();
  assert.equal(m.state, 'awaiting_answer');
  assert.deepEqual(m.context.question, QUESTION);
  assert.equal(m.context.conversationId, 'conv-1');
});

test('unclear without a question becomes a client-side clarifying prompt in the same conversation', async () => {
  const { m, api, voice } = setup();
  m.submitText('امممم');
  await settle();
  api.calls.turns[0].d.resolve({ conversation: { id: 'conv-1', state: 'collecting', turns: 1 }, action: 'unclear', summary: { titleAr: '', chips: [] }, understanding: { engine: 'rules', latencyMs: 1 } });
  await settle();
  assert.equal(m.state, 'speaking');
  assert.equal(m.context.question?.text, MESSAGES_AR.unclear);
  voice.endSpeech();
  await settle();
  assert.equal(m.state, 'awaiting_answer');
  m.submitText('بدي شقة للإيجار');
  await settle();
  assert.equal(api.calls.turns[1].id, 'conv-1');
});

test('without speech synthesis the question is shown and the machine waits for an answer', async () => {
  const { m, api, voice } = setup({ synthesis: false });
  m.pressMic();
  voice.final('بدي شقة');
  m.sendNow();
  await settle();
  api.calls.turns[0].d.resolve(askResult('conv-1'));
  await settle();
  assert.equal(voice.speakCalls.length, 0);
  assert.equal(m.context.speech?.status, 'skipped');
  // voice user + permission granted → auto-listen even when the question could not be spoken
  assert.equal(m.state, 'listening');
});

test('reset clears everything and ignores late responses', async () => {
  const { m, api } = setup();
  m.submitText('بدي شقة');
  await settle();
  assert.ok(m.reset());
  assert.equal(m.state, 'ready');
  api.calls.turns[0].d.resolve(askResult('conv-1'));
  await settle();
  assert.equal(m.state, 'ready');
  assert.equal(m.context.conversationId, null);
});

test('resume() restores an open conversation with a pending question', async () => {
  const { m, api } = setup();
  assert.ok(m.resume({ id: 'conv-9' }, QUESTION));
  assert.equal(m.state, 'awaiting_answer');
  m.submitText('للإيجار');
  await settle();
  assert.equal(api.calls.ensure, 0);
  assert.equal(api.calls.turns[0].id, 'conv-9');
});

test('subscribers receive (state, context, event) in order, even when they trigger nested transitions', async () => {
  const { m, voice } = setup();
  const seen: string[] = [];
  m.subscribe((s, c, e) => {
    seen.push(`${e.type}:${e.from}->${s}`);
    if (s === 'reviewing' && !c.review?.editing) m.edit(); // nested command from a subscriber
  });
  m.pressMic();
  voice.final('بدي شقة');
  assert.deepEqual(seen, ['LISTEN:ready->listening', 'FINAL:listening->reviewing', 'EDIT:reviewing->reviewing']);
  assert.equal(m.context.review?.editing, true);
});
