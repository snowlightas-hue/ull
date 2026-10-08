# Ultra Link — independent review (Role 8: tests & adversarial review)

Reviewed: `ultra-link/` at `b7a54b6` (integrator WIP snapshots on top of `168d2a7`) **plus the uncommitted working
tree of 2026-10-08** (other roles were editing in parallel; line numbers refer to that tree and were re-checked at the
end of the review). Reviewer: Role 8. Nothing in `src/` or `public/` was changed by
this review — every defect below comes with a reproduction and a *proposed* patch for the owning role.

## 0. What is and is not proven (read this first)

| Claim | Status | Evidence |
|---|---|---|
| **Voice** works with a human voice | **NOT TESTED.** All voice checks are **SIMULATED**: a mock `SpeechRecognition` / `speechSynthesis` / `permissions` injected into Chromium (`test/e2e/mock-voice.ts`). They prove wiring, timing, half-duplex ordering and "answer goes to the same conversation" — not recognition of a person speaking Arabic. | `test/e2e/voice-harness.spec.ts`, `test/e2e/integration-voice.spec.ts` (both print "SIMULATED"). Human checklist still open: `public/js/conversation/README.md` §7. |
| **Jev key configured** | **Yes.** `.env` holds a well-formed `TYPESAFE_API_KEY` (prefix `apikey_`, 108 chars); `/api/ai/status` → `keyConfigured: true`. | `curl /api/ai/status` on the demo (read-only). |
| **Jev verified** (a real call succeeded) | **NO — blocked by the egress policy.** The proxy refuses `CONNECT api.typesafe.ai:443` with 403; the app reports `verified:false, mode:"rules"`, label «مفتاح Jev موجود لكن الاتصال فشل — يعمل المحلّل المحلي». | `curl https://api.typesafe.ai/v1/models` (no credentials sent) → `CONNECT tunnel failed, response 403`; demo `/api/ai/status` → `lastError: "network: … HTTPS proxy refused CONNECT with HTTP 403 (egress policy …)"`. |
| Jev **behaviour** (fallback, budget, honesty of status) | Proven **against the local mock only** (`JEV_MODE=simulate`, loopback). A simulation never counts as verified. | `test/integration/flows-conversation.test.ts` (fallback ≡ rules-only), `test/integration/server-jev.test.ts` (Role 7). |
| Secret hygiene | `apikey_` occurs **0 times in all 7 commits** of git history (`git log -p --all`), the exact key value occurs nowhere outside `.env` (repo, `var/log`, test artifacts, `public/`), `.env` is git-ignored and was never committed. No value was printed during the check. | §3 commands. |
| Demo data | Synthetic, labelled, `realm=synthetic`; never matched with real data. | `flows-matching` isolation test, fuzz realm check. |

## 1. How to reproduce

```bash
npm run test:e2e                                                   # = node test/e2e/run.ts (all 5 browser specs)
node --test --test-concurrency=1 test/integration/flows-*.test.ts  # flows on fresh databases
```
Every spec/test builds its **own** database (`freshDb`) and, for the browser, its own server + worker on a free port;
the live demo on :8080 (pids in `var/run/*.pid`) is never touched. Chromium: `/opt/pw-browsers/chromium`, `playwright-core` 1.56.1.

## 2. Results

RESULTS_PLACEHOLDER

## 3. Findings

Severity: **blocker** = a core scenario cannot be completed or data is exposed; **major** = wrong/unsafe behaviour a
normal user will hit; **minor** = polish, hardening, docs. Each finding lists evidence (a failing check where one
exists), a reproduction and a proposed patch for the owning role.

**No blocker found.** All six README scenarios pass end to end on 1280×800, 390×844 and 360×640.

### MAJOR-1 — Giving up on the *category* question crashes every later turn (HTTP 500, conversation stuck)
- Owner: integrator (`src/conversation/engine.ts`).
- Evidence: `flows-api › robustness` → `turn «لحظة» → 500`, `turn «طيب» → 500`; `flows-conversation › after 3 unanswered attempts…` → `CRASH Cannot read properties of undefined (reading 'value')`.
- Repro: «بدي حدا يصلحلي شي» → «ممم» → «يعني» → «لحظة». The 4th turn (and every turn after it) returns
  500 «صار خطأ عندنا». Stack: `buildSpec` `engine.ts:316` (`d.category!.value`) ← `applyTurn` `engine.ts:220`.
- Cause: `nextQuestion()` returns `null` once a field was asked 3× (`engine.ts:232`, "give up politely"), and
  `applyTurn` treats "no question" as "ready to save" unless *both* side and category are missing (`engine.ts:217-220`).
  With `side` known (بدي) and `category` missing, it calls `buildSpec`, which dereferences the missing category.
- Patch (engine.ts, decide step):
  ```ts
  const question = nextQuestion(reg, draft);
  if (question) return { draft, parse, next: { kind: 'ask', question }, appliedJev };
  const essentialMissing = !draft.category || needsDeal(reg, draft) || needsPlace(reg, draft);
  if (essentialMissing) return { draft, parse, next: { kind: 'unclear', messageAr: 'ما قدرت أفهم كل شي. احكيلي الطلب بجملة وحدة، مثلاً: «بدي كهربجي بإعزاز».' }, appliedJev };
  ```
  (`needsDeal` = category has >1 deal and `!draft.deal`; `needsPlace` = `!draft.place?.value.ids.length && !draft.resolved.includes('place')`.)

### MAJOR-2 — Giving up on *deal* saves a deal the user never chose (rent → **sale**)
- Owner: integrator (`engine.ts`). Violates PRODUCT §5.3 ("الصفقة… ممنوع" to infer) and §6.1 (deal is always required).
- Evidence: `flows-conversation › after 3 unanswered attempts…` → `«بدي شقة بإعزاز» saved as «بيع وشراء» (sale) although the user never chose buy or rent`.
- Repro: «بدي شقة بإعزاز» → «ممم» → «يعني» → «لحظة» ⇒ a **purchase** request is saved and matched.
- Cause: `buildSpec` `engine.ts:318`: `const deal = d.deal?.value ?? cat.deals[0]!` — the first allowed deal is used as a default.
- Patch: same guard as MAJOR-1 (never reach `buildSpec` while a multi-deal category has no deal); keep `cat.deals[0]` only for single-deal categories.

### MAJOR-3 — Giving up on *place* silently widens a seeker's request to "anywhere"
- Owner: integrator (`engine.ts`). Violates PRODUCT §6.1 (a seeker's place is required) and §6.2-7 ("لا توسيع تلقائي أبداً").
- Evidence: same test → `«بدي غسالة مستعملة» saved with an empty scope (= anywhere) although the user never named a place`.
- Cause: after 3 place questions `buildSpec` writes `scopePlaceIds: []`, which the schema defines as "anywhere" (`intents.scope_place_ids` comment, `refreshScopes` adds the root place).
- Patch: same guard as MAJOR-1. If the product wants "save anyway", save it **paused** with a visible «المكان ناقص» chip instead of matching it world-wide.

### MAJOR-4 — Keyboard/screen-reader focus is dropped to `<body>` after answering with a quick-answer chip
- Owner: Role 2 (`public/js/ui/home.js`). Contradicts `public/js/ui/README.md` ("If the focused element disappears, focus moves to the results heading…").
- Evidence: `app-a11y › keyboard: login, tabs…` → FAIL `focus is not lost to <body> after results render` (`activeElement` = `BODY`, also 1 s later).
- Repro (keyboard only): type «بدي شقة بإعزاز», Enter, Shift+Tab to «إيجار», Enter → results render, `document.activeElement` is `<body>` (screen readers lose their place; the results heading is never focused).
- Cause: the chip's click handler disables **all** chips, including the focused one (`home.js:391-393`), outside `focusRescue()`. The browser drops focus to `<body>`; later renders don't rescue it because `focusRescue` only acts when focus *was inside* the view (`home.js:215-218`).
- Patch:
  ```js
  b.addEventListener('click', () => {
    focusRescue(() => { for (const other of optionButtons) { other.disabled = true; other.dataset.chosen = other === b ? 'true' : 'false'; } });
    call('onOption', o.value);
  });
  ```
  (`focusRescue` then moves focus to `.q-text` (tabindex −1), and the results render moves it on to the results heading.)
  Alternative: use `aria-disabled="true"` + ignore clicks instead of `disabled` on the pressed chip.

### MAJOR-5 — Closing the request editor (Esc / إلغاء) loses focus instead of returning it to «تعديل»
- Owner: Role 2 (`public/js/ui/cards.js`) with integrator (`public/js/app.js`).
- Evidence: `app-a11y › keyboard: editor dialog` → FAIL `Esc closes and focus returns to «تعديل»` (`activeElement` = `BODY`). A probe confirmed the requests list is **not** re-rendered meanwhile — the opener is lost before the dialog opens.
- Cause: `onEdit` returns `editIntent()`'s promise (`app.js:182`, `onEdit: (intent) => editIntent(intent.id)`), so `runAction` (`cards.js:72-79`) sets `disabled` on the focused «تعديل» button while the intent/taxonomy load; focus falls to `<body>`; `openIntentEditor` then captures `opener = document.activeElement` = `<body>` (`editor.js:99`) and `close()` has nothing to return to (`editor.js:319`).
- Same pattern for every `runAction` button (طلب تواصل، قبول، رفض، إيقاف…): see `app-a11y › keyboard: «طلب تواصل» keeps focus`.
- Patch (cards.js `runAction`): keep the button focusable while busy —
  ```js
  btn.setAttribute('aria-disabled', 'true'); btn.dataset.busy = 'true';   // instead of btn.disabled = true
  // and at the top of runAction: if (btn.dataset.busy === 'true') return;
  ```
  and let `openIntentEditor` accept an explicit `{ opener }` (app.js passes the clicked button) so a later list refresh cannot orphan it either.

### MAJOR-6 — Real (non-demo) accounts cannot log back in; logout or cookie expiry orphans the account and its live requests
- Owner: Role 7 (`src/server/app.ts`) + product (Role 1).
- Evidence: the only auth routes are `POST /api/auth/demo-login` (synthetic personas only — `users.ts:31-32` requires `realm='synthetic'`), `/register` and `/logout` (`app.ts` auth section). A real account has no credential. After «خروج» (`app.js:279`, no warning or confirmation) or 30 days (`Max-Age=2592000`), the user can never act on their requests again, yet those requests stay `active` for 30–60 days, keep matching, and generate notifications and contact requests nobody can read or answer.
- Repro: register «أمل», save a request, press «خروج», reload → only "create a new account" is possible; the old request still matches other users.
- Patch options: (a) at registration show a one-time recovery code (store its hash) + `POST /api/auth/recover`; (b) minimum: on logout of a `real` account, confirm with a clear warning and **pause** its active intents (`setIntentStatus(..., 'pause')`) so no counterpart waits on an unreachable person.

### MAJOR-7 — The assistant re-asks «بدك تبيع ولا تأجّر؟» after the user already said «بدي بيعو»
- Owner: integrator (`src/nlu/parse.ts`).
- Evidence: `flows-conversation › repeated-question guard` → `d044#2: «deal» re-asked after the answer «عفرين»`, `d044#3: … «٧٠٠ دولار»` (corpus agreement otherwise 150/155 turns).
- Repro: «موتور» → «بدي بيعو» → «عفرين» → «٧٠٠ دولار»: the deal question is asked three times; the user said "sell it" in turn 2.
- Cause: `parseUtterance('بدي بيعو')` → `side=provide, deal=null`; the MSA spelling «بدي بيعه» → `deal=sale`. `SALE_RE` (`parse.ts:109`) lists `بيعه|بيعها|ابيعه|ابيعها` but not the Levantine pronoun suffix `-و`.
- Patch: add `بيعو|ابيعو|نبيعو|ببيعو|اشتريو` to `SALE_RE` (and the equivalent `أجّرو|اجرو|بأجرو` forms to the rent cue list); add «بدي بيعو» / «بدي أجّرو» to `test/corpus/utterances.json`.

### Minor findings
| # | Finding | Evidence / location | Proposed patch |
|---|---|---|---|
| m1 | A pair that is invalidated and later becomes valid again is never notified again (dedupe key is per pair, forever). PRODUCT §8 says users are told when a result changes. | `matching/engine.ts:176` `dedupeKey: match:${v}:${a}:${b}`; `flows-matching › stale evaluations` observes ≤ 1 notification across 25 flips. | Include the transition epoch in the key, e.g. `match:${v}:${a}:${b}:${firstConfirmedSeq}`; or a separate `match_restored` kind. |
| m2 | Concurrent turns on one conversation are rejected with 409 «busy» rather than queued (3 of 8 racing turns in the test). A double-tap on a chip shows an error. | `conversation/service.ts` optimistic retry ×3 (`revision`), `flows-conversation › many concurrent turns` info line. | `SELECT … FOR UPDATE` on the conversation row at the start of the turn transaction (serialize instead of fail), or have the client retry 409 «busy» once automatically. |
| m3 | Session cookie gets `Secure` only when Node itself sees HTTPS (`cookieAttrs`, `app.ts:209`, added during this review). With `trustProxy: false` behind a TLS-terminating proxy, `req.protocol` is `http` and the cookie is sent without `Secure`. | `app.ts:209` + `trustProxy: false`. | Add an explicit `UL_COOKIE_SECURE=1` (or trust the proxy's `X-Forwarded-Proto` when configured). |
| m4 | CSP allows `style-src 'unsafe-inline'` although the UI is documented to work under `style-src 'self'`. | `app.ts` onSend hook; `public/js/ui/README.md` "Hard rules". | Drop `'unsafe-inline'`; `ui-preview.spec.ts` already checks the UI under the strict policy. |
| m5 | No rate limit on `PATCH /api/intents/:id` and `/status`; each call runs a synchronous match (up to `UL_CANDIDATE_LIMIT`=5000 candidates) — cheap load amplification. | `app.ts` onRequest limiter covers auth / turns / simulate only. | Add an `edits` bucket (e.g. 30/min/session). |
| m6 | README / code reference docs that do not exist: `docs/DATABASE.md`, `docs/MATCHING.md`, `docs/OPERATIONS.md`. | `README.md` «الوثائق», `matching/evaluate.ts` header. | Write them or fix the links. |
| m7 | Product tension: a **preferred** price in another currency/unit blocks confirmation («whatever the strength», `evaluate.ts` header + `priceCheck`), while PRODUCT §6.2-4 says an unknown preference never blocks confirmation. | `flows-matching` fuzz oracle had to encode the engine's rule. | Decide in PRODUCT §6.2 and document; if preferences must not block, pass `blocks = strength === 'required'` for `currency_mismatch` / `unit_mismatch`. |
| m8 | `npm run typecheck` is red: `test/unit/ai-resolver.test.ts:22` (`RuleParse.radius` optional vs `null`). | `npx tsc --noEmit -p tsconfig.json`. | Role 4: build the fixture with `radius: null, nearest: false, hereRef: null` or make the fields optional in `src/nlu/types.ts`. |
| m9 | Touch targets below 44×44 px on phones: quick-answer chips 73×41, «إلغاء الطلب» 128×38, «خروج» 66×38 (all ≥ 24 px, so WCAG 2.2 AA 2.5.8 passes). | `app-a11y › mobile: touch targets` info line. | `min-height: 44px` for `.chip-btn`, `.cancel-btn`, `header .btn`. |
| m10 | `integration-voice.spec.ts` defaults to the **live demo** (`http://127.0.0.1:8080`) and writes into it (logs in as rami, saves requests). | `integration-voice.spec.ts` `BASE = process.argv[2] ?? …8080`. | `run.ts` now always passes an isolated stack; make the spec refuse to run without an explicit base URL. |
| m11 | A failing Jev call can exceed `UL_JEV_BUDGET_MS` (backoff sleep not abortable) — persistent 500 / 429 with retry-after. | `server-jev.test.ts` marks it `todo` (Role 4). Not reproduced in the flows sample (malformed / 401 / wrong type / dropped socket all stayed within budget + 1.5 s). | Pass the turn's `AbortSignal` into the retry sleep in `jev-client.ts`. |

## 4. What was attacked and held (no finding)

- **Isolation (HTTP):** another user gets **404** (never 403/200) for every intent, match, conversation, notification and contact-request id of someone else, and none of them appears in that user's lists; probes don't change the owner's state (`flows-api › isolation`). Anonymous → 401 on every private route. Cross-site writes (`Origin` of another site, `Origin: null`, form-encoded posts) → 403/415.
- **Privacy before consent:** match cards carry no counterpart name, phone or utterance until the recipient accepts; then both sides see each other at the same moment; a request cannot be answered twice or by the requester (`flows-api › privacy`). The results page never shows Layla's name (`app-scenarios (a)`).
- **Hard constraints:** 1,200 random seeker × offer pairs (3 seeds) re-checked from raw DB rows by an independent oracle: no stored confirmed/possible match violates a hard condition (place scope/exclusion, price lte/gte/eq/between, attributes in both directions, deal, category, realm, same owner); nothing unproven is confirmed; nothing non-excluded is missing; stored state ⇔ reasons ⇔ missing ⇔ score band are coherent (`flows-matching › fuzz`).
- **Money precision:** offers at 2^53−1, 2^53, 2^53+1 and BIGINT max against a cap of 2^53 and an exact 2^53+1 — compared as BigInt (2^53+1 is excluded although `Number(2^53+1) === Number(2^53)`), stored exactly, and shown with the exact digits; the API rejects > 15 digits, negatives, decimals, exponents and Arabic-Indic digit strings with 400/422, never 500 (`flows-matching`, `flows-api`).
- **Stale evaluations:** 25 randomized rounds of concurrent offer edits, seeker re-runs, stale worker jobs and stale direct runs — the stored pair always reflects the latest versions of both intents; no older evaluation overwrote a newer one.
- **Idempotency:** the same `clientTurnId` replayed sequentially, after the conversation was saved, with different text, and 5× concurrently — always the same TurnResult, one stored turn, one intent (service and HTTP level).
- **Racing different answers:** two answers to one question — exactly one wins, the other gets 409, never two intents (6 rounds).
- **Draft persistence:** pending question + understood chips survive a reload, a second device (second session), and the browser reload in `app-scenarios (g)`; the old draft is cancelled when a new request starts.
- **Provider failure:** with Jev failing on every call (malformed JSON, 401, wrong answer type, dropped socket) or unreachable, 18 corpus dialogues end exactly as with `JEV_MODE=off`; every attempted call (23 per fault kind) is disclosed in `understanding.notesAr`; latency stays bounded.
- **Logs:** server/worker logs of every isolated stack contain no Arabic utterance, cookie, token or key.
- **Accessibility that holds:** RTL + `lang=ar`, skip link, ARIA tablist with RTL arrow keys/Home/End/roving tabindex, dialog `aria-modal` + focus trap + inert background, polite live region for outcomes, AA contrast on all audited text, no horizontal scroll on any screen at 360/390 px, no looping or > 200 ms animation under `prefers-reduced-motion: reduce` (and the probe is shown to detect them without it).

## 5. Test inventory (owned by Role 8)

| File | What |
|---|---|
| `test/e2e/run.ts` | runs all browser specs (ui-preview, voice-harness, app-scenarios, app-a11y, integration-voice on an isolated stack); one summary table; non-zero exit on failure |
| `test/e2e/app-lib.ts` | isolated stack (freshDb → seed → server + worker on a free port → teardown), viewports, noise watcher, helpers |
| `test/e2e/app-scenarios.spec.ts` | the six README scenarios + draft-after-reload, 3 viewports, screenshots in `test/e2e/artifacts/app/` |
| `test/e2e/app-a11y.spec.ts` | keyboard, focus, dialog, mobile layout/touch/contrast, reduced motion |
| `test/integration/flows-conversation.test.ts` | corpus repeated-question guard, reload, retries, races, give-up, provider fallback |
| `test/integration/flows-matching.test.ts` | constraint fuzz with DB-row oracle, 2^53 precision, stale-evaluation race, realm isolation |
| `test/integration/flows-api.test.ts` | HTTP isolation, auth/CSRF, privacy before consent, wire-level idempotency, two devices, no-5xx robustness |
