# Connections («ربط») & chat — V2.2

Owner: the connections role. Product design: `docs/FEATURES-V2.md` §4. HTTP contract: `docs/CONTRACTS.md`,
section "Connections & chat". What is **measured** is labelled measured; everything about scale is a **plan**.

## 1. Lifecycle

```
match (anonymous) ──▶ contact request ──▶ accept ──▶ connection «open»  ──▶ closed   (either side)
                         │                 │                │          ──▶ blocked  (either side; user-level)
                         │                 │                │          ──▶ archived (worker: 14 d after both
                         └─ refused (409) when the two realms differ,   │               intents ended, or 30 d
                            either side blocked the other, or this      │               without messages)
                            match's connection already ended            └─ blocked ──▶ closed (unblock; never reopens)
```

- **Created on accept**, in the same transaction as `contact_requests.status = 'accepted'`
  (`openConnectionForMatch`, called from `POST /api/contact-requests/:id/respond` in `src/server/app.ts`).
  One row per match: `UNIQUE (vertical_id, match_id)` + `INSERT … ON CONFLICT DO NOTHING`, then read the winner's row.
  Both sides asking each other and both accepting at the same moment still produce one connection (tested).
- **Realms never mix**: the contact route and the accept both check that the two users share a realm
  (`409 realm_mismatch`), although the matcher already separates realms. Synthetic connections are labelled
  (`synthetic: true` → «تجريبي» in the chat header).
- **Close**: either side; final for that match (a new contact request on the same match is `409 connection_ended`).
- **Block**: either side; stored per user pair (`user_blocks`). Every connection between the pair becomes
  `blocked`, pending contact requests between them are cancelled, new ones are refused in both directions
  (`409 contact_unavailable`, wording does not say "blocked"). The **blocked side sees the connection as `closed`**
  (it is not told who blocked whom). Only the blocker can `unblock`; unblocking lifts the user-level block, the
  frozen connections become `closed` (not reopened).
- **Report**: stored in `connection_reports` (reason + optional note, one row per reporter and connection, a new
  report updates it, `status='open'` for review). **Nothing is automated**: no ban, no hiding, the reported user is
  not told.
- **Auto-archive** (worker): `open`/`closed` connections are archived 14 days after **both** intents are
  `closed | fulfilled | expired` (the later `closed_at` counts), or after 30 days without a message (counted from
  creation when there is none). `blocked` stays `blocked`. Archived = read-only history.

## 2. Privacy rules (enforced on the server)

| What | Visible to the counterpart | Code |
|---|---|---|
| display name | after accept | `decorateMatchCards`, `CARD_SELECT` |
| phone (`users.contact_phone`) | only while the owner's «شارك رقمي» is on **and** the connection is `open` | SQL `CASE` — the raw phone never leaves the database otherwise |
| precise position | only while the owner's share is active (not stopped, not expired) **and** the connection is `open` | `locationsOf` |
| message text | the two participants only; never in notifications, SSE events or logs | `sendMessage` |

- **Behaviour change (V2.2):** accepting a contact request used to reveal name **and phone** to both. Now it reveals
  the **display name only**; the phone needs the owner's explicit «شارك رقمي» inside the chat and disappears again
  when it is switched off or the connection is closed / blocked / archived. Notification and button texts say so.
  Contact requests accepted before migration 0004 get a connection by backfill, with both phone shares **off**.
- The MatchCard hydration in `src/matching/engine.ts` still reads `contact_phone`; `src/server/app.ts` passes every
  MatchCard it returns through `decorateMatchCards`, which removes any phone and re-adds it only under the rule
  above. (Recommended for the matching role: drop `contact_phone` from that query.)
- **Isolation**: every connection, message, phone and location endpoint loads the connection with
  `public_id = $1 AND (a_user_id = me OR b_user_id = me)` → anyone else gets **404** (never 403); anonymous → 401.
- **No logging of content**: request bodies are redacted by the server logger; this feature logs nothing itself.
  Notifications say «رسائل جديدة من …» with a count, never the text. SSE events carry only an event name + counts;
  the client fetches messages (`?after=seq`) — no text or coordinates go through `pg_notify`.
- **Location**: coordinates are erased from the row when a share stops, expires or the connection ends
  (`CHECK (ended_at IS NULL OR lat IS NULL)`); no position history is kept. Each start notifies the counterpart once
  («… يشارك موقعه المباشر معك»), each end once («انتهت مشاركة موقع …»). Self-contained tables; no dependency on the
  geo agent's `live_positions`.

## 3. Chat

- Text ≤ **1000 Unicode code points** after trimming and removing control characters (newlines kept). Empty → 400.
- **Idempotent send**: `clientMsgId` (uuid) per sender. The same id returns the stored message (`duplicate: true`),
  also for parallel retries and after the connection closed; the same id with another text → `409 client_msg_id_reused`.
- **Ordering**: the connection row is locked (`SELECT … FOR UPDATE`) before `seq = message_count + 1` is assigned,
  so `seq` is gap-free (1..n) and grows in **commit order**: a reader of `?after=seq` can never miss a message that
  commits later with a smaller number. Consequence: exact totals and page positions are computed (`message_count`,
  `total − seq + 1`), not counted.
- **Pages**: newest first, keyset on `(connection_id, seq)`; `next` = older, `prev` = newer; `Page<T>` shape with
  exact `total`, `rangeStart`, `rangeEnd`, like `listIntents`. `?after=seq` returns newer messages oldest-first
  (`{items, more, total, lastReadSeq}`) for live updates.
- **Read receipts**: `a_last_read_seq` / `b_last_read_seq`, forward-only, clamped to `message_count`. Sending a
  message moves the sender's own receipt to it.
- **Grouped notification**: one row per (recipient, connection) — `dedupe_key = conn-msg:<connection id>` —
  upserted on every message (title «رسائل جديدة من <name>», body = unread count, `read_at = NULL`, `created_at` =
  newest message). Reading everything (or replying) marks it read. Duplicates are impossible
  (`UNIQUE (recipient_id, dedupe_key)`).
- **Live**: `conn_message` (new message), `conn_update` (status, receipts, phone/location share changes),
  `conn_location` (position ping) through the existing hub (`ul_events`). The client refetches.
- **Rate limits** (per session, `UL_RL_<NAME>_PER_MIN` overrides, 0 disables): `conn_messages` 30/min,
  `conn_location` 20/min (pings), `conn_actions` 30/min (phone, location start/stop, close, block, unblock, report).

## 4. Live location for rides

«شارك موقعي لمدة ١٥ / ٣٠ / ساعة» starts a share (`expires_at = now + duration`, CHECK ≤ 60 min); restarting replaces
the share (new `share_id`). While active, the sharer's page runs `navigator.geolocation.watchPosition` and posts a
position at most every 15 s, or after moving ≥ 50 m (but not more often than every 5 s), to
`POST /api/connections/:id/location`. The counterpart reads the latest position (`GET …/location`, or the detail) with
its age and accuracy and an «افتح في الخريطة» link (OpenStreetMap, opened by the user; no map is embedded, no tiles
are fetched by the app). «إيقاف مشاركة موقعي» ends it at once. A web page only tracks while it is open
(FEATURES-V2 §1) — the UI says so. Expiry: reads stop at `expires_at` immediately; a `conn_location_end` job at the
expiry time erases the coordinates and notifies the counterpart (the archive sweep is the safety net).

## 5. Account recovery (REVIEW.md MAJOR-6)

- At registration (`POST /api/auth/register`, real accounts) the response carries `recoveryCode` **once**:
  16 characters of Crockford base32 (`0-9 A-Z` without `I L O U`) in 4 groups, 80 random bits. The UI shows
  «احفظ هذا الرمز» with a copy button and a «كتبت الرمز…» checkbox; Esc does not dismiss it.
- **Storage**: `user_recovery_codes.code_hash = HMAC-SHA256(pepper, "ul-recovery-v1:" + code)` with
  `UNIQUE` → direct lookup. **Decision: HMAC with a pepper, not scrypt** — the code is 80 random bits, not a
  password, so a slow hash adds nothing, while a deterministic keyed hash allows an index lookup without a username
  (same pattern as `sessions.token_hash`). The pepper comes from env **`UL_RECOVERY_PEPPER`** (≥ 16 chars); unset →
  a fixed development pepper (and a warning when `NODE_ENV=production`). Changing the pepper invalidates all codes.
- `POST /api/auth/recover {code, displayName?}` → a new session for the code's owner (real accounts only). Input is
  normalised (Arabic-Indic / Persian digits, lower case, spaces, dashes, `O→0`, `I/L→1`). Wrong, malformed or
  name-mismatched → **401** `bad_recovery_code` (same answer). A well-formed miss costs the same as a hit (one HMAC,
  one index probe, one `timingSafeEqual` against the row or a dummy); a malformed code is refused before the probe. Limits per client IP: `auth_recover` **5/min** on top of the
  global `/api/auth/*` 20/min → 429 + `Retry-After`. A browser holding another session gets it replaced (deleted).
- The code stays valid until regenerated (it is not consumed by a recovery) — a deliberate usability choice for
  people who keep it on paper; `POST /api/account/recovery-code` (in a session, real accounts) issues a new one and
  the old one stops working at once. «خروج» on a real account first shows a warning dialog («ستحتاج رمز
  الاسترداد…») with «أنشئ رمز استرداد جديد أولًا». No SMS, OTP or paid service is used.

## 6. Data model (migration `0004_connections.sql`)

| Table | Purpose / key points |
|---|---|
| `connections` | one per match; `a_*`/`b_*` = the match's a/b user (phone share, last read seq); `message_count` = newest seq; `activity_at` for the list order and the idle rule; indexes `(a_user_id, activity_at DESC, id DESC)`, `(b_user_id, …)`, partial `(id) WHERE status IN ('open','closed')` for the sweep; `fillfactor 80` (HOT updates per message) |
| `connection_messages` | append-only; `PRIMARY KEY (connection_id, seq)`; `UNIQUE (connection_id, sender_id, client_msg_id)` |
| `user_blocks` | `PRIMARY KEY (blocker_id, blocked_id)` + index on `blocked_id` |
| `connection_reports` | review queue index `(created_at) WHERE status = 'open'` |
| `connection_location_shares` | `PRIMARY KEY (connection_id, sharer_id)`, `share_id` per start, coordinates erased on end, `fillfactor 70` |
| `user_recovery_codes` | `user_id` PK, `code_hash` UNIQUE (32 bytes) |

Jobs (registered in `src/worker/main.ts` with `if (job.kind.startsWith('conn_')) return runConnectionJob(pool, job)`):
`conn_sweep` (archive + expired-share safety net; a self-rescheduling chain with one job per hourly slot,
`UL_CONN_SWEEP_MS`, started when a connection opens, continued while archivable connections or live shares exist)
and `conn_location_end` (at a share's expiry).

## 7. Scale (plan — nothing here was measured)

- **Messages** are the only fast-growing table. Its key is already partition-ready: `PRIMARY KEY (connection_id,
  seq)` and the unique idempotency key both lead with `connection_id`, so `PARTITION BY HASH (connection_id)`
  (e.g. 16 → 64 partitions) needs no key change; every chat query names one connection → one partition. A shard key
  of `connection_id` keeps a conversation (and its row lock) on one node; `connections` can live with the smaller
  user-keyed tables. Old archived conversations could move to cold storage by `archived_at`.
- **Per-message write cost**: one insert + one update of the connection row (HOT, fillfactor 80) + one notification
  upsert, all in one transaction; the per-connection row lock serializes only the two participants' sends.
- **Sweep**: walks archivable connections in id order (partial index), O(open connections) per hourly run, batched.
  At large scale this should become event-driven (an intent status change enqueues a check for its connections) —
  not built.
- **SSE fan-out** stays the existing hub's (one LISTEN per server); position pings are rate-limited per session and
  never re-match intents.

## 8. Tests

```
node --test --test-concurrency=1 test/integration/connections-*.test.ts    # API, live SSE, recovery, sweep/jobs
node --test test/unit/connections-helpers.test.ts                         # codes, normalisation, counts
node test/e2e/connections.spec.ts                                          # two browsers, isolated stack
```
The e2e spec starts its own server in-process on a fresh database (never `:8080`), mocks browser geolocation, and
writes screenshots to `test/e2e/artifacts/connections/`.

## 9. Known limits

- The SSE events carry no connection id (the hub fans out names + counts only), so a client refetches; a burst
  of messages can cause a few redundant small fetches.
- Matches between users who blocked each other are still listed by the matcher; the contact request is refused.
  Hiding them belongs to the matching role.
- Reports have no reviewer UI yet (rows wait in `connection_reports`).
- If a user deletes their account, connections, messages and their reports cascade away.
- Web location sharing works only while the sharer's page is open (no background tracking without a native app).
