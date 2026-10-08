// SIMULATION of the TypeSafe Jev System One API for tests and offline demos. NOT the real model.
//
// Implements the wire contract from typesafe-sdk 0.7.2 (_schemas/models.py):
//   POST /v1/systemone  {state, model, questions} -> {model, answers, usage} + x-typesafe-request-id
//   GET  /v1/models     -> {models:[{name, description, release_date}]}
// Requires `Authorization: Bearer <token>`; validates the request shape and answers 422
// {detail:[{loc,msg,type}]} like the real (FastAPI/Pydantic) API. Answers are deterministic Arabic
// keyword heuristics over the utterance and the offered criteria texts.
//
// Fault injection (FIFO queue, one fault consumed per API request): latency, status (429 + retry-after-ms,
// 500, 401, ...), malformed JSON, wrong choice label, missing answer, wrong answer type, hang, drop.
//
// Standalone: node test/mocks/jev-mock-server.ts [--port 8787]
//   then JEV_MODE=simulate TYPESAFE_BASE_URL=http://127.0.0.1:8787 for the app.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { normalizeAr, tokenVariants, tokenize } from '../../src/nlu/arabic.ts';

export type JevMockFault =
  | { kind: 'latency'; ms: number }
  | { kind: 'status'; status: number; headers?: Record<string, string>; body?: unknown }
  | { kind: 'rate_limit'; retryAfterMs?: number; retryAfterSec?: number }
  | { kind: 'server_error'; status?: number }
  | { kind: 'unauthorized' }
  | { kind: 'malformed' }
  | { kind: 'wrong_label'; question?: string }
  | { kind: 'missing_answer'; question?: string }
  | { kind: 'wrong_type'; question?: string }
  | { kind: 'out_of_range'; question?: string }
  | { kind: 'hang' }
  | { kind: 'drop' };

export interface JevMockOptions {
  port?: number;
  host?: string;
  /** expected bearer token; when omitted any non-empty bearer token is accepted */
  token?: string;
  faults?: JevMockFault[];
  /** latency added to every request (ms) */
  latencyMs?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorized: boolean;
  retryCount: string | null;
  contentType: string | null;
  body: unknown;
  at: number;
}

export interface JevMock {
  url: string;
  port: number;
  requests: RecordedRequest[];
  /** replace the fault queue */
  setFaults(faults: JevMockFault[]): void;
  /** append faults to the queue */
  pushFaults(...faults: JevMockFault[]): void;
  reset(): void;
  close(): Promise<void>;
}

export const SIM_MODEL = 'jev-sim';

// ───────────────────────────── request validation (Pydantic-like) ─────────────────────────────

interface Issue { loc: (string | number)[]; msg: string; type: string }

const isJsonContent = (v: unknown) => typeof v === 'string' || Array.isArray(v) || (v !== null && typeof v === 'object');

function validateRequest(body: unknown): Issue[] {
  const issues: Issue[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return [{ loc: ['body'], msg: 'Input should be a valid dictionary or object to extract fields from', type: 'model_attributes_type' }];
  }
  const b = body as Record<string, unknown>;
  if (!('state' in b)) issues.push({ loc: ['body', 'state'], msg: 'Field required', type: 'missing' });
  else if (!isJsonContent(b.state)) issues.push({ loc: ['body', 'state'], msg: 'Input should be a valid string, dictionary or list', type: 'union_type' });
  if (!('model' in b)) issues.push({ loc: ['body', 'model'], msg: 'Field required', type: 'missing' });
  else if (typeof b.model !== 'string') issues.push({ loc: ['body', 'model'], msg: 'Input should be a valid string', type: 'string_type' });
  if (!('questions' in b)) {
    issues.push({ loc: ['body', 'questions'], msg: 'Field required', type: 'missing' });
    return issues;
  }
  const qs = b.questions;
  if (qs === null || typeof qs !== 'object' || Array.isArray(qs)) {
    issues.push({ loc: ['body', 'questions'], msg: 'Input should be a valid dictionary', type: 'dict_type' });
    return issues;
  }
  const entries = Object.entries(qs as Record<string, unknown>);
  if (entries.length < 1) issues.push({ loc: ['body', 'questions'], msg: 'Dictionary should have at least 1 item after validation, not 0', type: 'too_short' });
  for (const [name, q] of entries) {
    const loc = ['body', 'questions', name];
    if (q === null || typeof q !== 'object' || Array.isArray(q)) {
      issues.push({ loc, msg: 'Input should be a valid dictionary or object to extract fields from', type: 'model_attributes_type' });
      continue;
    }
    const qq = q as Record<string, unknown>;
    if (!('type' in qq)) {
      issues.push({ loc, msg: "Unable to extract tag using discriminator 'type'", type: 'union_tag_not_found' });
      continue;
    }
    if (qq.type !== 'noul' && qq.type !== 'choice' && qq.type !== 'score') {
      issues.push({ loc, msg: "Input tag does not match any of the expected tags: 'noul', 'choice', 'score'", type: 'union_tag_invalid' });
      continue;
    }
    if ('instructions' in qq && qq.instructions !== null && !isJsonContent(qq.instructions)) {
      issues.push({ loc: [...loc, qq.type, 'instructions'], msg: 'Input should be a valid string, dictionary or list', type: 'union_type' });
    }
    if (qq.type === 'choice') {
      const c = qq.criteria;
      if (!('criteria' in qq)) issues.push({ loc: [...loc, 'choice', 'criteria'], msg: 'Field required', type: 'missing' });
      else if (c === null || typeof c !== 'object' || Array.isArray(c)) issues.push({ loc: [...loc, 'choice', 'criteria'], msg: 'Input should be a valid dictionary', type: 'dict_type' });
      else {
        const labels = Object.keys(c);
        // UNVERIFIED limits: >= 1 label and <= 255 labels (third-party claim). The mock enforces them.
        if (labels.length < 1) issues.push({ loc: [...loc, 'choice', 'criteria'], msg: 'Dictionary should have at least 1 item', type: 'too_short' });
        if (labels.length > 255) issues.push({ loc: [...loc, 'choice', 'criteria'], msg: 'Dictionary should have at most 255 items', type: 'too_long' });
        for (const [label, d] of Object.entries(c)) {
          if (d !== null && !isJsonContent(d)) issues.push({ loc: [...loc, 'choice', 'criteria', label], msg: 'Input should be a valid string, dictionary or list', type: 'union_type' });
        }
      }
    } else if (qq.type === 'score') {
      if (!('criteria' in qq)) issues.push({ loc: [...loc, 'score', 'criteria'], msg: 'Field required', type: 'missing' });
      else if (!Array.isArray(qq.criteria)) issues.push({ loc: [...loc, 'score', 'criteria'], msg: 'Input should be a valid list', type: 'list_type' });
      else if (qq.criteria.length < 1) issues.push({ loc: [...loc, 'score', 'criteria'], msg: 'List should have at least 1 item after validation, not 0', type: 'too_short' });
    } else if ('criteria' in qq && qq.criteria !== null) {
      const c = qq.criteria;
      if (typeof c !== 'object' || Array.isArray(c)) issues.push({ loc: [...loc, 'noul', 'criteria'], msg: 'Input should be a valid dictionary or instance of NoulCriteria', type: 'model_type' });
    }
  }
  return issues;
}

// ───────────────────────────── deterministic heuristics (SIMULATION) ─────────────────────────────

/** Cue words per well-known label (normalized at load). Purely a simulation aid. */
const LABEL_CUES: Record<string, string[]> = {
  seek: ['بدي', 'بدنا', 'محتاج', 'محتاجة', 'بحاجة', 'ابحث', 'عم دور', 'دور على', 'مطلوب', 'اريد', 'بلزمني', 'لازمني', 'مين عنده', 'حدا عنده', 'بشتري', 'اشتري', 'استاجر', 'بستاجر'],
  provide: ['عندي', 'عنا', 'للبيع', 'ببيع', 'بأجر', 'بقدم', 'اقدم', 'بصلح', 'بدرس', 'معروض', 'اعرض', 'متوفر', 'بعرض'],
  join: ['مين بدو', 'حدا بدو', 'مين جاي', 'نروح', 'سوا', 'سوية', 'نلعب', 'نطلع', 'نتمشى', 'مين حابب', 'بدنا ناس', 'ننضم'],
  lte: ['حد اقصى', 'اقصى', 'ما بدفع اكتر', 'ما يزيد', 'لحد', 'او اقل', 'ميزانيتي', 'مو اكتر'],
  gte: ['حد ادنى', 'ما بنزل عن', 'على الاقل', 'او اكتر', 'مو اقل'],
  approx: ['حوالي', 'تقريبا', 'بحدود', 'شي'],
  eq: ['سعرها', 'سعره', 'بسعر', 'السعر'],
  sale: ['للبيع', 'بيع', 'ببيع', 'اشتري', 'بشتري', 'شراء'],
  rent: ['بالشهر', 'شهريا', 'شهري', 'ايجار', 'اجار', 'للايجار', 'استاجر', 'بستاجر', 'بالسنه'],
  service: ['يصلح', 'يزبط', 'تصليح', 'صيانه', 'يركب', 'تركيب', 'ينظف'],
  lesson: ['درس', 'دروس', 'بدرس', 'مدرس', 'استاذ', 'كورس', 'دوره'],
  activity: ['نروح', 'سوا', 'نلعب', 'رحله', 'نطلع'],
  help: ['مساعده', 'ساعدوني', 'تطوع', 'متطوع'],
};
const STRICT_CUES = ['فقط', 'بس', 'حصرا', 'لازم', 'ضروري', 'شرط'];
const PREFER_CUES = ['يفضل', 'بفضل', 'افضل', 'اذا ممكن', 'ياريت', 'قريب', 'او'];

function utteranceOf(state: unknown): string {
  if (typeof state === 'string') return state;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const u = (state as Record<string, unknown>).utterance;
    if (typeof u === 'string') return u;
  }
  return JSON.stringify(state);
}

function textOf(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** variant sets per token (len >= 3) */
function tokenStems(text: string): Set<string>[] {
  return tokenize(normalizeAr(text))
    .map((t) => new Set(tokenVariants(t).filter((v) => v.length >= 3)))
    .filter((s) => s.size > 0);
}

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const s of tokenStems(text)) for (const v of s) out.add(v);
  return out;
}

function countCues(norm: string, cues: string[]): number {
  const padded = ` ${norm} `;
  let n = 0;
  for (const c of cues) {
    const cn = normalizeAr(c);
    if (!cn) continue;
    if (padded.includes(` ${cn} `)) n++;
    // single word: any prefix-stripped variant equals the cue, or starts with it (يزبطلي ~ يزبط) for cues of 4+ letters
    else if (!cn.includes(' ') && tokenize(norm).some((t) => tokenVariants(t).some((v) => v === cn || (cn.length >= 4 && v.startsWith(cn))))) n++;
  }
  return n;
}

/** number of utterance tokens that have at least one variant among the description stems */
function overlap(utterTokens: Set<string>[], desc: Set<string>): number {
  let n = 0;
  for (const tok of utterTokens) if ([...tok].some((v) => desc.has(v))) n++;
  return n;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

function answerChoice(utter: string, criteria: Record<string, unknown>) {
  const norm = normalizeAr(utter);
  const u = tokenStems(utter);
  const labels = Object.keys(criteria);
  const scores = labels.map((label) => {
    const desc = stems(`${label.replace(/[._]/g, ' ')} ${textOf(criteria[label])}`);
    return 3 * countCues(norm, LABEL_CUES[label] ?? []) + overlap(u, desc);
  });
  const weights = scores.map((s) => s + 0.1);
  const total = weights.reduce((a, b) => a + b, 0);
  const probabilities: Record<string, number> = {};
  labels.forEach((l, i) => (probabilities[l] = r4(weights[i]! / total)));
  let best = 0;
  for (let i = 1; i < labels.length; i++) if (scores[i]! > scores[best]!) best = i;
  // no signal at all: abstain via a none-of-the-above label when one is offered
  const abstain = labels.findIndex((l) => l === 'other' || l === 'none');
  if (scores[best] === 0 && abstain >= 0) best = abstain;
  return { type: 'choice', choice: labels[best]!, confidence: probabilities[labels[best]!]!, probabilities };
}

function answerNoul(utter: string, q: Record<string, unknown>) {
  const norm = normalizeAr(utter);
  const u = tokenStems(utter);
  const crit = (q.criteria ?? {}) as Record<string, unknown>;
  const yes = 2 * countCues(norm, STRICT_CUES) + 0.25 * overlap(u, stems(textOf(crit.true)));
  const no = 2 * countCues(norm, PREFER_CUES) + 0.25 * overlap(u, stems(textOf(crit.false)));
  return { type: 'noul', noul: r4(Math.min(0.97, Math.max(0.03, (yes + 0.35) / (yes + no + 1)))) };
}

function answerScore(q: Record<string, unknown>) {
  const levels = (q.criteria as unknown[]).length;
  const probabilities: Record<string, number> = {};
  const legend: Record<string, unknown> = {};
  (q.criteria as unknown[]).forEach((c, i) => {
    probabilities[String(i)] = r4(1 / levels);
    legend[String(i)] = c;
  });
  return { type: 'score', score: (levels - 1) / 2, confidence: r4(1 / levels), legend, probabilities };
}

export function simulateAnswers(body: { state: unknown; questions: Record<string, Record<string, unknown>> }): Record<string, unknown> {
  const utter = utteranceOf(body.state);
  const answers: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(body.questions)) {
    if (q.type === 'choice') answers[name] = answerChoice(utter, q.criteria as Record<string, unknown>);
    else if (q.type === 'noul') answers[name] = answerNoul(utter, q);
    else answers[name] = answerScore(q);
  }
  return answers;
}

// ───────────────────────────── server ─────────────────────────────

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, raw = false) {
  const payload = raw ? String(body) : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'x-jev-simulation': '1', ...headers });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function startJevMock(opts: JevMockOptions = {}): Promise<JevMock> {
  let faults: JevMockFault[] = [...(opts.faults ?? [])];
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let counter = 0;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/.exec(auth);
    const authorized = !!m && (opts.token === undefined || m[1] === opts.token);
    let rawBody = '';
    try {
      rawBody = req.method === 'POST' ? await readBody(req) : '';
    } catch {
      return send(res, 413, { detail: 'Request body too large' });
    }
    let parsed: unknown = undefined;
    let jsonOk = true;
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        jsonOk = false;
      }
    }
    requests.push({
      method: req.method ?? '',
      path,
      authorized,
      retryCount: (req.headers['x-typesafe-retry-count'] as string | undefined) ?? null,
      contentType: (req.headers['content-type'] as string | undefined) ?? null,
      body: parsed,
      at: Date.now(),
    });
    const requestId = `sim-${++counter}`;
    const rid = { 'x-typesafe-request-id': requestId };

    const isSystemOne = path === '/v1/systemone';
    const isModels = path === '/v1/models';
    if (!isSystemOne && !isModels) return send(res, 404, { detail: 'Not Found' }, rid);
    if ((isSystemOne && req.method !== 'POST') || (isModels && req.method !== 'GET')) return send(res, 405, { detail: 'Method Not Allowed' }, rid);
    if (!authorized) return send(res, 401, { detail: 'Invalid or missing API key' }, rid);

    if (opts.latencyMs) await sleep(opts.latencyMs);
    const fault = faults.shift();
    if (fault) {
      switch (fault.kind) {
        case 'latency':
          await sleep(fault.ms);
          break;
        case 'status':
          return send(res, fault.status, fault.body ?? { detail: `simulated ${fault.status}` }, { ...rid, ...(fault.headers ?? {}) });
        case 'rate_limit': {
          const h: Record<string, string> = { ...rid };
          if (fault.retryAfterMs !== undefined) h['retry-after-ms'] = String(fault.retryAfterMs);
          if (fault.retryAfterSec !== undefined) h['retry-after'] = String(fault.retryAfterSec);
          return send(res, 429, { detail: 'Rate limit exceeded' }, h);
        }
        case 'server_error':
          return send(res, fault.status ?? 500, { detail: 'Internal Server Error' }, rid);
        case 'unauthorized':
          return send(res, 401, { detail: 'Invalid or missing API key' }, rid);
        case 'hang':
          return; // never answer; the socket is destroyed on close()
        case 'drop':
          req.socket.destroy();
          return;
        default:
          break; // answer-level faults handled below
      }
    }

    if (isModels) {
      return send(res, 200, { models: [{ name: 'jev-latest', description: 'SIMULATION — local mock of the Jev System One API (not the real model)', release_date: '1970-01-01' }] }, rid);
    }
    if (!jsonOk) return send(res, 422, { detail: [{ loc: ['body', 0], msg: 'JSON decode error', type: 'json_invalid' }] }, rid);
    const issues = validateRequest(parsed);
    if (issues.length) return send(res, 422, { detail: issues }, rid);

    const body = parsed as { state: unknown; model: string; questions: Record<string, Record<string, unknown>> };
    if (fault?.kind === 'malformed') return send(res, 200, '{"model":"jev-sim","answers":{', rid, true);
    const answers = simulateAnswers(body);
    const names = Object.keys(answers);
    const target = (f: { question?: string }) => f.question ?? names[0]!;
    if (fault?.kind === 'missing_answer') delete answers[target(fault)];
    if (fault?.kind === 'wrong_label') {
      const a = answers[target(fault)] as Record<string, unknown>;
      if (a.type === 'choice') a.choice = '__not_offered__';
      else a.type = 'choice';
    }
    if (fault?.kind === 'wrong_type') {
      const a = answers[target(fault)] as Record<string, unknown>;
      a.type = a.type === 'noul' ? 'score' : 'noul';
    }
    if (fault?.kind === 'out_of_range') {
      const a = answers[target(fault)] as Record<string, unknown>;
      if (a.type === 'noul') a.noul = 1.5;
      else a.confidence = -0.2;
    }
    const inputTokens = Math.ceil(rawBody.length / 4);
    return send(res, 200, { model: SIM_MODEL, answers, usage: { input_tokens: inputTokens, output_tokens: names.length * 2 } }, rid);
  });

  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const host = opts.host ?? '127.0.0.1';

  return {
    url: `http://${host}:${port}`,
    port,
    requests,
    setFaults(f) {
      faults = [...f];
    },
    pushFaults(...f) {
      faults.push(...f);
    },
    reset() {
      faults = [];
      requests.length = 0;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// standalone
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 8787;
  const mock = await startJevMock({ port });
  console.log(`Jev SIMULATION mock listening on ${mock.url} (not the real API). Use JEV_MODE=simulate TYPESAFE_BASE_URL=${mock.url}`);
}
