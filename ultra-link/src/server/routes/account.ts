// Account recovery and account settings for real accounts (REVIEW.md MAJOR-6; docs/CONNECTIONS.md §Recovery).
//   POST /api/auth/recover          {code, displayName?} → new session for the code's owner (public; per-IP limits)
//   GET  /api/account               → recovery status + own phone
//   POST /api/account/recovery-code → a NEW code (shown once); the previous code stops working at once
//   POST /api/account/phone         {phone|null} → own contact phone (shared only through «شارك رقمي»)
// The register route (src/server/app.ts) issues the first code. No SMS / OTP / paid service is involved.
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { defineRoutes } from '../context.ts';
import { createSession, deleteSession, type SessionUser } from '../../repo/users.ts';
import { issueRecoveryCode, recoveryStatus, userForRecoveryCode } from '../../connections/recovery.ts';
import { PHONE_RE } from '../../connections/repo.ts';

// must match src/server/app.ts (cookie name and attributes of the session cookie)
const COOKIE = 'ul_session';
const sessionCookie = (req: FastifyRequest, token: string) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${req.protocol === 'https' ? '; Secure' : ''}; Max-Age=${30 * 86400}`;
function cookieToken(req: FastifyRequest): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) {
      const raw = part.slice(i + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
  }
  return undefined;
}
const publicUser = (u: SessionUser) => ({ publicId: u.publicId, displayName: u.displayName, realm: u.realm });

/** Brute-force bounds for /api/auth/recover, per client IP (on top of the global /api/auth/* bucket, 20/min/IP). */
export const RECOVER_LIMIT = { name: 'auth_recover', perMinute: 5, by: 'ip' as const };

export default defineRoutes('account', async (app, ctx) => {
  app.post('/api/auth/recover', { config: { public: true, rateLimit: RECOVER_LIMIT } }, async (req, reply: FastifyReply) => {
    const b = ctx.body(z.object({ code: z.string().max(64), displayName: z.string().trim().max(80).optional().nullable() }), req);
    const user = await userForRecoveryCode(ctx.pool, b.code, b.displayName ?? null);
    if (!user) throw new ctx.HttpError(401, 'bad_recovery_code', 'رمز الاسترداد غير صحيح. تأكد منه وحاول مرة ثانية.');
    // replace whatever session this browser had (e.g. a throwaway account made after losing access)
    const old = cookieToken(req);
    if (old && req.user && req.user.id !== user.id) await deleteSession(ctx.pool, old);
    reply.header('Set-Cookie', sessionCookie(req, await createSession(ctx.pool, user.id)));
    return { user: publicUser(user) };
  });

  app.get('/api/account', async (req) => {
    const u = ctx.user(req);
    const phone = (await ctx.pool.query('SELECT contact_phone FROM users WHERE id = $1', [u.id])).rows[0]?.contact_phone ?? null;
    return { user: publicUser(u), recovery: u.realm === 'real' ? await recoveryStatus(ctx.pool, u.id) : null, phone };
  });

  app.post('/api/account/recovery-code', { config: { rateLimit: { name: 'account_recovery', perMinute: 5 } } }, async (req) => {
    const u = ctx.user(req);
    if (u.realm !== 'real') throw new ctx.HttpError(403, 'real_only', 'رمز الاسترداد للحسابات الحقيقية فقط. الحسابات التجريبية تدخل من شاشة البداية.');
    const r = await issueRecoveryCode(ctx.pool, u.id);
    return { recoveryCode: r.code, createdAt: r.createdAt };
  });

  app.post('/api/account/phone', { config: { rateLimit: { name: 'account_phone', perMinute: 10 } } }, async (req) => {
    const u = ctx.user(req);
    const { phone } = ctx.body(z.object({ phone: z.string().trim().max(30).nullable() }), req);
    const p = phone ? phone.trim() : null;
    if (p && (!PHONE_RE.test(p) || (p.match(/\d/g) ?? []).length < 5)) throw new ctx.HttpError(400, 'bad_phone', 'رقم الهاتف غير صالح.');
    await ctx.pool.query('UPDATE users SET contact_phone = $2 WHERE id = $1', [u.id, p]);
    return { phone: p };
  });
});
