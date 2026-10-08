// Output of the deterministic Arabic parser and the input/output contract for the Jev resolver.

import type { AttrConstraint, AttrFact, AttrValue, Currency, DealCode, PriceSpec, PriceUnit, Side, Strength, TimeWindow } from '../domain/types.ts';

export interface Candidate<T> {
  value: T;
  confidence: number; // 0..1
  evidence: string; // the user's words that support it
  explicit: boolean; // true when an unambiguous cue was present (rules win over the model)
}

export interface PriceCandidate {
  lo: string | null; // minor units (decimal string)
  hi: string | null;
  currency: Currency | null;
  unit: PriceUnit | null;
  op: PriceSpec['op'] | null; // null = no operator cue ("200 دولار" alone)
  opExplicit: boolean;
  strength: Strength | null; // explicit strictness cue if any
  evidence: string;
}

export interface PlaceMention {
  placeId: number;
  evidence: string;
  strength: Strength | null; // 'فقط/حصرًا/لازم' => required, 'يفضّل/إذا ممكن' => preferred, null => no cue
  negated: boolean; // "مو بعفرين"
}

export interface RuleParse {
  normalized: string;
  side: Candidate<Side> | null;
  categories: Candidate<string>[]; // ranked category codes (best first)
  deal: Candidate<DealCode> | null;
  places: PlaceMention[];
  prices: PriceCandidate[];
  when: TimeWindow | null;
  attrs: Record<string, { value: AttrFact; evidence: string }>; // facts about the speaker's own item
  constraints: AttrConstraint[]; // conditions on the counterpart
  /** Raw attribute mentions before deciding self-fact vs counterpart-condition (depends on side). */
  attrMentions: AttrMention[];
  unknownTerms: string[]; // content words not mapped to anything (advisor input)
  isNegativeAnswer: boolean; // "لا" / "مو هيك"
  isUnsure: boolean; // "ما بعرف" / "مو مهم"
}

export interface AttrMention {
  key: string;
  op: 'eq' | 'neq' | 'lte' | 'gte' | 'between' | 'in';
  value?: AttrValue;
  values?: AttrValue[];
  lo?: number;
  hi?: number;
  strength: Strength | null; // explicit cue (لازم/فقط → required, يفضّل → preferred) or null
  evidence: string;
  about: 'self' | 'counterpart' | 'either'; // "أنا عيلة" = self; "للعائلات فقط" = counterpart
}

/** What the Jev resolver may decide. It only chooses among options we give it; it never invents values. */
export interface JevResolution {
  side?: Candidate<Side>;
  category?: Candidate<string>;
  deal?: Candidate<DealCode>;
  priceOp?: Candidate<PriceSpec['op']>; // for prices[0] when op was not explicit
  placeStrength?: Record<number, Candidate<Strength>>; // by placeId, when no explicit cue
  engine: 'jev' | 'jev-sim';
  model: string;
  latencyMs: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
}

export type { AttrValue, Currency, PriceUnit };
