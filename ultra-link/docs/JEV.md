# Jev in Ultra Link (ألترا لينك)

Owner: Role 4 (Jev & structured extraction). Code: `src/ai/*`. Tests: `test/unit/ai-*.test.ts`, mock: `test/mocks/jev-mock-server.ts`.

> **Current status (2026-10-08): NOT VERIFIED against the real API.** This container's egress policy refuses
> `CONNECT api.typesafe.ai:443` with HTTP 403, so no real call has ever succeeded from here. Everything below
> was tested against a local **simulation** that follows the documented wire contract. The app works without
> Jev: the deterministic Arabic parser is always the fallback, and `/api/ai/status` says so honestly.

---

## 1. What is VERIFIED vs UNVERIFIED

### Verified — read from the official Python SDK `typesafe-sdk` 0.7.2 source

| Fact | Source file in the SDK wheel |
|---|---|
| Base URL `https://api.typesafe.ai` (env `TYPESAFE_BASE_URL`), default model `jev-latest`, key env `TYPESAFE_API_KEY`, SDK model env `TYPESAFE_DEFAULT_MODEL`, default timeout 10 s | `constants.py`, `_core/config.py` |
| `POST /v1/systemone`, `GET /v1/models` | `_core/constants.py`, `_core/endpoints.py` |
| Headers `Authorization: Bearer <key>`, `Accept`/`Content-Type: application/json`, retry counter `X-TypeSafe-Retry-Count`, request id `x-typesafe-request-id` | `_core/transport.py`, `_core/constants.py` |
| Request `{state: string\|object\|array, model: string, questions: {name: Question}}` (≥ 1 question) | `_schemas/models.py` (`SystemOneRequest`, generated from `https://api.typesafe.ai/openapi.json`) |
| Question types: `noul` (`instructions?`, `criteria?: {true?, false?}`), `choice` (`instructions?`, `criteria: {label: description\|null}`), `score` (`instructions?`, `criteria: [level0, level1, …]`, ≥ 1) | `_schemas/models.py`, `_core/question_types.py`, `_core/questions.py` |
| Answers: `{type:'noul', noul:p(yes)}`, `{type:'choice', choice, confidence, probabilities}`, `{type:'score', score, confidence, legend, probabilities}` | `_schemas/models.py`, `_core/response_types.py` |
| Response `{model, answers, usage:{input_tokens, output_tokens}}`; `model` may differ from the alias sent | `_schemas/models.py` (`SystemOneResponse`) |
| **Output tokens are currently free of charge** (field description in the OpenAPI schema) | `_schemas/models.py` (`Usage.output_tokens`) |
| `GET /v1/models` → `{models:[{name, description, release_date}]}` | `_schemas/models.py` (`ModelMetadataList`) |
| 422 body is `HTTPValidationError {detail:[{loc, msg, type, input?, ctx?}]}` | `_schemas/models.py` |
| Retries: max 2, on 408/429/5xx + connection errors + timeouts; backoff 0.5 s doubling to 5 s, up to 25 % jitter subtracted; honours `retry-after-ms`, then `retry-after` (seconds or HTTP date); total retry budget 30 s, stopping *before* a wait that would exceed it | `_core/retry.py`, `_core/errors.py` (`parse_retry_after`) |
| Error classes by status: 400, 401, 403, 404, 422, 429, 5xx; a 2xx with a bad body is a validation error (not retried) | `_core/errors.py`, `_core/schemas/base.py` |
| Jev is a "System One" model: the API surface only returns typed answers (probabilities/labels/scores), never free text | `_schemas/models.py` (no text-generation endpoint or answer type exists) |

### Unverified (third-party pages, never confirmed by a real call or by the SDK)

- A `choice` question can have **up to 255 options**. We enforce ≤ 255 client-side as a conservative cap (`MAX_CHOICE_LABELS`).
- Price **~$0.04 per 1 M input tokens**. Only "output tokens are free" is in the official schema.
- Real latency, real answer quality on Levantine Arabic, real rate limits, the exact JSON of 401/429 bodies,
  and whether the API rejects unknown model names — **all unknown** until the host is reachable.

---

## 2. How Ultra Link uses Jev

```
utterance ──► deterministic parser (src/nlu/parse.ts) ──► RuleParse (values + explicit flags)
                                   │
                                   ├─ shouldCallJev(parse)?  no ─► rules only
                                   │  yes
                                   ▼
                  resolveWithJev(client, registry, text, parse)   (src/ai/resolver.ts)
                  ONE batched POST /v1/systemone, only the open questions
                                   │
                                   ▼
                  JevResolution (Candidates, explicit=false) ──► conversation engine applies
                  them only to non-explicit fields above its own thresholds
```

**The model only chooses among options we offer.** It never produces values:

| Question name | Type | Asked when | Options offered |
|---|---|---|---|
| `side` | choice | `parse.side` is null or not explicit | `seek` / `provide` / `join` with Arabic + English descriptions; `join` removed for an explicit exchange category; not asked at all for an explicit peer category (only `join` is valid) |
| `category` | choice | no explicit category candidate | active **leaf** categories (filtered by an explicit side/deal), criteria = `"nameAr: descriptionAr"` from `src/seed/taxonomy.ts`; when > 60 leaves, the top 5 rule candidates + their siblings; plus `other` ("none of the above") so the model can abstain; always ≤ 255 labels |
| `deal` | choice | `parse.deal` not explicit and > 1 deal is possible | deals allowed by the explicit or most likely category; a model-chosen deal that the resolved category forbids is dropped |
| `price_op` | choice | `prices[0]` exists, operator not explicit, not a range | `eq` / `lte` / `gte` / `approx` with Arabic descriptions |
| `place_<id>` | noul | a place mention with no strictness cue, not negated (max 4) | "Does the speaker accept ONLY this place?" → `p ≥ 0.5` ⇒ `required`, else `preferred` |

- `state` = `{"utterance": text, "language": "ar", "context": <short English description of the app>}`.
- Confidence mapping: choice → the API's `confidence`; noul → `|p − 0.5| × 2` (so 0.9 → 0.8 required, 0.2 → 0.6 preferred, 0.5 → 0 required).
- Prices, places, dates, attribute values **always come from the user's own words** via the deterministic parser.
- **Rules win**: a field the parser marked `explicit` is never asked and never overridden.
- **Server-side rules decide matching** (`src/matching/*`) regardless of what the model said; a wrong model answer can at worst
  produce a wrong *draft* field, which the user sees in the summary chips and can correct before saving.
- **The model cannot run SQL, commands or tools**: it receives a JSON state + typed questions and returns probabilities. Nothing it
  returns is executed or interpolated into SQL; labels are validated against the exact set we offered (anything else is rejected).

---

## 3. Modules

| File | Purpose |
|---|---|
| `src/ai/jev-client.ts` | `createJevClient({apiKey, baseUrl?, model?, timeoutMs?, maxRetries?, budgetMs?, circuitThreshold?, circuitOpenMs?, fetchImpl?, now?, …})` → `{systemOne(state, questions, opts?), listModels(), circuit()}`; `JevError {kind, status?, requestId?}`; zod validation; retries; circuit breaker; redaction |
| `src/ai/resolver.ts` | `planJevQuestions`, `shouldCallJev(parse, {registry?, only?})`, `resolveWithJev(client, registry, text, parse, {cache?, only?, signal?})`, `JevCache` (LRU + TTL), `cacheKey` |
| `src/ai/status.ts` | `jevStatus` singleton / `getJevStatus()` → `{mode, keyConfigured, verified, lastSuccessAt, lastError, lastLatencyMs, model, labelAr}` |
| `src/ai/index.ts` | `getJev(env?)` → `{client \| null, status, setting, engine}` (memoized per env); re-exports |
| `src/ai/probe.ts` | `node src/ai/probe.ts` — honest connectivity report; changes nothing |
| `test/mocks/jev-mock-server.ts` | `startJevMock({port?, token?, faults?, latencyMs?})` — **simulation** of the API with fault injection; also runnable standalone |

### Configuration (env, `.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | – | secret; never logged; never sent to a non-official host in simulate mode |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | must be `https` (plain `http` only for a loopback mock) |
| `TYPESAFE_MODEL` | `jev-latest` | `TYPESAFE_DEFAULT_MODEL` (the SDK's name) is accepted too |
| `JEV_MODE` | `auto` | `auto`: loopback URL ⇒ simulate, key ⇒ live, else rules · `live` · `simulate` (loopback only, uses a fixed local token) · `off` |
| `JEV_LOG` | – | `1` = sanitized one-line call logs on stderr |
| `NODE_USE_ENV_PROXY` | – | **must be `1`** (or start node with `--use-env-proxy`) when the host reaches the internet only through `HTTPS_PROXY`: Node's global `fetch` ignores proxy variables otherwise. The probe re-runs itself with it automatically. |

### Integration notes (server / conversation engine)

```ts
import { getJev, resolveWithJev, shouldCallJev, getJevStatus } from '../ai/index.ts';
const { client } = getJev();                       // null => rules only
let jev = null;
if (client && shouldCallJev(parse, { registry, only: stillNeeded })) {
  try { jev = await resolveWithJev(client, registry, text, parse, { only: stillNeeded }); }
  catch { /* JevError: fall back to rules; status already updated */ }
}
// TurnResult.understanding.engine = jev ? jev.engine : 'rules'
// GET /api/ai/status => getJevStatus()
```

---

## 4. Reliability, failure modes and fallbacks

| Setting | Value | Why |
|---|---|---|
| per-attempt timeout | 4 s (SDK: 10 s) | a voice turn must not stall |
| total budget per call | 6 s incl. retries and waits (SDK: 30 s) | a retry whose wait would cross the budget is skipped, like the SDK's `stop_before_delay` |
| retries | 2, on `network`, `timeout` (incl. 408), `rate_limited`, `server`; backoff 0.5 → 5 s, jitter; `retry-after-ms` / `retry-after` honoured | same as SDK |
| no retry | `auth` (401/403), `validation` (400/404/422…), `bad_response` | retrying cannot help |
| circuit breaker | opens after 3 consecutive failed calls, stays open 60 s, then one half-open trial (success closes, failure re-opens); `validation` responses prove the server is up and do not count | stop paying latency on a dead link |
| redirects | not followed (`redirect: 'manual'` → `bad_response`) | the `Authorization` header must never leave the base URL |

`JevError.kind`: `auth`, `network`, `timeout`, `rate_limited`, `server`, `bad_response`, `validation`, `circuit_open`, `no_key`.

**Response validation** (zod + cross-check with the questions sent): every asked question must have an answer; the answer type must
match the question type; a choice must be one of the offered labels; probability keys must be offered labels / existing levels;
`noul`, `confidence` and probabilities must be in [0, 1]; a score must lie in 0..n−1. Any violation ⇒ `bad_response` (not retried).

**Fallback**: every failure throws a `JevError`; the caller keeps the rule parse. The conversation never blocks on Jev.

**Status** (`/api/ai/status`): `mode` is the engine expected for the next turn — `jev`, `jev-sim`, or `rules` (also when the last live
call failed). `verified` is `true` only after a real successful response from `https://api.typesafe.ai` in this process.
Labels: «Jev متصل» · «مفتاح Jev موجود — لم يُختبر الاتصال بعد» · «مفتاح Jev موجود لكن الاتصال فشل — يعمل المحلّل المحلي» ·
«محاكاة Jev (ليست اتصالًا فعليًا)» · «المحلّل المحلي فقط» (+ variants for disabled / misconfigured / custom URL).

### Security & privacy

- The key is validated like the SDK (printable ASCII, no spaces) and redacted (`***`) from every message, log line and status string,
  including JSON- and URL-encoded variants and any `Bearer …` token.
- Error messages never echo request bodies, server `input` fields, or **Arabic text** (runs of Arabic script become `‹ar›`), so user
  utterances cannot reach logs through errors. 422 details keep only `loc` path, error `type` code and a sanitized `msg`.
- `simulate` mode sends a fixed local token, never the real key; `live` mode refuses a loopback URL; plain `http` is refused for
  non-loopback hosts.

---

## 5. Cost controls

1. **Ask only what is open**: `shouldCallJev` returns false when every field is explicit, for "لا"/"ما بعرف" answers and empty text;
   `only` restricts to fields the conversation still needs (never re-ask answered fields).
2. **One batched request per turn** (all open questions together; the utterance is sent once).
3. **Cache**: in-memory LRU (500 entries) + TTL (10 min) keyed by `sha256(model + normalized text + question set)`; normalization removes
   diacritics/spacing differences; identical concurrent requests share one call; failures are not cached; hits report 0 tokens.
4. **Circuit breaker** avoids paying for repeated timeouts.
5. Size: a full first-turn request (side + 28 category labels + deal + price + place) is ~4.5 KB of JSON. The simulation estimates
   ~900–1150 input tokens (chars/4 — **not** a real tokenizer count). At the **unverified** $0.04 / 1 M input tokens that is ≈ $0.00005
   per turn; output tokens are free per the official schema.

---

## 6. Testing (all against the local simulation)

```
node --test test/unit/ai-*.test.ts
```

- `ai-client.test.ts` — wire shape; 429 + `retry-after-ms`/`retry-after`; exponential backoff; give-up after 2 retries; 408 retried;
  no retry on 401/422; client-side validation (no request); per-attempt timeout; budget cap; long `retry-after` vs budget; connection
  refused / dropped socket; caller abort; `bad_response` for wrong label / missing answer / wrong type / out-of-range / malformed JSON /
  unknown probability labels; circuit breaker open → half-open → closed, failed trial re-opens, single trial; key and Arabic text never in
  `String(err)`, `JSON.stringify(err)`, `util.inspect(err)`, stack, logs or captured stdout/stderr; no redirects.
- `ai-resolver.test.ts` — only needed questions (side/category/deal/price/place, `only`), label sets and descriptions, narrowing for large
  taxonomies, confidence mapping, `other` and inconsistent-deal handling, no call when nothing is open, error propagation, cache
  hit/TTL/LRU/in-flight/immutability, and a batched run against the mock.
- `ai-status.test.ts` — env modes (`auto`/`live`/`simulate`/`off`), sim token isolation, labels, `verified` only for the official URL.

Mock: `startJevMock({faults:[{kind:'rate_limit', retryAfterMs:50}, {kind:'server_error'}, {kind:'unauthorized'}, {kind:'malformed'},
{kind:'wrong_label', question}, {kind:'missing_answer', question}, {kind:'wrong_type'}, {kind:'out_of_range'}, {kind:'latency', ms},
{kind:'hang'}, {kind:'drop'}, {kind:'status', status, headers, body}]})`. It requires a Bearer token, validates the request shape and
returns Pydantic-style 422s. Its answers are deterministic keyword heuristics — a **simulation**, labelled as such in every response
(`model: "jev-sim"`, header `x-jev-simulation: 1`). Demo: `node test/mocks/jev-mock-server.ts --port 8787` then
`JEV_MODE=simulate TYPESAFE_BASE_URL=http://127.0.0.1:8787`.

---

## 7. Current connection status — 2026-10-08

`node src/ai/probe.ts` in this container:

```
note: HTTPS_PROXY is set; re-running with NODE_USE_ENV_PROXY=1 so Node fetch uses it.
(node:3075) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.
(Use `node --trace-warnings ...` to show where the warning was created)
Jev connectivity probe
  time:        2026-10-08T17:57:28.360Z
  .env:        found (6 vars loaded, values not shown)
  base URL:    https://api.typesafe.ai (official TypeSafe API)
  model:       jev-latest
  API key:     configured (redacted)
  proxy:       HTTPS_PROXY set; NODE_USE_ENV_PROXY=1

[1] GET /v1/models
  FAILED kind=network | http_status=none (no HTTP response from the API) | request_id=- | attempts=1 | message="network error: HTTPS proxy refused CONNECT with HTTP 403 (egress policy or upstream failure)"

[2] POST /v1/systemone (one noul question, no user data)
  FAILED kind=network | http_status=none (no HTTP response from the API) | request_id=- | attempts=1 | message="network error: HTTPS proxy refused CONNECT with HTTP 403 (egress policy or upstream failure)" | elapsed_ms=305

RESULT: NOT VERIFIED — Jev is unreachable from here; Ultra Link falls back to the local rule parser.
```

The local egress proxy's own log confirms it: `connect_rejected api.typesafe.ai:443 — gateway answered 403 to CONNECT (policy denial
or upstream failure)`. The request never reached TypeSafe, so the key itself is **untested** (neither accepted nor rejected).

## 8. How to enable the real Jev

1. Allow the host: in the cloud environment's settings (environment menu in the session title bar → **Edit** → **Network access**),
   either choose a broader access level or add **`api.typesafe.ai`** under *Allowed domains* (keep *Allow package managers* ticked).
   Steps: https://code.claude.com/docs/en/cloud-environments#network-access
2. Keep `TYPESAFE_API_KEY` in `.env` (git-ignored). Start the server with `NODE_USE_ENV_PROXY=1` when an `HTTPS_PROXY` is in use.
3. Run `node src/ai/probe.ts`. Only `RESULT: VERIFIED — the real Jev API answered both calls.` counts as verification; then
   `/api/ai/status` will show `verified: true`, «Jev متصل» after the first real successful call of the running server.
4. Re-check the unverified items in §1 (label limit, price, latency) and update this document.
