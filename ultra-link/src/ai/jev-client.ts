// HTTP client for the TypeSafe "Jev" System One API (POST /v1/systemone, GET /v1/models).
//
// Wire contract and retry semantics mirror the official Python SDK `typesafe-sdk` 0.7.2
// (_schemas/models.py, _core/transport.py, _core/retry.py, _core/errors.py, constants.py):
//   - Authorization: Bearer <key>; Accept/Content-Type: application/json
//   - retries on 408/429/5xx, connection errors and timeouts; max 2 retries; exponential backoff
//     0.5 s -> 5 s with up to 25 % jitter subtracted; honors `retry-after-ms` then `retry-after`
//   - request id in the `x-typesafe-request-id` response header
// Differences on purpose (interactive voice turns): shorter per-attempt timeout (4 s vs SDK 10 s),
// smaller total budget (6 s vs SDK 30 s), a circuit breaker, and strict cross-validation of the
// answers against the questions that were asked.
//
// Security: error messages and log lines never contain the API key, request bodies or Arabic
// user text. Redirects are not followed (the Authorization header must never leave the base URL).
// Real network calls from Node need NODE_USE_ENV_PROXY=1 (or --use-env-proxy) when the host only
// reaches the internet through HTTPS_PROXY; Node's global fetch ignores proxy env vars otherwise.

import { z } from 'zod';

export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_MODEL = 'jev-latest';
export const SYSTEM_ONE_PATH = '/v1/systemone';
export const MODELS_PATH = '/v1/models';
export const REQUEST_ID_HEADER = 'x-typesafe-request-id';
export const RETRY_COUNT_HEADER = 'X-TypeSafe-Retry-Count';
/** UNVERIFIED (third-party pages): a choice may have up to 255 options. Enforced client-side as a conservative cap. */
export const MAX_CHOICE_LABELS = 255;

export const DEFAULTS = {
  timeoutMs: 4000,
  maxRetries: 2,
  budgetMs: 6000,
  backoffInitialMs: 500,
  backoffMaxMs: 5000,
  backoffJitter: 0.25,
  circuitThreshold: 3,
  circuitOpenMs: 60_000,
} as const;

// ───────────────────────────── wire types ─────────────────────────────

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** The content every question refers to (string, JSON object or array). */
export type JevState = string | { [key: string]: JsonValue } | JsonValue[];

export interface NoulQuestion {
  type: 'noul';
  instructions?: JsonValue;
  criteria?: { true?: JsonValue; false?: JsonValue } | null;
}
export interface ChoiceQuestion {
  type: 'choice';
  instructions?: JsonValue;
  /** label -> description (or null: interpreted by the label alone) */
  criteria: Record<string, JsonValue>;
}
export interface ScoreQuestion {
  type: 'score';
  instructions?: JsonValue;
  /** ordered level descriptions; position = score, starting at 0 */
  criteria: JsonValue[];
}
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface NoulAnswer { type: 'noul'; noul: number }
export interface ChoiceAnswer { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
}
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type AnswerFor<Q extends JevQuestion> = Q extends { type: 'noul' }
  ? NoulAnswer
  : Q extends { type: 'choice' }
    ? ChoiceAnswer
    : ScoreAnswer;
export type AnswersFor<Q extends JevQuestions> = { [K in keyof Q]: AnswerFor<Q[K]> };

export interface JevUsage { inputTokens: number | null; outputTokens: number | null }

export interface SystemOneResult<Q extends JevQuestions = JevQuestions> {
  model: string; // may differ from the requested alias
  answers: AnswersFor<Q>;
  usage: JevUsage;
  requestId: string | null;
  latencyMs: number; // wall time including retries
  attempts: number;
}

export interface JevModelInfo { name: string; description: string; releaseDate: string }
export interface ListModelsResult { models: JevModelInfo[]; requestId: string | null; latencyMs: number; attempts: number }

// ───────────────────────────── errors ─────────────────────────────

export type JevErrorKind =
  | 'auth' // 401/403
  | 'network' // no HTTP response (DNS, refused, reset, proxy CONNECT refused)
  | 'timeout' // per-attempt timeout, total budget exhausted, or HTTP 408
  | 'rate_limited' // 429
  | 'server' // 5xx
  | 'bad_response' // 2xx whose body is not valid JSON / does not match the contract or the questions asked
  | 'validation' // our request was rejected (400/404/422 ...) or failed client-side checks
  | 'circuit_open' // short-circuited after repeated failures
  | 'no_key'; // API key missing or malformed

export interface JevErrorInit { status?: number; requestId?: string; retryAfterMs?: number; attempts?: number }

export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  attempts: number;
  constructor(kind: JevErrorKind, message: string, init: JevErrorInit = {}) {
    super(message);
    this.name = 'JevError';
    this.kind = kind;
    this.status = init.status;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.attempts = init.attempts ?? 0;
  }
  /** Short, sanitized description suitable for status pages (no secrets, no user text). */
  get short(): string {
    const parts: string[] = [this.kind];
    if (this.status != null) parts.push(`HTTP ${this.status}`);
    return `${parts.join(' ')}: ${this.message}`.slice(0, 200);
  }
  toJSON(): Record<string, unknown> {
    return { name: this.name, kind: this.kind, status: this.status, requestId: this.requestId, message: this.message };
  }
}

export function isJevError(e: unknown): e is JevError {
  return e instanceof JevError;
}

// ───────────────────────────── sanitizing ─────────────────────────────

const ARABIC_RUN = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+(?:[\s؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]*[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]+)?/g;

/** Builds a redactor that removes the given secrets (and common encodings of them), bearer tokens and Arabic text. */
export function makeRedactor(secrets: string[]): (s: string) => string {
  const variants = new Set<string>();
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    variants.add(s);
    variants.add(JSON.stringify(s).slice(1, -1));
    variants.add(encodeURIComponent(s));
  }
  const sorted = [...variants].sort((a, b) => b.length - a.length);
  return (input: string) => {
    let out = String(input);
    for (const v of sorted) out = out.split(v).join('***');
    out = out.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer ***');
    out = out.replace(ARABIC_RUN, '‹ar›');
    return out.replace(/\s+/g, ' ').trim();
  };
}

const SAFE_IDENT = /^[A-Za-z0-9_.:\-]{1,64}$/;

function safeServerMessage(body: unknown, redact: (s: string) => string): string | null {
  // Mirrors the SDK's extract_message, but never echoes `input` values (they may contain user text).
  if (typeof body === 'string') return body ? redact(body).slice(0, 120) : null;
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const pick = (v: unknown): string | null => (typeof v === 'string' && v ? redact(v).slice(0, 120) : null);
  if (typeof b.error === 'string') return pick(b.error);
  if (b.error && typeof b.error === 'object') {
    const m = pick((b.error as Record<string, unknown>).message);
    if (m) return m;
  }
  if (typeof b.message === 'string') return pick(b.message);
  if (typeof b.detail === 'string') return pick(b.detail);
  if (Array.isArray(b.detail)) {
    const parts: string[] = [];
    for (const entry of b.detail.slice(0, 3)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const loc = Array.isArray(e.loc)
        ? e.loc
            .filter((x) => x !== 'body')
            .map((x) => (typeof x === 'number' || (typeof x === 'string' && SAFE_IDENT.test(x)) ? String(x) : '…'))
            .join('.')
        : '';
      const type = typeof e.type === 'string' && SAFE_IDENT.test(e.type) ? e.type : '';
      const msg = typeof e.msg === 'string' ? redact(e.msg).slice(0, 80) : '';
      parts.push([loc, type && `[${type}]`, msg].filter(Boolean).join(' '));
    }
    return parts.length ? parts.join('; ').slice(0, 200) : null;
  }
  return null;
}

// ───────────────────────────── retry helpers (SDK semantics) ─────────────────────────────

/** Parse `retry-after-ms` (ms) then `retry-after` (seconds or HTTP date). Returns ms, or null. Same rules as the SDK. */
export function parseRetryAfter(headers: { get(name: string): string | null }, nowMs: number = Date.now()): number | null {
  const ms = headers.get('retry-after-ms');
  if (ms != null) {
    const v = Number(ms.trim() || '0');
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const s = headers.get('retry-after');
  if (s != null) {
    const raw = s.trim() || '0';
    const v = Number(raw);
    if (!Number.isNaN(v) && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw)) {
      if (Number.isFinite(v) && v >= 0) return v * 1000;
      return null;
    }
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  }
  return null;
}

/** SDK `_backoff`: attempt is 1-based (number of attempts made so far). */
export function backoffDelayMs(attempt: number, initialMs: number, maxMs: number, jitter: number, random: () => number = Math.random): number {
  if (initialMs === 0 || maxMs === 0) return 0;
  const exponent = attempt - 1;
  const exponential = exponent >= Math.log2(maxMs) - Math.log2(initialMs) ? maxMs : initialMs * 2 ** exponent;
  const delay = exponential * (1 - random() * jitter);
  return Math.min(exponential, Math.round(delay));
}

function isRetryable(e: JevError): boolean {
  return e.kind === 'network' || e.kind === 'timeout' || e.kind === 'rate_limited' || e.kind === 'server';
}

function kindForStatus(status: number): JevErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'validation';
  return 'bad_response';
}

// ───────────────────────────── zod response schemas ─────────────────────────────

const Prob = z.number().min(0).max(1);
const NoulAnswerZ = z.object({ type: z.literal('noul'), noul: Prob });
const ChoiceAnswerZ = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: Prob,
  probabilities: z.record(z.string(), Prob),
});
const ScoreAnswerZ = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: Prob,
  legend: z.record(z.string(), z.unknown()),
  probabilities: z.record(z.string(), Prob),
});
const TokenCount = z.number().int().min(0).nullable().optional();
const SystemOneResponseZ = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: TokenCount, output_tokens: TokenCount }),
});
const ModelsResponseZ = z.object({
  models: z.array(z.object({ name: z.string(), description: z.string(), release_date: z.string() })),
});

function issuePath(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return '';
  const path = first.path.map((p) => (typeof p === 'number' ? `[${p}]` : SAFE_IDENT.test(String(p)) ? String(p) : '…')).join('.');
  return `${path || '(root)'} (${first.code})`;
}

/** Validate one answer against the question it answers. Throws a message (no values echoed). */
function checkAnswer(name: string, q: JevQuestion, raw: unknown): JevAnswer {
  if (raw === undefined) throw new Error(`missing answer for question '${name}'`);
  const type = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : undefined;
  if (type !== q.type) throw new Error(`answer '${name}' has type ${typeof type === 'string' && SAFE_IDENT.test(type) ? `'${type}'` : 'invalid'}, expected '${q.type}'`);
  if (q.type === 'noul') {
    const r = NoulAnswerZ.safeParse(raw);
    if (!r.success) throw new Error(`answer '${name}' invalid at ${issuePath(r.error)}`);
    return r.data;
  }
  if (q.type === 'choice') {
    const r = ChoiceAnswerZ.safeParse(raw);
    if (!r.success) throw new Error(`answer '${name}' invalid at ${issuePath(r.error)}`);
    const labels = new Set(Object.keys(q.criteria));
    if (!labels.has(r.data.choice)) throw new Error(`answer '${name}': choice is not one of the ${labels.size} offered labels`);
    for (const k of Object.keys(r.data.probabilities)) {
      if (!labels.has(k)) throw new Error(`answer '${name}': probabilities contain a label that was not offered`);
    }
    return r.data;
  }
  const r = ScoreAnswerZ.safeParse(raw);
  if (!r.success) throw new Error(`answer '${name}' invalid at ${issuePath(r.error)}`);
  const levels = q.criteria.length;
  if (r.data.score < 0 || r.data.score > levels - 1) throw new Error(`answer '${name}': score outside 0..${levels - 1}`);
  for (const k of Object.keys(r.data.probabilities)) {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 0 || n >= levels) throw new Error(`answer '${name}': probabilities contain an unknown level`);
  }
  return r.data;
}

/** Client-side request checks (same rules as the SDK's normalize_questions plus the label cap). */
export function validateQuestions(questions: JevQuestions): void {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) throw new JevError('validation', 'questions must be an object');
  const names = Object.keys(questions);
  if (names.length === 0) throw new JevError('validation', 'at least one question is required');
  for (const name of names) {
    if (!SAFE_IDENT.test(name)) throw new JevError('validation', 'question names must be 1-64 chars of [A-Za-z0-9_.:-]');
    const q = questions[name] as JevQuestion | undefined;
    if (!q || typeof q !== 'object') throw new JevError('validation', `question '${name}' must be an object`);
    if (q.type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) throw new JevError('validation', `question '${name}' requires criteria`);
      const n = Object.keys(q.criteria).length;
      if (n < 1) throw new JevError('validation', `choice question '${name}' needs at least one label`);
      if (n > MAX_CHOICE_LABELS) throw new JevError('validation', `choice question '${name}' has ${n} labels (max ${MAX_CHOICE_LABELS})`);
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 1) throw new JevError('validation', `score question '${name}' needs at least one level`);
    } else if (q.type !== 'noul') {
      throw new JevError('validation', `question '${name}' has an unknown type`);
    }
  }
}

function validateState(state: unknown): void {
  if (typeof state === 'string' || Array.isArray(state) || (state !== null && typeof state === 'object')) return;
  throw new JevError('validation', 'state must be a string, an object or an array');
}

// ───────────────────────────── client ─────────────────────────────

export interface JevOutcome {
  ok: boolean;
  op: 'systemone' | 'models';
  latencyMs: number;
  baseUrl: string;
  official: boolean; // baseUrl is the real TypeSafe API
  model?: string;
  requestId?: string | null;
  error?: JevError;
}

export interface JevClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** per-attempt timeout (default 4000 ms) */
  timeoutMs?: number;
  /** retries after the first attempt (default 2, like the SDK) */
  maxRetries?: number;
  /** total wall-time budget per call incl. retries and waits (default 6000 ms) */
  budgetMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  backoffJitter?: number;
  /** consecutive failed calls before the circuit opens (default 3) */
  circuitThreshold?: number;
  /** how long the circuit stays open before one half-open trial (default 60 s) */
  circuitOpenMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** 'jev-sim' for a local mock; default: derived from baseUrl (loopback => jev-sim) */
  engine?: 'jev' | 'jev-sim';
  /** called after every call (success or failure) — used by the status tracker */
  onOutcome?: (o: JevOutcome) => void;
  /** sanitized one-line logs (never key, body or user text) */
  log?: (line: string) => void;
}

export interface CallOptions { model?: string; signal?: AbortSignal; timeoutMs?: number }

export interface CircuitState { state: 'closed' | 'open' | 'half-open'; consecutiveFailures: number; openUntil: number | null }

export interface JevClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly engine: 'jev' | 'jev-sim';
  readonly official: boolean;
  systemOne<Q extends JevQuestions>(state: JevState, questions: Q, opts?: CallOptions): Promise<SystemOneResult<Q>>;
  listModels(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ListModelsResult>;
  circuit(): CircuitState;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch {
    return false;
  }
}

export function isOfficialBaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'api.typesafe.ai' && (u.port === '' || u.port === '443');
  } catch {
    return false;
  }
}

/** SDK rule: printable ASCII without whitespace. */
export function isWellFormedKey(key: string | undefined | null): key is string {
  return typeof key === 'string' && key.trim().length > 0 && /^[\x21-\x7E]+$/.test(key.trim());
}

const TIMEOUT_MARK = Symbol('jev-timeout');

export function createJevClient(opts: JevClientOptions): JevClient {
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
  if (!isWellFormedKey(apiKey)) throw new JevError('no_key', 'Jev API key is missing or malformed (expected printable ASCII without spaces)');

  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new JevError('validation', 'Jev base URL is not a valid URL');
  }
  const loopback = isLoopbackUrl(baseUrl);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new JevError('validation', 'Jev base URL must use https (plain http is allowed only for a loopback mock)');
  }

  const model = opts.model?.trim() || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? DEFAULTS.maxRetries));
  const budgetMs = opts.budgetMs ?? DEFAULTS.budgetMs;
  const backoffInitialMs = opts.backoffInitialMs ?? DEFAULTS.backoffInitialMs;
  const backoffMaxMs = opts.backoffMaxMs ?? DEFAULTS.backoffMaxMs;
  const backoffJitter = opts.backoffJitter ?? DEFAULTS.backoffJitter;
  const circuitThreshold = Math.max(1, opts.circuitThreshold ?? DEFAULTS.circuitThreshold);
  const circuitOpenMs = opts.circuitOpenMs ?? DEFAULTS.circuitOpenMs;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => performance.timeOrigin + performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const engine = opts.engine ?? (loopback ? 'jev-sim' : 'jev');
  const official = isOfficialBaseUrl(baseUrl);
  const redact = makeRedactor([apiKey, `Bearer ${apiKey}`]);
  const log = (line: string) => {
    try {
      opts.log?.(redact(line));
    } catch {
      /* logging must never break a call */
    }
  };

  // circuit breaker state
  let consecutiveFailures = 0;
  let openedAt: number | null = null;
  let halfOpenInFlight = false;

  function circuit(): CircuitState {
    if (openedAt === null) return { state: 'closed', consecutiveFailures, openUntil: null };
    const until = openedAt + circuitOpenMs;
    return { state: now() >= until ? 'half-open' : 'open', consecutiveFailures, openUntil: until };
  }

  function admit(): 'closed' | 'half-open' {
    if (openedAt === null) return 'closed';
    const remaining = openedAt + circuitOpenMs - now();
    if (remaining > 0) {
      throw new JevError('circuit_open', `Jev calls paused for ${Math.ceil(remaining / 1000)} s after ${consecutiveFailures} consecutive failures`, { retryAfterMs: remaining });
    }
    if (halfOpenInFlight) throw new JevError('circuit_open', 'Jev half-open trial already in flight');
    halfOpenInFlight = true;
    return 'half-open';
  }

  function settle(phase: 'closed' | 'half-open', err: JevError | null) {
    if (phase === 'half-open') halfOpenInFlight = false;
    // A server that answers (2xx, or rejects our request shape with 4xx validation) is reachable.
    if (!err || err.kind === 'validation') {
      consecutiveFailures = 0;
      openedAt = null;
      return;
    }
    consecutiveFailures++;
    if (phase === 'half-open' || consecutiveFailures >= circuitThreshold) openedAt = now();
  }

  async function attemptOnce<T>(
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    attempt: number,
    attemptTimeoutMs: number,
    callerSignal: AbortSignal | undefined,
    decode: (json: unknown, status: number, requestId: string | undefined) => T,
  ): Promise<{ value: T; requestId: string | undefined }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(TIMEOUT_MARK), Math.max(1, attemptTimeoutMs));
    const signal = callerSignal ? AbortSignal.any([ctrl.signal, callerSignal]) : ctrl.signal;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'ultra-link-jev-client/0.1 (node)',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (attempt > 0) headers[RETRY_COUNT_HEADER] = String(attempt);
    const t0 = now();
    let status = 0;
    let requestId: string | undefined;
    try {
      let res: Response;
      let text: string;
      try {
        res = await fetchImpl(baseUrl + path, { method, headers, body, signal, redirect: 'manual' });
        status = res.status;
        requestId = res.headers.get(REQUEST_ID_HEADER) ?? undefined;
        text = await res.text();
      } catch (e) {
        if (callerSignal?.aborted) throw new JevError('timeout', 'request aborted by caller', { requestId });
        if (ctrl.signal.aborted) throw new JevError('timeout', `no complete response within ${attemptTimeoutMs} ms`, { requestId });
        throw networkError(e, redact);
      }
      if (status < 200 || status >= 300) {
        let parsedBody: unknown = text;
        try {
          parsedBody = text ? JSON.parse(text) : null;
        } catch {
          /* keep text */
        }
        const kind = status >= 300 && status < 400 ? 'bad_response' : kindForStatus(status);
        const detail = status >= 300 && status < 400 ? 'redirects are not followed' : safeServerMessage(parsedBody, redact);
        throw new JevError(kind, `Jev HTTP ${status}${detail ? `: ${detail}` : ''}`, {
          status,
          requestId,
          retryAfterMs: parseRetryAfter(res.headers) ?? undefined,
        });
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new JevError('bad_response', 'response body is not valid JSON', { status, requestId });
      }
      const value = decode(json, status, requestId);
      log(`[jev] ${method} ${path} -> ${status} in ${Math.round(now() - t0)} ms (request ${requestId ?? '-'}) attempt ${attempt + 1}`);
      return { value, requestId };
    } catch (e) {
      const err = e instanceof JevError ? e : new JevError('bad_response', 'unexpected client error', { status: status || undefined, requestId });
      log(`[jev] ${method} ${path} attempt ${attempt + 1} failed: ${err.kind}${err.status ? ` (HTTP ${err.status})` : ''} after ${Math.round(now() - t0)} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<T>(
    op: 'systemone' | 'models',
    method: 'GET' | 'POST',
    path: string,
    body: string | undefined,
    callOpts: { signal?: AbortSignal; timeoutMs?: number },
    decode: (json: unknown, status: number, requestId: string | undefined) => T,
  ): Promise<{ value: T; requestId: string | null; latencyMs: number; attempts: number }> {
    const started = now();
    const phase = admit();
    const perAttempt = callOpts.timeoutMs ?? timeoutMs;
    let attempt = 0;
    let lastErr: JevError | null = null;
    try {
      for (;;) {
        const remaining = budgetMs - (now() - started);
        if (remaining <= 0) {
          throw lastErr ?? new JevError('timeout', `Jev budget of ${budgetMs} ms exhausted`);
        }
        try {
          const { value, requestId } = await attemptOnce(method, path, body, attempt, Math.min(perAttempt, remaining), callOpts.signal, decode);
          const latencyMs = Math.round(now() - started);
          settle(phase, null);
          const modelName = (value as { model?: unknown }).model;
          safeOutcome({ ok: true, op, latencyMs, baseUrl, official, model: typeof modelName === 'string' ? modelName : undefined, requestId: requestId ?? null });
          return { value, requestId: requestId ?? null, latencyMs, attempts: attempt + 1 };
        } catch (e) {
          lastErr = e as JevError;
          lastErr.attempts = attempt + 1;
          if (callOpts.signal?.aborted || !isRetryable(lastErr) || attempt >= maxRetries) throw lastErr;
          const delay = lastErr.retryAfterMs ?? backoffDelayMs(attempt + 1, backoffInitialMs, backoffMaxMs, backoffJitter, random);
          if (now() - started + delay >= budgetMs) throw lastErr; // SDK: stop_before_delay(budget)
          await sleep(delay);
          attempt++;
        }
      }
    } catch (e) {
      const err = e as JevError;
      if (callOpts.signal?.aborted) {
        if (phase === 'half-open') halfOpenInFlight = false; // caller abort is neutral for the circuit
      } else {
        settle(phase, err);
      }
      safeOutcome({ ok: false, op, latencyMs: Math.round(now() - started), baseUrl, official, error: err });
      throw err;
    }
  }

  function safeOutcome(o: JevOutcome) {
    try {
      opts.onOutcome?.(o);
    } catch {
      /* status hooks must never break a call */
    }
  }

  return {
    baseUrl,
    model,
    engine,
    official,
    circuit,

    async systemOne<Q extends JevQuestions>(state: JevState, questions: Q, callOpts: CallOptions = {}): Promise<SystemOneResult<Q>> {
      validateState(state);
      validateQuestions(questions);
      const useModel = callOpts.model?.trim() || model;
      let body: string;
      try {
        body = JSON.stringify({ state, model: useModel, questions });
      } catch {
        throw new JevError('validation', 'request body could not be encoded as JSON');
      }
      const r = await call('systemone', 'POST', SYSTEM_ONE_PATH, body, callOpts, (json, status, requestId) => {
        const parsedResp = SystemOneResponseZ.safeParse(json);
        if (!parsedResp.success) throw new JevError('bad_response', `invalid response at ${issuePath(parsedResp.error)}`, { status, requestId });
        const answers: Record<string, JevAnswer> = {};
        for (const [name, q] of Object.entries(questions)) {
          try {
            answers[name] = checkAnswer(name, q, parsedResp.data.answers[name]);
          } catch (e) {
            throw new JevError('bad_response', (e as Error).message, { status, requestId });
          }
        }
        return {
          model: parsedResp.data.model,
          answers: answers as AnswersFor<Q>,
          usage: { inputTokens: parsedResp.data.usage.input_tokens ?? null, outputTokens: parsedResp.data.usage.output_tokens ?? null },
        };
      });
      return { ...r.value, requestId: r.requestId, latencyMs: r.latencyMs, attempts: r.attempts };
    },

    async listModels(callOpts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ListModelsResult> {
      const r = await call('models', 'GET', MODELS_PATH, undefined, callOpts, (json, status, requestId) => {
        const p = ModelsResponseZ.safeParse(json);
        if (!p.success) throw new JevError('bad_response', `invalid models response at ${issuePath(p.error)}`, { status, requestId });
        return p.data.models.map((m) => ({ name: m.name, description: m.description, releaseDate: m.release_date }));
      });
      return { models: r.value, requestId: r.requestId, latencyMs: r.latencyMs, attempts: r.attempts };
    },
  };
}

/** Map a fetch() rejection to a sanitized 'network' error (walks the cause chain; keeps only codes and short messages). */
function networkError(e: unknown, redact: (s: string) => string): JevError {
  const chain: { message: string; code: string | null }[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    const c = cur as { message?: unknown; code?: unknown; cause?: unknown };
    chain.push({ message: typeof c.message === 'string' ? c.message : '', code: typeof c.code === 'string' ? c.code : null });
    cur = c.cause;
  }
  const proxyHit = chain.find((x) => /Proxy response \((\d{3})\)/i.test(x.message));
  if (proxyHit) {
    const st = /Proxy response \((\d{3})\)/i.exec(proxyHit.message)![1];
    // The proxy's status is deliberately NOT stored in `status` (that field is reserved for the API's own HTTP status).
    return new JevError('network', `network error: HTTPS proxy refused CONNECT with HTTP ${st} (egress policy or upstream failure)`);
  }
  const code = [...chain].reverse().find((x) => x.code)?.code ?? null;
  const deepest = [...chain].reverse().find((x) => x.message && x.message !== 'fetch failed')?.message ?? 'fetch failed';
  return new JevError('network', `network error${code ? ` ${code}` : ''}: ${redact(deepest).slice(0, 120)}`);
}
