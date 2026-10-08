# `public/js/ui` — Ultra Link view layer (Role 2 · Design & UX)

These are pure view/render helpers: plain ES modules with no framework, no build step and no network access (fonts are system fonts, icons are inline SVG). They never touch the microphone, speech synthesis or the API. `app.js` (integrator) and `conversation/*` (Role 3) own state and side effects, and they call these functions.

**Hard rules**
- Untrusted text is always inserted as text nodes. Nothing here uses `innerHTML`, `insertAdjacentHTML` or `document.write`.
- Inline styles go only through the CSSOM (`el.style.setProperty`). The pages work under a strict `script-src 'self'; style-src 'self'` CSP, and `index.html` has no inline script.
- Native `Element.append()` / `replaceChildren()` turn `null` into the text `"null"`. Use `append()` / `mount()` from `dom.js`. The e2e script checks every state for leaked `null` / `undefined` / `NaN`.
- Signatures below are stable. New options are only ever added as optional fields.

## Digits and numbers (decision)

Every number the UI generates uses **Arabic-Indic digits** (`٠١٢٣٤٥٦٧٨٩`) with the Arabic separators `٬` (thousands) and `٫` (decimal), for example `٢١–٤٠ من ٢٥٠` and `قبل ٥ دقائق`. Our users in northern Syria and the Levant read these digits natively, the product copy uses them, and mixing two digit systems in one Arabic sentence slows scanning. Arabic strings from the server go through `ar()` / `localizeDigits()` so the whole screen stays consistent. That function leaves alone numbers glued to Latin letters (`i10`, `X5`) and phone-like runs of 7 or more digits.

**The single exception is phone numbers.** They are shown exactly as given, in an LTR `<a href="tel:">`, so they can be dialled and copied.

Formatting is done by hand rather than with `Intl.*`, because ICU builds disagree on the default Arabic numbering system. Money is integer minor units held in decimal strings and is processed with **BigInt only**: no `parseFloat`, no `Number` arithmetic.

## Modules and exact signatures

### `dom.js`
```js
h(tag, attrs?, ...children) → HTMLElement      // attrs: class (string|array), style (object; --vars ok), dataset, on:{ev:fn}, onClick…, aria-*, booleans
s(tag, attrs?, ...children) → SVGElement       // same, SVG namespace
append(parent, children) → parent              // null/false-safe
mount(el, ...children) → el                    // replaceChildren, null-safe
clear(el), setText(el, text), uid(prefix), on(el, type, fn) → off, prefersReducedMotion(), focusableWithin(root), srOnly(text)
```

### `format.js`
```js
toArabicDigits(v), toLatinDigits(v), localizeDigits(text) (alias ar)
formatNumber(n|bigint|string)                       // "١٬٢٥٠٬٠٠٠"
formatAmount(minorStr, currency?)                   // "125050" → "١٬٢٥٠٫٥٠"
formatMoney(minorStr, currency?, unit?)             // ("20000","USD","month") → "٢٠٠ دولار شهريًا"
formatPriceSpec(PriceSpec|null)                     // "بين ١٠٠ و٢٥٠ دولار شهريًا", "حتى ٢٠٠ دولار (قابل للتفاوض)"
parseAmountToMinor(text, currency?) → string|null   // "١٬٢٥٠٫٥" → "125050"; rejects >2 decimals
minorToInput(minorStr, currency?), compareMinor(a, b) → -1|0|1
arPluralCategory(n), formatCount(n, NOUNS.x, {acc?}) // "٣ عروض", "١١ عرضًا", "عرضان" / acc "عرضين"
formatRelativeTime(iso|Date|ms, now?)               // "الآن", "قبل دقيقتين", "قبل ٥ دقائق", "أمس", "بعد ٣ أيام"
formatDateTime(iso, {time?, year?}), formatDate(iso, {year?})   // Levantine months: "الجمعة ٩ تشرين الأول"
formatRange(start, end, total)                      // "٢١–٤٠ من ٢٥٠"
formatBadge(n)                                      // "" | "٧" | "٩٩+"
formatScore(0..10000)                               // "٨٧٪"
telHref(phone)
CURRENCY_AR, PRICE_UNIT_AR, PRICE_UNIT_LABEL_AR, MINOR_DIGITS, NOUNS
```

### `shell.js`
```js
mountShell(root) → {
  el, header, main, panels,
  tabs: { list: HTMLElement /* role=tablist */, buttons: { home, requests, offers, matches, notifications } },
  views: { home, requests, offers, matches, notifications },  // render targets (list panels already have a heading)
  setCounts({ requests?, offers?, matches?, unread? }),       // tab badges + list-heading totals; partial updates ok
  setActiveTab(name, { silent?: boolean, focus?: boolean }),   // fires onTabChange listeners unless silent
  getActiveTab() → name,
  onTabChange(cb(name)) → unsubscribe,
  setAiStatus(status|null),     // /api/ai/status payload; uses status.labelAr when present
  setRealm(realm, displayName), // 'synthetic' shows the "وضع تجريبي" badge
}
```
Tabs follow the ARIA tablist pattern: roving `tabindex` and automatic activation. In RTL, **ArrowLeft goes to the next tab** and ArrowRight to the previous one. Home and End jump to the first and last tab. At narrow widths the tab bar scrolls inside itself; the page never scrolls sideways. The shell keeps `--header-h` in sync with the header's real height.

### `home.js`
```js
mountHome(el, handlers) → {
  el, phase /* getter */,
  setPhase(phase, detail?: { labelAr?, hintAr?, messageAr? }),
  showTranscript(text, { interim?: boolean }),
  showReview({ text, seconds }),              // countdown is visual only: the caller owns the real timer
  showQuestion(question, { canAutoListen? }), // sets phase 'asking' if not already in a question phase
  hideQuestion(),
  showSummary(summary|null),                  // TurnResult.summary
  showResults(matchRunResult),                // sets phase 'results'
  showSavedNoResults(intentCard, suggestionsAr[], matchRunResult?),  // 3rd arg optional → exclusion line
  showError(messageAr),                       // sets phase 'error'
  setTextValue(text), focusText(),
}
handlers = {
  onMicPress(), onTextSubmit(text), onSendNow(text), onEditTranscript(text), onCancel(), onOption(value),
  onAnswerTap(), onRetry(), onOpenRequests(intent?), onSuggestion(suggestionAr),
  // optional
  onContact(match) → Promise<MatchCard|void>?, onRespond(match, accept), onOpenMatches(), onNewRequest(), onOpenIntent(intent)
}
```
**Idempotent re-renders.** `app.js` re-renders on every machine update, so identical calls do nothing. An identical `showReview` keeps the running countdown. An identical `showQuestion` keeps the card and the keyboard focus. An identical `showResults`, `showSavedNoResults` or `showError` keeps the DOM, so entrance animations don't replay and `role=alert` isn't announced again.

**Housekeeping done by the view.** Entering `ready` clears the transcript, summary and results. Entering `saving`, `searching`, `results` or `saved_no_results` clears the question. Going from results to `listening` clears the old summary and results. If the focused element disappears, focus moves to the results heading, the question, the mic or the status line (in that order).

| phase | what the user sees | motion (state-bound; none while idle) |
|---|---|---|
| ready | near-empty screen, mic, three example phrases (tap → fills the text box) | none (static glow) |
| listening | pulse rings, live transcript (dashed), "إلغاء الطلب" | 3 pulse rings, only while listening |
| reviewing | transcript + countdown ring + إرسال الآن / تعديل / إلغاء | ring depletes once over N s |
| processing | orbiting dots, transcript shimmer | orbit + shimmer |
| asking / speaking | question card fades/scales in, quick-answer chips; speaking shows an equaliser | card enters once; equaliser only while speaking |
| awaiting_answer | status "دورك …" with a static dot; if `canAutoListen:false` a big **اضغط للإجابة** replaces the mic | none |
| saving | check drawn on the mic | draws once |
| searching | radar sweep | sweep, only while searching |
| results | counts, exclusion line, suggestions (choices, never auto-applied), staggered MatchCards | cards slide up once |
| saved_no_results | "تم حفظ طلبك، سنخبرك عند ظهور مطابقات مناسبة" + card + link to طلباتي/عروضي | fade once |
| error | recoverable message + إعادة المحاولة / البدء من جديد (`role=alert`) | fade once |

### `cards.js`
```js
intentCard(intentCard, { onEdit(intent), onStatus(intent, 'pause'|'resume'|'fulfill'|'close'), onOpenMatches?(intent) }) → <article>
matchCard(matchCard, { onContact(match) → Promise<MatchCard|void>?, onRespond(match, accept), onOpenIntent?(intent) }) → <article>
chipList(chips, { compact? }), timeEl(iso, prefixAr?), sep()
STATUS_AR, SIDE_AR, MATCH_STATE_AR, POLARITY_AR, STRENGTH_AR
```
A handler may return a Promise; the pressed button shows a busy state until it settles. "تمت تلبية الحاجة" and "إغلاق" ask for a second press within 4 s. If `onContact` resolves with an updated `MatchCard`, the card re-renders in place. Contact states are shown as `none` → "طلب تواصل", `pending_out`, `pending_in` (قبول / رفض), `accepted` (name + LTR `tel:` phone + "اتصال") and `declined`.

### `lists.js`
```js
renderIntentPage(el, Page<IntentCard>, { onPage(dir, cursor, page), onEdit, onStatus, onOpenMatches?,
                                         onFilter?(status), filter?: 'active'|'fulfilled'|'closed'|'expired'|'all',
                                         emptyTextAr?, emptyActionLabelAr?, onEmptyAction? })
renderMatchPage(el, Page<MatchCard>, { onPage, onContact, onRespond, onOpenIntent?, onFilter?(state), filter?, emptyTextAr? })
renderNotificationPage(el, Page<Notification> & { unread? }, { onPage, onRead(n) → Promise?, onReadAll() → Promise?, onOpen?(n), emptyTextAr? })
renderEmpty(el, textAr, { actionLabelAr?, onAction?, icon? })
renderLoading(el, textAr?)                 // skeleton, aria-busy
renderListError(el, messageAr, onRetry?)
```
The pager reads "٢١–٤٠ من ٢٥٠" with السابق / التالي. A button is disabled with `aria-disabled` (so it stays focusable) when its cursor is `null`. After the caller re-renders the next page, focus goes back to the same pager button.

`Notification` is read tolerantly as `{ id, kind, titleAr, bodyAr, payload: { matchId?, intentId?, requestId? }, createdAt, readAt }` (the shape in `src/repo/notifications.ts`). "عرض" appears when the notification has a target. Mark-as-read and mark-all are optimistic and roll back if the handler's promise rejects.

### `editor.js`
```js
openIntentEditor(intentDetail, { onSave(changes) → Promise|void, onCancel(), choices? }) → { el, close() }
// intentDetail: IntentCard + optional spec: IntentSpec (prefill)
// choices (or intentDetail.choices): { categories: {code, labelAr, deals?, vertical?}[], places: {id, labelAr}[] }  (= /api/taxonomy)
// changes: Partial<IntentSpec> with ONLY edited sections: categoryCode, deal, place, price (PriceSpec|null), when (TimeWindow|null)
```
The editor opens as a sheet on phones and a centred dialog on desktop. It has `role=dialog` and `aria-modal`, traps focus, closes on Esc or a backdrop click, makes the background `inert`, and returns focus to the opener.

Price and time stay collapsed behind "إضافة سعر" / "إضافة موعد" until they are needed. Amounts accept Arabic-Indic or Latin digits and are parsed with BigInt. "Between" checks `lo ≤ hi`. "Approx" forces `preferred`. Categories are limited to the current vertical, because the server rejects a change of vertical. On a rejected save the sheet stays open and shows `error.messageAr`, for example on a 409 version conflict.

### `toast.js`
```js
toast(textAr, { kind?: 'info'|'success'|'warning'|'error'|'match', timeoutMs? = 5000 (0 = sticky), titleAr?, actionLabelAr? (alias actionLabel), onAction? }) → { el, dismiss() }
clearToasts()
```
There is a single live region (`role=status`, `aria-live=polite`) that is created when the module loads. At most 3 toasts are visible, and hovering or focusing one pauses its timer.

### `icons.js`
`icon(name, { size?, label?, className? })`, `logoMark({ size? })`, `ICON_NAMES`.

## Styling (`public/css/app.css`)
Colours are tokens on `:root`: `--bg #060914` (deep night), `--surface*`, `--text #eef2ff`, `--text-2`, `--text-3`, `--accent #4ff0d2` (luminous aqua), `--accent-2 #8b7bff` (violet), `--ok`, `--warn`, `--danger`, `--info`, and `--focus #ffd84d` for the 3px focus ring. Every text pair measured in the e2e check has a contrast of at least 4.5:1.

The font stack is `"Noto Sans Arabic","Noto Naskh Arabic","Segoe UI","Tahoma","Geeza Pro","DejaVu Sans",system-ui`. Layout is mobile-first (360/390) with a centred column of at most 760px on desktop.

Motion only animates `transform` and `opacity`. The two exceptions are tiny SVG strokes: the countdown ring and the check-draw. With `prefers-reduced-motion`, continuous motion is removed (listening shows static rings) and entrance animations become 150ms fades.

## Preview and tests
- `public/ui-preview.html` mounts these modules with fake Arabic data: 250 paginated requests, a very long title, missing values, every contact state and every phase. Use `?state=<name>` to pick a state and `?chrome=0` to hide the control panel. Its dev-only driver lives in `preview.js` / `preview-data.js`, which the app never imports.
- `node test/e2e/ui-preview.spec.ts` checks overflow at 360×640, 390×844 and 1280×800, RTL and `lang`, the tab keyboard pattern, contrast, reduced motion, the dialog focus trap, pagination, idempotent re-renders and leaked `null`. It writes screenshots to `test/e2e/artifacts/ui/`.
