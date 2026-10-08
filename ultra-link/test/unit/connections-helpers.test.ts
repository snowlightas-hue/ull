// Pure helpers of the connections feature (no database): recovery codes, message cleaning, Arabic counts,
// viewer-relative status. Owner: connections role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRecoveryCode, generateRecoveryCode, hashRecoveryCode, normalizeRecoveryCode, RECOVERY_ALPHABET, sameDisplayName,
} from '../../src/connections/recovery.ts';
import { cleanMessageText, codePoints, sideOf, statusesFor, unreadAr, viewStatus } from '../../src/connections/repo.ts';

test('recovery codes: 4×4 characters from the unambiguous alphabet, 80 random bits, no repeats in 5000', () => {
  assert.equal(RECOVERY_ALPHABET.length, 32);
  for (const ch of 'ILOU') assert.ok(!RECOVERY_ALPHABET.includes(ch), `${ch} is not used`);
  const seen = new Set<string>();
  const freq = new Map<string, number>();
  for (let i = 0; i < 5000; i++) {
    const c = generateRecoveryCode();
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    seen.add(c);
    for (const ch of c.replace(/-/g, '')) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  assert.equal(seen.size, 5000);
  // 80 000 characters over 32 symbols → 2500 each on average; a biased mapping would skew some far off
  for (const [ch, n] of freq) assert.ok(n > 2200 && n < 2800, `${ch}: ${n}`);
});

test('recovery codes: normalization accepts how people type them back, rejects everything else', () => {
  const code = '7KQ2-M9XD-4TRC-PW3H';
  const norm = '7KQ2M9XD4TRCPW3H';
  for (const v of [code, '7kq2 m9xd 4trc pw3h', '٧KQ٢-M٩XD-٤TRC-PW٣H', '۷KQ۲M۹XD۴TRCPW۳H', ' 7KQ2–M9XD—4TRC.PW3H ']) assert.equal(normalizeRecoveryCode(v), norm, v);
  assert.equal(normalizeRecoveryCode('O0IL-0000-0000-0000'), '0011000000000000', 'O→0, I/L→1');
  for (const bad of ['', '7KQ2-M9XD-4TRC', '7KQ2-M9XD-4TRC-PW3H-AAAA', '7KQ2-M9XD-4TRC-PW3U', 'ابجد-هوزح-طيكل-منسع', 'x'.repeat(65)]) assert.equal(normalizeRecoveryCode(bad), null, bad);
  assert.equal(formatRecoveryCode(norm), code);
});

test('recovery hash: HMAC-SHA256, deterministic per pepper, different with another pepper', () => {
  const a = hashRecoveryCode('7KQ2M9XD4TRCPW3H', 'pepper-one-0123456789');
  assert.equal(a.length, 32);
  assert.deepEqual(a, hashRecoveryCode('7KQ2M9XD4TRCPW3H', 'pepper-one-0123456789'));
  assert.notDeepEqual(a, hashRecoveryCode('7KQ2M9XD4TRCPW3H', 'pepper-two-0123456789'));
  assert.notDeepEqual(a, hashRecoveryCode('7KQ2M9XD4TRCPW3J', 'pepper-one-0123456789'));
});

test('display names compare loosely (spaces, tatweel, diacritics, case)', () => {
  assert.ok(sameDisplayName('  أمل   الرجوع ', 'أمل الرجوع'));
  assert.ok(sameDisplayName('أمـــل', 'أمل'));
  assert.ok(sameDisplayName('مُنى', 'منى'));
  assert.ok(sameDisplayName('Rami', 'rami'));
  assert.ok(!sameDisplayName('أمل', 'أمال'));
});

test('message text: control characters stripped, newlines kept, trimmed; length in code points', () => {
  assert.equal(cleanMessageText('  مرحبا\r\nكيفك؟\u0000\u0007  '), 'مرحبا\nكيفك؟');
  assert.equal(cleanMessageText('\t\n '), '');
  assert.equal(codePoints('😀😀'), 2);
  assert.equal('😀😀'.length, 4);
});

test('Arabic unread counts and viewer-relative status', () => {
  assert.deepEqual([1, 2, 3, 10, 11, 100].map(unreadAr), ['رسالة جديدة واحدة', 'رسالتان جديدتان', '3 رسائل جديدة', '10 رسائل جديدة', '11 رسالة جديدة', '100 رسالة جديدة']);
  const c = { a_user_id: '1', b_user_id: '2', status: 'blocked' as const, status_by: '1' };
  assert.equal(viewStatus(c, '1'), 'blocked');
  assert.equal(viewStatus(c, '2'), 'closed', 'the blocked side sees "closed"');
  assert.equal(viewStatus({ ...c, status: 'open', status_by: null }, '2'), 'open');
  assert.equal(sideOf(c, '2'), 'b');
  assert.equal(sideOf(c, '3'), null);
  assert.deepEqual(statusesFor('closed'), ['closed', 'blocked']);
  assert.deepEqual(statusesFor(undefined), ['open']);
});
