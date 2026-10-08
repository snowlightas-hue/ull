// npm run bench:generate -- [--n 1000000] [--seed 20261008] [--history-days 120] [--batch 10000] [--parallel 3]
//
// Builds a dedicated benchmark database `ultralink_bench` (cloned from ultralink_template, then the real
// migrations + reference sync) and fills it with N synthetic-but-realistic intents:
//   * skew: most intents in a few cities (Aleppo, Azaz, Idlib, Gaziantep, Istanbul…), long tail elsewhere
//   * sides: providers ~60 %, seekers ~35 %, peers (join) ~5 %
//   * prices in USD/TRY/SYP/EUR with several units (month, year, day, hour, session, person, total)
//   * a lifecycle: older intents are expired/closed/fulfilled, recent ones mostly active (partial indexes
//     only hold active rows, exactly like production)
//   * intent_refs for every intent and intent_scopes for ACTIVE intents with the same semantics as
//     src/repo/intents.ts#refreshScopes (scope places; root place when the scope is empty or preferred)
//   * matches + match_refs between compatible active intents, notifications, a few contact requests
// Rows are written with multi-row INSERT … SELECT FROM unnest($arrays) (one statement per batch).
// Never touches the app database.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../src/db/migrate.ts';
import { ROOT } from '../src/lib/env.ts';
import { loadRegistry, syncReference } from '../src/seed/reference.ts';
import type { Registry } from '../src/domain/registry.ts';
import type { PriceUnit } from '../src/domain/types.ts';
import { BENCH_DB, argInt, argValue, between, dbUrl, insertRows, pick, rng, weighted, withAdmin, type Col } from './lib.ts';

const N = argInt('n', 1_000_000);
const SEED = argInt('seed', 20261008);
const HISTORY_DAYS = argInt('history-days', 120);
const BATCH = argInt('batch', 10_000);
const PAR = Math.max(1, argInt('parallel', 3));
const DB = argValue('db', BENCH_DB)!;
const DAY = 86_400_000;

// ───────────── distributions ─────────────
const POINT_WEIGHTS: [string, number][] = [
  ['sy.aleppo.aleppo', 22], ['sy.aleppo.azaz', 14], ['sy.idlib.idlib', 10], ['tr.gaziantep', 8], ['tr.istanbul', 6],
  ['sy.aleppo.afrin', 5], ['sy.aleppo.al_bab', 4], ['sy.idlib.sarmada', 3], ['sy.idlib.dana', 3], ['sy.damascus.damascus', 3],
];
const TAIL_WEIGHT = 0.5; // every other leaf place
const REGIONS = ['sy.aleppo', 'sy.idlib', 'tr', 'sy', 'tr.hatay'];

const EXCHANGE_VERTICALS: [string, number][] = [['real_estate', 30], ['vehicles', 26], ['services', 18], ['goods', 16], ['education', 8], ['help', 2]];
const CATS: Record<string, [string, number][]> = {
  real_estate: [['real_estate.apartment', 60], ['real_estate.villa', 8], ['real_estate.room', 12], ['real_estate.shop', 10], ['real_estate.land', 10]],
  vehicles: [['vehicles.car', 75], ['vehicles.motorcycle', 15], ['vehicles.truck', 10]],
  services: [['services.appliance_repair', 16], ['services.plumbing', 12], ['services.electrical', 14], ['services.cleaning', 10], ['services.moving', 8], ['services.construction', 16], ['services.car_repair', 14], ['services.it_repair', 10]],
  goods: [['goods.electronics', 40], ['goods.furniture', 25], ['goods.appliances', 20], ['goods.clothing', 15]],
  education: [['education.tutoring', 75], ['education.skills', 25]],
  help: [['help.general', 1]],
  activities: [['activities.trip', 30], ['activities.sports', 35], ['activities.study_group', 15], ['activities.social', 20]],
};
const DEAL_WEIGHTS: Record<string, [string, number][]> = {
  real_estate: [['rent', 60], ['sale', 40]],
  vehicles: [['sale', 80], ['rent', 20]],
};
const PRICE: Record<string, { unit: PriceUnit; lo: number; hi: number; w: number }[]> = {
  'real_estate.apartment:rent': [{ unit: 'month', lo: 80, hi: 500, w: 9 }, { unit: 'year', lo: 900, hi: 5000, w: 1 }],
  'real_estate.apartment:sale': [{ unit: 'total', lo: 8000, hi: 150000, w: 1 }],
  'real_estate.villa:rent': [{ unit: 'month', lo: 250, hi: 1500, w: 1 }],
  'real_estate.villa:sale': [{ unit: 'total', lo: 40000, hi: 400000, w: 1 }],
  'real_estate.room:rent': [{ unit: 'month', lo: 40, hi: 200, w: 1 }],
  'real_estate.shop:rent': [{ unit: 'month', lo: 100, hi: 1200, w: 1 }],
  'real_estate.shop:sale': [{ unit: 'total', lo: 15000, hi: 200000, w: 1 }],
  'real_estate.land:rent': [{ unit: 'year', lo: 300, hi: 5000, w: 1 }],
  'real_estate.land:sale': [{ unit: 'total', lo: 3000, hi: 250000, w: 1 }],
  'vehicles.car:sale': [{ unit: 'total', lo: 1500, hi: 40000, w: 1 }],
  'vehicles.car:rent': [{ unit: 'day', lo: 15, hi: 80, w: 3 }, { unit: 'month', lo: 300, hi: 1200, w: 1 }],
  'vehicles.motorcycle:sale': [{ unit: 'total', lo: 250, hi: 3500, w: 1 }],
  'vehicles.motorcycle:rent': [{ unit: 'day', lo: 5, hi: 25, w: 1 }],
  'vehicles.truck:sale': [{ unit: 'total', lo: 4000, hi: 60000, w: 1 }],
  'vehicles.truck:rent': [{ unit: 'day', lo: 30, hi: 150, w: 1 }],
  'services:service': [{ unit: 'session', lo: 5, hi: 100, w: 2 }, { unit: 'hour', lo: 3, hi: 30, w: 1 }],
  'education:lesson': [{ unit: 'hour', lo: 3, hi: 30, w: 3 }, { unit: 'month', lo: 30, hi: 200, w: 1 }, { unit: 'session', lo: 3, hi: 25, w: 1 }],
  'goods.electronics:sale': [{ unit: 'total', lo: 40, hi: 2000, w: 1 }],
  'goods.furniture:sale': [{ unit: 'total', lo: 30, hi: 1500, w: 1 }],
  'goods.appliances:sale': [{ unit: 'total', lo: 40, hi: 900, w: 1 }],
  'goods.clothing:sale': [{ unit: 'total', lo: 3, hi: 120, w: 1 }],
  'activities:activity': [{ unit: 'person', lo: 1, hi: 40, w: 1 }],
};
const CURRENCIES: [string, number][] = [['USD', 60], ['TRY', 25], ['SYP', 10], ['EUR', 5]];
const FX: Record<string, number> = { USD: 1, TRY: 34, SYP: 13000, EUR: 0.92 };
const MAKES = ['kia', 'hyundai', 'toyota', 'mercedes', 'bmw', 'opel', 'volkswagen', 'chevrolet', 'nissan', 'honda', 'ford', 'peugeot', 'renault', 'skoda', 'suzuki', 'mitsubishi', 'mazda', 'fiat'];
const APPLIANCES = ['washing_machine', 'fridge', 'ac', 'oven', 'tv', 'water_heater'];
const SUBJECTS = ['math', 'physics', 'chemistry', 'biology', 'arabic', 'english', 'turkish', 'french', 'programming', 'quran'];
const LEVELS = ['primary', 'middle', 'secondary', 'university'];
const WHEN_LABELS = ['يوم الجمعة', 'يوم السبت', 'مساء الخميس', 'الأسبوع القادم', 'صباح الأحد'];

const niceRound = (x: number) => (x < 100 ? Math.max(1, Math.round(x)) : x < 1000 ? Math.round(x / 5) * 5 : x < 100_000 ? Math.round(x / 50) * 50 : Math.round(x / 1000) * 1000);

interface Ctx {
  reg: Registry; r: () => number; now: number; users: number; dealers: number;
  pointChoices: [number, number][]; regionIds: number[]; rootId: number; onlineId: number;
  catIds: Map<string, number>; dealIds: Map<string, number>;
}

// per-intent facts kept in memory for the match/notification phase
interface Facts {
  vertical: Int16Array; user: Int32Array; created: Float64Array; side: Uint8Array; status: Uint8Array; key: Int32Array;
}
const SIDE_CODE = { seek: 0, provide: 1, join: 2 } as const;
const STATUS_CODE = { active: 0, paused: 1, fulfilled: 2, closed: 3, expired: 4 } as const;

function genIntent(ctx: Ctx, id: number, facts: Facts): { intent: unknown[]; ref: unknown[]; scopes: unknown[][] } {
  const { r, reg, now } = ctx;
  // age: denser towards "now" (a growing product); t in [0,1) follows insertion order
  const t = (id - 1) / N;
  const created = now - HISTORY_DAYS * DAY * Math.pow(1 - t, 1.5) - r() * 3_600_000;
  const sideRoll = r();
  const side: 'seek' | 'provide' | 'join' = sideRoll < 0.6 ? 'provide' : sideRoll < 0.95 ? 'seek' : 'join';
  const vertical = side === 'join' ? 'activities' : weighted(r, EXCHANGE_VERTICALS);
  let catCode = weighted(r, CATS[vertical]!);
  if (side === 'seek' && r() < 0.08) catCode = vertical; // "any vehicle" style seekers use the parent category
  const cat = reg.categoryByCode.get(catCode)!;
  const deal = DEAL_WEIGHTS[vertical] ? weighted(r, DEAL_WEIGHTS[vertical]!.filter(([d]) => cat.deals.includes(d as never))) : cat.deals[0]!;
  const dealId = ctx.dealIds.get(deal)!;
  const user = side === 'provide' && ['real_estate', 'vehicles', 'goods'].includes(vertical) && r() < 0.2
    ? 1 + Math.floor(ctx.dealers * Math.pow(r(), 2))
    : ctx.dealers + 1 + Math.floor((ctx.users - ctx.dealers) * Math.pow(r(), 1.7));

  // ── places
  const city = () => (vertical === 'education' && r() < 0.15 ? ctx.onlineId : weighted(r, ctx.pointChoices));
  let point: number | null = null;
  let scope: number[] = [];
  let scopeStrength: 'required' | 'preferred' = 'required';
  if (side === 'provide') {
    point = r() < 0.95 ? city() : null;
    if (vertical === 'services' && r() < 0.25) scope = [pick(r, ctx.regionIds)];
  } else if (side === 'seek') {
    point = r() < 0.3 ? city() : null;
    const s = r();
    if (s < 0.55) scope = [point ?? city()];
    else if (s < 0.70) scope = [pick(r, ctx.regionIds)];
    else if (s < 0.75) scope = [...new Set([city(), city()])];
    else if (s < 0.85) { scope = [point ?? city()]; scopeStrength = 'preferred'; }
  } else {
    point = city();
    const s = r();
    if (s < 0.5) scope = [point];
    else if (s < 0.7) scope = [pick(r, ctx.regionIds)];
  }
  const exclude = side === 'seek' && r() < 0.02 ? [weighted(r, ctx.pointChoices)] : [];

  // ── when (peers)
  let whenFrom: number | null = null;
  let whenTo: number | null = null;
  if (side === 'join') {
    whenFrom = Math.floor((created + between(r, 1, 30) * DAY) / 3_600_000) * 3_600_000 + between(r, 8, 20) * 3_600_000;
    whenTo = whenFrom + between(r, 2, 8) * 3_600_000;
  }

  // ── lifecycle
  const validUntil = side === 'join' ? whenTo! + DAY : created + (side === 'provide' ? 60 : 30) * DAY;
  let status: keyof typeof STATUS_CODE;
  let closedAt: number | null = null;
  if (validUntil <= now) {
    status = weighted(r, [['expired', 60], ['closed', 22], ['fulfilled', 18]] as const);
    closedAt = status === 'expired' ? validUntil : created + r() * (validUntil - created);
  } else {
    status = weighted(r, [['active', 86], ['paused', 5], ['fulfilled', 5], ['closed', 4]] as const);
    if (status === 'fulfilled' || status === 'closed') closedAt = created + r() * (now - created);
  }
  const version = 1 + (status === 'active' ? 0 : 1) + (r() < 0.1 ? 1 : 0);
  const updated = closedAt ?? (version > 1 ? created + r() * (now - created) : created);

  // ── price (minor units, BIGINT)
  let price: { op: string; lo: string | null; hi: string | null; cur: string; unit: string; strength: string; neg: boolean } | null = null;
  const hasPrice = side === 'provide' ? r() < 0.85 : side === 'seek' ? r() < 0.7 : r() < 0.3;
  if (hasPrice && vertical !== 'help') {
    const baseCode = cat.descendants.length > 1 && !PRICE[`${catCode}:${deal}`] ? reg.categoryById.get(cat.descendants.find((d) => d !== cat.id)!)!.code : catCode;
    const options = PRICE[`${baseCode}:${deal}`] ?? PRICE[`${vertical}:${deal}`];
    if (options) {
      const o = weighted(r, options.map((x) => [x, x.w] as const));
      const cur = weighted(r, CURRENCIES);
      const usd = o.lo + Math.pow(r(), 1.8) * (o.hi - o.lo);
      const amount = BigInt(niceRound(usd * FX[cur]!)) * 100n;
      if (side === 'provide') price = { op: 'eq', lo: String(amount), hi: String(amount), cur, unit: o.unit, strength: 'required', neg: r() < 0.3 };
      else {
        const k = r();
        if (k < 0.6) price = { op: 'lte', lo: null, hi: String((amount * BigInt(between(r, 90, 140))) / 100n), cur, unit: o.unit, strength: r() < 0.8 ? 'required' : 'preferred', neg: false };
        else if (k < 0.85) price = { op: 'between', lo: String((amount * 60n) / 100n), hi: String((amount * 120n) / 100n), cur, unit: o.unit, strength: 'required', neg: false };
        else price = { op: 'approx', lo: String(amount), hi: String(amount), cur, unit: o.unit, strength: 'preferred', neg: false };
      }
    }
  }

  // ── attributes (owner facts) and constraints (on the counterpart)
  const attrs: Record<string, unknown> = {};
  const cons: Record<string, unknown>[] = [];
  const req = () => (r() < 0.5 ? 'required' : 'preferred');
  if (vertical === 'real_estate') {
    if (side === 'provide') {
      if (['real_estate.apartment', 'real_estate.villa', 'real_estate.room'].includes(catCode)) {
        attrs.rooms = catCode === 'real_estate.room' ? 1 : between(r, 1, 6);
        attrs.floor = between(r, 0, 8);
        attrs.furnished = r() < 0.35;
      } else attrs.area_m2 = between(r, 30, 2000);
    } else {
      if (r() < 0.5) cons.push({ key: 'rooms', op: 'gte', value: between(r, 1, 4), strength: req() });
      if (r() < 0.2) cons.push({ key: 'furnished', op: 'eq', value: true, strength: 'preferred', weight: 2 });
      if (r() < 0.15) cons.push({ key: 'floor', op: 'lte', value: between(r, 0, 3), strength: 'preferred', weight: 1 });
    }
  } else if (vertical === 'vehicles') {
    if (side === 'provide') { attrs.make = pick(r, MAKES); attrs.year = between(r, 1998, 2025); attrs.mileage_km = between(r, 0, 400) * 1000; }
    else {
      if (r() < 0.35) cons.push({ key: 'make', op: 'eq', value: pick(r, MAKES), strength: req() });
      if (r() < 0.25) cons.push({ key: 'year', op: 'gte', value: between(r, 2005, 2020), strength: 'preferred', weight: 2 });
    }
  } else if (catCode === 'services.appliance_repair') {
    if (side === 'provide') attrs.appliance = [...new Set([pick(r, APPLIANCES), pick(r, APPLIANCES)])];
    else cons.push({ key: 'appliance', op: 'eq', value: pick(r, APPLIANCES), strength: 'required' });
  } else if (vertical === 'services') {
    if (r() < 0.4) attrs.home_visit = r() < 0.7;
  } else if (vertical === 'education') {
    if (side === 'provide') { attrs.subject = [...new Set([pick(r, SUBJECTS), pick(r, SUBJECTS)])]; attrs.level = pick(r, LEVELS); attrs.mode = point === ctx.onlineId ? 'online' : 'in_person'; }
    else {
      if (r() < 0.8) cons.push({ key: 'subject', op: 'eq', value: pick(r, SUBJECTS), strength: 'required' });
      if (r() < 0.3) cons.push({ key: 'level', op: 'eq', value: pick(r, LEVELS), strength: 'preferred', weight: 2 });
    }
  } else if (vertical === 'goods') {
    if (side === 'provide') attrs.condition = r() < 0.7 ? 'used' : 'new';
    else if (r() < 0.3) cons.push({ key: 'condition', op: 'eq', value: r() < 0.5 ? 'used' : 'new', strength: 'preferred', weight: 1 });
  } else if (vertical === 'activities') {
    attrs.group_size = between(r, 2, 20);
  }
  if (exclude.length) cons.push({ key: '__exclude_places', op: 'in', values: exclude, strength: 'required' });

  const placeName = (p: number | null) => (p == null ? 'مكان غير محدد' : reg.placeById.get(p)!.nameAr);
  const title = `${side === 'seek' ? 'مطلوب' : side === 'provide' ? 'معروض' : 'نشاط'}: ${cat.nameAr} — ${placeName(point ?? scope[0] ?? null)}`;
  const scopeIds = scope.filter((p) => p !== ctx.rootId);

  facts.vertical[id] = cat.verticalId;
  facts.user[id] = user;
  facts.created[id] = created;
  facts.side[id] = SIDE_CODE[side];
  facts.status[id] = STATUS_CODE[status];
  facts.key[id] = cat.id * 16 + dealId;

  const publicId = randomUUID();
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  const intent = [
    id, cat.verticalId, publicId, user, 'real', side, cat.id, dealId, status, version, title,
    point, point == null ? null : reg.placeById.get(point)!.lft, scopeStrength, `{${scopeIds.join(',')}}`,
    price?.op ?? null, price?.lo ?? null, price?.hi ?? null, price?.cur ?? null, price?.unit ?? null, price?.strength ?? null, price?.neg ?? false,
    whenFrom == null ? null : `[${iso(whenFrom)},${iso(whenTo)})`, whenFrom == null ? null : r() < 0.7 ? 'required' : 'preferred', whenFrom == null ? null : pick(r, WHEN_LABELS),
    JSON.stringify(attrs), JSON.stringify(cons), iso(validUntil), iso(created), iso(updated), iso(closedAt),
  ];
  const ref = [publicId, cat.verticalId, id, user];
  const scopes: unknown[][] = [];
  if (status === 'active') {
    // same semantics as refreshScopes(): scope places; root when the scope is empty or merely preferred
    const places = new Set<number>(scopeIds);
    if (!places.size || scopeStrength === 'preferred') places.add(ctx.rootId);
    for (const p of places) scopes.push([cat.verticalId, id, 'real', side, dealId, cat.id, p]);
  }
  return { intent, ref, scopes };
}

const INTENT_COLS: Col[] = [
  { name: 'id', type: 'bigint' }, { name: 'vertical_id', type: 'smallint' }, { name: 'public_id', type: 'uuid' }, { name: 'user_id', type: 'bigint' },
  { name: 'realm', type: 'text' }, { name: 'side', type: 'text' }, { name: 'category_id', type: 'int' }, { name: 'deal_type_id', type: 'smallint' },
  { name: 'status', type: 'text' }, { name: 'version', type: 'int' }, { name: 'title_ar', type: 'text' },
  { name: 'point_place_id', type: 'int' }, { name: 'point_lft', type: 'int' }, { name: 'scope_strength', type: 'text' }, { name: 'scope_place_ids', type: 'text', cast: 'int[]' },
  { name: 'price_op', type: 'text' }, { name: 'price_lo', type: 'bigint' }, { name: 'price_hi', type: 'bigint' }, { name: 'currency', type: 'text' },
  { name: 'price_unit', type: 'text' }, { name: 'price_strength', type: 'text' }, { name: 'negotiable', type: 'bool' },
  { name: 'when_range', type: 'text', cast: 'tstzrange' }, { name: 'when_strength', type: 'text' }, { name: 'when_label_ar', type: 'text' },
  { name: 'attrs', type: 'text', cast: 'jsonb' }, { name: 'constraints', type: 'text', cast: 'jsonb' },
  { name: 'expires_at', type: 'timestamptz' }, { name: 'created_at', type: 'timestamptz' }, { name: 'updated_at', type: 'timestamptz' }, { name: 'closed_at', type: 'timestamptz' },
];
const REF_COLS: Col[] = [{ name: 'public_id', type: 'uuid' }, { name: 'vertical_id', type: 'smallint' }, { name: 'intent_id', type: 'bigint' }, { name: 'user_id', type: 'bigint' }];
const SCOPE_COLS: Col[] = [
  { name: 'vertical_id', type: 'smallint' }, { name: 'intent_id', type: 'bigint' }, { name: 'realm', type: 'text' }, { name: 'side', type: 'text' },
  { name: 'deal_type_id', type: 'smallint' }, { name: 'category_id', type: 'int' }, { name: 'place_id', type: 'int' },
];
const MATCH_COLS: Col[] = [
  { name: 'id', type: 'bigint' }, { name: 'public_id', type: 'uuid' }, { name: 'vertical_id', type: 'smallint' }, { name: 'kind', type: 'text' },
  { name: 'a_intent_id', type: 'bigint' }, { name: 'b_intent_id', type: 'bigint' }, { name: 'a_user_id', type: 'bigint' }, { name: 'b_user_id', type: 'bigint' },
  { name: 'state', type: 'text' }, { name: 'score', type: 'int' }, { name: 'reasons', type: 'text', cast: 'jsonb' }, { name: 'missing', type: 'text', cast: 'jsonb' },
  { name: 'a_version', type: 'int' }, { name: 'b_version', type: 'int' }, { name: 'eval_seq', type: 'bigint' }, { name: 'invalid_reason_ar', type: 'text' },
  { name: 'first_matched_at', type: 'timestamptz' }, { name: 'updated_at', type: 'timestamptz' },
];
const MREF_COLS: Col[] = [{ name: 'public_id', type: 'uuid' }, { name: 'vertical_id', type: 'smallint' }, { name: 'match_id', type: 'bigint' }];
const NOTIF_COLS: Col[] = [
  { name: 'recipient_id', type: 'bigint' }, { name: 'kind', type: 'text' }, { name: 'title_ar', type: 'text' }, { name: 'body_ar', type: 'text' },
  { name: 'payload', type: 'text', cast: 'jsonb' }, { name: 'dedupe_key', type: 'text' }, { name: 'created_at', type: 'timestamptz' }, { name: 'read_at', type: 'timestamptz' },
];
const CONTACT_COLS: Col[] = [
  { name: 'vertical_id', type: 'smallint' }, { name: 'match_id', type: 'bigint' }, { name: 'requester_id', type: 'bigint' }, { name: 'recipient_id', type: 'bigint' },
  { name: 'status', type: 'text' }, { name: 'created_at', type: 'timestamptz' }, { name: 'responded_at', type: 'timestamptz' },
];

/** Run async jobs with bounded concurrency. */
async function pooled<T>(items: Iterable<T>, par: number, fn: (x: T) => Promise<void>): Promise<void> {
  const it = items[Symbol.iterator]();
  const workers = Array.from({ length: par }, async () => {
    for (let n = it.next(); !n.done; n = it.next()) await fn(n.value);
  });
  await Promise.all(workers);
}

function* range(from: number, to: number, step: number): Generator<[number, number]> {
  for (let a = from; a <= to; a += step) yield [a, Math.min(to, a + step - 1)];
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const lap = (k: string, since: number) => { timings[k] = Date.now() - since; return Date.now(); };
  console.log(`bench:generate n=${N} seed=${SEED} history=${HISTORY_DAYS}d batch=${BATCH} parallel=${PAR} db=${DB}`);

  // 1) fresh database from the template + real migrations + reference data
  let t = Date.now();
  await withAdmin(async (a) => {
    await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await a.query(`CREATE DATABASE ${DB} TEMPLATE ultralink_template`);
  });
  const pool = new pg.Pool({ connectionString: dbUrl(DB), max: PAR + 1 });
  await migrate(pool, (s) => console.log(`  ${s}`));
  await syncReference(pool);
  const reg = await loadRegistry(pool);
  t = lap('create_db_migrate_reference', t);

  const r = rng(SEED);
  const now = Date.now();
  const users = Math.max(1000, Math.round(N / 6));
  const dealers = Math.max(10, Math.round(users / 800));
  const leafPlaces = reg.places.filter((p) => p.kind !== 'world' && p.kind !== 'country' && p.kind !== 'virtual' && !reg.places.some((c) => c.parent === p.code));
  const heavy = new Map(POINT_WEIGHTS.map(([c, w]) => [reg.placeByCode.get(c)!.id, w] as const));
  const ctx: Ctx = {
    reg, r, now, users, dealers,
    pointChoices: leafPlaces.map((p) => [p.id, heavy.get(p.id) ?? TAIL_WEIGHT] as [number, number]),
    regionIds: REGIONS.map((c) => reg.placeByCode.get(c)!.id),
    rootId: reg.rootPlaceId,
    onlineId: reg.placeByCode.get('online')!.id,
    catIds: new Map(reg.categories.map((c) => [c.code, c.id])),
    dealIds: new Map(reg.deals.map((d) => [d.code, d.id])),
  };

  // 2) users (dealers first)
  const userRows: unknown[][] = [];
  for (let u = 1; u <= users; u++) userRows.push([u, u <= dealers ? `تاجر ${u}` : `مستخدم ${u}`, 'real', new Date(now - HISTORY_DAYS * DAY - r() * 30 * DAY).toISOString()]);
  await pooled(range(0, users - 1, BATCH), PAR, async ([a, b]) => {
    await insertRows(pool, 'users', [{ name: 'id', type: 'bigint' }, { name: 'display_name', type: 'text' }, { name: 'realm', type: 'text' }, { name: 'created_at', type: 'timestamptz' }], userRows.slice(a, b + 1), { overriding: true });
  });
  await pool.query(`SELECT setval(pg_get_serial_sequence('users', 'id'), $1)`, [users]);
  t = lap('users', t);
  console.log(`  users: ${users} (${dealers} dealers) in ${timings.users} ms`);

  // 3) intents + intent_refs + intent_scopes (one connection per batch, bounded parallelism)
  const facts: Facts = {
    vertical: new Int16Array(N + 1), user: new Int32Array(N + 1), created: new Float64Array(N + 1),
    side: new Uint8Array(N + 1), status: new Uint8Array(N + 1), key: new Int32Array(N + 1),
  };
  let scopeRows = 0;
  let done = 0;
  // generate deterministically in order, insert in parallel
  const gen = function* () {
    for (const [a, b] of range(1, N, BATCH)) {
      const intents: unknown[][] = [];
      const refs: unknown[][] = [];
      const scopes: unknown[][] = [];
      for (let id = a; id <= b; id++) {
        const g = genIntent(ctx, id, facts);
        intents.push(g.intent);
        refs.push(g.ref);
        for (const s of g.scopes) scopes.push(s);
      }
      yield { intents, refs, scopes };
    }
  };
  await pooled(gen(), PAR, async (bt) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await insertRows(c, 'intents', INTENT_COLS, bt.intents);
      await insertRows(c, 'intent_refs', REF_COLS, bt.refs);
      await insertRows(c, 'intent_scopes', SCOPE_COLS, bt.scopes);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
    scopeRows += bt.scopes.length;
    done += bt.intents.length;
    if (done % (BATCH * 10) === 0 || done === N) console.log(`  intents ${done}/${N} (${Math.round(done / ((Date.now() - t) / 1000))}/s)`);
  });
  await pool.query(`SELECT setval('intents_id_seq', $1)`, [N]);
  t = lap('intents_refs_scopes', t);

  // 4) matches between compatible ACTIVE intents (+ match_refs, notifications, contact requests)
  const providersByKey = new Map<number, number[]>();
  const joinsByKey = new Map<number, number[]>();
  for (let id = 1; id <= N; id++) {
    if (facts.status[id] !== STATUS_CODE.active) continue;
    const m = facts.side[id] === SIDE_CODE.provide ? providersByKey : facts.side[id] === SIDE_CODE.join ? joinsByKey : null;
    if (!m) continue;
    const list = m.get(facts.key[id]!) ?? [];
    list.push(id);
    m.set(facts.key[id]!, list);
  }
  let matchId = 0;
  let evalSeq = 0;
  let notifCount = 0;
  let contactCount = 0;
  const reasonsJson = JSON.stringify([{ code: 'place_in_scope', polarity: 'plus', text: 'داخل المكان المطلوب', strength: 'required' }, { code: 'price_within_max', polarity: 'plus', text: 'ضمن السعر', strength: 'required' }]);
  const matchBatches: { m: unknown[][]; refs: unknown[][]; notes: unknown[][]; contacts: unknown[][] }[] = [];
  let cur = { m: [] as unknown[][], refs: [] as unknown[][], notes: [] as unknown[][], contacts: [] as unknown[][] };
  const iso = (ms: number) => new Date(ms).toISOString();
  for (let id = 1; id <= N; id++) {
    if (facts.status[id] !== STATUS_CODE.active || facts.side[id] === SIDE_CODE.provide) continue;
    if (r() >= 0.55) continue;
    const peer = facts.side[id] === SIDE_CODE.join;
    const pool2 = (peer ? joinsByKey : providersByKey).get(facts.key[id]!);
    if (!pool2 || pool2.length < 2) continue;
    const k = between(r, 1, 8);
    const chosen = new Set<number>();
    for (let j = 0; j < k * 2 && chosen.size < k; j++) {
      const o = pick(r, pool2);
      if (o === id || facts.user[o] === facts.user[id]) continue;
      if (peer && o < id) continue; // each peer pair once (a = lower id)
      chosen.add(o);
    }
    for (const o of chosen) {
      const [a, b] = peer ? [Math.min(id, o), Math.max(id, o)] : [id, o];
      const state = weighted(r, [['confirmed', 50], ['possible', 35], ['invalidated', 15]] as const);
      const score = state === 'confirmed' ? between(r, 5000, 10000) : state === 'possible' ? between(r, 0, 4999) : between(r, 0, 10000);
      const first = Math.min(now, Math.max(facts.created[a]!, facts.created[b]!) + r() * 2 * DAY);
      const mid = ++matchId;
      const pub = randomUUID();
      const v = facts.vertical[a]!;
      cur.m.push([mid, pub, v, peer ? 'peer' : 'exchange', a, b, facts.user[a], facts.user[b], state, score, reasonsJson, state === 'possible' ? '["price"]' : '[]', 1, 1, ++evalSeq,
        state === 'invalidated' ? 'لم تعد مطابقة' : null, iso(first), iso(first + (state === 'invalidated' ? r() * (now - first) : 0))]);
      cur.refs.push([pub, v, mid]);
      if (state !== 'invalidated') {
        for (const rcpt of [facts.user[a]!, facts.user[b]!]) {
          const age = now - first;
          cur.notes.push([rcpt, state === 'confirmed' ? 'match_new' : 'match_possible', state === 'confirmed' ? 'مطابقة جديدة مناسبة' : 'مطابقة محتملة تحتاج تأكيد',
            '«عرض» يناسب «طلب»', JSON.stringify({ matchId: pub, verticalId: v }), `match:${v}:${a}:${b}`, iso(first), r() < (age > 7 * DAY ? 0.9 : 0.4) ? iso(first + r() * Math.min(age, 3 * DAY)) : null]);
          notifCount++;
        }
        if (state === 'confirmed' && r() < 0.02) {
          const accepted = r() < 0.5;
          cur.contacts.push([v, mid, facts.user[a], facts.user[b], accepted ? 'accepted' : 'pending', iso(first), accepted ? iso(Math.min(now, first + DAY)) : null]);
          contactCount++;
        }
      }
      if (cur.m.length >= BATCH) { matchBatches.push(cur); cur = { m: [], refs: [], notes: [], contacts: [] }; }
    }
  }
  // expiry notifications (one per expired intent, like the worker's expire_sweep)
  for (let id = 1; id <= N; id++) {
    if (facts.status[id] !== STATUS_CODE.expired) continue;
    const at = facts.created[id]! + (facts.side[id] === SIDE_CODE.provide ? 60 : 30) * DAY;
    cur.notes.push([facts.user[id], 'intent_expired', 'انتهت صلاحية طلب', '«طلب» — يمكنك استئنافه من القائمة', JSON.stringify({ verticalId: facts.vertical[id] }), `expired:${facts.vertical[id]}:${id}:2`, iso(Math.min(now, at)), r() < 0.8 ? iso(Math.min(now, at + DAY)) : null]);
    notifCount++;
    if (cur.notes.length >= BATCH * 2) { matchBatches.push(cur); cur = { m: [], refs: [], notes: [], contacts: [] }; }
  }
  matchBatches.push(cur);
  t = lap('generate_matches_in_memory', t);
  // matches must exist before match_refs/contacts; notifications are independent
  await pooled(matchBatches, PAR, async (bt) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await insertRows(c, 'matches', MATCH_COLS, bt.m);
      await insertRows(c, 'match_refs', MREF_COLS, bt.refs);
      await insertRows(c, 'contact_requests', CONTACT_COLS, bt.contacts);
      for (let i = 0; i < bt.notes.length; i += BATCH) await insertRows(c, 'notifications', NOTIF_COLS, bt.notes.slice(i, i + BATCH));
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  });
  await pool.query(`SELECT setval('matches_id_seq', $1), setval('match_eval_seq', $2)`, [Math.max(1, matchId), Math.max(1, evalSeq)]);
  t = lap('matches_notifications', t);
  console.log(`  matches: ${matchId}, notifications: ${notifCount}, contact requests: ${contactCount} in ${timings.matches_notifications} ms`);

  // 5) VACUUM ANALYZE: planner statistics + visibility map (index-only scans), as autovacuum would in production
  await pool.query('VACUUM (ANALYZE)');
  t = lap('vacuum_analyze', t);

  const counts = (await pool.query(`
    SELECT (SELECT count(*) FROM intents)::int AS intents,
           (SELECT count(*) FROM intents WHERE status = 'active')::int AS active,
           (SELECT count(*) FROM intent_refs)::int AS intent_refs,
           (SELECT count(*) FROM intent_scopes)::int AS intent_scopes,
           (SELECT count(*) FROM matches)::int AS matches,
           (SELECT count(*) FROM notifications)::int AS notifications,
           (SELECT count(*) FROM users)::int AS users`)).rows[0];
  const bySide = (await pool.query(`SELECT side, count(*)::int AS n, round(100.0 * count(*) / sum(count(*)) OVER (), 1)::float AS pct FROM intents GROUP BY side ORDER BY side`)).rows;
  const byVertical = (await pool.query(`SELECT v.code, count(*)::int AS n FROM intents i JOIN verticals v ON v.id = i.vertical_id GROUP BY v.code ORDER BY n DESC`)).rows;
  const topPlaces = (await pool.query(`SELECT p.code, count(*)::int AS n FROM intents i JOIN places p ON p.id = i.point_place_id GROUP BY p.code ORDER BY n DESC LIMIT 8`)).rows;
  const byCurrency = (await pool.query(`SELECT currency, price_unit, count(*)::int AS n FROM intents WHERE currency IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`)).rows;
  const totalMs = Date.now() - t0;
  const summary = { params: { n: N, seed: SEED, historyDays: HISTORY_DAYS, batch: BATCH, parallel: PAR, db: DB }, counts, bySide, byVertical, topPlaces, byCurrency, timingsMs: timings, totalMs, intentRowsPerSec: Math.round(N / (timings.intents_refs_scopes! / 1000)), scopeRows };
  mkdirSync(join(ROOT, 'bench', 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'bench', 'results', 'generate.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
