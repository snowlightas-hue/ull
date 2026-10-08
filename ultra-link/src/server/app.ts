// HTTP API + static frontend. Every data route is scoped to the session user (isolation by construction).
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import pg from 'pg';
import { z } from 'zod';
import { ROOT } from '../lib/env.ts';
import { withTx } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import { validateSpec } from '../domain/validate.ts';
import type { IntentSpec } from '../domain/types.ts';
import { getJevStatus } from '../ai/index.ts';
import { cancelConversation, currentConversation, handleTurn, HttpError, startConversation } from '../conversation/service.ts';
import { titleOf } from '../conversation/engine.ts';
import { counterpartFor, PERSONAS } from '../seed/demo.ts';
import { createIntent, intentToSpec, listIntents, loadIntent, resolveIntentRef, setIntentStatus, toCard, updateIntent, type StatusAction } from '../repo/intents.ts';
import { enqueue } from '../repo/jobs.ts';
import { emitUserEvent, listNotifications, markAllRead, markRead, notify } from '../repo/notifications.ts';
import { clampLimit } from '../repo/paging.ts';
import { counts, createSession, deleteSession, personaUser, registerUser, userForToken, type SessionUser } from '../repo/users.ts';
import { hydrateMatches, latestRun, listMatches, matchIntent } from '../matching/engine.ts';

const COOKIE = 'ul_session';
declare module 'fastify' { interface FastifyRequest { user: SessionUser | null } }

export interface AppDeps { pool: pg.Pool; reg: Registry; databaseUrl: string; version: string; listen?: boolean }

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool, reg } = deps;
  const app = Fastify({ logger: { level: process.env.UL_LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] }, bodyLimit: 64 * 1024, trustProxy: false });
  app.decorateRequest('user', null);

  await app.register(fastifyStatic, { root: join(ROOT, 'public'), prefix: '/', index: ['index.html'], cacheControl: true, maxAge: 0 });

  // ── security headers
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'microphone=(self)');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });

  // ── session + CSRF (mutations must be JSON from our own origin)
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = await userForToken(pool, token);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const ct = String(req.headers['content-type'] ?? '');
      if (!ct.startsWith('application/json')) return reply.code(415).send({ error: 'json_required', messageAr: 'يجب إرسال JSON' });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return reply.code(403).send({ error: 'bad_origin', messageAr: 'مصدر غير مسموح' });
    }
    const open = ['/api/health', '/api/personas', '/api/ai/status', '/api/taxonomy', '/api/session'].includes(req.routeOptions.url ?? '') || req.url.startsWith('/api/auth/');
    if (!open && !req.user) return reply.code(401).send({ error: 'unauthorized', messageAr: 'سجّل الدخول أولًا' });
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, messageAr: err.message });
    if (err.validation) return reply.code(400).send({ error: 'bad_request', messageAr: 'طلب غير صالح' });
    req.log.error({ err: { message: err.message, code: err.code } }, 'unhandled');
    return reply.code(500).send({ error: 'internal', messageAr: 'صار خطأ عندنا. حاول مرة ثانية.' });
  });

  const u = (req: FastifyRequest) => req.user!;
  const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) throw new HttpError(400, 'bad_request', 'بيانات الطلب غير صالحة');
    return r.data;
  };
  const setCookie = (reply: FastifyReply, token: string) => reply.header('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`);

  // ── public
  app.get('/api/health', async () => {
    const db = await pool.query('SELECT 1 AS ok').then(() => true).catch(() => false);
    const hb = await pool.query('SELECT max(beat_at) AS beat FROM worker_heartbeats').then((r) => r.rows[0]?.beat ?? null).catch(() => null);
    return { ok: db, db, worker: { lastBeatAt: hb, alive: hb ? Date.now() - new Date(hb).getTime() < 30_000 : false }, version: deps.version, registry: reg.version };
  });
  app.get('/api/ai/status', async () => getJevStatus());
  app.get('/api/taxonomy', async () => ({
    categories: reg.categories.filter((c) => c.depth > 0).map((c) => ({ code: c.code, labelAr: c.nameAr, deals: c.deals, vertical: c.verticalCode })),
    places: reg.places.filter((p) => p.kind !== 'world').map((p) => ({ id: p.id, labelAr: p.nameAr, kind: p.kind, depth: p.depth })),
  }));
  app.get('/api/personas', async () => {
    const { rows } = await pool.query("SELECT handle, display_name, persona_ar FROM users WHERE realm = 'synthetic' AND persona_ar IS NOT NULL ORDER BY id");
    const order = PERSONAS.map((p) => p.handle);
    rows.sort((a, b) => order.indexOf(a.handle) - order.indexOf(b.handle));
    return { items: rows.map((r) => ({ handle: r.handle, displayName: r.display_name, descriptionAr: r.persona_ar })) };
  });
  app.post('/api/auth/demo-login', async (req, reply) => {
    const { handle } = body(z.object({ handle: z.string().regex(/^[a-z0-9_]{3,40}$/) }), req);
    const user = await personaUser(pool, handle);
    if (!user) throw new HttpError(404, 'not_found', 'الشخصية التجريبية غير موجودة');
    setCookie(reply, await createSession(pool, user.id));
    return { user: publicUser(user) };
  });
  app.post('/api/auth/register', async (req, reply) => {
    const { displayName, phone } = body(z.object({ displayName: z.string().trim().min(1).max(80), phone: z.string().trim().max(30).optional() }), req);
    const user = await registerUser(pool, displayName, phone || null);
    setCookie(reply, await createSession(pool, user.id));
    return { user: publicUser(user) };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    await deleteSession(pool, parseCookies(req.headers.cookie)[COOKIE]);
    reply.header('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  // ── session probe (never 401: lets the client decide between login and app without console noise)
  app.get('/api/session', async (req) => ({ user: req.user ? publicUser(req.user) : null }));
  // ── me
  app.get('/api/me', async (req) => ({ user: publicUser(u(req)), counts: await counts(pool, u(req).id) }));

  // ── conversations
  app.post('/api/conversations', async (req) => ({ conversation: await startConversation(pool, u(req)) }));
  app.get('/api/conversations/current', async (req) => ({ conversation: await currentConversation(pool, reg, u(req)) }));
  app.post<{ Params: { id: string } }>('/api/conversations/:id/turns', async (req) => {
    const b = body(z.object({ text: z.string().max(1000), modality: z.enum(['voice', 'text']).default('text'), clientTurnId: z.string().max(40).default('') }), req);
    return handleTurn(pool, reg, u(req), req.params.id, b);
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/cancel', async (req) => ({ conversation: await cancelConversation(pool, u(req), req.params.id) }));

  // ── intents
  const ownIntent = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const ref = await resolveIntentRef(pool, req.params.id);
    if (!ref || ref.userId !== u(req).id) throw new HttpError(404, 'not_found', 'غير موجود'); // never reveal others' ids
    return ref;
  };
  app.get<{ Querystring: Record<string, string> }>('/api/intents', async (req) => {
    const q = req.query;
    const sides = q.side === 'offers' || q.side === 'provide' ? ['provide'] : q.side === 'seek' ? ['seek'] : q.side === 'join' ? ['join'] : ['seek', 'join'];
    const statuses = q.status ? q.status.split(',').filter((s) => ['active', 'paused', 'fulfilled', 'closed', 'expired'].includes(s)) : undefined;
    return listIntents(pool, reg, u(req).id, { sides: sides as any, statuses, cursor: q.cursor, dir: q.dir === 'prev' ? 'prev' : 'next', limit: clampLimit(q.limit) });
  });
  app.get<{ Params: { id: string } }>('/api/intents/:id', async (req) => {
    const ref = await ownIntent(req);
    const row = await loadIntent(pool, ref.verticalId, ref.id);
    return { intent: toCard(reg, row!, undefined, true) };
  });
  app.patch<{ Params: { id: string } }>('/api/intents/:id', async (req) => {
    const ref = await ownIntent(req);
    const b = body(z.object({ expectedVersion: z.number().int().positive(), changes: z.record(z.string(), z.unknown()) }), req);
    const row = await loadIntent(pool, ref.verticalId, ref.id);
    const current = intentToSpec(reg, row!);
    const merged = { ...current, ...b.changes } as IntentSpec;
    const v = validateSpec(reg, merged);
    if (!v.ok) throw new HttpError(422, 'invalid_spec', `تعديل غير صالح: ${v.issues.map((i) => i.code).join('، ')}`);
    const title = titleOf(reg, { side: v.spec.side, category: v.spec.categoryCode, deal: v.spec.deal, placeIds: v.spec.side === 'seek' ? v.spec.place.scopePlaceIds : v.spec.place.pointPlaceId != null ? [v.spec.place.pointPlaceId] : [], whenLabel: v.spec.when?.label });
    const res = await withTx(pool, async (tx) => {
      const r = await updateIntent(tx, reg, ref.verticalId, ref.id, u(req).id, b.expectedVersion, v.spec, row!.realm === 'synthetic' ? `${title} (تجريبي)` : title);
      if (r.ok) await enqueue(tx, 'match_intent', { verticalId: ref.verticalId, intentId: ref.id, version: r.version, trigger: 'edit' }, { dedupeKey: `match:${ref.verticalId}:${ref.id}:${r.version}`, priority: 50 });
      return r;
    });
    if (!res.ok) throw new HttpError(res.reason === 'version_conflict' ? 409 : res.reason === 'vertical_change' ? 422 : 404, res.reason, res.reason === 'version_conflict' ? 'تغيّر الطلب من مكان آخر. حدّث الصفحة.' : 'لا يمكن هذا التعديل');
    // re-evaluate now so the user immediately sees invalidated/new matches (the job is the safety net)
    const run = await matchIntent(pool, reg, { verticalId: ref.verticalId, intentId: ref.id, version: res.version, trigger: 'edit' });
    const updated = await loadIntent(pool, ref.verticalId, ref.id);
    return { intent: toCard(reg, updated!, undefined, true), run };
  });
  app.post<{ Params: { id: string } }>('/api/intents/:id/status', async (req) => {
    const ref = await ownIntent(req);
    const { action } = body(z.object({ action: z.enum(['pause', 'resume', 'fulfill', 'close']) }), req);
    const res = await withTx(pool, async (tx) => setIntentStatus(tx, reg, ref.verticalId, ref.id, u(req).id, action as StatusAction));
    if (!res.ok) throw new HttpError(409, 'invalid_transition', 'لا يمكن تنفيذ هذا الإجراء على حالته الحالية');
    const run = await matchIntent(pool, reg, { verticalId: ref.verticalId, intentId: ref.id, version: res.version, trigger: 'status' });
    const row = await loadIntent(pool, ref.verticalId, ref.id);
    return { intent: toCard(reg, row!), run };
  });
  app.post<{ Params: { id: string }; Querystring: Record<string, string> }>('/api/intents/:id/match', async (req) => {
    const ref = await ownIntent(req);
    const row = await loadIntent(pool, ref.verticalId, ref.id);
    let run = await latestRun(pool, ref.verticalId, ref.id, row!.version);
    let status: 'done' | 'queued' = 'done';
    if (!run) {
      const r = await matchIntent(pool, reg, { verticalId: ref.verticalId, intentId: ref.id, version: row!.version, trigger: 'interactive' });
      if (r.status === 'superseded') status = 'queued';
      run = await latestRun(pool, ref.verticalId, ref.id, row!.version);
    }
    const page = await listMatches(pool, reg, u(req).id, { intent: { verticalId: ref.verticalId, id: ref.id }, states: ['confirmed', 'possible'], limit: clampLimit(req.query.limit, 10) });
    return {
      intentId: req.params.id, version: row!.version, status,
      totals: run ? { confirmed: run.confirmed, possible: run.possible, excluded: run.excluded, candidates: run.candidates } : { confirmed: 0, possible: 0, excluded: 0, candidates: 0 },
      exclusions: run?.exclusions ?? [], truncated: run?.truncated ?? false, page,
      suggestionsAr: suggestionsFor(reg, row!, run),
    };
  });

  // ── matches
  app.get<{ Querystring: Record<string, string> }>('/api/matches', async (req) => {
    const q = req.query;
    let intent: { verticalId: number; id: string } | null = null;
    if (q.intent) {
      const ref = await resolveIntentRef(pool, q.intent);
      if (!ref || ref.userId !== u(req).id) throw new HttpError(404, 'not_found', 'غير موجود');
      intent = { verticalId: ref.verticalId, id: ref.id };
    }
    const states = q.state === 'invalidated' ? ['invalidated'] : q.state === 'confirmed' ? ['confirmed'] : q.state === 'possible' ? ['possible'] : q.state === 'all' ? ['confirmed', 'possible', 'invalidated'] : ['confirmed', 'possible'];
    return listMatches(pool, reg, u(req).id, { intent, states, cursor: q.cursor, dir: q.dir === 'prev' ? 'prev' : 'next', limit: clampLimit(q.limit) });
  });
  const ownMatch = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'not_found', 'غير موجود');
    const { rows } = await pool.query(
      `SELECT m.* FROM match_refs r JOIN matches m ON m.vertical_id = r.vertical_id AND m.id = r.match_id
        WHERE r.public_id = $1 AND (m.a_user_id = $2 OR m.b_user_id = $2)`, [req.params.id, u(req).id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'غير موجود');
    return rows[0];
  };
  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req) => ({ match: (await hydrateMatches(pool, reg, u(req).id, [await ownMatch(req)]))[0] }));
  app.post<{ Params: { id: string } }>('/api/matches/:id/contact', async (req) => {
    const m = await ownMatch(req);
    if (m.state === 'invalidated') throw new HttpError(409, 'match_invalidated', 'هذه المطابقة لم تعد صالحة');
    const { messageAr } = body(z.object({ messageAr: z.string().trim().max(500).optional() }), req);
    const me = u(req).id;
    const other = String(m.a_user_id) === me ? String(m.b_user_id) : String(m.a_user_id);
    const { rows } = await pool.query(
      `INSERT INTO contact_requests (vertical_id, match_id, requester_id, recipient_id, message_ar) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (vertical_id, match_id, requester_id) DO UPDATE SET message_ar = coalesce(EXCLUDED.message_ar, contact_requests.message_ar) RETURNING public_id, status`,
      [m.vertical_id, m.id, me, other, messageAr ?? null],
    );
    await notify(pool, { recipientId: other, kind: 'contact_request', titleAr: 'طلب تواصل جديد', bodyAr: 'شخص مهتم بمطابقة معك. وافق ليظهر لكما اسم ورقم كل منكما.', payload: { matchId: m.public_id, requestId: rows[0].public_id }, dedupeKey: `contact:${rows[0].public_id}` });
    await emitUserEvent(pool, me, 'match_update');
    return { contactRequest: { id: rows[0].public_id, status: rows[0].status } };
  });
  app.post<{ Params: { id: string } }>('/api/contact-requests/:id/respond', async (req) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'not_found', 'غير موجود');
    const { accept } = body(z.object({ accept: z.boolean() }), req);
    const { rows } = await pool.query(
      `UPDATE contact_requests c SET status = $3, responded_at = now() FROM match_refs r
        WHERE c.public_id = $1 AND c.recipient_id = $2 AND c.status = 'pending' AND r.vertical_id = c.vertical_id AND r.match_id = c.match_id
        RETURNING c.public_id, c.status, c.requester_id, r.public_id AS match_public_id`,
      [req.params.id, u(req).id, accept ? 'accepted' : 'declined'],
    );
    if (!rows[0]) throw new HttpError(404, 'not_found', 'الطلب غير موجود أو تمت الإجابة عليه');
    await notify(pool, { recipientId: String(rows[0].requester_id), kind: accept ? 'contact_accepted' : 'contact_declined', titleAr: accept ? 'تمت الموافقة على التواصل' : 'تم رفض طلب التواصل', bodyAr: accept ? 'افتح المطابقة لترى الاسم ورقم التواصل.' : undefined, payload: { matchId: rows[0].match_public_id }, dedupeKey: `contact-reply:${rows[0].public_id}` });
    await emitUserEvent(pool, u(req).id, 'match_update');
    return { contactRequest: { id: rows[0].public_id, status: rows[0].status } };
  });

  // ── notifications (recipient-only)
  app.get<{ Querystring: Record<string, string> }>('/api/notifications', async (req) => listNotifications(pool, u(req).id, { cursor: req.query.cursor, dir: req.query.dir === 'prev' ? 'prev' : 'next', limit: clampLimit(req.query.limit), unreadOnly: req.query.unread === '1' }));
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req) => {
    if (!(await markRead(pool, u(req).id, req.params.id))) throw new HttpError(404, 'not_found', 'غير موجود');
    await emitUserEvent(pool, u(req).id, 'counts');
    return { ok: true };
  });
  app.post('/api/notifications/read-all', async (req) => {
    const updated = await markAllRead(pool, u(req).id);
    await emitUserEvent(pool, u(req).id, 'counts');
    return { ok: true, updated };
  });

  // ── demo (synthetic realm only): a counterpart arrives later for the user's newest unmatched request
  app.post('/api/demo/simulate', async (req) => {
    const me = u(req);
    if (me.realm !== 'synthetic') throw new HttpError(403, 'synthetic_only', 'المحاكاة متاحة فقط في الوضع التجريبي');
    body(z.object({ scenario: z.literal('later_match') }), req);
    const { rows } = await pool.query(
      `SELECT i.vertical_id, i.id FROM intents i WHERE i.user_id = $1 AND i.status = 'active' AND i.side IN ('seek','join')
         AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.vertical_id = i.vertical_id AND (m.a_intent_id = i.id OR m.b_intent_id = i.id) AND m.state IN ('confirmed','possible'))
       ORDER BY i.created_at DESC LIMIT 1`, [me.id]);
    if (!rows[0]) throw new HttpError(404, 'nothing_to_simulate', 'لا يوجد طلب نشط بدون مطابقات. احفظ طلبًا أولًا.');
    const row = await loadIntent(pool, rows[0].vertical_id, String(rows[0].id));
    const spec = counterpartFor(reg, intentToSpec(reg, row!));
    const v = spec ? validateSpec(reg, spec) : null;
    if (!v || !v.ok) throw new HttpError(422, 'cannot_simulate', 'تعذّر إنشاء عرض مطابق لهذا الطلب');
    const owner = (await pool.query("SELECT id FROM users WHERE handle = 'syn_owner_001'")).rows[0];
    const created = await withTx(pool, async (tx) => {
      const c = await createIntent(tx, reg, { userId: String(owner.id), realm: 'synthetic', spec: v.spec, titleAr: `${titleOf(reg, { side: v.spec.side, category: v.spec.categoryCode, deal: v.spec.deal, placeIds: v.spec.place.pointPlaceId ? [v.spec.place.pointPlaceId] : [], whenLabel: v.spec.when?.label })} (تجريبي — محاكاة)`, sourceText: null, conversationId: null });
      await enqueue(tx, 'match_intent', { verticalId: c.verticalId, intentId: c.id, version: c.version, trigger: 'job' }, { dedupeKey: `match:${c.verticalId}:${c.id}:${c.version}`, priority: 10 });
      return c;
    });
    return { created: { id: created.publicId }, noteAr: 'أُضيف عرض تجريبي جديد. سيصلك تنبيه عندما يطابقه العامل في الخلفية.' };
  });

  // ── server-sent events: live notifications/counts per user
  const streams = new Map<string, Set<FastifyReply>>();
  app.get('/api/events', async (req, reply) => {
    const me = u(req);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(`event: counts\ndata: ${JSON.stringify(await counts(pool, me.id))}\n\n`);
    const set = streams.get(me.id) ?? new Set();
    set.add(reply);
    streams.set(me.id, set);
    const hb = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(hb); set.delete(reply); if (!set.size) streams.delete(me.id); });
  });
  let listener: pg.Client | null = null;
  if (deps.listen !== false) {
    listener = new pg.Client({ connectionString: deps.databaseUrl });
    await listener.connect();
    await listener.query('LISTEN ul_events');
    listener.on('notification', async (n) => {
      try {
        const ev = JSON.parse(n.payload ?? '{}') as { userId?: string; type?: string };
        const set = ev.userId ? streams.get(String(ev.userId)) : undefined;
        if (!set?.size) return;
        const c = await counts(pool, String(ev.userId));
        for (const r of set) {
          r.raw.write(`event: ${ev.type ?? 'counts'}\ndata: ${JSON.stringify(c)}\n\n`);
          if (ev.type !== 'counts') r.raw.write(`event: counts\ndata: ${JSON.stringify(c)}\n\n`);
        }
      } catch { /* ignore malformed */ }
    });
    listener.on('error', (e) => app.log.error({ err: e.message }, 'listener error'));
  }
  app.addHook('onClose', async () => {
    for (const set of streams.values()) for (const r of set) r.raw.end();
    await listener?.end().catch(() => {});
  });

  return app;
}

function publicUser(u: SessionUser) { return { publicId: u.publicId, displayName: u.displayName, realm: u.realm }; }

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Suggestions to widen constraints — shown to the user, NEVER applied automatically. */
function suggestionsFor(reg: Registry, row: any, run: any): string[] {
  if (!run || run.confirmed + run.possible > 0) return [];
  const out: string[] = [];
  const ex: { code: string; count: number }[] = run.exclusions ?? [];
  const scope: number[] = row.scope_place_ids ?? [];
  if (ex.some((e) => e.code === 'place_out_of_scope') && scope.length) {
    const parent = reg.placeById.get(reg.placeById.get(scope[0]!)!.parent ? reg.placeByCode.get(reg.placeById.get(scope[0]!)!.parent!)!.id : scope[0]!);
    if (parent && parent.kind !== 'world') out.push(`وسّع المكان إلى ${parent.nameAr}`);
  }
  if (ex.some((e) => e.code === 'price_above_max')) out.push('ارفع الحد الأقصى للسعر قليلًا');
  if (ex.some((e) => e.code === 'attr_violation')) out.push('اجعل بعض الشروط تفضيلات بدل شروط ملزمة');
  if (ex.some((e) => e.code === 'date_no_overlap')) out.push('جرّب يومًا آخر');
  return out;
}
