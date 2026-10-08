// Matching flows on a fresh, isolated database (Role 8 — independent tests).
//   * strict-constraint fuzz: random seekers × providers (≥ 200 pairs) are written through the real repo and
//     matched by the real engine; every stored match row is then RE-CHECKED FROM THE DB ROWS by an independent
//     oracle written here (raw SQL: intents, places.lft/rgt, categories.parent_id) — not by evaluate.ts.
//   * money precision near 2^53 (and at the BIGINT limit): BigInt end to end, never a float
//   * stale evaluations never overwrite newer ones, under a randomized race of edits, re-runs and stale jobs
//   * realm isolation: synthetic and real data never meet
import './server-env.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { freshDb, mkUser, type TestDb } from '../helpers/testdb.ts';
import { withTx } from '../../src/db/pool.ts';
import type { AttrConstraint, IntentSpec, PriceSpec } from '../../src/domain/types.ts';
import { validateSpec } from '../../src/domain/validate.ts';
import { createIntent, intentToSpec, loadIntent, updateIntent } from '../../src/repo/intents.ts';
import { matchIntent } from '../../src/matching/engine.ts';
import { runJob } from '../../src/worker/main.ts';
import { handleTurn, startConversation } from '../../src/conversation/service.ts';

const TAG = `r8_flows_match_${process.pid}`;
let db: TestDb;
before(async () => { db = await freshDb(TAG); });
after(async () => {
  await db?.close();
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${db.name} WITH (FORCE)`); } finally { await a.end(); }
});

const P = (code: string) => db.reg.placeByCode.get(code)!.id;
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
async function mk(userId: string, realm: 'real' | 'synthetic', spec: IntentSpec, opts: { validate?: boolean; title?: string } = {}) {
  let s = spec;
  if (opts.validate !== false) {
    const v = validateSpec(db.reg, spec);
    if (!v.ok) throw new Error(`generator produced an invalid spec: ${JSON.stringify(v.issues)}`);
    s = v.spec;
  }
  return withTx(db.pool, (tx) => createIntent(tx, db.reg, { userId, realm, spec: s, titleAr: opts.title ?? 'اختبار', sourceText: null, conversationId: null }));
}

// ───────────────────────────── independent oracle (DB rows only) ─────────────────────────────
interface Oracle { verdict: 'match' | 'possible' | 'excluded'; violations: string[]; unknowns: string[] }
let placeIv: Map<number, { lft: number; rgt: number }>;
let catParent: Map<number, number | null>;
async function loadRefs() {
  placeIv = new Map((await db.pool.query('SELECT id, lft, rgt FROM places')).rows.map((r) => [r.id, { lft: r.lft, rgt: r.rgt }]));
  catParent = new Map((await db.pool.query('SELECT id, parent_id FROM categories')).rows.map((r) => [r.id, r.parent_id]));
}
const placeWithin = (p: number, s: number) => { const a = placeIv.get(p)!; const b = placeIv.get(s)!; return a.lft >= b.lft && a.rgt <= b.rgt; };
const catWithin = (c: number, s: number) => { for (let x: number | null | undefined = c; x != null; x = catParent.get(x)) if (x === s) return true; return false; };
function relate(point: number, area: number[]): 'inside' | 'partial' | 'disjoint' {
  if (area.some((s) => placeWithin(point, s))) return 'inside';
  if (area.every((s) => !placeWithin(point, s) && !placeWithin(s, point))) return 'disjoint';
  return 'partial';
}
function attrOk(c: AttrConstraint, v: unknown): boolean {
  const vals = Array.isArray(v) ? v : [v];
  const one = (x: unknown) => {
    switch (c.op) {
      case 'eq': return x === c.value;
      case 'neq': return x !== c.value;
      case 'in': return (c.values ?? []).includes(x as never);
      case 'gte': return typeof x === 'number' && x >= (c.value as number);
      case 'lte': return typeof x === 'number' && x <= (c.value as number);
      case 'between': return typeof x === 'number' && (c.lo === undefined || x >= c.lo) && (c.hi === undefined || x <= c.hi);
    }
  };
  return c.op === 'neq' ? vals.every(one) : vals.some(one);
}
/** Hard conditions of PRODUCT.md §6.2 for an exchange pair, from raw `intents` rows. */
function oracle(seek: any, prov: any): Oracle {
  const violations: string[] = [];
  const unknowns: string[] = [];
  if (seek.realm !== prov.realm) violations.push('realm');
  if (String(seek.user_id) === String(prov.user_id)) violations.push('same_owner');
  if (seek.status !== 'active' || prov.status !== 'active') violations.push('inactive');
  if (seek.deal_type_id !== prov.deal_type_id) violations.push('deal');
  const provIn = catWithin(prov.category_id, seek.category_id);
  if (!provIn && !catWithin(seek.category_id, prov.category_id)) violations.push('category');
  else if (!provIn) unknowns.push('category');
  const excl: number[] = (seek.constraints ?? []).find((c: any) => c.key === '__exclude_places')?.values ?? [];
  const point: number | null = prov.point_place_id;
  if (excl.length) {
    if (point == null) unknowns.push('place');
    else { const r = relate(point, excl); if (r === 'inside') violations.push('place_excluded'); else if (r === 'partial') unknowns.push('place'); }
  }
  if (seek.scope_place_ids.length && seek.scope_strength === 'required') {
    if (point == null) unknowns.push('place');
    else { const r = relate(point, seek.scope_place_ids); if (r === 'disjoint') violations.push('place_out_of_scope'); else if (r === 'partial') unknowns.push('place'); }
  }
  if (seek.price_op) {
    // MATCHING semantics (evaluate.ts header, PRODUCT §6.2-2): amounts in different or unknown currencies/units are
    // never compared and never confirmed, whatever the strength; a missing price blocks only a required condition.
    const required = seek.price_op !== 'approx' && (seek.price_strength ?? 'required') === 'required';
    const saleId = db.reg.dealByCode.get('sale')!.id;
    const wantUnit = seek.price_unit ?? (seek.deal_type_id === saleId ? 'total' : null);
    const haveUnit = prov.price_unit ?? (prov.deal_type_id === saleId ? 'total' : null);
    if (!prov.price_op || (prov.price_lo === null && prov.price_hi === null)) { if (required) unknowns.push('price'); }
    else if (!seek.currency || !prov.currency || seek.currency.trim() !== prov.currency.trim()) unknowns.push('price.currency');
    else if (!wantUnit || !haveUnit || wantUnit !== haveUnit) unknowns.push('price.unit');
    else if (required) {
      assert.equal(prov.price_op, 'eq', 'generator: offers are asking prices');
      const x = BigInt(prov.price_lo); // pg returns BIGINT as a string: exact
      const lo = seek.price_lo === null ? null : BigInt(seek.price_lo);
      const hi = seek.price_hi === null ? null : BigInt(seek.price_hi);
      const ok = seek.price_op === 'lte' ? x <= hi! : seek.price_op === 'gte' ? x >= lo! : seek.price_op === 'eq' ? x === lo : x >= lo! && x <= hi!;
      if (!ok) violations.push(`price_${seek.price_op}`);
    }
  }
  for (const [owner, other] of [[seek, prov], [prov, seek]] as const) {
    for (const c of (owner.constraints ?? []) as AttrConstraint[]) {
      if (c.key === '__exclude_places' || c.strength !== 'required') continue;
      const v = other.attrs?.[c.key];
      if (v === undefined || v === null) unknowns.push(`attr.${c.key}`);
      else if (!attrOk(c, v)) violations.push(`attr.${c.key}`);
    }
  }
  return { verdict: violations.length ? 'excluded' : unknowns.length ? 'possible' : 'match', violations, unknowns };
}

// ───────────────────────────── strict-constraint fuzz ─────────────────────────────
test('strict-constraint fuzz (3 seeds × 20 seekers × 20 offers): every stored match is re-checked from DB rows; no hard condition is violated, nothing is missed', { timeout: 300_000 }, async () => {
  await loadRefs();
  const total = { pairs: 0, match: 0, possible: 0, excluded: 0, rows: 0 };
  const why = new Map<string, number>();
  for (const seed of [8_2026, 53, 1_001]) await fuzzRound(seed, total, why);
  console.log(`      info: TOTAL ${total.pairs} pairs; oracle ${total.match} match / ${total.possible} possible / ${total.excluded} excluded; ${total.rows} stored rows re-checked`);
  console.log(`      info: hard violations exercised: ${[...why].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  for (const k of ['place_out_of_scope', 'price_lte', 'attr.rooms', 'attr.tenant_type', 'deal', 'realm', 'same_owner']) assert.ok((why.get(k) ?? 0) > 0, `the fuzz exercised ${k}`);
});

async function fuzzRound(seed: number, total: { pairs: number; match: number; possible: number; excluded: number; rows: number }, why: Map<string, number>) {
  const FUZZ = `fuzz ${seed}`;
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const chance = (p: number) => r() < p;
  const users = [];
  for (let i = 0; i < 8; i++) users.push(await mkUser(db.pool, `مستخدم عشوائي ${i}`, 'synthetic'));
  const realUsers = [await mkUser(db.pool, 'حقيقي 1', 'real'), await mkUser(db.pool, 'حقيقي 2', 'real')];
  const CITIES = ['sy.aleppo.azaz', 'sy.aleppo.afrin', 'sy.aleppo.marea', 'sy.idlib.sarmada'];
  const REGIONS = ['sy.aleppo', 'sy.idlib'];
  const LEAVES = ['real_estate.apartment', 'real_estate.villa', 'real_estate.shop'];
  const amount = (deal: string) => BigInt(deal === 'sale' ? 10_000 + Math.floor(r() * 50) * 1000 : 50 + Math.floor(r() * 36) * 10) * 100n;
  const unitFor = (deal: string): PriceSpec['unit'] => (deal === 'sale' ? 'total' : chance(0.85) ? 'month' : 'year');

  const seekers: { realm: 'real' | 'synthetic' }[] = [];
  const N = 20;
  for (let i = 0; i < N; i++) {
    const deal = pick(['rent', 'rent', 'rent', 'sale']);
    const realm = i < 2 ? 'real' : 'synthetic';
    const scope = chance(0.15) ? [P(pick(REGIONS))] : [...new Set([P(pick(CITIES)), ...(chance(0.3) ? [P(pick(CITIES))] : [])])];
    const excl = chance(0.15) ? [P(pick(CITIES))].filter((x) => !scope.includes(x)) : [];
    let price: PriceSpec | null = null;
    if (chance(0.75)) {
      const op = pick(['lte', 'lte', 'gte', 'eq', 'between', 'approx'] as const);
      const a = amount(deal); const b = a + amount(deal);
      price = { op, lo: op === 'lte' ? null : String(a), hi: op === 'gte' ? null : op === 'between' ? String(b) : String(a), currency: chance(0.8) ? 'USD' : 'TRY', unit: unitFor(deal), strength: chance(0.8) ? 'required' : 'preferred' };
    }
    const constraints: AttrConstraint[] = [];
    if (chance(0.4)) constraints.push({ key: 'rooms', op: 'gte', value: 1 + Math.floor(r() * 4), strength: chance(0.7) ? 'required' : 'preferred' });
    if (chance(0.25)) constraints.push({ key: 'furnished', op: 'eq', value: true, strength: chance(0.5) ? 'required' : 'preferred' });
    const attrs: IntentSpec['attrs'] = chance(0.5) ? { tenant_type: pick(['family', 'single', 'student']) } : {};
    const spec: IntentSpec = { side: 'seek', categoryCode: chance(0.2) ? 'real_estate' : pick(LEAVES.slice(0, 2)), deal: deal as IntentSpec['deal'], place: { pointPlaceId: null, scopePlaceIds: scope, scopeStrength: chance(0.8) ? 'required' : 'preferred', excludePlaceIds: excl }, price, when: null, attrs, constraints };
    await mk(realm === 'real' ? realUsers[i % 2]! : pick(users), realm, spec, { title: FUZZ });
    seekers.push({ realm });
  }
  for (let i = 0; i < N; i++) {
    const deal = pick(['rent', 'rent', 'rent', 'sale']);
    const realm = i < 2 ? 'real' : 'synthetic';
    const point = chance(0.1) ? P(pick(REGIONS)) : P(pick(CITIES));
    const price: PriceSpec | null = chance(0.85) ? (() => { const a = String(amount(deal)); return { op: 'eq' as const, lo: a, hi: a, currency: chance(0.8) ? 'USD' as const : 'TRY' as const, unit: unitFor(deal), strength: 'required' as const }; })() : null;
    const attrs: IntentSpec['attrs'] = {};
    if (chance(0.8)) attrs.rooms = 1 + Math.floor(r() * 5);
    if (chance(0.6)) attrs.furnished = chance(0.5);
    const constraints: AttrConstraint[] = chance(0.15) ? [{ key: 'tenant_type', op: 'in', values: ['family'], strength: 'required' }] : [];
    const spec: IntentSpec = { side: 'provide', categoryCode: pick(LEAVES), deal: deal as IntentSpec['deal'], place: { pointPlaceId: point, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] }, price, when: null, attrs, constraints };
    await mk(realm === 'real' ? realUsers[(i + 1) % 2]! : pick(users), realm, spec, { title: FUZZ });
  }
  // the real engine, in a random order, as the app does (interactive on save; the other side via jobs)
  const all = (await db.pool.query('SELECT vertical_id, id FROM intents WHERE title_ar = $1 ORDER BY random()', [FUZZ])).rows;
  for (const row of all) await matchIntent(db.pool, db.reg, { verticalId: row.vertical_id, intentId: String(row.id), trigger: 'interactive' });

  const rows = (await db.pool.query('SELECT * FROM intents WHERE title_ar = $1', [FUZZ])).rows;
  const byId = new Map(rows.map((x) => [String(x.id), x]));
  const seek = rows.filter((x) => x.side === 'seek');
  const prov = rows.filter((x) => x.side === 'provide');
  const matches = (await db.pool.query('SELECT * FROM matches')).rows.filter((m) => byId.has(String(m.a_intent_id)) && byId.has(String(m.b_intent_id)));
  const stored = new Map(matches.map((m) => [`${m.a_intent_id}:${m.b_intent_id}`, m]));
  const unsound: string[] = [];
  const missed: string[] = [];
  const stateDiff: string[] = [];
  const tally = { match: 0, possible: 0, excluded: 0 };
  for (const s of seek) for (const p of prov) {
    const o = oracle(s, p);
    tally[o.verdict]++;
    for (const v of o.violations) why.set(v, (why.get(v) ?? 0) + 1);
    const m = stored.get(`${s.id}:${p.id}`);
    const label = `seek ${s.id} × offer ${p.id}`;
    if (m && m.state !== 'invalidated' && o.verdict === 'excluded') unsound.push(`${label}: stored «${m.state}» but violates ${o.violations.join(',')}`);
    if (m?.state === 'confirmed' && o.verdict === 'possible') unsound.push(`${label}: «confirmed» although unproven: ${o.unknowns.join(',')}`);
    if (o.verdict !== 'excluded' && (!m || m.state === 'invalidated')) missed.push(`${label}: oracle ${o.verdict} (${o.unknowns.join(',') || 'all proven'}) but ${m ? 'invalidated' : 'no row'}`);
    if (m?.state === 'possible' && o.verdict === 'match') stateDiff.push(`${label}: stored «possible», oracle proves every hard condition (missing=${JSON.stringify(m.missing)})`);
  }
  // rows must also be internally consistent: state ⇔ reasons ⇔ missing ⇔ score band
  const incoherent: string[] = [];
  for (const m of matches) {
    const req = (m.reasons as any[]).filter((x) => x.strength === 'required');
    if (m.state === 'confirmed' && (m.missing.length || m.score < 5000 || req.some((x) => x.polarity === 'unknown' || x.polarity === 'minus'))) incoherent.push(`confirmed ${m.id}: missing=${JSON.stringify(m.missing)} score=${m.score}`);
    if (m.state === 'possible' && (!m.missing.length || m.score > 4999 || req.some((x) => x.polarity === 'minus'))) incoherent.push(`possible ${m.id}: missing=${JSON.stringify(m.missing)} score=${m.score}`);
    const a = byId.get(String(m.a_intent_id)); const b = byId.get(String(m.b_intent_id));
    if (a && b && a.realm !== b.realm) incoherent.push(`match ${m.id} crosses realms`);
  }
  console.log(`      info: seed ${seed}: ${seek.length} seekers × ${prov.length} offers = ${seek.length * prov.length} pairs; oracle ${tally.match} match / ${tally.possible} possible / ${tally.excluded} excluded; stored rows ${matches.length}`);
  total.pairs += seek.length * prov.length; total.match += tally.match; total.possible += tally.possible; total.excluded += tally.excluded; total.rows += matches.length;
  assert.ok(seek.length * prov.length >= 200 && tally.match > 3 && tally.possible > 3, `seed ${seed}: the fuzz exercises every verdict`);
  assert.deepEqual(unsound, [], `seed ${seed} SOUNDNESS: no stored confirmed/possible match violates a hard condition; nothing unproven is confirmed`);
  assert.deepEqual(incoherent, [], `seed ${seed}: stored rows are coherent (state, reasons, missing, score band, realm)`);
  assert.deepEqual(missed, [], `seed ${seed} COMPLETENESS: every non-excluded pair is stored`);
  assert.deepEqual(stateDiff, [], `seed ${seed}: a pair whose hard conditions are all proven is confirmed, not merely possible`);
}

// ───────────────────────────── money precision near 2^53 ─────────────────────────────
test('money precision near 2^53 and at the BIGINT limit: compared and shown as exact integers (BigInt), never floats', async () => {
  const TWO53 = 2n ** 53n; // 9007199254740992 — Number(2^53 + 1) === 2^53 in floating point
  const seller = [await mkUser(db.pool, 'بائع 1', 'real'), await mkUser(db.pool, 'بائع 2', 'real'), await mkUser(db.pool, 'بائع 3', 'real'), await mkUser(db.pool, 'بائع 4', 'real')];
  const buyer = await mkUser(db.pool, 'مشتري دقيق', 'real');
  const where = P('tr.kilis'); // a city no other test uses
  const offer = (amount: bigint): IntentSpec => ({ side: 'provide', categoryCode: 'vehicles.car', deal: 'sale', place: { pointPlaceId: where, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] }, price: { op: 'eq', lo: String(amount), hi: String(amount), currency: 'USD', unit: 'total', strength: 'required' }, when: null, attrs: {}, constraints: [] });
  const want = (op: 'lte' | 'eq', amount: bigint): IntentSpec => ({ side: 'seek', categoryCode: 'vehicles.car', deal: 'sale', place: { pointPlaceId: null, scopePlaceIds: [where], scopeStrength: 'required', excludePlaceIds: [] }, price: { op, lo: op === 'eq' ? String(amount) : null, hi: String(amount), currency: 'USD', unit: 'total', strength: 'required' }, when: null, attrs: {}, constraints: [] });
  // the HTTP/NLU path rejects > 15 digits (validate.ts MONEY); these rows model data that reaches the engine any
  // other way (imports, a future limit change), so they bypass validation on purpose
  const above = await mk(seller[0]!, 'real', offer(TWO53 + 1n), { validate: false });
  const at = await mk(seller[1]!, 'real', offer(TWO53), { validate: false });
  const below = await mk(seller[2]!, 'real', offer(TWO53 - 1n), { validate: false });
  const huge = await mk(seller[3]!, 'real', offer(2n ** 63n - 1n), { validate: false }); // BIGINT max
  assert.equal(Number(TWO53 + 1n), Number(TWO53), 'precondition: a float cannot tell these two apart');

  const cap = await mk(buyer, 'real', want('lte', TWO53), { validate: false });
  const run = await matchIntent(db.pool, db.reg, { verticalId: cap.verticalId, intentId: cap.id, trigger: 'interactive' });
  const rowsFor = async (i: { id: string }) => new Map((await db.pool.query('SELECT b_intent_id, state, reasons FROM matches WHERE a_intent_id = $1', [i.id])).rows.map((m) => [String(m.b_intent_id), m]));
  let got = await rowsFor(cap);
  assert.equal(got.get(at.id)?.state, 'confirmed', 'price == cap (2^53) is within the cap (inclusive)');
  assert.equal(got.get(below.id)?.state, 'confirmed', '2^53 − 1 is within the cap');
  assert.equal(got.has(above.id), false, '2^53 + 1 is one minor unit above the cap → excluded (a float compare would confirm it)');
  assert.equal(got.has(huge.id), false, 'BIGINT max is excluded, without overflow');
  assert.ok(run.exclusions.some((e) => e.code === 'price_above_max' && e.count === 2), JSON.stringify(run.exclusions));
  // the reason shown to the user carries the exact digits (format.ts is BigInt-only)
  const digits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[^0-9]/g, '');
  const txt = (got.get(below.id)!.reasons as any[]).find((x) => x.code === 'price_within_max')!.text;
  assert.ok(digits(txt).includes(String(TWO53 - 1n)) && digits(txt).includes(String(TWO53)), `exact amounts in «${txt}»`);

  const exact = await mk(buyer, 'real', want('eq', TWO53 + 1n), { validate: false });
  await matchIntent(db.pool, db.reg, { verticalId: exact.verticalId, intentId: exact.id, trigger: 'interactive' });
  got = await rowsFor(exact);
  assert.equal(got.get(above.id)?.state, 'confirmed', '«exactly 2^53 + 1» matches 2^53 + 1');
  assert.equal(got.has(at.id), false, '«exactly 2^53 + 1» does not match 2^53');
  const stored = (await db.pool.query('SELECT price_lo::text AS lo FROM intents WHERE id = $1', [above.id])).rows[0].lo;
  assert.equal(stored, String(TWO53 + 1n), 'stored exactly');
  assert.equal(validateSpec(db.reg, want('lte', TWO53)).ok, false, 'documented limit: API amounts have at most 15 digits');

  // the NLU/conversation path: a huge spoken amount is never rounded into a stored request
  const uid = await mkUser(db.pool, 'متكلم بأرقام كبيرة', 'real');
  const pub = (await db.pool.query('SELECT public_id FROM users WHERE id = $1', [uid])).rows[0].public_id;
  const user = { id: uid, publicId: pub, displayName: 'x', realm: 'real' as const, handle: null };
  for (const text of ['عندي سيارة للبيع بكلس بسعر 90071992547409.93 دولار', 'عندي سيارة للبيع بكلس بسعر 9007199254740993 دولار']) {
    const conv = await startConversation(db.pool, user);
    const r = await handleTurn(db.pool, db.reg, user, conv.id, { text, modality: 'text', clientTurnId: randomUUID() });
    if (r.action === 'saved') {
      const p = (await db.pool.query('SELECT price_lo::text AS lo FROM intents WHERE public_id = $1', [r.intent!.id])).rows[0].lo;
      const expected = text.includes('.93') ? '9007199254740993' : '900719925474099300';
      assert.equal(p, expected, `«${text}» stored exactly (${p})`);
    } else {
      assert.ok(['unclear', 'ask'].includes(r.action), `«${text}» → ${r.action}`);
    }
  }
});

// ───────────────────────────── stale evaluations ─────────────────────────────
test('stale evaluations never overwrite newer ones: randomized race of offer edits, seeker re-runs and stale jobs', { timeout: 120_000 }, async () => {
  const u1 = await mkUser(db.pool, 'باحث السباق', 'real');
  const u2 = await mkUser(db.pool, 'مؤجر السباق', 'real');
  const city = P('tr.hatay.reyhanli');
  const S = await mk(u1, 'real', { side: 'seek', categoryCode: 'real_estate.apartment', deal: 'rent', place: { pointPlaceId: null, scopePlaceIds: [city], scopeStrength: 'required', excludePlaceIds: [] }, price: { op: 'lte', lo: null, hi: '20000', currency: 'USD', unit: 'month', strength: 'required' }, when: null, attrs: {}, constraints: [] });
  const O = await mk(u2, 'real', { side: 'provide', categoryCode: 'real_estate.apartment', deal: 'rent', place: { pointPlaceId: city, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] }, price: { op: 'eq', lo: '18000', hi: '18000', currency: 'USD', unit: 'month', strength: 'required' }, when: null, attrs: { rooms: 2 }, constraints: [] });
  await matchIntent(db.pool, db.reg, { verticalId: S.verticalId, intentId: S.id, trigger: 'interactive' });
  const pair = async () => (await db.pool.query('SELECT * FROM matches WHERE a_intent_id = $1 AND b_intent_id = $2', [S.id, O.id])).rows[0];
  assert.equal((await pair()).state, 'confirmed');

  const r = rng(53);
  const editO = async (usd: number) => {
    const row = (await loadIntent(db.pool, O.verticalId, O.id))!;
    const spec = intentToSpec(db.reg, row);
    let res;
    try {
      res = await withTx(db.pool, (tx) => updateIntent(tx, db.reg, O.verticalId, O.id, u2, row.version, { ...spec, price: { ...spec.price!, lo: String(usd * 100), hi: String(usd * 100) } }, row.title_ar));
    } catch (e) {
      // deadlock / serialization failure: the API answers 409 «busy» and the client retries
      if (['40P01', '40001'].includes((e as { code?: string }).code ?? '')) return { ok: false as const };
      throw e;
    }
    if (res.ok) await matchIntent(db.pool, db.reg, { verticalId: O.verticalId, intentId: O.id, version: res.version, trigger: 'edit' });
    return res;
  };
  let conflicts = 0;
  for (let round = 0; round < 25; round++) {
    const oldVersion = (await loadIntent(db.pool, O.verticalId, O.id))!.version;
    const target = r() < 0.5 ? 180 : 260;
    const ops: Promise<unknown>[] = [
      editO(target).then((x) => { if (!x.ok) conflicts++; }),
      matchIntent(db.pool, db.reg, { verticalId: S.verticalId, intentId: S.id, trigger: 'job' }),
      runJob(db.pool, db.reg, { id: '0', kind: 'match_intent', payload: { verticalId: O.verticalId, intentId: O.id, version: oldVersion, trigger: 'job' }, attempts: 0, max_attempts: 5 }),
      matchIntent(db.pool, db.reg, { verticalId: O.verticalId, intentId: O.id, version: oldVersion, trigger: 'job' }),
    ];
    if (r() < 0.5) ops.reverse();
    await Promise.all(ops);
    const o = (await loadIntent(db.pool, O.verticalId, O.id))!;
    const s = (await loadIntent(db.pool, S.verticalId, S.id))!;
    const m = await pair();
    const expected = BigInt(o.price_lo!) <= 20000n ? 'confirmed' : 'invalidated';
    assert.equal(m.state, expected, `round ${round}: offer v${o.version} at ${o.price_lo} → ${expected}, stored ${m.state} (eval_seq ${m.eval_seq}, b_version ${m.b_version})`);
    assert.equal(m.b_version, o.version, `round ${round}: the row reflects the offer's latest version`);
    assert.equal(m.a_version, s.version);
    if (expected === 'invalidated') assert.match(m.invalid_reason_ar ?? '', /أعلى من/, 'the reason says why');
  }
  const notes = Number((await db.pool.query("SELECT count(*) AS n FROM notifications WHERE recipient_id = $1 AND dedupe_key LIKE 'match:%'", [u1])).rows[0].n);
  assert.ok(notes <= 1, `the seeker is told about this pair at most once, not on every flip (${notes})`);
  console.log(`      info: 25 racing rounds, ${conflicts} edit(s) lost to a concurrent edit (409 path), final state always matches the latest versions`);
});

// ───────────────────────────── isolation ─────────────────────────────
test('isolation: synthetic and real intents never match, even when everything else fits', async () => {
  const realSeeker = await mkUser(db.pool, 'حقيقي يبحث', 'real');
  const synOwner = await mkUser(db.pool, 'تجريبي يعرض', 'synthetic');
  const realOwner = await mkUser(db.pool, 'حقيقي يعرض', 'real');
  const city = P('tr.gaziantep');
  const flat = (side: 'seek' | 'provide'): IntentSpec => side === 'seek'
    ? { side, categoryCode: 'real_estate.apartment', deal: 'rent', place: { pointPlaceId: null, scopePlaceIds: [city], scopeStrength: 'required', excludePlaceIds: [] }, price: null, when: null, attrs: {}, constraints: [] }
    : { side, categoryCode: 'real_estate.apartment', deal: 'rent', place: { pointPlaceId: city, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] }, price: { op: 'eq', lo: '10000', hi: '10000', currency: 'USD', unit: 'month', strength: 'required' }, when: null, attrs: {}, constraints: [] };
  const syn = await mk(synOwner, 'synthetic', flat('provide'));
  const real = await mk(realOwner, 'real', flat('provide'));
  const s = await mk(realSeeker, 'real', flat('seek'));
  await matchIntent(db.pool, db.reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'interactive' });
  await matchIntent(db.pool, db.reg, { verticalId: syn.verticalId, intentId: syn.id, trigger: 'interactive' });
  const rows = (await db.pool.query('SELECT b_intent_id, state FROM matches WHERE a_intent_id = $1', [s.id])).rows;
  assert.deepEqual(rows.map((x) => String(x.b_intent_id)), [real.id], 'only the real offer');
  assert.equal(rows[0].state, 'confirmed');
});
