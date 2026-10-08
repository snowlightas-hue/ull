# سجل دورات التحسين — Improvement log

Loop: اكتشاف مشكلة → تحديد أثرها → أصغر حل مفيد → اختبار ومراجعة → قياس → اختيار التحسين التالي.
Measurement: `node scripts/corpus-report.ts` against the labeled corpus in `test/corpus/` (written by the product role independently of the parser). Rules engine only — Jev is not reachable from this environment.

| Field | Baseline | Cycle 1 | Cycle 2 | Cycle 3 | Cycle 4 |
|---|---|---|---|---|---|
| side (الدور) | 88.0% | 89.8% | 89.8% | **96.6%** | 96.6% |
| category (التصنيف) | 84.1% | 85.1% | 85.1% | 85.9% | **98.2%** |
| deal (نوع الصفقة) | 81.2% | 88.0% | 88.0% | 88.8% | **98.2%** |
| places (الأماكن) | 96.3% | 96.6% | 96.6% | 97.4% | 97.4% |
| price (السعر كاملًا) | 32.2% | 33.1% | **80.2%** | 79.3% | 81.0% |
| constraints (الشروط) | 5.7%* | 4.7%* | **50.6%** | 53.0% | 58.0% |
| attrs (الصفات) | 54.9% | 56.3% | 57.7% | 62.5% | 66.7% |
| when (الزمن) | 74.5% | 74.5% | 74.5% | 74.5% | 82.2% |
| first question = essential (السؤال الأول ضروري) | 66.6% | 74.2% | 76.2% | 79.6% | **86.4%** |
| dialogues fully correct | 70.5% | 73.8% | 75.4% | 77.0% | 77.0% → **96.7%** (cycle 6) |
| repeated-question violations | 0 | 0 | 0 | 0 | 0 |

> **تنبيه منهجي:** هذه أرقام «داخل العيّنة» — التحسينات بُنيت بقراءة أخطاء نفس المدوّنة، لذا تبالغ في تقدير الأداء على كلام جديد. لقياس صادق طُلبت مدوّنة **محجوزة** جديدة (`holdout-utterances.json`) تُكتب دون رؤية المحلّل، ولا تُقرأ أخطاؤها فرديًا أثناء التطوير. نتيجتها في القسم الأخير.

\* before cycle 2 the report compared default strengths instead of the user's explicit cue (measurement bug, fixed).

### Cycle 1 — prefixes and deal words (impact: fewer needless questions)
Found: «وبدي», «بأجّر», «للشراء», «للضمان», «استئجار», «شقتي/شقتين», «بألف/بمليون» missed → extra questions. «بس» read as "only" when it means "but". Fix: clitic-aware cues, post/pre cue split. Effect: deal +6.8 pts, first-question accuracy +7.6 pts.

### Cycle 2 — money semantics (impact: correct exclusion, trust)
Found: «ما بدي أدفع أكتر من ٢٠٠» parsed as a minimum; «بين ١٥ و٢٠ ألف» lost the multiplier; unit before amount («بالأسبوع، ٧٠ دولار») missed; sale price lacked the 'total' unit. Fix: negation-aware ceilings, shared multipliers, unit look-back. Effect: price 33% → 80%.

### Cycle 3 — roles (impact: right counterpart type)
Found: ad openings («للبيع سيارة…»), professions advertising themselves («سباك بالباب، جاهز ٢٤ ساعة»), first-person service verbs («بنضّف»، «بركّب»), companionship («بدي حدا يمشي معي»). Fix: 5 targeted rules + vocabulary. Effect: side 89.8% → 96.6%.

### Cycle 4 — category confusions (impact: right counterpart pool)
Found: «طاقة شمسية» pulled housing into electrical services; service verbs lost to their object («ينضّف البيت»); «معلم بلاط» read as tutoring; a clitic-stripping bug produced «اليه» (=آلية → vehicles) from «بيتي». Fix: variant priority order in `tokenVariants`, verb keywords for services, hiring-a-person penalty for real-estate/goods, repair cue ignored when a sale/rent cue exists, single-child roots resolve to the child. Effect: category 85.9% → 98.2%, deal → 98.2%.

### Cycle 5 — latency when the AI provider is down (impact: response speed, cost)
Found (measured over HTTP): with the Jev key configured but the host blocked, each ambiguous turn waited ~2.2 s for retries before falling back; the circuit breaker re-opened the penalty every minute. Fix: `src/conversation/jev-gate.ts` — conversations call Jev only after a non-blocking background probe (`GET /v1/models`) succeeded; a turn-time failure closes the gate until the next good probe. Effect: turn latency 2.13–2.22 s → 4–20 ms with Jev unreachable; status label stays honest.

### Cycle 6 — clarification dialogues (impact: fewer repeated/needless questions)
Found (61 labeled dialogues): a bare amount answering «قديش السعر؟» («٦٠٠٠») was ignored → the same question came back; a bare place answer that is also a common word («الباب») was ignored; conflict choices by a distinctive word/number («السبت», «٥٥٠٠») not recognized; «دولار بالساعة» inside an answer dropped; «بدي بيعو» answering the role question read as a request; «يجي عالبيت» inside an answer opened a false category conflict; vague roots («بدي شي نشاط») not asked about; a greeting got a formal question. Fix: answer-aware parsing for each. Effect: dialogues 77.0% → 96.7%; first-question accuracy 86.4% → 87.7%; repeated-question violations stay 0.

### Cycle 7 — conditions and time (impact: correct exclusion & ranking)
Found: «واحد» became Sunday through a synthesized «الاحد»; «اليوم» ignored outside activities; a seeker's «لعائلة» stored as a condition on the landlord; «مو بالطابق الأرضي», «مو أقل من غرفتين», «بين ٢٠٠ و٤٠٠ متر» lost their operators; «بس تكون / المهم» not read as binding; «يجي عالبيت» (home visit) and «الصف الخامس» (grade) unrecognized; verbs taken as car models. Effect: constraints 58.0% → 87.3%, time 82.2% → 95.3%, attrs 66.7% → 77.1%.

### Cycle 8 — findings of the independent review (impact: no stuck conversations, nothing invented)
Found by Role 8 (`docs/REVIEW.md`), each with a failing test first:
- after 3 unanswered questions about the category, every later turn returned HTTP 500 (MAJOR-1);
- giving up on the deal saved «بدي شقة بإعزاز» as a **purchase** the user never chose (MAJOR-2);
- giving up on the place saved a seeker's request as "anywhere" (MAJOR-3);
- «بدي بيعو» was not read as a sale, so the deal question came back three times (MAJOR-7);
- keyboard focus fell to `<body>` after a quick-answer chip, after Esc in the editor, and after «طلب تواصل» (MAJOR-4/5);
- a Jev 429 with a long `retry-after` overran the turn budget.

Fix:
- `essentialGap()` in `src/conversation/engine.ts`: the request is never saved while side, category, deal (multi-deal categories) or a seeker's place is unknown. The user is told exactly what is missing, and the next free answer is read against that field without counting as another question.
- Levantine `-و` object forms and job statements in `src/nlu/parse.ts`.
- Focus kept or restored in the UI, and stale list responses ignored.
- An abortable retry sleep in `src/ai/jev-client.ts`.

Effect: flows tests 15/18 → 18/18; dialogues 96.7% → 98.4%; a11y checks 40/43 → 43/43; the Jev budget tests went from `todo` to passing.

Corpus note: the new `transport` category got 4 training and 3 held-out examples. The 3 held-out ones (h161–h163) were written by the integrator, who also writes the parser, so they are **not** independent. Treat held-out numbers for `transport` as optimistic until an independent author adds more.

## Held-out evaluation (honest generalization)
`node scripts/corpus-report.ts --holdout` — 160 new utterances written by the product role without seeing the parser (13 places absent from training, average word overlap with the closest training sentence 0.21). Individual held-out failures are deliberately **not** printed or read.

| Field | Training (in-sample, now) | Held-out @ first commit (after cycle 3) | Held-out now (after cycle 7) |
|---|---|---|---|
| side | 96.9% | 85.6% | 85.6% |
| category | 98.4% | 78.1% | 86.3% |
| deal | 98.4% | 78.1% | 83.8% |
| places | 97.4% | 95.6% | 95.6% |
| price | 81.0% | 70.9% | 70.9% |
| constraints | 88.6% | 27.9% | 44.2% |
| attrs | 77.1% | 45.0% | 52.5% |
| time | 95.3% | 64.7% | 93.8% |
| first question = essential | 88.3% | 64.4% | 70.6% |

Reading: the rules generalize well for places, time and (partly) category/deal; conditions and roles on unseen phrasing are the weak spots (−44 pts and −11 pts vs in-sample). This is exactly where a model like Jev (choosing among options, not inventing values) should help once the network allows it — measure rules vs Jev on this held-out set before trusting either.

### Next candidates (by expected impact)
1. Enable real Jev and measure it on the held-out set (roles, categories, deals, strictness).
2. Time expressions (74.5%): «صباح السبت»، «كل تلاتاء»، dates like «١٥ الشهر».
3. Grow the training corpus from real (consented) usage via `unknown_terms` + the advisor loop; keep a fresh held-out set per release.
