# Ultra Link — Operations

Owner: Role 7 (server & ops). Covers `src/server/*`, `scripts/app.sh`, `scripts/db.sh`.

## Processes
| Process | Entry | Default | Pidfile / log |
|---|---|---|---|
| PostgreSQL 16 (dedicated cluster, `var/pgdata`) | `scripts/db.sh` | `127.0.0.1:5544` | `var/pgdata/postmaster.pid`, `var/log/postgres.log` |
| API + static UI (Fastify) | `src/server/main.ts` | `127.0.0.1:8080` | `var/run/server.pid`, `var/log/server.log` |
| Background worker (match jobs, expiry sweep, heartbeat) | `src/worker/main.ts` | – | `var/run/worker.pid`, `var/log/worker.log` |

Node processes write their own pidfile (`UL_PIDFILE`) and remove it on exit only if it still names them.

## scripts/app.sh
```
bash scripts/app.sh start            # db.sh start → migrate → seed if empty → server → worker → wait for /api/health = 200
bash scripts/app.sh status           # postgres, server, worker pids + the health JSON
bash scripts/app.sh logs [server|worker|postgres|all] [-f] [-n N]
bash scripts/app.sh restart          # server + worker only (postgres keeps running)
bash scripts/app.sh stop [--all]     # graceful (SIGTERM, up to UL_STOP_WAIT_S=15 s, then SIGKILL); --all also stops postgres
```
- **Never signals a foreign process.** A pid counts as ours only if the process carries our `UL_PIDFILE` in its
  environment (`/proc/<pid>/environ`; elsewhere: command line `node … <entry>` with cwd = this checkout).
  Anything else is a stale pidfile: it is removed with a note, the process is left alone.
- **Port in use**: `start` refuses and names the holder, e.g. `port 8080 is already in use by pid 4242: python3 -m http.server`.
- **Second instance** (tests, experiments) without touching the demo:
  `PORT=8091 UL_RUN_DIR=/tmp/ul/run UL_LOG_DIR=/tmp/ul/log UL_DATABASE_URL=postgres://…/other_db bash scripts/app.sh start`
  (migrate/seed/server/worker all use `UL_DATABASE_URL`; stop it with the same env).

## scripts/db.sh
`start | stop | status | provision | psql …`. `start` runs `initdb` once, starts the cluster (refuses with the
holder's name if 5544 is taken; a `postmaster.pid` whose pid now belongs to another program is removed, that
program untouched) and `provision`s: role `ultralink` (password generated into `.env`, never printed), databases
`ultralink`, `ultralink_test`, template `ultralink_template`, extensions
`btree_gist pg_trgm pg_stat_statements pgcrypto cube earthdistance` (superuser-only, so migrations can rely on them).
The template's installed set is recorded as its database comment; an up-to-date template is never connected to
(cloning fails while anyone is connected). Per-test databases (`ultralink_t_*`) are cloned from it.

## Configuration (env; `.env` is loaded but never overrides an exported variable)
| Variable | Default | Effect |
|---|---|---|
| `PORT`, `HOST` | `8080`, `127.0.0.1` | listen address |
| `UL_DATABASE_URL` | `DATABASE_URL` | database for server, worker, migrate, seed |
| `UL_TRUST_PROXY` | unset (0) | number of trusted proxy hops (Codespaces: `1`), see below |
| `UL_RL_TURNS_PER_MIN` / `UL_RL_AUTH_PER_MIN` / `UL_RL_SIMULATE_PER_MIN` | 30 / 20 / 10 | token buckets; `0` disables |
| `UL_RL_<NAME>_PER_MIN` | route value | override a feature route's bucket |
| `UL_SSE_MAX_PER_USER`, `UL_SSE_HEARTBEAT_MS` | 5, 25000 | live event streams |
| `UL_SHUTDOWN_TIMEOUT_MS` | 10000 | drain limit before a forced exit |
| `UL_SESSION_CLEANUP_MS` | 600000 | min interval between lazy expired-session cleanups |
| `UL_LOG_LEVEL` | `info` | pino level (JSON lines on stdout → `var/log/server.log`) |
| `UL_DB_POOL_MAX` | 10 | pg pool size per process |
| `JEV_MODE`, `UL_JEV_BUDGET_MS` | `auto`, 2500 | Jev provider (see `docs/JEV.md`); rules always answer |

## Health and metrics
`GET /api/health` (public, cheap): `200` while the database answers, `503` when it does not (`status:"down"`) or
while draining. Body: `ok, status (ok|degraded|draining|down), degraded[], db, dbLatencyMs,
worker {lastBeatAt, ageMs, alive (<30 s)}, queue {pending, due, running, failed, oldestDueAgeMs}, jev {mode,
verified, labelAr, lastSuccessAt, lastError}, events {connected, reconnects}, version, registry, uptimeS`.
`degraded`: `worker` (no heartbeat for 30 s), `events` (LISTEN down, reconnecting), `queue_lag` (oldest due job > 2 min).

`GET /api/metrics` — **loopback only** (404 for any other address or anything carrying X-Forwarded-For /
Forwarded / X-Real-IP): `db.turns`, `db.saves`, `db.matchRuns {total, last24h, durationMs {p50, p95, max}}` (last
10k `match_runs`), `db.jobs` by status, `db.notifications {sent, last24h, unread}`, `db.sessions`, and process
counters (`http` by class, `turns` by action/engine, `rateLimited` per bucket, pool, SSE, Jev). Read-only
transaction with a 3 s statement timeout. Never contains user text.

## Guards on every `/api/*` request (in order, before the body is parsed)
1. **CSRF**: mutations need `Content-Type: application/json` (else 415) and our own origin: Origin, else Referer,
   must match `Host` (scheme default ports normalised); `Sec-Fetch-Site: cross-site` and `Origin: null` are 403.
2. **Rate limits** (in-memory token buckets, refill continuously; 429 + `Retry-After` seconds):
   turns 30/min per session, `/api/auth/*` 20/min per client IP, simulate 10/min per session, feature buckets.
3. **Session**: httpOnly cookie `ul_session` (SameSite=Lax; `Secure` only when the request arrived over https via a
   trusted proxy). Missing/expired → 401. Expired sessions are deleted lazily in batches of 1000 by ordinary traffic.
4. **Validation**: zod for bodies, query strings (limit 1–100, opaque cursors checked before SQL), and UUID path ids
   (400 `bad_id`); errors are always `{error, messageAr}`. PostgreSQL data errors → 400, contention → 409,
   outages → 503 + `Retry-After: 5`, never a stack trace.
5. **Logs**: method, path (no query string), status, latency, client IP. Never bodies, cookies, headers, query
   strings, user names, phone numbers or utterances; error messages are sanitised (`safeErr`: quoted values and
   Arabic text removed). Bodies are capped at 64 KiB (413).

The turn body accepts an optional `geo: {lat −90..90, lng −180..180, accuracyM? 0..100000}` (`null` = none),
passed to `handleTurn`; unknown optional fields are passed through, not rejected.

## Live events (SSE, `GET /api/events`)
One LISTEN connection (`ul_events`) per server fans out `notification | counts | match_update` to the user's open
streams. Heartbeat comment every 25 s; at most 5 streams per user (6th → 429 `too_many_streams`, `Retry-After: 30`).
If the LISTEN connection drops, it reconnects with jittered exponential backoff (0.5 s → 30 s) and pushes fresh
counts to every open stream (events may have been missed). Health shows `events.connected/reconnects`.

## Graceful shutdown (SIGTERM / SIGINT)
health → 503 `draining` → stop accepting connections → every SSE stream gets `event: shutdown` and is closed
(browsers reconnect after `retry: 3000`) → in-flight requests finish → LISTEN connection and pool closed → exit 0.
Bounded by `UL_SHUTDOWN_TIMEOUT_MS` (then exit 1); a second signal forces exit. Uncaught exceptions log a
sanitised error and shut down the same way. A taken port is a one-line error and exit 1.

## Reverse proxy / GitHub Codespaces
Set `UL_TRUST_PROXY=1` (`.devcontainer/devcontainer.json` does). Then: the client IP is the address the nearest
proxy saw (right-most X-Forwarded-For entry — a forged left part cannot dodge per-IP limits), `X-Forwarded-Proto:
https` makes the cookie `Secure`, and a mutation's Origin may match the first `X-Forwarded-Host` value
(`https://<name>-8080.app.github.dev`) as well as `Host`. Unset = strict `Host` comparison, forwarded headers ignored.
`/api/metrics` stays unreachable through the proxy.

## Adding feature routes (`src/server/routes/<feature>.ts`)
```ts
import { defineRoutes } from '../context.ts';
export default defineRoutes('links', async (app, ctx) => {
  app.get('/api/links/:id', { config: { public: true, rateLimit: { name: 'links_view', perMinute: 120, by: 'ip' } } },
    async (req) => ({ id: ctx.uuidParam((req.params as { id: string }).id) }));
});
```
Append it to `FEATURE_ROUTES` in `src/server/routes/index.ts` (tests can pass `buildApp({ …, routes: [plugin] })`).
Plugins register after all hooks, so they inherit CSRF, auth (opt out per route with `config.public`), rate limits
(`config.rateLimit`, or `ctx.rateLimit(req, reply, …)` inside a handler), the error format, headers and log policy.
`config.contentTypes: ['image/jpeg', …]` admits non-JSON uploads on that route only (origin check still applies).
`ctx` offers `pool, reg, user(req), maybeUser(req), body(schema, req), parseQuery, uuidParam, HttpError, events, limiter`.

## Runbook
| Symptom | Check | Action |
|---|---|---|
| `start`: port in use | the message names the pid/command | stop that process or `PORT=…` |
| `note: removed stale … pidfile` | – | harmless (crash/reboot left it); the named pid was not ours |
| health 503 `down`, API 503 | `bash scripts/db.sh status`, `app.sh logs postgres` | `bash scripts/db.sh start` |
| `degraded: ["worker"]` | `app.sh logs worker` | `bash scripts/app.sh restart` (jobs are idempotent) |
| `degraded: ["queue_lag"]` | `/api/metrics` → `db.jobs`, `queue.oldestDueAgeMs` | worker alive? failing jobs (`jobs.last_error`)? |
| `degraded: ["events"]` | `events.reconnects`, server log | reconnects alone; live badges fall back on reload |
| Jev label “لا تستجيب” | `/api/ai/status.lastError` | nothing urgent: rules answer every turn |
| many 429 | `/api/metrics` → `process.rateLimited` | raise `UL_RL_*_PER_MIN` only if legitimate |

## Tests
`node --test --test-concurrency=1 test/integration/server-*.test.ts` — API contract (`server-api`), hardening and
ops (`server-ops`), SSE/LISTEN (`server-events`), Jev failure modes (`server-jev`), the real entry point
(`server-lifecycle`), and `app.sh` on a private run dir/port/database (`server-scripts`). All use isolated
`ultralink_t_*` databases and never touch `:8080` or `var/run`.
