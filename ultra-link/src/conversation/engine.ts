// Conversation engine (pure): merges each turn into the draft, detects conflicts, picks ONE next
// question, and builds the validated IntentSpec when enough is known.
// Rules: answers are merged into the same draft (never a new request); an answered field is never
// re-asked; a conflict asks only about that field; Jev may only fill non-explicit fields above a threshold.

import type { Registry } from '../domain/registry.ts';
import { attributesFor } from '../domain/registry.ts';
import { priceText } from '../domain/format.ts';
import type { AttrConstraint, AttrFact, Currency, DealCode, GeoPoint, IntentSpec, PlaceSpec, PriceSpec, PriceUnit, Question, Side, SlotName, Strength, TimeWindow } from '../domain/types.ts';
import { normalizeAr } from '../nlu/arabic.ts';
import { assignAttributes, parseUtterance, tokensOf } from '../nlu/parse.ts';
import { findNumbers } from '../nlu/numbers.ts';
import type { AttrMention, JevResolution, RuleParse } from '../nlu/types.ts';
import { CHIP, conflictQuestion, dealOptions, makeQuestion, type TemplateKey } from './questions.ts';
import { defaultNearestKm } from '../geo/semantics.ts';

export type Source = 'rules' | 'jev' | 'jev-sim' | 'answer' | 'default';
export interface Slot<T> { value: T; source: Source; confidence: number; evidence?: string; turn: number }

export interface PlaceSlot { ids: number[]; strength: Strength | null; exclude: number[] }
export interface PriceSlot { op: PriceSpec['op'] | null; lo: string | null; hi: string | null; strength: Strength | null; negotiable: boolean }

export interface ConversationDraft {
  side?: Slot<Side>;
  category?: Slot<string>;
  deal?: Slot<DealCode>;
  place?: Slot<PlaceSlot>;
  price?: Slot<PriceSlot>;
  currency?: Slot<Currency>;
  unit?: Slot<PriceUnit>;
  when?: Slot<TimeWindow>;
  /** precise point from the browser (GPS with consent) — never shown to others before a connection */
  geo?: Slot<GeoPoint>;
  radius?: Slot<{ value: number; strength: Strength }>;
  nearest?: boolean;
  mentions: AttrMention[];
  turns: number;
  asked: Record<string, number>; // field → times asked
  resolved: string[]; // fields answered (even if "don't know") — never asked again
  pendingConflict?: { field: SlotName; existing: string; incoming: string; existingAr: string; incomingAr: string };
  unknownTerms: string[];
  notes: string[];
}

export function emptyDraft(): ConversationDraft {
  return { mentions: [], turns: 0, asked: {}, resolved: [], unknownTerms: [], notes: [] };
}

export interface TurnInput {
  text: string;
  /** coordinates sent by the client when the user tapped "استخدم موقعي" */
  geo?: { lat: number; lng: number; accuracyM?: number } | null;
  answering: Question | null; // the question the user is answering, if any
  jev?: JevResolution | null;
  now?: Date;
}

export interface TurnOutput {
  draft: ConversationDraft;
  parse: RuleParse;
  /** `awaiting`: after giving up on an essential field, the field the next free-form answer is read against (not counted as asked) */
  next: { kind: 'ask'; question: Question } | { kind: 'ready'; spec: IntentSpec } | { kind: 'unclear'; messageAr: string; awaiting?: Question };
  appliedJev: string[]; // fields decided by Jev (for transparency)
}

const JEV_MIN: Record<string, number> = { side: 0.6, category: 0.6, deal: 0.85, priceOp: 0.6, placeStrength: 0.6 };
const GREETING_RE = /^(?:مرحبا|مرحبتين|مرحبه|اهلا|اهلين|هلا|هاي|السلام عليكم|سلام|صباح الخير|مسا الخير|مساء الخير|شكرا|يسلمو|تسلم|الله يعطيك العافيه)(?: .{0,25})?$/;
const CORRECTION_RE = /^(?:لا|لأ|لاء|عفوا|عفوًا)?\s*(?:قصدي|بقصد|اقصد|عفوا|غلطت|صحح|بالاحري|اقصد|لا مو|لا قصدي|مو هيك)/;

export function applyTurn(reg: Registry, draftIn: ConversationDraft, input: TurnInput): TurnOutput {
  const draft: ConversationDraft = structuredClone(draftIn);
  draft.turns += 1;
  const turn = draft.turns;
  const ans = input.answering;
  const answeringField = ans?.field === 'conflict' ? 'conflict' : ans?.field ?? null;
  const parse = parseUtterance(reg, input.text, { now: input.now, answering: answeringField, categoryHint: draft.category?.value ?? null, sideHint: draft.side?.value ?? null });
  const norm = parse.normalized;
  const correction = CORRECTION_RE.test(norm);
  const appliedJev: string[] = [];
  let conflict: ConversationDraft['pendingConflict'] | undefined;

  // ── 1) conflict answer
  if (ans?.field === 'conflict' && draft.pendingConflict) {
    const pc = draft.pendingConflict;
    const pick = chooseConflict(norm, input.text, pc);
    if (pick) {
      setFromSerialized(draft, pc.field, pick === 'take' ? pc.incoming : pc.existing, turn);
      markResolved(draft, pc.field);
      draft.pendingConflict = undefined;
    }
  }

  // ── 2) chip/short answers for the asked field
  if (ans && ans.field !== 'conflict') {
    const handled = applyDirectAnswer(reg, draft, ans.field, input.text, norm, parse, turn);
    if (handled) markResolved(draft, ans.field);
    else if (parse.isUnsure) {
      applyUnsure(reg, draft, ans.field, turn);
      markResolved(draft, ans.field);
    }
  }

  // ── 3) merge everything else the user said (extra info in answers is kept)
  const offer = (field: SlotName, incoming: unknown, ar: string, existingAr: string, apply: () => void) => {
    const cur = getSlot(draft, field);
    if (cur === undefined) { apply(); return; }
    if (sameValue(cur, incoming)) return;
    if (correction || ans?.field === field) { apply(); return; }
    if (!conflict) conflict = { field, existing: serialize(cur), incoming: serialize(incoming), existingAr, incomingAr: ar };
  };

  // side: only from explicit strong cues, or when nothing is known yet
  const sideC = pickSide(parse, input.jev, appliedJev);
  if (sideC && (!draft.side || (ans === null && sideC.explicit && sideC.confidence >= 0.9))) {
    offer('side', sideC.value, sideAr(sideC.value), draft.side ? sideAr(draft.side.value) : '', () => { draft.side = { value: sideC.value, source: sideC.source, confidence: sideC.confidence, evidence: sideC.evidence, turn }; });
  }
  // category: explicit keywords only once known (attribute-implied categories don't override)
  const catC = pickCategory(reg, parse, input.jev, appliedJev);
  const mayChangeCategory = !ans || ans.field === 'category' || correction;
  if (catC && (!draft.category || (mayChangeCategory && catC.explicit && catC.confidence >= 0.7 && !isWithinCategory(reg, catC.value, draft.category.value)))) {
    offer('category', catC.value, catAr(reg, catC.value), draft.category ? catAr(reg, draft.category.value) : '', () => {
      draft.category = { value: catC.value, source: catC.source, confidence: catC.confidence, evidence: catC.evidence, turn };
      // a category change can make an earlier deal invalid
      if (draft.deal && !reg.categoryByCode.get(catC.value)!.deals.includes(draft.deal.value)) draft.deal = undefined;
    });
  }
  // deal (re-detect with the final category)
  const dealC = pickDeal(reg, parse, draft.category?.value ?? null, input.jev, appliedJev);
  if (dealC) offer('deal', dealC.value, dealAr(reg, dealC.value), draft.deal ? dealAr(reg, draft.deal.value) : '', () => { draft.deal = { value: dealC.value, source: dealC.source, confidence: dealC.confidence, evidence: dealC.evidence, turn }; });

  // places
  const pos = parse.places.filter((p) => !p.negated);
  const neg = parse.places.filter((p) => p.negated).map((p) => p.placeId);
  if (pos.length || neg.length) {
    const strength = pos.find((p) => p.strength)?.strength ?? jevPlaceStrength(input.jev, pos.map((p) => p.placeId), appliedJev);
    const incoming: PlaceSlot = { ids: [...new Set(pos.map((p) => p.placeId))], strength, exclude: neg };
    const additive = /(?:^| )(?:او|أو|وكمان|كمان|ولا)(?: |$)/.test(norm) && !!draft.place?.value.ids.length;
    if (!draft.place || additive || !incoming.ids.length) {
      const base = draft.place?.value ?? { ids: [], strength: null, exclude: [] };
      draft.place = {
        value: {
          ids: additive || !incoming.ids.length ? [...new Set([...base.ids, ...incoming.ids])] : incoming.ids,
          strength: incoming.strength ?? base.strength,
          exclude: [...new Set([...base.exclude, ...incoming.exclude])],
        },
        source: 'rules', confidence: 0.9, evidence: parse.places.map((p) => p.evidence).join('، '), turn,
      };
    } else {
      const merged: PlaceSlot = { ...incoming, strength: incoming.strength ?? draft.place.value.strength, exclude: [...new Set([...draft.place.value.exclude, ...incoming.exclude])] };
      offer('place', merged, placesAr(reg, merged.ids), placesAr(reg, draft.place.value.ids), () => { draft.place = { value: merged, source: 'rules', confidence: 0.9, evidence: parse.places.map((p) => p.evidence).join('، '), turn }; });
      // same place but a new strictness cue ("بإعزاز فقط") just tightens
      if (draft.place && sameIds(draft.place.value.ids, merged.ids) && incoming.strength) draft.place.value.strength = incoming.strength;
    }
  }

  // price
  const p0 = parse.prices[0];
  if (p0 && (p0.lo !== null || p0.hi !== null)) {
    let op = p0.op;
    let strength = p0.strength;
    if (!p0.opExplicit && input.jev?.priceOp && input.jev.priceOp.confidence >= JEV_MIN.priceOp!) {
      op = input.jev.priceOp.value; appliedJev.push('price.op');
      strength = op === 'approx' ? 'preferred' : 'required';
      if (op === 'lte') { /* lo/hi from the single amount */ }
    }
    const amount = p0.lo ?? p0.hi;
    let lo = p0.lo;
    let hi = p0.hi;
    if (!p0.opExplicit && op && op !== 'between') {
      lo = op === 'lte' ? null : amount;
      hi = op === 'gte' ? null : amount;
    }
    const incoming: PriceSlot = { op, lo, hi, strength, negotiable: /قابل للتفاوض/.test(p0.evidence) };
    offer('price', incoming, p0.evidence, draft.price ? (draft.price.evidence ?? '') : '', () => { draft.price = { value: incoming, source: 'rules', confidence: 0.9, evidence: p0.evidence, turn }; });
    if (p0.currency) offer('price.currency', p0.currency, p0.currency, draft.currency?.value ?? '', () => { draft.currency = { value: p0.currency!, source: 'rules', confidence: 0.95, turn }; });
    if (p0.unit) offer('price.unit', p0.unit, p0.unit, draft.unit?.value ?? '', () => { draft.unit = { value: p0.unit!, source: 'rules', confidence: 0.95, turn }; });
  }
  // currency / unit stated without an amount ("دولار بالساعة") complete the existing price
  if (draft.price && !p0) {
    if (!draft.currency) {
      const cur = /(?:^| )(?:دولار|\$|usd)(?: |$)/.test(norm) ? 'USD' : /(?:^| )(?:تركي|تركيه)(?: |$)/.test(norm) ? 'TRY' : /(?:^| )(?:سوري|سوريه)(?: |$)/.test(norm) ? 'SYP' : /(?:^| )يورو(?: |$)/.test(norm) ? 'EUR' : null;
      if (cur) { draft.currency = { value: cur, source: 'answer', confidence: 0.95, turn }; markResolved(draft, 'price.currency'); }
    }
    if (!draft.unit) {
      const unit = /(?:^| )(?:بالشهر|شهري|شهريا)(?: |$)/.test(norm) ? 'month' : /(?:^| )(?:بالسنه|سنوي|سنويا)(?: |$)/.test(norm) ? 'year' : /(?:^| )(?:بالساعه|للساعه)(?: |$)/.test(norm) ? 'hour' : /(?:^| )(?:للحصه|بالحصه|للدرس)(?: |$)/.test(norm) ? 'session' : /(?:^| )(?:باليوم|يوميا)(?: |$)/.test(norm) ? 'day' : /(?:^| )(?:بالاسبوع|اسبوعيا)(?: |$)/.test(norm) ? 'week' : null;
      if (unit) { draft.unit = { value: unit, source: 'answer', confidence: 0.95, turn }; markResolved(draft, 'price.unit'); }
    }
  }
  // when
  if (parse.when) {
    const w = parse.when;
    offer('when', w, w.label ?? '', draft.when?.value.label ?? '', () => { draft.when = { value: w, source: 'rules', confidence: 0.9, evidence: w.evidence, turn }; });
  }
  // precise location & distance
  if (input.geo && Number.isFinite(input.geo.lat) && Number.isFinite(input.geo.lng) && Math.abs(input.geo.lat) <= 90 && Math.abs(input.geo.lng) <= 180) {
    draft.geo = { value: { lat: input.geo.lat, lng: input.geo.lng, accuracyM: input.geo.accuracyM, source: 'gps', at: (input.now ?? new Date()).toISOString() }, source: 'answer', confidence: 1, turn };
    markResolved(draft, 'geo');
  }
  if (parse.radius) draft.radius = { value: { value: parse.radius.km, strength: parse.radius.strength }, source: 'rules', confidence: 0.9, evidence: parse.radius.evidence, turn };
  if (parse.nearest) draft.nearest = true;

  // attribute mentions: newer mention of the same key replaces the older one
  for (const m of parse.attrMentions) {
    const sameUtterance = parse.attrMentions.filter((x) => x.key === m.key).length > 1;
    if (!sameUtterance) draft.mentions = draft.mentions.filter((x) => !(x.key === m.key && (x.op === m.op || m.op === 'eq')));
    draft.mentions.push(m);
  }
  for (const t of parse.unknownTerms) if (!draft.unknownTerms.includes(t) && draft.unknownTerms.length < 30) draft.unknownTerms.push(t);

  if (conflict) draft.pendingConflict = conflict;

  // ── 4) decide
  const nothingYet = !draft.side && !draft.category && !draft.place && !draft.price && !draft.when && !draft.mentions.length;
  if (nothingYet && !ans && GREETING_RE.test(norm)) {
    return { draft, parse, next: { kind: 'unclear', messageAr: 'أهلًا وسهلًا! احكيلي شو بدك أو شو عندك تقدّمه، مثلاً: «بدي شقة للإيجار بإعزاز» أو «عندي سيارة للبيع».' }, appliedJev };
  }
  const question = nextQuestion(reg, draft);
  if (question) return { draft, parse, next: { kind: 'ask', question }, appliedJev };
  if (!draft.side && !draft.category) {
    return { draft, parse, next: { kind: 'unclear', messageAr: 'ما فهمت الطلب بعد. احكيلي شو بدك أو شو عندك، مثلاً: «بدي شقة للإيجار بإعزاز».' }, appliedJev };
  }
  // the questions gave up (3 attempts) but an essential field is still unknown: never guess it, never widen — say what is missing
  const gap = essentialGap(reg, draft);
  if (gap) return { draft, parse, next: giveUp(reg, draft, gap), appliedJev };
  return { draft, parse, next: { kind: 'ready', spec: buildSpec(reg, draft) }, appliedJev };
}

type Gap = 'side' | 'category' | 'deal' | 'place';
/** Fields without which a saved request would be invented or silently widened (PRODUCT §5.3, §6.1, §6.2). */
export function essentialGap(reg: Registry, d: ConversationDraft): Gap | null {
  if (!d.category) return 'category';
  const cat = reg.categoryByCode.get(d.category.value)!;
  if (!d.side && cat.relation !== 'peer') return 'side';
  if (!d.deal && cat.deals.length > 1) return 'deal';
  const side = d.side?.value ?? 'join';
  if (side !== 'provide' && !d.place?.value.ids.length && !d.resolved.includes('place') && !d.geo && !d.resolved.includes('geo')) return 'place';
  return null;
}

function giveUp(reg: Registry, d: ConversationDraft, gap: Gap): { kind: 'unclear'; messageAr: string; awaiting?: Question } {
  const side = d.side?.value ?? null;
  const attempt = (d.asked[gap] ?? 0) + 1;
  const awaiting = (text: string, options?: { value: string; label: string }[]): Question => ({ id: `${gap}:giveup`, field: gap, text, speech: text, options, attempt });
  if (gap === 'category') {
    return { kind: 'unclear', messageAr: 'ما قدرت أعرف شو الشي اللي بدك ياه بالضبط. احكيلي الطلب بجملة وحدة، مثلاً: «بدي كهربجي بإعزاز».' };
  }
  if (gap === 'side') {
    const m = 'ما عرفت إذا عم تدوّر على شي ولا عم تعرضه. قول «بدي …» إذا عم تدوّر، أو «عندي …» إذا عم تعرض.';
    return { kind: 'unclear', messageAr: m, awaiting: awaiting(m, CHIP.side.filter((c) => c.value !== 'join')) };
  }
  if (gap === 'deal') {
    const opts = dealOptions(reg, d.category!.value, side);
    const m = `ما بحفظ الطلب قبل ما أعرف نوع الصفقة. قول ${opts.map((o) => `«${o.label}»`).join(' أو ')}.`;
    return { kind: 'unclear', messageAr: m, awaiting: awaiting(m, opts) };
  }
  const m = 'ما بحفظ الطلب بدون مكان، حتى ما وسّعه من عندي. قول اسم المدينة أو المنطقة، أو «أي مكان» إذا ما بتفرق معك.';
  return { kind: 'unclear', messageAr: m, awaiting: awaiting(m, CHIP.place_any) };
}

// ───────────── next question policy (one at a time) ─────────────
export function nextQuestion(reg: Registry, d: ConversationDraft): Question | null {
  if (d.pendingConflict) {
    const pc = d.pendingConflict;
    return conflictQuestion(pc.field, pc.existingAr, pc.incomingAr, pc.existing, pc.incoming, (d.asked['conflict'] ?? 0) + 1);
  }
  const ask = (field: SlotName, key: TemplateKey, options?: { value: string; label: string }[]): Question | null => {
    if (d.resolved.includes(field)) return null;
    const n = d.asked[field] ?? 0;
    if (n >= 3) return null; // give up politely; proceed with what we have
    return makeQuestion(field, key, n + 1, options);
  };
  const tryAsk = (...qs: (Question | null | false | undefined)[]) => qs.find((x) => x) || null;

  if (!d.side && !d.category) return tryAsk(ask('side', 'side', CHIP.side));
  const cat = d.category ? reg.categoryByCode.get(d.category.value) : undefined;
  if (!d.category) return tryAsk(ask('category', 'category', CHIP.category));
  // too vague to match well ("بدي شي نشاط", "بدي خدمة") — ask which kind, with the sub-categories as chips
  if (cat && cat.depth === 0 && !(['real_estate', 'vehicles'].includes(cat.verticalCode) && d.side?.value !== 'provide')) {
    const kids = reg.categories.filter((c) => c.parent === cat.code).map((c) => ({ value: c.code, label: c.nameAr }));
    const q = ask('category', 'category', kids.slice(0, 8));
    if (q) return q;
  }
  if (!d.side) {
    if (cat?.relation === 'peer') d.side = { value: 'join', source: 'default', confidence: 1, turn: d.turns };
    else return tryAsk(ask('side', 'side', CHIP.side.filter((c) => c.value !== 'join')));
  }
  const side = d.side!.value;
  const family = familyOf(cat!.verticalCode);
  if (!d.deal) {
    if (cat!.deals.length === 1) d.deal = { value: cat!.deals[0]!, source: 'default', confidence: 1, turn: d.turns };
    else {
      const q = ask('deal', side === 'provide' ? 'deal_provide' : 'deal_seek', dealOptions(reg, cat!.code, side));
      if (q) return q;
    }
  }
  // distance-based requests (rides, "قريب مني", "ضمن 5 كم"): ask for the precise location instead of a city
  const needsGeo = (d.nearest || !!d.radius || (cat!.code === 'transport.ride' && side === 'seek')) && !d.geo;
  if (needsGeo && !d.resolved.includes('geo') && !d.place?.value.ids.length) {
    const q = ask('geo', 'geo', [{ value: '__use_my_location__', label: 'استخدم موقعي الحالي' }]);
    if (q) return q;
  }
  if (!d.place?.value.ids.length && !d.resolved.includes('place') && !d.geo && !d.resolved.includes('geo')) {
    const key: TemplateKey =
      family === 'goods' ? (side === 'provide' ? 'place_provide' : 'place_seek')
      : family === 'service' ? (side === 'provide' ? 'place_service_provide' : 'place_service_seek')
      : family === 'lesson' ? 'place_lesson'
      : 'place_activity';
    const opts = family === 'lesson' ? CHIP.online : side === 'seek' && family === 'goods' ? CHIP.place_any : undefined;
    const q = ask('place', key, opts);
    if (q) return q;
  }
  if (family === 'activity' && !d.when) {
    const q = ask('when', 'when_activity', CHIP.when);
    if (q) return q;
  }
  if (family === 'lesson' && !d.mentions.some((m) => m.key === 'subject') && cat!.code === 'education.tutoring') {
    const q = ask('attr.subject', side === 'provide' ? 'subject_provide' : 'subject_seek', CHIP.subject);
    if (q) return q;
  }
  const deal = d.deal?.value;
  if (side === 'provide' && (deal === 'sale' || deal === 'rent') && !d.price) {
    const q = ask('price', 'price_provide');
    if (q) return q;
  }
  const free = !!d.price && d.price.value.lo === '0' && d.price.value.hi === '0'; // "ببلاش": no currency or unit to ask
  if (d.price && !d.currency && !free) {
    const q = ask('price.currency', 'currency', CHIP.currency);
    if (q) return q;
  }
  if (d.price && !d.unit && deal !== 'sale' && !free) {
    const key: TemplateKey = deal === 'rent' ? 'unit_rent' : deal === 'lesson' ? 'unit_lesson' : 'unit_service';
    const q = ask('price.unit', key, deal === 'rent' ? CHIP.unit_rent : deal === 'lesson' ? CHIP.unit_lesson : CHIP.unit_service);
    if (q) return q;
  }
  return null;
}

/** Called by the service when a question is actually sent to the user. */
export function recordAsked(d: ConversationDraft, q: Question): void {
  const f = q.field === 'conflict' ? 'conflict' : q.field;
  d.asked[f] = (d.asked[f] ?? 0) + 1;
}

// ───────────── spec building ─────────────
type Family = 'goods' | 'service' | 'lesson' | 'activity';
function familyOf(vertical: string): Family {
  if (vertical === 'services' || vertical === 'help' || vertical === 'transport') return 'service';
  if (vertical === 'education') return 'lesson';
  if (vertical === 'activities') return 'activity';
  return 'goods';
}

export function buildSpec(reg: Registry, d: ConversationDraft): IntentSpec {
  const cat = reg.categoryByCode.get(d.category!.value)!;
  const side = d.side?.value ?? (cat.relation === 'peer' ? 'join' : 'seek');
  const deal = d.deal?.value ?? cat.deals[0]!;
  const family = familyOf(cat.verticalCode);
  const ids = (d.place?.value.ids ?? []).filter((id) => id !== reg.rootPlaceId);
  const strength: Strength = d.place?.value.strength ?? 'required';
  const exclude = d.place?.value.exclude ?? [];
  let place: PlaceSpec;
  if (family === 'goods') {
    place = side === 'provide' ? { pointPlaceId: ids[0] ?? null, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: exclude }
      : { pointPlaceId: null, scopePlaceIds: ids, scopeStrength: strength, excludePlaceIds: exclude };
  } else if (family === 'service' || family === 'lesson') {
    const online = ids.includes(reg.placeByCode.get('online')!.id);
    const physical = ids.filter((id) => reg.placeById.get(id)?.kind !== 'virtual');
    if (side === 'provide') {
      place = { pointPlaceId: online && !physical.length ? reg.placeByCode.get('online')!.id : physical[0] ?? null, scopePlaceIds: online ? [] : physical, scopeStrength: 'required', excludePlaceIds: exclude };
    } else {
      place = { pointPlaceId: online && !physical.length ? reg.placeByCode.get('online')!.id : physical[0] ?? null, scopePlaceIds: [], scopeStrength: strength, excludePlaceIds: exclude };
    }
  } else {
    place = { pointPlaceId: ids[0] ?? null, scopePlaceIds: ids, scopeStrength: strength, excludePlaceIds: exclude };
  }

  let price: PriceSpec | null = null;
  if (d.price) {
    const p = d.price.value;
    const unit = d.unit?.value ?? (deal === 'sale' ? 'total' : null);
    if (side === 'provide' || side === 'join') {
      const amount = p.lo ?? p.hi;
      price = { op: 'eq', lo: amount, hi: amount, currency: d.currency?.value ?? null, unit, strength: 'required', negotiable: p.negotiable, evidence: d.price.evidence };
    } else {
      const op = p.op ?? 'lte';
      const amount = p.lo ?? p.hi;
      const lo = p.op ? p.lo : null;
      const hi = p.op ? p.hi : amount;
      price = { op, lo: op === 'lte' ? null : lo, hi: op === 'gte' ? null : hi, currency: d.currency?.value ?? null, unit, strength: p.op ? (p.strength ?? (op === 'approx' ? 'preferred' : 'required')) : 'preferred', evidence: d.price.evidence };
      if (op === 'approx') price.strength = 'preferred';
    }
  }

  const { attrs: rawAttrs, constraints } = assignAttributes(d.mentions, side);
  const allowed = new Set(attributesFor(reg, cat.code).map((a) => a.key));
  const attrs: Record<string, AttrFact> = {};
  for (const [k, v] of Object.entries(rawAttrs)) if (allowed.has(k)) attrs[k] = v.value;
  const cons: AttrConstraint[] = constraints.filter((c) => allowed.has(c.key));

  if (d.geo) {
    place.geo = d.geo.value;
    if (place.pointPlaceId == null) place.pointPlaceId = nearestCity(reg, d.geo.value.lat, d.geo.value.lng);
  }
  if (d.radius) place.radiusKm = d.radius.value;
  // a ride request means "the nearest car", inside the declared default limit (never widened silently)
  if (d.nearest || (cat.code === 'transport.ride' && side === 'seek' && !d.radius)) place.nearest = true;
  return { side, categoryCode: cat.code, deal, place, price, when: d.when?.value ?? null, attrs, constraints: cons };
}

/** Nearest city with known coordinates within 30 km (for place-based matching and a coarse display name). */
export function nearestCity(reg: Registry, lat: number, lng: number): number | null {
  let best: { id: number; km: number } | null = null;
  for (const p of reg.places) {
    if (p.lat == null || p.lng == null || p.kind === 'world' || p.kind === 'country') continue;
    const r = Math.PI / 180;
    const h = Math.sin(((p.lat - lat) * r) / 2) ** 2 + Math.cos(lat * r) * Math.cos(p.lat * r) * Math.sin(((p.lng - lng) * r) / 2) ** 2;
    const km = 2 * 6371 * Math.asin(Math.sqrt(h));
    if (km <= 30 && (!best || km < best.km)) best = { id: p.id, km };
  }
  return best?.id ?? null;
}

// ───────────── summaries ─────────────
export function summarize(reg: Registry, d: ConversationDraft): { titleAr: string; chips: { labelAr: string; valueAr: string; slot: string }[] } {
  const chips: { labelAr: string; valueAr: string; slot: string }[] = [];
  if (d.side) chips.push({ labelAr: 'النوع', valueAr: sideAr(d.side.value), slot: 'side' });
  if (d.category) chips.push({ labelAr: 'الصنف', valueAr: catAr(reg, d.category.value), slot: 'category' });
  if (d.deal) chips.push({ labelAr: 'العملية', valueAr: dealAr(reg, d.deal.value), slot: 'deal' });
  if (d.place?.value.ids.length) chips.push({ labelAr: 'المكان', valueAr: placesAr(reg, d.place.value.ids) + (d.place.value.strength === 'preferred' ? ' (تفضيل)' : ''), slot: 'place' });
  if (d.place?.value.exclude.length) chips.push({ labelAr: 'باستثناء', valueAr: placesAr(reg, d.place.value.exclude), slot: 'place' });
  if (d.price) {
    const side = d.side?.value ?? 'seek';
    const p = d.price.value;
    const spec: PriceSpec = { op: p.op ?? (side === 'provide' ? 'eq' : 'lte'), lo: p.lo, hi: p.hi ?? p.lo, currency: d.currency?.value ?? null, unit: d.unit?.value ?? null, strength: p.op ? p.strength ?? 'required' : 'preferred', negotiable: p.negotiable };
    if (!p.op && side !== 'provide') { spec.lo = null; spec.hi = p.lo ?? p.hi; }
    chips.push({ labelAr: 'السعر', valueAr: priceText(spec, side) ?? '', slot: 'price' });
  }
  if (d.when) chips.push({ labelAr: 'الموعد', valueAr: d.when.value.label ?? '', slot: 'when' });
  if (d.geo) chips.push({ labelAr: 'موقعك', valueAr: 'محدد بدقة (لا يظهر لأحد قبل موافقتك)', slot: 'geo' });
  if (d.radius) chips.push({ labelAr: 'المسافة', valueAr: `ضمن ${d.radius.value.value} كم${d.radius.value.strength === 'preferred' ? ' (تقريبًا)' : ''}`, slot: 'geo' });
  const cat = d.category ? reg.categoryByCode.get(d.category.value) : undefined;
  if (!d.radius && (d.nearest || (cat?.code === 'transport.ride' && d.side?.value === 'seek'))) {
    chips.push({ labelAr: 'الترتيب', valueAr: `الأقرب أولًا (ضمن ${cat ? defaultNearestKm(reg, cat.code) : 50} كم)`, slot: 'geo' });
  }
  const defs = cat ? attributesFor(reg, cat.code) : [];
  for (const m of d.mentions) {
    const def = defs.find((a) => a.key === m.key);
    if (!def) continue;
    const v = def.type === 'enum' ? def.values?.find((x) => x.code === m.value)?.labelAr ?? String(m.value) : typeof m.value === 'boolean' ? (m.value ? 'نعم' : 'لا') : m.key === 'floor' && m.value === 0 ? 'أرضي' : String(m.value);
    const opAr = m.op === 'gte' && d.side?.value !== 'provide' ? 'على الأقل ' : m.op === 'lte' ? 'حتى ' : m.op === 'neq' ? 'ليس ' : '';
    const strength = m.strength ? (m.strength === 'required' ? ' (شرط)' : ' (تفضيل)') : '';
    chips.push({ labelAr: def.labelAr, valueAr: `${opAr}${v}${strength}`, slot: `attr.${m.key}` });
  }
  return { titleAr: titleOf(reg, d), chips };
}

export function titleOf(reg: Registry, d: ConversationDraft | { side?: Side; category?: string; deal?: DealCode; placeIds?: number[]; whenLabel?: string; subject?: string }): string {
  const side = 'turns' in d ? d.side?.value : d.side;
  const catCode = 'turns' in d ? d.category?.value : d.category;
  const deal = 'turns' in d ? d.deal?.value : d.deal;
  const ids = 'turns' in d ? d.place?.value.ids ?? [] : d.placeIds ?? [];
  const when = 'turns' in d ? d.when?.value.label : d.whenLabel;
  if (!catCode) return side === 'provide' ? 'عرض جديد' : 'طلب جديد';
  const cat = reg.categoryByCode.get(catCode)!;
  let t = cat.nameAr;
  if (deal === 'sale') t += side === 'provide' ? ' للبيع' : ' للشراء';
  else if (deal === 'rent') t += ' للإيجار';
  const where = ids.filter((i) => i !== reg.rootPlaceId);
  if (where.length) t += (cat.verticalCode === 'activities' ? ' من ' : ' في ') + placesAr(reg, where);
  if (when) t += ` — ${when}`;
  return t;
}

// ───────────── helpers ─────────────
function pickSide(parse: RuleParse, jev: JevResolution | null | undefined, applied: string[]) {
  const r = parse.side;
  if (r?.explicit) return { ...r, source: 'rules' as Source };
  if (jev?.side && jev.side.confidence >= JEV_MIN.side!) { applied.push('side'); return { ...jev.side, source: jev.engine as Source }; }
  // a weak guess (e.g. noun-only "شقة للإيجار بإعزاز") is asked about rather than assumed
  return r && r.confidence >= 0.8 ? { ...r, source: 'rules' as Source } : null;
}
function pickCategory(reg: Registry, parse: RuleParse, jev: JevResolution | null | undefined, applied: string[]) {
  const r = parse.categories[0];
  if (r?.explicit) return { ...r, source: 'rules' as Source };
  if (jev?.category && jev.category.confidence >= JEV_MIN.category! && reg.categoryByCode.has(jev.category.value)) { applied.push('category'); return { ...jev.category, source: jev.engine as Source, explicit: false }; }
  return r ? { ...r, source: 'rules' as Source } : null;
}
function pickDeal(reg: Registry, parse: RuleParse, categoryCode: string | null, jev: JevResolution | null | undefined, applied: string[]) {
  const cat = categoryCode ? reg.categoryByCode.get(categoryCode) : undefined;
  const r = parse.deal;
  if (r && (!cat || cat.deals.includes(r.value)) && r.explicit) return { ...r, source: 'rules' as Source };
  if (jev?.deal && jev.deal.confidence >= JEV_MIN.deal! && (!cat || cat.deals.includes(jev.deal.value))) { applied.push('deal'); return { ...jev.deal, source: jev.engine as Source }; }
  if (r && (!cat || cat.deals.includes(r.value)) && r.confidence >= 0.6) return { ...r, source: 'rules' as Source };
  return null;
}
function jevPlaceStrength(jev: JevResolution | null | undefined, ids: number[], applied: string[]): Strength | null {
  if (!jev?.placeStrength) return null;
  for (const id of ids) {
    const c = jev.placeStrength[id];
    if (c && c.confidence >= JEV_MIN.placeStrength!) { applied.push('place.strength'); return c.value; }
  }
  return null;
}

function applyDirectAnswer(reg: Registry, d: ConversationDraft, field: SlotName, raw: string, norm: string, parse: RuleParse, turn: number): boolean {
  const v = raw.trim();
  switch (field) {
    case 'side': {
      const chip = (['seek', 'provide', 'join'] as Side[]).find((s) => v === s) ?? (parse.side?.explicit && parse.side.confidence >= 0.9 ? parse.side.value : undefined);
      const s = chip ?? (/(ناس|يشاركوني|سوا|نطلع|نلعب|مشاركه)/.test(norm) ? 'join' : /(عندي|بقدم|اقدم|بعرض|ببيع|باجر|بعطي)/.test(norm) ? 'provide' : /(بدور|عم دور|بدي|محتاج|دور)/.test(norm) ? 'seek' : parse.side?.value);
      if (!s) return false;
      d.side = { value: s, source: 'answer', confidence: 1, evidence: raw, turn };
      return true;
    }
    case 'category': {
      const code = reg.categoryByCode.has(v) ? v : parse.categories[0]?.value;
      if (!code) return false;
      d.category = { value: code, source: 'answer', confidence: 1, evidence: raw, turn };
      return true;
    }
    case 'deal': {
      if (v === 'ride' || /(توصيل|توصيله|توصيلات|مع سائق|مع سايق|تكسي|تاكسي)/.test(norm)) {
        d.category = { value: 'transport.ride', source: 'answer', confidence: 1, evidence: raw, turn };
        d.deal = { value: 'service', source: 'answer', confidence: 1, evidence: raw, turn };
        return true;
      }
      const chip = (['sale', 'rent', 'service', 'lesson', 'activity', 'help'] as DealCode[]).find((x) => v === x);
      const deal = chip ?? (/(ايجار|اجار|استاجر|للايجار|اجر|كري)/.test(norm) ? 'rent' : /(شراء|اشتري|بيع|للبيع|شرا|شري|ملك|تمليك)/.test(norm) ? 'sale' : null);
      if (!deal) return false;
      d.deal = { value: deal, source: 'answer', confidence: 1, evidence: raw, turn };
      return true;
    }
    case 'place': {
      const ids = parse.places.filter((p) => !p.negated).map((p) => p.placeId);
      if (!ids.length) {
        if (/(اي مكان|وين ما كان|مو مهم المكان|مش مهم|ما بتفرق)/.test(norm)) { d.place = { value: { ids: [reg.rootPlaceId], strength: 'preferred', exclude: [] }, source: 'answer', confidence: 1, evidence: raw, turn }; return true; }
        return false;
      }
      const strength = parse.places.find((p) => p.strength)?.strength ?? d.place?.value.strength ?? null;
      d.place = { value: { ids, strength, exclude: d.place?.value.exclude ?? [] }, source: 'answer', confidence: 1, evidence: raw, turn };
      return true;
    }
    case 'when': return !!parse.when; // merged below by the generic path
    case 'price': {
      if (parse.prices[0]) return true;
      // a bare amount answering "قديش السعر؟" is the price ("٦٠٠٠")
      const n = findNumbers(tokensOf(norm))[0];
      if (!n || n.cents <= 0n) return false;
      const amount = n.cents.toString();
      const side = d.side?.value;
      d.price = { value: side === 'seek' ? { op: null, lo: null, hi: amount, strength: null, negotiable: false } : { op: 'eq', lo: amount, hi: amount, strength: 'required', negotiable: false }, source: 'answer', confidence: 1, evidence: raw, turn };
      return true;
    }
    case 'price.currency': {
      const chip = (['USD', 'TRY', 'SYP', 'EUR'] as Currency[]).find((c) => v === c);
      const cur = chip ?? (/(دولار|\$|usd)/.test(norm) ? 'USD' : /(تركي|تركيه)/.test(norm) ? 'TRY' : /(سوري|سوريه)/.test(norm) ? 'SYP' : /يورو/.test(norm) ? 'EUR' : null);
      if (!cur) return false;
      d.currency = { value: cur, source: 'answer', confidence: 1, evidence: raw, turn };
      return true;
    }
    case 'price.unit': {
      const chip = (['total', 'month', 'year', 'week', 'day', 'hour', 'session', 'person'] as PriceUnit[]).find((u) => v === u);
      const unit = chip ?? (/(شهر|شهري)/.test(norm) ? 'month' : /(سنه|سنوي)/.test(norm) ? 'year' : /(اسبوع)/.test(norm) ? 'week' : /(يوم|يومي)/.test(norm) ? 'day' : /(ساعه)/.test(norm) ? 'hour' : /(حصه|درس|جلسه)/.test(norm) ? 'session' : /(كلها|مقطوع|الشغله)/.test(norm) ? 'total' : null);
      if (!unit) return false;
      d.unit = { value: unit, source: 'answer', confidence: 1, evidence: raw, turn };
      return true;
    }
    case 'geo': {
      if (d.geo) return true; // coordinates arrived with this turn
      const ids = parse.places.filter((p) => !p.negated).map((p) => p.placeId);
      if (ids.length) { d.place = { value: { ids, strength: d.place?.value.strength ?? null, exclude: d.place?.value.exclude ?? [] }, source: 'answer', confidence: 1, evidence: raw, turn }; return true; }
      return false;
    }
    default:
      if (field.startsWith('attr.')) {
        const key = field.slice(5);
        return parse.attrMentions.some((m) => m.key === key);
      }
      return false;
  }
}

function applyUnsure(reg: Registry, d: ConversationDraft, field: SlotName, turn: number) {
  if (field === 'place') d.place = { value: { ids: [reg.rootPlaceId], strength: 'preferred', exclude: [] }, source: 'answer', confidence: 1, turn };
  if (field === 'price.currency' || field === 'price.unit') { d.notes.push('price_dropped_unclear_currency_or_unit'); d.price = undefined; d.currency = undefined; d.unit = undefined; }
}

function markResolved(d: ConversationDraft, field: string) { if (!d.resolved.includes(field)) d.resolved.push(field); }

function getSlot(d: ConversationDraft, f: SlotName): unknown {
  switch (f) {
    case 'side': return d.side?.value;
    case 'category': return d.category?.value;
    case 'deal': return d.deal?.value;
    case 'place': return d.place?.value;
    case 'price': return d.price?.value;
    case 'price.currency': return d.currency?.value;
    case 'price.unit': return d.unit?.value;
    case 'when': return d.when?.value;
    default: return undefined;
  }
}
function serialize(v: unknown): string { return typeof v === 'string' ? v : JSON.stringify(v); }
function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  const pa = a as PlaceSlot, pb = b as PlaceSlot;
  if (pa && pb && Array.isArray(pa.ids) && Array.isArray(pb.ids)) return sameIds(pa.ids, pb.ids);
  const ta = a as TimeWindow, tb = b as TimeWindow;
  if (ta && tb && ta.from !== undefined) return ta.from === tb.from && ta.to === tb.to;
  const ra = a as PriceSlot, rb = b as PriceSlot;
  if (ra && rb && 'op' in ra) return ra.lo === rb.lo && ra.hi === rb.hi && (ra.op ?? 'x') === (rb.op ?? 'x');
  return JSON.stringify(a) === JSON.stringify(b);
}
function sameIds(a: number[], b: number[]) { return a.length === b.length && a.every((x) => b.includes(x)); }

function setFromSerialized(d: ConversationDraft, f: SlotName, s: string, turn: number) {
  const parsed = (() => { try { return JSON.parse(s); } catch { return s; } })();
  const slot = { source: 'answer' as Source, confidence: 1, turn };
  switch (f) {
    case 'side': d.side = { value: parsed, ...slot }; break;
    case 'category': d.category = { value: parsed, ...slot }; break;
    case 'deal': d.deal = { value: parsed, ...slot }; break;
    case 'place': d.place = { value: parsed, ...slot }; break;
    case 'price': d.price = { value: parsed, ...slot }; break;
    case 'price.currency': d.currency = { value: parsed, ...slot }; break;
    case 'price.unit': d.unit = { value: parsed, ...slot }; break;
    case 'when': d.when = { value: parsed, ...slot }; break;
  }
}

function chooseConflict(norm: string, raw: string, pc: NonNullable<ConversationDraft['pendingConflict']>): 'keep' | 'take' | null {
  if (raw.startsWith('keep:')) return 'keep';
  if (raw.startsWith('take:')) return 'take';
  const e = normalizeAr(pc.existingAr);
  const i = normalizeAr(pc.incomingAr);
  if (i && norm.includes(i) && !norm.includes(e)) return 'take';
  if (e && norm.includes(e) && !norm.includes(i)) return 'keep';
  // a distinctive word or number from one side only ("السبت", "٥٥٠٠")
  const words = (x: string) => new Set(x.split(' ').filter((w) => w.length >= 2 && !/^(يوم|في|من|ب|او)$/.test(w)));
  const ew = words(e), iw = words(i), aw = words(norm);
  const onlyI = [...iw].filter((w) => !ew.has(w)), onlyE = [...ew].filter((w) => !iw.has(w));
  const hitI = onlyI.some((w) => aw.has(w)), hitE = onlyE.some((w) => aw.has(w));
  if (hitI && !hitE) return 'take';
  if (hitE && !hitI) return 'keep';
  if (/(التاني|الثاني|الجديد|الاخير|هلق|التانيه)/.test(norm)) return 'take';
  if (/(الاول|القديم|قبل|الاولي)/.test(norm)) return 'keep';
  return null;
}

function isWithinCategory(reg: Registry, child: string, parent: string): boolean {
  const c = reg.categoryByCode.get(child), p = reg.categoryByCode.get(parent);
  return !!c && !!p && c.ancestors.includes(p.id);
}

export function sideAr(s: Side): string { return s === 'seek' ? 'طلب' : s === 'provide' ? 'عرض' : 'مشاركة بنشاط'; }
export function catAr(reg: Registry, code: string): string { return reg.categoryByCode.get(code)?.nameAr ?? code; }
export function dealAr(reg: Registry, d: DealCode): string { return reg.dealByCode.get(d)?.nameAr ?? d; }
export function placesAr(reg: Registry, ids: number[]): string { return ids.map((i) => reg.placeById.get(i)?.nameAr ?? '?').join(' أو '); }
