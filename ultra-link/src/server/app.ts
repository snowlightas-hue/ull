// HTTP API + static frontend. Every data route is scoped to the session user (isolation by construction).
// Hardening: CSRF guard, token-bucket rate limits, strict query/param validation, privacy-safe logging,
// SSE hub with LISTEN auto-reconnect and per-user caps, health/metrics, lazy session cleanup.
// Extension: feature route plugins (src/server/routes/*, see context.ts) are registered after the core API
// and inherit every guard above.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type pg from 'pg';
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
import { counts, createSession, deleteSession, personaUser, registerUser, userForToken, type SessionUser } from '../repo/users.ts';
import { hydrateMatches, latestRun, listMatches, matchIntent } from '../matching/engine.ts';
import { contactRefusal, ConnError, openConnectionForMatch } from '../connections/repo.ts';
import { decorateMatchCards } from '../connections/match-cards.ts';
import { issueRecoveryCode } from '../connections/recovery.ts';
import { EventHub } from './events.ts';
import { perMinuteRule, type RouteContext, type RouteRateLimit, type UlRoutePlugin } from './context.ts';
import { FEATURE_ROUTES } from './routes/index.ts';
import { health, isLocalRequest, metrics, newCounters, safeErr, SessionJanitor, type Counters } from './ops.ts';
import { rateLimitConfig, TokenBuckets, type RateLimitConfig } from './ratelimit.ts';
import { IntentsQuery, MatchesQuery, MatchRunQuery, NotificationsQuery, parseQuery, TurnBody, uuidParam } from './validate.ts';

const COOKIE = 'ul_session';

export interface UlRuntime {
  counters: Counters;
  events: EventHub;
  janitor: SessionJanitor;
  limiter: TokenBuckets;
  limits: RateLimitConfig;
  /** set by main.ts on SIGTERM/SIGINT: health answers 503 so a balancer stops sending traffic */
  draining: boolean;
}

declare module 'fastify' {
  interface FastifyRequest { user: SessionUser | null; sessionKey: string | null }
  interface FastifyInstance { ul: UlRuntime }
}

export interface AppDeps {
  pool: pg.Pool; reg: Registry; databaseUrl: string; version: string;
  /** open the LISTEN connection for live events (default true) */
  listen?: boolean;
  /** rate-limit overrides (null disables one bucket); defaults from env, see ratelimit.ts */
  rateLimits?: Partial<RateLimitConfig>;
  sse?: { maxPerUser?: number; heartbeatMs?: number; reconnectMinMs?: number; reconnectMaxMs?: number };
  /** logs go here instead of stdout (tests capture them) */
  logStream?: Writable;
  logLevel?: string;
  sessionCleanupMs?: number;
  /** extra route plugins registered after the core API and FEATURE_ROUTES (tests, experiments) */
  routes?: UlRoutePlugin[];
  /** register src/server/routes/index.ts FEATURE_ROUTES (default true) */
  featureRoutes?: boolean;
  /**
   * Number of trusted reverse-proxy hops in front of the server (default: env UL_TRUST_PROXY, unset = 0).
   * With ≥1 (e.g. GitHub Codespaces port forwarding): client IP and protocol come from the X-Forwarded-*
   * headers set by that proxy, and a mutation's Origin may match X-Forwarded-Host as well as Host.
   */
  trustProxy?: number;
}

export type { RouteContext, UlRoutePlugin } from './context.ts';
export { defineRoutes } from './context.ts';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { pool, reg } = deps;
  const proxyHops = deps.trustProxy ?? trustProxyFromEnv(process.env.UL_TRUST_PROXY);
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? process.env.UL_LOG_LEVEL ?? 'info',
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // Never log bodies, cookies, auth headers or query strings (utterances and tokens stay out of logs).
      redact: { paths: ['req.headers', 'req.body', 'req.query', 'res.headers', 'headers', 'body'], censor: '[redacted]' },
      serializers: {
        req: (r: { method?: string; url?: string; ip?: string }) => ({ method: r.method, url: String(r.url ?? '').split('?')[0]!.slice(0, 200), remoteAddress: r.ip }),
        res: (r: { statusCode?: number }) => ({ statusCode: r.statusCode }),
        err: (e: unknown) => { const s = safeErr(e); return { ...s, stack: s.stack ?? '' }; },
      },
    },
    bodyLimit: 64 * 1024,
    // trust exactly `proxyHops` hops (not `true`): req.ip is the address the nearest trusted proxy saw, never a
    // client-forged left-most X-Forwarded-For entry. 0 = no proxy: req.ip is the socket address.
    trustProxy: proxyHops > 0 ? (_addr: string, hop: number) => hop < proxyHops : false,
    return503OnClosing: true,
  });
  app.decorateRequest('user', null);
  app.decorateRequest('sessionKey', null);

  const counters = newCounters();
  const limits = rateLimitConfig(deps.rateLimits);
  const limiter = new TokenBuckets();
  const events = new EventHub({
    pool, databaseUrl: deps.databaseUrl, log: app.log, listen: deps.listen !== false,
    maxPerUser: deps.sse?.maxPerUser ?? Number(process.env.UL_SSE_MAX_PER_USER ?? 5),
    heartbeatMs: deps.sse?.heartbeatMs ?? Number(process.env.UL_SSE_HEARTBEAT_MS ?? 25_000),
    reconnectMinMs: deps.sse?.reconnectMinMs ?? 500, reconnectMaxMs: deps.sse?.reconnectMaxMs ?? 30_000,
  });
  const janitor = new SessionJanitor(pool, counters, (e) => app.log.warn({ err: safeErr(e) }, 'session cleanup failed'), deps.sessionCleanupMs);
  const ul: UlRuntime = { counters, events, janitor, limiter, limits, draining: false };
  app.decorate('ul', ul);

  await app.register(fastifyStatic, { root: join(ROOT, 'public'), prefix: '/', index: ['index.html'], cacheControl: true, maxAge: 0 });

  // ── security headers
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'microphone=(self)');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (reply.request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.addHook('onResponse', async (_req, reply) => {
    const k = `${Math.floor(reply.statusCode / 100)}xx`;
    if (k in counters.http) counters.http[k]!++;
  });

  // ── CSRF guard → rate limits → session (all before the body is parsed)
  const OPEN = new Set(['/api/health', '/api/metrics', '/api/personas', '/api/ai/status', '/api/taxonomy', '/api/session']);
  const tooMany = (reply: FastifyReply, bucket: string, retryAfterMs: number) => {
    counters.rateLimited[bucket] = (counters.rateLimited[bucket] ?? 0) + 1;
    return reply.code(429).header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
      .send({ error: 'rate_limited', messageAr: 'طلبات كثيرة خلال وقت قصير. انتظر قليلًا ثم حاول مجددًا.' });
  };
  const who = (req: FastifyRequest, by: 'session' | 'ip' = 'session') => (by === 'session' && req.sessionKey ? `s:${req.sessionKey}` : `ip:${req.ip}`);
  /** feature buckets: perMinute from the route, overridable with UL_RL_<NAME>_PER_MIN (0 = off) */
  const routeRule = (l: RouteRateLimit) => {
    const env = process.env[`UL_RL_${l.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PER_MIN`];
    const n = env === undefined || env === '' ? l.perMinute : Number(env);
    return Number.isFinite(n) && n > 0 ? perMinuteRule(n) : null;
  };
  const takeNamed = (req: FastifyRequest, reply: FastifyReply, l: RouteRateLimit): boolean => {
    const rule = routeRule(l);
    if (!rule) return true;
    const r = limiter.take(`${l.name}|${who(req, l.by)}`, rule);
    if (!r.ok) { tooMany(reply, l.name, r.retryAfterMs); return false; }
    return true;
  };
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const route = req.routeOptions.url ?? '';
    const cfg = req.routeOptions.config ?? {};
    const mutation = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (mutation) {
      const ct = String(req.headers['content-type'] ?? '').toLowerCase();
      const extra = cfg.contentTypes ?? [];
      if (!ct.startsWith('application/json') && !extra.some((t) => ct.startsWith(t.toLowerCase()))) return reply.code(415).send({ error: 'json_required', messageAr: 'يجب إرسال JSON' });
      if (!sameOrigin(req, proxyHops > 0)) return reply.code(403).send({ error: 'bad_origin', messageAr: 'مصدر غير مسموح' });
    }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.sessionKey = token ? createHash('sha256').update(token).digest('base64url').slice(0, 22) : null;
    if (route.startsWith('/api/auth/') && limits.auth) {
      const r = limiter.take(`auth|ip:${req.ip}`, limits.auth);
      if (!r.ok) return tooMany(reply, 'auth', r.retryAfterMs);
    } else if (route === '/api/conversations/:id/turns' && mutation && limits.turns) {
      const r = limiter.take(`turns|${who(req)}`, limits.turns);
      if (!r.ok) return tooMany(reply, 'turns', r.retryAfterMs);
    } else if (route === '/api/demo/simulate' && limits.simulate) {
      const r = limiter.take(`simulate|${who(req)}`, limits.simulate);
      if (!r.ok) return tooMany(reply, 'simulate', r.retryAfterMs);
    }
    if (cfg.rateLimit && !takeNamed(req, reply, cfg.rateLimit)) return reply;
    req.user = await userForToken(pool, token);
    janitor.maybeRun();
    if (!OPEN.has(route) && cfg.public !== true && !route.startsWith('/api/auth/') && !req.url.startsWith('/api/auth/') && !req.user) {
      return reply.code(401).send({ error: 'unauthorized', messageAr: 'سجّل الدخول أولًا' });
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, messageAr: err.message });
    if (err.validation) return reply.code(400).send({ error: 'bad_request', messageAr: 'طلب غير صالح' });
    const fst = String(err.code ?? '');
    if (fst === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: 'too_large', messageAr: 'الطلب كبير جدًا' });
    if (fst === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: 'json_required', messageAr: 'يجب إرسال JSON' });
    if (fst.startsWith('FST_ERR_CTP_') || (err.statusCode === 400)) return reply.code(400).send({ error: 'bad_json', messageAr: 'تعذّرت قراءة الطلب' });
    // PostgreSQL: data exceptions are bad input (never 500); contention is retryable; outages are 503.
    if (/^22[0-9A-Z]{3}$/.test(fst)) return reply.code(400).send({ error: 'bad_request', messageAr: 'طلب غير صالح' });
    if (fst === '40001' || fst === '40P01' || fst === '55P03') return reply.code(409).send({ error: 'busy', messageAr: 'في طلب آخر قيد المعالجة، حاول مرة ثانية' });
    if (fst === '57014' || fst === '57P01' || fst === '57P03' || fst.startsWith('08') || fst === 'ECONNREFUSED' || fst === 'ECONNRESET' || /timeout exceeded when trying to connect/i.test(String(err.message))) {
      req.log.error({ err: safeErr(err) }, 'database unavailable');
      return reply.code(503).header('Retry-After', '5').send({ error: 'unavailable', messageAr: 'الخدمة مشغولة مؤقتًا. حاول بعد قليل.' });
    }
    req.log.error({ err: safeErr(err) }, 'unhandled');
    return reply.code(500).send({ error: 'internal', messageAr: 'صار خطأ عندنا. حاول مرة ثانية.' });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found', messageAr: req.url.startsWith('/api/') ? 'غير موجود' : 'الصفحة غير موجودة' }));

  const u = (req: FastifyRequest) => req.user!;
  const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T> => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) throw new HttpError(400, 'bad_request', 'بيانات الطلب غير صالحة');
    return r.data;
  };
  // `Secure` only when the request really arrived over https (a trusted proxy's X-Forwarded-Proto); the local demo is plain http
  const cookieAttrs = (req: FastifyRequest) => `HttpOnly; SameSite=Lax; Path=/${req.protocol === 'https' ? '; Secure' : ''}`;
  const setCookie = (reply: FastifyReply, token: string) => reply.header('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(reply.request)}; Max-Age=${30 * 86400}`);

  // ── public
  app.get('/api/health', async (_req, reply) => {
    const r = await health({ pool, version: deps.version, registry: reg.version, startedAt: counters.startedAt, draining: ul.draining, events: deps.listen === false ? null : { connected: events.stats.connected, reconnects: events.stats.reconnects } });
    return reply.code(r.code).send(r.body);
  });
  // local-only operational counters (no secrets, but not for the outside world)
  app.get('/api/metrics', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(404).send({ error: 'not_found', messageAr: 'غير موجود' });
    const jev = getJevStatus();
    return metrics(pool, counters, {
      sse: { ...events.open, listener: { ...events.stats } },
      jev: { mode: jev.mode, verified: jev.verified, lastLatencyMs: jev.lastLatencyMs, lastError: jev.lastError },
      rateLimiterKeys: limiter.size,
    });
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
    const { displayName, phone } = body(z.object({ displayName: z.string().trim().min(1).max(80), phone: z.string().trim().max(30).regex(/^[0-9+()\-\s.]*$/).optional() }), req);
    // MAJOR-6: a real account gets a one-time-shown recovery code (only its HMAC is stored; docs/CONNECTIONS.md)
    const { user, token, recovery } = await withTx(pool, async (tx) => {
      const created = await registerUser(tx, displayName, phone || null);
      return { user: created, recovery: await issueRecoveryCode(tx, created.id), token: await createSession(tx, created.id) };
    });
    setCookie(reply, token);
    return { user: publicUser(user), recoveryCode: recovery.code };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    await deleteSession(pool, parseCookies(req.headers.cookie)[COOKIE]);
    reply.header('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req)}; Max-Age=0`);
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
    const id = uuidParam(req.params.id);
    const b = body(TurnBody, req);
    try {
      const r = await handleTurn(pool, reg, u(req), id, b);
      counters.turns.ok++;
      counters.turns.latencyMsTotal += r.understanding.latencyMs;
      counters.turns.byEngine[r.understanding.engine] = (counters.turns.byEngine[r.understanding.engine] ?? 0) + 1;
      if (r.action === 'saved') counters.turns.saved++;
      else if (r.action === 'ask') counters.turns.asked++;
      else if (r.action === 'unclear') counters.turns.unclear++;
      return r;
    } catch (e) {
      counters.turns.failed++;
      throw e;
    }
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/cancel', async (req) => ({ conversation: await cancelConversation(pool, u(req), uuidParam(req.params.id)) }));

  // ── intents
  const ownIntent = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const ref = await resolveIntentRef(pool, uuidParam(req.params.id));
    if (!ref || ref.userId !== u(req).id) throw new HttpError(404, 'not_found', 'غير موجود'); // never reveal others' ids
    return ref;
  };
  app.get('/api/intents', async (req) => {
    const q = parseQuery(IntentsQuery, req.query);
    const sides = q.side === 'offers' || q.side === 'provide' ? ['provide'] : q.side === 'seek' ? ['seek'] : q.side === 'join' ? ['join'] : ['seek', 'join'];
    return listIntents(pool, reg, u(req).id, { sides: sides as ('seek' | 'provide' | 'join')[], statuses: q.status, cursor: q.cursor, dir: q.dir === 'prev' ? 'prev' : 'next', limit: q.limit ?? 20 });
  });
  app.get<{ Params: { id: string } }>('/api/intents/:id', async (req) => {
    const ref = await ownIntent(req);
    const row = await loadIntent(pool, ref.verticalId, ref.id);
    return { intent: toCard(reg, row!, undefined, true) };
  });
  app.patch<{ Params: { id: string } }>('/api/intents/:id', async (req) => {
    const ref = await ownIntent(req);
    const b = body(z.object({ expectedVersion: z.number().int().positive().max(2_147_483_647), changes: z.record(z.string().max(40), z.unknown()) }), req);
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
    const res = await withTx(pool, async (tx) => {
      const r = await setIntentStatus(tx, reg, ref.verticalId, ref.id, u(req).id, action as StatusAction);
      // safety net in the same transaction: if the process dies before the inline re-match below, the worker
      // still re-evaluates this version (and notifies counterparts); the inline run makes the job a no-op
      if (r.ok) await enqueue(tx, 'match_intent', { verticalId: ref.verticalId, intentId: ref.id, version: r.version, trigger: 'status' }, { dedupeKey: `match:${ref.verticalId}:${ref.id}:${r.version}`, priority: 50 });
      return r;
    });
    if (!res.ok) throw new HttpError(409, 'invalid_transition', 'لا يمكن تنفيذ هذا الإجراء على حالته الحالية');
    const run = await matchIntent(pool, reg, { verticalId: ref.verticalId, intentId: ref.id, version: res.version, trigger: 'status' });
    const row = await loadIntent(pool, ref.verticalId, ref.id);
    return { intent: toCard(reg, row!), run };
  });
  app.post<{ Params: { id: string } }>('/api/intents/:id/match', async (req) => {
    const ref = await ownIntent(req);
    const q = parseQuery(MatchRunQuery, req.query);
    const row = await loadIntent(pool, ref.verticalId, ref.id);
    let run = await latestRun(pool, ref.verticalId, ref.id, row!.version);
    let status: 'done' | 'queued' = 'done';
    if (!run) {
      const r = await matchIntent(pool, reg, { verticalId: ref.verticalId, intentId: ref.id, version: row!.version, trigger: 'interactive' });
      if (r.status === 'superseded') status = 'queued';
      run = await latestRun(pool, ref.verticalId, ref.id, row!.version);
    }
    const page = await listMatches(pool, reg, u(req).id, { intent: { verticalId: ref.verticalId, id: ref.id }, states: ['confirmed', 'possible'], limit: q.limit ?? 10 });
    await decorateMatchCards(pool, u(req).id, page.items); // name only after accept; phone only while shared
    return {
      intentId: row!.public_id, version: row!.version, status,
      totals: run ? { confirmed: run.confirmed, possible: run.possible, excluded: run.excluded, candidates: run.candidates } : { confirmed: 0, possible: 0, excluded: 0, candidates: 0 },
      exclusions: run?.exclusions ?? [], truncated: run?.truncated ?? false, page,
      suggestionsAr: suggestionsFor(reg, row!, run),
    };
  });

  // ── matches
  app.get('/api/matches', async (req) => {
    const q = parseQuery(MatchesQuery, req.query);
    let intent: { verticalId: number; id: string } | null = null;
    if (q.intent) {
      const ref = await resolveIntentRef(pool, q.intent);
      if (!ref || ref.userId !== u(req).id) throw new HttpError(404, 'not_found', 'غير موجود');
      intent = { verticalId: ref.verticalId, id: ref.id };
    }
    const states = q.state === 'invalidated' ? ['invalidated'] : q.state === 'confirmed' ? ['confirmed'] : q.state === 'possible' ? ['possible'] : q.state === 'all' ? ['confirmed', 'possible', 'invalidated'] : ['confirmed', 'possible'];
    const page = await listMatches(pool, reg, u(req).id, { intent, states, cursor: q.cursor, dir: q.dir === 'prev' ? 'prev' : 'next', limit: q.limit ?? 20 });
    await decorateMatchCards(pool, u(req).id, page.items); // name only after accept; phone only while shared
    return page;
  });
  const ownMatch = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const id = uuidParam(req.params.id);
    const { rows } = await pool.query(
      `SELECT m.* FROM match_refs r JOIN matches m ON m.vertical_id = r.vertical_id AND m.id = r.match_id
        WHERE r.public_id = $1 AND (m.a_user_id = $2 OR m.b_user_id = $2)`, [id, u(req).id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'غير موجود');
    return rows[0];
  };
  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req) => ({ match: (await decorateMatchCards(pool, u(req).id, await hydrateMatches(pool, reg, u(req).id, [await ownMatch(req)])))[0] }));
  app.post<{ Params: { id: string } }>('/api/matches/:id/contact', async (req) => {
    const m = await ownMatch(req);
    if (m.state === 'invalidated') throw new HttpError(409, 'match_invalidated', 'هذه المطابقة لم تعد صالحة');
    const { messageAr } = body(z.object({ messageAr: z.string().trim().max(500).optional() }), req);
    const me = u(req).id;
    const other = String(m.a_user_id) === me ? String(m.b_user_id) : String(m.a_user_id);
    // connections (docs/CONNECTIONS.md): same realm only, never between blocked users (either direction), and not on a
    // match whose connection already ended
    const refusal = await contactRefusal(pool, { verticalId: m.vertical_id, matchId: String(m.id) }, me, other);
    if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
    const { rows } = await pool.query(
      `INSERT INTO contact_requests (vertical_id, match_id, requester_id, recipient_id, message_ar) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (vertical_id, match_id, requester_id) DO UPDATE SET message_ar = coalesce(EXCLUDED.message_ar, contact_requests.message_ar) RETURNING public_id, status`,
      [m.vertical_id, m.id, me, other, messageAr ?? null],
    );
    await notify(pool, { recipientId: other, kind: 'contact_request', titleAr: 'طلب تواصل جديد', bodyAr: 'شخص مهتم بمطابقة معك. إذا وافقت يظهر لكما الاسم فقط وتُفتح محادثة داخل التطبيق؛ الرقم لا يظهر إلا إذا شاركه صاحبه.', payload: { matchId: m.public_id, requestId: rows[0].public_id }, dedupeKey: `contact:${rows[0].public_id}` });
    await emitUserEvent(pool, me, 'match_update');
    return { contactRequest: { id: rows[0].public_id, status: rows[0].status } };
  });
  app.post<{ Params: { id: string } }>('/api/contact-requests/:id/respond', async (req) => {
    const id = uuidParam(req.params.id);
    const { accept } = body(z.object({ accept: z.boolean() }), req);
    // accept and open the connection («ربط») in ONE transaction: one connection per match even under concurrent
    // accepts; accept reveals the display name only (the phone needs the owner's explicit «شارك رقمي»)
    const res = await withTx(pool, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE contact_requests c SET status = $3, responded_at = now() FROM match_refs r
          WHERE c.public_id = $1 AND c.recipient_id = $2 AND c.status = 'pending' AND r.vertical_id = c.vertical_id AND r.match_id = c.match_id
          RETURNING c.public_id, c.status, c.requester_id, c.vertical_id, c.match_id, r.public_id AS match_public_id`,
        [id, u(req).id, accept ? 'accepted' : 'declined'],
      );
      if (!rows[0]) return null;
      const connection = accept ? await openConnectionForMatch(tx, { verticalId: rows[0].vertical_id, matchId: String(rows[0].match_id) }) : null;
      return { row: rows[0], connection };
    }).catch((e) => { throw e instanceof ConnError ? new HttpError(e.status, e.code, e.message) : e; });
    if (!res) throw new HttpError(404, 'not_found', 'الطلب غير موجود أو تمت الإجابة عليه');
    const { row, connection } = res;
    await notify(pool, { recipientId: String(row.requester_id), kind: accept ? 'contact_accepted' : 'contact_declined', titleAr: accept ? 'تمت الموافقة على التواصل' : 'تم رفض طلب التواصل', bodyAr: accept ? 'صار بإمكانكما المحادثة داخل التطبيق. يظهر الاسم فقط؛ الرقم لا يظهر إلا إذا شاركه صاحبه.' : undefined, payload: { matchId: row.match_public_id, ...(connection ? { connectionId: connection.publicId } : {}) }, dedupeKey: `contact-reply:${row.public_id}` });
    await emitUserEvent(pool, u(req).id, 'match_update');
    await emitUserEvent(pool, String(row.requester_id), 'match_update');
    return { contactRequest: { id: row.public_id, status: row.status }, ...(connection ? { connection: { id: connection.publicId, status: connection.status } } : {}) };
  });

  // ── notifications (recipient-only)
  app.get('/api/notifications', async (req) => {
    const q = parseQuery(NotificationsQuery, req.query);
    return listNotifications(pool, u(req).id, { cursor: q.cursor, dir: q.dir === 'prev' ? 'prev' : 'next', limit: q.limit ?? 20, unreadOnly: q.unread === '1' || q.unread === 'true' });
  });
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req) => {
    if (!(await markRead(pool, u(req).id, uuidParam(req.params.id)))) throw new HttpError(404, 'not_found', 'غير موجود');
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
    const owner = (await pool.query("SELECT id FROM users WHERE handle = 'syn_owner_001' AND realm = 'synthetic'")).rows[0];
    if (!owner) throw new HttpError(503, 'demo_not_seeded', 'بيانات العرض التجريبي غير مهيأة (npm run db:seed)');
    const created = await withTx(pool, async (tx) => {
      const c = await createIntent(tx, reg, { userId: String(owner.id), realm: 'synthetic', spec: v.spec, titleAr: `${titleOf(reg, { side: v.spec.side, category: v.spec.categoryCode, deal: v.spec.deal, placeIds: v.spec.place.pointPlaceId ? [v.spec.place.pointPlaceId] : [], whenLabel: v.spec.when?.label })} (تجريبي — محاكاة)`, sourceText: null, conversationId: null });
      await enqueue(tx, 'match_intent', { verticalId: c.verticalId, intentId: c.id, version: c.version, trigger: 'job' }, { dedupeKey: `match:${c.verticalId}:${c.id}:${c.version}`, priority: 10 });
      return c;
    });
    return { created: { id: created.publicId }, noteAr: 'أُضيف عرض تجريبي جديد. سيصلك تنبيه عندما يطابقه العامل في الخلفية.' };
  });

  // ── server-sent events: live notifications/counts per user (capped per user, closed on shutdown)
  app.get('/api/events', async (req, reply) => {
    const me = u(req);
    if (!events.admit(me.id)) {
      reply.header('Retry-After', '30');
      throw new HttpError(429, 'too_many_streams', 'الصفحة مفتوحة في نوافذ كثيرة. أغلق بعضها ثم أعد المحاولة.');
    }
    reply.hijack();
    await events.attach(reply.raw, me.id, (cb) => reply.raw.on('close', cb));
  });
  // ── feature route plugins (after every hook above, so they inherit CSRF/auth/limits/logging/errors)
  const ctx: RouteContext = {
    pool, reg, events, limiter,
    user: (req) => { if (!req.user) throw new HttpError(401, 'unauthorized', 'سجّل الدخول أولًا'); return req.user; },
    maybeUser: (req) => req.user, body, parseQuery, uuidParam, HttpError,
    rateLimit: takeNamed,
  };
  for (const plugin of [...(deps.featureRoutes === false ? [] : FEATURE_ROUTES), ...(deps.routes ?? [])]) {
    try {
      await app.register(async (scope) => { await plugin.register(scope, ctx); });
    } catch (e) {
      throw new Error(`route plugin "${plugin.name}" failed to register: ${(e as Error).message}`);
    }
  }

  await events.start();
  app.addHook('preClose', async () => { events.endStreams(); });
  app.addHook('onClose', async () => { await events.stop(); });

  return app;
}

export function trustProxyFromEnv(v: string | undefined): number {
  if (v === undefined || v === '' || v === '0' || v.toLowerCase() === 'false') return 0;
  if (v.toLowerCase() === 'true') return 1;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 10 ? n : 0;
}

/**
 * Mutations must come from our own origin (Origin, else Referer; Sec-Fetch-Site when the browser sends it).
 * Strict mode: the origin's host:port must equal the Host header. Behind a trusted proxy (UL_TRUST_PROXY),
 * the browser's origin is the public forwarded host (e.g. https://<name>-8080.app.github.dev) while Host
 * may be localhost:8080, so the first X-Forwarded-Host value is accepted too.
 */
export function sameOrigin(req: Pick<FastifyRequest, 'headers'>, trustProxy = false): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return false;
  const src = req.headers.origin ?? (req.headers.referer ? String(req.headers.referer) : undefined);
  if (src === undefined) return site === undefined || site === 'same-origin' || site === 'none';
  let o: URL;
  try { o = new URL(String(src)); } catch { return false; } // "Origin: null" → refused
  if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
  const port = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : '80');
  const matches = (hostHeader: string | undefined) => {
    if (!hostHeader) return false;
    try {
      const h = new URL(`${o.protocol}//${hostHeader.trim()}`);
      return h.hostname === o.hostname && port(h) === port(o);
    } catch { return false; }
  };
  if (matches(req.headers.host)) return true;
  if (!trustProxy) return false;
  const xfh = req.headers['x-forwarded-host'];
  const first = (Array.isArray(xfh) ? xfh[0] : xfh)?.split(',')[0];
  return matches(first);
}

function publicUser(u: SessionUser) { return { publicId: u.publicId, displayName: u.displayName, realm: u.realm }; }

function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    try { out[part.slice(0, i).trim()] = decodeURIComponent(raw); } catch { out[part.slice(0, i).trim()] = raw; }
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
