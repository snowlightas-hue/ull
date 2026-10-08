// Strict input validation for query strings and path params (bodies are validated per route with zod).
// Invalid input is a 400 with {error, messageAr}; nothing malformed ever reaches SQL.
import { z } from 'zod';
import { decodeCursor } from '../repo/paging.ts';
import { HttpError } from '../conversation/service.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** created_at::text as PostgreSQL prints it (DateStyle ISO), e.g. "2026-10-08 18:25:40.967123+00". */
const TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?([+-]\d{2}(:\d{2}){0,2})?$/;

function plausibleTimestamp(s: string): boolean {
  const m = TS_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 60) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // days in that month
  return d >= 1 && d <= dim;
}

/** Cursor kinds: 'ts' = (created_at, id) keyset, 'score' = (score, id) keyset. */
export function validCursor(raw: string, kind: 'ts' | 'score'): boolean {
  if (raw.length > 300 || !/^[A-Za-z0-9_-]+$/.test(raw)) return false;
  const c = decodeCursor(raw);
  if (!c) return false;
  if (kind === 'score') return /^\d{1,5}$/.test(c.k) && Number(c.k) <= 10000;
  return plausibleTimestamp(c.k);
}

const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);
const limit = z.preprocess(emptyToUndef, z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional());
const dir = z.preprocess(emptyToUndef, z.enum(['next', 'prev']).optional());
const cursor = (kind: 'ts' | 'score') => z.preprocess(emptyToUndef, z.string().optional().refine((c) => c === undefined || validCursor(c, kind), { message: 'bad_cursor' }));

const INTENT_STATUSES = ['active', 'paused', 'fulfilled', 'closed', 'expired'] as const;

export const IntentsQuery = z.object({
  side: z.preprocess(emptyToUndef, z.enum(['seek', 'provide', 'join', 'requests', 'offers']).optional()),
  status: z.preprocess(emptyToUndef, z.string().max(80).optional().transform((s, ctx) => {
    if (s === undefined || s === 'all') return undefined;
    const parts = s.split(',');
    if (!parts.every((p) => (INTENT_STATUSES as readonly string[]).includes(p))) { ctx.addIssue({ code: 'custom', message: 'bad_status' }); return z.NEVER; }
    return [...new Set(parts)];
  })),
  cursor: cursor('ts'),
  dir,
  limit,
});

export const MatchesQuery = z.object({
  intent: z.preprocess(emptyToUndef, z.string().regex(UUID_RE).optional()),
  state: z.preprocess(emptyToUndef, z.enum(['active', 'confirmed', 'possible', 'invalidated', 'all']).optional()),
  cursor: cursor('score'),
  dir,
  limit,
});

export const NotificationsQuery = z.object({
  unread: z.preprocess(emptyToUndef, z.enum(['1', '0', 'true', 'false']).optional()),
  cursor: cursor('ts'),
  dir,
  limit,
});

export const MatchRunQuery = z.object({ limit });

/** Optional device position sent with a turn ("near me"); validated ranges, accuracy in metres. */
export const Geo = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
});
export type GeoInput = z.infer<typeof Geo>;

/**
 * POST /api/conversations/:id/turns body. Unknown optional fields pass through untouched (newer clients can
 * send more context without being rejected); `geo: null` means "no position".
 */
export const TurnBody = z.looseObject({
  text: z.string().max(1000),
  modality: z.enum(['voice', 'text']).default('text'),
  clientTurnId: z.union([z.literal(''), z.string().regex(UUID_RE)]).default(''),
  geo: z.preprocess((v) => (v === null ? undefined : v), Geo.optional()),
});

/** Parse a query string with a schema; a bad cursor gets its own code so the client can restart paging. */
export function parseQuery<T extends z.ZodTypeAny>(schema: T, q: unknown): z.infer<T> {
  const r = schema.safeParse(q ?? {});
  if (r.success) return r.data;
  if (r.error.issues.some((i) => i.message === 'bad_cursor')) throw new HttpError(400, 'bad_cursor', 'مؤشر الصفحة غير صالح. ارجع إلى الصفحة الأولى.');
  throw new HttpError(400, 'bad_query', 'معاملات الطلب غير صالحة');
}

/** Path ids are public UUIDs; anything else is rejected before touching the database. */
export function uuidParam(v: unknown): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, 'bad_id', 'معرّف غير صالح');
  return v.toLowerCase();
}
