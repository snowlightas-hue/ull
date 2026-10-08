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
| dialogues fully correct | 70.5% | 73.8% | 75.4% | 77.0% | 77.0% |
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

### Next candidates (by expected impact)
1. Held-out evaluation (see methodology note) to confirm cycles 1–4 generalize.
2. Time expressions (74.5%): «صباح السبت»، «كل تلاتاء»، dates like «١٥ الشهر».
3. Enable real Jev (needs network allowlist) and measure rules vs Jev disagreement on the same corpus.
