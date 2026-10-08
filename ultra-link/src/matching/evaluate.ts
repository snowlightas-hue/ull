// Pure pair evaluation: hard constraints first (exclude / possible-if-unknown), then soft ranking.
// This function is the single source of truth for match semantics; SQL only pre-filters candidates.
// Semantics are documented in docs/MATCHING.md (keep the two in sync).
//
//   * A required condition that is violated          → 'excluded' (the first one by EXCLUSION_PRIORITY).
//   * A required condition that cannot be proven      → 'possible' (+ the fact in `missing`), never 'confirmed'.
//   * Amounts in different currencies or units         → never compared, never 'confirmed' (whatever the strength).
//   * Preferences only move the score; they never exclude and are never widened or applied automatically.
//   * Exchange (seek ↔ provide) is order-independent; peer (join ↔ join) is evaluated in a canonical order,
//     so evaluatePair(a, b) and evaluatePair(b, a) return the same verdict, score and reasons.

import type { Registry } from '../domain/registry.ts';
import { attributesFor, distanceKm, isCategoryWithin, isPlaceWithin } from '../domain/registry.ts';
import { moneyText } from '../domain/format.ts';
import type { AttrConstraint, AttrFact, AttrValue, DealCode, GeoPoint, IntentSpec, MatchReason, PairVerdict, PriceSpec, PriceUnit, Side, Strength } from '../domain/types.ts';
import { normalizeAr } from '../nlu/arabic.ts';
import { proximityApplies, proximityCheck } from '../geo/semantics.ts';

/** A shared live position (src/geo/live.ts). `at` = time of the last accepted update. Never shown to others. */
export interface LivePoint { lat: number; lng: number; accuracyM?: number | null; at: string }

export interface MatchableIntent {
  id: string;
  userId: string;
  realm: 'real' | 'synthetic';
  side: Side;
  categoryCode: string;
  deal: DealCode;
  status: string;
  version: number;
  pointPlaceId: number | null;
  scopePlaceIds: number[];
  scopeStrength: Strength;
  excludePlaceIds: number[];
  price: PriceSpec | null;
  when: { from: string; to: string; strength: Strength; label?: string } | null;
  attrs: Record<string, AttrFact>;
  constraints: AttrConstraint[];
  createdAt: string;
  // ── proximity (V2.1, docs/GEO.md) — all optional: intents without them keep the place-only semantics
  /** precise static point of the owner (browser GPS with consent) */
  geo?: GeoPoint | null;
  /** latest live position while the owner shares it (provide / join only) */
  live?: LivePoint | null;
  /** "ضمن 5 كم" (required) / "حوالي 5 كم" (preferred) */
  radiusKm?: { value: number; strength: Strength } | null;
  /** "الأقرب / قريب مني" */
  nearest?: boolean;
}

/** Build a MatchableIntent from a validated IntentSpec (tests, corpus, simulations). */
export function specToMatchable(
  spec: IntentSpec,
  meta: { id: string; userId: string; realm?: 'real' | 'synthetic'; status?: string; version?: number; createdAt?: string; live?: LivePoint | null },
): MatchableIntent {
  const proximity: Partial<MatchableIntent> = {};
  if (spec.place.geo) proximity.geo = spec.place.geo;
  if (spec.place.radiusKm) proximity.radiusKm = spec.place.radiusKm;
  if (spec.place.nearest) proximity.nearest = true;
  if (meta.live) proximity.live = meta.live;
  return {
    ...proximity,
    id: meta.id, userId: meta.userId, realm: meta.realm ?? 'synthetic', side: spec.side, categoryCode: spec.categoryCode, deal: spec.deal,
    status: meta.status ?? 'active', version: meta.version ?? 1,
    pointPlaceId: spec.place.pointPlaceId, scopePlaceIds: spec.place.scopePlaceIds, scopeStrength: spec.place.scopeStrength,
    excludePlaceIds: spec.place.excludePlaceIds ?? [],
    price: spec.price, when: spec.when, attrs: spec.attrs, constraints: spec.constraints,
    createdAt: meta.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

/** Hard-violation codes, most fundamental first. `exclusion` is the first present in this order. */
export const EXCLUSION_PRIORITY = [
  'side_mismatch', 'realm_mismatch', 'same_owner', 'inactive', 'deal_mismatch', 'category_mismatch', 'place_excluded', 'place_out_of_scope',
  'distance_beyond_radius', 'date_no_overlap', 'price_above_max', 'price_below_min', 'price_not_exact', 'attr_violation',
] as const;

/** Score bands (integers): confirmed ∈ [5000, 10000], possible ∈ [0, 4999], excluded = 0. */
export const SCORE = { confirmedBase: 7000, possibleBase: 2500, possiblePerExtraMissing: 400, confirmedMin: 5000, possibleMax: 4999 } as const;

export interface EvalOptions { now?: Date }

/** A price as an inclusive interval of minor units (null bound = unbounded). */
interface Interval { lo: bigint | null; hi: bigint | null }

/** Evaluate a pair. Exchange: sides are detected; peer: canonical order by id. */
export function evaluatePair(reg: Registry, x: MatchableIntent, y: MatchableIntent, opts: EvalOptions = {}): PairVerdict {
  const reasons: MatchReason[] = [];
  const hard: MatchReason[] = [];
  const missing: string[] = [];
  let bonus = 0;
  const push = (r: MatchReason) => { if (!reasons.some((q) => q.code === r.code && q.text === r.text)) reasons.push(r); };
  const plus = (code: string, text: string, strength?: Strength, w = 0) => { push({ code, polarity: 'plus', text, strength }); bonus += w; };
  const minus = (code: string, text: string, strength?: Strength, w = 0) => { push({ code, polarity: 'minus', text, strength }); bonus -= w; };
  /** Unknown fact. `blocks` = it prevents confirmation (goes to `missing`). */
  const unknown = (code: string, text: string, miss: string, strength: Strength = 'required', blocks = strength === 'required') => {
    push({ code, polarity: 'unknown', text, strength });
    if (blocks && !missing.includes(miss)) missing.push(miss);
  };
  const exclude = (code: string, text: string) => { const r: MatchReason = { code, polarity: 'minus', text, strength: 'required' }; hard.push(r); push(r); };

  // ── relation & sides
  let seek: MatchableIntent;
  let prov: MatchableIntent;
  const peer = x.side === 'join' && y.side === 'join';
  if (peer) [seek, prov] = compareIds(x.id, y.id) <= 0 ? [x, y] : [y, x];
  else if (x.side === 'seek' && y.side === 'provide') { seek = x; prov = y; }
  else if (x.side === 'provide' && y.side === 'seek') { seek = y; prov = x; }
  else return excluded('side_mismatch', 'الطرفان من نفس النوع (طلب مع طلب أو عرض مع عرض)');
  if (x.realm !== y.realm) return excluded('realm_mismatch', 'بيانات تجريبية لا تُطابق مع بيانات حقيقية');
  if (x.userId === y.userId) return excluded('same_owner', 'نفس المستخدم');
  if (x.status !== 'active' || y.status !== 'active') return excluded('inactive', 'أحد الطرفين لم يعد نشطًا');

  // ── deal & category
  if (seek.deal !== prov.deal) {
    return excluded('deal_mismatch', `نوع العملية مختلف (${dealAr(reg, seek.deal)} مقابل ${dealAr(reg, prov.deal)})`);
  }
  const cs = reg.categoryByCode.get(seek.categoryCode);
  const cp = reg.categoryByCode.get(prov.categoryCode);
  if (!cs || !cp) return excluded('category_mismatch', 'الصنف مختلف');
  const provWithinSeek = isCategoryWithin(reg, cp.id, cs.id); // offer is the requested category or narrower
  const seekWithinProv = isCategoryWithin(reg, cs.id, cp.id);
  if (!provWithinSeek && !seekWithinProv) return excluded('category_mismatch', `الصنف مختلف (${cs.nameAr} و${cp.nameAr})`);
  if (peer) plus('category_same', `نفس النشاط: ${(provWithinSeek ? cp : cs).nameAr}`);
  else if (!provWithinSeek) {
    // the offer is broader than the request ("عندي عقار" vs "بدي شقة"): not proven to be what was asked for
    unknown('category_unknown', `العرض عام (${cp.nameAr}) — غير معروف إن كان ${cs.nameAr}`, 'category');
  }

  // ── places
  if (peer) {
    if (!locationOf(seek) || !locationOf(prov)) unknown('place_unknown', 'مكان النشاط غير محدد عند أحد الطرفين', 'place');
    peerPlace(seek, prov);
    peerPlace(prov, seek);
  } else {
    placeDirection(prov, seek, 'seek');
    placeDirection(seek, prov, 'provide');
  }

  // ── time windows (half-open [from, to))
  const sw = seek.when;
  const pw = prov.when;
  if (sw && pw) {
    const overlap = Date.parse(sw.from) < Date.parse(pw.to) && Date.parse(pw.from) < Date.parse(sw.to);
    const anyReq = sw.strength === 'required' || pw.strength === 'required';
    const bothReq = sw.strength === 'required' && pw.strength === 'required';
    const labels = [sw.label, pw.label].filter(Boolean).join(' و');
    if (overlap) plus('date_overlap', `الموعد متوافق${pw.label ?? sw.label ? ': ' + (pw.label ?? sw.label) : ''}`, anyReq ? 'required' : 'preferred', anyReq ? 0 : 300);
    else if (bothReq) exclude('date_no_overlap', `الموعد مختلف${labels ? ': ' + labels : ''}`);
    // at most one side is strict: the strict window is still feasible for the flexible side
    else minus('date_no_overlap', `الموعد غير المفضّل${labels ? ' (' + labels + ')' : ''}`, 'preferred', 400);
  } else if (peer) {
    // doing an activity together needs a shared time; without one it cannot be confirmed
    unknown('date_unknown', sw || pw ? 'الموعد غير محدد عند أحد الطرفين' : 'لم يحدد أي من الطرفين موعدًا', 'when');
  } else if (sw?.strength === 'required' || pw?.strength === 'required') {
    unknown('date_unknown', 'الموعد غير معروف عند الطرف الآخر', 'when');
  }

  // ── price (exchange: seeker condition vs provider asking price)
  if (!peer && seek.price) priceCheck(seek.price, prov.price);

  // ── attribute constraints in both directions
  for (const c of seek.constraints) attrCheck(c, prov, peer ? 'peer' : 'seek');
  for (const c of prov.constraints) attrCheck(c, seek, peer ? 'peer' : 'provide');

  // ── distance: precise / live points, radius and "nearest" (src/geo/semantics.ts, docs/GEO.md) — symmetric because
  // it runs on the canonical (seek, prov) order. Without any proximity data: the legacy soft centroid signal.
  if (proximityApplies(seek, prov)) {
    const px = proximityCheck(reg, seek, prov, peer, opts.now ?? new Date());
    for (const r of px.reasons) push(r);
    hard.push(...px.hard);
    for (const k of px.missing) if (!missing.includes(k)) missing.push(k);
    bonus += px.bonus;
  } else {
    const km = peer
      ? distanceKm(reg, locationOf(seek)?.[0] ?? null, locationOf(prov)?.[0] ?? null)
      : distanceKm(reg, seek.pointPlaceId ?? nonRoot(seek.scopePlaceIds)[0] ?? null, prov.pointPlaceId);
    if (km !== null && km > 0) { reasons.push({ code: 'distance', polarity: 'info', text: `على بعد حوالي ${km} كم` }); bonus -= Math.min(1000, km * 8); }
  }

  // ── recency: the offer's freshness (exchange) / the older of the two (peer, symmetric)
  const created = peer ? Math.min(Date.parse(seek.createdAt), Date.parse(prov.createdAt)) : Date.parse(prov.createdAt);
  const ageDays = Math.max(0, ((opts.now ?? new Date()).getTime() - created) / 86_400_000);
  bonus += Math.round(300 * Math.exp(-ageDays / 14));

  if (hard.length) {
    hard.sort((a, b) => rank(a.code) - rank(b.code));
    return { verdict: 'excluded', score: 0, reasons, missing, exclusion: hard[0] };
  }
  const isPossible = missing.length > 0;
  const score = isPossible
    ? clamp(SCORE.possibleBase - SCORE.possiblePerExtraMissing * (missing.length - 1) + bonus, 0, SCORE.possibleMax)
    : clamp(SCORE.confirmedBase + bonus, SCORE.confirmedMin, 10000);
  return { verdict: isPossible ? 'possible' : 'match', score, reasons, missing };

  // ───── helpers (closures over reasons) ─────
  function excluded(code: string, text: string): PairVerdict {
    const r: MatchReason = { code, polarity: 'minus', text, strength: 'required' };
    return { verdict: 'excluded', score: 0, reasons: [r], missing: [], exclusion: r };
  }

  function nonRoot(ids: number[]): number[] { return ids.filter((p) => p !== reg.rootPlaceId); }
  function within(p: number, s: number): boolean { return isPlaceWithin(reg, p, s); }
  /** Where an intent is: its point, else (peer) the area it named. */
  function locationOf(i: MatchableIntent): number[] | null {
    if (i.pointPlaceId != null) return [i.pointPlaceId];
    const s = nonRoot(i.scopePlaceIds);
    return s.length ? s : null;
  }

  /**
   * How a location (one or more places) relates to an area (one or more places):
   * inside = every location place lies within some area place (proven);
   * disjoint = no location place overlaps any area place (violated);
   * partial = they overlap but containment is not proven (e.g. "ريف حلب" against "إعزاز") → unknown.
   */
  function relate(loc: number[], area: number[]): 'inside' | 'partial' | 'disjoint' {
    if (loc.every((l) => area.some((s) => within(l, s)))) return 'inside';
    if (loc.every((l) => area.every((s) => !within(l, s) && !within(s, l)))) return 'disjoint';
    return 'partial';
  }

  /** Exchange: is `pt.point` inside `sc.scope` and outside `sc.exclude`? (sc = the side whose condition applies). */
  function placeDirection(pt: MatchableIntent, sc: MatchableIntent, scSide: 'seek' | 'provide') {
    const who = scSide === 'seek' ? 'طلبك' : 'العرض';
    const point = pt.pointPlaceId;
    const here = point != null ? placeAr(reg, point) : '';
    const excl = sc.excludePlaceIds;
    if (excl.length) {
      const ex = excl.map((p) => placeAr(reg, p)).join('، ');
      if (point == null) unknown('place_unknown', `المكان غير محدد — ${who} يستثني ${ex}`, 'place');
      else {
        const r = relate([point], excl);
        if (r === 'inside') { exclude('place_excluded', `في ${here} — ${scSide === 'seek' ? 'استثنيتها' : 'مستثناة في العرض'}`); return; }
        if (r === 'partial') unknown('place_unknown', `${here} تشمل ${ex} المستثناة — يحتاج تأكيد المكان`, 'place');
      }
    }
    if (!sc.scopePlaceIds.length) return;
    const req = sc.scopeStrength === 'required';
    if (sc.scopePlaceIds.includes(reg.rootPlaceId)) {
      if (point != null && req) plus('place_in_scope', `في ${here} (أي مكان مقبول)`, 'required');
      return;
    }
    const scope = nonRoot(sc.scopePlaceIds);
    const names = scope.map((p) => placeAr(reg, p)).join(' أو ');
    if (point == null) {
      if (req) unknown('place_unknown', `المكان غير محدد — ${who} يشترط ${names}`, 'place');
      return;
    }
    const r = relate([point], scope);
    if (r === 'inside') {
      if (req) plus('place_in_scope', scSide === 'seek' ? `في ${here} كما طلبت` : `ضمن منطقة الخدمة (${names})`, 'required');
      else plus('place_pref_satisfied', `في ${here} (مكان مفضّل)`, 'preferred', 600);
    } else if (r === 'disjoint') {
      if (req) exclude('place_out_of_scope', scSide === 'seek' ? `في ${here} — خارج ${names}` : `${here} خارج منطقة خدمة العرض (${names})`);
      else minus('place_pref_unsatisfied', `في ${here} (كنت تفضّل ${names})`, 'preferred', 600);
    } else {
      // a broader point ("ريف حلب") may or may not lie inside the scope: never confirmed, never excluded
      unknown('place_unknown', `${here} أوسع من ${names} — يحتاج تأكيد المكان`, 'place', sc.scopeStrength);
    }
  }

  /** Peer: `other`'s location (point, else named area) against `owner`'s area and exclusions. */
  function peerPlace(owner: MatchableIntent, other: MatchableIntent) {
    const loc = locationOf(other);
    if (!loc) return; // reported once as place_unknown above
    const there = loc.map((p) => placeAr(reg, p)).join(' أو ');
    if (owner.excludePlaceIds.length) {
      const r = relate(loc, owner.excludePlaceIds);
      if (r === 'inside') { exclude('place_excluded', `${there} — مكان مستثنى`); return; }
      if (r === 'partial') unknown('place_unknown', `${there} قد يكون في مكان مستثنى`, 'place');
    }
    // no stated area → the owner's own point is the area (never widened to "anywhere")
    const own = owner.scopePlaceIds.length ? owner.scopePlaceIds : owner.pointPlaceId != null ? [owner.pointPlaceId] : [];
    if (!own.length || own.includes(reg.rootPlaceId)) return;
    const scope = nonRoot(own);
    const names = scope.map((p) => placeAr(reg, p)).join(' أو ');
    const req = owner.scopeStrength === 'required';
    const r = relate(loc, scope);
    if (r === 'inside') {
      if (req) plus('place_in_scope', there === names ? `نفس المنطقة: ${there}` : `${there} ضمن ${names}`, 'required');
      else plus('place_pref_satisfied', `${there} (منطقة مفضّلة)`, 'preferred', 600);
    } else if (r === 'disjoint') {
      if (req) exclude('place_out_of_scope', `المكان مختلف: ${there} خارج ${names}`);
      else minus('place_pref_unsatisfied', `منطقة مختلفة: ${there} (المفضّل ${names})`, 'preferred', 600);
    } else {
      unknown('place_unknown', `${there} أوسع من ${names} — يحتاج تأكيد المكان`, 'place', owner.scopeStrength);
    }
  }

  function priceCheck(want: PriceSpec, have: PriceSpec | null) {
    const strength: Strength = want.op === 'approx' ? 'preferred' : want.strength;
    if (!have || (have.lo === null && have.hi === null)) {
      unknown('price_unknown', strength === 'required' ? 'السعر غير معروف — يحتاج تأكيد' : 'السعر غير مذكور', 'price', strength);
      return;
    }
    const wantUnit: PriceUnit | null = want.unit ?? (seek.deal === 'sale' ? 'total' : null);
    const haveUnit: PriceUnit | null = have.unit ?? (prov.deal === 'sale' ? 'total' : null);
    const haveShown = moneyText(have.lo ?? have.hi!, have.currency, haveUnit);
    // free of charge (0, no currency): within any ceiling or target, whatever its currency or unit
    if (have.lo === '0' && have.hi === '0' && (want.op === 'lte' || want.op === 'approx')) {
      plus('price_within_max', 'مجانًا — ضمن حدك', strength, 0);
      return;
    }
    // amounts with a different (or unknown) meaning are never compared. A required price stays unconfirmed;
    // a preferred one is shown as unknown but does not block confirmation (PRODUCT §6.2: preferences never block)
    if (!want.currency || !have.currency || want.currency !== have.currency) {
      const t = have.currency && want.currency
        ? `السعر بعملة مختلفة (${haveShown}) — لا نقارن عملات مختلفة`
        : 'العملة غير محددة — يحتاج تأكيد';
      unknown('currency_mismatch', t, 'price.currency', strength);
      return;
    }
    if (!wantUnit || !haveUnit || wantUnit !== haveUnit) {
      const t = wantUnit && haveUnit
        ? `وحدة السعر مختلفة (${haveShown}) — لا نقارن مبالغ مختلفة المعنى`
        : `وحدة السعر غير محددة (${haveShown}) — يحتاج تأكيد`;
      unknown('unit_mismatch', t, 'price.unit', strength);
      return;
    }
    const cur = want.currency;
    const h = offerInterval(have);
    const shown = h.lo !== null && h.lo === h.hi ? moneyText(h.lo, cur, haveUnit) : haveShown;
    const m = (v: bigint | null) => moneyText(v ?? 0n, cur, null);
    if (want.op === 'approx') {
      const target = BigInt(want.lo ?? want.hi!);
      const point = h.lo !== null && h.hi !== null ? (h.lo + h.hi) / 2n : (h.lo ?? h.hi!);
      const diff = point > target ? point - target : target - point;
      const pct = target === 0n ? (diff === 0n ? 0 : 100) : Number((diff * 100n) / target);
      if (pct <= 10) plus('price_near', `السعر ${shown} قريب من ${m(target)}`, 'preferred', 600);
      else minus('pref_unsatisfied', `السعر ${shown} بعيد عن ${m(target)} (فرق ${pct}%)`, 'preferred', Math.min(1500, pct * 20));
      return;
    }
    const w = wantInterval(want);
    if (w.lo === null && w.hi === null) return; // no usable bound (rejected by validation; never guessed)
    const inside = (w.lo === null || (h.lo !== null && h.lo >= w.lo)) && (w.hi === null || (h.hi !== null && h.hi <= w.hi));
    const above = w.hi !== null && h.lo !== null && h.lo > w.hi;
    const below = w.lo !== null && h.hi !== null && h.hi < w.lo;
    const fail = (code: string, text: string) => (strength === 'required' ? exclude(code, text) : minus(code, text, 'preferred', 900));
    if (inside) {
      switch (want.op) {
        case 'lte': plus('price_within_max', `السعر ${shown} ضمن حدك (${m(w.hi)})`, strength, 0); if (h.hi !== null && w.hi !== null) bonus += cheaperBonus(h.hi, w.hi); break;
        case 'eq': plus('price_exact', `السعر مطابق تمامًا: ${shown}`, strength, 400); break;
        case 'gte': plus('price_in_range', `السعر ${shown} ضمن الحد الأدنى (${m(w.lo)} وما فوق)`, strength, 0); break;
        case 'between': plus('price_in_range', `السعر ${shown} ضمن المدى ${m(w.lo)}–${m(w.hi)}`, strength, 200); break;
      }
    } else if (above || below) {
      if (want.op === 'eq') fail('price_not_exact', `السعر ${shown} لا يساوي ${m(w.lo)} المطلوب بالضبط`);
      else if (above) fail('price_above_max', `السعر ${shown} أعلى من ${want.op === 'between' ? 'المدى ' + m(w.lo) + '–' + m(w.hi) : 'حدك (' + m(w.hi) + ')'}`);
      else fail('price_below_min', `السعر ${shown} أقل من ${want.op === 'between' ? 'المدى ' + m(w.lo) + '–' + m(w.hi) : 'الحد الأدنى (' + m(w.lo) + ')'}`);
    } else {
      // the offer is a range that straddles the condition: neither proven nor violated
      unknown('price_uncertain', `السعر ${shown} قد لا يحقق شرطك — يحتاج تأكيد`, 'price', strength);
    }
  }

  function attrCheck(c: AttrConstraint, other: MatchableIntent, owner: 'seek' | 'provide' | 'peer') {
    const def = attributesFor(reg, other.categoryCode).find((a) => a.key === c.key);
    const label = def?.labelAr ?? c.key;
    const v = other.attrs[c.key];
    const whose = owner === 'provide' ? ' (شرط صاحب العرض)' : '';
    const w = (c.weight ?? 1) * 500;
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) {
      if (c.strength === 'required') unknown('attr_unknown', `غير معروف: ${label} ${valueAr(def, c)}${whose} — يحتاج تأكيد`, `attr.${c.key}`);
      else unknown('pref_unknown', `غير مذكور: ${label}${whose}`, `attr.${c.key}`, 'preferred');
      return;
    }
    const ok = satisfies(c, v);
    const shown = `${label}: ${displayValue(def, v)}`;
    if (ok) {
      if (c.strength === 'required') plus('attr_satisfied', `${shown}${whose}`, 'required');
      else plus('pref_satisfied', `${shown} (كما تفضّل)`, 'preferred', w);
    } else if (c.strength === 'required') exclude('attr_violation', `${shown} — لا يحقق الشرط ${valueAr(def, c)}${whose}`);
    else minus('pref_unsatisfied', `${shown} (كنت تفضّل ${valueAr(def, c)})`, 'preferred', w);
  }
}

/** Seeker condition → interval. eq uses lo (= hi); a missing bound is unbounded. */
function wantInterval(p: PriceSpec): Interval {
  const lo = p.lo === null ? null : BigInt(p.lo);
  const hi = p.hi === null ? null : BigInt(p.hi);
  switch (p.op) {
    case 'eq': { const x = lo ?? hi; return { lo: x, hi: x }; }
    case 'lte': return { lo: null, hi };
    case 'gte': return { lo, hi: null };
    case 'between': return { lo, hi };
    case 'approx': { const x = lo ?? hi; return { lo: x, hi: x }; }
  }
}

/**
 * Offer price → interval of what the counterpart may actually pay. An asking price ('eq') is a point;
 * "from X" is [X, ∞); "up to X" is [0, X]; a range is itself; "about X" is X ± 10% (never treated as exact).
 */
function offerInterval(p: PriceSpec): Interval {
  const lo = p.lo === null ? null : BigInt(p.lo);
  const hi = p.hi === null ? null : BigInt(p.hi);
  switch (p.op) {
    case 'eq': { const x = (lo ?? hi)!; return { lo: x, hi: x }; }
    case 'lte': return { lo: 0n, hi: hi ?? lo };
    case 'gte': return { lo: lo ?? hi, hi: null };
    case 'between': return { lo: lo ?? 0n, hi };
    case 'approx': { const x = (lo ?? hi)!; return { lo: x - x / 10n, hi: x + (x + 9n) / 10n }; }
  }
}

export function satisfies(c: AttrConstraint, fact: AttrFact): boolean {
  if (Array.isArray(fact)) {
    // multi-valued fact: eq/in/lte/gte/between = has a value that satisfies it; neq = has none of the excluded value
    if (fact.length === 0) return false;
    if (c.op === 'neq') return fact.every((x) => satisfies(c, x));
    return fact.some((x) => satisfies(c, x));
  }
  const v = fact;
  const eq = (a: AttrValue, b: AttrValue) => (typeof a === 'string' && typeof b === 'string' ? normalizeAr(a) === normalizeAr(b) : a === b);
  switch (c.op) {
    case 'eq': return c.value !== undefined && eq(v, c.value);
    case 'neq': return c.value !== undefined && !eq(v, c.value);
    case 'in': return (c.values ?? []).some((x) => eq(v, x));
    case 'lte': return typeof v === 'number' && typeof c.value === 'number' && v <= c.value;
    case 'gte': return typeof v === 'number' && typeof c.value === 'number' && v >= c.value;
    case 'between': return typeof v === 'number' && (c.lo === undefined || v >= c.lo) && (c.hi === undefined || v <= c.hi);
  }
}

function displayValue(def: ReturnType<typeof attributesFor>[number] | undefined, v: AttrFact): string {
  if (Array.isArray(v)) return v.map((x) => displayValue(def, x)).join('، ');
  if (typeof v === 'boolean') return v ? 'نعم' : 'لا';
  if (def?.type === 'enum') return def.values?.find((x) => x.code === v)?.labelAr ?? String(v);
  if (def?.key === 'floor' && typeof v === 'number') return v === 0 ? 'أرضي' : String(v);
  return `${v}${def?.unit ? ' ' + def.unit : ''}`;
}

function valueAr(def: ReturnType<typeof attributesFor>[number] | undefined, c: AttrConstraint): string {
  const dv = (v: AttrValue | undefined) => (v === undefined ? '' : displayValue(def, v));
  switch (c.op) {
    case 'eq': return typeof c.value === 'boolean' ? (c.value ? '(نعم)' : '(لا)') : `${dv(c.value)}`;
    case 'neq': return `≠ ${dv(c.value)}`;
    case 'lte': return `≤ ${dv(c.value)}`;
    case 'gte': return `≥ ${dv(c.value)}`;
    case 'between': return `${c.lo ?? ''}–${c.hi ?? ''}`;
    case 'in': return (c.values ?? []).map(dv).join(' أو ');
  }
}

function cheaperBonus(amount: bigint, max: bigint): number {
  if (max <= 0n) return 0;
  return Number(((max - amount) * 500n) / max); // up to +500 for cheaper offers within budget
}

function rank(code: string): number {
  const i = (EXCLUSION_PRIORITY as readonly string[]).indexOf(code);
  return i < 0 ? EXCLUSION_PRIORITY.length : i;
}
/** Numeric ids compare as BigInt (ids are bigint strings); anything else lexicographically. */
function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) { const x = BigInt(a); const y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.round(n))); }
function placeAr(reg: Registry, id: number): string { return reg.placeById.get(id)?.nameAr ?? '?'; }
function dealAr(reg: Registry, d: DealCode): string { return reg.dealByCode.get(d)?.nameAr ?? d; }
