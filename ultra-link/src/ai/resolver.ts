// Jev resolver: asks the model ONLY the typed questions the deterministic parser could not settle,
// in ONE batched System One request, and maps the answers to Candidate<...> values.
//
// Principles:
// - The model only CHOOSES among options we offer (sides, category codes, deal codes, price operators,
//   strict/preferred). Values such as prices, places, dates and attributes always come from the user's
//   own words via the deterministic parser; they are never asked from or produced by the model.
// - Explicit rule cues always win: we never ask about a field the parser marked explicit.
// - Cost control: `shouldCallJev` + an LRU/TTL cache + in-flight de-duplication.

import { createHash } from 'node:crypto';
import type { Category, Registry } from '../domain/registry.ts';
import type { DealCode, PriceSpec, Side, Strength } from '../domain/types.ts';
import { normalizeAr } from '../nlu/arabic.ts';
import type { Candidate, JevResolution, PlaceMention, RuleParse } from '../nlu/types.ts';
import { MAX_CHOICE_LABELS } from './jev-client.ts';
import type { CallOptions, ChoiceAnswer, JevQuestion, JevQuestions, JevState, NoulAnswer, SystemOneResult } from './jev-client.ts';

export type JevField = 'side' | 'category' | 'deal' | 'priceOp' | 'placeStrength';
export const ALL_FIELDS: readonly JevField[] = ['side', 'category', 'deal', 'priceOp', 'placeStrength'];

/** Label the model can pick when no offered category fits (the conversation then asks the user). */
export const OTHER_CATEGORY = 'other';
/** When the full leaf list is longer than this, offer rule candidates + their siblings instead. */
export const MAX_CATEGORY_OPTIONS = 60;
export const MAX_PLACE_QUESTIONS = 4;

export const APP_CONTEXT =
  'Ultra Link connects people who need something (seek) with people who offer it (provide), and people who want ' +
  'to do the same activity together (join). The utterance is one spoken or typed request in Arabic, often Syrian/Levantine ' +
  'dialect, about housing, vehicles, services, lessons, goods, shared activities or help in northern Syria and southern Turkey.';

/** Minimal client surface the resolver needs (real client or a test double). */
export interface JevResolverClient {
  readonly model: string;
  readonly engine: 'jev' | 'jev-sim';
  systemOne<Q extends JevQuestions>(state: JevState, questions: Q, opts?: CallOptions): Promise<SystemOneResult<Q>>;
}

// ───────────────────────────── option texts ─────────────────────────────

export const SIDE_CRITERIA: Record<Side, string> = {
  seek: 'The speaker is looking for something they need: wants to buy, rent, hire or find (يبحث عن شيء يحتاجه: بدّي، محتاج، عم دوّر على، مطلوب).',
  provide: 'The speaker offers something: sells, rents out, provides a service, teaches or volunteers (يعرض شيئًا: للبيع، للإيجار، عندي، بقدّم خدمة، بدرّس).',
  join: 'The speaker wants other people to do a shared activity together, e.g. a trip, sport, study group (يبحث عن ناس يشاركونه نشاطًا: مين بدّو يجي، نروح سوا، نلعب).',
};

const DEAL_EN: Record<DealCode, string> = {
  sale: 'buying or selling an item',
  rent: 'renting or leasing for a period of time',
  service: 'a service performed by a person (repair, cleaning, moving...)',
  lesson: 'teaching, private lessons or training',
  activity: 'doing an activity together with peers',
  help: 'help or volunteering, usually unpaid',
};

export const PRICE_OP_CRITERIA: Record<'eq' | 'lte' | 'gte' | 'approx', string> = {
  eq: 'السعر المذكور هو السعر المطلوب أو المعروض نفسه (exactly this price; typical when offering or selling).',
  lte: 'هذا هو الحد الأعلى: يقبل هذا السعر أو أقل (a maximum budget: this price or less).',
  gte: 'هذا هو الحد الأدنى: يقبل هذا السعر أو أكثر (a minimum: this price or more).',
  approx: 'سعر تقريبي: حوالي هذا المبلغ، زيادة أو نقصان قليل (roughly this amount).',
};

// ───────────────────────────── planning ─────────────────────────────

export interface PlaceQuestionRef { name: string; placeId: number; mention: PlaceMention }

export interface QuestionPlan {
  questions: JevQuestions;
  fields: JevField[];
  sideLabels: Side[];
  categoryLabels: string[]; // category codes (+ OTHER_CATEGORY)
  dealLabels: DealCode[];
  placeQuestions: PlaceQuestionRef[];
}

export interface PlanOptions {
  /** restrict to the fields the conversation still needs (e.g. not yet answered by the user) */
  only?: readonly JevField[];
}

function isActiveLeaf(c: Category): boolean {
  return c.descendants.length === 1 && (c as { active?: boolean }).active !== false;
}

function explicitCategory(reg: Registry, parse: RuleParse): Category | null {
  const c = parse.categories.find((x) => x.explicit);
  return c ? (reg.categoryByCode.get(c.value) ?? null) : null;
}

function likelyCategory(reg: Registry, parse: RuleParse): Category | null {
  return explicitCategory(reg, parse) ?? (parse.categories[0] ? (reg.categoryByCode.get(parse.categories[0].value) ?? null) : null);
}

function sideAllowedFor(cat: Category, side: Side): boolean {
  return cat.relation === 'peer' ? side === 'join' : side !== 'join';
}

function categoryLabelsFor(reg: Registry, parse: RuleParse): string[] {
  const side = parse.side?.explicit ? parse.side.value : null;
  const deal = parse.deal?.explicit ? parse.deal.value : null;
  const fits = (c: Category) => isActiveLeaf(c) && (!side || sideAllowedFor(c, side)) && (!deal || c.deals.includes(deal));
  let leaves = reg.categories.filter(fits);
  if (leaves.length > MAX_CATEGORY_OPTIONS && parse.categories.length > 0) {
    // narrow: top rule candidates + their sibling leaves (or leaf descendants of a parent candidate)
    const picked = new Set<string>();
    for (const cand of parse.categories.slice(0, 5)) {
      const c = reg.categoryByCode.get(cand.value);
      if (!c) continue;
      const parentCode = isActiveLeaf(c) ? c.parent : c.code;
      for (const other of reg.categories) {
        if (!fits(other)) continue;
        if (other.code === c.code || (parentCode && other.ancestors.includes(reg.categoryByCode.get(parentCode)?.id ?? -1))) picked.add(other.code);
      }
    }
    const narrowed = leaves.filter((c) => picked.has(c.code));
    if (narrowed.length > 0) leaves = narrowed;
  }
  return leaves.slice(0, MAX_CHOICE_LABELS - 1).map((c) => c.code);
}

/** Build the minimal question set for this parse. Pure; no I/O. */
export function planJevQuestions(reg: Registry, parse: RuleParse, opts: PlanOptions = {}): QuestionPlan {
  const want = new Set<JevField>(opts.only ?? ALL_FIELDS);
  const plan: QuestionPlan = { questions: {}, fields: [], sideLabels: [], categoryLabels: [], dealLabels: [], placeQuestions: [] };
  if (parse.isNegativeAnswer || parse.isUnsure || !parse.normalized.trim()) return plan;

  const expCat = explicitCategory(reg, parse);
  const likely = likelyCategory(reg, parse);
  const expSide = parse.side?.explicit ? parse.side.value : null;

  // side
  if (want.has('side') && !expSide) {
    const sides = (['seek', 'provide', 'join'] as Side[]).filter((s) => !expCat || sideAllowedFor(expCat, s));
    if (sides.length > 1) {
      plan.sideLabels = sides;
      plan.questions.side = {
        type: 'choice',
        instructions: 'Which role does the speaker take in this request? (ما دور المتكلم في هذا الطلب؟)',
        criteria: Object.fromEntries(sides.map((s) => [s, SIDE_CRITERIA[s]])),
      };
      plan.fields.push('side');
    }
  }

  // category
  if (want.has('category') && !expCat) {
    const labels = categoryLabelsFor(reg, parse);
    if (labels.length > 0) {
      const criteria: Record<string, string> = {};
      for (const code of labels) {
        const c = reg.categoryByCode.get(code)!;
        criteria[code] = `${c.nameAr}: ${c.descriptionAr}`;
      }
      criteria[OTHER_CATEGORY] = 'لا شيء مما سبق يناسب الطلب (none of the listed categories fits).';
      plan.categoryLabels = [...labels, OTHER_CATEGORY];
      plan.questions.category = {
        type: 'choice',
        instructions: 'Which category best describes what the speaker needs, offers or wants to do? (ما الفئة الأنسب للطلب؟)',
        criteria,
      };
      plan.fields.push('category');
    }
  }

  // deal
  if (want.has('deal') && !parse.deal?.explicit) {
    let deals: DealCode[];
    if (likely) deals = [...likely.deals];
    else {
      const fromLabels = new Set<DealCode>();
      for (const code of plan.categoryLabels) for (const d of reg.categoryByCode.get(code)?.deals ?? []) fromLabels.add(d);
      deals = fromLabels.size ? [...fromLabels] : reg.deals.map((d) => d.code);
    }
    if (expSide) deals = deals.filter((d) => (expSide === 'join' ? reg.dealByCode.get(d)?.relation === 'peer' : reg.dealByCode.get(d)?.relation !== 'peer'));
    deals = [...new Set(deals)];
    if (deals.length > 1) {
      plan.dealLabels = deals;
      plan.questions.deal = {
        type: 'choice',
        instructions: 'What kind of deal is this? (ما نوع التعامل المطلوب؟)',
        criteria: Object.fromEntries(deals.map((d) => [d, `${reg.dealByCode.get(d)?.nameAr ?? d} (${DEAL_EN[d] ?? d})`])),
      };
      plan.fields.push('deal');
    }
  }

  // price operator for prices[0]
  const p0 = parse.prices[0];
  if (want.has('priceOp') && p0 && !p0.opExplicit && !(p0.lo !== null && p0.hi !== null && p0.lo !== p0.hi)) {
    plan.questions.price_op = {
      type: 'choice',
      instructions: `How should the price the speaker mentioned ("${p0.evidence}") be read? (كيف نفهم السعر المذكور؟)`,
      criteria: { ...PRICE_OP_CRITERIA },
    };
    plan.fields.push('priceOp');
  }

  // place strictness (one noul per place mention without an explicit cue)
  if (want.has('placeStrength')) {
    const seen = new Set<number>();
    for (const m of parse.places) {
      if (m.strength !== null || m.negated || seen.has(m.placeId)) continue;
      if (plan.placeQuestions.length >= MAX_PLACE_QUESTIONS) break;
      seen.add(m.placeId);
      const name = `place_${m.placeId}`;
      const placeAr = reg.placeById.get(m.placeId)?.nameAr ?? m.evidence;
      plan.questions[name] = {
        type: 'noul',
        instructions: `Does the speaker accept ONLY this place ("${placeAr}", said as "${m.evidence}") and reject other places? (هل يقبل المتكلم هذا المكان فقط؟)`,
        criteria: {
          true: 'Only this place is acceptable: a strict requirement (مثل: فقط، حصرًا، لازم، بس).',
          false: 'This place is a preference or simply where the speaker is; other or nearby places could also work (مثل: يفضّل، إذا ممكن، قريب من).',
        },
      };
      plan.placeQuestions.push({ name, placeId: m.placeId, mention: m });
    }
    if (plan.placeQuestions.length) plan.fields.push('placeStrength');
  }
  return plan;
}

/**
 * Cost control: true only when something is ambiguous / not explicit. With a registry the answer is exact
 * (same planner as resolveWithJev); without one it is a conservative approximation.
 */
export function shouldCallJev(parse: RuleParse, opts: PlanOptions & { registry?: Registry } = {}): boolean {
  if (opts.registry) return planJevQuestions(opts.registry, parse, opts).fields.length > 0;
  if (parse.isNegativeAnswer || parse.isUnsure || !parse.normalized.trim()) return false;
  const want = new Set<JevField>(opts.only ?? ALL_FIELDS);
  const p0 = parse.prices[0];
  return (
    (want.has('side') && !parse.side?.explicit) ||
    (want.has('category') && !parse.categories.some((c) => c.explicit)) ||
    (want.has('deal') && !parse.deal?.explicit) ||
    (want.has('priceOp') && !!p0 && !p0.opExplicit) ||
    (want.has('placeStrength') && parse.places.some((m) => m.strength === null && !m.negated))
  );
}

// ───────────────────────────── cache ─────────────────────────────

export class JevCache {
  private readonly map = new Map<string, { at: number; value: JevResolution }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  hits = 0;
  misses = 0;

  constructor(opts: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.clock = opts.now ?? Date.now;
  }

  get(key: string): JevResolution | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return undefined;
    }
    if (this.clock() - e.at > this.ttlMs) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.map.delete(key); // refresh LRU position
    this.map.set(key, e);
    this.hits++;
    return structuredClone(e.value);
  }

  set(key: string, value: JevResolution): void {
    this.map.delete(key);
    this.map.set(key, { at: this.clock(), value: structuredClone(value) });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

export const defaultJevCache = new JevCache();
const inFlight = new Map<string, Promise<JevResolution>>();

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** sha256(model + normalized text + question set) */
export function cacheKey(model: string, text: string, questions: JevQuestions): string {
  return createHash('sha256').update(`${model}\n${normalizeAr(text)}\n${stableStringify(questions)}`).digest('hex');
}

// ───────────────────────────── mapping ─────────────────────────────

const round4 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1e4) / 1e4;

function snippet(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

/** choice -> its confidence field */
export function choiceCandidate<T extends string>(a: ChoiceAnswer, evidence: string): Candidate<T> {
  return { value: a.choice as T, confidence: round4(a.confidence), evidence, explicit: false };
}

/** noul -> required when p >= 0.5, confidence |p - 0.5| * 2 */
export function noulStrength(a: NoulAnswer, evidence: string): Candidate<Strength> {
  return { value: a.noul >= 0.5 ? 'required' : 'preferred', confidence: round4(Math.abs(a.noul - 0.5) * 2), evidence, explicit: false };
}

function mapAnswers(reg: Registry, text: string, parse: RuleParse, plan: QuestionPlan, r: SystemOneResult, engine: 'jev' | 'jev-sim'): JevResolution {
  const out: JevResolution = {
    engine,
    model: r.model,
    latencyMs: r.latencyMs,
    usage: { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens },
  };
  const a = r.answers as Record<string, ChoiceAnswer | NoulAnswer>;
  const fallbackEvidence = snippet(text);

  if (plan.questions.side && a.side?.type === 'choice') {
    out.side = choiceCandidate<Side>(a.side, parse.side?.evidence || fallbackEvidence);
  }
  const catAns = a.category;
  if (plan.questions.category && catAns?.type === 'choice' && catAns.choice !== OTHER_CATEGORY) {
    const rule = parse.categories.find((c) => c.value === catAns.choice);
    out.category = choiceCandidate<string>(catAns, rule?.evidence || fallbackEvidence);
  }
  if (plan.questions.deal && a.deal?.type === 'choice') {
    const deal = a.deal.choice as DealCode;
    const catCode = explicitCategory(reg, parse)?.code ?? out.category?.value ?? parse.categories[0]?.value ?? null;
    const resolvedCat = catCode ? reg.categoryByCode.get(catCode) : undefined;
    // drop a deal that the resolved category does not allow (the model chose category and deal independently)
    if (!resolvedCat || resolvedCat.deals.includes(deal)) out.deal = choiceCandidate<DealCode>(a.deal, parse.deal?.evidence || fallbackEvidence);
  }
  if (plan.questions.price_op && a.price_op?.type === 'choice') {
    out.priceOp = choiceCandidate<PriceSpec['op']>(a.price_op, parse.prices[0]?.evidence || fallbackEvidence);
  }
  if (plan.placeQuestions.length) {
    const rec: Record<number, Candidate<Strength>> = {};
    for (const pq of plan.placeQuestions) {
      const ans = a[pq.name];
      if (ans?.type === 'noul') rec[pq.placeId] = noulStrength(ans, pq.mention.evidence);
    }
    if (Object.keys(rec).length) out.placeStrength = rec;
  }
  return out;
}

// ───────────────────────────── main entry ─────────────────────────────

export interface ResolveOptions extends PlanOptions {
  /** null disables caching; default: the process-wide cache */
  cache?: JevCache | null;
  signal?: AbortSignal;
}

/**
 * One batched System One call for the fields the parser left open. Throws JevError on failure
 * (the caller falls back to the deterministic parser). Returns an empty resolution without any
 * network call when nothing needs resolving.
 */
export async function resolveWithJev(
  client: JevResolverClient,
  registry: Registry,
  text: string,
  parse: RuleParse,
  opts: ResolveOptions = {},
): Promise<JevResolution> {
  const plan = planJevQuestions(registry, parse, opts);
  if (plan.fields.length === 0) {
    return { engine: client.engine, model: client.model, latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  const state: JevState = { utterance: text, language: 'ar', context: APP_CONTEXT };
  const cache = opts.cache === undefined ? defaultJevCache : opts.cache;
  const key = cacheKey(client.model, text, plan.questions);

  if (cache) {
    const hit = cache.get(key);
    if (hit) return { ...hit, latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  const pending = inFlight.get(key);
  if (pending && cache) return pending.then((r) => structuredClone(r));

  const run = (async () => {
    const r = await client.systemOne(state, plan.questions as Record<string, JevQuestion>, { signal: opts.signal });
    const res = mapAnswers(registry, text, parse, plan, r, client.engine);
    cache?.set(key, res);
    return res;
  })();
  if (cache) inFlight.set(key, run);
  try {
    return await run;
  } finally {
    if (cache) inFlight.delete(key);
  }
}
