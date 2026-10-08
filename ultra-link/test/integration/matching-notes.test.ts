// Notification coalescing: a seeker matching many products of one shop (or a shop listing many products at once) gets
// at most MATCH_NOTE_BUDGET individual alerts per own request per hour, then ONE summary row with a running count.
import { after, before, test } from 'node:test';
import pg from 'pg';
import assert from 'node:assert/strict';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { withTx } from '../../src/db/pool.ts';
import type { Registry } from '../../src/domain/registry.ts';
import type { IntentSpec } from '../../src/domain/types.ts';
import { createIntent } from '../../src/repo/intents.ts';
import { MATCH_NOTE_BUDGET, matchIntent } from '../../src/matching/engine.ts';

let db: TestDb;
let reg: Registry;
const TAG = `notes_${process.pid}`;
const P = (code: string) => reg.placeByCode.get(code)!.id;

const phoneSeek = (place: string): IntentSpec => ({
  side: 'seek', categoryCode: 'goods.electronics', deal: 'sale',
  place: { pointPlaceId: null, scopePlaceIds: [P(place)], scopeStrength: 'required', excludePlaceIds: [] },
  price: { op: 'lte', lo: null, hi: '50000', currency: 'USD', unit: 'total', strength: 'required' }, when: null, attrs: {}, constraints: [],
});
const phoneOffer = (place: string, usd: number): IntentSpec => ({
  side: 'provide', categoryCode: 'goods.electronics', deal: 'sale',
  place: { pointPlaceId: P(place), scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] },
  price: { op: 'eq', lo: String(usd * 100), hi: String(usd * 100), currency: 'USD', unit: 'total', strength: 'required' }, when: null, attrs: {}, constraints: [],
});
const mk = (userId: string, spec: IntentSpec, title: string) =>
  withTx(db.pool, (tx) => createIntent(tx, reg, { userId, realm: 'synthetic', spec, titleAr: title, sourceText: null, conversationId: null }));
const notesOf = async (userId: string) =>
  (await db.pool.query('SELECT kind, body_ar, payload, read_at FROM notifications WHERE recipient_id = $1 ORDER BY id', [userId])).rows;

before(async () => { db = await freshDb(TAG); reg = db.reg; });
after(async () => {
  await db?.close();
  if (!db) return;
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`); } finally { await a.end(); }
});

test('a shop listing 10 fitting products one by one: the waiting seeker gets 3 alerts + one summary «٧ مطابقة أخرى»', async () => {
  const seeker = await mkUser(db.pool, 'باحث');
  const shop = await mkUser(db.pool, 'محل');
  const s = await mk(seeker, phoneSeek('sy.aleppo.azaz'), 'بدي موبايل بإعزاز');
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' });
  for (let i = 0; i < 10; i++) {
    const o = await mk(shop, phoneOffer('sy.aleppo.azaz', 200 + i), `موبايل رقم ${i + 1}`);
    await matchIntent(db.pool, reg, { verticalId: o.verticalId, intentId: o.id, trigger: 'job' });
  }
  const mine = await notesOf(seeker);
  const individual = mine.filter((n) => n.kind === 'match_new');
  const summary = mine.filter((n) => n.kind === 'match_more');
  assert.equal(individual.length, MATCH_NOTE_BUDGET, JSON.stringify(mine.map((n) => n.kind)));
  assert.equal(summary.length, 1, 'one summary row, updated in place');
  assert.equal(summary[0].payload.count, 10 - MATCH_NOTE_BUDGET);
  assert.equal(summary[0].body_ar, '٧ مطابقة أخرى لطلبك «بدي موبايل بإعزاز»');
  assert.equal(summary[0].payload.intentId, s.publicId, 'the summary opens the matches of that request');
  assert.equal(summary[0].read_at, null);
  // the shop owner: each product is its own request → one alert per product (they are different requests)
  assert.equal((await notesOf(shop)).filter((n) => n.kind === 'match_new').length, 10);
});

test('a seeker whose own run finds 12 products at once: 3 alerts + one summary; reading it and a later match re-surfaces it', async () => {
  const seeker = await mkUser(db.pool, 'باحث٢');
  const shop = await mkUser(db.pool, 'محل٢');
  for (let i = 0; i < 12; i++) await mk(shop, phoneOffer('sy.aleppo.afrin', 300 + i), `منتج ${i + 1}`);
  const s = await mk(seeker, phoneSeek('sy.aleppo.afrin'), 'موبايل بعفرين');
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' }); // not interactive: the seeker is notified
  let mine = await notesOf(seeker);
  assert.equal(mine.filter((n) => n.kind === 'match_new').length, MATCH_NOTE_BUDGET);
  assert.deepEqual(mine.filter((n) => n.kind === 'match_more').map((n) => n.payload.count), [12 - MATCH_NOTE_BUDGET]);

  await db.pool.query("UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND kind = 'match_more'", [seeker]);
  const late = await mk(shop, phoneOffer('sy.aleppo.afrin', 450), 'منتج متأخر');
  await matchIntent(db.pool, reg, { verticalId: late.verticalId, intentId: late.id, trigger: 'job' });
  mine = await notesOf(seeker);
  const sum = mine.filter((n) => n.kind === 'match_more');
  assert.equal(sum.length, 1);
  assert.equal(sum[0].payload.count, 12 - MATCH_NOTE_BUDGET + 1, 'running count');
  assert.equal(sum[0].read_at, null, 'unread again with the new total');
});

test('a single match still gets its normal individual alert (no summary)', async () => {
  const seeker = await mkUser(db.pool, 'باحث٣');
  const seller = await mkUser(db.pool, 'بائع٣');
  const o = await mk(seller, phoneOffer('sy.aleppo.al_bab', 250), 'موبايل بالباب');
  const s = await mk(seeker, phoneSeek('sy.aleppo.al_bab'), 'بدي موبايل بالباب');
  await matchIntent(db.pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job' });
  assert.deepEqual((await notesOf(seeker)).map((n) => n.kind), ['match_new']);
  assert.deepEqual((await notesOf(seller)).map((n) => n.kind), ['match_new']);
  void o;
});
