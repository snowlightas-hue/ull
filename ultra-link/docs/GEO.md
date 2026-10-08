# Location & live tracking (V2.1)

Owner: location role. Design: `docs/FEATURES-V2.md` §1. Code: `src/geo/*` (pure: `distance.ts`, `semantics.ts`; DB: `retrieve.ts`,
`live.ts`, `nearby.ts`), `src/matching/{evaluate,engine}.ts`, `src/repo/intents.ts` (persistence), `src/server/routes/geo.ts`,
`public/js/geo/live.js`, `public/js/ui/geo.js`, `public/css/geo.css`, `migrations/0003_geo.sql`. Tests: `test/unit/geo-*.test.ts`,
`test/integration/geo-*.test.ts`.

## 1. What a user gets
- «عندي تكسي بإعزاز» + «شارك موقعي المباشر»: the offer follows the phone while the page is open (≥ 15 s or ≥ 50 m per update).
- «بدي تكسي قريب مني» / «بدي سيارة ضمن 3 كم» / «بدي سباك ضمن 5 كم»: candidates within the distance, **nearest first**,
  with a rounded distance («أقل من 1 كم», «≈ 2.5 كم») and the driver's connection state («متصل الآن», «غير متصل منذ 25 د»).
- A new ride request notifies only the **10 nearest connected** drivers, once (`dedupe_key = match:{v}:{a}:{b}`).

## 2. Semantics (pure — `proximityCheck`, called by `evaluatePair`)
**Effective point** of an intent: fresh live position (updated ≤ 10 min ago, fix ≤ 3 km) › static GPS fix (≤ 3 km) ›
centroid of the named place (± 6 km city, ± 30 km region; a point-less seeker with exactly one place uses it) › a coarse
fix › unknown. A fix better than 250 m is exact; 250 m–3 km carries its accuracy as uncertainty `u`.

**Bounds**: hard radius «ضمن 5 كم» = 5 km. «الأقرب / قريب مني» (and a preferred «حوالي 3 كم») rank by distance inside a
**declared default limit**: 10 km for transport, 50 km otherwise (or the preferred radius when larger) — shown on the card
(«الأقرب أولًا (حتى 10 كم)»), never widened automatically. A provider's radius is its service area. Each side's bound
applies; `d` = distance between effective points, `U` = sum of both uncertainties:

| Case | Verdict / reason |
|---|---|
| `d − U > B` | **excluded** `distance_beyond_radius` «أبعد من 5 كم (≈ 7 كم)» (after `place_out_of_scope` in the priority) |
| `d + U ≤ B` (exactly at B is inside) | ok; hard radius adds `distance_within_radius` |
| otherwise (only approximate points straddle B) | **possible** `distance_uncertain` «… الموقع تقريبي (حسب مركز إعزاز)», missing `distance` |
| no point on a side | **possible** `distance_unknown`, missing `distance` — never confirmed |
| live row older than 10 min | **possible** `live_stale` «غير متصل منذ 25 د», missing `live`; its point falls back to GPS/centroid |
| fresh live row | `live_now` «متصل الآن — موقع مباشر», +300 |

Ranking with a bound: `+round(1500 / (1 + d))` (0.5 km → +1000, 2 km → +500, 10 km → +136); preferred radius ±400.
Pairs without any geo/live/radius/nearest keep the legacy centroid signal unchanged (Role 6's corpus and properties pass
untouched). Exchange stays order-independent and peers symmetric (property test over 3000 random geo pairs, with an
independent oracle for the distance condition).

## 3. Retrieval (`retrieveNearby`, used when the intent has a bound and an effective point)
Every counterpart the evaluator can accept satisfies `d − (u_me + u_other) ≤ B`. Precise counterparts have `u_other ≤ 6`,
so four bounded, index-only directions are complete:

| Direction | Index | Finds |
|---|---|---|
| `geo` | GiST `ll_to_earth(geo_lat, geo_lng)` WHERE active | stored points within `B + u_me + 6 km` (+0.3 % for earthdistance's larger sphere), nearest first, K = 100 |
| `live` | GiST on `live_positions` | connected positions, same box, nearest first, K = 100 |
| `near` | `intents_point_coarse_idx` (active, no precise point) | place-only counterparts at places whose centroid − margin ≤ B, plus places without coordinates |
| `pointless` | same | counterparts without any place point (unknown distance) |

They **replace** RANGE/PROBE for bounded intents: inside a bound the place directions add nothing, and their «anywhere»
scopes are keyed on the root place, so they fan out over every GPS driver of the category (measured below). Hitting K sets
`truncated` (the nearest K are always included). Tested: KNN = brute force over ~500 random points (filters, radius,
order); bounded retrieval ⊇ every non-excluded verdict over 360 random geo/place/live/unknown intents (mutations of the
`near` direction or the 6 km slack are caught).

## 4. Data (migration 0003)
`intents`: `geo_lat/geo_lng` (both or neither), `geo_accuracy_m`, `geo_source` gps|live|place, `geo_at`, `radius_km`
numeric(6,2) ∈ (0, 500] with `radius_strength`, `nearest` (CHECKs `intents_geo_chk`, `intents_radius_chk`). Partitions
**`intents_transport` / `matches_transport` (vertical 8)**; the migration stops with a clear message if vertical-8 rows already
sit in `intents_other`/`matches_other`. `live_positions`: one row per sharing intent (PK = intent, FK cascade, matching keys
copied), `expires_at = updated_at + 10 min`, GiST + expiry + user indexes. `cube` is trusted and created by the
migration; **`earthdistance` is not a trusted extension** (measured: "must be superuser") — `scripts/db.sh provision`
installs it in `ultralink`, `ultralink_test`, `ultralink_template`; elsewhere 0003 fails with the remedy and rolls back.

## 5. API (`src/server/routes/geo.ts`, Fastify plugin `geo`)
| Method | Path | Notes |
|---|---|---|
| POST | `/api/intents/:id/live` `{lat,lng,accuracyM,heading?,speedKmh?}` | owner only (else 404); provide/join (else 422 `live_not_allowed`); active (else 409); fix ≤ 3 km (else 422); ≥ 10 s apart per intent, enforced in SQL (else 429 + Retry-After); bucket `geo_live` 30/min/session. One upsert: **no version bump, no re-match**. Echoes no coordinates. |
| DELETE | `/api/intents/:id/live` (alias POST `…/live/stop`) | stop sharing → `{ok, stopped}`; pause/close/fulfil also deletes the row |
| GET | `/api/intents/:id/nearby?limit=1..50` | owner only; on demand with fresh live positions; `{items:[{intent: IntentCard, distance:{ar,km,lt1,approximate}, live, freshnessAr, verdict, score, reasons, matchId}], limitAr, from, truncated}`; 422 `no_location` |

`IntentCard` gains `live: {sharing, fresh, labelAr} | null` and `precise`; a precise intent's `placeAr` is only «قرب إعزاز».

## 6. Client and the web-only limit
`createLiveSharing({ api, intentId, onStatus })` (`public/js/geo/live.js`): `navigator.geolocation.watchPosition` (the browser
asks for consent), sends ≥ 15 s or ≥ 50 m (never under 10 s), re-sends every 60 s when stationary, skips fixes > 3 km,
retries 429/network, stops on 404/409/422 or permission denial, **auto-stops after 2 h**, best-effort stop on `pagehide`.
**A web page can only follow the position while it is open**; with the screen off or the tab hidden, browsers throttle or stop
updates — the UI says so («المشاركة المباشرة تعمل فقط ما دامت هذه الصفحة مفتوحة…»). Background tracking needs a native
app (later). The server turns a silent driver into «غير متصل» after 10 min, so nobody is shown a stale position as live.
`public/js/ui/geo.js`: toggle + status line for offers, connection chips, «الأقرب أولًا · ≈ ٢٫٥ كم» chip on match cards.

## 7. Privacy model
- Exact coordinates are stored for matching and returned **only to their owner** (`GET/PATCH /api/intents/:id` spec).
  Cards, matches, notifications and `/nearby` carry a coarse place («قرب إعزاز»), a **rounded** distance and a connection
  label — never coordinates (integration test scans every response the other side sees, including after a live ping).
- Rounding (`roundDistance`): < 1 km → «أقل من 1 كم»; 0.5 km steps to 10 km; 1 km to 50 km; 5 km beyond. This limits
  trilateration but does not eliminate it: an attacker with several accounts/requests can narrow a driver to roughly
  0.5–1 km. Mitigations in place: owner-only nearby, rate limits, synthetic/real separation; no exact position before
  consent (sharing after acceptance is V2.2's «الربط»).
- Live sharing is opt-in per offer, ends on stop/pause/close, after 2 h on the client, and goes stale after 10 min.
  `purgeStaleLive()` deletes rows silent for 24 h (to be called from the worker's minute tick — not wired yet).

## 8. Measured vs projected
Measured 2026-10-08 on this machine (PostgreSQL 16 local), `UL_GEO_PERF=1 node --test test/integration/geo-perf.test.ts`: 100 000 GPS drivers in 6
clusters (σ ≈ 6 km), 5 000 connected, 30 ride requests (dense: ~30 000 drivers around إعزاز).

| Operation | p50 ms | p95 ms |
|---|---|---|
| KNN nearest 10 (stored points, 16 km box) | 1.6 | 2.5 |
| KNN nearest 200 | 3.9 | 6.2 |
| KNN nearest 10 within 5 km | 1.6 | 2.5 |
| KNN nearest 10 live positions | 1.1 | 1.9 |
| full `matchIntent`, ride request, K = 100 (≈ 195 candidates; cold / warm) | 143 / 28 | 170 / 38 |
| same with K = 50 / K = 200 (cold, earlier runs) | 77 / 253 | 102 / 313 |
| `/nearby` (limit 10) | 11 | 16 |
| same request **without** a distance condition (classic PROBE: 5 000 candidates, truncated) | 2 879 | 2 969 |

The cold cost is dominated by writing the K pairs (≈ 0.7 ms per pair, as in MATCHING.md §7); K is `UL_GEO_K`. Projected,
not measured: city-scale live fleets beyond one table → shard `live_positions` by geohash/H3 cell (plan only).

## 9. Known limits / follow-ups
- Stored matches keep the distance of the moment they were computed (pings never re-match); `/nearby` is the live view.
- «بدي تكسي» with GPS but without «قريب/ضمن» has no bound and uses place retrieval; buildSpec could set `nearest` for
  `transport.ride` requests (integrator's file) so the default limit is declared on the summary.
- Seeded «online» demo drivers are fresh for 10 min after `db:seed`, then «غير متصل» (no simulator pings them).
- The web demo (`web-demo/local-api.ts`) does not copy the new geo columns into its rows yet.
