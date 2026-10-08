# Ultra Link — Stores, catalog & photos (V2.3)

> **ملخص:** صاحب المحل يضع محله كله: متجر (اسم، مكان، وصف، تفضيلات التواصل) وقائمة منتجات بأسعارها وصورها. **كل منتج
> عرض عادي** (نية `provide` بيع/إيجار) مربوط بالمتجر عبر جدول ربط خاص، فيستفيد من محرك المطابقة كما هو دون أي تعديل.
> الإضافة الجماعية: لصق أسطر ← معاينة لكل سطر (الصنف، السعر، العملة، الصفات، المشاكل) ← تصحيح/إلغاء ← تأكيد في معاملة
> واحدة، مع مفتاح `importId` يجعل إعادة التأكيد بلا أثر. الصور: حتى ٦ لكل منتج، ≤ ٥ ميغابايت، JPEG/PNG/WebP بحسب
> **البايتات الأولى** لا الامتداد، وتُزال كل بيانات EXIF/GPS/XMP قبل الحفظ، وتُخزَّن بعنوان المحتوى (sha256).
> كل رقم أداء هنا **مُقاس** مع الأمر الذي أنتجه، وما ليس مقاسًا معلَّم **PROJECTED**.

Owner: catalog role (V2.3). Design: `docs/FEATURES-V2.md` §2. Contracts: `docs/CONTRACTS.md` «Stores & catalog».
Code: `migrations/0005_catalog.sql`, `src/catalog/*` (repo, service, import glue, media intake, media store, match-card
decorator), `src/server/routes/catalog.ts`, `src/seed/stores-demo.ts`, `public/js/ui/store.js`, `public/css/store.css`.

## 1. Model

| Table | Row | Key points |
|---|---|---|
| `stores` | one provider profile | `owner_id`, `realm` (**copied from the owner by a trigger**, never from the client), `name_ar` 2–80, `description_ar` ≤ 500, `place_id` (registry place, not the root), `contact_pref` `chat`/`chat_then_phone`, `hours_ar`, `status` `active`/`paused`, `version`, `next_position`. ≤ 5 per owner (advisory lock per owner + count). |
| `store_items` | "intent X is product N of store S" | PK `(vertical_id, intent_id)` → an intent is in at most one store; `UNIQUE (store_id, position) INCLUDE (vertical_id, intent_id)` = the keyset index of the product list; `name_ar` / `name_norm` (duplicate check, index `(store_id, name_norm)`); `paused_by_store`; `import_id`. FK to `intents` with cascade. A trigger enforces **intent.user = store.owner, intent.realm = store.realm, intent.side = 'provide'**. |
| `catalog_imports` | one confirmed import | PK `(store_id, import_id)`, `request_hash` (sha256 of the canonical request), `result` (created ids). |
| `media_blobs` | one distinct cleaned image | PK `sha256` (of the bytes **after** metadata removal), `mime`, `bytes` ≤ 5 MB, `width`, `height`, `last_used_at`. |
| `store_item_photos` | photo slot 1..6 of a product | `UNIQUE (vertical_id, intent_id, slot)` (≤ 6 by construction), `UNIQUE (vertical_id, intent_id, sha256)` (same picture twice = one photo), cascade with the product link. |

**Why a link table and not a column on `intents`:** products stay ordinary intents, so `createIntent`, `updateIntent`,
`setIntentStatus`, the scope keys, versions, `eval_seq` fencing, invalidation, notifications and expiry apply to them
unchanged, and the matching engine never needs to know that stores exist. No column was added to `intents`.

**Product = intent:** `side='provide'`, `deal` sale | rent (categories whose deals include one of them), point = the
store's place, `price {op:'eq', lo=hi, currency, unit ('total' for a sale; a period for a rent), strength:'required'}`,
attributes from the parser (e.g. `condition: used`), title = the product name (+ « (تجريبي)» when synthetic),
`source_text` = the pasted line (owner-only, as for every intent).

**Status:** pausing a store pauses every **active** product through `setIntentStatus` (new version → re-match → their
matches are invalidated with «الطلب موقوف مؤقتًا») and marks them `paused_by_store`; resuming resumes exactly those, so a
product the owner paused by hand stays paused. While the store is paused a product cannot be resumed (409
`store_paused`) and new imports are created paused. **Delete** = `close` the intent (matches invalidated) + remove the
link (its photos go with it; the closed offer stays in the owner's history like any closed offer). Moving the store to
another place updates every product's point (`updateIntent`, new versions, re-match).

**Limits:** 5 stores per user · 1,000 products per store (non-closed; checked under the store row lock) · 200 lines per
import · 6 photos per product · 5 MB per photo · 50 MP / 16,384 px per side.

## 2. Isolation and realms
Every store/product/import/photo route is owner-scoped in SQL (`s.owner_id = $user`); anything else is **404** (never
"forbidden": ids reveal nothing), and **401** when logged out — tested route by route
(`catalog-api.test.ts` «isolation»). A store's realm is its owner's (trigger), its products are created in that realm,
and the engine's realm rule keeps synthetic products away from real users — tested both ways (a real seeker never gets
the synthetic product, a synthetic seeker does) plus the DB trigger refusing a foreign intent as a store item.

## 3. Bulk import
1. **Preview** (`POST …/import/preview`, saves nothing): the text is split into non-empty lines (bullets and «1-» /
   «2)» numbering removed, ≤ 200 lines). Each line goes through the **existing** understanding path — `applyTurn` on an
   empty draft (which runs `parseUtterance`) and `buildSpec` for the attributes — with the provider side and the store's
   place fixed. One adaptation for shop lists: « - » between name and price is turned into «، » before parsing, because
   the parser reads «12 - 300» as a range. Places mentioned in a line are ignored (warning `place_ignored` when the place
   is unrelated to the store's), a request-like line («بدي…») gets a warning.
2. Per line the preview returns name (the line without its price), category, deal, price (minor units + typed amount),
   currency, unit, attribute chips, **problems** (blocking) and **warnings**, and the `item` to send back:

   | Problem | When |
   |---|---|
   | `unknown_category` | no catalogue category recognised (e.g. «كيلو بندورة») |
   | `not_a_product` | a service/activity category («تصليح موبايلات») |
   | `missing_price` / `bad_amount` | no amount / an amount that is not digits with ≤ 2 decimals |
   | `missing_currency` / `ambiguous_lira` | no currency / «ليرة» alone (Turkish or Syrian? — asked, never guessed) |
   | `missing_deal` / `missing_unit` | a car or a flat can be sold or rented / a rent without a period |
   | `duplicate_existing` / `duplicate_in_batch` | same normalised name as a product of the store / an earlier line |
   | `line_too_long`, `bad_condition`, `invalid` | > 200 chars / condition on a category without it / `validateSpec` refused |

   Warnings: `category_uncertain` (e.g. «براد سامسونج»: appliance or electronics?), `currency_defaulted`,
   `deal_defaulted` (only with an owner-chosen default), `place_ignored`, `looks_like_request`, `name_from_category`,
   `price_range`.
3. The owner fixes lines with **typed fields** (name, category, deal, amount, currency, unit, condition) or unchecks them.
4. **Confirm** (`POST …/import/confirm`): every line is parsed **again on the server** (the client's preview is never
   trusted), corrections are applied, the spec must pass `validateSpec`, duplicates are re-checked under the store row
   lock. Any problem refuses the **whole** import with 422 `import_invalid` + per-line problems — nothing is half-saved.
   Then ONE transaction: `INSERT catalog_imports` (idempotency), cap check, `createIntent` per line, one batched
   `INSERT … SELECT unnest(…)` into `store_items`, `next_position` advanced, one `match_intent` job per product (dedupe
   key `match:<v>:<id>:<version>`, as the core routes). After commit the products are matched inline (trigger
   `interactive`: the seekers are notified, the owner — who is looking at the result — is not spammed).
5. **Idempotency:** `importId` is generated by the client per preview. A retried confirm with the same id and the same
   request returns the first result (`replay: true`, same ids, nothing created) — also when two confirms race
   (`INSERT … ON CONFLICT DO NOTHING` on the PK serialises them). The same id with a different list is 409.

Money is BigInt minor units end to end: the parser's amounts, `amountToMinor` for typed corrections («١٢٥٫٥» →
`12550`), decimal strings in JSON (tested beyond 2^53).

## 4. Photos
### 4.1 Intake (`src/catalog/media.ts`, zero dependencies)
The **type comes from the magic bytes** (`FF D8 FF` JPEG, `89 50 4E 47 0D 0A 1A 0A` PNG, `RIFF….WEBP` WebP); the file
name, extension and `Content-Type` are never trusted (a PNG sent as `image/jpeg` is stored as PNG; a text file named
`photo.jpg` is 415). The container is then walked and rebuilt from a **whitelist**:

| Format | Kept | Removed |
|---|---|---|
| JPEG (segments) | SOI/EOI, DQT, DHT, SOFn, SOS + entropy data, DRI, DNL, ICC profile (APP2), Adobe APP14, JFIF header **without its thumbnail** | EXIF APP1 (GPS, camera, serials, embedded thumbnail), XMP, IPTC/Photoshop APP13, MPF (secondary images), every other APPn, comments, JPGn, bytes after EOI |
| PNG (chunks) | IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, iCCP, sBIT, bKGD, pHYs, APNG acTL/fcTL/fdAT, cICP/mDCv/cLLi | eXIf, tEXt, zTXt, iTXt (XMP), tIME, any private/unknown chunk, bytes after IEND |
| WebP (RIFF) | VP8, VP8L, VP8X (EXIF/XMP flags cleared), ALPH, ANIM, ANMF, ICCP | EXIF, XMP, unknown chunks, bytes after the RIFF size |

One deliberate exception: a JPEG's EXIF **Orientation** (2..8) is re-emitted as a fresh 32-byte EXIF block holding that
single tag, so phone photos are not displayed sideways; no other tag survives (test: the output's only APP1 has one IFD0
entry, 0x0112, and no GPSInfo pointer). Dimensions are read from the headers and capped (50 MP, 16,384 px per side) —
a decompression bomb is refused before any browser tries to decode it. The output is structurally re-validated
(cleaning a cleaned file is a no-op). There is **no decoder**: pixel data is copied verbatim and malformed scan data
is not detected (browsers render what they can).

**Thumbnails: skipped.** Making them needs an image decoder/encoder (a dependency or a large amount of code); the UI
shows the original with CSS `object-fit: cover`, `loading="lazy"` and its real `width`/`height` (no layout shift).

### 4.2 Storage (`src/catalog/media-store.ts`)
`<UL_MEDIA_DIR or var/media>/<aa>/<bb>/<sha256 hex>` — git-ignored (`ultra-link/var/`). The address is the sha256 of
the **cleaned** bytes, so the same picture uploaded for two products (or by two owners) is one file and one
`media_blobs` row (tested). Write order: blob row (upsert, touches `last_used_at`) → file (temp name + atomic rename;
skipped when an identical file exists) → photo row under the product's row lock. A crash leaves at most an unreferenced
blob that the collector removes.

### 4.3 Serving
`GET /api/photos/:id` streams the file with `Content-Type` from the sniffed type, `Content-Length`,
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Cross-Origin-Resource-Policy: same-origin`, and the
app's `Cache-Control: no-store` (privacy before caching; a private max-age is a possible later optimisation). The app CSP
already allows `img-src 'self'`. Nothing about files (names, bytes, EXIF) is logged; the request log has method, path
and status only (tested by grepping the captured log).

### 4.4 Visibility rule (one function: `photoForViewer`)
* the product's **owner** always;
* anyone else only while **the product is active, its store is active, and the viewer holds a live (confirmed or
  possible) match with that product** — i.e. exactly when the product is on one of the viewer's match cards;
* everything else (stranger, invalidated match, paused store, deleted product, unknown id) → **404**.
When V2.4 adds shared store/product links, "reachable through a link the viewer opened" is added in this one function.

### 4.5 Garbage collection
`gcMedia(pool, mediaStore, olderThanMs = 1 h)` deletes blobs that no photo references and nobody used for an hour
(`FOR UPDATE SKIP LOCKED`, batches of 500), then their files. The grace period protects an upload that has written its
blob but not yet its photo row. **Not scheduled yet** — integration step: a periodic worker job (e.g. hourly).

## 5. Results grouped by store
`attachStoreInfo(pool, reg, viewerId, cards)` (`src/catalog/match-cards.ts`) adds to every MatchCard whose counterpart
is a store product `store = { id, nameAr, labelAr, synthetic, placeAr, requestMatches, groupLabelAr }` —
`requestMatches` is the exact number of live matches between **this** request and that store's products (not limited
to the page) and `groupLabelAr` the ready label «3 منتجات من متجر أبو أحمد للموبايلات (تجريبي)» — plus
`other.photos` while the match is live, and `mineStore` when the viewer's own side is a product. Three queries per page
(named statements), measured below. The UI helpers `groupMatchesByStore(items)`, `storeGroupLabel(store)`,
`storeBadge(card)` and `matchPhotos(card)` in `public/js/ui/store.js` are ready for the list.

## 6. UI («عروضي» → «متجري»)
`createStoreUi({ api, toast, onExit, onChange })` renders inside the «عروضي» panel: an entry card («متجري»: store name
and product count) → store home (profile card with «تجريبي» tag, status, place, hours, exact counts; actions: إضافة
منتجات / تعديل المتجر / إيقاف المتجر مؤقتًا ↔ استئناف المتجر / متجر جديد) → product list in catalog order with keyset
pages and exact range («١–٢٠ من ٢٥»), status filter, inline price edit (amount + currency [+ unit for rent], Esc
cancels, 409 refreshes), pause/resume, two-step delete, photo strip with upload progress (XMLHttpRequest progress,
`role=progressbar`), client-side size/type pre-checks and the server's message on 413/415. Import screen: textarea with a
live line counter, optional default currency, «معاينة» → summary + one card per line (checkbox, name, category select
ordered by the parser's alternatives, amount, currency, deal/unit when needed, problems in red, warnings) → «حفظ N
منتجات»; a 422 marks the still-broken lines and focuses the first one.
Rules followed: DOM only via `h()`/`s()` (no `innerHTML`), camelCase handlers, the only inline style is the progress
custom property set through the CSSOM, RTL with logical properties, Arabic-Indic digits, focus kept/restored by
`data-key` across re-renders (SSE refreshes coalesce and skip identical renders), the screen heading takes focus on
open, ≥ 44 px targets inside the store screens, reduced motion disables the only transition. E2E:
`node test/e2e/catalog.spec.ts` (3 viewports, screenshots in `test/e2e/artifacts/catalog/`).

## 7. Scale
All numbers below are **MEASURED** on this machine (4 cores, the project's local PostgreSQL 16, isolated
`ultralink_t_*` databases, never the app DB) unless the row says **PROJECTED**.

### 7.1 Commands
```
node --test --test-concurrency=1 test/integration/catalog-paging.test.ts            # 120 / 1,000 products, HTTP
UL_CATALOG_SCALE=1 node --test --test-concurrency=1 test/integration/catalog-scale.test.ts
UL_CATALOG_SCALE=1 UL_CATALOG_STORES=200 node --test --test-concurrency=1 test/integration/catalog-scale.test.ts
```
The scale test bulk-loads `STORES × 1,000` real products (ordinary provide intents + refs + scope keys + `store_items`,
spread over all 36 cities of the registry) and 500 electronics seekers in إعزاز, then times the catalog's queries (p50/p95 of 30 runs
after 3 warm-ups) through the real repo functions, one 200-line confirm through the real service, and one seeker run.

### 7.2 Measured
| Operation | 120–1,000 products (HTTP, `catalog-paging`) | 200,000 products in the DB | **1,000,000 products** (1,000 stores × 1,000) |
|---|---|---|---|
| Product page (20–25 items, exact total, photos, match counts) | slowest page of 25 over HTTP: 30–36 ms | p50 16.6 / p95 24.1 ms | p50 21.1 / p95 31.5 ms |
| Page deep in the list (after position 500) | – | p50 15.1 / p95 21.4 ms | p50 22.7 / p95 28.0 ms |
| Exact per-status totals of a store (`storeCounts`, 1,000 products) | – | p50 8.3 / p95 10.4 ms | p50 10.2 / p95 13.3 ms |
| Duplicate check on import (`existingNames`, 1,000 names) | – | p50 9.4 / p95 13.6 ms | p50 13.6 / p95 21.8 ms |
| Store badges on 20 match cards (`attachStoreInfo`) | – | p50 1.6 / p95 3.5 ms | p50 2.1 / p95 4.7 ms |
| Preview of 120 lines | 99–124 ms | – | – |
| Confirm 120 lines (incl. inline matching, no seekers) | 0.89–1.4 s | – | – |
| Confirm 200 lines (incl. inline matching, no seekers) | 1.17–1.89 s per batch | – | – |
| Confirm 200 lines into إعزاز **with 500 matching seekers there** | – | 8.4 s → 88,150 match pairs | 10.4 s → 88,150 match pairs |
| One seeker «موبايل بإعزاز حتى 300$» vs the products of إعزاز | – | 6,200 products: 817 ms, 5,000 evaluated, `truncated` | 28,200 products: 924 ms, 5,000 evaluated, `truncated` |
| Pause / resume a 1,000-product store (HTTP) | 3.0 s / 3.6 s (1,000 status changes + 1,000 jobs in one tx, 250 re-matched inline, 750 left to the worker) | – | – |
| Named vs plain statements (120 products, two runs) | page 4.5–4.9 → 1.3–1.8 ms, exact total 5.4–6.5 → 2.7–4.3 ms (p50) | – | – |
| Storage | – | `store_items` 262 B per product incl. its 3 indexes; `intents_goods` 634 B per intent | – |

The 1,000,000-product numbers were taken before the returned product cards of a confirm were batched into one query
(`itemCardsByIds`), so its confirm time is an upper bound. The bulk load itself (806 s for 1M, 163 s for 200k) is test
setup, not a product path.

Plans (printed by the scale test): the product page is an **Index Only Scan on `store_items_position_key`** (`Heap
Fetches: 0`, 21 index entries) plus 21 primary-key probes into the one goods partition (run-time partition pruning);
nothing scans the store's other products or other stores. Hence pages cost the same at 200k and 1M (≈ +5 ms of cache
effects), and the per-store operations are bounded by the 1,000-product cap, not by the table size.

### 7.3 Why it behaves like this
* **Keyset paging** on `UNIQUE (store_id, position) INCLUDE (vertical_id, intent_id)`: `position` is dense per store and
  never reused, so a cursor is one integer; `prev` pages read the same index backwards; `rangeStart` is a count over
  the same index prefix.
* **Exact totals** cost O(products of that store) — at most 1,000 index entries + 1,000 PK probes (~10 ms measured at the
  cap) — because a product's status lives on its intent (no column was added to `intents`, and a status copy in
  `store_items` could drift when the core or the expiry sweep changes an intent).
* **Bulk insert path:** one transaction per import; per line `createIntent` (intent + ref + scope row: 4–5 statements,
  unchanged core code), then ONE batched `INSERT … SELECT FROM unnest(…)` for all links and one job per product.
  ~1.2–1.9 s for 200 lines including the inline matching; the transaction holds only the store row lock, so imports
  into different stores run in parallel.
* **Planning dominates** small queries on the 9-partition `intents` table, so the hot reads are named statements.
* **Matching is the engine's, unchanged:** each new product is evaluated against the seekers whose scope reaches its city
  (PROBE direction). Cost = products × waiting seekers of that category and city; 200 × ~440 = 88,150 pairs in 8–10 s.
  A seeker's request in a city with more than `CANDIDATE_LIMIT` (5,000) products of its category is evaluated on the
  5,000 newest and reported `truncated` (docs/MATCHING.md §2).

### 7.4 PROJECTED: 10,000 stores × 1,000 products (10,000,000 product intents) — not run
* **Per-store reads** (pages, totals, duplicate check, badges) stay in the measured range: their plans touch only one
  store's ≤ 1,000 entries; B-tree depth grows by about one level from 1M to 10M.
* **Storage** (linear extrapolation of the 200k measurement): `store_items` ≈ 2.5 GB, the product intents in
  `intents_goods` ≈ 6 GB, plus `intent_refs` / `intent_scopes` rows per product (core tables, see docs/DATABASE.md).
* **Imports** stay per-store transactions; total throughput is bounded by `createIntent` (DATABASE.md measured ~270/s
  sequential per connection) and by the inline matching, which is bounded per request by `UL_CATALOG_INLINE_MATCH`.
* **Matching becomes the limit, not the catalogue tables:** with 36 cities, ~280,000 products per city and category.
  (1) Requests are evaluated on the 5,000 newest candidates (`truncated`), so the cheapest fitting product can be missed →
  needs price-aware retrieval (e.g. an index on `(realm, side, deal, category, point_lft, price_lo)` for `eq` offers and
  a price-ordered RANGE query) and finer goods categories (phones vs accessories) — engine work, not done here.
  (2) Notification fan-out: an import of N products into a city with S matching seekers creates up to N·S pair
  notifications (88,150 measured for 200 × 500) → grouped notifications per (seeker, store, import) are recommended.
* **Photos:** up to 60M files (6 per product, ≤ 5 MB each) do not belong on one local disk → object storage keyed by the
  same sha256 (the `MediaStore` interface: `ensure` / `open` / `exists` / `remove`) behind the same visibility check,
  ideally with short-lived signed URLs; thumbnails generated asynchronously by a worker with an image library.
* **Bulk status changes:** pausing a 1,000-product store is 3 s in one transaction; at 10k stores this is unchanged per
  store, and the worker absorbs the 750 queued re-matches per pause.

## 8. Demo data
`seedDemoStores(pool, reg)` (`src/seed/stores-demo.ts`): synthetic persona «أبو أحمد (تجريبي)» (`abu_ahmad_shop`) with
the store «أبو أحمد للموبايلات» in إعزاز and **25 products** imported through the same confirm path (fixed `importId`,
idempotent), plus persona «مشتري موبايل (تجريبي)» (`mobile_buyer`) with «موبايل للشراء في إعزاز حتى 300$», who then sees
19 products of that one store. Everything is `realm='synthetic'`, every product title ends with «(تجريبي)», prices are
illustrative. `--reset-demo` (deletes synthetic users) removes stores, links and products by cascade.

## 9. Tests
| File | Covers |
|---|---|
| `test/unit/catalog-media.test.ts` | magic bytes; JPEG with an EXIF GPS block (+XMP, IPTC, comment, JFIF thumbnail, trailing bytes) comes back without it, orientation-only EXIF; PNG eXIf/tEXt/iTXt/zTXt/tIME/private chunks removed; WebP EXIF/XMP removed and flags cleared; malformed / pixel bombs refused |
| `test/unit/catalog-import.test.ts` | 21 realistic Levantine lines (٣٠٠$, 300 دولار, ١٠ آلاف ليرة تركي, بـ٥٠ الف, «ليرة» alone, missing price, unknown item, duplicates), corrections, defaults, helpers |
| `test/integration/catalog-api.test.ts` | store CRUD/limits/realm; preview over HTTP; idempotent confirm (incl. a concurrent double-click); products match an existing seeker with reasons; price edit invalidates; store pause → invalidated, resume → restored; delete; relocation; 404/401 isolation; synthetic ≠ real |
| `test/integration/catalog-photos.test.ts` | GPS stripped end to end; 415 (renamed text, GIF, text/plain), 413, 422, 400; content-addressed dedupe; 6-photo limit; visibility rule; GC |
| `test/integration/catalog-paging.test.ts` | 120 products: exact totals, keyset forward/back, filters, bad cursors; 1,000-product cap; bulk pause/resume of 1,000 |
| `test/integration/catalog-seed.test.ts` | demo store seed |
| `test/integration/catalog-scale.test.ts` | opt-in measurement (`UL_CATALOG_SCALE=1`), §7 |
| `test/e2e/catalog.spec.ts` | the UI end to end on 3 viewports |

## 10. Open issues
* **Expiry:** products are offers, so they expire after 60 days (`expiryFor`); an expired product shows «منتهي الصلاحية»
  and `setIntentStatus` has no "renew". A store-level renew (or a longer catalogue expiry) needs a core decision.
* **«عروضي» lists every product too** (they are the owner's offers); with 1,000 products the offers tab is long.
  Option for the integrator: hide store items from `/api/intents?side=offers` or group them under «متجري».
* **The generic intent editor** (`PATCH /api/intents/:id`) on a product re-titles it with `titleOf` (the product name is
  lost from the title, `store_items.name_ar` keeps it) and could change its side; product edits should go through
  `PATCH /api/stores/:id/items/:itemId`.
* **Candidate cap at catalogue scale** (§7): a request in a city holding more than `CANDIDATE_LIMIT` (5,000) products of
  its category is evaluated on the 5,000 newest (`truncated=true` is reported) — the engine's documented behaviour.
* `gcMedia` is not scheduled; no thumbnails; photos are not cached by browsers (`no-store`).
* The parser's vocabulary decides categories: brand-only lines («شاحن هواوي», «سماعات بلوتوث») are `unknown_category`
  until the taxonomy learns those words (the owner picks the category in the preview meanwhile).

## 11. Integration steps (integrator)
1. **Migration 0005** (`migrations/0005_catalog.sql`): new tables + two triggers only, no rewrite of existing tables;
   needs 0001–0002 (0003/0004 are independent of it, but `src/repo/intents.ts` already reads 0003's `live_positions`).
   App DB: backup → rehearse on a restored copy → `node src/db/migrate.ts` (the server also migrates on start).
2. **Routes:** in `src/server/routes/index.ts`: `import catalogRoutes from './catalog.ts';` and append `catalogRoutes` to
   `FEATURE_ROUTES` (photos go to `UL_MEDIA_DIR`, default `var/media`).
3. **Store badges on match cards** (`src/server/app.ts`, after each `decorateMatchCards(...)`):
   `import { attachStoreInfo } from '../catalog/match-cards.ts';` then `await attachStoreInfo(pool, reg, u(req).id, page.items)`
   in `GET /api/matches` and `POST /api/intents/:id/match`, and on the one-card array in `GET /api/matches/:id`.
   In the list UI: `groupMatchesByStore`, `storeBadge`, `matchPhotos`, `storeGroupLabel` from `public/js/ui/store.js`.
4. **Demo seed** (`src/seed/seed.ts`, after `await seedDemo(pool, reg)`):
   `import { seedDemoStores } from './stores-demo.ts';` and `if (!process.argv.includes('--no-demo')) await seedDemoStores(pool, reg);`
   The two new personas (`abu_ahmad_shop`, `mobile_buyer`) are not in `PERSONAS`, so `/api/personas` lists them first;
   add them to `PERSONAS`' order if another position is wanted.
5. **Media GC:** schedule `gcMedia(pool, new MediaStore())` (e.g. an hourly worker job).
6. Already done in this change (narrow edits): `public/js/app.js` («عروضي» → «متجري» hook, 4 lines),
   `public/index.html` (one stylesheet link), `docs/CONTRACTS.md` («Stores & catalog»).
