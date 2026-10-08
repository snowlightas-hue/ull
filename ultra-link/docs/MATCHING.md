# Matching & background jobs

Owner: Role 6. Code: `src/matching/evaluate.ts` (semantics), `src/matching/engine.ts` (retrieval + persistence),
`src/repo/jobs.ts` (queue), `src/worker/main.ts` (worker). Contracts: `docs/CONTRACTS.md`. Product rules: `docs/PRODUCT.md` §5–6.

## 1. Semantics — `evaluatePair` is the single source of truth
SQL only pre-selects candidates; every verdict comes from the pure function `evaluatePair(reg, x, y)`.

| Rule | Behaviour |
|---|---|
| Required conditions first | Any violated required condition ⇒ `excluded` with **one** exclusion reason (first in `EXCLUSION_PRIORITY`). |
| Unknown needed info | A required condition that cannot be proven (fact missing, broader place, offer range straddling a bound) ⇒ `possible`, the fact goes to `missing`. Never `confirmed`. |
| Preferences | Only move the score (`pref_*`, `place_pref_*`, preferred price/date). They never exclude, never block confirmation. |
| `فقط بإعزاز` | Required scope: the counterpart point must lie inside (nested set). Outside ⇒ `place_out_of_scope`. |
| `مو بعفرين` | `excludePlaceIds`: a point inside ⇒ `place_excluded` (own code; a widening suggestion must never re-propose it). |
| `بالضبط` | `eq`: equality in minor units; ±1 ⇒ `price_not_exact`. |
| `حد أقصى` | `lte`: equal to the max is fine; max + 1 minor unit ⇒ `price_above_max`. `gte`/`between` are inclusive. |
| `حوالي` | `approx` is always a preference (±10 % = `price_near`). |
| Money | BigInt minor units end to end (tested beyond 2^53). Different currency or price unit (or unknown) ⇒ never compared, `currency_mismatch` / `unit_mismatch`. For a **required** price that leaves the pair at best `possible`; for a preferred price it is shown as an unknown reason but does not block confirmation (PRODUCT §6.2-4; changed after REVIEW m7). A free offer (0, «مجانًا») is within any ceiling or target (`price_within_max`). |
| Never widen | No automatic widening of place, price or date. Suggestions are text only (`suggestionsAr`). A peer without an area uses its own point as its area, never "anywhere". |
| Sides | Exchange = `seek ↔ provide` (order-independent: a seeker's condition vs the provider's facts and vice versa). Peer = `join ↔ join`, evaluated in canonical id order so `f(a,b)` and `f(b,a)` are identical objects. |
| Dates | Half-open `[from, to)`; touching windows do not overlap. Both required + no overlap ⇒ `date_no_overlap`; one flexible ⇒ minus reason. Peers need a known shared time (`date_unknown` ⇒ `possible`). |
| Categories | The offer may be the requested category or narrower; broader (`عندي عقار` vs `بدي شقة`) ⇒ `category_unknown` (possible); siblings ⇒ `category_mismatch`. |
| Multi-valued facts | `["washer","fridge"]`: `eq`/`in`/`lte`/… = has a satisfying value; `neq` = has none of the excluded value; `[]` = unknown. |
| Realm / owner / status | Synthetic never matches real; own intents never match; non-active ⇒ `inactive`. |

`PlaceSpec.geo / radiusKm / nearest` and live positions are evaluated by `proximityCheck` (src/geo/semantics.ts): hard radius,
"nearest" inside a declared default limit, unknown / approximate distance ⇒ `possible`, stale live ⇒ `possible` — see docs/GEO.md §2.
Pairs without any of them keep the soft centroid-distance signal below.

**Exclusion priority:** `side_mismatch, realm_mismatch, same_owner, inactive, deal_mismatch, category_mismatch,
place_excluded, place_out_of_scope, distance_beyond_radius, date_no_overlap, price_above_max, price_below_min, price_not_exact, attr_violation`.

**Score (integer):** confirmed ∈ [5000, 10000] = 7000 + bonus; possible ∈ [0, 4999] = 2500 − 400·(missing − 1) + bonus;
excluded = 0. Bonus: preferred place ±600, preferred attribute ±500·weight, near price +600 / far −min(1500, 20·%),
missed preferred price −900, exact +400, in-range +200, cheaper than max up to +500, preferred date +300 / −400,
centroid distance −min(1000, 8·km), freshness +300·e^(−age/14 d). Reasons carry `polarity` plus/minus/unknown/info.

## 2. Retrieval — index-only directions, complete for every non-excluded verdict
`retrieveCandidates` never scans a vertical. Every query is pinned to `(vertical, realm, counter-side, deal,
category ∈ ancestors ∪ descendants, status='active', user ≠ me)`.

- **RANGE** (I have a *required* scope S): counterpart `point_lft BETWEEN lft(s) AND rgt(s)` for each s ∈ S (B-tree range),
  plus points equal to an *ancestor* of s (a broader point can only be `possible`), plus point-less counterparts:
  probed through `intent_scopes` with my point when I have one, else a bounded newest-first sample (`NULL_POINT_SAMPLE`, 200).
  Points outside S are only *counted* (≤ 1000) for the "excluded N: outside the place" statistic.
- **PROBE** (I have a point P, and no required scope — or I am a peer): equality probes on `intent_scopes.place_id` with
  P's ancestors (≤ 4) and the places inside P when P is a region. An empty or merely preferred scope is keyed on the root,
  so every probe reaches it.
- **BROAD** (no point, no required scope): newest counterparts of the category (capped, `truncated` reported).
- **GEO** (a distance bound — radius or "nearest" — and a known point): KNN on stored / live points plus place-only
  counterparts near enough; replaces the place directions for that intent (completeness argument: docs/GEO.md §3).

Why it is complete (exchange; peers run RANGE and PROBE together): a non-excluded verdict needs the counterpart's point to
be *inside or broader than* my required scope (else `place_out_of_scope`), or unknown — exactly RANGE's three parts. With no
required scope of mine, it needs my point to be inside, broader than, or unknown to the counterpart's required scope
(else excluded), and an empty/preferred counterpart scope is keyed on the root — exactly PROBE. Every query is capped
(`CANDIDATE_LIMIT`, 5000); hitting a cap sets `truncated = true`. The brute-force integration test checks completeness
over 400 random intents (§6). Existing pairs are always re-evaluated, so stale rows are invalidated even if retrieval no
longer returns them.

## 3. Persistence & consistency
One run = one transaction (`matchIntent`, retried on deadlock/serialization failure):

1. `pg_advisory_xact_lock(vertical, intent)` — one run per intent at a time.
2. `eval_seq = nextval('match_eval_seq')` is taken **before anything is read**.
3. Load the intent; if `args.version` ≠ current version ⇒ `superseded`, nothing written.
4. Not active (paused/closed/fulfilled/expired) ⇒ every pair of this intent becomes `invalidated` with a reason
   (`الطلب موقوف مؤقتًا`, `الطلب مغلق`, `انتهت صلاحية الطلب`, `تمت تلبية الطلب`) and is *fenced*: its `eval_seq` and this
   side's version are raised even if it was already invalidated, so no older run can resurrect it.
5. Otherwise retrieve, evaluate in memory, then write in a **fixed number of batched statements** (sorted by pair key):
   `upsertPairs` (one `INSERT … SELECT unnest … ON CONFLICT DO UPDATE … WHERE`), `invalidatePairs`, `match_refs`,
   `notifications`, one `pg_notify` batch, one `match_runs` row.

Every write is guarded: `matches.eval_seq < new eval_seq AND a_version <= new AND b_version <= new`. So
**an older evaluation never overwrites a newer one**, and a newer evaluation of older intent versions is refused too.
Convergence: every version change (edit, status, expiry) is followed by a run *of that intent* whose `eval_seq` is taken
after the change committed, so the last writer always saw the latest versions.

Notifications: one per side per pair, ever — `UNIQUE(recipient_id, dedupe_key)` with `dedupe_key = match:{v}:{a}:{b}`,
inserted with `ON CONFLICT DO NOTHING`. New notes only for pairs that were absent or invalidated before; the viewer of an
interactive run is not notified. Repeats, retries, concurrent runs of both sides: no duplicates (tested).

`match_runs.exclusions[]`: `{code, count, textAr}` — `textAr` is the reason **label only** (`أعلى من حد السعر`); the UI
prefixes the count. Counterparts outside a required scope are counted under `place_out_of_scope`.

## 4. When matching runs
| Event | Interactive | Safety net |
|---|---|---|
| New intent saved | `POST /api/intents/:id/match` (stored run reused per version) | `match_intent` job (+15 s) |
| Edit (`PATCH`) | run for the new version | `match_intent` job in the same transaction as the update |
| Pause / resume / close / fulfil | run for the new version | — (see §7) |
| Expiry | `expire_sweep` job: per intent one tx (re-check under `FOR UPDATE`, flip status, enqueue job, owner notification `expired:{v}:{id}:{version}`), then the run | `match_intent` job in that tx |

A `match_intent` job carries `{verticalId, intentId, version}` and dedupe key `match:{v}:{id}:{version}`. The worker marks it
`superseded` when the intent moved to another version, and `done` without work when a run for that version is already
recorded (a run row commits together with its writes).

## 5. Job queue (`jobs` table)
- **States:** `pending → running → done | superseded | failed`; failures go back to `pending` with a later `run_at`.
- **Claim:** `FOR UPDATE SKIP LOCKED LIMIT 1` ordered by `(priority, run_at, id)`; concurrent workers never share a job.
  The claim increments `attempts` and sets a lease (`locked_until`, 60 s).
- **Lease recovery & fencing:** an expired `running` job is claimable again; `complete()`/`fail()` only touch the job while
  it is `running` under the *same* attempt number, so a late worker cannot finish or reschedule someone else's run.
- **Backoff:** `min(300 s, 2^attempts s)`; **`max_attempts`** (default 5) ⇒ `failed`, also when the worker crashes every
  time (only leases expire).
- **Dedupe:** partial unique index on `dedupe_key` while `pending`/`running`; a finished job does not block a new one.
- **Worker:** `processNext()` = claim → `runJob` → complete, or fail with backoff; `LISTEN ul_jobs` wakes it, 2 s poll
  otherwise; heartbeat every 10 s; an `expire_sweep` (deduped) is enqueued every minute and expires ≤ 2000 intents per job.

## 6. Tests (all deterministic)
- `test/unit/matching-corpus.test.ts` — all 169 labeled scenarios of `test/corpus/matching-scenarios.json` in both argument
  orders (verdict, required reason codes, exclusion code), plus symmetry and verdict invariants.
- `test/unit/matching-properties.test.ts` — seeded PRNG (`UL_PROP_SEED`, `UL_PROP_N`, default 3000 pairs) against an
  independent oracle of the required conditions; score bands; exclusion code present; exchange order independence and
  peer symmetry (deep-equal verdicts); currency/unit mismatch never confirmed; exact BigInt boundaries beyond 2^53
  (max, max+1, eq ±1, gte, between); straddling ranges ⇒ possible; multi-valued facts; preferences never exclude.
- `test/integration/matching-engine.test.ts` — guarded rows, refs and one note per side; interactive viewer not notified;
  stale job superseded with zero writes; an older transaction that commits last changes nothing; a stale run cannot
  resurrect paused pairs; pause/close/expire invalidate with reasons, resume restores, notes not repeated; `expire_sweep`;
  repeated + concurrent runs (both sides) never duplicate matches or notes; retrieval vs brute force over 400 random
  intents (and stored rows = brute-force verdicts after every intent ran); exclusion statistics; region/point-less cases.
- `test/integration/jobs-queue.test.ts` — dedupe, SKIP LOCKED, lease recovery + fencing, backoff, max_attempts (explicit and
  crash loop), superseded `match_intent`, and the worker iteration (`processNext`) success/retry/failed path.

Run: `node --test test/unit/matching-*.test.ts` and
`node --test --test-concurrency=1 test/integration/matching-*.test.ts test/integration/jobs-*.test.ts`.

**Corpus labels questioned (reported to Role 1, corpus untouched):**
- `m027` — verdict agrees (`excluded`); the label says `place_out_of_scope`, the evaluator says `place_excluded`. Afrin *is*
  inside the stated scope (ريف حلب); the explicit negation is its own condition, and `place_out_of_scope` would make the
  UI suggest widening towards a place the user excluded. Pinned in `QUESTIONED` in the corpus test.
- `m133` — agrees with the data, but the `why` says one side said "أي يوم" while the data has `when: null` (not stated).
  If "any day" is meant, `TimeWindow` has no encoding for "any time" and the product should decide whether that is
  `match` rather than `possible` (today: not stated ⇒ unknown ⇒ `possible`).

## 7. Performance — batched writes vs. the per-pair (N+1) engine
`node src/matching/perf.ts --n 20000 --sample 300` builds 20 000 synthetic active intents (skewed cities/categories, prices,
attributes, constraints, activity windows) in a throw-away database, clones it per engine, and runs `matchIntent` for the
same 300 intents twice (cold: all pairs/notes new; warm: same pairs again). Statements = client round trips incl. BEGIN/COMMIT.

Measured 2026-10-08 on this machine (PostgreSQL 16 local, seed 7, 296 distinct intents, mean 380 candidates and 263
confirmed/possible pairs per run, max 1805 candidates):

| Engine | Pass | mean ms | p50 | p95 | max | statements / run (mean · max) |
|---|---|---|---|---|---|---|
| before (row-wise) | cold | 675.0 | 450.0 | 2166 | 4078 | 1823.6 · 9651 |
| **batched (current)** | cold | **191.7** | **137.0** | **604** | **983** | **14 · 17** |
| before (row-wise) | warm | 194.6 | 140.4 | 598 | 994 | 520 · 2621 |
| **batched (current)** | warm | **42.7** | **33.4** | **126** | **223** | **12 · 15** |
| before (bc888ed verbatim) | cold / warm | 738.5 / 206.2 | 489 / 149 | 2314 / 612 | 4387 / 1137 | 1795.9 / 512 |

Cold: 3.5× faster, 130× fewer round trips; warm: 4.6× faster. The batched run's statement count does not depend on the number of
pairs (BEGIN, lock, eval_seq, load, existing pairs, retrieval = one query per scope place + ≤ 3, candidates, invalidations,
upserts, refs, notifications, pg_notify, run row, COMMIT). Both 20k results: 77 171 matches, 77 171 refs, 154 342 notifications, fingerprint `25ccbdc98b561164`.

`before (row-wise)` is the pre-batching engine (commit bc888ed: one upsert, one `match_refs` insert, two notification
inserts and per-user `pg_notify` per pair, plus a linear title lookup per notification) fed by the current retrieval;
its result fingerprint (all match rows: state, score, reasons, missing, versions; all notifications) is **identical** to the
batched engine's, so batching kept the semantics. `before (bc888ed)` is that commit verbatim; it also finds fewer pairs
(76 007 vs 77 171: its retrieval missed broader points and point-less counterparts, fixed since). To reproduce a "before"
column: `git show bc888ed:ultra-link/src/matching/engine.ts`, point its `../` imports at this checkout's `src/`, and pass
`--engine before=/abs/path/engine.ts`.

## 8. Known limits / follow-ups
- Status changes now enqueue the same safety-net `match_intent` job as edits (Role 7), in the status transaction.
- **Decision (REVIEW m1):** a pair that was invalidated and later becomes valid again is *not* notified a second time.
  It reappears in the lists live (SSE `match_update`); a second alert per pair would turn every back-and-forth edit or
  pause/resume into a notification storm. `matching-engine.test.ts` and `flows-matching.test.ts` keep this rule.
- Leaf foreign keys (migration 0006): each `matches` partition references its own `intents` partition; first-evaluation
  p50 1,972 → 744 ms in Role 5's measurement. A migration that adds a partition pair must add both leaf FKs.
- Point-less counterparts are only sampled (200) when *I* have no point either; reported through `truncated`.
- Proximity (`geo`, `radiusKm`, `nearest`, live positions): evaluated and retrieved by the GEO directions — docs/GEO.md.
