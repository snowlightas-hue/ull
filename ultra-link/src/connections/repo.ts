// Connections («ربط») and in-app chat: the domain + SQL behind src/server/routes/connections.ts.
//
// Rules enforced here (docs/CONNECTIONS.md):
//   * A connection exists only after a contact request was accepted; one per match (UNIQUE (vertical_id, match_id)).
//   * Only the two participants can see or touch it (every lookup filters on the session user → 404 for anyone else).
//   * Nothing personal is revealed automatically: after accept each side sees the other's display name only; the
//     phone (users.contact_phone) only while the owner's share is on AND the connection is open; a precise position
//     only while the owner's time-limited share is active AND the connection is open.
//   * Real users connect only with real users, synthetic with synthetic.
//   * A user-level block freezes every connection between the pair and refuses contact requests both ways.
//     The blocked side sees the connection as "closed" (it is not told who blocked whom).
//   * Messages: ≤ 1000 characters, idempotent per (sender, clientMsgId), numbered 1..n per connection under the
//     connection row lock (gap-free, commit-ordered), never logged.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTx, type Queryable } from '../db/pool.ts';
import { emitUserEvent, notify } from '../repo/notifications.ts';
import { decodeCursor, encodeCursor, type Page } from '../repo/paging.ts';
import { scheduleConnectionsSweep, scheduleLocationEnd } from './schedule.ts';

// ───────────── types ─────────────
export type ConnStatus = 'open' | 'closed' | 'blocked' | 'archived';
export type Side = 'a' | 'b';

export interface ConnRow {
  id: string; public_id: string; vertical_id: number; match_id: string; realm: 'real' | 'synthetic';
  a_user_id: string; b_user_id: string; a_intent_id: string; b_intent_id: string;
  status: ConnStatus; status_by: string | null; status_reason: string | null;
  a_phone_shared: boolean; b_phone_shared: boolean; a_last_read_seq: number; b_last_read_seq: number;
  message_count: number; last_message_at: Date | null; activity_at: Date; activity_key: string;
  created_at: Date; updated_at: Date; closed_at: Date | null; archived_at: Date | null;
}

export interface LocationOut {
  active: boolean; startedAt: string | null; expiresAt: string | null;
  /** counterpart's latest position — present only while their share is active and the connection is open */
  position?: { lat: number; lng: number; accuracyM: number | null; at: string } | null;
}

export interface ConnectionCard {
  id: string;
  /** viewer-relative: a connection blocked by the other side reads 'closed' */
  status: 'open' | 'closed' | 'blocked' | 'archived';
  blockedByMe: boolean;
  synthetic: boolean;
  matchId: string;
  counterpart: { displayName: string; phone?: string };
  titles: { mineAr: string | null; otherAr: string | null };
  unread: number;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionDetail extends ConnectionCard {
  canSend: boolean;
  reportedByMe: boolean;
  me: { phoneShared: boolean; hasPhone: boolean; lastReadSeq: number; location: LocationOut };
  them: { phoneShared: boolean; lastReadSeq: number; location: LocationOut };
}

export interface MessageOut { seq: number; mine: boolean; text: string; createdAt: string; clientMsgId?: string }

/** A refusal with an HTTP status, an error code and an Arabic message (routes turn it into HttpError). */
export class ConnError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, messageAr: string) { super(messageAr); this.status = status; this.code = code; }
}

const NOT_FOUND = () => new ConnError(404, 'not_found', 'غير موجود');
export const MSG = {
  notOpen: 'المحادثة مغلقة، لا يمكن إرسال رسائل أو مشاركة شيء فيها.',
  unavailable: 'لا يمكن إرسال طلب تواصل لهذه المطابقة.',
  realm: 'الحسابات التجريبية تتواصل مع حسابات تجريبية فقط، والحقيقية مع الحقيقية.',
  ended: 'انتهى التواصل في هذه المطابقة.',
};

// ───────────── helpers ─────────────
export const CONN_COLS = `c.id, c.public_id, c.vertical_id, c.match_id, c.realm, c.a_user_id, c.b_user_id, c.a_intent_id, c.b_intent_id,
  c.status, c.status_by, c.status_reason, c.a_phone_shared, c.b_phone_shared, c.a_last_read_seq, c.b_last_read_seq,
  c.message_count, c.last_message_at, c.activity_at, c.activity_at::text AS activity_key, c.created_at, c.updated_at, c.closed_at, c.archived_at`;

export function sideOf(c: Pick<ConnRow, 'a_user_id' | 'b_user_id'>, userId: string): Side | null {
  return String(c.a_user_id) === String(userId) ? 'a' : String(c.b_user_id) === String(userId) ? 'b' : null;
}
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');
const userOf = (c: ConnRow, s: Side) => String(s === 'a' ? c.a_user_id : c.b_user_id);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function viewStatus(c: Pick<ConnRow, 'status' | 'status_by'>, userId: string): ConnectionCard['status'] {
  if (c.status === 'blocked' && String(c.status_by) !== String(userId)) return 'closed';
  return c.status;
}

/** Pairs are frozen by a block in EITHER direction. */
export async function blockedBetween(db: Queryable, u1: string, u2: string): Promise<boolean> {
  const { rows } = await db.query(
    'SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1', [u1, u2]);
  return rows.length > 0;
}

/** The connection row if `userId` is one of its two participants, else null (callers answer 404). */
export async function loadForParticipant(db: Queryable, publicId: string, userId: string, lock = false): Promise<ConnRow | null> {
  const { rows } = await db.query(
    `SELECT ${CONN_COLS} FROM connections c WHERE c.public_id = $1 AND (c.a_user_id = $2 OR c.b_user_id = $2)${lock ? ' FOR UPDATE' : ''}`,
    [publicId, userId]);
  return rows[0] ?? null;
}

async function mustLoad(db: Queryable, publicId: string, userId: string, lock = false): Promise<{ c: ConnRow; me: Side }> {
  const c = await loadForParticipant(db, publicId, userId, lock);
  if (!c) throw NOT_FOUND();
  return { c, me: sideOf(c, userId)! };
}

async function matchPublicId(db: Queryable, verticalId: number, matchId: string): Promise<string | null> {
  const { rows } = await db.query('SELECT public_id FROM match_refs WHERE vertical_id = $1 AND match_id = $2', [verticalId, matchId]);
  return rows[0]?.public_id ?? null;
}

async function displayName(db: Queryable, userId: string): Promise<string> {
  const { rows } = await db.query('SELECT display_name FROM users WHERE id = $1', [userId]);
  return rows[0]?.display_name ?? 'الطرف الآخر';
}

/** "٣ رسائل جديدة" style counts (digits stay Latin here; the UI localizes them). */
export function unreadAr(n: number): string {
  if (n <= 1) return 'رسالة جديدة واحدة';
  if (n === 2) return 'رسالتان جديدتان';
  if (n <= 10) return `${n} رسائل جديدة`;
  return `${n} رسالة جديدة`;
}

function minutesAr(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m <= 1) return 'دقيقة';
  if (m === 2) return 'دقيقتين';
  if (m <= 10) return `${m} دقائق`;
  return `${m} دقيقة`;
}

// ───────────── contact flow hooks (used by POST /api/matches/:id/contact and /respond in src/server/app.ts) ─────────────

/**
 * May `me` send a contact request on this match to `otherId`? null = yes; else the refusal.
 * Refused when the two realms differ, when either blocked the other, or when this match's connection already ended.
 */
export async function contactRefusal(db: Queryable, match: { verticalId: number; matchId: string }, me: string, otherId: string): Promise<ConnError | null> {
  const { rows } = await db.query(
    `SELECT (SELECT count(DISTINCT realm) FROM users WHERE id = ANY($1::bigint[]))::int AS realms,
            EXISTS (SELECT 1 FROM user_blocks WHERE (blocker_id = $2 AND blocked_id = $3) OR (blocker_id = $3 AND blocked_id = $2)) AS blocked,
            (SELECT status FROM connections WHERE vertical_id = $4 AND match_id = $5) AS conn_status`,
    [[me, otherId], me, otherId, match.verticalId, match.matchId]);
  const r = rows[0];
  if (r.realms !== 1) return new ConnError(409, 'realm_mismatch', MSG.realm);
  if (r.blocked) return new ConnError(409, 'contact_unavailable', MSG.unavailable);
  if (r.conn_status && r.conn_status !== 'open') return new ConnError(409, 'connection_ended', MSG.ended);
  return null;
}

/**
 * Open (idempotently) the connection of an accepted contact request's match. Call inside the transaction that
 * accepted the request. Two concurrent accepts on one match end in ONE row: INSERT … ON CONFLICT DO NOTHING waits
 * for the other transaction and then reads its row.
 */
export async function openConnectionForMatch(db: Queryable, match: { verticalId: number; matchId: string }): Promise<{ id: string; publicId: string; status: ConnStatus; created: boolean }> {
  const { rows: mr } = await db.query(
    `SELECT m.a_user_id, m.b_user_id, m.a_intent_id, m.b_intent_id, ua.realm AS a_realm, ub.realm AS b_realm
       FROM matches m JOIN users ua ON ua.id = m.a_user_id JOIN users ub ON ub.id = m.b_user_id
      WHERE m.vertical_id = $1 AND m.id = $2`, [match.verticalId, match.matchId]);
  const m = mr[0];
  if (!m) throw NOT_FOUND();
  if (m.a_realm !== m.b_realm) throw new ConnError(409, 'realm_mismatch', MSG.realm);
  if (await blockedBetween(db, String(m.a_user_id), String(m.b_user_id))) throw new ConnError(409, 'contact_unavailable', MSG.unavailable);
  const ins = await db.query(
    `INSERT INTO connections (vertical_id, match_id, realm, a_user_id, b_user_id, a_intent_id, b_intent_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (vertical_id, match_id) DO NOTHING RETURNING id, public_id, status`,
    [match.verticalId, match.matchId, m.a_realm, m.a_user_id, m.b_user_id, m.a_intent_id, m.b_intent_id]);
  if (ins.rows[0]) {
    await scheduleConnectionsSweep(db);
    return { id: String(ins.rows[0].id), publicId: ins.rows[0].public_id, status: ins.rows[0].status, created: true };
  }
  const { rows } = await db.query('SELECT id, public_id, status FROM connections WHERE vertical_id = $1 AND match_id = $2', [match.verticalId, match.matchId]);
  return { id: String(rows[0].id), publicId: rows[0].public_id, status: rows[0].status, created: false };
}

// ───────────── reads ─────────────
const CARD_SELECT = (meParam: string) => `
  SELECT ${CONN_COLS}, r.public_id AS match_public_id,
         uo.display_name AS other_name,
         CASE WHEN c.status = 'open' AND (CASE WHEN c.a_user_id = ${meParam} THEN c.b_phone_shared ELSE c.a_phone_shared END)
              THEN uo.contact_phone END AS other_phone_visible,
         im.title_ar AS mine_title, io.title_ar AS other_title
    FROM connections c
    JOIN match_refs r ON r.vertical_id = c.vertical_id AND r.match_id = c.match_id
    JOIN users uo ON uo.id = CASE WHEN c.a_user_id = ${meParam} THEN c.b_user_id ELSE c.a_user_id END
    LEFT JOIN intents im ON im.vertical_id = c.vertical_id AND im.id = CASE WHEN c.a_user_id = ${meParam} THEN c.a_intent_id ELSE c.b_intent_id END
    LEFT JOIN intents io ON io.vertical_id = c.vertical_id AND io.id = CASE WHEN c.a_user_id = ${meParam} THEN c.b_intent_id ELSE c.a_intent_id END`;

function toCard(r: any, userId: string): ConnectionCard {
  const me = sideOf(r, userId)!;
  const lastRead = me === 'a' ? r.a_last_read_seq : r.b_last_read_seq;
  const status = viewStatus(r, userId);
  return {
    id: r.public_id, status, blockedByMe: r.status === 'blocked' && String(r.status_by) === String(userId),
    synthetic: r.realm === 'synthetic', matchId: r.match_public_id,
    counterpart: { displayName: r.other_name, ...(r.other_phone_visible ? { phone: r.other_phone_visible } : {}) },
    titles: { mineAr: r.mine_title ?? null, otherAr: r.other_title ?? null },
    unread: Math.max(0, r.message_count - lastRead), messageCount: r.message_count,
    lastMessageAt: iso(r.last_message_at), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

/** status filter → stored statuses ('closed' covers blocked ones: the blocked side sees them as closed). */
export function statusesFor(filter: 'open' | 'closed' | 'archived' | 'all' | undefined): ConnStatus[] {
  if (filter === 'closed') return ['closed', 'blocked'];
  if (filter === 'archived') return ['archived'];
  if (filter === 'all') return ['open', 'closed', 'blocked', 'archived'];
  return ['open'];
}

/** The viewer's connections, newest activity first, keyset-paginated with exact totals (like listIntents). */
export async function listConnections(db: Queryable, userId: string, opts: { statuses: ConnStatus[]; cursor?: string | null; dir?: 'next' | 'prev'; limit: number }): Promise<Page<ConnectionCard>> {
  const where = '(c.a_user_id = $1 OR c.b_user_id = $1) AND c.status = ANY($2)';
  const total = Number((await db.query(`SELECT count(*) FROM connections c WHERE ${where}`, [userId, opts.statuses])).rows[0].count);
  const cur = decodeCursor(opts.cursor);
  const prev = opts.dir === 'prev' && !!cur;
  const params: unknown[] = [userId, opts.statuses, opts.limit + 1];
  let keyset = '';
  if (cur) {
    params.push(cur.k, cur.id);
    keyset = prev ? 'AND (c.activity_at, c.id) > ($4::timestamptz, $5::bigint)' : 'AND (c.activity_at, c.id) < ($4::timestamptz, $5::bigint)';
  }
  const { rows } = await db.query(
    `${CARD_SELECT('$1')} WHERE ${where} ${keyset} ORDER BY c.activity_at ${prev ? 'ASC' : 'DESC'}, c.id ${prev ? 'ASC' : 'DESC'} LIMIT $3`, params);
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  if (prev) page.reverse();
  let rangeStart = 0;
  if (page.length) {
    const f = page[0];
    rangeStart = Number((await db.query(`SELECT count(*) FROM connections c WHERE ${where} AND (c.activity_at, c.id) > ($3::timestamptz, $4::bigint)`,
      [userId, opts.statuses, f.activity_key, f.id])).rows[0].count) + 1;
  }
  const items = page.map((r: any) => toCard(r, userId));
  const last = page[page.length - 1];
  const first = page[0];
  return {
    items, total, limit: opts.limit,
    nextCursor: last && (prev || hasMore) ? encodeCursor(last.activity_key, String(last.id)) : null,
    prevCursor: first && rangeStart > 1 ? encodeCursor(first.activity_key, String(first.id)) : null,
    rangeStart: items.length ? rangeStart : 0,
    rangeEnd: items.length ? rangeStart + items.length - 1 : 0,
  };
}

async function locationsOf(db: Queryable, c: ConnRow, userId: string): Promise<{ mine: LocationOut; theirs: LocationOut }> {
  const { rows } = await db.query(
    `SELECT sharer_id, started_at, expires_at, lat, lng, accuracy_m, position_at, (ended_at IS NULL AND expires_at > now()) AS active
       FROM connection_location_shares WHERE connection_id = $1`, [c.id]);
  const open = c.status === 'open';
  const out = (r: any, withPosition: boolean): LocationOut => {
    const active = !!r && r.active && open;
    const o: LocationOut = { active, startedAt: active ? iso(r.started_at) : null, expiresAt: active ? iso(r.expires_at) : null };
    if (withPosition) o.position = active && r.lat !== null ? { lat: r.lat, lng: r.lng, accuracyM: r.accuracy_m, at: iso(r.position_at)! } : null;
    return o;
  };
  const mine = rows.find((r) => String(r.sharer_id) === String(userId));
  const theirs = rows.find((r) => String(r.sharer_id) !== String(userId));
  return { mine: out(mine, false), theirs: out(theirs, true) };
}

export async function getConnection(db: Queryable, publicId: string, userId: string): Promise<ConnectionDetail> {
  const { rows } = await db.query(`${CARD_SELECT('$2')} WHERE c.public_id = $1 AND (c.a_user_id = $2 OR c.b_user_id = $2)`, [publicId, userId]);
  const r = rows[0];
  if (!r) throw NOT_FOUND();
  const card = toCard(r, userId);
  const me = sideOf(r, userId)!;
  const extra = (await db.query(
    `SELECT (SELECT contact_phone IS NOT NULL FROM users WHERE id = $1) AS has_phone,
            EXISTS (SELECT 1 FROM connection_reports WHERE connection_id = $2 AND reporter_id = $1) AS reported`, [userId, r.id])).rows[0];
  const loc = await locationsOf(db, r, userId);
  return {
    ...card,
    canSend: r.status === 'open',
    reportedByMe: extra.reported,
    me: { phoneShared: me === 'a' ? r.a_phone_shared : r.b_phone_shared, hasPhone: extra.has_phone, lastReadSeq: me === 'a' ? r.a_last_read_seq : r.b_last_read_seq, location: loc.mine },
    them: { phoneShared: r.status === 'open' && (me === 'a' ? r.b_phone_shared : r.a_phone_shared), lastReadSeq: me === 'a' ? r.b_last_read_seq : r.a_last_read_seq, location: loc.theirs },
  };
}

// ───────────── messages ─────────────
const msgOut = (r: any, userId: string): MessageOut => {
  const mine = String(r.sender_id) === String(userId);
  return { seq: r.seq, mine, text: r.body, createdAt: iso(r.created_at)!, ...(mine ? { clientMsgId: r.client_msg_id } : {}) };
};

/**
 * Newest first (like the other lists): `next` goes to OLDER messages, `prev` to newer ones. seq is gap-free 1..n,
 * so the exact total is message_count and a page's position is computed, not counted.
 */
export async function listMessages(db: Queryable, publicId: string, userId: string, opts: { cursor?: string | null; dir?: 'next' | 'prev'; limit: number }): Promise<Page<MessageOut> & { lastReadSeq: { mine: number; theirs: number } }> {
  const { c, me } = await mustLoad(db, publicId, userId);
  const total = c.message_count;
  const cur = decodeCursor(opts.cursor);
  const prev = opts.dir === 'prev' && !!cur;
  const params: unknown[] = [c.id, opts.limit + 1];
  let keyset = '';
  if (cur) { params.push(Number(cur.id)); keyset = prev ? 'AND seq > $3' : 'AND seq < $3'; }
  const { rows } = await db.query(
    `SELECT seq, sender_id, client_msg_id, body, created_at FROM connection_messages
      WHERE connection_id = $1 ${keyset} ORDER BY seq ${prev ? 'ASC' : 'DESC'} LIMIT $2`, params);
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  if (prev) page.reverse();
  const rangeStart = page.length ? total - page[0].seq + 1 : 0;
  const items = page.map((r) => msgOut(r, userId));
  const last = page[page.length - 1];
  const first = page[0];
  return {
    items, total, limit: opts.limit,
    nextCursor: last && (prev ? last.seq > 1 : hasMore) ? encodeCursor(last.seq, String(last.seq)) : null,
    prevCursor: first && rangeStart > 1 ? encodeCursor(first.seq, String(first.seq)) : null,
    rangeStart: items.length ? rangeStart : 0,
    rangeEnd: items.length ? rangeStart + items.length - 1 : 0,
    lastReadSeq: { mine: me === 'a' ? c.a_last_read_seq : c.b_last_read_seq, theirs: me === 'a' ? c.b_last_read_seq : c.a_last_read_seq },
  };
}

/** Live updates: messages with seq > after, oldest first (at most `limit`; `more` = call again). */
export async function messagesAfter(db: Queryable, publicId: string, userId: string, after: number, limit: number): Promise<{ items: MessageOut[]; more: boolean; total: number; lastReadSeq: { mine: number; theirs: number } }> {
  const { c, me } = await mustLoad(db, publicId, userId);
  const { rows } = await db.query(
    'SELECT seq, sender_id, client_msg_id, body, created_at FROM connection_messages WHERE connection_id = $1 AND seq > $2 ORDER BY seq LIMIT $3',
    [c.id, after, limit + 1]);
  return {
    items: rows.slice(0, limit).map((r) => msgOut(r, userId)), more: rows.length > limit, total: c.message_count,
    lastReadSeq: { mine: me === 'a' ? c.a_last_read_seq : c.b_last_read_seq, theirs: me === 'a' ? c.b_last_read_seq : c.a_last_read_seq },
  };
}

/** Strip control characters (keep newline/tab), trim; length counted in Unicode code points. */
export function cleanMessageText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}
export const MAX_MESSAGE_CHARS = 1000;
export const codePoints = (s: string) => [...s].length;

/**
 * Send one message. Idempotent: the same (sender, clientMsgId) returns the stored message (duplicate: true) — even
 * after the connection closed; the same id with a different text is a 409. The connection row is locked first, so
 * concurrent sends (and retries) on one connection are serialized and seq stays gap-free in commit order.
 * The counterpart gets ONE grouped unread notification per connection ("رسائل جديدة من …"), refreshed per message.
 */
export async function sendMessage(pool: pg.Pool, publicId: string, userId: string, input: { text: string; clientMsgId: string }): Promise<{ message: MessageOut; duplicate: boolean }> {
  const text = cleanMessageText(input.text);
  if (!text) throw new ConnError(400, 'empty_message', 'اكتب رسالة أولًا.');
  if (codePoints(text) > MAX_MESSAGE_CHARS) throw new ConnError(400, 'message_too_long', 'الرسالة طويلة. الحد ١٠٠٠ حرف.');
  return withTx(pool, async (tx) => {
    const { c, me } = await mustLoad(tx, publicId, userId, true);
    const dup = await tx.query(
      'SELECT seq, sender_id, client_msg_id, body, created_at FROM connection_messages WHERE connection_id = $1 AND sender_id = $2 AND client_msg_id = $3',
      [c.id, userId, input.clientMsgId]);
    if (dup.rows[0]) {
      if (dup.rows[0].body !== text) throw new ConnError(409, 'client_msg_id_reused', 'هذا المعرّف استُخدم لرسالة أخرى.');
      return { message: msgOut(dup.rows[0], userId), duplicate: true };
    }
    if (c.status !== 'open') throw new ConnError(409, 'connection_not_open', MSG.notOpen);
    const seq = c.message_count + 1;
    const ins = await tx.query(
      'INSERT INTO connection_messages (connection_id, seq, sender_id, client_msg_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING seq, sender_id, client_msg_id, body, created_at',
      [c.id, seq, userId, input.clientMsgId, text]);
    const up = await tx.query(
      `UPDATE connections SET message_count = $2, last_message_at = now(), activity_at = now(), updated_at = now(), ${me}_last_read_seq = $2
        WHERE id = $1 RETURNING a_last_read_seq, b_last_read_seq`, [c.id, seq]);
    const them = other(me);
    const theirUnread = seq - up.rows[0][`${them}_last_read_seq`];
    const recipient = userOf(c, them);
    const matchPublic = await matchPublicId(tx, c.vertical_id, c.match_id);
    await tx.query(
      `INSERT INTO notifications (recipient_id, kind, title_ar, body_ar, payload, dedupe_key) VALUES ($1, 'connection_message', $2, $3, $4, $5)
       ON CONFLICT (recipient_id, dedupe_key) DO UPDATE
         SET title_ar = EXCLUDED.title_ar, body_ar = EXCLUDED.body_ar, payload = EXCLUDED.payload, created_at = now(), read_at = NULL`,
      [recipient, `رسائل جديدة من ${await displayName(tx, userId)}`, unreadAr(theirUnread),
        JSON.stringify({ connectionId: c.public_id, matchId: matchPublic ?? null }), `conn-msg:${c.public_id}`]);
    // replying means I have read everything before: clear my own grouped notification for this connection
    await tx.query('UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND dedupe_key = $2 AND read_at IS NULL', [userId, `conn-msg:${c.public_id}`]);
    await emitUserEvent(tx, recipient, 'conn_message');
    await emitUserEvent(tx, userId, 'conn_message'); // the sender's other devices (the hub also pushes fresh counts)
    return { message: msgOut(ins.rows[0], userId), duplicate: false };
  });
}

/** Read receipt: my last read seq moves forward only (never past the newest message). */
export async function markRead(pool: pg.Pool, publicId: string, userId: string, seq: number): Promise<{ lastReadSeq: number; unread: number }> {
  return withTx(pool, async (tx) => {
    const { c, me } = await mustLoad(tx, publicId, userId);
    const col = `${me}_last_read_seq`;
    const { rows } = await tx.query(
      `UPDATE connections SET ${col} = greatest(${col}, least($2::int, message_count))
        WHERE id = $1 AND ${col} < least($2::int, message_count) RETURNING ${col} AS last_read, message_count`, [c.id, seq]);
    const moved = !!rows[0];
    const lastRead: number = moved ? rows[0].last_read : me === 'a' ? c.a_last_read_seq : c.b_last_read_seq;
    const count: number = moved ? rows[0].message_count : c.message_count;
    if (lastRead >= count) {
      const n = await tx.query('UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND dedupe_key = $2 AND read_at IS NULL', [userId, `conn-msg:${c.public_id}`]);
      if ((n.rowCount ?? 0) > 0) await emitUserEvent(tx, userId, 'counts');
    }
    if (moved) await emitUserEvent(tx, userOf(c, other(me)), 'conn_update'); // their "read" ticks
    return { lastReadSeq: lastRead, unread: Math.max(0, count - lastRead) };
  });
}

// ───────────── phone sharing ─────────────
export const PHONE_RE = /^[0-9+()\-\s.]{5,30}$/;

/** «شارك رقمي» on/off for my side. Turning it on needs a phone (stored, or given here and saved to my account). */
export async function setPhoneShare(pool: pg.Pool, publicId: string, userId: string, share: boolean, phone?: string | null): Promise<void> {
  await withTx(pool, async (tx) => {
    const { c, me } = await mustLoad(tx, publicId, userId, true);
    if (c.status !== 'open') throw new ConnError(409, 'connection_not_open', MSG.notOpen);
    if (share) {
      if (phone) {
        const p = phone.trim();
        if (!PHONE_RE.test(p) || (p.match(/\d/g) ?? []).length < 5) throw new ConnError(400, 'bad_phone', 'رقم الهاتف غير صالح.');
        await tx.query('UPDATE users SET contact_phone = $2 WHERE id = $1', [userId, p]);
      }
      const has = (await tx.query('SELECT contact_phone IS NOT NULL AS has FROM users WHERE id = $1', [userId])).rows[0]?.has;
      if (!has) throw new ConnError(409, 'no_phone', 'أضف رقم هاتفك أولًا حتى تشاركه.');
    }
    await tx.query(`UPDATE connections SET ${me}_phone_shared = $2, updated_at = now() WHERE id = $1`, [c.id, share]);
    await emitUserEvent(tx, userOf(c, other(me)), 'conn_update');
  });
}

// ───────────── live location (time-limited) ─────────────
export const SHARE_MINUTES = [15, 30, 60] as const;
const ENDED_COLS = 'lat = NULL, lng = NULL, accuracy_m = NULL, position_at = NULL';

/** Start (or restart) my share for `durationMs` (≤ 60 min). The counterpart is notified once per share. */
export async function startLocationShare(pool: pg.Pool, publicId: string, userId: string, durationMs: number): Promise<LocationOut> {
  if (!(durationMs > 0 && durationMs <= 3_600_000)) throw new ConnError(400, 'bad_duration', 'مدة غير صالحة.');
  return withTx(pool, async (tx) => {
    const { c, me } = await mustLoad(tx, publicId, userId, true);
    if (c.status !== 'open') throw new ConnError(409, 'connection_not_open', MSG.notOpen);
    const { rows } = await tx.query(
      `INSERT INTO connection_location_shares (connection_id, sharer_id, share_id, started_at, expires_at)
       VALUES ($1, $2, $3, now(), now() + make_interval(secs => $4::double precision))
       ON CONFLICT (connection_id, sharer_id) DO UPDATE SET share_id = EXCLUDED.share_id, started_at = EXCLUDED.started_at,
         expires_at = EXCLUDED.expires_at, ended_at = NULL, end_reason = NULL, ${ENDED_COLS}
       RETURNING share_id, started_at, expires_at`,
      [c.id, userId, randomUUID(), durationMs / 1000]);
    const s = rows[0];
    await scheduleLocationEnd(tx, s.share_id, new Date(s.expires_at));
    const recipient = userOf(c, other(me));
    // conn_update BEFORE the notification: the client then shows its own toast instead of the generic one
    await emitUserEvent(tx, recipient, 'conn_update');
    await notify(tx, {
      recipientId: recipient, kind: 'location_share_started',
      titleAr: `${await displayName(tx, userId)} يشارك موقعه المباشر معك`,
      bodyAr: `لمدة ${minutesAr(durationMs)}. افتح المحادثة لترى موقعه.`,
      payload: { connectionId: c.public_id, matchId: await matchPublicId(tx, c.vertical_id, c.match_id) }, dedupeKey: `loc-start:${s.share_id}`,
    });
    return { active: true, startedAt: iso(s.started_at), expiresAt: iso(s.expires_at) };
  });
}

async function notifyShareEnded(db: Queryable, c: Pick<ConnRow, 'a_user_id' | 'b_user_id' | 'public_id' | 'vertical_id' | 'match_id'>, sharerId: string, shareId: string, reason: 'stopped' | 'expired'): Promise<void> {
  const recipient = String(c.a_user_id) === String(sharerId) ? String(c.b_user_id) : String(c.a_user_id);
  await emitUserEvent(db, recipient, 'conn_update'); // before the notification (see startLocationShare)
  await emitUserEvent(db, sharerId, 'conn_update');
  await notify(db, {
    recipientId: recipient, kind: 'location_share_ended',
    titleAr: `انتهت مشاركة موقع ${await displayName(db, sharerId)}`,
    bodyAr: reason === 'stopped' ? 'أوقف مشاركة موقعه.' : 'انتهت المدة المحددة للمشاركة.',
    payload: { connectionId: c.public_id, matchId: await matchPublicId(db, c.vertical_id, c.match_id) }, dedupeKey: `loc-end:${shareId}`,
  });
}

/** Stop my share now; the stored position is erased. Idempotent (no active share → ok). */
export async function stopLocationShare(pool: pg.Pool, publicId: string, userId: string): Promise<void> {
  await withTx(pool, async (tx) => {
    const { c } = await mustLoad(tx, publicId, userId, true);
    const { rows } = await tx.query(
      `UPDATE connection_location_shares SET ended_at = least(now(), expires_at),
         end_reason = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'stopped' END, ${ENDED_COLS}
        WHERE connection_id = $1 AND sharer_id = $2 AND ended_at IS NULL RETURNING share_id, end_reason`, [c.id, userId]);
    if (rows[0]) await notifyShareEnded(tx, c, userId, rows[0].share_id, rows[0].end_reason);
  });
}

/** A position ping from the sharer's device. Refused (409) unless my share is active and the connection open. */
export async function postPosition(pool: pg.Pool, publicId: string, userId: string, p: { lat: number; lng: number; accuracyM?: number | null }): Promise<{ expiresAt: string }> {
  const c = await loadForParticipant(pool, publicId, userId);
  if (!c) throw NOT_FOUND();
  const { rows } = await pool.query(
    `UPDATE connection_location_shares s SET lat = $3, lng = $4, accuracy_m = $5, position_at = now()
       FROM connections c
      WHERE s.connection_id = $1 AND s.sharer_id = $2 AND s.ended_at IS NULL AND s.expires_at > now()
        AND c.id = s.connection_id AND c.status = 'open'
      RETURNING s.expires_at`,
    [c.id, userId, p.lat, p.lng, p.accuracyM == null ? null : Math.round(p.accuracyM)]);
  if (!rows[0]) throw new ConnError(409, 'share_not_active', 'مشاركة الموقع متوقفة. ابدأها من جديد إذا أردت.');
  await emitUserEvent(pool, userOf(c, other(sideOf(c, userId)!)), 'conn_location');
  return { expiresAt: iso(rows[0].expires_at)! };
}

export async function getLocation(db: Queryable, publicId: string, userId: string): Promise<{ mine: LocationOut; theirs: LocationOut }> {
  const { c } = await mustLoad(db, publicId, userId);
  return locationsOf(db, c, userId);
}

/** End shares whose time ran out (job at expiry + sweep safety net): erase coordinates, notify the counterpart. */
export async function endExpiredShares(db: Queryable, shareId?: string): Promise<number> {
  const { rows } = await db.query(
    `UPDATE connection_location_shares s SET ended_at = s.expires_at, end_reason = 'expired', ${ENDED_COLS}
       FROM connections c
      WHERE s.ended_at IS NULL AND s.expires_at <= now() AND c.id = s.connection_id ${shareId ? 'AND s.share_id = $1' : ''}
      RETURNING s.share_id, s.sharer_id, c.public_id, c.a_user_id, c.b_user_id, c.status, c.vertical_id, c.match_id`, shareId ? [shareId] : []);
  for (const r of rows) {
    if (r.status === 'open') await notifyShareEnded(db, r, String(r.sharer_id), r.share_id, 'expired');
  }
  return rows.length;
}

async function endSharesOf(db: Queryable, connectionIds: string[]): Promise<void> {
  if (!connectionIds.length) return;
  await db.query(
    `UPDATE connection_location_shares SET ended_at = least(now(), expires_at), end_reason = 'connection_ended', ${ENDED_COLS}
      WHERE connection_id = ANY($1::bigint[]) AND ended_at IS NULL`, [connectionIds]);
}

// ───────────── close / block / unblock / report ─────────────
export async function closeConnection(pool: pg.Pool, publicId: string, userId: string): Promise<void> {
  await withTx(pool, async (tx) => {
    const { c, me } = await mustLoad(tx, publicId, userId, true);
    if (c.status === 'closed' || (c.status === 'blocked' && viewStatus(c, userId) === 'closed')) return; // already closed
    if (c.status !== 'open') throw new ConnError(409, 'invalid_transition', 'لا يمكن تنفيذ هذا الإجراء على حالتها الحالية.');
    await tx.query(
      `UPDATE connections SET status = 'closed', status_by = $2, status_reason = 'closed_by_user', closed_at = now(), updated_at = now(),
         a_phone_shared = false, b_phone_shared = false WHERE id = $1`, [c.id, userId]);
    await endSharesOf(tx, [c.id]);
    await emitUserEvent(tx, userOf(c, other(me)), 'conn_update');
    await emitUserEvent(tx, userId, 'conn_update');
  });
}

/**
 * Block the other participant (user-level): every connection between the two becomes 'blocked' (phones and
 * location shares off), pending contact requests between them are cancelled, and new ones are refused both ways.
 * Idempotent; blocking someone who already blocked me also records my block (both must unblock).
 */
export async function blockCounterpart(pool: pg.Pool, publicId: string, userId: string): Promise<void> {
  await withTx(pool, async (tx) => {
    const { c, me } = await mustLoad(tx, publicId, userId, true);
    const otherId = userOf(c, other(me));
    await tx.query('INSERT INTO user_blocks (blocker_id, blocked_id, connection_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, otherId, c.id]);
    const { rows } = await tx.query(
      `UPDATE connections SET status = 'blocked', status_by = $1, status_reason = 'blocked_by_user', closed_at = coalesce(closed_at, now()),
         archived_at = NULL, updated_at = now(), a_phone_shared = false, b_phone_shared = false
        WHERE ((a_user_id = $1 AND b_user_id = $2) OR (a_user_id = $2 AND b_user_id = $1)) AND status <> 'blocked'
        RETURNING id`, [userId, otherId]);
    await endSharesOf(tx, rows.map((r) => String(r.id)));
    await tx.query(
      `UPDATE contact_requests SET status = 'cancelled', responded_at = now()
        WHERE status = 'pending' AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))`, [userId, otherId]);
    await emitUserEvent(tx, otherId, 'conn_update');
    await emitUserEvent(tx, userId, 'conn_update');
  });
}

/** Lift MY block. Connections I froze become 'closed' (not reopened), unless the other side blocks me too. */
export async function unblockCounterpart(pool: pg.Pool, publicId: string, userId: string): Promise<void> {
  await withTx(pool, async (tx) => {
    const { c, me } = await mustLoad(tx, publicId, userId, true);
    const otherId = userOf(c, other(me));
    const del = await tx.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [userId, otherId]);
    if (!(del.rowCount ?? 0)) return;
    const theyBlockMe = (await tx.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [otherId, userId])).rows.length > 0;
    await tx.query(
      theyBlockMe
        ? `UPDATE connections SET status_by = $2, updated_at = now()
            WHERE ((a_user_id = $1 AND b_user_id = $2) OR (a_user_id = $2 AND b_user_id = $1)) AND status = 'blocked' AND status_by = $1`
        : `UPDATE connections SET status = 'closed', status_reason = 'closed_by_user', updated_at = now()
            WHERE ((a_user_id = $1 AND b_user_id = $2) OR (a_user_id = $2 AND b_user_id = $1)) AND status = 'blocked' AND status_by = $1`,
      [userId, otherId]);
    await emitUserEvent(tx, userId, 'conn_update');
  });
}

export const REPORT_REASONS = ['spam', 'scam', 'abuse', 'inappropriate', 'fake', 'other'] as const;

/** Store a report for human review (one per reporter and connection; a new report updates it). Never auto-bans. */
export async function reportCounterpart(pool: pg.Pool, publicId: string, userId: string, reason: typeof REPORT_REASONS[number], note?: string | null): Promise<void> {
  const { c, me } = await mustLoad(pool, publicId, userId);
  await pool.query(
    `INSERT INTO connection_reports (connection_id, reporter_id, reported_id, reason, note) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (connection_id, reporter_id) DO UPDATE SET reason = EXCLUDED.reason, note = EXCLUDED.note, status = 'open', updated_at = now()`,
    [c.id, userId, userOf(c, other(me)), reason, note?.trim() ? note.trim().slice(0, 500) : null]);
}
