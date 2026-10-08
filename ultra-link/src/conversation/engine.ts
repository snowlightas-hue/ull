// Conversation engine (pure): merges each turn into the draft, detects conflicts, picks ONE next
// question, and builds the validated IntentSpec when enough is known.
// Rules: answers are merged into the same draft (never a new request); an answered field is never
// re-asked; a conflict asks only about that field; Jev may only fill non-explicit fields above a threshold.

import type { Registry } from '../domain/registry.ts';
import { attributesFor } from '../domain/registry.ts';
import { priceText } from '../domain/format.ts';
import type { AttrConstraint, AttrFact, Currency, DealCode, IntentSpec, PlaceSpec, PriceSpec, PriceUnit, Question, Side, SlotName, Strength, TimeWindow } from '../domain/types.ts';
import { normalizeAr } from '../nlu/arabic.ts';
import { assignAttributes, parseUtterance } from '../nlu/parse.ts';
import type { AttrMention, JevResolution, RuleParse } from '../nlu/types.ts';
import { CHIP, conflictQuestion, dealOptions, makeQuestion, type TemplateKey } from './questions.ts';

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
  answering: Question | null; // the question the user is answering, if any
  jev?: JevResolution | null;
  now?: Date;
}

export interface TurnOutput {
  draft: ConversationDraft;
  parse: RuleParse;
  next: { kind: 'ask'; question: Question } | { kind: 'ready'; spec: IntentSpec } | { kind: 'unclear'; messageAr: string };
  appliedJev: string[]; // fields decided by Jev (for transparency)
}

const JEV_MIN: Record<string, number> = { side: 0.6, category: 0.6, deal: 0.85, priceOp: 0.6, placeStrength: 0.6 };
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
  if (catC && (!draft.category || (catC.explicit && catC.confidence >= 0.7 && !isWithinCategory(reg, catC.value, draft.category.value)))) {
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
  // when
  if (parse.when) {
    const w = parse.when;
    offer('when', w, w.label ?? '', draft.when?.value.label ?? '', () => { draft.when = { value: w, source: 'rules', confidence: 0.9, evidence: w.evidence, turn }; });
  }
  // attribute mentions: newer mention of the same key replaces the older one
  for (const m of parse.attrMentions) {
    const sameUtterance = parse.attrMentions.filter((x) => x.key === m.key).length > 1;
    if (!sameUtterance) draft.mentions = draft.mentions.filter((x) => !(x.key === m.key && (x.op === m.op || m.op === 'eq')));
    draft.mentions.push(m);
  }
  for (const t of parse.unknownTerms) if (!draft.unknownTerms.includes(t) && draft.unknownTerms.length < 30) draft.unknownTerms.push(t);

  if (conflict) draft.pendingConflict = conflict;

  // ── 4) decide
  const question = nextQuestion(reg, draft);
  if (question) return { draft, parse, next: { kind: 'ask', question }, appliedJev };
  if (!draft.side && !draft.category) {
    return { draft, parse, next: { kind: 'unclear', messageAr: 'ما فهمت الطلب بعد. احكيلي شو بدك أو شو عندك، مثلاً: «بدي شقة للإيجار بإعزاز».' }, appliedJev };
  }
  return { draft, parse, next: { kind: 'ready', spec: buildSpec(reg, draft) }, appliedJev };
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
  if (!d.place?.value.ids.length && !d.resolved.includes('place')) {
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
  if (d.price && !d.currency) {
    const q = ask('price.currency', 'currency', CHIP.currency);
    if (q) return q;
  }
  if (d.price && !d.unit && deal !== 'sale') {
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
  if (vertical === 'services' || vertical === 'help') return 'service';
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

  return { side, categoryCode: cat.code, deal, place, price, when: d.when?.value ?? null, attrs, constraints: cons };
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
  const cat = d.category ? reg.categoryByCode.get(d.category.value) : undefined;
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
      const chip = (['seek', 'provide', 'join'] as Side[]).find((s) => v === s);
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
    case 'price': return !!parse.prices[0];
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
