// Connections («ربط») and in-app chat — HTTP routes (docs/CONNECTIONS.md, CONTRACTS.md "Connections & chat").
// Every route needs a session (401 otherwise) and answers 404 to anyone who is not one of the two participants.
// Message text is never logged (bodies are redacted by the server logger, and nothing here logs).
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { defineRoutes, type RouteContext } from '../context.ts';
import { decodeCursor } from '../../repo/paging.ts';
import {
  blockCounterpart, closeConnection, ConnError, getConnection, getLocation, listConnections, listMessages, markRead,
  MAX_MESSAGE_CHARS, messagesAfter, postPosition, REPORT_REASONS, reportCounterpart, sendMessage, SHARE_MINUTES,
  setPhoneShare, startLocationShare, statusesFor, stopLocationShare, unblockCounterpart,
} from '../../connections/repo.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const empty = (v: unknown) => (v === '' ? undefined : v);
const limit = (max: number) => z.preprocess(empty, z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(max)).optional());
const dir = z.preprocess(empty, z.enum(['next', 'prev']).optional());

/** (activity_at::text, id) cursors for the list; (seq, seq) cursors for messages — checked before any SQL. */
const tsCursor = z.preprocess(empty, z.string().max(300).regex(/^[A-Za-z0-9_-]+$/).optional()
  .refine((c) => c === undefined || (!!decodeCursor(c) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2}){0,2})?$/.test(decodeCursor(c)!.k)), { message: 'bad_cursor' }));
const seqCursor = z.preprocess(empty, z.string().max(100).regex(/^[A-Za-z0-9_-]+$/).optional()
  .refine((c) => { if (c === undefined) return true; const d = decodeCursor(c); return !!d && /^\d{1,9}$/.test(d.id) && d.k === d.id; }, { message: 'bad_cursor' }));

const ListQuery = z.object({ status: z.preprocess(empty, z.enum(['open', 'closed', 'archived', 'all']).optional()), cursor: tsCursor, dir, limit: limit(100) });
const MessagesQuery = z.object({ cursor: seqCursor, dir, limit: limit(100), after: z.preprocess(empty, z.string().regex(/^\d{1,9}$/).transform(Number).optional()) });

const SendBody = z.object({
  text: z.string().max(MAX_MESSAGE_CHARS * 4), // code points are checked after cleaning (repo); this bounds the payload
  clientMsgId: z.string().regex(UUID).transform((s) => s.toLowerCase()),
});
const ReadBody = z.object({ seq: z.number().int().min(0).max(2_000_000_000) });
const PhoneBody = z.object({ share: z.boolean(), phone: z.string().trim().max(30).optional().nullable() });
const StartBody = z.object({ minutes: z.union(SHARE_MINUTES.map((m) => z.literal(m)) as [z.ZodLiteral<15>, z.ZodLiteral<30>, z.ZodLiteral<60>]) });
const PositionBody = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).optional().nullable() });
const ReportBody = z.object({ reason: z.enum(REPORT_REASONS), note: z.string().max(500).optional().nullable() });

/** Rate limits (per session; env UL_RL_<NAME>_PER_MIN overrides, 0 disables). */
export const CONNECTION_LIMITS = {
  messages: { name: 'conn_messages', perMinute: 30 },
  location: { name: 'conn_location', perMinute: 20 },
  actions: { name: 'conn_actions', perMinute: 30 },
} as const;

export interface ConnectionsRoutesOptions {
  /** share durations in ms per allowed minute value (tests shorten them); default minutes × 60 000 */
  shareDurationMs?: (minutes: 15 | 30 | 60) => number;
}

export function makeConnectionsRoutes(opts: ConnectionsRoutesOptions = {}) {
  const durationMs = opts.shareDurationMs ?? ((m: number) => m * 60_000);
  return defineRoutes('connections', async (app, ctx) => {
    const me = (req: FastifyRequest) => ctx.user(req).id;
    const idOf = (req: FastifyRequest) => ctx.uuidParam((req.params as { id: string }).id);
    /** ConnError → the shared {error, messageAr} format with its status */
    const run = async <T>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); } catch (e) {
        if (e instanceof ConnError) throw new ctx.HttpError(e.status, e.code, e.message);
        throw e;
      }
    };
    const detail = (req: FastifyRequest) => run(() => getConnection(ctx.pool, idOf(req), me(req)));

    app.get('/api/connections', async (req) => {
      const q = ctx.parseQuery(ListQuery, req.query);
      return listConnections(ctx.pool, me(req), { statuses: statusesFor(q.status), cursor: q.cursor, dir: q.dir === 'prev' ? 'prev' : 'next', limit: q.limit ?? 20 });
    });

    app.get('/api/connections/:id', async (req) => ({ connection: await detail(req) }));

    app.get('/api/connections/:id/messages', async (req) => {
      const id = idOf(req);
      const q = ctx.parseQuery(MessagesQuery, req.query);
      if (q.after !== undefined) return run(() => messagesAfter(ctx.pool, id, me(req), q.after!, q.limit ?? 100));
      return run(() => listMessages(ctx.pool, id, me(req), { cursor: q.cursor, dir: q.dir === 'prev' ? 'prev' : 'next', limit: q.limit ?? 30 }));
    });

    app.post('/api/connections/:id/messages', { config: { rateLimit: CONNECTION_LIMITS.messages } }, async (req) => {
      const id = idOf(req);
      const b = ctx.body(SendBody, req);
      return run(() => sendMessage(ctx.pool, id, me(req), b));
    });

    app.post('/api/connections/:id/read', async (req) => {
      const id = idOf(req);
      const { seq } = ctx.body(ReadBody, req);
      return { ok: true, ...(await run(() => markRead(ctx.pool, id, me(req), seq))) };
    });

    app.post('/api/connections/:id/phone', { config: { rateLimit: CONNECTION_LIMITS.actions } }, async (req) => {
      const id = idOf(req);
      const b = ctx.body(PhoneBody, req);
      await run(() => setPhoneShare(ctx.pool, id, me(req), b.share, b.phone || null));
      return { connection: await detail(req) };
    });

    app.post('/api/connections/:id/location/start', { config: { rateLimit: CONNECTION_LIMITS.actions } }, async (req) => {
      const id = idOf(req);
      const { minutes } = ctx.body(StartBody, req);
      const share = await run(() => startLocationShare(ctx.pool, id, me(req), durationMs(minutes)));
      return { share, minutes };
    });

    app.post('/api/connections/:id/location/stop', { config: { rateLimit: CONNECTION_LIMITS.actions } }, async (req) => {
      const id = idOf(req);
      await run(() => stopLocationShare(ctx.pool, id, me(req)));
      return { ok: true };
    });

    // position pings from the sharer's device (client throttles to ≥ 15 s or ≥ 50 m)
    app.post('/api/connections/:id/location', { config: { rateLimit: CONNECTION_LIMITS.location } }, async (req) => {
      const id = idOf(req);
      const p = ctx.body(PositionBody, req);
      return { ok: true, ...(await run(() => postPosition(ctx.pool, id, me(req), p))) };
    });

    app.get('/api/connections/:id/location', async (req) => run(() => getLocation(ctx.pool, idOf(req), me(req))));

    const action = (path: string, fn: (pool: RouteContext['pool'], id: string, userId: string) => Promise<void>) =>
      app.post(`/api/connections/:id/${path}`, { config: { rateLimit: CONNECTION_LIMITS.actions } }, async (req) => {
        const id = idOf(req);
        await run(() => fn(ctx.pool, id, me(req)));
        return { connection: await detail(req) };
      });
    action('close', closeConnection);
    action('block', blockCounterpart);
    action('unblock', unblockCounterpart);

    app.post('/api/connections/:id/report', { config: { rateLimit: CONNECTION_LIMITS.actions } }, async (req) => {
      const id = idOf(req);
      const b = ctx.body(ReportBody, req);
      await run(() => reportCounterpart(ctx.pool, id, me(req), b.reason, b.note ?? null));
      return { ok: true, noteAr: 'وصلنا بلاغك وسيراجعه فريقنا. لا يُعاقَب أحد تلقائيًا.' };
    });
  });
}

/** The plugin to register in src/server/routes/index.ts (FEATURE_ROUTES). */
export default makeConnectionsRoutes();
