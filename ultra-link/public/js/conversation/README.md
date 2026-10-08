# public/js/conversation — voice and conversation (client)

Owner: Role 3. These are plain browser ES modules with no build step and no dependencies. Nothing touches `window` or the DOM when a module is imported, so all three can be unit-tested in Node.

| File | What it is |
|---|---|
| `machine.js` | A pure state machine for one request: listen, review, send, ask, speak, answer, save, search. It knows nothing about the DOM. The API, voice layer and clock are passed in. |
| `voice.js` | `createVoice()` wraps the Web Speech API (recognition and synthesis) and enforces the half-duplex invariant. |
| `speech-text.js` | `speakableText(question)` picks the safe spoken variant of a question. `addPauses()`. `skeleton()` (identical to `src/nlu/arabic.ts`). |
| `*.d.ts` | Type declarations, so the TS tests (and the integrator) get types. |

There's a manual and automated test page at `public/voice-harness.html`. It uses a mock API by default; add `?api=live` to use the real `/api/*` endpoints with your session cookie.

---

## 1. Wiring (integrator, `public/js/app.js`)

```js
import { createVoice } from './conversation/voice.js';
import { createConversationMachine } from './conversation/machine.js';
import * as apiClient from './api.js';           // integrator-owned
import * as home from './ui/home.js';             // Role 2

const voice = createVoice();                      // lang prefs: ar-SY, ar-LB, ar-JO, ar-SA, ar
const machine = createConversationMachine({
  voice,
  autoSendMs: 1600,
  api: {
    // Must return an OPEN conversation, creating one if needed. Called only when the machine
    // has no conversation (first turn of a new request). Simplest: always POST /api/conversations.
    ensureConversation: async () => (await apiClient.post('/api/conversations')).conversation,
    sendTurn: (id, body) => apiClient.post(`/api/conversations/${id}/turns`, body),   // → TurnResult
    runMatch: (intentId) => apiClient.post(`/api/intents/${intentId}/match`),         // → MatchRunResult
    cancelConversation: (id) => apiClient.post(`/api/conversations/${id}/cancel`),    // optional
  },
});

machine.subscribe((state, ctx, event) => {
  home.setPhase(state);                                       // one of the 12 state names below
  home.setTranscript(state === 'listening' ? ctx.interim : ctx.transcript, { interim: state === 'listening', micLive: ctx.micLive });
  if (state === 'reviewing') home.showReview({ text: ctx.transcript, deadline: ctx.review.deadline, autoSendMs: ctx.review.autoSendMs, editing: ctx.review.editing });
  if (ctx.question && ['asking', 'speaking', 'awaiting_answer'].includes(state)) home.showQuestion(ctx.question, { canAutoListen: ctx.canAutoListen, speaking: state === 'speaking' });
  if (state === 'awaiting_answer') home.showTapToAnswer(!ctx.canAutoListen);   // big "اضغط للإجابة" button
  if (state === 'error') home.showError(ctx.error);           // {kind, code, recoverable, messageAr, offerText}
  if (state === 'results') home.showResults(ctx.matchRun);    // MatchRunResult
  if (state === 'saved_no_results') home.showSaved(ctx.notice.messageAr); // "تم حفظ طلبك، سنخبرك عند ظهور مطابقات مناسبة"
  if (ctx.lastTurn) home.showSummary(ctx.lastTurn.summary);   // chips of what we understood
});

// UI events → machine commands (each returns true if accepted, false if rejected and logged)
home.onMic(() => machine.pressMic());                 // ready/awaiting/results/error: listen. listening: stop. speaking: barge-in
home.onTapToAnswer(() => machine.startListening());
home.onSendNow((text) => machine.sendNow(text));      // text is optional (an edited draft)
home.onEdit(() => machine.edit());                    // stops the countdown and switches to text editing
home.onDraftInput((text) => machine.updateDraft(text));
home.onCancel(() => machine.cancel());
home.onOption((opt) => machine.chooseOption(opt));    // quick-answer chip, sends opt.label as a text turn
home.onTextSubmit((text) => machine.submitText(text));
home.onRetry(() => machine.retry());
home.onDismissError(() => machine.dismissError());
home.onRepeatQuestion(() => machine.repeatQuestion());

// After a reload, if GET /api/conversations/current returns an open conversation:
// machine.resume({ id: conversation.id }, pendingQuestionOrNull);
```

Use `machine.can(EVENT)` to enable or disable buttons, for example `can('SUBMIT_TEXT')` or `can('CANCEL')`.

## 2. States (names are fixed by docs/CONTRACTS.md)

| State | What the UI shows | Commands accepted |
|---|---|---|
| `ready` | mic button and text box | `pressMic`, `submitText`, `resume` |
| `listening` | live `ctx.interim` and a recording indicator (`ctx.micLive` once audio actually flows) | `pressMic`/`stopListening` (finalize), `cancel`, `submitText`/`chooseOption` (aborts the mic) |
| `reviewing` | the final transcript plus a countdown to `ctx.review.deadline` | `sendNow`, `edit`, `updateDraft`, `cancel`, `pressMic` (record again), `submitText` |
| `processing` | sending/understanding spinner | `cancel` (the late response is then ignored) |
| `asking` | the question, centred (only for an instant before `speaking`) | `pressMic`, `submitText`, `cancel` |
| `speaking` | the question and options while TTS speaks | `pressMic` (barge-in), `chooseOption`, `submitText`, `cancel` |
| `awaiting_answer` | the question, options, a **tap-to-answer button**, and the text box | `pressMic`/`startListening`, `chooseOption`, `submitText`, `repeatQuestion`, `cancel` (cancels the request) |
| `saving` | "تم حفظ طلبك…" (brief, `savingMs` = 600 ms) | — |
| `searching` | searching for matches | — |
| `results` | `ctx.matchRun.page.items` and `ctx.notice.messageAr` ("وجدنا مطابقتين لطلبك.") | `pressMic`/`submitText` (start a NEW request) |
| `saved_no_results` | `ctx.notice.messageAr` = "تم حفظ طلبك، سنخبرك عند ظهور مطابقات مناسبة" | `pressMic`/`submitText` (start a NEW request) |
| `error` | `ctx.error.messageAr`. Show a retry button only if `ctx.error.recoverable`. Always keep the text box usable (`offerText`). | `retry`, `dismissError`, `pressMic`, `submitText` |

The full table is exported as `TRANSITIONS`. Invalid commands are rejected: they return `false`, leave the state unchanged and add an `ok:false` entry to `machine.getLog()`.

## 3. Behaviour guarantees

- **Answers go to the same conversation.** When a question is open (`ctx.conversationId && ctx.question`), every input is sent as a turn of that conversation, whether spoken, typed or a chip, and including retries and inputs from `error`. `ensureConversation()` is called only for the first turn of a new request. After `saved` or `cancelled`, `conversationId` is cleared, so the next input starts a new request.
- **One `clientTurnId` (UUID v4) per user turn.** `retry()` resends exactly the same `{text, modality, clientTurnId}`, so the server can dedupe. If a turn fails with 404, the conversation id is dropped and retry opens a new conversation with the same turn.
- **Stale responses are ignored.** Every request carries `ctx.seq`. `cancel()`, `reset()` and new turns bump it, and a late response or error is logged as `STALE_RESPONSE` and ignored.
- **Review before sending.** The final transcript waits `autoSendMs` (1600 ms) and is then sent automatically. `edit()` or `updateDraft()` stop the countdown and nothing is auto-sent while editing. `cancel()` sends nothing. Modality is `voice` unless the user changed the text, in which case it is `text`.
- **Questions are spoken, then the app listens.** In `asking`, the question goes through `speakableText()` (described below) and is spoken in `speaking`. It then moves to `awaiting_answer` and **auto-listens only if** `voice.canAutoListen()` is true **and** the user's last turn was spoken (`autoListenAfterText: true` changes this). Otherwise it waits for the tap button. If synthesis is unavailable or there's no Arabic voice, speaking is skipped (`ctx.speech.status = 'skipped'`) and the question is still shown.
- **`unclear` responses.** If the server gives no question, the machine asks the client-side question `MESSAGES_AR.unclear` (shown and spoken). The conversation stays open.
- **Outcome announcements.** With `announce: 'voice'` (the default), the result sentence is spoken if the user used voice. There is no auto-listen afterwards.
- **Search failures.** These become `error` with `kind:'match'`, and `retry()` re-runs only `runMatch`. `dismissError()` goes to `saved_no_results`, because the intent is already saved.
- **Privacy.** The event log records lengths, never transcripts.

## 4. `voice.js`

`createVoice({ lang?, langs?, window?, clock?, guardMs = 400, rate = 0.95, keepalive = 'auto', ... })`

- `support` is `{recognition, synthesis}`, detected separately (`SpeechRecognition` or `webkitSpeechRecognition`; `speechSynthesis` plus `SpeechSynthesisUtterance`).
- `listen({onStart, onInterim, onFinal, onEnd, onError})` → `Promise<{started, lang?, reason?}>`.
  - Settings are `continuous=false`, `interimResults=true`, `maxAlternatives=1`. Languages are tried in the order `['ar-SY','ar-LB','ar-JO','ar-SA','ar']`. On `language-not-supported` it moves to the next one silently. The language that works is remembered in `localStorage['ul.voice.recLang']`.
  - `onInterim(text)` receives the full text so far (final plus interim). `onFinal(text)` fires **on the recognizer's `end` event** with the accumulated final text. If Chrome ends without marking a result final, the last interim text is used. If it ends with nothing at all, the result is `no-speech`. Every call gets exactly one `onEnd(reason)`, where reason is `final`, `no-speech`, `error` or `aborted`.
  - `onError({code, recoverable, messageAr, offerText:true, offline?})`, by code:

    | code | recoverable | meaning (Arabic message explains and offers typing) |
    |---|---|---|
    | `not-allowed` | no | Mic permission denied. The message explains how to enable it (lock icon, then Allow, then reload). `permission` becomes `denied` and later `listen()` calls fail at once without prompting. |
    | `service-not-allowed` | no | The browser or a policy blocks the speech service. |
    | `audio-capture` | no | No working microphone. |
    | `network` | yes | The recognition service needs internet (Chrome streams audio to a server). If `navigator.onLine === false`, this is reported **before** trying, with `offline:true`. |
    | `no-speech` | yes | Nothing was heard. Try again. |
    | `language-not-supported` | no | Only reported after every language has failed. |
    | `unsupported` | no | No SpeechRecognition (Firefox, for example). Use text. |
    | `start-failed`, `busy`, `aborted`, `unknown` | yes | |
- `stopListening()` finalizes what was heard. `abortListening()` discards it.
- `speak(text)` → `Promise<{ok, reason}>`, where reason is `end`, `cancelled`, `error`, `timeout`, `unsupported`, `empty` or `no-arabic-voice`. It never rejects. It:
  - picks an Arabic voice (`lang` starting with `ar`, preferring the language list order and then on-device voices), waiting for an async `voiceschanged` if needed;
  - calls `cancel()` before speaking and uses `rate` 0.95;
  - applies Chrome's long-utterance pause/resume keepalive every 10 s (desktop Chrome only; skipped on Android, where `pause` cancels speech);
  - keeps strong references to utterances (Chrome GC bug);
  - has a start timeout and an overall timeout, so a broken engine can't block the conversation.
- **Half-duplex invariant.** `recognition.start()` is never called while `speechSynthesis.speaking || pending`. `speak()` first aborts any active recognition. `listen()` stops our own speech (barge-in), waits for the synthesizer to be silent, waits `guardMs` (400 ms) after speech ended, and checks again immediately before `start()`.
- `canAutoListen()` is true only when recognition is supported, `navigator.permissions.query({name:'microphone'})` reports **`granted`** (kept live through its `change` event), the browser is online, and there has been no mic or service failure. If the Permissions API is missing (older Safari or Firefox), the state is `unknown` and the UI shows the tap button.
- `canSpeak()`, `hasArabicVoice()`, `status()`, `subscribe(fn)` (status changes), `refreshPermission()`, `debugLog()` (timeline, no transcripts) and `destroy()` are also available.

## 5. `speech-text.js`

- `speakableText(question)` uses `question.speech` **only if** `skeleton(speech) === skeleton(text)`, meaning only diacritics, punctuation or pauses differ. Otherwise it uses `question.text`. It then applies `addPauses`, so the app never says words that aren't on screen.
- `addPauses(text)` puts an Arabic comma before «ولا» / «ولّا» / «أو» («بدك للبيع، ولا للإيجار؟») and never changes letters.
- `skeleton()` and `stripDiacritics()` re-implement `src/nlu/arabic.ts` exactly. A test checks this over the Arabic Unicode blocks.

## 6. Browser notes

- Use HTTPS or `localhost`; microphone APIs need a secure context. Chrome and Edge send recognition audio to a cloud service, so it does not work offline. Safari (macOS and iOS 14.5+) has `webkitSpeechRecognition`. Firefox has no recognition, so the user types and the question is still shown, and spoken if an Arabic voice exists.
- Many desktop installs have **no Arabic TTS voice**. In that case `canSpeak()` is false and the question is only shown, because an English voice reading Arabic is worse than silence.

## 7. Tests

```
node --test test/unit/conversation-*.test.ts     # machine (fake api/voice/clock), voice (fake window), speech-text
node test/e2e/voice-harness.spec.ts              # SIMULATED voice e2e in Chromium (mock Web Speech API)
```

The e2e run is **simulated**: it injects a mock SpeechRecognition, speechSynthesis and permissions. It proves the client wiring, timing and half-duplex ordering, but it is **not** a human voice test. Before release, a person should do this check with a real microphone in Chrome:

1. Say «بدي شقة بإعزاز». Interim words appear, then the review countdown, then the request is sent.
2. The question is spoken in Arabic. The mic opens only after the speech has finished, and the app doesn't transcribe its own voice.
3. Answer «للإيجار». The answer belongs to the same request.
4. Deny the mic once. The message explains how to re-enable it and typing still works.
