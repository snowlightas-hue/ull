// Account recovery for real accounts (REVIEW.md MAJOR-6) through the HTTP API. Owner: connections role.
//   register → a recovery code shown once (only its HMAC stored) → logout → recover → same user, same intents;
//   wrong / malformed codes → 401, per-IP limit → 429; regenerating invalidates the old code; demo accounts excluded.
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, harness, mkPersona, type Harness } from './server-helpers.ts';
import connectionsRoutes from '../../src/server/routes/connections.ts';
import accountRoutes from '../../src/server/routes/account.ts';
import { hashRecoveryCode, normalizeRecoveryCode } from '../../src/connections/recovery.ts';

let h: Harness;
before(async () => { h = await harness(`conn_rec_${process.pid}`, { routes: [connectionsRoutes, accountRoutes], featureRoutes: false }); });
after(async () => { await h?.close(); });

let ipSeq = 10;
const client = () => new Client(h, `10.45.0.${ipSeq++}`);
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

test('register shows a recovery code once; logout; the code brings back the same user with the same requests', async () => {
  const A = client();
  const reg = await A.post('/api/auth/register', { displayName: 'أمل الرجوع', phone: '+963 933 111 222' });
  assert.equal(reg.status, 200);
  const code: string = reg.body.recoveryCode;
  assert.match(code, CODE_RE);
  // only a 32-byte HMAC is stored — never the code
  const userId = String((await h.db.pool.query('SELECT id FROM users WHERE public_id = $1', [reg.body.user.publicId])).rows[0].id);
  const stored = (await h.db.pool.query('SELECT code_hash, encode(code_hash, \'escape\') AS raw FROM user_recovery_codes WHERE user_id = $1', [userId])).rows[0];
  assert.equal(stored.code_hash.length, 32);
  assert.ok(!String(stored.raw).includes(code.replace(/-/g, '')) && !String(stored.raw).includes(code));
  assert.deepEqual(Buffer.from(stored.code_hash), hashRecoveryCode(normalizeRecoveryCode(code)!));
  const dump = JSON.stringify((await h.db.pool.query('SELECT * FROM user_recovery_codes')).rows);
  assert.ok(!dump.includes(code), 'the plain code is nowhere in the table');
  // the account page says a code exists (without showing it)
  const acc = await A.get('/api/account');
  assert.equal(acc.body.recovery.hasCode, true);
  assert.ok(!JSON.stringify(acc.body).includes(code));
  // a request, then logout
  const saved = await A.dialogue('بدي شقة للإيجار بإعزاز حد أقصى 200 دولار بالشهر');
  assert.equal(saved.action, 'saved');
  assert.equal((await A.post('/api/auth/logout')).status, 200);
  assert.equal((await A.get('/api/me')).status, 401);
  // recover (as typed by hand: lower case, spaces, Arabic-Indic digits, O for 0 …)
  const typed = code.toLowerCase().replace(/-/g, ' ').replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const rec = await A.post('/api/auth/recover', { code: typed });
  assert.equal(rec.status, 200, rec.raw);
  assert.equal(rec.body.user.publicId, reg.body.user.publicId, 'same user');
  assert.equal(rec.body.user.realm, 'real');
  assert.ok(A.cookie.startsWith('ul_session='), 'a new session cookie');
  const mine = await A.get('/api/intents');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.items.map((i: any) => i.id), [saved.intent.id], 'same requests');
  // with the display name too (loosely compared), and a second device at the same time
  const B = client();
  assert.equal((await B.post('/api/auth/recover', { code, displayName: '  أمل   الرجوع ' })).status, 200);
  assert.equal((await B.post('/api/auth/recover', { code, displayName: 'شخص آخر' })).status, 401, 'a wrong name with the right code is refused');
  assert.equal((await B.get('/api/me')).body.user.publicId, reg.body.user.publicId);
  assert.notEqual((await h.db.pool.query('SELECT last_used_at FROM user_recovery_codes WHERE user_id = $1', [userId])).rows[0].last_used_at, null);
});

test('wrong and malformed codes → 401 (same answer); the per-IP limit → 429 + Retry-After, other IPs unaffected', async () => {
  const A = client();
  const code = (await A.post('/api/auth/register', { displayName: 'سامر' })).body.recoveryCode as string;
  const ip = '10.46.0.1';
  const X = new Client(h, ip);
  const wrong = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0');
  const attempts = [wrong, 'XXXX', '0000-0000-0000-0000', 'ابجد-هوزح-طيكل-منسع', wrong];
  for (const c of attempts) {
    const r = await X.post('/api/auth/recover', { code: c });
    assert.equal(r.status, 401, `«${c}»`);
    assert.equal(r.body.error, 'bad_recovery_code');
    assert.ok(r.body.messageAr);
  }
  const limited = await X.post('/api/auth/recover', { code });
  assert.equal(limited.status, 429, 'even the right code waits once the IP spent its attempts');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(X.cookie, '', 'no session handed out');
  assert.equal((await new Client(h, '10.46.0.2').post('/api/auth/recover', { code })).status, 200, 'another IP is unaffected');
  assert.equal((await new Client(h, '10.46.0.3').post('/api/auth/recover', { code: 'x'.repeat(65) })).status, 400, 'oversized body field');
});

test('regenerating (inside a session) invalidates the old code at once; demo personas have no recovery code', async () => {
  const A = client();
  const reg = await A.post('/api/auth/register', { displayName: 'ريم' });
  const old = reg.body.recoveryCode as string;
  const fresh = await A.post('/api/account/recovery-code', {});
  assert.equal(fresh.status, 200);
  assert.match(fresh.body.recoveryCode, CODE_RE);
  assert.notEqual(fresh.body.recoveryCode, old);
  const R1 = client(); const R2 = client();
  assert.equal((await R1.post('/api/auth/recover', { code: old })).status, 401, 'old code no longer works');
  const ok = await R2.post('/api/auth/recover', { code: fresh.body.recoveryCode });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.publicId, reg.body.user.publicId);
  assert.equal((await client().post('/api/account/recovery-code', {})).status, 401, 'needs a session');
  // synthetic personas log in from the start screen; no code for them
  await mkPersona(h.db.pool, 'conn_rec_persona');
  const P = client();
  const demo = await P.post('/api/auth/demo-login', { handle: 'conn_rec_persona' });
  assert.equal(demo.status, 200);
  assert.equal(demo.body.recoveryCode, undefined);
  const gen = await P.post('/api/account/recovery-code', {});
  assert.equal(gen.status, 403);
  assert.equal(gen.body.error, 'real_only');
  assert.equal((await P.get('/api/account')).body.recovery, null);
});

test('recovering in a browser that holds another session replaces it (the old session is deleted)', async () => {
  const A = client();
  const code = (await A.post('/api/auth/register', { displayName: 'منى' })).body.recoveryCode as string;
  const T = client();
  await T.post('/api/auth/register', { displayName: 'حساب مؤقت' });
  const tempCookie = T.cookie;
  const r = await T.post('/api/auth/recover', { code });
  assert.equal(r.status, 200);
  assert.notEqual(T.cookie, tempCookie);
  const Old = client(); Old.cookie = tempCookie;
  assert.equal((await Old.get('/api/me')).status, 401, 'the throwaway session is gone');
  assert.equal((await T.get('/api/me')).body.user.displayName, 'منى');
});

test('account phone: set, validate, clear — never shared by itself', async () => {
  const A = client();
  await A.post('/api/auth/register', { displayName: 'هاني' });
  assert.equal((await A.get('/api/account')).body.phone, null);
  assert.equal((await A.post('/api/account/phone', { phone: 'abc' })).status, 400);
  assert.equal((await A.post('/api/account/phone', { phone: '+963 944 555 666' })).body.phone, '+963 944 555 666');
  assert.equal((await A.get('/api/account')).body.phone, '+963 944 555 666');
  assert.equal((await A.post('/api/account/phone', { phone: null })).body.phone, null);
});
