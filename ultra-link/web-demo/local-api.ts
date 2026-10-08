// In-browser backend for the Ultra Link demo edition.
// Implements the same /api/* contract as src/server/app.ts (docs/CONTRACTS.md) on top of the SAME
// understanding, conversation, validation and matching modules — only storage differs: an in-memory
// store persisted to this browser's localStorage, seeded with the same synthetic dataset as PostgreSQL.
// Never contains secrets: Jev is not called from the browser (the key must stay on a server).

import { seedRegistry } from '../src/domain/registry.ts';
import { attributesFor } from '../src/domain/registry.ts';
import { validateSpec } from '../src/domain/validate.ts';
import type { IntentSpec, Question, Side } from '../src/domain/types.ts';
import { applyTurn, emptyDraft, recordAsked, summarize, titleOf, type ConversationDraft } from '../src/conversation/engine.ts';
import { evaluatePair } from '../src/matching/evaluate.ts';
import { expiryFor, intentToSpec, rowToMatchable, specToColumns, toCard, type IntentRow } from '../src/repo/intents.ts';
import { buildDemoDataset, counterpartFor, PERSONAS } from '../src/seed/demo-data.ts';

const reg = seedRegistry();
const STORE_KEY = 'ultra-link-demo-v1';

interface User { id: string; publicId: string; displayName: string; realm: 'real' | 'synthetic'; handle: string | null; persona: string | null; phone: string | null }
interface MatchRec {
  id: string; publicId: string; verticalId: number; kind: 'exchange' | 'peer'; a: string; b: string; aUser: string; bUser: string;
  state: 'confirmed' | 'possible' | 'invalidated'; score: number; reasons: unknown[]; missing: string[]; aVersion: number; bVersion: number;
  invalidReasonAr: string | null; firstAt: string; updatedAt: string;
}
interface Notif { id: string; recipient: string; kind: string; titleAr: string; bodyAr: string | null; payload: Record<string, unknown>; dedupe: string; createdAt: string; readAt: string | null }
interface Contact { id: string; matchId: string; requester: string; recipient: string; status: 'pending' | 'accepted' | 'declined'; createdAt: string }
interface Run { intentId: string; version: number; candidates: number; confirmed: number; possible: number; excluded: number; exclusions: { code: string; count: number; textAr: string }[] }
interface Conv { publicId: string; userId: string; state: 'collecting' | 'asking' | 'saved' | 'cancelled'; draft: ConversationDraft; pending: Question | null; turnResults: Record<string, unknown>; updatedAt: string; intentId?: string }
interface State { seq: number; session: string | null; users: User[]; intents: IntentRow[]; matches: MatchRec[]; notifications: Notif[]; contacts: Contact[]; runs: Run[]; conversations: Conv[]; seededAt: string }

let S: State;
const listeners = new Set<(type: string, data: unknown) => void>();

// ───────────── persistence ─────────────
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* storage unavailable: keep in memory */ } }
function load(): State | null {
  try { const raw = localStorage.getItem(STORE_KEY); return raw ? (JSON.parse(raw) as State) : null; } catch { return null; }
}
const nextId = () => String(++S.seq);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-4000-8000-${Math.random().toString(16).slice(2, 14)}`);
const nowIso = () => new Date().toISOString();

export function resetDemo(): void {
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  init(true);
}

export function init(force = false): void {
  const prev = force ? null : load();
  if (prev && prev.intents?.length) { S = prev; return; }
  S = { seq: 0, session: null, users: [], intents: [], matches: [], notifications: [], contacts: [], runs: [], conversations: [], seededAt: nowIso() };
  const now = Date.now();
  const { users, items } = buildDemoDataset(reg, now);
  const byHandle = new Map<string, string>();
  for (const u of users) {
    const id = nextId();
    byHandle.set(u.handle, id);
    S.users.push({ id, publicId: uuid(), displayName: u.name, realm: 'synthetic', handle: u.handle, persona: u.persona, phone: u.phone });
  }
  for (const it of items) createIntent(byHandle.get(it.owner)!, 'synthetic', it.spec, `${it.title} (تجريبي)`, new Date(now - it.ageHours * 3600_000));
  for (const row of [...S.intents]) matchIntent(row.id, 'seed');
  save();
}

// ───────────── intents ─────────────
function createIntent(userId: string, realm: 'real' | 'synthetic', spec: IntentSpec, titleAr: string, createdAt = new Date()): IntentRow {
  const c = specToColumns(reg, spec);
  const id = nextId();
  const iso = createdAt.toISOString();
  const row: IntentRow = {
    id, vertical_id: c.vertical_id, public_id: uuid(), user_id: userId, realm, side: c.side, category_id: c.category_id, deal_type_id: c.deal_type_id,
    status: 'active', version: 1, title_ar: titleAr, source_text: null, point_place_id: c.point_place_id, scope_strength: c.scope_strength,
    scope_place_ids: c.scope_place_ids, price_op: c.price_op, price_lo: c.price_lo, price_hi: c.price_hi, currency: c.currency, price_unit: c.price_unit,
    price_strength: c.price_strength, negotiable: c.negotiable, when_from: c.when_from, when_to: c.when_to, when_strength: c.when_strength, when_label_ar: c.when_label_ar,
    attrs: c.attrs as IntentRow['attrs'], constraints: c.constraints as IntentRow['constraints'], expires_at: expiryFor(spec, createdAt).toISOString(),
    created_at: iso, updated_at: iso, created_key: `${iso}#${id.padStart(9, '0')}`,
  };
  S.intents.push(row);
  return row;
}
const intentById = (id: string) => S.intents.find((i) => i.id === id);
const intentByPublic = (pid: string) => S.intents.find((i) => i.public_id === pid);

// ───────────── matching (same evaluator as the server; brute force over this small store) ─────────────
function matchIntent(intentId: string, trigger: 'interactive' | 'seed' | 'job' | 'edit' | 'status'): Run {
  const row = intentById(intentId)!;
  const me = rowToMatchable(reg, row);
  const run: Run = { intentId, version: row.version, candidates: 0, confirmed: 0, possible: 0, excluded: 0, exclusions: [] };
  const agg = new Map<string, { count: number; textAr: string }>();
  const mine = S.matches.filter((m) => m.a === intentId || m.b === intentId);
  if (row.status !== 'active') {
    for (const m of mine) if (m.state !== 'invalidated') { m.state = 'invalidated'; m.invalidReasonAr = row.status === 'paused' ? 'الطلب موقوف مؤقتًا' : row.status === 'expired' ? 'انتهت صلاحية الطلب' : 'الطلب مغلق'; m.updatedAt = nowIso(); emit(m.aUser, 'match_update'); emit(m.bUser, 'match_update'); }
    upsertRun(run);
    return run;
  }
  const counterSide: Side = me.side === 'join' ? 'join' : me.side === 'seek' ? 'provide' : 'seek';
  // same candidate pool as the server's retrieval: same realm/vertical/deal, compatible category (ancestor or descendant)
  const cat = reg.categoryById.get(row.category_id)!;
  const catSet = new Set([...cat.ancestors, ...cat.descendants]);
  const others = S.intents.filter((o) => o.id !== intentId && o.vertical_id === row.vertical_id && o.realm === row.realm && o.side === counterSide
    && o.deal_type_id === row.deal_type_id && catSet.has(o.category_id) && o.user_id !== row.user_id
    && (o.status === 'active' || mine.some((m) => m.a === o.id || m.b === o.id)));
  for (const o of others) {
    const other = rowToMatchable(reg, o);
    const v = evaluatePair(reg, me, other);
    run.candidates++;
    const peer = me.side === 'join';
    const [a, b] = peer ? (Number(me.id) < Number(other.id) ? [me, other] : [other, me]) : me.side === 'seek' ? [me, other] : [other, me];
    const prev = S.matches.find((m) => m.a === a.id && m.b === b.id);
    if (v.verdict === 'excluded') {
      run.excluded++;
      const code = v.exclusion?.code ?? 'excluded';
      const g = agg.get(code) ?? { count: 0, textAr: EXCLUSION_AR[code] ?? v.exclusion?.text ?? '' };
      g.count++; agg.set(code, g);
      if (prev && prev.state !== 'invalidated') { prev.state = 'invalidated'; prev.invalidReasonAr = v.exclusion?.text ?? 'لم تعد مطابقة'; prev.aVersion = a.version; prev.bVersion = b.version; prev.updatedAt = nowIso(); emit(a.userId, 'match_update'); emit(b.userId, 'match_update'); }
      continue;
    }
    const state = v.verdict === 'match' ? 'confirmed' : 'possible';
    run[state]++;
    if (prev) Object.assign(prev, { state, score: v.score, reasons: v.reasons, missing: v.missing, aVersion: a.version, bVersion: b.version, invalidReasonAr: null, updatedAt: nowIso() });
    else S.matches.push({ id: nextId(), publicId: uuid(), verticalId: row.vertical_id, kind: peer ? 'peer' : 'exchange', a: a.id, b: b.id, aUser: a.userId, bUser: b.userId, state, score: v.score, reasons: v.reasons, missing: v.missing, aVersion: a.version, bVersion: b.version, invalidReasonAr: null, firstAt: nowIso(), updatedAt: nowIso() });
    if ((!prev || prev.state === 'invalidated') && trigger !== 'seed') {
      const m = S.matches.find((x) => x.a === a.id && x.b === b.id)!;
      for (const [rec, mineI, theirs] of [[a, a, b], [b, b, a]] as const) {
        if (trigger === 'interactive' && rec.userId === me.userId) continue;
        notify(rec.userId, state === 'confirmed' ? 'match_new' : 'match_possible', state === 'confirmed' ? 'مطابقة جديدة مناسبة' : 'مطابقة محتملة تحتاج تأكيد', `«${intentById(theirs.id)!.title_ar}» يناسب «${intentById(mineI.id)!.title_ar}»`, { matchId: m.publicId }, `match:${a.id}:${b.id}`);
      }
    }
  }
  run.exclusions = [...agg.entries()].map(([code, g]) => ({ code, count: g.count, textAr: g.textAr })).sort((x, y) => y.count - x.count);
  upsertRun(run);
  return run;
}
function upsertRun(run: Run) { S.runs = S.runs.filter((r) => !(r.intentId === run.intentId && r.version === run.version)); S.runs.push(run); }

const EXCLUSION_AR: Record<string, string> = {
  place_out_of_scope: 'خارج المكان الذي اشترطته', place_excluded: 'في مكان استثنيته', price_above_max: 'أعلى من حد السعر',
  price_below_min: 'أقل من الحد الأدنى للسعر', price_not_exact: 'السعر لا يساوي المطلوب بالضبط', attr_violation: 'لا يحقق شرطًا ملزمًا',
  date_no_overlap: 'موعد مختلف', deal_mismatch: 'نوع عملية مختلف', category_mismatch: 'صنف مختلف', side_mismatch: 'نفس الدور', same_owner: 'من نفس الحساب', inactive: 'غير نشط',
};
const MISSING_AR: Record<string, string> = { price: 'السعر', 'price.currency': 'عملة السعر', 'price.unit': 'وحدة السعر (شهري/سنوي…)', place: 'المكان', when: 'الموعد' };

function notify(recipient: string, kind: string, titleAr: string, bodyAr: string | null, payload: Record<string, unknown>, dedupe: string) {
  if (S.notifications.some((n) => n.recipient === recipient && n.dedupe === dedupe)) return; // never duplicated
  S.notifications.push({ id: uuid(), recipient, kind, titleAr, bodyAr, payload, dedupe, createdAt: nowIso(), readAt: null });
  emit(recipient, 'notification');
}

function emit(userId: string, type: string) {
  if (userId !== S.session) return;
  queueMicrotask(() => { for (const l of listeners) { l(type, counts(userId)); if (type !== 'counts') l('counts', counts(userId)); } });
}
export function onEvent(fn: (type: string, data: unknown) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

// ───────────── views ─────────────
function counts(userId: string) {
  return {
    requests: S.intents.filter((i) => i.user_id === userId && (i.side === 'seek' || i.side === 'join') && (i.status === 'active' || i.status === 'paused')).length,
    offers: S.intents.filter((i) => i.user_id === userId && i.side === 'provide' && (i.status === 'active' || i.status === 'paused')).length,
    matches: S.matches.filter((m) => (m.aUser === userId || m.bUser === userId) && m.state !== 'invalidated').length,
    unread: S.notifications.filter((n) => n.recipient === userId && !n.readAt).length,
  };
}
function matchCounts(intentId: string) {
  const ms = S.matches.filter((m) => m.a === intentId || m.b === intentId);
  return { confirmed: ms.filter((m) => m.state === 'confirmed').length, possible: ms.filter((m) => m.state === 'possible').length };
}
function card(row: IntentRow, withSpec = false) { return toCard(reg, row, matchCounts(row.id), withSpec); }
function matchCard(m: MatchRec, userId: string) {
  const iAmA = m.aUser === userId;
  const mine = intentById(iAmA ? m.a : m.b)!;
  const other = intentById(iAmA ? m.b : m.a)!;
  const c = S.contacts.find((x) => x.matchId === m.id && (x.requester === userId || x.recipient === userId));
  let contact: Record<string, unknown> = { status: 'none' };
  if (c) {
    const out = c.requester === userId;
    contact = { status: c.status === 'pending' ? (out ? 'pending_out' : 'pending_in') : c.status, requestId: c.id };
    if (c.status === 'accepted') { const u = S.users.find((x) => x.id === (out ? c.recipient : c.requester))!; contact.counterpart = { displayName: u.displayName, phone: u.phone ?? undefined }; }
  }
  const defs = attributesFor(reg, reg.categoryById.get(other.category_id)!.code);
  return {
    id: m.publicId, state: m.state, score: m.score, kind: m.kind, mine: card(mine), other: card(other), reasons: m.reasons,
    missing: m.missing.map((k) => MISSING_AR[k] ?? (k.startsWith('attr.') ? defs.find((d) => d.key === k.slice(5))?.labelAr ?? k.slice(5) : k)),
    missingKeys: m.missing, contact, updatedAt: m.updatedAt, invalidReasonAr: m.invalidReasonAr ?? undefined,
  };
}
/** Offset pagination with exact totals (the demo store is small; the server uses keyset cursors). */
function page<T>(all: T[], q: URLSearchParams, def = 20) {
  const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || def));
  const offset = Math.max(0, Number(q.get('cursor') ? atob(q.get('cursor')!) : 0) || 0);
  const items = all.slice(offset, offset + limit);
  return {
    items, total: all.length, limit,
    nextCursor: offset + limit < all.length ? btoa(String(offset + limit)) : null,
    prevCursor: offset > 0 ? btoa(String(Math.max(0, offset - limit))) : null,
    rangeStart: items.length ? offset + 1 : 0, rangeEnd: items.length ? offset + items.length : 0,
  };
}

// ───────────── HTTP-shaped handler ─────────────
export class LocalError extends Error { status: number; code: string; constructor(status: number, code: string, msg: string) { super(msg); this.status = status; this.code = code; } }
const fail = (status: number, code: string, msg: string): never => { throw new LocalError(status, code, msg); };

export async function handle(method: string, url: string, body: any): Promise<{ status: number; json: unknown }> {
  try { return { status: 200, json: await route(method, url, body ?? {}) }; }
  catch (e) {
    if (e instanceof LocalError) return { status: e.status, json: { error: e.code, messageAr: e.message } };
    console.error(e);
    return { status: 500, json: { error: 'internal', messageAr: 'صار خطأ في النسخة التجريبية. جرّب «إعادة ضبط البيانات».' } };
  } finally { save(); }
}

function me(): User { const u = S.users.find((x) => x.id === S.session); if (!u) fail(401, 'unauthorized', 'سجّل الدخول أولًا'); return u!; }
const publicUser = (u: User) => ({ publicId: u.publicId, displayName: u.displayName, realm: u.realm });

async function route(method: string, url: string, body: any): Promise<unknown> {
  const u = new URL(url, 'http://local');
  const p = u.pathname;
  const q = u.searchParams;
  let m: RegExpMatchArray | null;

  if (method === 'GET' && p === '/api/session') return { user: S.session ? publicUser(me()) : null };
  if (method === 'GET' && p === '/api/ai/status') return { mode: 'rules', keyConfigured: false, verified: false, model: null, labelAr: 'نسخة المتصفح — المحلّل المحلي (Jev يعمل فقط على الخادم)' };
  if (method === 'GET' && p === '/api/personas') return { items: PERSONAS.map((x) => ({ handle: x.handle, displayName: x.name, descriptionAr: x.persona })) };
  if (method === 'GET' && p === '/api/taxonomy') return {
    categories: reg.categories.filter((c) => c.depth > 0).map((c) => ({ code: c.code, labelAr: c.nameAr, deals: c.deals, vertical: c.verticalCode })),
    places: reg.places.filter((x) => x.kind !== 'world').map((x) => ({ id: x.id, labelAr: x.nameAr, kind: x.kind, depth: x.depth })),
  };
  if (method === 'POST' && p === '/api/auth/demo-login') {
    const user = S.users.find((x) => x.handle === body.handle && x.persona);
    if (!user) fail(404, 'not_found', 'الشخصية غير موجودة');
    S.session = user!.id;
    return { user: publicUser(user!) };
  }
  if (method === 'POST' && p === '/api/auth/register') {
    const name = String(body.displayName ?? '').trim().slice(0, 80);
    if (!name) fail(400, 'bad_request', 'اكتب اسمك');
    // in the browser edition every account is synthetic: there are no real users here
    const user: User = { id: nextId(), publicId: uuid(), displayName: name, realm: 'synthetic', handle: null, persona: null, phone: body.phone ? String(body.phone).slice(0, 30) : null };
    S.users.push(user);
    S.session = user.id;
    return { user: publicUser(user) };
  }
  if (method === 'POST' && p === '/api/auth/logout') { S.session = null; return { ok: true }; }

  const user = me();
  if (method === 'GET' && p === '/api/me') return { user: publicUser(user), counts: counts(user.id) };

  // conversations
  if (method === 'POST' && p === '/api/conversations') {
    for (const c of S.conversations) if (c.userId === user.id && (c.state === 'collecting' || c.state === 'asking')) c.state = 'cancelled';
    const c: Conv = { publicId: uuid(), userId: user.id, state: 'collecting', draft: emptyDraft(), pending: null, turnResults: {}, updatedAt: nowIso() };
    S.conversations.push(c);
    return { conversation: { id: c.publicId, state: c.state, turns: 0 } };
  }
  if (method === 'GET' && p === '/api/conversations/current') {
    const c = [...S.conversations].reverse().find((x) => x.userId === user.id && (x.state === 'collecting' || x.state === 'asking'));
    return { conversation: c ? { id: c.publicId, state: c.state, turns: c.draft.turns, question: c.pending, summary: summarize(reg, c.draft) } : null };
  }
  if ((m = p.match(/^\/api\/conversations\/([\w-]+)\/turns$/)) && method === 'POST') return turn(user, m[1]!, body);
  if ((m = p.match(/^\/api\/conversations\/([\w-]+)\/cancel$/)) && method === 'POST') {
    const c = S.conversations.find((x) => x.publicId === m![1] && x.userId === user.id);
    if (!c) fail(404, 'not_found', 'المحادثة غير موجودة');
    c!.state = 'cancelled';
    return { conversation: { id: c!.publicId, state: c!.state } };
  }

  // intents
  if (method === 'GET' && p === '/api/intents') {
    const side = q.get('side');
    const sides = side === 'offers' || side === 'provide' ? ['provide'] : side === 'seek' ? ['seek'] : side === 'join' ? ['join'] : ['seek', 'join'];
    const statuses = q.get('status') ? q.get('status')!.split(',') : ['active', 'paused', 'fulfilled', 'closed', 'expired'];
    const all = S.intents.filter((i) => i.user_id === user.id && sides.includes(i.side) && statuses.includes(i.status)).sort((a, b) => b.created_key.localeCompare(a.created_key));
    const pg = page(all, q);
    return { ...pg, items: pg.items.map((r) => card(r)) };
  }
  const own = (pid: string) => { const r = intentByPublic(pid); if (!r || r.user_id !== user.id) fail(404, 'not_found', 'غير موجود'); return r!; };
  if ((m = p.match(/^\/api\/intents\/([\w-]+)$/)) && method === 'GET') return { intent: card(own(m[1]!), true) };
  if ((m = p.match(/^\/api\/intents\/([\w-]+)$/)) && method === 'PATCH') {
    const row = own(m[1]!);
    if (body.expectedVersion !== row.version) fail(409, 'version_conflict', 'تغيّر الطلب من مكان آخر. حدّث الصفحة.');
    const merged = { ...intentToSpec(reg, row), ...(body.changes ?? {}) } as IntentSpec;
    const v = validateSpec(reg, merged);
    if (!v.ok) fail(422, 'invalid_spec', `تعديل غير صالح: ${v.issues.map((i) => i.code).join('، ')}`);
    const spec = (v as { ok: true; spec: IntentSpec }).spec;
    const c = specToColumns(reg, spec);
    if (c.vertical_id !== row.vertical_id) fail(422, 'vertical_change', 'لا يمكن تغيير القطاع');
    const title = titleOf(reg, { side: spec.side, category: spec.categoryCode, deal: spec.deal, placeIds: spec.side === 'seek' ? spec.place.scopePlaceIds : spec.place.pointPlaceId != null ? [spec.place.pointPlaceId] : [], whenLabel: spec.when?.label });
    Object.assign(row, {
      side: c.side, category_id: c.category_id, deal_type_id: c.deal_type_id, point_place_id: c.point_place_id, scope_strength: c.scope_strength, scope_place_ids: c.scope_place_ids,
      price_op: c.price_op, price_lo: c.price_lo, price_hi: c.price_hi, currency: c.currency, price_unit: c.price_unit, price_strength: c.price_strength, negotiable: c.negotiable,
      when_from: c.when_from, when_to: c.when_to, when_strength: c.when_strength, when_label_ar: c.when_label_ar, attrs: c.attrs, constraints: c.constraints,
      title_ar: row.realm === 'synthetic' && user.persona ? `${title} (تجريبي)` : title, version: row.version + 1, updated_at: nowIso(),
    });
    const run = matchIntent(row.id, 'edit');
    const inv = S.matches.filter((x) => (x.a === row.id || x.b === row.id) && x.state === 'invalidated').length;
    return { intent: card(row, true), run: { totals: { confirmed: run.confirmed, possible: run.possible, excluded: run.excluded, candidates: run.candidates }, invalidated: inv } };
  }
  if ((m = p.match(/^\/api\/intents\/([\w-]+)\/status$/)) && method === 'POST') {
    const row = own(m[1]!);
    const t: Record<string, [string[], string]> = { pause: [['active'], 'paused'], resume: [['paused'], 'active'], fulfill: [['active', 'paused'], 'fulfilled'], close: [['active', 'paused'], 'closed'] };
    const tr = t[body.action];
    if (!tr || !tr[0].includes(row.status)) fail(409, 'invalid_transition', 'لا يمكن تنفيذ هذا الإجراء على حالته الحالية');
    row.status = tr![1]; row.version++; row.updated_at = nowIso();
    const before = S.matches.filter((x) => (x.a === row.id || x.b === row.id) && x.state !== 'invalidated').length;
    matchIntent(row.id, 'status');
    const after = S.matches.filter((x) => (x.a === row.id || x.b === row.id) && x.state !== 'invalidated').length;
    return { intent: card(row), run: { invalidated: Math.max(0, before - after) } };
  }
  if ((m = p.match(/^\/api\/intents\/([\w-]+)\/match$/)) && method === 'POST') {
    const row = own(m[1]!);
    let run = S.runs.find((r) => r.intentId === row.id && r.version === row.version);
    if (!run) run = matchIntent(row.id, 'interactive');
    const list = S.matches.filter((x) => (x.a === row.id || x.b === row.id) && x.state !== 'invalidated').sort((a, b) => b.score - a.score);
    const pg = page(list, q, 10);
    const suggestionsAr: string[] = [];
    if (run.confirmed + run.possible === 0) {
      if (run.exclusions.some((e) => e.code === 'place_out_of_scope') && row.scope_place_ids.length) {
        const pl = reg.placeById.get(row.scope_place_ids[0]!)!;
        const parent = pl.parent ? reg.placeByCode.get(pl.parent) : undefined;
        if (parent && parent.kind !== 'world') suggestionsAr.push(`وسّع المكان إلى ${parent.nameAr}`);
      }
      if (run.exclusions.some((e) => e.code === 'price_above_max')) suggestionsAr.push('ارفع الحد الأقصى للسعر قليلًا');
      if (run.exclusions.some((e) => e.code === 'attr_violation')) suggestionsAr.push('اجعل بعض الشروط تفضيلات بدل شروط ملزمة');
    }
    return { intentId: row.public_id, version: row.version, status: 'done', totals: { confirmed: run.confirmed, possible: run.possible, excluded: run.excluded, candidates: run.candidates }, exclusions: run.exclusions, truncated: false, page: { ...pg, items: pg.items.map((x) => matchCard(x, user.id)) }, suggestionsAr };
  }

  // matches
  if (method === 'GET' && p === '/api/matches') {
    const st = q.get('state');
    const states = st === 'invalidated' ? ['invalidated'] : st === 'confirmed' ? ['confirmed'] : st === 'possible' ? ['possible'] : st === 'all' ? ['confirmed', 'possible', 'invalidated'] : ['confirmed', 'possible'];
    let list = S.matches.filter((x) => (x.aUser === user.id || x.bUser === user.id) && states.includes(x.state));
    if (q.get('intent')) { const r = own(q.get('intent')!); list = list.filter((x) => x.a === r.id || x.b === r.id); }
    list.sort((a, b) => b.score - a.score || Number(b.id) - Number(a.id));
    const pg = page(list, q);
    return { ...pg, items: pg.items.map((x) => matchCard(x, user.id)) };
  }
  if ((m = p.match(/^\/api\/matches\/([\w-]+)\/contact$/)) && method === 'POST') {
    const mt = S.matches.find((x) => x.publicId === m![1] && (x.aUser === user.id || x.bUser === user.id));
    if (!mt) fail(404, 'not_found', 'غير موجود');
    if (mt!.state === 'invalidated') fail(409, 'match_invalidated', 'هذه المطابقة لم تعد صالحة');
    const other = mt!.aUser === user.id ? mt!.bUser : mt!.aUser;
    let c = S.contacts.find((x) => x.matchId === mt!.id && x.requester === user.id);
    if (!c) { c = { id: uuid(), matchId: mt!.id, requester: user.id, recipient: other, status: 'pending', createdAt: nowIso() }; S.contacts.push(c); }
    // demo only: the synthetic counterpart accepts after a few seconds (clearly announced)
    const counterpart = S.users.find((x) => x.id === other)!;
    if (!counterpart.persona || counterpart.handle === 'layla') {
      const cid = c.id;
      setTimeout(() => {
        const cc = S.contacts.find((x) => x.id === cid);
        if (!cc || cc.status !== 'pending') return;
        cc.status = 'accepted';
        notify(user.id, 'contact_accepted', 'تمت الموافقة على التواصل', 'قبول تلقائي في النسخة التجريبية — افتح المطابقة لترى الاسم والرقم (وهمي).', { matchId: mt!.publicId }, `contact-reply:${cid}`);
        emit(user.id, 'match_update');
        save();
      }, 3000);
    }
    return { contactRequest: { id: c.id, status: c.status } };
  }
  if ((m = p.match(/^\/api\/contact-requests\/([\w-]+)\/respond$/)) && method === 'POST') {
    const c = S.contacts.find((x) => x.id === m![1] && x.recipient === user.id && x.status === 'pending');
    if (!c) fail(404, 'not_found', 'الطلب غير موجود أو تمت الإجابة عليه');
    c!.status = body.accept ? 'accepted' : 'declined';
    return { contactRequest: { id: c!.id, status: c!.status } };
  }

  // notifications (recipient only)
  if (method === 'GET' && p === '/api/notifications') {
    const all = S.notifications.filter((n) => n.recipient === user.id && (q.get('unread') !== '1' || !n.readAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const pg = page(all, q);
    return { ...pg, items: pg.items.map((n) => ({ id: n.id, kind: n.kind, titleAr: n.titleAr, bodyAr: n.bodyAr, payload: n.payload, createdAt: n.createdAt, readAt: n.readAt })), unread: counts(user.id).unread };
  }
  if ((m = p.match(/^\/api\/notifications\/([\w-]+)\/read$/)) && method === 'POST') {
    const n = S.notifications.find((x) => x.id === m![1] && x.recipient === user.id);
    if (!n) fail(404, 'not_found', 'غير موجود');
    n!.readAt ??= nowIso();
    emit(user.id, 'counts');
    return { ok: true };
  }
  if (method === 'POST' && p === '/api/notifications/read-all') {
    let k = 0; for (const n of S.notifications) if (n.recipient === user.id && !n.readAt) { n.readAt = nowIso(); k++; }
    emit(user.id, 'counts');
    return { ok: true, updated: k };
  }

  // demo: a counterpart arrives later (the "worker" runs after a short delay, like the server's queue)
  if (method === 'POST' && p === '/api/demo/simulate') {
    const target = [...S.intents].reverse().find((i) => i.user_id === user.id && i.status === 'active' && (i.side === 'seek' || i.side === 'join') && matchCounts(i.id).confirmed + matchCounts(i.id).possible === 0);
    if (!target) fail(404, 'nothing_to_simulate', 'لا يوجد طلب نشط بدون مطابقات. احفظ طلبًا أولًا.');
    const spec = counterpartFor(reg, intentToSpec(reg, target!));
    const v = spec ? validateSpec(reg, spec) : null;
    if (!v || !v.ok) fail(422, 'cannot_simulate', 'تعذّر إنشاء عرض مطابق لهذا الطلب');
    const owner = S.users.find((x) => x.handle === 'syn_owner_001')!;
    const sp = (v as { ok: true; spec: IntentSpec }).spec;
    const row = createIntent(owner.id, 'synthetic', sp, `${titleOf(reg, { side: sp.side, category: sp.categoryCode, deal: sp.deal, placeIds: sp.place.pointPlaceId ? [sp.place.pointPlaceId] : [], whenLabel: sp.when?.label })} (تجريبي — محاكاة)`);
    setTimeout(() => { matchIntent(row.id, 'job'); save(); }, 1500);
    return { created: { id: row.public_id }, noteAr: 'أُضيف عرض تجريبي جديد. سيصلك تنبيه بعد لحظات عندما يُطابَق في الخلفية.' };
  }

  return fail(404, 'not_found', 'المسار غير موجود في النسخة التجريبية');
}

function turn(user: User, convId: string, body: any) {
  const c = S.conversations.find((x) => x.publicId === convId && x.userId === user.id);
  if (!c) return fail(404, 'not_found', 'المحادثة غير موجودة');
  const turnId = typeof body.clientTurnId === 'string' ? body.clientTurnId : '';
  if (turnId && c.turnResults[turnId]) return c.turnResults[turnId];
  if (c.state === 'saved' || c.state === 'cancelled') fail(409, 'conversation_closed', 'هذه المحادثة انتهت. ابدأ طلبًا جديدًا.');
  const text = String(body.text ?? '').trim();
  if (!text || text.length > 1000) fail(422, 'bad_text', 'النص فارغ أو طويل جدًا');
  const t0 = performance.now();
  const geo = body.geo && Number.isFinite(body.geo.lat) && Number.isFinite(body.geo.lng) ? body.geo : null;
  const out = applyTurn(reg, { ...emptyDraft(), ...c.draft }, { text, answering: c.pending, geo });
  const understanding = { engine: 'rules', latencyMs: Math.round(performance.now() - t0) };
  const conv = (state: Conv['state']) => ({ id: c.publicId, state, turns: out.draft.turns });
  let result: Record<string, unknown>;
  if (out.next.kind === 'ask') {
    recordAsked(out.draft, out.next.question);
    c.draft = out.draft; c.pending = out.next.question; c.state = 'asking';
    result = { conversation: conv('asking'), action: 'ask', question: out.next.question, summary: summarize(reg, out.draft), understanding };
  } else if (out.next.kind === 'unclear') {
    c.draft = out.draft; c.pending = null; c.state = 'collecting';
    result = { conversation: conv('collecting'), action: 'unclear', messageAr: out.next.messageAr, summary: summarize(reg, out.draft), understanding };
  } else {
    const v = validateSpec(reg, out.next.spec);
    if (!v.ok) {
      c.draft = out.draft; c.state = 'collecting';
      result = { conversation: conv('collecting'), action: 'unclear', messageAr: 'ما قدرت أتحقق من كل التفاصيل. جرّب تحكيها بطريقة تانية.', summary: summarize(reg, out.draft), understanding };
    } else {
      const spec = v.spec;
      const defs = attributesFor(reg, spec.categoryCode);
      const key = ['subject', 'appliance', 'make'].map((k) => { const val = spec.attrs[k] ?? spec.constraints.find((x) => x.key === k && x.op === 'eq')?.value; return val === undefined ? null : defs.find((d) => d.key === k)?.values?.find((x) => x.code === val)?.labelAr ?? null; }).find(Boolean);
      const base = titleOf(reg, out.draft);
      const row = createIntent(user.id, user.realm, spec, key ? `${base} (${key})` : base);
      row.source_text = text;
      c.draft = out.draft; c.pending = null; c.state = 'saved'; c.intentId = row.id;
      result = { conversation: conv('saved'), action: 'saved', summary: summarize(reg, out.draft), intent: card(row), understanding };
    }
  }
  c.updatedAt = nowIso();
  if (turnId) c.turnResults[turnId] = result;
  return result;
}
