// Bulk catalog import (V2.3, docs/CATALOG.md §3): one pasted line = one product. Each line goes through the SAME
// understanding path as a spoken request — parseUtterance via applyTurn, then buildSpec — with the store fixed as the
// provider and its place as the product's point; nothing about the parser or the conversation engine is changed here.
// The result is a per-line preview (category, deal, price, currency, attributes, problems); the owner fixes or unchecks
// lines and confirms. On confirm every line is parsed again on the server (the client's preview is never trusted),
// the owner's corrections are applied as typed fields, and the spec must pass validateSpec.
//
// Money: amounts are integer minor units in decimal strings; corrections typed by the owner are parsed with BigInt.
import type { Registry } from '../domain/registry.ts';
import { attributesFor, isPlaceWithin } from '../domain/registry.ts';
import { priceText } from '../domain/format.ts';
import type { AttrConstraint, AttrFact, Currency, DealCode, IntentSpec, PriceUnit } from '../domain/types.ts';
import { validateSpec } from '../domain/validate.ts';
import { applyTurn, buildSpec, emptyDraft, type ConversationDraft } from '../conversation/engine.ts';
import { asciiDigits, normalizeAr } from '../nlu/arabic.ts';

export const IMPORT_LIMITS = { maxLines: 200, maxLineChars: 200, maxNameChars: 80 } as const;
export const CURRENCIES: Currency[] = ['USD', 'TRY', 'SYP', 'EUR'];
export const PRODUCT_DEALS = ['sale', 'rent'] as const;
export type ProductDeal = (typeof PRODUCT_DEALS)[number];
const CUR_AR: Record<Currency, string> = { USD: 'دولار', TRY: 'ليرة تركية', SYP: 'ليرة سورية', EUR: 'يورو' };

export interface ImportDefaults { currency?: Currency | null; deal?: ProductDeal | null }

/** One product as the client confirms it: the pasted line plus the owner's typed corrections (all optional). */
export interface ItemInput {
  line: string;
  nameAr?: string;
  categoryCode?: string;
  deal?: ProductDeal;
  /** decimal amount as typed: "300", "12.5", "٣٠٠", "1,500" */
  amount?: string;
  currency?: Currency;
  unit?: PriceUnit;
  condition?: 'new' | 'used' | null;
  negotiable?: boolean;
}

export interface LineIssue { code: string; field: string | null; messageAr: string }

export interface ParsedItem {
  lineNo: number;
  text: string;
  nameAr: string;
  nameNorm: string;
  categoryCode: string | null;
  alternatives: string[];
  deal: DealCode | null;
  amountMinor: string | null;
  currency: Currency | null;
  unit: PriceUnit | null;
  negotiable: boolean;
  attrs: Record<string, AttrFact>;
  constraints: AttrConstraint[];
  problems: LineIssue[];
  warnings: LineIssue[];
  /** set when there is no problem: the validated spec to save */
  spec: IntentSpec | null;
  duplicateOf?: { id?: string; nameAr: string; lineNo?: number };
}

export interface ParseContext { placeId: number; defaults: ImportDefaults; now?: Date }

// ───────────── text helpers ─────────────
/** Non-empty lines of the pasted text with their 1-based line numbers; list bullets and numbering are removed. */
export function splitImportText(text: string): { lineNo: number; text: string }[] {
  const out: { lineNo: number; text: string }[] = [];
  text.split(/\r\n|\r|\n/).forEach((raw, i) => {
    const t = cleanLine(raw);
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ lineNo: i + 1, text: t });
  });
  return out;
}

export function cleanLine(raw: string): string {
  return raw
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '') // bidi controls and BOM
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:[-–—•*·▪●◦►✓✔]+|[0-9٠-٩]{1,3}\s*[.)\-–:]|\(?[0-9٠-٩]{1,3}\))\s+/u, '')
    .trim();
}

/** Normalised name used for duplicate detection (Arabic letter variants, digits, spacing, the synthetic label). */
export function normName(name: string): string {
  return normalizeAr(name.replace(/\(تجريبي[ةه]?\)/g, '')).replace(/\s+/g, ' ').trim().slice(0, 200);
}

const D = '[0-9٠-٩۰-۹]';
const NUM = `${D}(?:[0-9٠-٩۰-۹.,٫٬]*${D})?`;
const MULT = '(?:\\s*(?:ألف|الف|آلاف|الاف|ألاف|مليون|ملايين|ك|k|K))?';
const CURW = '(?:\\$|€|دولارات|دولارًا|دولار|يورو|ليرات|ليرة|ليره|ل\\.?\\s?ت\\.?|ل\\.?\\s?س\\.?|TL|tl|USD|usd|EUR|eur|TRY|SYP)';
const CURQ = '(?:\\s*(?:تركية|تركيه|تركي|سورية|سوريه|سوري|أمريكي|امريكي))?';
const UNITW = '(?:\\s*(?:بالشهر|شهريًا|شهريا|شهري|باليوم|يوميًا|يوميا|بالسنة|بالسنه|سنويًا|سنويا|بالأسبوع|بالاسبوع|بالساعة|بالساعه|للقطعة|للقطعه|القطعة|القطعه|للحبة|للحبه))?';
const TAILW = '(?:\\s*(?:قابل للتفاوض|قابلة للتفاوض|قابل للنقاش|فقط|كاش|نقدًا|نقدا|نهائي|آخر سعر|اخر سعر))*';
const PRE = '(?:(?:بسعر|السعر|سعره|سعرها|سعر|بـ|ب)\\s*)?';
const PRICE = `${PRE}(?:\\$\\s*)?${NUM}${MULT}(?:\\s*${CURW}${CURQ})?${UNITW}${TAILW}`;
const PRICE_CUR = `${PRE}(?:\\$\\s*)?${NUM}${MULT}\\s*${CURW}${CURQ}${UNITW}${TAILW}`;
const TRAIL_RE = new RegExp(`(?:^|\\s+|\\s*[-–—:=،,|/]\\s*)${PRICE}\\s*$`, 'u');
const LEAD_RE = new RegExp(`^\\s*(?:\\$\\s*${NUM}${MULT}|${PRICE_CUR})\\s*[-–—:=،,|/]?\\s*`, 'u');
const MID_RE = new RegExp(`(?:\\s+|\\s*[-–—:=،,|/]\\s*)${PRICE_CUR}(?=\\s|$)`, 'u');
const EDGE_SEP = /^[\s\-–—:=،,|/]+|[\s\-–—:=،,|/]+$/gu;

/** The product's name: the line without its price. Only stripped when the parser found a price in the line. */
export function productName(text: string, hasPrice: boolean): string {
  let t = text;
  if (hasPrice) {
    const before = t;
    t = t.replace(TRAIL_RE, '');
    if (t === before) t = t.replace(LEAD_RE, '');
    if (t === before) t = t.replace(MID_RE, '');
  }
  t = t.replace(EDGE_SEP, '').replace(/\s+/g, ' ').trim();
  return t.slice(0, IMPORT_LIMITS.maxNameChars).trim();
}

/** "300" / "12.5" / "٣٠٠" / "1,500" / "١٬٥٠٠٫٥" → minor units ("30000"); null when not a plain amount. BigInt only. */
export function amountToMinor(input: string): string | null {
  let t = asciiDigits(String(input)).replace(/[\s ]/g, '').replace(/٫/g, '.').replace(/٬/g, ',');
  if (t.includes(',')) {
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(t)) return null;
    t = t.replace(/,/g, '');
  }
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return (BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2))).toString();
}

/** minor units → the amount a person types ("30000" → "300", "1250" → "12.50"). */
export function minorToAmount(minor: string): string {
  const v = BigInt(minor);
  const whole = (v / 100n).toString();
  const frac = v % 100n;
  return frac === 0n ? whole : `${whole}.${frac.toString().padStart(2, '0')}`;
}

// ───────────── messages ─────────────
const MSG: Record<string, string> = {
  unknown_category: 'ما عرفنا نوع المنتج. اختر الصنف أو اكتب اسمه بشكل أوضح.',
  not_a_product: 'هذا يبدو خدمة أو نشاطًا وليس منتجًا للبيع أو الإيجار.',
  missing_price: 'لا يوجد سعر. اكتب السعر في السطر (مثلًا «٣٠٠$»).',
  missing_currency: 'العملة غير مذكورة: دولار أو ليرة تركية أو ليرة سورية أو يورو؟',
  ambiguous_lira: '«ليرة» وحدها غير واضحة: تركية أو سورية؟',
  missing_deal: 'للبيع أم للإيجار؟',
  missing_unit: 'الإيجار بالشهر أم باليوم أم بالسنة؟',
  bad_amount: 'السعر المكتوب غير صالح (أرقام فقط، وحتى منزلتين بعد الفاصلة).',
  duplicate_existing: 'منتج بنفس الاسم موجود في متجرك.',
  duplicate_in_batch: 'مكرر في هذه القائمة.',
  line_too_long: 'السطر طويل جدًا (الحد ٢٠٠ حرف).',
  bad_condition: 'الحالة (جديد/مستعمل) لا تنطبق على هذا الصنف.',
  category_uncertain: 'تأكد من الصنف — فهمنا أكثر من احتمال.',
  currency_defaulted: 'لا توجد عملة في السطر؛ استُخدمت العملة الافتراضية.',
  deal_defaulted: 'لم يُذكر بيع أو إيجار؛ اعتبرناه للبيع.',
  place_ignored: 'ذُكر مكان في السطر؛ مكان المنتج هو مكان المتجر.',
  looks_like_request: 'السطر يشبه طلبًا («بدي…»)؛ سيُحفظ كمنتج معروض في متجرك.',
  name_from_category: 'لم نجد اسمًا للمنتج؛ استُخدم اسم الصنف.',
  price_range: 'في السطر سعران؛ أخذنا الأقل.',
};
const issue = (code: string, field: string | null, extra = ''): LineIssue => ({ code, field, messageAr: MSG[code] ? MSG[code] + extra : extra });

// ───────────── one line ─────────────
const providerDraft = (): ConversationDraft => {
  const d = emptyDraft();
  d.resolved = ['place', 'geo']; // the product's place is the store's: never asked, never taken from the line
  return d;
};

/** Parse one product line and apply the owner's corrections. Pure (no database). */
export function parseItem(reg: Registry, input: ItemInput, ctx: ParseContext, lineNo: number): ParsedItem {
  const text = cleanLine(input.line);
  const problems: LineIssue[] = [];
  const warnings: LineIssue[] = [];
  const base: ParsedItem = {
    lineNo, text, nameAr: '', nameNorm: '', categoryCode: null, alternatives: [], deal: null, amountMinor: null, currency: null, unit: null,
    negotiable: false, attrs: {}, constraints: [], problems, warnings, spec: null,
  };
  if (text.length > IMPORT_LIMITS.maxLineChars) {
    problems.push(issue('line_too_long', 'line'));
    base.nameAr = text.slice(0, IMPORT_LIMITS.maxNameChars);
    base.nameNorm = normName(base.nameAr) || '-';
    return base;
  }
  // " - " separates a name from its price in shop lists; the parser would read it as a range ("12 - 300")
  const forParser = text.replace(/\s+[-–—]\s+/g, '، ');
  const turn = applyTurn(reg, providerDraft(), { text: forParser, answering: null, now: ctx.now });
  const d = turn.draft;
  const parse = turn.parse;

  // category
  const parsedCat = d.category?.value ?? null;
  base.alternatives = parse.categories.slice(0, 3).map((c) => c.value).filter((c) => reg.categoryByCode.get(c)?.depth !== 0);
  let categoryCode = input.categoryCode ?? parsedCat;
  let cat = categoryCode ? reg.categoryByCode.get(categoryCode) : undefined;
  if (!input.categoryCode && cat && cat.depth === 0) {
    const kids = reg.categories.filter((c) => c.parent === cat!.code);
    if (kids.length === 1) { cat = kids[0]; categoryCode = cat!.code; }
  }
  if (!cat || cat.depth === 0) { problems.push(issue('unknown_category', 'categoryCode')); categoryCode = null; cat = undefined; }
  else if (!cat.deals.some((x) => x === 'sale' || x === 'rent')) { problems.push(issue('not_a_product', 'categoryCode')); }
  else if (!input.categoryCode && parse.categories.length > 1 && !parse.categories[0]?.explicit) warnings.push(issue('category_uncertain', 'categoryCode'));
  base.categoryCode = categoryCode;

  // deal (sale | rent)
  let deal: DealCode | null = null;
  if (cat) {
    const allowed = cat.deals.filter((x): x is ProductDeal => x === 'sale' || x === 'rent');
    if (input.deal && allowed.includes(input.deal)) deal = input.deal;
    else if (d.deal && allowed.includes(d.deal.value as ProductDeal)) deal = d.deal.value;
    else if (allowed.length === 1) deal = allowed[0]!;
    else if (ctx.defaults.deal && allowed.includes(ctx.defaults.deal)) { deal = ctx.defaults.deal; if (!input.deal) warnings.push(issue('deal_defaulted', 'deal')); }
    else if (allowed.length) problems.push(issue('missing_deal', 'deal'));
  }
  base.deal = deal;

  // price
  const p0 = d.price?.value ?? null;
  if (input.amount !== undefined && input.amount !== '') {
    const m = amountToMinor(input.amount);
    if (m === null) problems.push(issue('bad_amount', 'amount'));
    base.amountMinor = m;
  } else if (p0 && (p0.lo !== null || p0.hi !== null)) {
    base.amountMinor = p0.lo ?? p0.hi;
    if (p0.lo !== null && p0.hi !== null && p0.lo !== p0.hi) warnings.push(issue('price_range', 'amount'));
  } else problems.push(issue('missing_price', 'amount'));
  base.negotiable = input.negotiable ?? p0?.negotiable ?? false;

  // currency
  if (base.amountMinor !== null || problems.some((x) => x.code === 'bad_amount')) {
    const cur = input.currency ?? d.currency?.value ?? null;
    if (cur) base.currency = cur;
    else if (ctx.defaults.currency) { base.currency = ctx.defaults.currency; warnings.push(issue('currency_defaulted', 'currency', ` (${CUR_AR[ctx.defaults.currency]})`)); }
    else problems.push(/(?:^| )(?:ليره|ليرات)(?: |$)/.test(parse.normalized) ? issue('ambiguous_lira', 'currency') : issue('missing_currency', 'currency'));
  }

  // unit: a sale price is a total; a rent needs a period
  if (deal === 'sale') base.unit = 'total';
  else if (deal === 'rent') {
    base.unit = input.unit ?? d.unit?.value ?? null;
    if (!base.unit || base.unit === 'total') { base.unit = null; problems.push(issue('missing_unit', 'unit')); }
  }

  // attributes (facts about the product) through buildSpec, filtered to the final category
  if (cat && deal) {
    const forSpec: ConversationDraft = {
      ...d,
      side: { value: 'provide', source: 'default', confidence: 1, turn: 1 },
      category: { value: cat.code, source: 'answer', confidence: 1, turn: 1 },
      deal: { value: deal, source: 'answer', confidence: 1, turn: 1 },
      place: { value: { ids: [ctx.placeId], strength: null, exclude: [] }, source: 'default', confidence: 1, turn: 1 },
      price: undefined, currency: undefined, unit: undefined, when: undefined, geo: undefined, radius: undefined, nearest: false,
    };
    const s = buildSpec(reg, forSpec);
    base.attrs = s.attrs;
    base.constraints = s.constraints;
    if (input.condition !== undefined) {
      const hasCondition = attributesFor(reg, cat.code).some((a) => a.key === 'condition');
      if (input.condition === null) delete base.attrs.condition;
      else if (hasCondition) base.attrs.condition = input.condition;
      else problems.push(issue('bad_condition', 'condition'));
    }
  }

  // name
  const typed = input.nameAr?.replace(/\s+/g, ' ').trim();
  let name = typed ? typed.slice(0, IMPORT_LIMITS.maxNameChars) : productName(text, parse.prices.length > 0);
  if (!name || !/[\p{L}]/u.test(name)) {
    name = cat ? cat.nameAr : text.slice(0, IMPORT_LIMITS.maxNameChars);
    if (cat) warnings.push(issue('name_from_category', 'nameAr'));
  }
  base.nameAr = name;
  base.nameNorm = normName(name) || normName(text) || '-';

  // other hints
  // a place that neither contains nor lies inside the store's place («بعفرين» in an إعزاز store) is ignored, visibly
  const unrelated = (id: number) => id !== reg.rootPlaceId && !isPlaceWithin(reg, ctx.placeId, id) && !isPlaceWithin(reg, id, ctx.placeId);
  if (parse.places.some((pl) => !pl.negated && unrelated(pl.placeId))) warnings.push(issue('place_ignored', null));
  if (parse.side?.value === 'seek' && parse.side.explicit) warnings.push(issue('looks_like_request', null));

  if (!problems.length && cat && deal && base.amountMinor !== null && base.currency) {
    const spec: IntentSpec = {
      side: 'provide', categoryCode: cat.code, deal,
      place: { pointPlaceId: ctx.placeId, scopePlaceIds: [], scopeStrength: 'required' },
      price: { op: 'eq', lo: base.amountMinor, hi: base.amountMinor, currency: base.currency, unit: base.unit, strength: 'required', negotiable: base.negotiable },
      when: null, attrs: base.attrs, constraints: base.constraints,
    };
    const v = validateSpec(reg, spec);
    if (v.ok) base.spec = v.spec;
    else problems.push(issue('invalid', null, `بيانات غير صالحة: ${v.issues.map((i) => i.code).join('، ')}`));
  }
  return base;
}

/** Mark duplicates: against the store's existing products and earlier lines of the same batch (blocking). */
export function markDuplicates(items: ParsedItem[], existing: Map<string, { id: string; nameAr: string }>): void {
  const seen = new Map<string, ParsedItem>();
  for (const it of items) {
    const ex = existing.get(it.nameNorm);
    if (ex) {
      it.duplicateOf = { id: ex.id, nameAr: ex.nameAr };
      it.problems.push(issue('duplicate_existing', 'nameAr'));
      it.spec = null;
      continue;
    }
    const first = seen.get(it.nameNorm);
    if (first) {
      it.duplicateOf = { nameAr: first.nameAr, lineNo: first.lineNo };
      it.problems.push(issue('duplicate_in_batch', 'nameAr', ` (السطر ${first.lineNo})`));
      it.spec = null;
      continue;
    }
    seen.set(it.nameNorm, it);
  }
}

// ───────────── preview view ─────────────
export interface PreviewLine {
  lineNo: number;
  text: string;
  ok: boolean;
  nameAr: string;
  categoryCode: string | null;
  categoryAr: string | null;
  alternatives: { code: string; labelAr: string }[];
  deal: DealCode | null;
  dealAr: string | null;
  price: { minor: string; amount: string; currency: Currency | null; unit: PriceUnit | null; negotiable: boolean } | null;
  priceAr: string | null;
  chips: { labelAr: string; valueAr: string }[];
  condition: string | null;
  problems: LineIssue[];
  warnings: LineIssue[];
  duplicateOf: ParsedItem['duplicateOf'] | null;
  /** what to send back on confirm (the owner may edit any field) */
  item: ItemInput;
}

export function previewLine(reg: Registry, it: ParsedItem): PreviewLine {
  const cat = it.categoryCode ? reg.categoryByCode.get(it.categoryCode) : undefined;
  const defs = cat ? attributesFor(reg, cat.code) : [];
  const chips: PreviewLine['chips'] = [];
  for (const [k, v] of Object.entries(it.attrs)) {
    const def = defs.find((a) => a.key === k);
    if (!def) continue;
    const one = (x: unknown) => def.values?.find((y) => y.code === x)?.labelAr ?? String(x);
    chips.push({ labelAr: def.labelAr, valueAr: Array.isArray(v) ? v.map(one).join('، ') : typeof v === 'boolean' ? (v ? 'نعم' : 'لا') : one(v) + (def.unit && typeof v === 'number' ? ` ${def.unit}` : '') });
  }
  const price = it.amountMinor !== null
    ? { minor: it.amountMinor, amount: minorToAmount(it.amountMinor), currency: it.currency, unit: it.unit, negotiable: it.negotiable }
    : null;
  const condition = typeof it.attrs.condition === 'string' ? it.attrs.condition : null;
  return {
    lineNo: it.lineNo, text: it.text, ok: it.problems.length === 0, nameAr: it.nameAr,
    categoryCode: it.categoryCode, categoryAr: cat?.nameAr ?? null,
    alternatives: it.alternatives.map((c) => ({ code: c, labelAr: reg.categoryByCode.get(c)?.nameAr ?? c })),
    deal: it.deal, dealAr: it.deal ? (it.deal === 'sale' ? 'للبيع' : 'للإيجار') : null,
    price,
    priceAr: price ? priceText({ op: 'eq', lo: price.minor, hi: price.minor, currency: price.currency, unit: price.unit, strength: 'required', negotiable: price.negotiable }, 'provide') : null,
    chips, condition, problems: it.problems, warnings: it.warnings, duplicateOf: it.duplicateOf ?? null,
    item: {
      line: it.text, nameAr: it.nameAr,
      ...(it.categoryCode ? { categoryCode: it.categoryCode } : {}),
      ...(it.deal === 'sale' || it.deal === 'rent' ? { deal: it.deal } : {}),
      ...(price ? { amount: price.amount } : {}),
      ...(it.currency ? { currency: it.currency } : {}),
      ...(it.unit && it.deal === 'rent' ? { unit: it.unit } : {}),
      ...(condition === 'new' || condition === 'used' ? { condition } : {}),
      ...(it.negotiable ? { negotiable: true } : {}),
    },
  };
}
