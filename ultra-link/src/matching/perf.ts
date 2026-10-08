// Matching write-path benchmark (developer tool; never touches the app database `ultralink`).
//
//   node src/matching/perf.ts [--n 20000] [--sample 400] [--seed 7] [--engine label=/abs/path/engine.ts ...] [--keep]
//
// 1. Builds `ultralink_t_r6_perf_base` (from ultralink_template + migrations + reference data) with N synthetic,
//    all-active intents: skewed towards a few cities and categories so that runs have tens to hundreds of
//    candidates, with prices, places, attributes, constraints and activity windows (createIntent, batched txs).
// 2. Clones it once per engine (CREATE DATABASE … TEMPLATE), so every engine starts from identical data.
// 3. Runs matchIntent (trigger 'job', fixed `now`) for the same seeded sample of intents, twice:
//      cold — every pair and notification is new;  warm — the same pairs again (guarded updates, deduped notes).
// 4. Prints per-run latency (mean / p50 / p95), SQL round trips per run (pg.Client#query calls, BEGIN/COMMIT
//    included) and a fingerprint of the resulting matches + notifications: equal fingerprints = equal results.
// The current engine is always measured as `current`; `--engine` adds another module exporting matchIntent
// (e.g. an older engine.ts extracted from git with its imports pointed at this checkout).
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../lib/env.ts';
import { migrate } from '../db/migrate.ts';
import { withTx } from '../db/pool.ts';
import { loadRegistry, syncReference } from '../seed/reference.ts';
import { attributesFor, type Registry } from '../domain/registry.ts';
import { createIntent } from '../repo/intents.ts';
import type { AttrConstraint, AttrFact, Currency, IntentSpec, PriceSpec, PriceUnit, Side } from '../domain/types.ts';

type MatchFn = (pool: pg.Pool, reg: Registry, args: { verticalId: number; intentId: string; trigger: 'job'; now?: Date }) => Promise<{ totals: { candidates: number; confirmed: number; possible: number } }>;

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const N = Number(arg('n', '20000'));
const SAMPLE = Number(arg('sample', '400'));
const SEED = Number(arg('seed', '7'));
const KEEP = process.argv.includes('--keep');
const PREFIX = 'ultralink_t_r6_perf';

// ───────────── deterministic generator ─────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r = mulberry32(SEED);
const chance = (p: number) => r() < p;
const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
function weighted<T>(xs: readonly (readonly [T, number])[]): T {
  const total = xs.reduce((s, x) => s + x[1], 0);
  let u = r() * total;
  for (const [v, w] of xs) { u -= w; if (u < 0) return v; }
  return xs[xs.length - 1]![0];
}

const CITY_W: [string, number][] = [
  ['sy.aleppo.aleppo', 22], ['sy.aleppo.azaz', 14], ['sy.idlib.idlib', 10], ['tr.gaziantep', 8], ['tr.istanbul', 6], ['sy.aleppo.afrin', 5],
  ['sy.aleppo.al_bab', 4], ['sy.idlib.sarmada', 3], ['sy.idlib.dana', 3], ['sy.damascus.damascus', 3], ['sy.aleppo.marea', 1], ['sy.aleppo.jarabulus', 1],
  ['sy.idlib.atmeh', 1], ['tr.kilis', 1], ['tr.hatay.reyhanli', 1], ['sy.aleppo.jindires', 1],
];
const CAT_W: [string, number][] = [
  ['real_estate.apartment', 20], ['real_estate.room', 4], ['real_estate.shop', 3], ['vehicles.car', 16], ['vehicles.motorcycle', 4],
  ['services.plumbing', 4], ['services.electrical', 4], ['services.appliance_repair', 4], ['education.tutoring', 6], ['goods.electronics', 8],
  ['goods.furniture', 5], ['activities.sports', 3], ['activities.trip', 2],
];
const PRICE: Record<string, [PriceUnit, number, number]> = {
  'real_estate.apartment:rent': ['month', 80, 500], 'real_estate.apartment:sale': ['total', 8000, 150000], 'real_estate.room:rent': ['month', 40, 200],
  'real_estate.shop:rent': ['month', 100, 600], 'real_estate.shop:sale': ['total', 10000, 100000], 'vehicles.car:sale': ['total', 2000, 30000],
  'vehicles.car:rent': ['day', 20, 80], 'vehicles.motorcycle:sale': ['total', 300, 3000], 'vehicles.motorcycle:rent': ['day', 5, 20],
  'education.tutoring:lesson': ['hour', 3, 15], 'goods.electronics:sale': ['total', 50, 1500], 'goods.furniture:sale': ['total', 30, 800],
  'services.plumbing:service': ['session', 10, 60], 'services.electrical:service': ['session', 10, 60], 'services.appliance_repair:service': ['session', 10, 60],
};
const DAY = 86_400_000;

function genSpec(reg: Registry, now: Date): IntentSpec {
  const P = (code: string) => reg.placeByCode.get(code)!.id;
  const city = () => P(weighted(CITY_W));
  const regionOf = (id: number) => reg.placeById.get(id)!.ancestors[1] ?? id; // ancestors = [self, parent, …]
  const categoryCode = weighted(CAT_W);
  const cat = reg.categoryByCode.get(categoryCode)!;
  const deal = cat.deals.length > 1 ? (cat.deals.includes('rent') && chance(0.6) ? 'rent' : 'sale') : cat.deals[0]!;
  const fam = cat.verticalCode === 'activities' ? 'peer' : ['services', 'education'].includes(cat.verticalCode) ? 'service' : 'goods';
  const side: Side = fam === 'peer' ? 'join' : chance(0.61) ? 'provide' : 'seek';
  const spec: IntentSpec = { side, categoryCode, deal, place: { pointPlaceId: null, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] }, price: null, when: null, attrs: {}, constraints: [] };

  // places
  if (fam === 'peer') {
    const c = city();
    spec.place = { pointPlaceId: c, scopePlaceIds: [chance(0.2) ? regionOf(c) : c], scopeStrength: chance(0.8) ? 'required' : 'preferred', excludePlaceIds: [] };
    const d = new Date(now.getTime() + int(0, 6) * DAY);
    d.setUTCHours(0, 0, 0, 0);
    spec.when = { from: d.toISOString(), to: new Date(d.getTime() + (chance(0.7) ? 1 : 3) * DAY).toISOString(), strength: chance(0.8) ? 'required' : 'preferred' };
  } else if (fam === 'service') {
    const c = categoryCode === 'education.tutoring' && chance(0.2) ? P('online') : city();
    if (side === 'provide') {
      const area = c === P('online') ? [] : chance(0.5) ? [c] : chance(0.5) ? [c, city()] : [regionOf(c)];
      spec.place = { pointPlaceId: c, scopePlaceIds: chance(0.85) ? [...new Set(area)] : [], scopeStrength: chance(0.8) ? 'required' : 'preferred', excludePlaceIds: [] };
    } else {
      spec.place = { pointPlaceId: c, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] };
    }
  } else if (side === 'provide') {
    const c = city();
    spec.place = { pointPlaceId: chance(0.03) ? regionOf(c) : chance(0.02) ? null : c, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] };
  } else {
    const c = city();
    const scope = chance(0.05) ? [] : chance(0.1) ? [regionOf(c)] : chance(0.15) ? [c, city()] : [c];
    spec.place = { pointPlaceId: null, scopePlaceIds: [...new Set(scope)], scopeStrength: chance(0.75) ? 'required' : 'preferred', excludePlaceIds: chance(0.03) ? [P('sy.aleppo.afrin')] : [] };
  }

  // price
  const band = PRICE[`${categoryCode}:${deal}`];
  if (band && fam !== 'peer') {
    const [unit, lo, hi] = band;
    const currency: Currency = weighted([['USD', 80], ['TRY', 15], ['SYP', 5]] as const);
    const scale = currency === 'USD' ? 1 : currency === 'TRY' ? 35 : 13000;
    const amount = (x: number) => String(BigInt(Math.round(x * scale)) * 100n);
    if (side === 'provide' && chance(0.9)) {
      const x = int(lo, hi);
      spec.price = { op: 'eq', lo: amount(x), hi: amount(x), currency, unit: chance(0.95) ? unit : null, strength: 'required' };
    } else if (side === 'seek' && chance(0.75)) {
      const x = int(lo, hi);
      const op: PriceSpec['op'] = weighted([['lte', 75], ['between', 10], ['approx', 10], ['eq', 5]] as const);
      const strength = op === 'approx' ? 'preferred' : chance(0.8) ? 'required' : 'preferred';
      spec.price = op === 'lte' ? { op, lo: null, hi: amount(x), currency, unit, strength }
        : op === 'between' ? { op, lo: amount(x * 0.7), hi: amount(x), currency, unit, strength }
        : { op, lo: amount(x), hi: amount(x), currency, unit, strength };
    }
  }

  // attributes (owner facts) and constraints (on the counterpart)
  const defs = attributesFor(reg, categoryCode);
  const def = (k: string) => defs.find((d) => d.key === k);
  const attrs: Record<string, AttrFact> = {};
  const cons: AttrConstraint[] = [];
  if (categoryCode === 'real_estate.apartment') {
    if (side === 'provide') { attrs.rooms = int(1, 5); if (chance(0.6)) attrs.furnished = chance(0.4); if (chance(0.5)) attrs.floor = int(0, 6); }
    else { if (chance(0.3)) cons.push({ key: 'rooms', op: 'gte', value: int(2, 4), strength: 'required' }); if (chance(0.2)) cons.push({ key: 'furnished', op: 'eq', value: true, strength: 'preferred', weight: 2 }); }
  } else if (categoryCode === 'vehicles.car') {
    const makes = def('make')!.values!.slice(0, 5).map((v) => v.code);
    if (side === 'provide') { attrs.make = pick(makes); attrs.year = int(2000, 2024); if (chance(0.6)) attrs.transmission = chance(0.5) ? 'automatic' : 'manual'; }
    else { if (chance(0.25)) cons.push({ key: 'make', op: 'in', values: [pick(makes), pick(makes)], strength: 'required' }); if (chance(0.2)) cons.push({ key: 'year', op: 'gte', value: int(2005, 2020), strength: 'required' }); }
  } else if (categoryCode === 'education.tutoring') {
    const subjects = def('subject')!.values!.slice(0, 5).map((v) => v.code);
    if (side === 'provide') attrs.subject = chance(0.4) ? [pick(subjects), pick(subjects)].filter((x, i, a) => a.indexOf(x) === i) : pick(subjects);
    else cons.push({ key: 'subject', op: 'eq', value: pick(subjects), strength: 'required' });
  } else if (categoryCode.startsWith('services.')) {
    if (side === 'provide' && chance(0.7)) attrs.home_visit = chance(0.7);
    if (side === 'seek' && chance(0.3)) cons.push({ key: 'home_visit', op: 'eq', value: true, strength: 'required' });
  } else if (categoryCode === 'activities.sports') {
    attrs.group_size = int(1, 6);
    if (chance(0.3)) cons.push({ key: 'group_size', op: 'lte', value: int(4, 10), strength: 'required' });
  }
  spec.attrs = attrs;
  spec.constraints = cons;
  return spec;
}

// ───────────── databases ─────────────
loadEnv();
const ADMIN = process.env.DATABASE_ADMIN_URL!;
const urlOf = (name: string) => ADMIN.replace(/\/[^/]+$/, `/${name}`);
async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
const dropDb = (name: string) => admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
async function cloneDb(from: string, to: string) {
  await dropDb(to);
  await admin((c) => c.query(`CREATE DATABASE ${to} TEMPLATE ${from}`));
}

async function buildBase(): Promise<{ ids: { verticalId: number; id: string }[]; ms: number }> {
  const base = `${PREFIX}_base`;
  await dropDb(base);
  await admin((c) => c.query(`CREATE DATABASE ${base} TEMPLATE ultralink_template`));
  const pool = new pg.Pool({ connectionString: urlOf(base), max: 5 });
  try {
    await migrate(pool, () => {});
    await syncReference(pool);
    const reg = await loadRegistry(pool);
    const t0 = Date.now();
    const users = (await pool.query(`INSERT INTO users (display_name, realm) SELECT 'perf ' || g, 'synthetic' FROM generate_series(1, $1) g RETURNING id`, [Math.max(50, Math.round(N / 5))])).rows.map((x) => String(x.id));
    const now = new Date();
    const jobs = Array.from({ length: N }, () => ({ user: pick(users), spec: genSpec(reg, now), createdAt: new Date(now.getTime() - Math.floor(r() * 20 * DAY)) }));
    const ids: { verticalId: number; id: string }[] = [];
    const CHUNK = 500;
    const chunks = Array.from({ length: Math.ceil(N / CHUNK) }, (_, k) => jobs.slice(k * CHUNK, (k + 1) * CHUNK));
    for (let k = 0; k < chunks.length; k += 4) {
      const out = await Promise.all(chunks.slice(k, k + 4).map((chunk) => withTx(pool, async (tx) => {
        const got: { verticalId: number; id: string }[] = [];
        for (const j of chunk) got.push(await createIntent(tx, reg, { userId: j.user, realm: 'synthetic', spec: j.spec, titleAr: 'عنوان تجريبي', sourceText: null, conversationId: null, createdAt: j.createdAt }));
        return got;
      })));
      for (const o of out) ids.push(...o);
    }
    await pool.query('ANALYZE');
    return { ids, ms: Date.now() - t0 };
  } finally {
    await pool.end();
  }
}

// ───────────── measurement ─────────────
let statements = 0;
const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
const origQuery = proto.query;
proto.query = function (this: unknown, ...a: unknown[]) { statements++; return origQuery.apply(this, a); };

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

interface PassStats { runs: number; totalMs: number; meanMs: number; p50Ms: number; p95Ms: number; maxMs: number; stmtMean: number; stmtMax: number; candidatesMean: number; pairsMean: number }

async function pass(fn: MatchFn, pool: pg.Pool, reg: Registry, sample: { verticalId: number; id: string }[], now: Date): Promise<PassStats> {
  const ms: number[] = [];
  const st: number[] = [];
  const cands: number[] = [];
  const pairs: number[] = [];
  const t0 = Date.now();
  for (const s of sample) {
    const before = statements;
    const t = performance.now();
    const out = await fn(pool, reg, { verticalId: s.verticalId, intentId: s.id, trigger: 'job', now });
    ms.push(performance.now() - t);
    st.push(statements - before);
    cands.push(out.totals.candidates);
    pairs.push(out.totals.confirmed + out.totals.possible);
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { runs: sample.length, totalMs: Date.now() - t0, meanMs: r1(mean(ms)), p50Ms: r1(pct(ms, 50)), p95Ms: r1(pct(ms, 95)), maxMs: r1(Math.max(...ms)), stmtMean: r1(mean(st)), stmtMax: Math.max(...st), candidatesMean: r1(mean(cands)), pairsMean: r1(mean(pairs)) };
}

async function fingerprint(pool: pg.Pool): Promise<{ matches: number; notifications: number; refs: number; hash: string }> {
  const m = await pool.query(`SELECT a_intent_id, b_intent_id, kind, state, score, reasons::text, missing::text, a_version, b_version, invalid_reason_ar FROM matches ORDER BY a_intent_id, b_intent_id`);
  const n = await pool.query(`SELECT recipient_id, kind, title_ar, body_ar, dedupe_key FROM notifications ORDER BY recipient_id, dedupe_key`);
  const refs = Number((await pool.query('SELECT count(*) n FROM match_refs')).rows[0].n);
  const h = createHash('sha256');
  for (const x of m.rows) h.update(JSON.stringify(Object.values(x)));
  h.update('|');
  for (const x of n.rows) h.update(JSON.stringify(Object.values(x)));
  return { matches: m.rowCount ?? 0, notifications: n.rowCount ?? 0, refs, hash: h.digest('hex').slice(0, 16) };
}

const engines: [string, string][] = [['current', new URL('./engine.ts', import.meta.url).href]];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--engine') continue;
  const [label, path] = process.argv[i + 1]!.split('=');
  engines.unshift([label!, pathToFileURL(path!).href]);
}

console.log(`matching perf: n=${N} sample=${SAMPLE} seed=${SEED} engines=${engines.map((e) => e[0]).join(',')}`);
const built = await buildBase();
console.log(`generated ${built.ids.length} intents in ${built.ms} ms`);
const sample = Array.from({ length: Math.min(SAMPLE, built.ids.length) }, () => pick(built.ids)).filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i);
const now = new Date();
const report: Record<string, unknown> = { n: N, sample: sample.length, seed: SEED };
for (const [label, href] of engines) {
  const name = `${PREFIX}_${label.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  await cloneDb(`${PREFIX}_base`, name);
  const pool = new pg.Pool({ connectionString: urlOf(name), max: 4 });
  try {
    const reg = await loadRegistry(pool);
    const fn = (await import(href)).matchIntent as MatchFn;
    await pool.query('SELECT count(*) FROM intents'); await pool.query('SELECT count(*) FROM intent_scopes'); // warm the cache
    const cold = await pass(fn, pool, reg, sample, now);
    const warm = await pass(fn, pool, reg, sample, now);
    const fp = await fingerprint(pool);
    report[label] = { cold, warm, result: fp };
    console.log(`\n[${label}] ${href}`);
    console.table({ cold, warm });
    console.log(`result: ${fp.matches} matches, ${fp.refs} refs, ${fp.notifications} notifications, fingerprint ${fp.hash}`);
  } finally {
    await pool.end();
    if (!KEEP) await dropDb(name);
  }
}
if (!KEEP) await dropDb(`${PREFIX}_base`);
console.log('\n' + JSON.stringify(report));
