// Notifications are private to their recipient. Duplicates are impossible: UNIQUE(recipient, dedupe_key).
import type { Queryable } from '../db/pool.ts';
import { decodeCursor, encodeCursor, type Page } from './paging.ts';

export interface NotificationOut {
  id: string; kind: string; titleAr: string; bodyAr: string | null; payload: Record<string, unknown>; createdAt: string; readAt: string | null;
}

export async function notify(db: Queryable, n: { recipientId: string; kind: string; titleAr: string; bodyAr?: string; payload?: Record<string, unknown>; dedupeKey: string }): Promise<boolean> {
  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_id, kind, title_ar, body_ar, payload, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (recipient_id, dedupe_key) DO NOTHING RETURNING id`,
    [n.recipientId, n.kind, n.titleAr, n.bodyAr ?? null, JSON.stringify(n.payload ?? {}), n.dedupeKey],
  );
  if (rows[0]) await db.query("SELECT pg_notify('ul_events', $1)", [JSON.stringify({ userId: n.recipientId, type: 'notification' })]);
  return !!rows[0];
}

export async function emitUserEvent(db: Queryable, userId: string, type: string): Promise<void> {
  await db.query("SELECT pg_notify('ul_events', $1)", [JSON.stringify({ userId, type })]);
}

export async function listNotifications(db: Queryable, userId: string, opts: { cursor?: string | null; dir?: 'next' | 'prev'; limit: number; unreadOnly?: boolean }): Promise<Page<NotificationOut> & { unread: number }> {
  const unreadFilter = opts.unreadOnly ? 'AND read_at IS NULL' : '';
  const total = Number((await db.query(`SELECT count(*) FROM notifications WHERE recipient_id = $1 ${unreadFilter}`, [userId])).rows[0].count);
  const unread = Number((await db.query('SELECT count(*) FROM notifications WHERE recipient_id = $1 AND read_at IS NULL', [userId])).rows[0].count);
  const cur = decodeCursor(opts.cursor);
  const prev = opts.dir === 'prev' && !!cur;
  const params: unknown[] = [userId, opts.limit + 1];
  let keyset = '';
  if (cur) { params.push(cur.k, cur.id); keyset = prev ? 'AND (created_at, id) > ($3::timestamptz, $4::bigint)' : 'AND (created_at, id) < ($3::timestamptz, $4::bigint)'; }
  const { rows } = await db.query(
    `SELECT id, public_id, kind, title_ar, body_ar, payload, created_at, created_at::text AS created_key, read_at FROM notifications
      WHERE recipient_id = $1 ${unreadFilter} ${keyset} ORDER BY created_at ${prev ? 'ASC' : 'DESC'}, id ${prev ? 'ASC' : 'DESC'} LIMIT $2`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  if (prev) page.reverse();
  let rangeStart = 0;
  if (page.length) {
    const f = page[0];
    rangeStart = Number((await db.query(`SELECT count(*) FROM notifications WHERE recipient_id = $1 ${unreadFilter} AND (created_at, id) > ($2::timestamptz, $3::bigint)`, [userId, f.created_key, f.id])).rows[0].count) + 1;
  }
  const items = page.map((r) => ({ id: r.public_id, kind: r.kind, titleAr: r.title_ar, bodyAr: r.body_ar, payload: r.payload, createdAt: new Date(r.created_at).toISOString(), readAt: r.read_at ? new Date(r.read_at).toISOString() : null }));
  return {
    items, total, unread, limit: opts.limit,
    nextCursor: page.length && (prev || hasMore) ? encodeCursor(page[page.length - 1].created_key, String(page[page.length - 1].id)) : null,
    prevCursor: page.length && rangeStart > 1 ? encodeCursor(page[0].created_key, String(page[0].id)) : null,
    rangeStart: items.length ? rangeStart : 0,
    rangeEnd: items.length ? rangeStart + items.length - 1 : 0,
  };
}

/** Only the recipient can mark a notification read (others get "not found"). */
export async function markRead(db: Queryable, userId: string, publicId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(publicId)) return false;
  const { rowCount } = await db.query('UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE public_id = $1 AND recipient_id = $2', [publicId, userId]);
  return (rowCount ?? 0) > 0;
}

export async function markAllRead(db: Queryable, userId: string): Promise<number> {
  const { rowCount } = await db.query('UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL', [userId]);
  return rowCount ?? 0;
}
