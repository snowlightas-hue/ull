// Deterministic Arabic (Levantine + MSA) parser: role, category, deal, places, prices, time, attributes.
// Values (places, amounts, attributes) come ONLY from the user's words. The Jev resolver may later choose
// among options where cues are missing, but it never invents values.

import type { Registry } from '../domain/registry.ts';
import { attributesFor } from '../domain/registry.ts';
import type { AttrConstraint, AttrFact, AttrValue, Currency, DealCode, PriceSpec, PriceUnit, Side, Strength, TimeWindow } from '../domain/types.ts';
import { normalizeAr, tokenVariants } from './arabic.ts';
import { findNumbers, type NumberPhrase } from './numbers.ts';
import type { AttrMention, Candidate, PlaceMention, PriceCandidate, RuleParse } from './types.ts';

export interface ParseOptions {
  now?: Date;
  /** Field the user is answering (clarification); biases interpretation of short answers. */
  answering?: string | null;
  /** Category already known from the conversation (helps attribute parsing in answers). */
  categoryHint?: string | null;
  sideHint?: Side | null;
}

// ───────────── tokenization ─────────────
export function tokensOf(normalized: string): string[] {
  return normalized
    .replace(/(\d)([^\d\s.,])/g, '$1 $2')
    .replace(/([^\d\s.,])(\d)/g, '$1 $2')
    .split(' ')
    .filter(Boolean);
}

interface PhraseHit<T> { start: number; end: number; value: T; phrase: string }

/** Greedy longest-first phrase matching with clitic-stripped variants of the first/last token. */
function matchPhrases<T>(tokens: string[], dict: Map<string, T>, maxN = 4, skip?: (h: PhraseHit<T>) => boolean): PhraseHit<T>[] {
  const hits: PhraseHit<T>[] = [];
  let i = 0;
  while (i < tokens.length) {
    let found: PhraseHit<T> | null = null;
    for (let n = Math.min(maxN, tokens.length - i); n >= 1 && !found; n--) {
      const firstVariants = tokenVariants(tokens[i]!);
      const lastVariants = n > 1 ? tokenVariants(tokens[i + n - 1]!) : [''];
      for (const fv of firstVariants) {
        for (const lv of lastVariants) {
          const parts = n === 1 ? [fv] : [fv, ...tokens.slice(i + 1, i + n - 1), lv];
          const key = parts.join(' ');
          const v = dict.get(key);
          if (v !== undefined) {
            const h = { start: i, end: i + n, value: v, phrase: tokens.slice(i, i + n).join(' ') };
            if (!skip || !skip(h)) { found = h; break; }
          }
        }
        if (found) break;
      }
    }
    if (found) { hits.push(found); i = found.end; } else i++;
  }
  return hits;
}

const has = (norm: string, re: RegExp) => re.test(norm);
const W = (alts: string) => new RegExp(`(?:^| )(?:${alts})(?= |$)`);

// ───────────── role (side) cues ─────────────
const WANT = '[وف]?(?:بدي|بدنا|بدو|بدها|محتاج|محتاجه|محتاجين|بحاجه|بحتاج|منحتاج|ابغي|ابي|اريد|نريد|لازمني|لازمنا|بلزمني|بيلزمني|عايز|عاوز|حابب|حابه|حاب|ناوي|نفسي|ارغب|نرغب|اود|نود|اتمني)';
const PROFESSIONS = 'سباك|كهربجي|كهربائي|ميكانيكي|دهان|نجار|حداد|عزال|مدرس|مدرسه|استاذ|استاذه|معلم|معلمه|فني|خياط|خياطه|مصور|مترجم|مدرب|مدربه|سايق|سواق|عامل|عامله|ممرض|ممرضه';
const SIDE_RULES: { re: RegExp; side: Side; conf: number; tag: string }[] = [
  // companionship: "بدي حدا يمشي معي", "بدي رفقة بالطريق", "أبحث عن مجموعة لممارسة الجري"
  { re: new RegExp(`(?:^| )(?:${WANT}|ابحث عن|نبحث عن|عم دور علي) (?:حدا|شب|شباب|ناس|رفقه|رفقة|جماعه|مجموعه|صحبه|رفيق|صديق)(?:(?: \\S+){0,4} (?:معي|معنا|سوا|سويه|مع بعض)| (?:ل|بال|ب)\\S+|$)`), side: 'join', conf: 0.9, tag: 'want_company' },
  // "بدي حدا يصلّح..." — needs a person → seeker of a service (beats "عندي غسالة خربانة")
  { re: new RegExp(`(?:^| )(?:${WANT}|عم دور علي|عم ندور علي|بدور علي|دور علي|مطلوب) (?:حدا|احد|شخص|واحد|واحده|فني|معلم|معلمه|مدرس|مدرسه|استاذ|استاذه|سباك|كهربجي|كهربائي|ميكانيكي|عامل|عامله|حرفي|دهان|نجار|حداد|مين|ناس|سايق|سواق|مصور)(?= |$)`), side: 'seek', conf: 0.95, tag: 'want_person' },
  { re: new RegExp(`(?:^| )(?:${WANT}) (?:ابيع|بيع|نبيع|اجر|نجر|نأجر|اعرض|اقدم|نقدم|اعطي|علم|اعلم)\\S*`), side: 'provide', conf: 0.95, tag: 'want_to_sell' },
  { re: new RegExp(`(?:^| )(?:${WANT}) (?:في |ب)?(?:اشتري|نشتري|شتري|استاجر|نستاجر|اخد|ناخد|اجار|استيجار|استئجار|شراء)\\S*`), side: 'seek', conf: 0.95, tag: 'want_to_buy' },
  { re: /(?:^| )(?:انا|احنا|نحن|انا بشتغل|شغلي|شغلتي|مهنتي) (?:مندوب|مندوبه|سائق|مدرس|مدرسه|استاذ|استاذه|معلم|معلمه|سباك|كهربجي|كهربائي|فني|ميكانيكي|دهان|نجار|حداد|مهندس|سايق|سواق|ممرض|ممرضه|مصور|مترجم|متطوع|متطوعه|خياط|خياطه|عامل|عامله|مدرب|مدربه)(?= |$)/, side: 'provide', conf: 0.95, tag: 'i_am_pro' },
  { re: new RegExp(`(?:^| )(?:${WANT}) (?:اطلع|نطلع|العب|نلعب|اروح|نروح|امشي|نمشي|اركض|نركض|ندرس سوا|اتعرف|نتعرف|نقعد|اسهر|نسهر)(?= |$)`), side: 'join', conf: 0.9, tag: 'want_activity' },
  { re: /(?:^| )(?:مين|حدا|في حدا|فيه حدا|شو رايكن|مين معي) (?:بدو|حابب|بحب|بيحب|جاي|بيجي|فاضي|بيلعب|يلعب|يطلع|بيطلع|معي|معنا)(?= |$)/, side: 'join', conf: 0.9, tag: 'who_joins' },
  // ad-style openings: "للبيع سيارة…", "للإيجار بيت…", "بيع لابتوب…", "معروض للبيع"
  { re: /^(?:للبيع|للايجار|للاجار|للتاجير|بيع|معروض للبيع|معروض|عرض خاص)(?= )/, side: 'provide', conf: 0.9, tag: 'ad_opening' },
  // seekers asking around: "مين بيعرف…", "مين بيعطي…", "في حدا بأجّر…؟", "أحتاج إلى…"
  { re: /(?:^| )(?:مين بيعرف|مين بيعطي|مين بيصلح|مين عنده|مين عندو|في حدا ب\S+|فيه حدا ب\S+|احتاج|نحتاج|احتاج الي)(?= |$)/, side: 'seek', conf: 0.9, tag: 'asking_around' },
  // volunteering / offering help: "أرغب بالتطوع لتعليم…", "متطوعة، بقدر ساعد…", "بساعد كبار السن…"
  { re: new RegExp(`(?:^| )(?:(?:${WANT}|ارغب) (?:ب|في )?(?:التطوع|اتطوع|بالتطوع)|متطوع|متطوعه|متطوعين|بتطوع|بقدر ساعد|بقدر اساعد|منقدر نساعد|بساعد|منساعد)(?= |$)`), side: 'provide', conf: 0.9, tag: 'volunteer' },
  { re: /(?:^| )(?:مين بيقدر|مين فيه|مين بيساعد|مين يساعد|حدا يساعد\S*|ساعدوني|ساعدونا|ساعدني|بحاجه لمساعده|محتاج مساعده|بحتاج مساعده)(?= |$)/, side: 'seek', conf: 0.9, tag: 'asking_help' },
  // a profession introducing itself with availability/experience/price: "سباك بالباب، جاهز ٢٤ ساعة"
  { re: new RegExp(`^(?:${PROFESSIONS})(?: \\S+){0,4} (?:جاهز|جاهزه|خبره|متوفر|متوفره|بروح|بخدم|منخدم|الكشفيه|الحلقه|بشتغل|عالبيوت|للبيوت)`), side: 'provide', conf: 0.9, tag: 'profession_ad' },

  { re: /(?:^| )[وف]?(?:عندي|عنا|عندنا|لدي|لدينا|متوفر|متوفره|يتوفر|ببيع|منبيع|عم بيع|ابيع|نبيع|بنبيع|باجر|باجرها|باجره|منأجر|منجر|بعطي|منعطي|اعطي|نعطي|بقدم|نقدم|اقدم|بدرس|بعلم|بصلح|منصلح|بشتغل|بخدم|منخدم|معروض|نعرض|اعرض|بنضف|بنظف|منضف|بركب|منركب|بعمل|منعمل|بنقل|منقل|بدهن|بصور|بترجم|بطبخ|بخيط)(?= |$)/, side: 'provide', conf: 0.85, tag: 'have' },
  { re: new RegExp(`(?:^| )(?:${WANT}|ابحث|نبحث|عم دور|عم ندور|عم فتش|بدور|بفتش|دورلي|مطلوب|حدا عنده|مين عنده|في حدا عنده|في حدا|عندكم|عندك|في عندكم|بشتري|منشتري)(?= |$)`), side: 'seek', conf: 0.85, tag: 'want' },
];

function detectSide(norm: string): Candidate<Side> | null {
  // specific patterns (first 6) win outright; generic have/want resolved by earliest position
  const nSpecific = SIDE_RULES.length - 2;
  for (const r of SIDE_RULES.slice(0, nSpecific)) {
    const m = r.re.exec(norm);
    if (m) return { value: r.side, confidence: r.conf, evidence: m[0].trim(), explicit: true };
  }
  const generic = SIDE_RULES.slice(nSpecific)
    .map((r) => ({ r, m: r.re.exec(norm) }))
    .filter((x) => x.m)
    .sort((a, b) => a.m!.index - b.m!.index);
  if (!generic.length) {
    // ad-style "شقة للإيجار بإعزاز ..." without any verb → most likely an offer (not explicit)
    const ad = /(?:^| )(?:للبيع|للايجار|للاجار|للتاجير|للكري)(?= |$)/.exec(norm);
    return ad ? { value: 'provide', confidence: 0.65, evidence: ad[0].trim(), explicit: false } : null;
  }
  // "عندنا ولاد", "عندي مصاري" describe the speaker, not an offer; "بدي ياها لعيلة" is about the counterpart, not a request
  const real = generic.filter((x) => {
    const after = norm.slice(x.m!.index + x.m![0].length).trim().split(' ').slice(0, 2).join(' ');
    if (x.r.side === 'provide') return !/^(ولاد|اولاد|ولادي|عيله|اطفال|ولد|بنت|بنات|مشكله|سؤال|حاجه|ظرف|مريض|مريضه|مصاري|فلوس|ميزانيه|مبلغ|\d+ (?:سجاد|قطع|غرض))/.test(after);
    return !/^(ياها|ياه|اياها|اياه|ياهن)(?: |$)/.test(after);
  });
  const pool = real.length ? real : generic;
  const g = pool[0]!;
  return { value: g.r.side, confidence: pool.length > 1 ? 0.7 : g.r.conf, evidence: g.m![0].trim(), explicit: pool.length === 1 };
}

// ───────────── deal cues ─────────────
const RENT_RE = W('ايجار|اجار|الايجار|الاجار|للايجار|للاجار|بالايجار|بالاجار|استاجر|نستاجر|مستاجر|تاجير|للتاجير|اجرها|اجره للشهر|كري|للكري|استيجار|استئجار|باجر|باجرها|باجره|منجر|ضمان|للضمان|بالضمان|اجره|اجرو|باجرو|ناجرو|مناجرو|استاجرو');
const RENT_OUT_RE = new RegExp(`(?:^| )(?:${WANT}) (?:اجر|نجر|نأجر)\\S*`);
const SALE_RE = W('للبيع|ابيع|بيع|نبيع|ببيع|منبيع|بيعها|بيعه|ابيعها|ابيعه|اشتري|نشتري|شراء|للشراء|بالشراء|شري|شرا|تمليك|ملك|مشتري|ينباع|بشتري|منشتري|اشتريها|اشتريه|بنبيع|بيعو|ابيعو|نبيعو|ببيعو|منبيعو|بنبيعو');
const MONTHLY_RE = W('بالشهر|شهري|شهريا|شهريه|كل شهر|الشهر');

function detectDeal(reg: Registry, norm: string, categoryCode: string | null): Candidate<DealCode> | null {
  const cat = categoryCode ? reg.categoryByCode.get(categoryCode) : undefined;
  if (cat && cat.deals.length === 1) return { value: cat.deals[0]!, confidence: 0.99, evidence: cat.nameAr, explicit: true };
  const allowed = new Set<DealCode>(cat ? cat.deals : ['sale', 'rent']);
  const rent = RENT_RE.exec(norm) ?? RENT_OUT_RE.exec(norm);
  const sale = SALE_RE.exec(norm);
  if (rent && allowed.has('rent') && !(sale && sale.index < rent.index && allowed.has('sale') && !RENT_OUT_RE.test(norm))) {
    return { value: 'rent', confidence: 0.95, evidence: rent[0].trim(), explicit: true };
  }
  if (sale && allowed.has('sale')) return { value: 'sale', confidence: 0.95, evidence: sale[0].trim(), explicit: true };
  if (allowed.has('rent') && cat?.verticalCode === 'real_estate') {
    // a price "per month" or a stay "for six months" on a property states a rental (not a guess)
    const m = /(?:^| )(?:ب|بـ)?\S*\d\S* (?:\S+ )?(?:بالشهر|شهريا|بالسنه|سنويا)(?= |$)/.exec(norm) ?? /(?:^| )(?:لمده|مده|لفتره) (?:\S+ )?(?:شهر|شهرين|شهور|اشهر|سنه|سنتين)(?= |$)/.exec(norm);
    if (m) return { value: 'rent', confidence: 0.9, evidence: m[0].trim(), explicit: true };
    const w = MONTHLY_RE.exec(norm);
    if (w) return { value: 'rent', confidence: 0.6, evidence: w[0].trim(), explicit: false };
  }
  return null;
}

// ───────────── strictness cues ─────────────
const REQUIRED_CUES = new Set(['فقط', 'بس', 'حصرا', 'حصري', 'حصريا', 'لازم', 'ضروري', 'شرط', 'بشرط', 'تحديدا', 'بالذات', 'اكيد', 'ضرورى', 'الزامي']);
const PRE_REQUIRED = new Set(['فقط', 'حصرا', 'حصريا', 'لازم', 'ضروري', 'شرط', 'بشرط', 'الزامي', 'اكيد', 'تحديدا', 'المهم']);
const POST_REQUIRED = new Set(['فقط', 'بس', 'حصرا', 'حصريا', 'تحديدا', 'بالذات']);
const PREFERRED_CUES = new Set(['يفضل', 'بفضل', 'افضل', 'مفضل', 'ياريت', 'حبذا', 'احسن', 'يستحسن', 'بحب', 'منيح', 'لو']);
const CLAUSE_START = /^(لازم|تكون|يكون|مو|مش|ما|بدي|بدنا|يجي|يكونو|ضروري|الله|المهم|يعني)$/;
const NEG_BEFORE = new Set(['مو', 'مش', 'بلا', 'بدون', 'ماعدا', 'عدا', 'غير']);

function strengthNear(tokens: string[], start: number, end: number, before = 3, after = 2): Strength | null {
  // "ما بدي غير إعزاز" / "ما بدي الا بإعزاز" → required
  for (let k = Math.max(0, start - 3); k < start; k++) {
    if ((tokens[k] === 'غير' || tokens[k] === 'الا') && tokens.slice(Math.max(0, k - 3), k).some((t) => t === 'ما' || t === 'مو' || t === 'مش' || t === 'بدي')) return 'required';
  }
  // cue words may carry an attached و/ف ("ويفضل", "وبس")
  const strip = (t: string) => (/^[وف]/.test(t) && t.length > 3 ? t.slice(1) : t);
  const preToks = tokens.slice(Math.max(0, start - before), start).map(strip);
  const postToks = tokens.slice(end, end + after).map(strip);
  // after the mention only "only"-markers count, and "بس" must not open a new clause ("بس لازم…" = "but")
  const post0 = postToks[0];
  if (post0 && POST_REQUIRED.has(post0) && !(post0 === 'بس' && CLAUSE_START.test(postToks[1] ?? ''))) return 'required';
  if (preToks.length && preToks[preToks.length - 1] === 'بس') return 'required'; // "بس بإعزاز"
  if (preToks.some((t) => PRE_REQUIRED.has(t))) return 'required';
  if (/(?:^| )بس (?:تكون|يكون|بتكون|بيكون)(?: |$)/.test(preToks.join(' '))) return 'required';
  // "اذا في/اذا ممكن" (if possible) before, or "إذا بيصير" right after
  const pre = preToks.join(' ');
  const post = postToks.join(' ');
  if (/(?:^| )(?:اذا|إذا) (?:في|ممكن|بيصير|امكن)(?: |$)/.test(pre) || /(?:^| )يا ريت(?: |$)/.test(pre)) return 'preferred';
  if (/^(?:اذا|لو) (?:بيصير|ممكن|امكن|في)/.test(post)) return 'preferred';
  if (preToks.some((t) => PREFERRED_CUES.has(t))) return 'preferred';
  return null;
}

function negatedBefore(tokens: string[], start: number): boolean {
  const p1 = tokens[start - 1];
  const p2 = tokens[start - 2];
  if (p1 && NEG_BEFORE.has(p1)) {
    if (p1 === 'غير' && p2 && (p2 === 'ما' || p2 === 'مو' || p2 === 'مش' || p2 === 'بدي')) return false; // "ما بدي غير X" = only X
    return true;
  }
  if (p1 && /^(مو|مش)ب?$/.test(p1)) return true;
  // the place token itself may carry "مو" attached? (rare) — also "بدي بغير X"
  const tok = tokens[start] ?? '';
  return tok.startsWith('بغير');
}

// Common words that are also place names: require a locative cue (ب/في/من/ل/مدينة/منطقة) to count.
const AMBIGUOUS_PLACES = new Set(['الباب', 'باب', 'الراعي', 'الدانا', 'الجسر', 'المعره', 'الدير', 'الشام', 'دانا']);

// ───────────── money cues ─────────────
const CURRENCY_WORDS: { re: RegExp; cur: Currency | 'LIRA' }[] = [
  { re: /^(\$|دولار|دولارات|دولارا|الدولار|بالدولار|دولار امريكي|usd|dollar|dollars|ددولار|دولاري|دولارين)$/, cur: 'USD' },
  { re: /^(تركي|تركيه|try|tl|بالتركي)$/, cur: 'TRY' },
  { re: /^(سوري|سوريه|syp|بالسوري|ل س)$/, cur: 'SYP' },
  { re: /^(يورو|€|eur|euro|باليورو)$/, cur: 'EUR' },
  { re: /^(ليره|ليرات|الليره|بالليره|لira)$/, cur: 'LIRA' },
];
const UNIT_WORDS: { re: RegExp; unit: PriceUnit }[] = [
  { re: /^(بالشهر|شهري|شهريا|شهريه|الشهري|الشهريه|الشهر|للشهر|عالشهر)$/, unit: 'month' },
  { re: /^(بالسنه|سنوي|سنويا|سنويه|السنوي|السنويه|السنه|للسنه|عالسنه)$/, unit: 'year' },
  { re: /^(بالاسبوع|اسبوعي|اسبوعيا|الاسبوعي|للاسبوع)$/, unit: 'week' },
  { re: /^(باليوم|يومي|يوميا|اليومي|اليوم|لليوم|عاليوم|بالليله|لليله|الليله|ليله|الليلة)$/, unit: 'day' },
  { re: /^(بالساعه|للساعه|ساعه|الساعه|عالساعه)$/, unit: 'hour' },
  { re: /^(للحصه|بالحصه|الحصه|حصه|للدرس|بالدرس|الدرس|للجلسه|بالجلسه|الجلسه)$/, unit: 'session' },
  { re: /^(للشخص|عالشخص|بالشخص|الشخص|للنفر|عالنفر|النفر|للراس)$/, unit: 'person' },
  { re: /^(للدوره|بالدوره|للكورس|بالكورس)$/, unit: 'total' },
];
// free of charge: a price of exactly 0 with no currency
const FREE_RE = /(?:^| )(ببلاش|مجانا|مجاني|مجانيه|بالمجان|مجانًا)(?= |$)/;
const PRICE_CONTEXT = new Set(['سعر', 'سعرها', 'سعره', 'بسعر', 'السعر', 'ثمن', 'ثمنها', 'حق', 'حقها', 'حقه', 'ادفع', 'بدفع', 'ندفع', 'ميزانيه', 'ميزانيتي', 'ميزانيتنا', 'معي', 'معنا', 'بقدر', 'بحدود', 'حدود', 'اجره', 'اجرتها', 'كلفه', 'تكلفه', 'قيمه', 'مبلغ', 'مطلوب']);

interface OpCue { op: PriceSpec['op']; strict?: 'lt' | 'gt'; strength: Strength; text: string }
function opBefore(tokens: string[], start: number): OpCue | null {
  const pre = tokens.slice(Math.max(0, start - 5), start).join(' ');
  const tests: [RegExp, OpCue][] = [
    [/(حد اقصي|الحد الاقصي|اقصي شي|اقصي حد|كحد اقصي|ما بدي اكتر من|ما بدي اكثر من|مو اكتر من|مش اكتر من|مو اكثر من|ما يزيد عن|ما يتجاوز|لا يتجاوز|لا يزيد عن|ما تتعدي|ما يتعدي|لا تتعدي|لحد|لغايه|حتي|ميزانيتي|ميزانيه|ميزانيتنا|معي|معنا|بقدر ادفع|قدرتي)\s*\S{0,2}$/, { op: 'lte', strength: 'required', text: '' }],
    // negated "less than" = at least: "مو أقل من ٣٠٠٠", "ما بأجرها بأقل من ٢٠٠" (tested before plain "أقل من")
    [/(?:^| )[وف]?(?:ما|مو|مش|لا)(?: \S+){0,2} (?:ب?اقل من|ب?ادني من|تحت)\s*\S{0,2}$/, { op: 'gte', strength: 'required', text: '' }],
    [/(علي الاقل|عالاقل|بالحد الادني|الحد الادني|مو اقل من|مش اقل من|ما يقل عن|لا يقل عن|من فوق)\s*\S{0,2}$/, { op: 'gte', strength: 'required', text: '' }],
    [/(اقل من|تحت|دون|ادني من)\s*\S{0,2}$/, { op: 'lte', strict: 'lt', strength: 'required', text: '' }],
    // negated "more than" = at most: "وما بدي أدفع أكتر من ٢٠٠", "وما منقدر ندفع أكتر من ١٢٠"
    [/(?:^| )[وف]?(?:ما|مو|مش|لا|ما منقدر|ما بقدر|ما فيني|ما فينا)(?: \S+){0,2} (?:اكتر من|اكثر من|فوق|يزيد عن|يتجاوز)\s*\S{0,2}$/, { op: 'lte', strength: 'required', text: '' }],
    [/(اكتر من|اكثر من|فوق)\s*\S{0,2}$/, { op: 'gte', strict: 'gt', strength: 'required', text: '' }],
    [/(حوالي|تقريبا|بحدود|حدود|حول|قرابه|شي|يعني)\s*\S{0,2}$/, { op: 'approx', strength: 'preferred', text: '' }],
  ];
  for (const [re, cue] of tests) {
    const m = re.exec(pre);
    if (m) return { ...cue, text: m[0].trim() };
  }
  return null;
}
const EQ_RE = /^(بالضبط|بالزبط|بالظبط|تماما|بالتمام|مضبوط|بالتحديد|مقطوع|ثابت|نهائي)$/;
const NEGOTIABLE_RE = /(قابل للتفاوض|قابله للتفاوض|فيه مجال|فيها مجال|بنتفاهم|منتفاهم|علي الفحص|قابل للنقاش|بنحكي|في مجال)/;

// ───────────── attributes ─────────────
const ROOMS_RE = /^(غرف|غرفه|غرفة|اوض|اوضه|غرفتين|اوضتين|غرفنوم)$/;
const FLOOR_WORDS: Record<string, number> = { ارضي: 0, الارضي: 0, اول: 1, الاول: 1, اولي: 1, تاني: 2, ثاني: 2, التاني: 2, الثاني: 2, تالت: 3, ثالث: 3, التالت: 3, الثالث: 3, رابع: 4, الرابع: 4, خامس: 5, الخامس: 5, اخير: -1, الاخير: -1 };

export function parseUtterance(reg: Registry, text: string, opts: ParseOptions = {}): RuleParse {
  const now = opts.now ?? new Date();
  const normalized = normalizeAr(text);
  const tokens = tokensOf(normalized);
  const norm = tokens.join(' ');
  const consumed = new Set<number>();
  const mark = (s: number, e: number) => { for (let k = s; k < e; k++) consumed.add(k); };

  // ── categories
  // "الأرضي" (ground floor) must not become "أرض" (land)
  const catHits = matchPhrases(tokens, reg.categoryPhrases, 4, (h) => /^(ال|بال)?ارضي(ه)?$/.test(tokens[h.start]!) && h.end - h.start === 1);
  const repairCue = /(?:^| )(?:يصلح\S*|بيصلح\S*|بصلح|تصليح|صيانه|خربان\S*|معطل\S*|عطلان\S*|عطل|بتصلح|يزبط\S*|تزبيط|فني)(?= |$)/.test(norm) && !SALE_RE.test(norm) && !RENT_RE.test(norm);
  // hiring a person ("بدي حدا ينضّف البيت") — the house is the object, not the request
  const wantsPerson = /(?:^| )[وف]?(?:بدي|بدنا|محتاج|بحاجه|مطلوب) (?:حدا|احد|شخص|واحد|فني|معلم|كهربجي|سباك)(?= |$)/.test(norm) || /^(?:بنضف|بنظف|بصلح|بركب|بعمل|بدهن)(?= |$)/.test(norm);
  const scored = new Map<string, { score: number; evidence: string; pos: number }>();
  for (const h of catHits) {
    let code = h.value;
    if (repairCue) {
      if (code === 'goods.appliances') code = 'services.appliance_repair';
      else if (code === 'goods.electronics') code = 'services.it_repair';
      else if (code.startsWith('vehicles')) code = 'services.car_repair';
    }
    let cat = reg.categoryByCode.get(code)!;
    // a root with a single child ("مساعدة" → help.general) resolves to that child
    if (cat.depth === 0) { const kids = reg.categories.filter((c) => c.parent === cat.code); if (kids.length === 1) { cat = kids[0]!; code = cat.code; } }
    let score = 0.55 + 0.1 * Math.min(h.end - h.start, 3) + (cat.depth >= 1 ? 0.1 : 0);
    if (wantsPerson && (cat.verticalCode === 'real_estate' || cat.verticalCode === 'goods' || cat.verticalCode === 'vehicles')) score -= 0.25;
    const prev = scored.get(code);
    if (!prev || prev.score < score) scored.set(code, { score: Math.min(score, 0.95), evidence: h.phrase, pos: prev ? Math.min(prev.pos, h.start) : h.start });
    mark(h.start, h.end);
  }
  if (opts.categoryHint && !scored.size) {
    // answering a follow-up: keep the conversation's category
  }
  // Attribute values can imply a category ("رياضيات" → tutoring, "غسالة" with repair cue handled above)
  const attrHits = matchPhrases(tokens, reg.attrValuePhrases, 3);
  if (!scored.size) {
    for (const h of attrHits) {
      for (const v of h.value) {
        const cat = reg.categoryByCode.get(v.category);
        if (!cat) continue;
        const code = cat.depth === 0 ? reg.categories.find((c) => c.parent === cat.code)?.code ?? cat.code : cat.code;
        if (!scored.has(code)) scored.set(code, { score: 0.5, evidence: h.phrase, pos: h.start });
      }
    }
  }
  const categories: Candidate<string>[] = [...scored.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].pos - b[1].pos)
    .map(([code, s], i, arr) => ({
      value: code,
      confidence: s.score,
      evidence: s.evidence,
      explicit: i === 0 && (arr.length === 1 || arr[0]![1].score - arr[1]![1].score >= 0.1 || sameFamily(arr.map((x) => x[0]))),
    }));
  const topCat = categories[0]?.value ?? opts.categoryHint ?? null;

  // ── side
  let side = detectSide(norm);
  const topCatObj = topCat ? reg.categoryByCode.get(topCat) : undefined;
  if (topCatObj?.relation === 'peer' && side?.value !== 'join') {
    side = { value: 'join', confidence: 0.9, evidence: topCatObj.nameAr, explicit: true };
  }

  // ── deal
  const deal = detectDeal(reg, norm, topCat);

  // ── places
  const placeHits = matchPhrases(tokens, reg.placePhrases, 4, (h) => {
    if (opts.answering === 'place') return false;
    if (!AMBIGUOUS_PLACES.has(h.phrase) && !AMBIGUOUS_PLACES.has(tokens[h.start]!)) return false;
    const prev = tokens[h.start - 1];
    const locative = /^(ب|في|من|ل|مدينه|منطقه|بمدينه|ريف|عند|قرب|جنب|سوق|بسوق|حي|بحي)$/.test(prev ?? '') || /^(ب|بال|في|فال|من)/.test(tokens[h.start]!);
    return !locative;
  });
  const places: PlaceMention[] = [];
  for (const h of placeHits) {
    if (h.value === reg.rootPlaceId) {
      places.push({ placeId: h.value, evidence: h.phrase, strength: 'preferred', negated: false });
    } else {
      places.push({ placeId: h.value, evidence: h.phrase, strength: strengthNear(tokens, h.start, h.end), negated: negatedBefore(tokens, h.start) });
    }
    mark(h.start, h.end);
  }

  // ── numbers → classify context (rooms/floor/year/mileage/group/area/time) vs price
  const nums = findNumbers(tokens);
  let radius: RuleParse['radius'] = null;
  const prices: PriceCandidate[] = [];
  const priceSure: boolean[] = []; // parallel to prices: had a currency, a price word, a range or an operator
  const attrMentions: AttrMention[] = [];
  const usedNum = new Set<number>();
  const vertical = topCatObj?.verticalCode ?? null;

  for (let ni = 0; ni < nums.length; ni++) {
    const n = nums[ni]!;
    const next = tokens[n.end] ?? '';
    const next2 = tokens[n.end + 1] ?? '';
    const prev = tokens[n.start - 1] ?? '';
    const whole = n.cents / 100n;
    const isInt = n.cents % 100n === 0n;
    const ev = tokens.slice(Math.max(0, n.start - 1), n.end + 1).join(' ');
    if (ROOMS_RE.test(next) || next === 'نوم') {
      const atLeast = /^(علي|عالاقل|الاقل)$/.test(tokens[n.start - 1] ?? '') || /(علي الاقل|عالاقل|وفوق|واكتر|وطالع)/.test(tokens.slice(n.start - 2, n.end + 3).join(' '));
      attrMentions.push({ key: 'rooms', op: atLeast ? 'gte' : 'eq', value: Number(whole), strength: strengthNear(tokens, n.start, n.end + 1), evidence: ev, about: 'either' });
      usedNum.add(ni); mark(n.start, n.end + 1); continue;
    }
    if (/^(طابق|الطابق|بالطابق|طابقها|ط)$/.test(prev)) {
      attrMentions.push({ key: 'floor', op: 'eq', value: Number(whole), strength: strengthNear(tokens, n.start - 1, n.end), evidence: ev, about: 'either' });
      usedNum.add(ni); mark(n.start - 1, n.end); continue;
    }
    if (/^(متر|م|مربع|م2|مترمربع|دونم|دنم)$/.test(next)) {
      const factor = /دونم|دنم/.test(next) ? 1000n : 1n;
      const pre = tokens.slice(Math.max(0, n.start - 4), n.start).join(' ');
      const prevNum = nums[ni - 1];
      if (prevNum && !usedNum.has(ni - 1) && /^(و|الي|ل)?$/.test(tokens.slice(prevNum.end, n.start).join(' ')) && /(^| )بين( |$)/.test(tokens.slice(Math.max(0, prevNum.start - 2), prevNum.start).join(' '))) {
        attrMentions.push({ key: 'area_m2', op: 'between', lo: Number((prevNum.cents / 100n) * factor), hi: Number(whole * factor), strength: strengthNear(tokens, prevNum.start, n.end + 1), evidence: tokens.slice(prevNum.start - 1, n.end + 1).join(' '), about: 'either' });
        usedNum.add(ni - 1); usedNum.add(ni); mark(prevNum.start, n.end + 1); continue;
      }
      const atLeast = /(علي الاقل|ما تقل عن|ما يقل عن|مو اقل من|لا تقل عن|لا يقل عن|اقل شي)\s*\S{0,3}$/.test(pre);
      attrMentions.push({ key: 'area_m2', op: atLeast ? 'gte' : 'eq', value: Number(whole * factor), strength: strengthNear(tokens, n.start, n.end + 1), evidence: ev, about: 'either' });
      usedNum.add(ni); mark(n.start, n.end + 1); continue;
    }
    // distance from me: "ضمن 5 كم", "ما يبعد أكتر من 3 كيلو", "تبعد عني مسافة 2 كم", "بحدود 500 متر"
    if (/^(كم|كيلو|كيلومتر|كيلومترات|كيلومترا|km|متر|م)$/.test(next)) {
      const pre = tokens.slice(Math.max(0, n.start - 5), n.start).join(' ');
      if (/(ضمن|بنطاق|نطاق|قطر|يبعد|تبعد|بعد|بعيد|بعيده|مسافه|حوالي|بحدود|قريب)/.test(pre) && !/(ماشيه|ماشي|مقطوعه|عداد|مشيها)/.test(pre)) {
        const km = /^(متر|م)$/.test(next) ? Number(n.cents) / 100 / 1000 : Number(n.cents) / 100;
        const required = /(ضمن|بنطاق|نطاق|ما يبعد|ما تبعد|لا يبعد|لا تبعد|ما بدي ابعد|مو ابعد|حد اقصي|اكتر من|اكثر من|اقصي)/.test(pre);
        if (km > 0 && km <= 500) radius = { km, strength: required ? 'required' : 'preferred', evidence: tokens.slice(Math.max(0, n.start - 3), n.end + 1).join(' ') };
        usedNum.add(ni); mark(n.start, n.end + 1); continue;
      }
    }
    if (/^(كم|كيلو|كيلومتر|km)$/.test(next) && vertical === 'vehicles') {
      attrMentions.push({ key: 'mileage_km', op: 'lte', value: Number(whole), strength: strengthNear(tokens, n.start, n.end + 1), evidence: ev, about: 'either' });
      usedNum.add(ni); mark(n.start, n.end + 1); continue;
    }
    if (isInt && whole >= 1950n && whole <= 2030n && (/^(موديل|موديلها|موديله|صنع|سنه|تصنيع|م)$/.test(prev) || (vertical === 'vehicles' && !isCurrencyAt(tokens, n.end)))) {
      const op = /^(فوق|بعد|من)$/.test(prev) || /^(وفوق|وطالع|ومافوق)$/.test(next) ? 'gte' : 'eq';
      attrMentions.push({ key: 'year', op, value: Number(whole), strength: strengthNear(tokens, n.start, n.end), evidence: ev, about: 'either' });
      usedNum.add(ni); mark(n.start, n.end); continue;
    }
    if (/^(شخص|اشخاص|نفر|انفار|شباب|بنات|اصحاب|رفقات)$/.test(next) || /^(عددنا|نحن|احنا|نحنا)$/.test(prev)) {
      attrMentions.push({ key: 'group_size', op: 'eq', value: Number(whole), strength: null, evidence: ev, about: 'self' });
      usedNum.add(ni); mark(n.start, n.end + 1); continue;
    }
    if ((/^(الساعه|ساعه)$/.test(prev) && !isCurrencyAt(tokens, n.end)) || /^(الصبح|المسا|العصر|الظهر|صباحا|مساء)$/.test(next)) { usedNum.add(ni); continue; }
    if (/^(اشهر|شهور|اشهور|شهر|سنه|سنين|سنتين)$/.test(next) && /^(لمده|مده|لفتره|اقل شي|اقل|علي الاقل|ل)$/.test(prev)) {
      const months = /سنه|سنين|سنتين/.test(next) ? Number(whole) * 12 : Number(whole);
      const atLeastM = /اقل|الاقل/.test(prev) || /^(علي|عالاقل)$/.test(tokens[n.end + 1] ?? '');
      attrMentions.push({ key: 'rental_months', op: atLeastM ? 'gte' : 'eq', value: months, strength: strengthNear(tokens, n.start, n.end + 1), evidence: ev, about: atLeastM ? 'counterpart' : 'self' });
      usedNum.add(ni); mark(n.start, n.end + 1); continue;
    }
    if (/^\d{7,}$/.test(tokens[n.start]!)) { usedNum.add(ni); continue; } // phone-like: ignore (privacy)
  }

  // remaining numbers → price candidates
  for (let ni = 0; ni < nums.length; ni++) {
    if (usedNum.has(ni)) continue;
    const n = nums[ni]!;
    // between: "بين X و Y" / "من X ل/الي Y" / "X الي Y"
    const after = nums[ni + 1];
    const link = after && !usedNum.has(ni + 1) ? tokens.slice(n.end, after.start).join(' ') : null;
    const prevTok = tokens[n.start - 1] ?? '';
    const isBetween = after && link !== null && (/^(و|الي|ل|لل|حتي|لـ)$/.test(link) || (link === '' && tokens[after.start]!.startsWith('و'))) &&
      (/^(بين|من|ما بين)$/.test(prevTok) || link === 'الي');
    const lastEnd = isBetween ? after!.end : n.end;
    const cu = currencyAndUnit(tokens, lastEnd, n.start);
    const { currency, end } = cu;
    let unit = cu.unit;
    if (!unit) {
      // unit stated before the amount: "بالأسبوع، ٧٠ دولار" / "بالسنة بألف دولار" / "والحصة ما تتعدى ١٥٠" / "اليوم بـ ٣٠ دولار"
      for (let k = n.start - 1; k >= Math.max(0, n.start - 4); k--) {
        if (nums.some((o) => o !== n && k >= o.start && k < o.end) || /^(الكشف|الكشفيه|كشفيه)$/.test(tokens[k]!)) break; // the unit belongs to another number / fee
        const t = /^[وف]/.test(tokens[k]!) && tokens[k]!.length > 4 ? tokens[k]!.slice(1) : tokens[k]!;
        const u = UNIT_WORDS.find((x) => x.re.test(t));
        // "اليوم" is "today" unless it directly introduces the amount ("اليوم بـ ٣٠")
        if (u && !(u.unit === 'day' && t === 'اليوم' && !(k === n.start - 1 || (k === n.start - 2 && prevTok === 'ب')))) { unit = u.unit; break; }
      }
    }
    let curr = currency;
    if (!curr) {
      // currency stated before the amount: "بالتركي حد أقصى ٤٠٠ ألف" (only explicit بال… forms, never "أستاذ تركي")
      for (let k = n.start - 1; k >= Math.max(0, n.start - 4); k--) {
        const t = tokens[k]!;
        if (/^بال/.test(t) || t === '$') { const c = CURRENCY_WORDS.find((x) => x.re.test(t)); if (c) { curr = c.cur; break; } }
      }
    }
    const ctx = PRICE_CONTEXT.has(prevTok) || PRICE_CONTEXT.has(tokens[n.start - 2] ?? '') || /^ب$/.test(prevTok) || prevTok === '$';
    if (!curr && !unit && !ctx && !isBetween && !opBefore(tokens, n.start)) continue; // a bare number we can't interpret
    const cue = isBetween ? null : opBefore(tokens, n.start);
    let lo: bigint | null = n.cents;
    let hi: bigint | null = n.cents;
    let op: PriceSpec['op'] | null = null;
    let opExplicit = false;
    let strength: Strength | null = null;
    if (isBetween) {
      let first = n.cents;
      const mult = /(?:^| )و?(الف|الاف|مليون|ملايين)(?: |$)/.exec(after!.text)?.[1];
      if (mult && !/(الف|الاف|مليون|ملايين|الفين)/.test(n.text)) first *= mult.startsWith('مل') ? 1_000_000n : 1000n;
      lo = first < after!.cents ? first : after!.cents;
      hi = first < after!.cents ? after!.cents : first;
      op = 'between'; opExplicit = true; strength = 'required';
      usedNum.add(ni + 1);
    } else if (cue) {
      op = cue.op; opExplicit = true; strength = cue.strength;
      if (cue.op === 'lte') { lo = null; if (cue.strict === 'lt') hi = n.cents - 1n; }
      if (cue.op === 'gte') { hi = null; if (cue.strict === 'gt') lo = n.cents + 1n; }
    }
    const tail = tokens.slice(lastEnd, end + 2);
    if (tail.some((t) => EQ_RE.test(t)) || tokens.slice(Math.max(0, n.start - 2), n.start).some((t) => EQ_RE.test(t))) {
      op = 'eq'; lo = n.cents; hi = n.cents; opExplicit = true; strength = 'required';
    }
    const near = strengthNear(tokens, n.start, end, 3, 3);
    if (near) strength = near === 'required' || !strength ? near : strength;
    priceSure.push(!!curr || ctx || isBetween || opExplicit);
    prices.push({
      lo: lo === null ? null : lo.toString(),
      hi: hi === null ? null : hi.toString(),
      currency: curr === 'LIRA' ? null : curr,
      unit,
      op,
      opExplicit,
      strength,
      evidence: tokens.slice(Math.max(0, n.start - (cue ? 2 : 1)), end).join(' '),
    });
    mark(n.start, end);
    usedNum.add(ni);
    if (curr === 'LIRA') prices[prices.length - 1]!.evidence += ' (ليرة)';
  }
  // "جاهز ٢٤ ساعة، الكشفية ٥ دولار": a bare "number + unit" is a duration, not a price, when a real price exists
  if (prices.some((p, i) => priceSure[i] && p.currency)) {
    for (let i = prices.length - 1; i >= 0; i--) if (!priceSure[i] && !prices[i]!.currency) { prices.splice(i, 1); priceSure.splice(i, 1); }
  }
  // free of charge: "ببلاش", "الحلقة مجانية"
  // (not for volunteer help — free by definition — nor for a free part like "الكشف ببلاش")
  const free = !prices.length && vertical !== 'help' ? FREE_RE.exec(norm) : null;
  const freeIdx = free ? tokens.indexOf(free[1]!) : -1;
  if (free && !/^(الكشف|الكشفيه|كشفيه|التوصيل|المعاينه)$/.test(tokens[freeIdx - 1] ?? '')) prices.push({ lo: '0', hi: '0', currency: null, unit: null, op: 'eq', opExplicit: true, strength: null, evidence: free[1]! });

  // ── attribute words (enum values), floors, furnished, solar, tenant type
  const attrsAllowed = topCat ? new Set(attributesFor(reg, topCat).map((a) => a.key)) : null;
  for (const h of attrHits) {
    for (const v of h.value) {
      if (attrsAllowed && !attrsAllowed.has(v.key)) continue;
      if (!attrsAllowed && v.category !== (topCat ?? v.category)) continue;
      if (attrMentions.some((m) => m.key === v.key && m.value === v.code)) continue;
      const neg = negatedBefore(tokens, h.start);
      const about = v.key === 'tenant_type' ? tenantAbout(tokens, h.start) : 'either';
      attrMentions.push({ key: v.key, op: neg ? 'neq' : 'eq', value: v.code, strength: strengthNear(tokens, h.start, h.end), evidence: h.phrase, about });
      mark(h.start, h.end);
    }
  }
  // vehicle model: word right after the make ("كيا ريو")
  const makeMention = attrMentions.find((m) => m.key === 'make');
  if (makeMention && vertical === 'vehicles') {
    const idx = tokens.findIndex((t, k) => !consumed.has(k + 1) && tokenVariants(t).some((v) => normalizeAr(String(makeMention.evidence)) === v));
    const model = idx >= 0 ? tokens[idx + 1] : undefined;
    if (model && /^[\p{L}\d-]{2,}$/u.test(model) && !reg.placePhrases.has(model) && !/^(موديل|للبيع|للايجار|بحاله|نظيفه|حلوه|او|و|بيكون|يكون|تكون|بتكون|كان|بس|اذا|مستعمل|مستعمله|جديد|جديده|نظيف|رخيص|رخيصه|غالي|منيحه|منيح|احسن|افضل)$/.test(model) && !/^\d+$/.test(model)) {
      attrMentions.push({ key: 'model', op: 'eq', value: model, strength: null, evidence: `${makeMention.evidence} ${model}`, about: 'either' });
      mark(idx + 1, idx + 2);
    }
  }
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (/^(غرفتين|اوضتين|غرفتان)$/.test(t) && (vertical === 'real_estate' || topCat === null) && !attrMentions.some((m) => m.key === 'rooms')) {
      const atLeast = /(علي الاقل|ما تقل عن|ما يقل عن|مو اقل من|مش اقل من|لا تقل عن|اقل شي)$/.test(tokens.slice(Math.max(0, k - 3), k).join(' '));
      attrMentions.push({ key: 'rooms', op: atLeast ? 'gte' : 'eq', value: 2, strength: strengthNear(tokens, k, k + 1), evidence: t, about: 'either' });
      mark(k, k + 1);
      continue;
    }
    const floorAt = (j: number) => FLOOR_WORDS[tokens[j] ?? ''] ?? FLOOR_WORDS[(tokens[j] ?? '').replace(/^(بال|ال|ب)/, '')];
    if (/^(طابق|الطابق|بالطابق|بطابق)$/.test(t) && tokens[k + 1] && floorAt(k + 1) !== undefined) {
      const first = floorAt(k + 1)!;
      // "الأول أو الثاني" / "أرضي أو أول" → one of several floors
      const alt = /^(او|ولا)$/.test(tokens[k + 2] ?? '') ? floorAt(k + 3) : undefined;
      if (alt !== undefined) {
        attrMentions.push({ key: 'floor', op: 'in', values: [first, alt], strength: strengthNear(tokens, k, k + 4), evidence: tokens.slice(k, k + 4).join(' '), about: 'either' } as AttrMention & { values: number[] });
        mark(k, k + 4);
        k += 3;
        continue;
      }
      const neg = tokens.slice(Math.max(0, k - 2), k).some((x) => /^(مو|مش|غير|بلا|بدون|ومو)$/.test(x));
      attrMentions.push({ key: 'floor', op: neg ? 'neq' : 'eq', value: first, strength: neg ? null : strengthNear(tokens, k, k + 2), evidence: tokens.slice(Math.max(0, k - (neg ? 1 : 0)), k + 2).join(' '), about: 'either' });
      mark(k, k + 2);
    } else if (/^(ارضي|ارضيه|الارضي|بالارضي)$/.test(t) && (vertical === 'real_estate' || topCat === null) && !attrMentions.some((m) => m.key === 'floor')) {
      const neg = tokens.slice(Math.max(0, k - 2), k).some((x) => /^(مو|مش|غير|بلا|بدون|ومو)$/.test(x));
      attrMentions.push({ key: 'floor', op: neg ? 'neq' : 'eq', value: 0, strength: neg ? null : strengthNear(tokens, k, k + 1), evidence: tokens.slice(Math.max(0, k - 2), k + 1).join(' '), about: 'either' });
      mark(k, k + 1);
    } else if (/^(مفروشه|مفروش|بفرشها|بفرشه|فرش|عفش|بعفش|بعفشها|بالعفش|مع العفش)$/.test(t) && (vertical === 'real_estate' || topCat === null)) {
      const neg = /^(بدون|بلا|غير|مو|مش)$/.test(tokens[k - 1] ?? '');
      attrMentions.push({ key: 'furnished', op: 'eq', value: !neg, strength: strengthNear(tokens, k, k + 1), evidence: (neg ? tokens[k - 1] + ' ' : '') + t, about: 'either' });
      mark(k - (neg ? 1 : 0), k + 1);
    } else if (/^(فاضيه|فارغه|عالعضم|علي العظم)$/.test(t) && vertical === 'real_estate') {
      attrMentions.push({ key: 'furnished', op: 'eq', value: false, strength: strengthNear(tokens, k, k + 1), evidence: t, about: 'either' });
      mark(k, k + 1);
    } else if (/^(شمسيه|طاقه)$/.test(t) && vertical === 'real_estate' && /طاقه شمسيه|الواح|طاقه/.test(norm)) {
      if (!attrMentions.some((m) => m.key === 'solar')) attrMentions.push({ key: 'solar', op: 'eq', value: true, strength: strengthNear(tokens, k, k + 1), evidence: 'طاقة شمسية', about: 'either' });
      mark(k, k + 1);
    } else if (/^(اونلاين|اون|بعد)$/.test(t) && (vertical === 'education') && !attrMentions.some((m) => m.key === 'mode')) {
      // handled by attr words; nothing
    }
  }
  // a sale price is a total amount unless the user said otherwise
  if (deal?.value === 'sale') for (const pr of prices) pr.unit ??= 'total';
  // home visit: "يجي لعندي / يجي عالبيت" (seeker), "بروح عالبيوت" (provider)
  const HOME_VISIT_RE = /(?:^| )[وف]?(?:يجي|بيجي|تجي|يجيني|ييجي|بروح|منروح|بزور) (?:لعندي|عالبيت|للبيت|عالبيوت|للبيوت|لعنا|عندي|البيت|لعند)(?: |$)|زياره منزليه|بالبيت(?: |$)/;
  if (vertical === 'education' && HOME_VISIT_RE.test(norm) && !attrMentions.some((m) => m.key === 'mode')) {
    attrMentions.push({ key: 'mode', op: 'eq', value: 'in_person', strength: null, evidence: HOME_VISIT_RE.exec(norm)![0].trim(), about: 'either' });
  }
  if (vertical === 'services' && HOME_VISIT_RE.test(norm) && !attrMentions.some((m) => m.key === 'home_visit')) {
    const m = /(?:يجي|بيجي|تجي|يجيني|ييجي|بروح|منروح|بزور) \S+|زياره منزليه|بالبيت/.exec(norm)!;
    attrMentions.push({ key: 'home_visit', op: 'eq', value: true, strength: strengthNear(tokens, Math.max(0, tokens.indexOf(m[0].split(' ')[0]!)), tokens.indexOf(m[0].split(' ')[0]!) + 1), evidence: m[0], about: 'either' });
  }
  const grade = /(?:^| )(?:الصف|للصف|صف|بالصف) (\S+)/.exec(norm);
  if (grade && vertical === 'education' && !attrMentions.some((m) => m.key === 'level')) {
    const g = grade[1]!;
    const lvl = /^(الاول|التاني|الثاني|التالت|الثالث|الرابع|الخامس|السادس|[1-6])$/.test(g) ? 'primary' : /^(السابع|التامن|الثامن|التاسع|[7-9])$/.test(g) ? 'middle' : /^(العاشر|الحادي عشر|التاني عشر|البكالوريا|1[0-2])$/.test(g) ? 'secondary' : null;
    if (lvl) attrMentions.push({ key: 'level', op: 'eq', value: lvl, strength: null, evidence: grade[0].trim(), about: 'either' });
  }
  // "أونلاين" is already the place (point = online); don't double-count it as a mode preference
  if (places.some((p) => reg.placeById.get(p.placeId)?.kind === 'virtual')) {
    for (let i = attrMentions.length - 1; i >= 0; i--) if (attrMentions[i]!.key === 'mode' && attrMentions[i]!.value === 'online') attrMentions.splice(i, 1);
  }
  // rental duration without digits: "لمدة سنة", "شهر واحد", "العقد سنة على الأقل"
  if (vertical === 'real_estate' && !attrMentions.some((m) => m.key === 'rental_months')) {
    const dm = /(?:^| )(?:لمده|مده|لفتره|العقد|عقد) (سنه|سنتين|شهر|شهرين)(?: (علي الاقل|عالاقل))?(?= |$)/.exec(norm) ?? /(?:^| )(شهر|سنه) (?:واحد|وحده|واحده)(?= |$)/.exec(norm);
    if (dm) {
      const months = { سنه: 12, سنتين: 24, شهر: 1, شهرين: 2 }[dm[1] as 'سنه'] ?? 12;
      const atLeastD = !!dm[2];
      attrMentions.push({ key: 'rental_months', op: atLeastD ? 'gte' : 'eq', value: months, strength: null, evidence: dm[0].trim(), about: atLeastD ? 'counterpart' : 'self' });
    }
  }
  // numbers read as attributes the category does not have ("نحنا عيلة من خمس أشخاص" on a rental) are dropped
  if (topCat) {
    const allowed = new Set(attributesFor(reg, topCat).map((a) => a.key));
    for (let i = attrMentions.length - 1; i >= 0; i--) if (!allowed.has(attrMentions[i]!.key)) attrMentions.splice(i, 1);
  }
  const negotiable = NEGOTIABLE_RE.test(norm);
  if (negotiable && prices[0]) prices[0].evidence += ' (قابل للتفاوض)';

  // ── time
  const when = parseWhen(tokens, now, vertical === 'activities');
  if (when) mark(0, 0);

  // ── attrs vs constraints from the detected side (re-assigned later when side becomes known)
  const { attrs, constraints } = assignAttributes(attrMentions, side?.value ?? opts.sideHint ?? null);

  // ── unknown content words (advisor input; never raw sentences)
  const unknownTerms = tokens.filter((t, k) => !consumed.has(k) && t.length >= 3 && !STOP.has(t) && !/^\d/.test(t) && !isCueWord(t)).slice(0, 12);

  const isNegativeAnswer = /^(لا|لاء|لأ|مو هيك|مش هيك|لا مو|غلط|لا ابدا)( |$)/.test(norm);
  const isUnsure = /(ما بعرف|مابعرف|مش عارف|ما عندي فكره|مو مهم|مش مهم|مو فارقه|مش فارقه|متل ما بدك|اي شي|عادي|ما بتفرق|ما بيفرق|بلا|ولا شي)/.test(norm) && tokens.length <= 5;

  // proximity: "قريب مني", "الأقرب", "جنبي" — and references to where I am now
  const nearestEarly = /(?:^| )(?:قريب|قريبه|قريبين|قراب) (?:مني|علي|لعندي)(?: |$)|(?:^| )(?:الاقرب|اقرب سياره|جنبي|حولي)(?: |$)/.test(norm);
  // "بدي سيارة قريبة مني / تبعد عني 3 كم" without a sale/rent cue = requesting a car to come (a ride)
  if (categories[0]?.value === 'vehicles.car' && (radius || nearestEarly) && !SALE_RE.test(norm) && !RENT_RE.test(norm) && side?.value !== 'provide') {
    categories.unshift({ value: 'transport.ride', confidence: 0.8, evidence: radius?.evidence ?? 'قريب', explicit: true });
    categories[1] = { ...categories[1]!, explicit: false };
  }
  const nearest = /(?:^| )(?:قريب|قريبه|قريبين|قراب) (?:مني|علي|عليي|منا|لعندي|من عندي|من موقعي)(?: |$)|(?:^| )(?:الاقرب|اقرب شي|اقرب واحد|اقرب سياره|جنبي|حولي|بمنطقتي|بحارتي)(?: |$)/.test(norm) || (radius !== null && radius.strength === 'preferred');
  const hereRef = /(?:^| )(?:موقعي|مكاني|موقعي الحالي|مكاني الحالي|من عندي|لعندي|من هون|وين انا|وين ما انا)(?: |$)/.test(norm);

  const finalDeal = categories[0]?.value === 'transport.ride' && deal?.value !== 'service' ? detectDeal(reg, norm, 'transport.ride') : deal;

  return {
    normalized: norm,
    radius,
    nearest,
    hereRef,
    side,
    categories,
    deal: finalDeal,
    places,
    prices: negotiable ? prices.map((p) => ({ ...p })) : prices,
    when,
    attrs,
    constraints,
    attrMentions,
    unknownTerms,
    isNegativeAnswer,
    isUnsure,
  };
}

function sameFamily(codes: string[]): boolean {
  return codes.length > 1 && codes.every((c) => c.startsWith(codes[0]!.split('.')[0]! + '.')) && codes.slice(1).every((c) => c.startsWith(codes[0]!));
}

function isCurrencyAt(tokens: string[], idx: number): boolean {
  const t = tokens[idx] ?? '';
  return CURRENCY_WORDS.some((c) => c.re.test(t));
}

function currencyAndUnit(tokens: string[], from: number, numStart: number): { currency: Currency | 'LIRA' | null; unit: PriceUnit | null; end: number } {
  let currency: Currency | 'LIRA' | null = null;
  let unit: PriceUnit | null = null;
  let end = from;
  if (tokens[numStart - 1] === '$') currency = 'USD';
  for (let k = from; k < Math.min(tokens.length, from + 4); k++) {
    const t = tokens[k]!;
    const two = `${t} ${tokens[k + 1] ?? ''}`;
    if (!currency) {
      if (/^(ليره|ليرات|الليره|بالليره) (تركي|تركيه|التركيه)$/.test(two)) { currency = 'TRY'; end = k + 2; k++; continue; }
      if (/^(ليره|ليرات|الليره|بالليره) (سوري|سوريه|السوريه)$/.test(two)) { currency = 'SYP'; end = k + 2; k++; continue; }
      if (/^(دولار|دولارات) (امريكي|اميركي)$/.test(two)) { currency = 'USD'; end = k + 2; k++; continue; }
      const c = CURRENCY_WORDS.find((x) => x.re.test(t));
      if (c) { currency = c.cur; end = k + 1; continue; }
    }
    if (!unit) {
      if (/^(كل|بال|عال) ?(شهر)$/.test(two) || two === 'كل شهر' || two === 'بالشهر الواحد') { unit = 'month'; end = k + 2; k++; continue; }
      if (two === 'كل سنه') { unit = 'year'; end = k + 2; k++; continue; }
      const u = UNIT_WORDS.find((x) => x.re.test(t));
      if (u) { unit = u.unit; end = k + 1; continue; }
    }
    if (EQ_RE.test(t) || REQUIRED_CUES.has(t) || /^(تقريبا|بالشهر)$/.test(t)) { end = k + 1; continue; }
    break;
  }
  return { currency, unit, end };
}

function tenantAbout(tokens: string[], start: number): 'self' | 'counterpart' | 'either' {
  const pre = tokens.slice(Math.max(0, start - 2), start).join(' ');
  if (/(انا|احنا|نحن|نحنا|انا و|عندي)/.test(pre)) return 'self';
  const t = tokens[start] ?? '';
  if (/^لل|^ل/.test(t) || REQUIRED_CUES.has(tokens[start + 1] ?? '')) return 'counterpart';
  return 'either';
}

/** Default strength of a seeker's attribute mention when the user gave no cue. */
const SEEKER_DEFAULT_STRENGTH: Record<string, Strength> = {
  make: 'required', model: 'preferred', year: 'preferred', transmission: 'preferred', fuel: 'preferred', mileage_km: 'preferred',
  rooms: 'preferred', floor: 'preferred', furnished: 'preferred', area_m2: 'preferred', solar: 'preferred', rental_months: 'preferred',
  subject: 'required', level: 'preferred', mode: 'preferred', appliance: 'required', condition: 'preferred', home_visit: 'preferred',
  tenant_type: 'required',
};

/** Decide which mentions are facts about the owner (attrs) vs conditions on the counterpart (constraints). */
export function assignAttributes(mentions: AttrMention[], side: Side | null): { attrs: Record<string, { value: AttrFact; evidence: string }>; constraints: AttrConstraint[] } {
  const attrs: Record<string, { value: AttrFact; evidence: string }> = {};
  const constraints: AttrConstraint[] = [];
  for (const m0 of mentions) {
    let m = m0;
    if (m.key === 'tenant_type' && m.about !== 'self' && side === 'provide') m = { ...m, about: 'counterpart', op: m.op === 'eq' ? 'in' : m.op, values: m.op === 'eq' && m.value !== undefined ? [m.value] : m.values, value: m.op === 'eq' ? undefined : m.value };
    else if (m.key === 'tenant_type' && side === 'seek' && m.about !== 'counterpart') m = { ...m, about: 'self' };
    else if (m.key === 'tenant_type' && side === 'seek') m = { ...m, about: 'self' };
    const selfFact = m.about === 'self' || (m.about === 'either' && (side === 'provide' || side === 'join'));
    if (selfFact && m.op === 'eq' && m.value !== undefined) {
      const prev = attrs[m.key];
      // several enum values for the same key ("رياضيات وفيزياء") become a multi-valued fact
      if (prev && typeof m.value === 'string' && (typeof prev.value === 'string' || Array.isArray(prev.value)) && prev.value !== m.value) {
        const list = Array.isArray(prev.value) ? prev.value : [prev.value];
        if (!list.includes(m.value)) attrs[m.key] = { value: [...list, m.value], evidence: `${prev.evidence}، ${m.evidence}` };
      } else attrs[m.key] = { value: m.value, evidence: m.evidence };
      continue;
    }
    if (selfFact && (m.op === 'gte' || m.op === 'lte') && m.value !== undefined && side === 'provide' && m.key !== 'rental_months') {
      attrs[m.key] = { value: m.value, evidence: m.evidence }; // "3 غرف" for an offer is a fact
      continue;
    }
    const strength: Strength = m.strength ?? SEEKER_DEFAULT_STRENGTH[m.key] ?? 'preferred';
    const c: AttrConstraint = { key: m.key, op: m.op, strength, evidence: m.evidence };
    if (m.value !== undefined) c.value = m.value;
    if (m.values !== undefined) c.values = m.values;
    if (m.lo !== undefined) c.lo = m.lo;
    if (m.hi !== undefined) c.hi = m.hi;
    const same = constraints.find((x) => x.key === m.key && (x.op === 'eq' || x.op === 'in') && m.op === 'eq' && typeof m.value === 'string');
    if (same) {
      same.values = [...new Set([...(same.values ?? (same.value !== undefined ? [same.value] : [])), m.value!])];
      same.op = 'in';
      delete same.value;
      continue;
    }
    constraints.push(c);
  }
  return { attrs, constraints };
}

// ───────────── time ─────────────
const WEEKDAYS: Record<string, number> = { الاحد: 0, الحد: 0, الاثنين: 1, الاتنين: 1, التنين: 1, اثنين: 1, تنين: 1, اتنين: 1, الثلاثاء: 2, الثلاثا: 2, التلات: 2, التلاتا: 2, تلاتاء: 2, تلاتا: 2, ثلاثاء: 2, التلاتاء: 2, الاربعاء: 3, الاربعا: 3, اربعا: 3, اربعاء: 3, الخميس: 4, خميس: 4, الجمعه: 5, جمعه: 5, السبت: 6, سبت: 6 };
const DAY_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const TZ_OFFSET_MIN = 180; // Syria: UTC+3 all year (since 2022)

function localMidnightUtc(now: Date, addDays: number): Date {
  const localMs = now.getTime() + TZ_OFFSET_MIN * 60_000;
  const local = new Date(localMs);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays);
  return new Date(midnightLocal - TZ_OFFSET_MIN * 60_000);
}
function localDow(now: Date): number {
  return new Date(now.getTime() + TZ_OFFSET_MIN * 60_000).getUTCDay();
}

export function parseWhen(tokens: string[], now: Date, activity: boolean): TimeWindow | null {
  const strength: Strength = activity ? 'required' : 'preferred';
  const norm = tokens.join(' ');
  const mk = (from: Date, to: Date, label: string, evidence: string): TimeWindow => ({ from: from.toISOString(), to: to.toISOString(), strength, label, evidence });
  if (/(^| )بعد (بكرا|بكره|بكرة|غدا)( |$)/.test(norm)) return mk(localMidnightUtc(now, 2), localMidnightUtc(now, 3), 'بعد بكرا', 'بعد بكرا');
  if (/(^| )(بكرا|بكره|غدا|غدوه|بكير بكرا)( |$)/.test(norm)) return mk(localMidnightUtc(now, 1), localMidnightUtc(now, 2), 'بكرا', 'بكرا');
  if (/(^| )(اليوم|الليله|هالمسا|المسا)( |$)/.test(norm) && !/(^| )(ليوم|باليوم|لليوم|عاليوم|يوميا)( |$)/.test(norm) && (activity || /(^| )اليوم( |$)/.test(norm))) return mk(localMidnightUtc(now, 0), localMidnightUtc(now, 1), 'اليوم', 'اليوم');
  if (/(^| )(الاسبوع|الجمعه|جمعه) (الجاي|القادم|الماي|الجايه|الجايي)( |$)/.test(norm) && /الاسبوع/.test(norm)) return mk(localMidnightUtc(now, 7 - localDow(now)), localMidnightUtc(now, 14 - localDow(now)), 'الأسبوع الجاي', 'الأسبوع الجاي');
  if (/(^| )(هالاسبوع|هاد الاسبوع|هذا الاسبوع)( |$)/.test(norm)) return mk(localMidnightUtc(now, 0), localMidnightUtc(now, 7 - localDow(now)), 'هالأسبوع', 'هالأسبوع');
  if (/(^| )(الويكند|ويكند|نهايه الاسبوع|العطله)( |$)/.test(norm)) {
    const d = (5 - localDow(now) + 7) % 7;
    return mk(localMidnightUtc(now, d), localMidnightUtc(now, d + 2), 'نهاية الأسبوع', 'نهاية الأسبوع');
  }
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    // only the token itself or a real clitic-stripped remainder ("بالجمعة" → "الجمعه"), never a synthesized form
    const variants = [tok, tok.replace(/^[وبل](?=ال)/, ''), tok.replace(/^(?:يوم|بيوم)$/, '')];
    const dayTok = variants.find((v) => WEEKDAYS[v] !== undefined);
    if (dayTok === undefined) continue;
    // avoid "يوم" ambiguity: weekday names are explicit enough
    const target = WEEKDAYS[dayTok]!;
    // "الجمعة الجاية" in Levantine usage = the coming Friday (same as "يوم الجمعة")
    const d = (target - localDow(now) + 7) % 7;
    return mk(localMidnightUtc(now, d), localMidnightUtc(now, d + 1), `يوم ${DAY_AR[target]}`, tokens[k]!);
  }
  return null;
}

const STOP = new Set(('في من على علي عن مع او ولا يا انا انت هو هي نحن احنا هاد هيك هاي هذا هذه هدول شي شو ليش كيف وين مين متى قديش كم ' +
  'كتير شوي اذا لو لان لانو منشان عشان مشان حدا يعني هلق هلا بس كمان ايضا لسا لسه بعد قبل عند فيه فيها فيني بقدر ممكن ' +
  'بدي بدنا بدو بدها عندي عنا عندنا محتاج بحاجه اريد نريد ابحث يوم الله الحمد شكرا مرحبا اهلا السلام عليكم صباح الخير مسا ' +
  'كل اي ايا واحد شخص حدا ناس الناس كتيره منيح منيحه حلو حلوه كويس تمام طيب اوكي اوك ok لازم ضروري فقط حصرا يفضل ياريت ' +
  'اطلع نطلع يلعب نلعب بعطي وبعطي يصلح يصلحها يصلحلي خربانه خربان معطله موديل بين اقل اكتر غير بعرف ابيع بيع اشتري الجاي الجايه القادم ' +
  'سعر السعر بسعر ثمن دولار ليره تركي سوري بالشهر شهري سنوي بالسنه حوالي تقريبا بحدود حد اقصي الاقل بالضبط').split(' '));
function isCueWord(t: string): boolean {
  return REQUIRED_CUES.has(t) || PREFERRED_CUES.has(t) || CURRENCY_WORDS.some((c) => c.re.test(t)) || UNIT_WORDS.some((u) => u.re.test(t)) || EQ_RE.test(t) || PRICE_CONTEXT.has(t) || RENT_RE.test(t) || SALE_RE.test(t);
}

/** Resolve a bare "ليرة" ambiguity etc. Exposed for tests. */
export const _internals = { matchPhrases, detectSide, detectDeal, strengthNear, currencyAndUnit, opBefore };
export type { NumberPhrase };
