// Users & sessions. The raw session token lives only in an httpOnly cookie; the DB stores sha256(token).
import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/pool.ts';

export interface SessionUser { id: string; publicId: string; displayName: string; realm: 'real' | 'synthetic'; handle: string | null }

const hash = (t: string) => createHash('sha256').update(t).digest();

export async function createSession(db: Queryable, userId: string, days = 30): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))", [hash(token), userId, days]);
  return token;
}

export async function userForToken(db: Queryable, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await db.query(
    `UPDATE sessions s SET last_seen_at = now() FROM users u
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id
      RETURNING u.id, u.public_id, u.display_name, u.realm, u.handle`,
    [hash(token)],
  );
  const r = rows[0];
  return r ? { id: String(r.id), publicId: r.public_id, displayName: r.display_name, realm: r.realm, handle: r.handle } : null;
}

export async function deleteSession(db: Queryable, token: string | undefined): Promise<void> {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
}

export async function personaUser(db: Queryable, handle: string): Promise<SessionUser | null> {
  const { rows } = await db.query("SELECT id, public_id, display_name, realm, handle FROM users WHERE handle = $1 AND realm = 'synthetic' AND persona_ar IS NOT NULL", [handle]);
  const r = rows[0];
  return r ? { id: String(r.id), publicId: r.public_id, displayName: r.display_name, realm: r.realm, handle: r.handle } : null;
}

export async function registerUser(db: Queryable, displayName: string, phone: string | null): Promise<SessionUser> {
  const { rows } = await db.query("INSERT INTO users (display_name, realm, contact_phone) VALUES ($1, 'real', $2) RETURNING id, public_id, display_name, realm, handle", [displayName, phone]);
  const r = rows[0];
  return { id: String(r.id), publicId: r.public_id, displayName: r.display_name, realm: r.realm, handle: r.handle };
}

export async function counts(db: Queryable, userId: string): Promise<{ requests: number; offers: number; matches: number; unread: number }> {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM intents WHERE user_id = $1 AND side IN ('seek','join') AND status IN ('active','paused'))::int AS requests,
       (SELECT count(*) FROM intents WHERE user_id = $1 AND side = 'provide' AND status IN ('active','paused'))::int AS offers,
       (SELECT count(*) FROM matches WHERE (a_user_id = $1 OR b_user_id = $1) AND state IN ('confirmed','possible'))::int AS matches,
       (SELECT count(*) FROM notifications WHERE recipient_id = $1 AND read_at IS NULL)::int AS unread`,
    [userId],
  );
  return rows[0];
}
