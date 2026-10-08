// Shape and vocabulary checks for the hand-labeled corpus in test/corpus/*.json (Role 1), including the
// held-out set test/corpus/holdout-utterances.json.
// It validates labels against src/seed/taxonomy.ts only; it never runs the parser or the matcher.
// Run: node --test test/unit/corpus-shape.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ATTRIBUTES, CATEGORIES, DEALS, PLACES } from '../../src/seed/taxonomy.ts';
import type { AttrSeed } from '../../src/seed/taxonomy.ts';

type Json = any; // corpus files are untyped JSON; every field is checked below

const load = (name: string): Json => JSON.parse(readFileSync(new URL(`../corpus/${name}`, import.meta.url), 'utf8'));
const utterances: Json[] = load('utterances.json');
const dialogues: Json[] = load('dialogues.json');
const scenarios: Json[] = load('matching-scenarios.json');
const holdout: Json[] = load('holdout-utterances.json');

// ── vocabularies ──
const catByCode = new Map(CATEGORIES.map((c) => [c.code, c] as const));
const placeByCode = new Map(PLACES.map((p) => [p.code, p] as const));
const placeById = new Map(PLACES.map((p) => [p.id, p] as const));
const dealByCode = new Map(DEALS.map((d) => [d.code, d] as const));
const SIDES = ['seek', 'provide', 'join'];
const STRENGTHS = ['required', 'preferred'];
const CURRENCIES = ['USD', 'TRY', 'SYP', 'EUR'];
const UNITS = ['total', 'month', 'year', 'week', 'day', 'hour', 'session', 'person'];
const PRICE_OPS = ['eq', 'lte', 'gte', 'between', 'approx'];
const CONSTRAINT_OPS = ['eq', 'neq', 'lte', 'gte', 'between', 'in'];
const WEEKDAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const RELATIVE = ['today', 'tomorrow', 'next_week'];
const MUST_ASK_ORDER = ['side', 'category', 'deal', 'place', 'when', 'price', 'price.currency', 'price.unit'];
const EXPECT_ASK = [...MUST_ASK_ORDER, 'conflict'];
const REASON_CODES = [
  'place_in_scope', 'place_out_of_scope', 'place_pref_satisfied', 'place_pref_unsatisfied',
  'price_within_max', 'price_above_max', 'price_below_min', 'price_exact', 'price_not_exact', 'price_in_range', 'price_near',
  'currency_mismatch', 'unit_mismatch', 'price_unknown',
  'attr_satisfied', 'attr_violation', 'attr_unknown', 'pref_satisfied', 'pref_unsatisfied',
  'deal_mismatch', 'category_mismatch', 'side_mismatch', 'date_overlap', 'date_no_overlap', 'date_unknown',
];
const VERDICTS = ['match', 'possible', 'excluded'];
const VERTICALS = ['real_estate', 'vehicles', 'services', 'education', 'activities', 'goods', 'help'];
const UTTERANCE_KEYS = ['side', 'category', 'deal', 'places', 'price', 'when', 'attrs', 'constraints', 'mustAsk'];

// ── helpers ──
function categoryAncestors(code: string): string[] {
  const out: string[] = [];
  let cur = catByCode.get(code);
  while (cur) {
    out.push(cur.code);
    cur = cur.parent ? catByCode.get(cur.parent) : undefined;
  }
  return out;
}
function attributesFor(code: string): Map<string, AttrSeed> {
  const anc = new Set(categoryAncestors(code));
  return new Map(ATTRIBUTES.filter((a) => anc.has(a.category)).map((a) => [a.key, a] as const));
}
const isLeaf = (code: string) => !CATEGORIES.some((c) => c.parent === code);
const isMoney = (v: unknown) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
const isObj = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkAttrValue(def: AttrSeed, v: unknown, where: string, errs: string[]) {
  if (def.type === 'int') {
    if (typeof v !== 'number' || !Number.isInteger(v)) return void errs.push(`${where}: ${def.key} must be an integer, got ${JSON.stringify(v)}`);
    if (def.min != null && v < def.min) errs.push(`${where}: ${def.key}=${v} < min ${def.min}`);
    if (def.max != null && v > def.max) errs.push(`${where}: ${def.key}=${v} > max ${def.max}`);
  } else if (def.type === 'bool') {
    if (typeof v !== 'boolean') errs.push(`${where}: ${def.key} must be boolean`);
  } else if (def.type === 'enum') {
    if (typeof v !== 'string' || !(def.values ?? []).some((x) => x.code === v)) errs.push(`${where}: ${def.key}=${JSON.stringify(v)} is not an enum code`);
  } else if (typeof v !== 'string' || v.trim() === '') errs.push(`${where}: ${def.key} must be non-empty text`);
}

function checkAttrs(attrs: Json, category: string | null, where: string, errs: string[]) {
  if (!isObj(attrs)) return void errs.push(`${where}: attrs must be an object`);
  const keys = Object.keys(attrs);
  if (keys.length && !category) return void errs.push(`${where}: attrs without a category`);
  if (!category) return;
  const defs = attributesFor(category);
  for (const k of keys) {
    const def = defs.get(k);
    if (!def) errs.push(`${where}: attribute ${k} does not apply to ${category}`);
    else checkAttrValue(def, attrs[k], `${where}.attrs`, errs);
  }
}

function checkConstraints(list: Json, category: string | null, allowNullStrength: boolean, where: string, errs: string[]) {
  if (!Array.isArray(list)) return void errs.push(`${where}: constraints must be an array`);
  if (list.length && !category) return void errs.push(`${where}: constraints without a category`);
  const defs = category ? attributesFor(category) : new Map<string, AttrSeed>();
  list.forEach((c: Json, i: number) => {
    const w = `${where}.constraints[${i}]`;
    const def = defs.get(c?.key);
    if (!def) return void errs.push(`${w}: attribute ${c?.key} does not apply to ${category}`);
    if (!CONSTRAINT_OPS.includes(c.op)) return void errs.push(`${w}: bad op ${c.op}`);
    if (!(STRENGTHS.includes(c.strength) || (allowNullStrength && c.strength === null))) errs.push(`${w}: bad strength ${c.strength}`);
    if (c.op === 'in') {
      if (!Array.isArray(c.values) || c.values.length === 0) errs.push(`${w}: 'in' needs non-empty values`);
      else c.values.forEach((v: unknown) => checkAttrValue(def, v, w, errs));
    } else if (c.op === 'between') {
      if (def.type !== 'int') errs.push(`${w}: between needs an int attribute`);
      if (typeof c.lo !== 'number' || typeof c.hi !== 'number' || c.lo > c.hi) errs.push(`${w}: between needs numeric lo<=hi`);
    } else {
      if ((c.op === 'lte' || c.op === 'gte') && def.type !== 'int') errs.push(`${w}: ${c.op} needs an int attribute`);
      checkAttrValue(def, c.value, w, errs);
    }
  });
}

/** Price: op/lo/hi consistency; money is an integer string; lo<=hi compared as BigInt. */
function checkPrice(p: Json, where: string, errs: string[], withStrength: boolean) {
  if (p === null) return;
  if (!isObj(p)) return void errs.push(`${where}: price must be an object or null`);
  if (!PRICE_OPS.includes(p.op as string)) errs.push(`${where}: bad price op ${p.op}`);
  for (const k of ['lo', 'hi'] as const) if (p[k] !== null && !isMoney(p[k])) errs.push(`${where}: price.${k}=${JSON.stringify(p[k])} is not an integer minor-units string`);
  if (p.currency !== null && !CURRENCIES.includes(p.currency as string)) errs.push(`${where}: bad currency ${p.currency}`);
  if (p.unit !== null && !UNITS.includes(p.unit as string)) errs.push(`${where}: bad unit ${p.unit}`);
  const lo = isMoney(p.lo) ? BigInt(p.lo as string) : null;
  const hi = isMoney(p.hi) ? BigInt(p.hi as string) : null;
  if (lo !== null && hi !== null && lo > hi) errs.push(`${where}: price lo > hi`);
  const shape: Record<string, boolean> = {
    eq: lo !== null && hi !== null && lo === hi,
    approx: lo !== null && hi !== null && lo === hi,
    lte: p.lo === null && hi !== null,
    gte: lo !== null && p.hi === null,
    between: lo !== null && hi !== null && lo < hi,
  };
  if (shape[p.op as string] === false) errs.push(`${where}: lo/hi do not fit op ${p.op}`);
  if (withStrength) {
    if (!STRENGTHS.includes(p.strength as string)) errs.push(`${where}: price.strength must be required|preferred`);
    if (p.op === 'approx' && p.strength !== 'preferred') errs.push(`${where}: approx price must be preferred`);
  }
}

/**
 * The `expected` / `final` label shape used by utterances.json and dialogues.json.
 * `accepted`: fields the user said they do not know (dialogues); they stay null and are never re-asked.
 */
function checkExpected(e: Json, where: string, errs: string[], accepted: Set<string> = new Set()) {
  if (!isObj(e)) return void errs.push(`${where}: expected must be an object`);
  for (const k of UTTERANCE_KEYS) if (!(k in e)) errs.push(`${where}: missing key ${k}`);
  for (const k of Object.keys(e)) if (!UTTERANCE_KEYS.includes(k)) errs.push(`${where}: unknown key ${k}`);
  if (e.side !== null && !SIDES.includes(e.side)) errs.push(`${where}: bad side ${e.side}`);
  const cat = e.category === null ? null : catByCode.get(e.category);
  if (e.category !== null && !cat) errs.push(`${where}: unknown category ${e.category}`);
  if (e.deal !== null && !dealByCode.has(e.deal)) errs.push(`${where}: unknown deal ${e.deal}`);
  if (cat && e.deal !== null && !cat.deals.includes(e.deal)) errs.push(`${where}: deal ${e.deal} not allowed for ${cat.code}`);
  if (cat && cat.deals.length === 1 && e.deal !== cat.deals[0]) errs.push(`${where}: single-deal category ${cat.code} must carry deal ${cat.deals[0]}`);
  if (e.side === 'join' && e.deal !== null && e.deal !== 'activity') errs.push(`${where}: join side needs deal activity`);
  if (e.deal === 'activity' && e.side !== null && e.side !== 'join') errs.push(`${where}: activity deal needs side join`);
  if (!Array.isArray(e.places)) errs.push(`${where}: places must be an array`);
  else e.places.forEach((p: Json, i: number) => {
    if (!placeByCode.has(p?.code)) errs.push(`${where}.places[${i}]: unknown place ${p?.code}`);
    if (!(p?.strength === null || STRENGTHS.includes(p?.strength))) errs.push(`${where}.places[${i}]: bad strength`);
    if (typeof p?.negated !== 'boolean') errs.push(`${where}.places[${i}]: negated must be boolean`);
  });
  checkPrice(e.price, `${where}.price`, errs, false);
  if (e.when !== null) {
    const ok = isObj(e.when) && Object.keys(e.when).length === 1 &&
      (WEEKDAYS.includes(e.when.weekday as string) || RELATIVE.includes(e.when.relative as string));
    if (!ok) errs.push(`${where}: bad when ${JSON.stringify(e.when)}`);
  }
  checkAttrs(e.attrs, e.category, where, errs);
  checkConstraints(e.constraints, e.category, true, where, errs);
  // mustAsk: known fields, no duplicates, canonical question order, and consistent with the other labels
  if (!Array.isArray(e.mustAsk)) return void errs.push(`${where}: mustAsk must be an array`);
  const idx = e.mustAsk.map((f: string) => MUST_ASK_ORDER.indexOf(f));
  if (idx.some((i: number) => i < 0)) errs.push(`${where}: unknown mustAsk field in ${JSON.stringify(e.mustAsk)}`);
  if (idx.some((v: number, i: number) => i > 0 && v <= idx[i - 1])) errs.push(`${where}: mustAsk not unique/in canonical order ${JSON.stringify(e.mustAsk)}`);
  const asks = new Set<string>(e.mustAsk);
  const hasPlace = Array.isArray(e.places) && e.places.some((p: Json) => !p.negated);
  if (asks.has('side') !== (e.side === null) && !(e.side === null && e.category === null && e.mustAsk.length === 0)) errs.push(`${where}: 'side' in mustAsk must mirror side===null`);
  if (asks.has('deal') && e.deal !== null) errs.push(`${where}: asks deal but deal is labeled`);
  if (cat && e.deal === null && cat.deals.length > 1 && !asks.has('deal')) errs.push(`${where}: deal missing for multi-deal category but not asked`);
  if (asks.has('category') && cat && isLeaf(cat.code)) errs.push(`${where}: asks category but a leaf category is labeled`);
  if (asks.has('place') && hasPlace) errs.push(`${where}: asks place but a place is labeled`);
  if (!asks.has('place') && !hasPlace && e.mustAsk.length > 0) errs.push(`${where}: no place labeled but place not asked`);
  if (asks.has('when') && e.when !== null) errs.push(`${where}: asks when but when is labeled`);
  if (cat && cat.code.startsWith('activities') && e.when === null && !asks.has('when') && !accepted.has('when')) errs.push(`${where}: activity without date must ask when`);
  if (asks.has('price') && e.price !== null) errs.push(`${where}: asks price but price is labeled`);
  if (e.side === 'provide' && (e.deal === 'sale' || e.deal === 'rent') && e.price === null && !asks.has('price') && !accepted.has('price')) errs.push(`${where}: provider sale/rent offer without price must ask price`);
  const zero = e.price?.lo === '0' && e.price?.hi === '0';
  if (asks.has('price.currency') !== (e.price !== null && e.price.currency === null && !zero)) errs.push(`${where}: 'price.currency' in mustAsk must mirror an amount without currency`);
  if (asks.has('price.unit') !== (e.price !== null && e.price.unit === null && e.deal === 'rent' && !zero)) errs.push(`${where}: 'price.unit' in mustAsk must mirror a rent amount without period`);
  if (e.price && e.deal === 'sale' && e.price.unit !== 'total') errs.push(`${where}: a sale price is a total`);
}

function checkSpec(s: Json, where: string, errs: string[]) {
  if (!isObj(s)) return void errs.push(`${where}: IntentSpec must be an object`);
  const allowed = ['side', 'categoryCode', 'deal', 'place', 'price', 'when', 'attrs', 'constraints', 'notes'];
  for (const k of allowed.slice(0, 8)) if (!(k in s)) errs.push(`${where}: missing ${k}`);
  for (const k of Object.keys(s)) if (!allowed.includes(k)) errs.push(`${where}: unknown key ${k}`);
  if (!SIDES.includes(s.side as string)) errs.push(`${where}: bad side`);
  const cat = catByCode.get(s.categoryCode as string);
  if (!cat) errs.push(`${where}: unknown category ${s.categoryCode}`);
  if (!dealByCode.has(s.deal as never)) errs.push(`${where}: unknown deal ${s.deal}`);
  if (cat && !cat.deals.includes(s.deal as never)) errs.push(`${where}: deal ${s.deal} not allowed for ${cat.code}`);
  if ((s.side === 'join') !== (dealByCode.get(s.deal as never)?.relation === 'peer')) errs.push(`${where}: join side iff peer deal`);
  const pl = s.place as Json;
  if (!isObj(pl)) errs.push(`${where}: place must be an object`);
  else {
    if (!(pl.pointPlaceId === null || placeById.has(pl.pointPlaceId))) errs.push(`${where}: unknown pointPlaceId ${pl.pointPlaceId}`);
    if (!Array.isArray(pl.scopePlaceIds) || pl.scopePlaceIds.some((id: number) => !placeById.has(id))) errs.push(`${where}: bad scopePlaceIds`);
    if (!STRENGTHS.includes(pl.scopeStrength)) errs.push(`${where}: bad scopeStrength`);
    if (pl.excludePlaceIds !== undefined && (!Array.isArray(pl.excludePlaceIds) || pl.excludePlaceIds.some((id: number) => !placeById.has(id)))) errs.push(`${where}: bad excludePlaceIds`);
    for (const k of Object.keys(pl)) if (!['pointPlaceId', 'scopePlaceIds', 'scopeStrength', 'excludePlaceIds', 'evidence'].includes(k)) errs.push(`${where}: unknown place key ${k}`);
  }
  checkPrice(s.price, `${where}.price`, errs, true);
  if (s.when !== null) {
    const w = s.when as Json;
    const from = Date.parse(w?.from);
    const to = Date.parse(w?.to);
    if (!(Number.isFinite(from) && Number.isFinite(to) && from < to)) errs.push(`${where}: when needs ISO from < to`);
    if (!STRENGTHS.includes(w?.strength)) errs.push(`${where}: bad when.strength`);
  }
  checkAttrs(s.attrs, s.categoryCode as string, where, errs);
  checkConstraints(s.constraints, s.categoryCode as string, false, where, errs);
}

function uniqueIds(items: Json[], prefix: string): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (typeof it?.id !== 'string' || !new RegExp(`^${prefix}\\d{3}$`).test(it.id)) errs.push(`bad id ${it?.id}`);
    if (seen.has(it?.id)) errs.push(`duplicate id ${it.id}`);
    seen.add(it?.id);
  }
  return errs;
}

function checkTags(tags: unknown, where: string, errs: string[]) {
  if (!Array.isArray(tags) || tags.length === 0 || tags.some((t) => typeof t !== 'string' || !/^[a-z0-9_]+$/.test(t))) errs.push(`${where}: tags must be non-empty snake_case strings`);
  else if (new Set(tags).size !== tags.length) errs.push(`${where}: duplicate tags`);
}

// ───────────────────────── utterances (training set and held-out set) ─────────────────────────
/** Label checks shared by utterances.json and holdout-utterances.json. */
function checkUtteranceFile(items: Json[], prefix: string): string[] {
  const errs = uniqueIds(items, prefix);
  const texts = new Set<string>();
  for (const u of items) {
    if (typeof u.text !== 'string' || u.text.trim() === '') errs.push(`${u.id}: empty text`);
    if (texts.has(u.text)) errs.push(`${u.id}: duplicate text`);
    texts.add(u.text);
    checkTags(u.tags, u.id, errs);
    checkExpected(u.expected, u.id, errs);
    const isNonRequest = u.tags?.includes('non_request');
    const e = u.expected;
    if (isNonRequest && (e.side !== null || e.category !== null || e.places.length || e.price || e.mustAsk.length)) errs.push(`${u.id}: non_request must carry empty labels`);
    if (!isNonRequest && e.category) {
      const v = e.category.split('.')[0];
      if (!u.tags.includes(v)) errs.push(`${u.id}: missing vertical tag ${v}`);
    }
  }
  return errs;
}

/** Tags below their minimum count, every vertical present, and every leaf category used. */
function coverageGaps(items: Json[], need: Record<string, number>): string[] {
  const tagCount = new Map<string, number>();
  for (const u of items) for (const t of u.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  const gaps: string[] = [];
  for (const [t, n] of Object.entries(need)) if ((tagCount.get(t) ?? 0) < n) gaps.push(`${t}: ${tagCount.get(t) ?? 0} < ${n}`);
  for (const v of VERTICALS) if (!items.some((u) => u.expected.category?.startsWith(v))) gaps.push(`vertical ${v}: no examples`);
  const used = new Set(items.map((u) => u.expected.category));
  for (const c of CATEGORIES) if (isLeaf(c.code) && !used.has(c.code)) gaps.push(`leaf category ${c.code}: no examples`);
  return gaps;
}

test('utterances.json: ids, labels and codes', () => {
  assert.ok(utterances.length >= 320, `need >= 320 utterances, have ${utterances.length}`);
  assert.deepEqual(checkUtteranceFile(utterances, 'u'), []);
});

test('utterances.json: coverage of verticals, sides, operators, currencies, units and asks', () => {
  assert.deepEqual(coverageGaps(utterances, {
    real_estate: 60, vehicles: 35, services: 40, education: 30, activities: 30, goods: 30, help: 15, non_request: 10,
    seeker: 100, provider: 80, joiner: 25, side_unknown: 5, dialect: 200, msa: 10,
    price_eq: 30, price_lte: 25, price_gte: 1, price_between: 5, price_approx: 10,
    currency_usd: 50, currency_try: 8, currency_syp: 4, currency_eur: 1, currency_missing: 5,
    unit_month: 20, unit_year: 3, unit_week: 1, unit_day: 3, unit_hour: 3, unit_session: 3, unit_person: 1, unit_total: 30,
    arabic_digits: 80, latin_digits: 10, number_words: 15, typo: 4, short: 15, long: 4,
    strict_place: 2, preferred_place: 3, negated_place: 1, multi_place: 15, region_place: 5, online: 10, when: 40,
    strict_attr: 8, preferred_attr: 4, ambiguous_deal: 10, ambiguous_side: 6, multi_intent: 3, keyword_collision: 10,
    asks_side: 6, asks_category: 6, asks_deal: 12, asks_place: 30, asks_when: 10, asks_price: 20, asks_price_currency: 5, asks_price_unit: 4,
    complete: 120,
  }), []);
});

// The held-out set measures parsers that were tuned on utterances.json; it must stay unseen and lexically distinct.
test('holdout-utterances.json: ids, labels and codes', () => {
  assert.ok(holdout.length >= 160, `need >= 160 held-out utterances, have ${holdout.length}`);
  assert.deepEqual(checkUtteranceFile(holdout, 'h'), []);
});

test('holdout-utterances.json: coverage in similar proportions to the training set', () => {
  assert.deepEqual(coverageGaps(holdout, {
    real_estate: 30, vehicles: 15, services: 18, education: 12, activities: 12, goods: 12, help: 6, non_request: 5,
    seeker: 60, provider: 45, joiner: 12, side_unknown: 4, dialect: 100, msa: 4,
    price_eq: 20, price_lte: 10, price_gte: 1, price_between: 2, price_approx: 4,
    currency_usd: 25, currency_try: 5, currency_syp: 2, currency_eur: 1, currency_missing: 2,
    unit_month: 8, unit_year: 1, unit_week: 1, unit_day: 1, unit_hour: 2, unit_session: 2, unit_person: 1, unit_total: 15,
    arabic_digits: 40, latin_digits: 5, number_words: 5, typo: 2, short: 5, long: 2,
    strict_place: 2, preferred_place: 2, negated_place: 1, multi_place: 3, region_place: 3, online: 3, when: 15,
    strict_attr: 3, preferred_attr: 2, ambiguous_deal: 4, ambiguous_side: 4, multi_intent: 2, keyword_collision: 5,
    asks_side: 4, asks_category: 2, asks_deal: 4, asks_place: 8, asks_when: 4, asks_price: 8, asks_price_currency: 2, asks_price_unit: 2,
    complete: 60,
  }), []);
});

test('holdout-utterances.json: no item repeats or closely paraphrases a training utterance', () => {
  // Own light normalization (no parser code): drop diacritics/tatweel, unify alef/ya/ta-marbuta, split on non-letters.
  const words = (s: string) => new Set(s.normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي').replace(/ة/g, 'ه').split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const jaccard = (a: Set<string>, b: Set<string>) => {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter || 1);
  };
  const train = utterances.map((u) => ({ id: u.id as string, text: u.text as string, w: words(u.text) }));
  const errs: string[] = [];
  for (const h of holdout) {
    const hw = words(h.text);
    for (const t of train) {
      if (t.text === h.text) errs.push(`${h.id} repeats ${t.id}`);
      else if (jaccard(hw, t.w) >= 0.5) errs.push(`${h.id} is too close to ${t.id} (word overlap ${jaccard(hw, t.w).toFixed(2)})`);
    }
  }
  assert.deepEqual(errs, []);
});

// ───────────────────────── dialogues ─────────────────────────
test('dialogues.json: ids, turn protocol and final labels', () => {
  assert.ok(dialogues.length >= 50, `need >= 50 dialogues, have ${dialogues.length}`);
  const errs = uniqueIds(dialogues, 'd');
  for (const d of dialogues) {
    checkTags(d.tags, d.id, errs);
    if (!Array.isArray(d.turns) || d.turns.length === 0) { errs.push(`${d.id}: no turns`); continue; }
    const asked: string[] = [];
    d.turns.forEach((t: Json, i: number) => {
      if (typeof t.user !== 'string' || t.user.trim() === '') errs.push(`${d.id}.turns[${i}]: empty user text`);
      if (!(t.expectAsk === null || EXPECT_ASK.includes(t.expectAsk))) errs.push(`${d.id}.turns[${i}]: bad expectAsk ${t.expectAsk}`);
      if (t.expectAsk && t.expectAsk !== 'conflict') {
        if (asked.includes(t.expectAsk)) errs.push(`${d.id}: field ${t.expectAsk} asked twice`);
        asked.push(t.expectAsk);
      }
    });
    if (d.turns.at(-1).expectAsk !== null) errs.push(`${d.id}: last turn must end the clarification (expectAsk null)`);
    checkExpected(d.final, `${d.id}.final`, errs, new Set(Array.isArray(d.acceptedUnknown) ? d.acceptedUnknown : []));
    if (d.final?.mustAsk?.length) errs.push(`${d.id}: final.mustAsk must be empty`);
    for (const k of ['side', 'category', 'deal']) if (d.final?.[k] === null) errs.push(`${d.id}: final.${k} must be known`);
    if (d.acceptedUnknown !== undefined) {
      if (!Array.isArray(d.acceptedUnknown) || d.acceptedUnknown.some((f: string) => !MUST_ASK_ORDER.includes(f))) errs.push(`${d.id}: bad acceptedUnknown`);
      else for (const f of d.acceptedUnknown) if (d.final[f] !== null && f !== 'place') errs.push(`${d.id}: ${f} accepted as unknown but labeled in final`);
    }
  }
  assert.deepEqual(errs, []);
  const tags = new Set(dialogues.flatMap((d) => d.tags));
  for (const t of ['conflict', 'correction', 'unsure', 'extra_info_merge', 'chip_answer', 'place_only_answer']) assert.ok(tags.has(t), `dialogue tag ${t} covered`);
  const asks = new Set(dialogues.flatMap((d) => d.turns.map((t: Json) => t.expectAsk)));
  for (const f of EXPECT_ASK) assert.ok(asks.has(f), `expectAsk ${f} covered`);
});

test('dialogues and utterances agree on the first question for the same opening sentence', () => {
  const byText = new Map(utterances.map((u) => [u.text, u] as const));
  const errs: string[] = [];
  let shared = 0;
  for (const d of dialogues) {
    const u = byText.get(d.turns[0].user);
    if (!u) continue;
    shared++;
    const first = u.expected.mustAsk[0] ?? null;
    if (first !== d.turns[0].expectAsk) errs.push(`${d.id} asks ${d.turns[0].expectAsk} but ${u.id} says ${first}`);
  }
  assert.ok(shared >= 10, `at least 10 dialogues open with a corpus utterance (have ${shared})`);
  assert.deepEqual(errs, []);
});

// ───────────────────────── matching scenarios ─────────────────────────
test('matching-scenarios.json: IntentSpecs, verdicts and reason codes', () => {
  assert.ok(scenarios.length >= 150, `need >= 150 scenarios, have ${scenarios.length}`);
  const errs = uniqueIds(scenarios, 'm');
  for (const s of scenarios) {
    checkTags(s.tags, s.id, errs);
    checkSpec(s.a, `${s.id}.a`, errs);
    checkSpec(s.b, `${s.id}.b`, errs);
    const x = s.expected;
    if (!isObj(x) || !VERDICTS.includes(x.verdict as string)) { errs.push(`${s.id}: bad verdict`); continue; }
    const codes = x.mustIncludeReasonCodes as unknown;
    if (!Array.isArray(codes) || codes.some((c) => !REASON_CODES.includes(c))) errs.push(`${s.id}: unknown reason code in ${JSON.stringify(codes)}`);
    if (x.verdict === 'excluded') {
      if (!REASON_CODES.includes(x.exclusionCode as string)) errs.push(`${s.id}: excluded needs a known exclusionCode`);
      else if (!(codes as string[]).includes(x.exclusionCode as string)) errs.push(`${s.id}: exclusionCode must be listed in mustIncludeReasonCodes`);
    } else if (x.exclusionCode !== null) errs.push(`${s.id}: exclusionCode must be null unless excluded`);
    if (typeof s.why !== 'string' || s.why.trim() === '') errs.push(`${s.id}: why is required`);
    if (s.a?.side === 'join' && s.b?.side === 'join' && s.a?.price) errs.push(`${s.id}: peer scenarios carry no price`);
  }
  assert.deepEqual(errs, []);
});

test('matching-scenarios.json: every reason code and verdict is exercised', () => {
  const seen = new Set<string>();
  const verdicts = new Map<string, number>();
  for (const s of scenarios) {
    for (const c of s.expected.mustIncludeReasonCodes) seen.add(c);
    verdicts.set(s.expected.verdict, (verdicts.get(s.expected.verdict) ?? 0) + 1);
  }
  assert.deepEqual(REASON_CODES.filter((c) => !seen.has(c)), []);
  for (const v of VERDICTS) assert.ok((verdicts.get(v) ?? 0) >= 20, `verdict ${v}: ${verdicts.get(v) ?? 0} >= 20`);
  const excl = new Set(scenarios.filter((s) => s.expected.verdict === 'excluded').map((s) => s.expected.exclusionCode));
  for (const c of ['place_out_of_scope', 'price_above_max', 'price_below_min', 'price_not_exact', 'attr_violation', 'deal_mismatch', 'category_mismatch', 'side_mismatch', 'date_no_overlap']) {
    assert.ok(excl.has(c), `exclusion ${c} covered`);
  }
});
