// Feature routes: live-position sharing and "nearest to my intent" (V2.1 location; docs/GEO.md).
// Registered like every feature plugin (src/server/routes/index.ts → FEATURE_ROUTES), so CSRF/auth/logging/errors are
// inherited. Owner-only: an intent that is not yours answers 404, exactly like the core intent routes.
//
//   POST   /api/intents/:id/live        {lat,lng,accuracyM,heading?,speedKmh?} → {live}   (provide/join, active; ≥10 s apart)
//   DELETE /api/intents/:id/live        → {ok, stopped}                                      (stop sharing)
//   POST   /api/intents/:id/live/stop   → same as DELETE (for clients whose API helper has no DELETE)
//   GET    /api/intents/:id/nearby?limit=1..50 → {items:[{intent, distance, live, freshnessAr, verdict, score, reasons, matchId}], limitAr, from, truncated}
//
// A ping is one upsert: no version bump, no re-match. Coordinates are never echoed or returned for anyone.
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { defineRoutes } from '../context.ts';
import { resolveIntentRef } from '../../repo/intents.ts';
import { stopLive, upsertLivePosition } from '../../geo/live.ts';
import { nearbyFor } from '../../geo/nearby.ts';
import { LIVE_FRESH_MS, LIVE_MIN_INTERVAL_MS, PRECISE_FIX_MAX_M } from '../../geo/semantics.ts';

const LiveBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000),
  heading: z.number().min(0).max(360).nullable().optional(),
  speedKmh: z.number().min(0).max(400).nullable().optional(),
});
const NearbyQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() });

export default defineRoutes('geo', async (app, ctx) => {
  const own = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const ref = await resolveIntentRef(ctx.pool, ctx.uuidParam(req.params.id));
    if (!ref || ref.userId !== ctx.user(req).id) throw new ctx.HttpError(404, 'not_found', 'غير موجود'); // never reveal others' ids
    return ref;
  };

  app.post<{ Params: { id: string } }>('/api/intents/:id/live', { config: { rateLimit: { name: 'geo_live', perMinute: 30 } } }, async (req, reply) => {
    const ref = await own(req);
    const b = ctx.body(LiveBody, req);
    if (b.accuracyM > PRECISE_FIX_MAX_M) throw new ctx.HttpError(422, 'inaccurate_fix', 'دقة الموقع ضعيفة (أكثر من 3 كم). جرّب في مكان مفتوح أو فعّل GPS.');
    const r = await upsertLivePosition(ctx.pool, ref, ctx.user(req).id, b);
    if (r.ok) {
      return { live: { sharing: true, fresh: true, labelAr: 'متصل الآن', updatedAt: r.updatedAt, expiresAt: r.expiresAt, startedAt: r.startedAt, minIntervalSec: LIVE_MIN_INTERVAL_MS / 1000, ttlSec: LIVE_FRESH_MS / 1000 } };
    }
    switch (r.reason) {
      case 'not_found': throw new ctx.HttpError(404, 'not_found', 'غير موجود');
      case 'side_not_allowed': throw new ctx.HttpError(422, 'live_not_allowed', 'مشاركة الموقع المباشر متاحة للعروض والأنشطة فقط');
      case 'inactive': throw new ctx.HttpError(409, 'inactive', 'العرض غير نشط — استأنفه أولًا لمشاركة موقعك');
      case 'inaccurate': throw new ctx.HttpError(422, 'inaccurate_fix', 'دقة الموقع ضعيفة');
      case 'too_soon':
        return reply.code(429).header('Retry-After', String(Math.max(1, Math.ceil((r.retryAfterMs ?? LIVE_MIN_INTERVAL_MS) / 1000))))
          .send({ error: 'rate_limited', messageAr: 'تحديث الموقع متكرر جدًا — مرة كل 10 ثوانٍ على الأكثر' });
    }
  });

  const stop = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const ref = await own(req);
    return { ok: true, stopped: await stopLive(ctx.pool, ref, ctx.user(req).id) };
  };
  app.delete<{ Params: { id: string } }>('/api/intents/:id/live', async (req) => stop(req));
  app.post<{ Params: { id: string } }>('/api/intents/:id/live/stop', async (req) => stop(req));

  app.get<{ Params: { id: string } }>('/api/intents/:id/nearby', { config: { rateLimit: { name: 'geo_nearby', perMinute: 60 } } }, async (req) => {
    const ref = await own(req);
    const q = ctx.parseQuery(NearbyQuery, req.query);
    const r = await nearbyFor(ctx.pool, ctx.reg, ref, { limit: q.limit ?? 10 });
    if (r.ok) return { items: r.items, limitAr: r.limitAr, from: r.from, truncated: r.truncated };
    if (r.reason === 'not_found') throw new ctx.HttpError(404, 'not_found', 'غير موجود');
    if (r.reason === 'inactive') throw new ctx.HttpError(409, 'inactive', 'الطلب غير نشط');
    throw new ctx.HttpError(422, 'no_location', 'لا نعرف موقع هذا الطلب. استخدم «موقعي الحالي» أو حدّد المكان.');
  });
});

