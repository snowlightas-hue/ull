// Account recovery for real (non-demo) accounts — REVIEW.md MAJOR-6.
//
// A recovery code is 16 characters from Crockford's base32 alphabet (0-9 A-Z without I, L, O, U: nothing that reads
// like another character), shown as 4 groups of 4: "7KQ2-M9XD-4TRC-PW3H". 16 × 5 bits = 80 random bits.
//
// Storage: only HMAC-SHA256(pepper, "ul-recovery-v1:" + normalized code) is kept (user_recovery_codes.code_hash,
// UNIQUE). Decision: HMAC with a server-side pepper, not scrypt. The code is 80 random bits (not a human password),
// so a slow hash adds nothing against brute force, while a deterministic keyed hash allows a direct UNIQUE-index
// lookup (exactly like sessions.token_hash) — no per-user scan, no username needed. The pepper (env
// UL_RECOVERY_PEPPER) lives outside the database: a database dump alone does not let anyone test candidate codes.
// Changing the pepper invalidates every stored code (users then regenerate from inside a session).
//
// Comparison: the lookup is by HMAC value, and the matched row is compared again with crypto.timingSafeEqual; a
// well-formed but unknown code does the same work as a hit (one HMAC, one index probe, one timingSafeEqual against a
// dummy). A malformed code is refused before the probe (its shape is visible to the caller anyway). An attacker cannot
// steer the HMAC (no pepper), so index-lookup timing leaks nothing usable.
// Brute force is bounded by the per-IP limits on /api/auth/recover (docs/CONNECTIONS.md §Recovery).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/pool.ts';
import type { SessionUser } from '../repo/users.ts';

export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 16;
const DEV_PEPPER = 'ultra-link-dev-recovery-pepper-NOT-FOR-PRODUCTION';
let warned = false;

/** The pepper from env UL_RECOVERY_PEPPER; a fixed development value (with one warning) when unset. */
export function recoveryPepper(): string {
  const p = process.env.UL_RECOVERY_PEPPER;
  if (p && p.length >= 16) return p;
  if (!warned && process.env.NODE_ENV === 'production') {
    warned = true;
    console.warn('[recovery] UL_RECOVERY_PEPPER is not set (or shorter than 16 chars): using the development pepper');
  }
  return DEV_PEPPER;
}

/** A fresh code, formatted "XXXX-XXXX-XXXX-XXXX". 32 divides 256, so `byte & 31` is unbiased. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += RECOVERY_ALPHABET[bytes[i]! & 31];
  return formatRecoveryCode(s);
}

export function formatRecoveryCode(normalized: string): string {
  return normalized.match(/.{1,4}/g)!.join('-');
}

/**
 * User input → the 16 canonical characters, or null. Accepts Arabic-Indic / Persian digits, lower case, spaces,
 * dashes and dots, and the Crockford aliases O→0, I/L→1 (people copy codes by hand).
 */
export function normalizeRecoveryCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toUpperCase()
    .replace(/[\s\-_.‐-―−]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s;
}

export function hashRecoveryCode(normalized: string, pepper = recoveryPepper()): Buffer {
  return createHmac('sha256', pepper).update(`ul-recovery-v1:${normalized}`).digest();
}

/** Create or replace the user's code (the old one stops working at once). Returns the code — show it once. */
export async function issueRecoveryCode(db: Queryable, userId: string): Promise<{ code: string; createdAt: string }> {
  const code = generateRecoveryCode();
  const { rows } = await db.query(
    `INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, created_at = now(), last_used_at = NULL
     RETURNING created_at`,
    [userId, hashRecoveryCode(normalizeRecoveryCode(code)!)],
  );
  return { code, createdAt: new Date(rows[0].created_at).toISOString() };
}

export async function recoveryStatus(db: Queryable, userId: string): Promise<{ hasCode: boolean; createdAt: string | null; lastUsedAt: string | null }> {
  const { rows } = await db.query('SELECT created_at, last_used_at FROM user_recovery_codes WHERE user_id = $1', [userId]);
  const r = rows[0];
  return { hasCode: !!r, createdAt: r ? new Date(r.created_at).toISOString() : null, lastUsedAt: r?.last_used_at ? new Date(r.last_used_at).toISOString() : null };
}

/** Display names compared loosely: Unicode NFKC, tatweel/diacritics dropped, whitespace collapsed, case folded. */
export function sameDisplayName(a: string, b: string): boolean {
  const n = (s: string) => s.normalize('NFKC').replace(/[ـً-ٰٟ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return n(a) === n(b);
}

const DUMMY = Buffer.alloc(32);

/**
 * The real account owning this code, or null (wrong/malformed code, name given but different, or not a real
 * account). A well-formed miss does the same work as a hit: one HMAC, one index lookup, one timingSafeEqual.
 */
export async function userForRecoveryCode(db: Queryable, code: string, displayName?: string | null): Promise<SessionUser | null> {
  const norm = normalizeRecoveryCode(code);
  const digest = hashRecoveryCode(norm ?? 'invalid-code-0000');
  const { rows } = norm
    ? await db.query(
      `SELECT u.id, u.public_id, u.display_name, u.realm, u.handle, rc.code_hash
         FROM user_recovery_codes rc JOIN users u ON u.id = rc.user_id
        WHERE rc.code_hash = $1 AND u.realm = 'real'`, [digest])
    : { rows: [] as any[] };
  const r = rows[0];
  const stored: Buffer = r ? Buffer.from(r.code_hash) : DUMMY;
  const equal = timingSafeEqual(stored, digest) && !!r && !!norm;
  if (!equal) return null;
  if (displayName && displayName.trim() && !sameDisplayName(displayName, r.display_name)) return null;
  await db.query('UPDATE user_recovery_codes SET last_used_at = now() WHERE user_id = $1', [r.id]);
  return { id: String(r.id), publicId: r.public_id, displayName: r.display_name, realm: r.realm, handle: r.handle };
}
