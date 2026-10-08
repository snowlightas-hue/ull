// Property tests for evaluatePair with a seeded PRNG (deterministic, no dependencies).
// An independent oracle re-derives every REQUIRED condition from the product rules and must agree with the
// verdict: violated → excluded, unprovable → possible, all proven → confirmed ("match").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributesFor, isCategoryWithin, isPlaceWithin, seedRegistry } from '../../src/domain/registry.ts';
import { EXCLUSION_PRIORITY, evaluatePair, satisfies, type MatchableIntent } from '../../src/matching/evaluate.ts';
import type { AttrConstraint, AttrFact, AttrValue, Currency, DealCode, PriceSpec, PriceUnit, Strength } from '../../src/domain/types.ts';

const reg = seedRegistry();
const NOW = new Date('2026-10-08T12:00:00Z');
const ROOT = reg.rootPlaceId;
const SEED = Number(process.env.UL_PROP_SEED ?? 20261008);
const N_RANDOM = Number(process.env.UL_PROP_N ?? 3000);

// ───────────── PRNG & generators ─────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Gen {
  r: () => number;
  constructor(seed: number) { this.r = mulberry32(seed); }
  int(n: number): number { return Math.floor(this.r() * n); }
  chance(p: number): boolean { return this.r() < p; }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)]!; }
  strength(pReq = 0.6): Strength { return this.chance(pReq) ? 'required' : 'preferred'; }
  big(max: bigint): bigint { let x = 0n; for (let i = 0; i < 4; i++) x = (x << 16n) | BigInt(this.int(65536)); return x % max; }
  subset<T>(xs: readonly T[], min: number, max: number): T[] {
    const n = min + this.int(max - min + 1);
    const pool = [...xs];
    const out: T[] = [];
    while (out.length < n && pool.length) out.push(pool.splice(this.int(pool.length), 1)[0]!);
    return out;
  }
}

const SCOPES = [ROOT, 10, 11, 1101, 1102, 1103, 1107, 12, 1201, 1202, 30, 31, 33, 3302, 90];
const POINTS = [1102, 1103, 1107, 1101, 1201, 1202, 31, 3302, 90, 11, 12];
const CURRENCIES: (Currency | null)[] = ['USD', 'TRY', 'SYP', 'EUR', null];
const UNITS: (PriceUnit | null)[] = ['total', 'month', 'year', 'week', 'day', 'hour', 'session', 'person', null];
const WINDOWS = [
  { from: '2026-10-09T00:00:00+03:00', to: '2026-10-10T00:00:00+03:00', label: 'الجمعة' },
  { from: '2026-10-10T00:00:00+03:00', to: '2026-10-11T00:00:00+03:00', label: 'السبت' },
  { from: '2026-10-09T00:00:00+03:00', to: '2026-10-11T00:00:00+03:00', label: 'نهاية الأسبوع' },
  { from: '2026-10-12T00:00:00+03:00', to: '2026-10-19T00:00:00+03:00', label: 'الأسبوع الجاي' },
  { from: '2026-10-09T10:00:00+03:00', to: '2026-10-09T13:00:00+03:00', label: 'الجمعة الصبح' },
];
const EXCHANGE_VERTICALS = ['real_estate', 'vehicles', 'services', 'education', 'goods', 'help'];
const catsOf = (v: string) => reg.categories.filter((c) => c.code === v || c.code.startsWith(v + '.'));
const PEER_CATS = catsOf('activities');
const BASES = [0n, 300n, 15000n, 20000n, 300000n, 1500000n, 9007199254740993n];

let nextId = 1;
function mk(g: Gen, side: MatchableIntent['side'], categoryCode: string, deal: DealCode, over: Partial<MatchableIntent> = {}): MatchableIntent {
  const id = String(nextId++);
  return {
    id, userId: `u${id}`, realm: 'synthetic', side, categoryCode, deal, status: 'active', version: 1 + g.int(3),
    pointPlaceId: null, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [], price: null, when: null, attrs: {}, constraints: [],
    createdAt: new Date(NOW.getTime() - g.int(60) * 86_400_000).toISOString(), ...over,
  };
}

function genValue(g: Gen, def: ReturnType<typeof attributesFor>[number]): AttrValue {
  if (def.type === 'bool') return g.chance(0.5);
  if (def.type === 'enum') return g.pick(def.values!.slice(0, 4)).code;
  if (def.type === 'text') return g.pick(['a', 'b']);
  const lo = def.min ?? 0;
  return lo + g.int(6);
}
function genFact(g: Gen, def: ReturnType<typeof attributesFor>[number]): AttrFact {
  if (def.type === 'enum' && g.chance(0.35)) return g.subset(def.values!.slice(0, 4).map((v) => v.code), 1, 3); // multi-valued
  return genValue(g, def);
}
function genConstraint(g: Gen, def: ReturnType<typeof attributesFor>[number]): AttrConstraint {
  const strength = g.strength();
  const weight = strength === 'preferred' ? 1 + g.int(5) : undefined;
  if (def.type === 'int') {
    const op = g.pick(['eq', 'neq', 'lte', 'gte', 'between', 'in'] as const);
    const v = genValue(g, def) as number;
    if (op === 'between') return { key: def.key, op, lo: v, hi: v + g.int(3), strength, weight };
    if (op === 'in') return { key: def.key, op, values: [v, genValue(g, def)], strength, weight };
    return { key: def.key, op, value: v, strength, weight };
  }
  if (def.type === 'enum') {
    const op = g.pick(['eq', 'neq', 'in'] as const);
    if (op === 'in') return { key: def.key, op, values: g.subset(def.values!.slice(0, 4).map((x) => x.code), 1, 2), strength, weight };
    return { key: def.key, op, value: genValue(g, def), strength, weight };
  }
  return { key: def.key, op: g.pick(['eq', 'neq'] as const), value: genValue(g, def), strength, weight };
}
function genAttrs(g: Gen, cat: string, p: number): Record<string, AttrFact> {
  const out: Record<string, AttrFact> = {};
  for (const d of attributesFor(reg, cat)) if (g.chance(p)) out[d.key] = genFact(g, d);
  return out;
}
function genConstraints(g: Gen, cat: string, max: number): AttrConstraint[] {
  const defs = attributesFor(reg, cat);
  if (!defs.length) return [];
  return Array.from({ length: g.int(max + 1) }, () => genConstraint(g, g.pick(defs)));
}
function unitFor(g: Gen, deal: DealCode): PriceUnit | null {
  if (g.chance(0.1)) return g.pick(UNITS);
  if (deal === 'sale') return g.chance(0.5) ? 'total' : null;
  if (deal === 'rent') return g.pick(['month', 'month', 'month', 'year', 'day'] as const);
  if (deal === 'lesson') return g.pick(['session', 'hour'] as const);
  return g.chance(0.5) ? 'total' : null;
}
function genWant(g: Gen, deal: DealCode, base: bigint): PriceSpec {
  const op = g.pick(['eq', 'lte', 'lte', 'gte', 'between', 'approx'] as const);
  const currency = g.chance(0.85) ? 'USD' : g.pick(CURRENCIES);
  const unit = unitFor(g, deal);
  const strength: Strength = op === 'approx' ? 'preferred' : g.strength(0.75);
  const s = (x: bigint) => String(x < 0n ? 0n : x);
  switch (op) {
    case 'eq': case 'approx': return { op, lo: s(base), hi: s(base), currency, unit, strength };
    case 'lte': return { op, lo: null, hi: s(base), currency, unit, strength };
    case 'gte': return { op, lo: s(base), hi: null, currency, unit, strength };
    case 'between': return { op, lo: s(base), hi: s(base + BigInt(g.int(3)) * (base / 10n + 1n)), currency, unit, strength };
  }
}
function genOffer(g: Gen, want: PriceSpec | null, deal: DealCode, base: bigint): PriceSpec {
  const deltas = [0n, 1n, -1n, 2n, -2n, base / 10n, -(base / 10n), base / 5n, -(base / 5n), base];
  const anchor = want ? BigInt(g.pick([want.lo, want.hi].filter((x): x is string => x !== null))) : base;
  const x = anchor + g.pick(deltas);
  const s = (v: bigint) => String(v < 0n ? 0n : v);
  const currency = want && g.chance(0.85) ? want.currency : g.pick(CURRENCIES);
  const unit = want && g.chance(0.85) ? want.unit : unitFor(g, deal);
  const op = g.chance(0.8) ? 'eq' : g.pick(['between', 'gte', 'lte', 'approx'] as const);
  if (op === 'between') { const lo = x < 0n ? 0n : x; return { op, lo: s(lo), hi: s(lo + BigInt(1 + g.int(3)) * (base / 10n + 1n)), currency, unit, strength: 'required' }; }
  if (op === 'gte') return { op, lo: s(x), hi: null, currency, unit, strength: 'required' };
  if (op === 'lte') return { op, lo: null, hi: s(x), currency, unit, strength: 'required' };
  return { op, lo: s(x), hi: s(x), currency, unit, strength: 'required' };
}
function genWhen(g: Gen, p: number): MatchableIntent['when'] {
  return g.chance(p) ? { ...g.pick(WINDOWS), strength: g.strength() } : null;
}

function genExchangePair(g: Gen): [MatchableIntent, MatchableIntent] {
  const vertical = catsOf(g.pick(EXCHANGE_VERTICALS));
  const sc = g.pick(vertical);
  const roll = g.r();
  const pc = roll < 0.6 ? sc : roll < 0.8 ? g.pick(vertical) : roll < 0.9 ? vertical[0]! : g.pick(reg.categories.filter((c) => c.relation === 'exchange'));
  const sDeal = g.pick(sc.deals);
  const pDeal = g.chance(0.88) ? sDeal : g.pick(pc.deals);
  const base = g.pick(BASES) + BigInt(g.int(1000));
  const seekPrice = g.chance(0.7) ? genWant(g, sDeal, base) : null;
  const seek = mk(g, 'seek', sc.code, sDeal, {
    pointPlaceId: g.chance(0.3) ? g.pick(POINTS) : null,
    scopePlaceIds: g.subset(SCOPES, 0, 2), scopeStrength: g.strength(0.7),
    excludePlaceIds: g.chance(0.15) ? [g.pick(POINTS)] : [],
    price: seekPrice, when: genWhen(g, 0.25), attrs: genAttrs(g, sc.code, 0.15), constraints: genConstraints(g, pc.code, 2),
  });
  const prov = mk(g, 'provide', pc.code, pDeal, {
    pointPlaceId: g.chance(0.85) ? g.pick(POINTS) : null,
    scopePlaceIds: g.chance(0.3) ? g.subset(SCOPES, 1, 2) : [], scopeStrength: g.strength(0.7),
    excludePlaceIds: g.chance(0.05) ? [g.pick(POINTS)] : [],
    price: g.chance(0.85) ? genOffer(g, seekPrice, pDeal, base) : null, when: genWhen(g, 0.25),
    attrs: genAttrs(g, pc.code, 0.6), constraints: g.chance(0.2) ? genConstraints(g, sc.code, 1) : [],
  });
  if (g.chance(0.03)) prov.side = 'seek';
  if (g.chance(0.02)) prov.userId = seek.userId;
  if (g.chance(0.02)) prov.status = 'paused';
  if (g.chance(0.02)) prov.realm = 'real';
  return g.chance(0.5) ? [seek, prov] : [prov, seek];
}

function genPeerPair(g: Gen): [MatchableIntent, MatchableIntent] {
  const ca = g.pick(PEER_CATS);
  const cb = g.chance(0.7) ? ca : g.pick(PEER_CATS);
  const one = (cat: string) => {
    const point = g.chance(0.85) ? g.pick([1102, 1103, 31, 90, 11, 1107]) : null;
    const scope = g.chance(0.6) && point != null ? [point] : g.subset(SCOPES, 0, 2);
    return mk(g, 'join', cat, g.chance(0.97) ? 'activity' : 'help', {
      pointPlaceId: point, scopePlaceIds: scope, scopeStrength: g.strength(0.7), excludePlaceIds: g.chance(0.07) ? [g.pick(POINTS)] : [],
      when: genWhen(g, 0.85), attrs: genAttrs(g, cat, 0.5), constraints: genConstraints(g, cat, 1),
    });
  };
  return [one(ca.code), one(cb.code)];
}

// ───────────── independent oracle (required conditions only) ─────────────
type Cat = 'side' | 'identity' | 'deal' | 'category' | 'place.excl' | 'place.scope' | 'date' | 'price' | 'attr';
const ORDER: Cat[] = ['side', 'identity', 'deal', 'category', 'place.excl', 'place.scope', 'date', 'price', 'attr'];
const CODE_CAT: Record<string, Cat> = {
  side_mismatch: 'side', realm_mismatch: 'identity', same_owner: 'identity', inactive: 'identity', deal_mismatch: 'deal', category_mismatch: 'category',
  place_excluded: 'place.excl', place_out_of_scope: 'place.scope', date_no_overlap: 'date', price_above_max: 'price', price_below_min: 'price',
  price_not_exact: 'price', attr_violation: 'attr',
};

function holds(c: AttrConstraint, v: AttrValue): boolean {
  switch (c.op) {
    case 'eq': return v === c.value;
    case 'neq': return v !== c.value;
    case 'in': return (c.values ?? []).includes(v);
    case 'lte': return typeof v === 'number' && typeof c.value === 'number' && v <= c.value;
    case 'gte': return typeof v === 'number' && typeof c.value === 'number' && v >= c.value;
    case 'between': return typeof v === 'number' && (c.lo === undefined || v >= c.lo) && (c.hi === undefined || v <= c.hi);
  }
}
function factHolds(c: AttrConstraint, f: AttrFact): boolean {
  if (!Array.isArray(f)) return holds(c, f);
  return c.op === 'neq' ? !f.includes(c.value as string) : f.some((x) => holds(c, x));
}
/** Offer price → the range of amounts it may end at (definitions from docs/MATCHING.md). */
function offerRange(p: PriceSpec): [bigint, bigint | null] {
  const x = BigInt(p.lo ?? p.hi!);
  switch (p.op) {
    case 'eq': return [x, x];
    case 'lte': return [0n, BigInt(p.hi ?? p.lo!)];
    case 'gte': return [BigInt(p.lo ?? p.hi!), null];
    case 'between': return [BigInt(p.lo ?? '0'), p.hi === null ? null : BigInt(p.hi)];
    case 'approx': return [x - x / 10n, x + (x + 9n) / 10n];
  }
}
function wantRange(p: PriceSpec): [bigint | null, bigint | null] {
  const lo = p.lo === null ? null : BigInt(p.lo);
  const hi = p.hi === null ? null : BigInt(p.hi);
  if (p.op === 'eq') return [lo ?? hi, lo ?? hi];
  if (p.op === 'lte') return [null, hi];
  if (p.op === 'gte') return [lo, null];
  return [lo, hi];
}

function oracle(x: MatchableIntent, y: MatchableIntent): { violations: Cat[]; unknowns: string[] } {
  const V: Cat[] = [];
  const U: string[] = [];
  const peer = x.side === 'join' && y.side === 'join';
  let s: MatchableIntent;
  let p: MatchableIntent;
  if (peer) [s, p] = [x, y];
  else if (x.side === 'seek' && y.side === 'provide') [s, p] = [x, y];
  else if (x.side === 'provide' && y.side === 'seek') [s, p] = [y, x];
  else return { violations: ['side'], unknowns: [] };
  if (x.realm !== y.realm || x.userId === y.userId || x.status !== 'active' || y.status !== 'active') V.push('identity');
  if (s.deal !== p.deal) V.push('deal');
  const cs = reg.categoryByCode.get(s.categoryCode)!;
  const cp = reg.categoryByCode.get(p.categoryCode)!;
  const pNarrower = isCategoryWithin(reg, cp.id, cs.id);
  if (!pNarrower && !isCategoryWithin(reg, cs.id, cp.id)) V.push('category');
  else if (!peer && !pNarrower) U.push('category');
  const inside = (a: number, b: number) => isPlaceWithin(reg, a, b);

  // places
  if (!peer) {
    for (const [pt, sc] of [[p, s], [s, p]] as const) {
      if (sc.excludePlaceIds.length) {
        const q = pt.pointPlaceId;
        if (q == null) U.push('place.excl');
        else if (sc.excludePlaceIds.some((e) => inside(q, e))) V.push('place.excl');
        else if (sc.excludePlaceIds.some((e) => inside(e, q))) U.push('place.excl'); // a region that contains an excluded place
      }
      if (sc.scopeStrength !== 'required' || !sc.scopePlaceIds.length || sc.scopePlaceIds.includes(ROOT)) continue;
      const q = pt.pointPlaceId;
      if (q == null) U.push('place.scope');
      else if (sc.scopePlaceIds.some((z) => inside(q, z))) continue;
      else if (sc.scopePlaceIds.some((z) => inside(z, q))) U.push('place.scope'); // broader point: maybe inside
      else V.push('place.scope');
    }
  } else {
    const loc = (i: MatchableIntent) => (i.pointPlaceId != null ? [i.pointPlaceId] : i.scopePlaceIds.filter((z) => z !== ROOT));
    if (!loc(s).length || !loc(p).length) U.push('place.loc');
    for (const [o, other] of [[s, p], [p, s]] as const) {
      const l = loc(other);
      if (!l.length) continue;
      if (o.excludePlaceIds.length) {
        if (l.every((q) => o.excludePlaceIds.some((e) => inside(q, e)))) V.push('place.excl');
        else if (l.some((q) => o.excludePlaceIds.some((e) => inside(e, q) || inside(q, e)))) U.push('place.excl'); // may be in an excluded place
      }
      const area = o.scopePlaceIds.length ? o.scopePlaceIds : o.pointPlaceId != null ? [o.pointPlaceId] : [];
      if (o.scopeStrength !== 'required' || !area.length || area.includes(ROOT)) continue;
      if (l.every((q) => area.some((z) => inside(q, z)))) continue;
      if (l.every((q) => area.every((z) => !inside(q, z) && !inside(z, q)))) V.push('place.scope');
      else U.push('place.scope');
    }
  }

  // dates
  if (s.when && p.when) {
    const overlap = Date.parse(s.when.from) < Date.parse(p.when.to) && Date.parse(p.when.from) < Date.parse(s.when.to);
    if (!overlap && s.when.strength === 'required' && p.when.strength === 'required') V.push('date');
  } else if (peer || s.when?.strength === 'required' || p.when?.strength === 'required') U.push('date');

  // price
  if (!peer && s.price) {
    const w = s.price;
    const req = w.op !== 'approx' && w.strength === 'required';
    const h = p.price;
    if (!h || (h.lo === null && h.hi === null)) { if (req) U.push('price'); }
    else {
      const wu = w.unit ?? (s.deal === 'sale' ? 'total' : null);
      const hu = h.unit ?? (p.deal === 'sale' ? 'total' : null);
      const free = h.lo === '0' && h.hi === '0' && (w.op === 'lte' || w.op === 'approx'); // free is within any ceiling
      if (free) { /* satisfied */ }
      // PRODUCT §6.2: an incomparable REQUIRED price leaves the pair possible; an incomparable preference never blocks
      else if (!w.currency || w.currency !== h.currency || !wu || wu !== hu) { if (req) U.push('price.meaning'); }
      else if (req) {
        const [hlo, hhi] = offerRange(h);
        const [wlo, whi] = wantRange(w);
        const allIn = (wlo === null || hlo >= wlo) && (whi === null || (hhi !== null && hhi <= whi));
        const noneIn = (whi !== null && hlo > whi) || (wlo !== null && hhi !== null && hhi < wlo);
        if (noneIn) V.push('price');
        else if (!allIn) U.push('price');
      }
    }
  }

  // attributes, both directions
  for (const [owner, other] of [[s, p], [p, s]] as const) {
    for (const c of owner.constraints) {
      if (c.strength !== 'required') continue;
      const f = other.attrs[c.key];
      if (f === undefined || f === null || (Array.isArray(f) && !f.length)) U.push('attr');
      else if (!factHolds(c, f)) V.push('attr');
    }
  }
  return { violations: V, unknowns: U };
}

const show = (a: MatchableIntent, b: MatchableIntent) => JSON.stringify({ a, b });

// ───────────── generated corpus (≥ 2,000 pairs) ─────────────
const g = new Gen(SEED);
const pairs: [MatchableIntent, MatchableIntent][] = [];
for (let i = 0; i < N_RANDOM; i++) pairs.push(g.chance(0.7) ? genExchangePair(g) : genPeerPair(g));
const verdicts = pairs.map(([a, b]) => evaluatePair(reg, a, b, { now: NOW }));

test(`properties: ${N_RANDOM} random pairs cover every verdict`, () => {
  assert.ok(pairs.length >= 2000);
  const n = { match: 0, possible: 0, excluded: 0 };
  for (const v of verdicts) n[v.verdict]++;
  for (const k of ['match', 'possible', 'excluded'] as const) assert.ok(n[k] >= N_RANDOM / 20, `verdict ${k}: ${n[k]} of ${N_RANDOM}`);
});

test('properties: verdict equals the independent oracle (confirmed never violates or leaves unproven a required condition)', () => {
  const errs: string[] = [];
  pairs.forEach(([a, b], i) => {
    const v = verdicts[i]!;
    const o = oracle(a, b);
    const want = o.violations.length ? 'excluded' : o.unknowns.length ? 'possible' : 'match';
    if (v.verdict !== want) errs.push(`#${i}: evaluator ${v.verdict}, oracle ${want} ${JSON.stringify(o)} reasons=${v.reasons.map((r) => r.code)} ${show(a, b)}`);
    else if (v.verdict === 'excluded') {
      const first = ORDER.find((c) => o.violations.includes(c));
      if (CODE_CAT[v.exclusion!.code] !== first) errs.push(`#${i}: exclusion ${v.exclusion!.code}, oracle's first violation ${first} ${show(a, b)}`);
    }
  });
  assert.deepEqual(errs.slice(0, 3), []);
});

test('properties: every excluded has a known exclusion code that is also listed in its reasons; scores stay in their band', () => {
  verdicts.forEach((v, i) => {
    if (v.verdict === 'excluded') {
      assert.ok(v.exclusion && (EXCLUSION_PRIORITY as readonly string[]).includes(v.exclusion.code), `#${i} ${v.exclusion?.code}`);
      assert.ok(v.reasons.some((r) => r.code === v.exclusion!.code && r.polarity === 'minus'), `#${i}`);
      assert.equal(v.score, 0);
    } else if (v.verdict === 'possible') {
      assert.ok(Number.isInteger(v.score) && v.score >= 0 && v.score <= 4999, `#${i} possible ${v.score}`);
      assert.ok(v.missing.length > 0 && v.reasons.some((r) => r.polarity === 'unknown'), `#${i} possible without a clear unknown`);
      assert.equal(v.exclusion, undefined);
    } else {
      assert.ok(Number.isInteger(v.score) && v.score >= 5000 && v.score <= 10000, `#${i} confirmed ${v.score}`);
      assert.deepEqual(v.missing, []);
    }
  });
});

test('properties: exchange is order-independent and peer evaluation is symmetric (identical verdict objects)', () => {
  let ex = 0;
  let pe = 0;
  pairs.forEach(([a, b], i) => {
    const ba = evaluatePair(reg, b, a, { now: NOW });
    assert.deepEqual(ba, verdicts[i], `#${i} ${show(a, b)}`);
    if (a.side === 'join' && b.side === 'join') pe++; else ex++;
  });
  assert.ok(ex > 1000 && pe > 500, `exchange ${ex}, peer ${pe}`);
});

test('properties: a currency or unit mismatch (or unknown) on a REQUIRED price is never confirmed; on a preference it is shown but does not block', () => {
  const h = new Gen(SEED + 1);
  let checked = 0;
  for (let i = 0; i < 500; i++) {
    const deal = h.pick(['rent', 'sale', 'lesson', 'service'] as const);
    const cat = deal === 'rent' || deal === 'sale' ? 'real_estate.apartment' : deal === 'lesson' ? 'education.tutoring' : 'services.plumbing';
    const amount = String(1000n + h.big(10n ** 12n));
    const unit: PriceUnit = deal === 'sale' ? 'total' : deal === 'rent' ? 'month' : 'session';
    const want: PriceSpec = { op: h.pick(['eq', 'lte', 'gte', 'between', 'approx'] as const), lo: amount, hi: amount, currency: 'USD', unit, strength: h.strength(0.5) };
    if (want.op === 'lte') want.lo = null;
    if (want.op === 'gte') want.hi = null;
    if (want.op === 'approx') want.strength = 'preferred';
    const offer: PriceSpec = { op: 'eq', lo: amount, hi: amount, currency: 'USD', unit, strength: 'required' };
    const kind = h.int(3);
    if (kind === 0) offer.currency = h.pick(['TRY', 'SYP', 'EUR', null] as const);
    else if (kind === 1) offer.unit = h.pick(UNITS.filter((u) => u !== unit && !(deal === 'sale' && u === null)));
    else want.currency = null;
    const a = mk(h, 'seek', cat, deal, { price: want });
    const b = mk(h, 'provide', cat, deal, { price: offer, pointPlaceId: 1102 });
    const v = evaluatePair(reg, a, b, { now: NOW });
    assert.ok(v.reasons.some((r) => r.code === 'currency_mismatch' || r.code === 'unit_mismatch'), show(a, b));
    if (want.op !== 'approx' && want.strength === 'required') {
      assert.notEqual(v.verdict, 'match', show(a, b));
      assert.ok(v.missing.includes('price.currency') || v.missing.includes('price.unit'));
    } else {
      assert.ok(!v.missing.includes('price.currency') && !v.missing.includes('price.unit'), `a preference never blocks: ${show(a, b)}`);
    }
    checked++;
  }
  // and inside the random corpus
  pairs.forEach(([a, b], i) => {
    const [s, p] = a.side === 'seek' ? [a, b] : [b, a];
    if (a.side === 'join' || s.side !== 'seek' || p.side !== 'provide' || !s.price || !p.price) return;
    const su = s.price.unit ?? (s.deal === 'sale' ? 'total' : null);
    const pu = p.price.unit ?? (p.deal === 'sale' ? 'total' : null);
    if (s.price.currency && s.price.currency === p.price.currency && su && su === pu) return;
    if (s.price.op === 'approx' || s.price.strength !== 'required') return; // preferences never block (PRODUCT §6.2-4)
    if (p.price.lo === '0' && p.price.hi === '0' && s.price.op === 'lte') return; // free is within any ceiling
    assert.notEqual(verdicts[i]!.verdict, 'match', `#${i}`);
    checked++;
  });
  assert.ok(checked >= 600, `checked ${checked}`);
});

test('properties: price boundaries are exact in BigInt minor units (max ok, max+1 excluded, eq exact, gte/between edges)', () => {
  const h = new Gen(SEED + 2);
  const run = (want: PriceSpec, amount: bigint) => {
    const a = mk(h, 'seek', 'vehicles.car', 'sale', { price: want });
    const b = mk(h, 'provide', 'vehicles.car', 'sale', { pointPlaceId: 1102, price: { op: 'eq', lo: String(amount), hi: String(amount), currency: 'USD', unit: 'total', strength: 'required' } });
    return evaluatePair(reg, a, b, { now: NOW });
  };
  const codes = (v: ReturnType<typeof run>) => v.reasons.map((r) => r.code);
  for (let i = 0; i < 150; i++) {
    const X = 2n + h.big(2n ** 63n); // well beyond 2^53
    const base = { currency: 'USD' as const, unit: 'total' as const };
    // ceiling
    const lte: PriceSpec = { op: 'lte', lo: null, hi: String(X), strength: 'required', ...base };
    assert.equal(run(lte, X).verdict, 'match'); assert.ok(codes(run(lte, X)).includes('price_within_max'));
    assert.equal(run(lte, X - 1n).verdict, 'match');
    assert.equal(run(lte, X + 1n).exclusion?.code, 'price_above_max', String(X));
    const lteSoft = { ...lte, strength: 'preferred' as const };
    const soft = run(lteSoft, X + 1n);
    assert.equal(soft.verdict, 'match'); assert.ok(soft.reasons.some((r) => r.code === 'price_above_max' && r.polarity === 'minus' && r.strength === 'preferred'));
    // equality
    const eq: PriceSpec = { op: 'eq', lo: String(X), hi: String(X), strength: 'required', ...base };
    assert.ok(codes(run(eq, X)).includes('price_exact'));
    assert.equal(run(eq, X + 1n).exclusion?.code, 'price_not_exact');
    assert.equal(run(eq, X - 1n).exclusion?.code, 'price_not_exact');
    // floor
    const gte: PriceSpec = { op: 'gte', lo: String(X), hi: null, strength: 'required', ...base };
    assert.ok(codes(run(gte, X)).includes('price_in_range'));
    assert.equal(run(gte, X - 1n).exclusion?.code, 'price_below_min');
    // range
    const Y = X + 1n + h.big(1000n);
    const btw: PriceSpec = { op: 'between', lo: String(X), hi: String(Y), strength: 'required', ...base };
    assert.ok(codes(run(btw, X)).includes('price_in_range'));
    assert.ok(codes(run(btw, Y)).includes('price_in_range'));
    assert.equal(run(btw, X - 1n).exclusion?.code, 'price_below_min');
    assert.equal(run(btw, Y + 1n).exclusion?.code, 'price_above_max');
  }
});

test('properties: an offer range that straddles a required condition is possible, never confirmed', () => {
  const h = new Gen(SEED + 3);
  for (let i = 0; i < 200; i++) {
    const X = 100n + h.big(10n ** 9n);
    const a = mk(h, 'seek', 'real_estate.apartment', 'rent', { price: { op: 'lte', lo: null, hi: String(X), currency: 'USD', unit: 'month', strength: 'required' } });
    const lo = X - 1n - h.big(X / 2n);
    const b = mk(h, 'provide', 'real_estate.apartment', 'rent', { pointPlaceId: 1102, price: { op: h.pick(['between', 'gte'] as const), lo: String(lo), hi: String(X + 1n + h.big(1000n)), currency: 'USD', unit: 'month', strength: 'required' } });
    if (b.price!.op === 'gte') b.price!.hi = null;
    const v = evaluatePair(reg, a, b, { now: NOW });
    assert.equal(v.verdict, 'possible', show(a, b));
    assert.ok(v.missing.includes('price'));
  }
});

test('properties: multi-valued facts — eq/in = has any requested value, neq = has none of it', () => {
  const h = new Gen(SEED + 4);
  const def = attributesFor(reg, 'services.appliance_repair').find((d) => d.key === 'appliance')!;
  const codes = def.values!.map((v) => v.code);
  let n = 0;
  for (let i = 0; i < 400; i++) {
    const fact = h.subset(codes, 1, 4);
    const op = h.pick(['eq', 'in', 'neq'] as const);
    const c: AttrConstraint = op === 'in'
      ? { key: 'appliance', op, values: h.subset(codes, 1, 3), strength: h.strength(0.5) }
      : { key: 'appliance', op, value: h.pick(codes), strength: h.strength(0.5) };
    const expected = op === 'eq' ? fact.includes(c.value as string) : op === 'in' ? c.values!.some((x) => fact.includes(x as string)) : !fact.includes(c.value as string);
    assert.equal(satisfies(c, fact), expected, JSON.stringify({ c, fact }));
    const seek = mk(h, 'seek', 'services.appliance_repair', 'service', { pointPlaceId: 1102, constraints: [c] });
    const prov = mk(h, 'provide', 'services.appliance_repair', 'service', { pointPlaceId: 1102, attrs: { appliance: fact } });
    const v = evaluatePair(reg, seek, prov, { now: NOW });
    if (c.strength === 'required') {
      assert.equal(v.verdict, expected ? 'match' : 'excluded');
      if (!expected) assert.equal(v.exclusion?.code, 'attr_violation');
      else assert.ok(v.reasons.some((r) => r.code === 'attr_satisfied'));
    } else {
      assert.equal(v.verdict, 'match');
      assert.ok(v.reasons.some((r) => r.code === (expected ? 'pref_satisfied' : 'pref_unsatisfied')));
    }
    n++;
  }
  // a missing or empty multi-valued fact is unknown (possible), never a violation
  const seek = mk(h, 'seek', 'services.appliance_repair', 'service', { pointPlaceId: 1102, constraints: [{ key: 'appliance', op: 'neq', value: 'tv', strength: 'required' }] });
  for (const attrs of [{}, { appliance: [] }] as Record<string, AttrFact>[]) {
    const prov = mk(h, 'provide', 'services.appliance_repair', 'service', { pointPlaceId: 1102, attrs });
    const v = evaluatePair(reg, seek, prov, { now: NOW });
    assert.equal(v.verdict, 'possible');
    assert.deepEqual(v.missing, ['attr.appliance']);
  }
  assert.ok(n === 400);
});

test('properties: preferences never exclude and never block confirmation (except incomparable money)', () => {
  // turn every required condition of the random corpus into a preference: nothing may be excluded except identity/side/deal/category
  pairs.forEach(([a, b], i) => {
    const soft = (m: MatchableIntent): MatchableIntent => ({
      ...m, scopeStrength: 'preferred', excludePlaceIds: [],
      price: m.price && { ...m.price, strength: 'preferred' }, when: m.when && { ...m.when, strength: 'preferred' },
      constraints: m.constraints.map((c) => ({ ...c, strength: 'preferred' as const })),
    });
    const v = evaluatePair(reg, soft(a), soft(b), { now: NOW });
    if (v.verdict === 'excluded') assert.ok(['side_mismatch', 'realm_mismatch', 'same_owner', 'inactive', 'deal_mismatch', 'category_mismatch'].includes(v.exclusion!.code), `#${i} ${v.exclusion!.code}`);
    if (v.verdict === 'possible') assert.ok(v.missing.every((m) => ['price.currency', 'price.unit', 'category', 'place', 'when'].includes(m)), `#${i} ${v.missing}`);
  });
});
