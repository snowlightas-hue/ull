# Ultra Link corpus: label conventions

Owner: Role 1 (Product & Business). The labels are ground truth written by a human-style annotator from the
**meaning of the words**. They were not tuned to the rule parser, the Jev resolver or the matcher. When a component
disagrees with a label, either the component is wrong or the label is. Settle it in review; never quietly edit a label
so that a test passes.

| File | Items | What it tests |
|---|---|---|
| `utterances.json` | 383 | single-utterance understanding + which essential question(s) must follow |
| `dialogues.json` | 61 (156 turns) | multi-turn clarification: the ask sequence, merging, conflicts, corrections, unsure answers |
| `matching-scenarios.json` | 169 | pair verdicts (`match` / `possible` / `excluded`) and the reason codes that must appear |

Shape check: `node --test test/unit/corpus-shape.test.ts`. It checks ids, the codes against `src/seed/taxonomy.ts`,
the money strings, `lo<=hi` (compared as BigInt), the mustAsk order and its consistency with the other labels, the
dialogue protocol, the reason-code vocabulary and the minimum counts and coverage. It does **not** run any parser or
matcher.

The policy behind `mustAsk`, `expectAsk` and the verdicts is in `docs/PRODUCT.md` (§5 and §6). This file covers
only how the labels are written.

## 1. General rules

- Labels use only codes from `src/seed/taxonomy.ts`: category, deal, place and attribute keys and enum codes.
- **`null` means the speaker did not say it.** The annotator never guesses. The few labels that come from a
  definition and not from a cue are listed below and tagged (`deal_implicit`, `unit_implicit`, `world_knowledge`).
- Money is integer **minor units as a decimal string**: 200 USD → `"20000"`, 1.5 USD → `"150"`,
  1,500 TRY → `"150000"`, 1,500,000 SYP → `"150000000"`. Every currency we support has 100 minor units.
- Free text such as Arabic place names that are not in the taxonomy (عين دارة، البحر) is **not** labeled. Those items
  carry `unmapped_place` / `unmapped_attr` / `taxonomy_gap`, and the words go to the schema advisor.

## 2. `utterances.json`

```json
{"id":"u003","text":"…","tags":["real_estate","seeker",…],
 "expected":{"side","category","deal","places","price","when","attrs","constraints","mustAsk"}}
```

### side
- `seek`: بدي / بدنا / عم دوّر / مين عنده / مطلوب / أبحث عن / بحتاج.
- `provide`: عندي … للبيع/للإيجار, بأجّر, بصلّح, بعطي دروس, أنا كهربجي, a header-first ad (`للبيع …`, `للإيجار …`,
  `معروض للبيع`, `بيع سيارة …`), and **بدي + بيع/أجّر/علّم** ("بدي بيع سيارتي" is an offer; tag `bdi_provide`).
- "عندي" is not always `provide`: "عندي براد خربان بدي حدا يصلحو" is a seeker of a repair (`indi_seek`).
- `join`: every activity (`activities.*`). An organizer ("عم نظّم رحلة") is also `join`.
- A noun-first phrase with no verb ("شقة للإيجار بإعزاز", "كهربجي سيارات بإعزاز") is labeled `side: null`, because
  it reads as a search query as easily as an ad (`ambiguous_side`).

### category
- The deepest code the words support. A root code (`real_estate`, `vehicles`, `services`, …) is used when only the
  vertical is clear ("عندي عقار", "بدي حدا يصلحلي شي"). These items carry `broad_category`.
- Keyword collisions are settled by meaning and by the taxonomy `descriptionAr`, never by the first keyword hit
  (`keyword_collision`). Examples: "غرفة نوم" = `goods.furniture`; "بدي حدا يصلح البوتوغاز" = appliance repair, not
  goods; "بلياردو" = `activities.sports`; "كورس انكليزي" = `education.tutoring` (a language lesson by description).
- Help versus a paid service: "ما معي مصاري" / volunteering / فزعة → `help.general` (`help_vs_service`, `help_vs_lesson`).

### deal
- Categories with a single deal always carry it (services → `service`, rooms → `rent`, goods → `sale`, …).
- Cues: للإيجار/استأجر/أجّر/ضمان (land lease) → `rent`; للبيع/اشتري/بيع/للشراء → `sale`. A price period
  ("بـ ١٥٠ دولار **بالشهر**") or a duration of stay ("لمدة ست شهور") also marks `rent` (`deal_implicit`).
- The deal is **never inferred from the size of an amount**. "بدي شقة بإعزاز بـ ٣٠ ألف دولار" keeps `deal: null`
  and must ask (`deal_inferable_from_price`). The amount may only order the answer chips.
- An offer of both ("للبيع أو للإيجار") → `deal: null` (`multi_deal`). One intent has one deal.

### places
- Every place mention in order of speech: `{code, strength, negated}`.
- `strength`: `required` for فقط / بس / حصرًا / لازم; `preferred` for يفضّل / ياريت / إذا بيصير / بفضّل; otherwise
  `null`, meaning no cue and the product default applies.
- `negated: true` for "مو بعفرين". A negated mention alone does not satisfy the place question.
- For a provider the mention is where the item or work is. For a mover or a technician several mentions describe
  the service area.
- "حلب" = the city `sy.aleppo.aleppo`. "ريف حلب / الريف الشمالي" = the region `sy.aleppo`. "دمشق" = `sy.damascus`.
- "الشام" is labeled `sy.damascus` (Levantine usage), although the taxonomy alias maps it to `sy`. Tag `taxonomy_gap`.
- "وين ما كان / أي مكان" → `world`. "أونلاين / عن بعد" for lessons, help or study groups → `online`. "أونلاين" as a
  purpose ("تابلت للدراسة أونلاين") is **not** a place (`trap_online`).

### price
- `op`: بالضبط/تمامًا → `eq`; حد أقصى/أقصى شي/ما بدي أكتر من/لحد/ما يتعدى/ميزانيتي → `lte`;
  على الأقل/مو أقل من/ما بأجرها بأقل من → `gte`; بين X و Y → `between`; حوالي/تقريبًا/بحدود → `approx` (with lo = hi = X).
- A **provider's** amount is the asking price: `eq` with lo = hi.
- A **seeker's** bare amount ("بدي سيارة بـ ٣٠٠٠") is a budget ceiling: `lte`, tagged `price_op_implicit` so that
  evaluators can score the op leniently on these items.
- Currency: `$`/دولار → USD; ليرة تركية/تركي/بالتركي/TL → TRY; ليرة سورية/سوري → SYP; يورو → EUR.
  **"ليرة" alone → `null`** (TRY or SYP; `currency_ambiguous_lira`). Size never decides the currency.
- Unit: بالشهر/شهري → month; بالسنة → year; بالأسبوع → week; باليوم/الليلة → day; بالساعة → hour;
  للحصة/الحصة → session; الشخص/عالراس → person. A **sale** amount is always `total`. For other deals with no
  period stated (a plumber's call-out fee, a price per m²), the unit is `null` and is not asked.
- Free lessons ("ببلاش / مجاناً") → `eq "0"` with currency and unit `null`. Help is unpaid by definition, so its
  price is `null`. A currency named without an amount → `price: null`.

### when
`{"weekday":"sat|sun|mon|tue|wed|thu|fri"}` or `{"relative":"today|tomorrow|next_week"}`. الليلة/اليوم → today;
بكرا → tomorrow; الجمعة الجاية / كل جمعة → `fri`; الأسبوع الجاي → next_week. Times of day (العصر، الصبح) are not labeled.

### attrs and constraints
- `attrs` are facts about the **speaker's own** item or self. Example: a landlord's "تلات غرف"; a seeker's
  "نحنا عيلة" → `tenant_type: family`; "لمدة سنة" → `rental_months: 12`.
- `constraints` are conditions on the **counterpart**. Example: a seeker's "مفروشة"; a landlord's "للعائلات فقط" →
  `tenant_type in [family]`.
- With `side: null`, any description goes in `attrs`. The assistant moves it to constraints if the user turns out
  to be a seeker.
- A constraint's `strength` is `required` / `preferred` only with an explicit cue (as for places, plus "المهم يكون"
  → required). Otherwise it is `null`; the product defaults are in PRODUCT.md §6.
- Units: دونم = 1000 m² (`unit_conversion`); ground floor = 0; "تلات غرف وصالون" → rooms = 3 (bedrooms);
  "مو أرضي" → `floor neq 0`. Enum attributes hold one value, so the corpus avoids providers who list several.

### mustAsk
The essential missing fields, in the fixed question order
`side, category, deal, place, when, price, price.currency, price.unit` (PRODUCT.md §5). A field appears only when it
can be decided from the labels. For example, `deal` is not listed while the category is unknown, and `price.unit` is
not listed while the deal is unknown. A non-request has `[]`.

### Special items
- `non_request` (greetings, thanks, meta questions, the dollar rate): every field is null and `mustAsk: []`.
- `multi_intent`: **the first-mentioned intent** is labeled. The assistant should offer the second after saving.
- `fragment` ("إعزاز" alone): only the place is labeled.

### Tags
Auto-derived tags:
- vertical (`real_estate`…`help`) and `seeker` / `provider` / `joiner` / `side_unknown`
- `dialect` (the default) or `msa` / `non_levantine`
- `price_<op>`, `currency_<code|missing>`, `unit_<unit|missing>`
- `strict_place`, `preferred_place`, `negated_place`, `multi_place`, `region_place`, `online`, `when`
- `strict_attr`, `preferred_attr`, `has_attrs`, `has_constraints`
- `asks_<field>`, `complete`
- `arabic_digits`, `latin_digits`

Hand-written tags describe the difficulty: `typo`, `short`, `long`, `number_words`, `mixed_script`,
`ambiguous_*`, `keyword_collision`, `bdi_provide`, `indi_seek`, `header_offer`, `distractor_number`,
`distractor_place`, `trap_*`, `vague`, `vague_price`, `unmapped_*`, `taxonomy_gap`, `world_knowledge`, and others.

## 3. `dialogues.json`

```json
{"id":"d018","turns":[{"user":"…","expectAsk":"price.currency"},…,{"user":"…","expectAsk":null}],
 "final":{…same shape as expected, mustAsk: []…},"acceptedUnknown":["price"],"tags":[…]}
```
- `expectAsk` is the **single** thing the assistant asks after that user turn. It is one of `side`, `category`,
  `deal`, `place`, `when`, `price`, `price.currency`, `price.unit`, or `conflict`. `null` means nothing to ask: the
  intent is saved, or the turn was not a request (a greeting).
- A field is never asked twice in one dialogue. A `conflict` question is about one field only, and after the user
  picks a value that field counts as answered.
- An answer may carry extra information. Merge it and skip the questions it answered (`extra_info_merge`).
- Correction ("لا قصدي عفرين", "لا عفواً ٤٥٠٠", "بدي محل مو شقة") replaces the earlier value silently. A different
  value with **no** correction cue ("الشقة بعفرين" after "بإعزاز") triggers a `conflict` question. "كمان / أو"
  adds a place instead of conflicting with it.
- "ما بعرف" for a non-structural field (price, when) is accepted once. The field stays `null`, appears in
  `acceptedUnknown` and is never asked again. "أي مكان / وين ما كان" is an answer: `world`.
- `final` is the intent as saved. `final.mustAsk` is always `[]`.

## 4. `matching-scenarios.json`

```json
{"id":"m001","a":IntentSpec,"b":IntentSpec,
 "expected":{"verdict":"match|possible|excluded","mustIncludeReasonCodes":[…],"exclusionCode":"…"|null},
 "why":"…","tags":[…]}
```
- `a` and `b` follow `IntentSpec` in `src/domain/types.ts` exactly, with numeric place ids from the taxonomy.
  Negated places use `place.excludePlaceIds`.
- **The verdict must not depend on order**: evaluating (b, a) gives the same verdict. Place is checked both ways:
  each side's `pointPlaceId` must lie in the other side's scope when that scope is set.
- `mustIncludeReasonCodes` is a **subset**: these codes must be present, and others may appear too.
- Every `excluded` scenario has **exactly one** hard violation, so `exclusionCode` does not depend on the order in
  which the matcher runs its checks.
- Gte satisfied → `price_in_range` (a half-open range). Lte satisfied → `price_within_max`. A violated preferred
  maximum still matches, with `price_above_max` as a minus reason.
- Time windows use `+03:00` and are half-open: `[Fri 00:00, Sat 00:00)` and `[Sat 00:00, Sun 00:00)` do **not**
  overlap. 2026-10-09 is a Friday.
- Precision traps (`precision_bigint`) use amounts above 2^53. Compare them as BigInt, never as a JS number.

## 5. Scoring suggestions (for evaluators)
- Utterances: exact match per field. For places, compare the set of `(code, negated)` and the strength separately.
  For price, compare op, lo, hi, currency and unit separately; the op on `price_op_implicit` items may be scored
  leniently. For `mustAsk`, compare the first element (the next question) and the full set.
- Dialogues: compare the `expectAsk` sequence exactly and `final` field by field.
- Scenarios: compare the verdict exactly, then check that each required code is included and that `exclusionCode`
  equals `PairVerdict.exclusion.code`.

## 6. Editing
The JSON files are the source of truth. Append new items with the next id and never renumber. Add a `tags` entry
explaining what makes the item hard. Run the shape test before committing.
