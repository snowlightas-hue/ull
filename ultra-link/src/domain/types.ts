// Shared domain contract for Ultra Link (server, worker, NLU, matching, tests).
// Erasable TypeScript only (runs directly on Node >= 22.18 with type stripping).

/** Who the intent's owner is in the relationship. */
export type Side = 'seek' | 'provide' | 'join';
/** exchange: seek <-> provide (asymmetric). peer: join <-> join (same activity). */
export type RelationKind = 'exchange' | 'peer';
export type Realm = 'real' | 'synthetic';
export type IntentStatus = 'active' | 'paused' | 'fulfilled' | 'closed' | 'expired';
export type Strength = 'required' | 'preferred';

/** Deal type codes (rows in deal_types). */
export type DealCode = 'sale' | 'rent' | 'service' | 'lesson' | 'activity' | 'help';

/** ISO-4217 currency codes we understand. */
export type Currency = 'USD' | 'TRY' | 'SYP' | 'EUR';
/** What a price amount refers to. Amounts with different units are never compared. */
export type PriceUnit = 'total' | 'month' | 'year' | 'week' | 'day' | 'hour' | 'session' | 'person';

/**
 * Money is always an integer count of minor units (cents/kuruş/piastres) carried as a decimal STRING
 * in JSON and as BIGINT in PostgreSQL. Never a JS float.
 */
export type MinorUnits = string;

/** Price condition. For providers it is the asking price (op 'eq'). */
export interface PriceSpec {
  op: 'eq' | 'lte' | 'gte' | 'between' | 'approx';
  lo: MinorUnits | null; // inclusive lower bound (null = unbounded)
  hi: MinorUnits | null; // inclusive upper bound (null = unbounded)
  currency: Currency | null; // null = not stated yet
  unit: PriceUnit | null; // null = not stated yet
  strength: Strength; // 'approx' is always preferred
  negotiable?: boolean;
  evidence?: string; // the user's own words
}

/** A typed attribute value (validated against attribute_defs). */
export type AttrValue = number | boolean | string;
/** An owner fact: a single value, or several enum codes ("بصلّح غسالات وبرادات", "بدرّس رياضيات وفيزياء"). */
export type AttrFact = AttrValue | string[];

/** Constraint on the counterpart's attributes. */
export interface AttrConstraint {
  key: string; // attribute key from the registry (e.g. rooms, floor, furnished, make, subject)
  op: 'eq' | 'neq' | 'lte' | 'gte' | 'between' | 'in';
  value?: AttrValue; // eq / neq / lte / gte
  values?: AttrValue[]; // in
  lo?: number; // between
  hi?: number;
  strength: Strength;
  weight?: number; // 1..5 for preferred
  evidence?: string;
}

/** Time window (ISO strings, half-open [from, to)). */
export interface TimeWindow {
  from: string;
  to: string;
  strength: Strength;
  label?: string; // human label, e.g. "يوم الجمعة"
  evidence?: string;
}

/** Location: point = where the thing/person is; scope = where a counterpart is acceptable. */
export interface PlaceSpec {
  pointPlaceId: number | null;
  scopePlaceIds: number[]; // empty = not stated
  scopeStrength: Strength; // 'فقط بإعزاز' => required; 'يفضّل إعزاز' => preferred
  excludePlaceIds?: number[]; // 'مو بعفرين' => never match points inside these places
  evidence?: string;
}

/** The structured, validated form of an intent (what the extractor fills and the matcher reads). */
export interface IntentSpec {
  side: Side;
  categoryCode: string; // e.g. real_estate.apartment
  deal: DealCode;
  place: PlaceSpec;
  price: PriceSpec | null;
  when: TimeWindow | null;
  attrs: Record<string, AttrFact>; // facts about the owner's own item/self
  constraints: AttrConstraint[]; // conditions on the counterpart
  notes?: string;
}

/** A field slot in the conversation draft, with provenance so we never re-ask answered fields. */
export type SlotName =
  | 'side'
  | 'category'
  | 'deal'
  | 'place'
  | 'price'
  | 'price.currency'
  | 'price.unit'
  | 'when'
  | `attr.${string}`;

export interface SlotValue<T = unknown> {
  value: T;
  source: 'rules' | 'jev' | 'jev-sim' | 'answer' | 'edit' | 'default';
  confidence: number; // 0..1
  evidence?: string;
  turn: number; // which user turn produced it
}

/** Conversation draft persisted server-side after every turn (survives reloads). */
export interface Draft {
  slots: Partial<Record<SlotName, SlotValue>>;
  constraints: AttrConstraint[];
  attrs: Record<string, AttrValue>;
  turns: number;
  askedFields: string[]; // fields we already asked about (never re-ask an answered one)
  unresolvedTerms: string[]; // words the parser could not map (feed for the schema advisor)
}

export interface Question {
  id: string; // stable id: field + attempt
  field: SlotName | 'conflict';
  text: string; // displayed Arabic text
  speech: string; // spoken variant (short, diacritized where ambiguous); same letters as text
  options?: { value: string; label: string }[]; // quick-answer chips
  conflict?: { field: SlotName; existing: string; incoming: string };
  attempt: number;
}

export type MatchState = 'confirmed' | 'possible' | 'invalidated';

export interface MatchReason {
  code: string; // machine code, e.g. place_in_scope, price_within_max, pref_unsatisfied
  polarity: 'plus' | 'minus' | 'unknown' | 'info';
  text: string; // Arabic explanation
  strength?: Strength;
}

export interface PairVerdict {
  verdict: 'match' | 'possible' | 'excluded';
  score: number; // integer 0..10000
  reasons: MatchReason[];
  missing: string[]; // unknown facts that block confirmation
  exclusion?: MatchReason; // first hard violation
}
