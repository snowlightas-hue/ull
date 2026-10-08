# Ultra Link — Shared contracts (source of truth for all roles)

Owner: integrator (lead). Changes to this file must be coordinated; agents must not change contracts silently.

## Runtime
- Node 22.22 runs `.ts` directly (type stripping; erasable syntax only: no `enum`, no `namespace`, no parameter properties).
- Server: Fastify 5 on `http://127.0.0.1:8080` (env `PORT`). Static frontend from `public/` (plain ES modules, no build step).
- DB: dedicated PostgreSQL 16 cluster in `var/pgdata`, `127.0.0.1:5544`, databases `ultralink` (app) and `ultralink_test` (tests). URLs in `.env` (git-ignored).
- Secrets only in `.env`. Never log `TYPESAFE_API_KEY`, session tokens, or full user utterances (log lengths/hashes).

## Domain types
See `src/domain/types.ts` (IntentSpec, PriceSpec, AttrConstraint, Draft, Question, PairVerdict...).
Money = integer minor units as **decimal string** in JSON (`"20000"` = 200.00 USD), BIGINT in SQL. Never floats.
Taxonomy/places/attributes: `src/seed/taxonomy.ts`; in-memory registry `src/domain/registry.ts`.

## HTTP API (JSON; Arabic text fields end with `Ar`)
Auth: httpOnly cookie `ul_session`. Every `/api/*` route except `/api/health`, `/api/personas`, `/api/auth/*`, `/api/ai/status` requires it → else `401 {error:'unauthorized'}`.
Errors: `{ error: string(code), messageAr: string }` with proper status (400/401/403/404/409/422/500/503).

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /api/health | – | `{ok, db, worker:{lastBeatAt}, version}` |
| GET | /api/ai/status | – | `{mode:'jev'|'rules'|'jev-sim', keyConfigured, verified, lastSuccessAt, lastError, model, labelAr}` |
| GET | /api/personas | – | `{items:[{handle, displayName, descriptionAr}]}` (synthetic demo users) |
| POST | /api/auth/demo-login | `{handle}` | `{user}` + cookie |
| POST | /api/auth/register | `{displayName}` | `{user}` + cookie (realm=real) |
| POST | /api/auth/logout | – | `{ok}` |
| GET | /api/me | – | `{user:{publicId, displayName, realm}, counts:{requests, offers, matches, unread}}` |
| POST | /api/conversations | – | `{conversation}` (new) |
| GET | /api/conversations/current | – | `{conversation|null}` (open draft restored after reload) |
| POST | /api/conversations/:id/turns | `{text, modality:'voice'|'text', clientTurnId}` | `TurnResult` (idempotent per clientTurnId) |
| POST | /api/conversations/:id/cancel | – | `{conversation}` |
| GET | /api/intents | `side=seek|provide|join|requests|offers&status=&cursor=&dir=next|prev&limit=` | `Page<IntentCard>` |
| GET | /api/intents/:id | – | `{intent: IntentDetail}` |
| PATCH | /api/intents/:id | `{expectedVersion, changes: Partial<IntentSpec>}` | `{intent}` or 409 version conflict |
| POST | /api/intents/:id/status | `{action:'pause'|'resume'|'fulfill'|'close'}` | `{intent}` |
| POST | /api/intents/:id/match | – | `MatchRunResult` (runs matching now for current version, or returns the stored run) |
| GET | /api/matches | `intent=&state=active|confirmed|possible|invalidated&cursor=&dir=&limit=` | `Page<MatchCard>` |
| POST | /api/matches/:id/contact | `{messageAr?}` | `{contactRequest}` |
| POST | /api/contact-requests/:id/respond | `{accept:boolean}` | `{contactRequest}` |
| GET | /api/notifications | `cursor=&dir=&limit=&unread=1` | `Page<Notification>` + `unread` |
| POST | /api/notifications/:id/read | – | `{ok}` (only recipient; else 404) |
| POST | /api/notifications/read-all | – | `{ok, updated}` |
| GET | /api/events | – | SSE: `event: notification|counts|match_update` data JSON |
| POST | /api/demo/simulate | `{scenario:'later_match'}` | `{created}` synthetic realm only |

### Shapes
```ts
type Page<T> = { items: T[]; total: number; limit: number; nextCursor: string|null; prevCursor: string|null; rangeStart: number; rangeEnd: number };

type TurnResult = {
  conversation: { id: string; state: 'collecting'|'asking'|'saved'|'cancelled'; turns: number };
  action: 'ask' | 'saved' | 'cancelled' | 'unclear';
  question?: Question;                 // when action='ask' (one question only)
  summary: { titleAr: string; chips: { labelAr: string; valueAr: string; slot: string }[] };
  intent?: IntentCard;                 // when action='saved'
  understanding: { engine: 'rules'|'jev'|'jev-sim'; latencyMs: number; notesAr?: string[] };
};

type IntentCard = {
  id: string /* public uuid */; side: 'seek'|'provide'|'join'; status: string; version: number;
  titleAr: string; categoryAr: string; dealAr: string; placeAr: string|null; priceAr: string|null; whenAr: string|null;
  chips: { labelAr: string; valueAr: string; strength?: 'required'|'preferred' }[];
  matchCounts: { confirmed: number; possible: number }; createdAt: string; updatedAt: string; expiresAt: string|null;
  synthetic: boolean;
};

type MatchCard = {
  id: string; state: 'confirmed'|'possible'|'invalidated'; score: number; kind: 'exchange'|'peer';
  mine: IntentCard;           // the viewer's intent
  other: IntentCard;          // counterpart (no identity until contact accepted)
  reasons: { code: string; polarity: 'plus'|'minus'|'unknown'|'info'; text: string; strength?: string }[];
  missing: string[];
  contact: { status: 'none'|'pending_out'|'pending_in'|'accepted'|'declined'; requestId?: string; counterpart?: { displayName: string; phone?: string } };
  updatedAt: string; invalidReasonAr?: string;
};

type MatchRunResult = {
  intentId: string; version: number; status: 'done'|'queued';
  totals: { confirmed: number; possible: number; excluded: number; candidates: number };
  exclusions: { code: string; count: number; textAr: string }[];
  page: Page<MatchCard>;
  suggestionsAr: string[];    // e.g. "وسّع المكان إلى محافظة حلب" — never applied automatically
  truncated: boolean;
};
```

## Client conversation states (UI + voice must use these names)
`ready → listening → reviewing(countdown, cancel/edit) → processing → asking → speaking → awaiting_answer → listening ...`
`→ saving → searching → results | saved_no_results` ; any → `error` (recoverable, shows retry).

## File ownership (agents edit only their files; integrator merges)
| Role | Owns |
|---|---|
| 1 Product & business | `docs/PRODUCT.md`, `test/corpus/*.json` (utterance corpus + expected labels) |
| 2 Design & UX | `public/index.html`, `public/css/*`, `public/js/ui/*` |
| 3 Voice & conversation (client) | `public/js/conversation/*` |
| 4 Jev & structured extraction | `src/ai/*`, `test/unit/ai*.test.ts`, `test/mocks/jev-mock-server.ts` |
| 5 Database | `migrations/*.sql`, `src/db/*`, `scripts/backup.sh`, `scripts/restore-test.sh`, `bench/*`, `src/advisor/*` |
| 6 Matching & jobs | `src/matching/*`, `src/worker/*`, `test/unit/matching*.test.ts` |
| 7 Server & ops | `src/server/*`, `scripts/app.sh`, `scripts/db.sh` |
| 8 Tests & review | `test/integration/*`, `test/e2e/*`, `docs/REVIEW.md` |
Integrator: `src/domain/*`, `src/nlu/*`, `src/conversation/*`, `src/seed/*`, `public/js/app.js`, `public/js/api.js`, `docs/ARCHITECTURE.md`, `README.md`.

## Connections & chat (V2.2 — owner: connections role; details in `docs/CONNECTIONS.md`)
Plugins `src/server/routes/connections.ts` and `src/server/routes/account.ts`. Every route needs a session (401) except
`/api/auth/recover`; every `:id` route answers **404** to anyone who is not one of the connection's two participants.
Rate limits per session: `conn_messages` 30/min, `conn_location` 20/min, `conn_actions` 30/min; `auth_recover` 5/min per IP.

Changes to existing routes:
- `POST /api/auth/register` → `{user, recoveryCode}` (shown once; real accounts).
- `POST /api/matches/:id/contact` → `409 realm_mismatch | contact_unavailable (a block either way) | connection_ended`.
- `POST /api/contact-requests/:id/respond` → `{contactRequest, connection?: {id, status}}`; accept opens the connection
  (one per match, idempotent). **Accept reveals the display name only** — `MatchCard.contact.counterpart.phone` is present
  only while the counterpart shares it in an open connection. `MatchCard` gains `connection?: {id, status, unread}`.

| Method | Path | Body / Query | Response |
|---|---|---|---|
| GET | /api/connections | `status=open|closed|archived|all&cursor=&dir=&limit=` | `Page<ConnectionCard>` (newest activity first) |
| GET | /api/connections/:id | – | `{connection: ConnectionDetail}` |
| GET | /api/connections/:id/messages | `cursor=&dir=&limit=` (newest first) or `after=<seq>&limit=` | `Page<Message> & {lastReadSeq:{mine,theirs}}` · with `after`: `{items (oldest first), more, total, lastReadSeq}` |
| POST | /api/connections/:id/messages | `{text ≤1000 chars, clientMsgId: uuid}` | `{message, duplicate}`; 409 `connection_not_open` / `client_msg_id_reused` |
| POST | /api/connections/:id/read | `{seq}` | `{ok, lastReadSeq, unread}` (forward-only) |
| POST | /api/connections/:id/phone | `{share: boolean, phone?}` | `{connection}`; 409 `no_phone` |
| POST | /api/connections/:id/location/start | `{minutes: 15|30|60}` | `{share:{active, startedAt, expiresAt}, minutes}` |
| POST | /api/connections/:id/location/stop | – | `{ok}` (idempotent; coordinates erased) |
| POST | /api/connections/:id/location | `{lat, lng, accuracyM?}` | `{ok, expiresAt}`; 409 `share_not_active` |
| GET | /api/connections/:id/location | – | `{mine: Location, theirs: Location}` |
| POST | /api/connections/:id/close · /block · /unblock | – | `{connection}` |
| POST | /api/connections/:id/report | `{reason: spam|scam|abuse|inappropriate|fake|other, note?}` | `{ok, noteAr}` (stored for review; no automatic action) |
| POST | /api/auth/recover | `{code, displayName?}` | `{user}` + cookie; 401 `bad_recovery_code`; 429 |
| GET | /api/account | – | `{user, recovery: {hasCode, createdAt, lastUsedAt}|null, phone}` |
| POST | /api/account/recovery-code | – | `{recoveryCode, createdAt}` (old code invalid at once; 403 `real_only` for demo personas) |
| POST | /api/account/phone | `{phone|null}` | `{phone}` |
| GET | /api/events | – | adds `event: conn_message | conn_update | conn_location` (data = counts; clients refetch) |

```ts
type ConnectionCard = {
  id: string; status: 'open'|'closed'|'blocked'|'archived';   // viewer-relative: the blocked side sees 'closed'
  blockedByMe: boolean; synthetic: boolean; matchId: string;
  counterpart: { displayName: string; phone?: string };        // phone only while shared and open
  titles: { mineAr: string|null; otherAr: string|null };
  unread: number; messageCount: number; lastMessageAt: string|null; createdAt: string; updatedAt: string;
};
type Location = { active: boolean; startedAt: string|null; expiresAt: string|null;
                  position?: { lat: number; lng: number; accuracyM: number|null; at: string } | null }; // theirs only, while active
type ConnectionDetail = ConnectionCard & { canSend: boolean; reportedByMe: boolean;
  me: { phoneShared: boolean; hasPhone: boolean; lastReadSeq: number; location: Location };
  them: { phoneShared: boolean; lastReadSeq: number; location: Location } };
type Message = { seq: number /* 1..n per connection, gap-free */; mine: boolean; text: string; createdAt: string; clientMsgId?: string /* mine only */ };
```
Notifications: `contact_accepted` (payload `connectionId`), `connection_message` (one per connection and recipient,
refreshed, body = unread count, never the text), `location_share_started`, `location_share_ended`.
Jobs: `conn_sweep`, `conn_location_end` (worker: `job.kind.startsWith('conn_')` → `runConnectionJob`). Env: `UL_RECOVERY_PEPPER`, `UL_CONN_SWEEP_MS`.
