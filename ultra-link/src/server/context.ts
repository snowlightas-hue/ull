// Extension point for feature route plugins (src/server/routes/<feature>.ts).
//
// A feature plugin is registered by buildApp() AFTER the global hooks, so every route it adds gets, for free:
//   - the CSRF guard (JSON content type + same origin) on mutations,
//   - the session lookup and 401 for anonymous callers (opt out per route with `config: { public: true }`),
//   - privacy-safe logging, the shared error handler ({error, messageAr}), security headers, no-store caching.
// Per-route options (Fastify route `config`):
//   public: true                        → no session required (e.g. a shared link page)
//   rateLimit: { name, perMinute, by }  → token bucket keyed by session (default) or client IP → 429 + Retry-After
//   contentTypes: ['image/jpeg', ...]   → extra accepted request content types for this mutation (uploads)
//
// Example (src/server/routes/geo.ts):
//   import { z } from 'zod';
//   import { defineRoutes } from '../context.ts';
//   export default defineRoutes('geo', async (app, ctx) => {
//     app.get('/api/geo/nearby', { config: { rateLimit: { name: 'geo_nearby', perMinute: 60 } } }, async (req) => {
//       const q = ctx.parseQuery(z.object({ lat: z.coerce.number().min(-90).max(90) }), req.query);
//       return { me: ctx.user(req).publicId, lat: q.lat };
//     });
//   });
// and add it to FEATURE_ROUTES in src/server/routes/index.ts (or pass `routes: [plugin]` to buildApp in tests).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import type { Registry } from '../domain/registry.ts';
import type { SessionUser } from '../repo/users.ts';
import type { EventHub } from './events.ts';
import type { BucketRule, TokenBuckets } from './ratelimit.ts';

export interface RouteRateLimit {
  /** bucket name (also the key in /api/metrics → rateLimited) */
  name: string;
  perMinute: number;
  /** 'session' (default; falls back to IP when anonymous) or 'ip' */
  by?: 'session' | 'ip';
}

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
    rateLimit?: RouteRateLimit;
    contentTypes?: string[];
  }
}

export interface RouteContext {
  pool: pg.Pool;
  reg: Registry;
  /** the session user (routes without `public: true` are guaranteed one) */
  user(req: FastifyRequest): SessionUser;
  /** the session user or null (for `public: true` routes) */
  maybeUser(req: FastifyRequest): SessionUser | null;
  /** validate a JSON body → 400 {error:'bad_request'} */
  body<T extends z.ZodTypeAny>(schema: T, req: FastifyRequest): z.infer<T>;
  /** validate a query string → 400 {error:'bad_query'|'bad_cursor'} */
  parseQuery<T extends z.ZodTypeAny>(schema: T, q: unknown): z.infer<T>;
  /** a public UUID path param → lower-cased, else 400 {error:'bad_id'} */
  uuidParam(v: unknown): string;
  /** throw new ctx.HttpError(404, 'not_found', 'غير موجود') → {error, messageAr} with that status */
  HttpError: new (status: number, code: string, message: string) => Error;
  /** take one token from a named bucket inside a handler; false = 429 already sent */
  rateLimit(req: FastifyRequest, reply: FastifyReply, limit: RouteRateLimit): boolean;
  /** live events hub (push `counts`/custom events to a user's open SSE streams via pg_notify) */
  events: EventHub;
  limiter: TokenBuckets;
}

export type UlRoutePlugin = {
  readonly name: string;
  register(app: FastifyInstance, ctx: RouteContext): Promise<void>;
};

/** Declare a feature route plugin (see the header comment for an example). */
export function defineRoutes(name: string, register: (app: FastifyInstance, ctx: RouteContext) => Promise<void>): UlRoutePlugin {
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(name)) throw new Error(`bad route plugin name "${name}"`);
  return { name, register };
}

export const perMinuteRule = (n: number): BucketRule => ({ capacity: Math.max(1, Math.floor(n)), windowMs: 60_000 });
