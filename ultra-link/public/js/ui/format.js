// Arabic formatting helpers (pure functions, no DOM).
//
// DIGITS: every number the UI generates is written with Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and the
// Arabic separators ٬ (thousands) and ٫ (decimal). Reason: our users (northern Syria / Levant) read
// these digits natively, the product copy uses them ("قبل ٥ دقائق", "٢١–٤٠ من ٢٥٠"), and mixing two
// digit systems inside one Arabic sentence slows scanning. Server-provided Arabic strings are passed
// through localizeDigits() so the whole screen stays consistent.
// The single deliberate exception is a phone number: it is shown as the user/server wrote it, in an
// LTR <a href="tel:"> so it can be dialled and copied exactly.
//
// MONEY: amounts are integer minor units carried as decimal strings ("20000" = 200.00). They are
// handled with BigInt only — never parseFloat/Number — so no rounding can ever creep in.
// We deliberately avoid Intl.NumberFormat/RelativeTimeFormat so output is identical on every
// browser/ICU build (ICU changed the default Arabic numbering system across versions).

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export const AR_GROUP = '٬'; // U+066C ARABIC THOUSANDS SEPARATOR
export const AR_DECIMAL = '٫'; // U+066B ARABIC DECIMAL SEPARATOR
export const AR_PERCENT = '٪'; // U+066A ARABIC PERCENT SIGN
export const EN_DASH = '–';

/** "21" → "٢١". Accepts anything; non-digits are kept. */
export function toArabicDigits(value) {
  return String(value ?? '').replace(/[0-9]/g, (d) => AR_DIGITS[d.charCodeAt(0) - 48]);
}

/** "٢١" / "۲۱" (Persian) → "21". */
export function toLatinDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Convert ASCII digit runs inside Arabic text to Arabic-Indic digits, except when the number is glued
 * to Latin letters (model names such as "i10", "X5") or looks like a phone number (7+ digits).
 * "شقة 3 غرف بسعر 1,200 دولار" → "شقة ٣ غرف بسعر ١٬٢٠٠ دولار".
 */
export function localizeDigits(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/(^|[^A-Za-z0-9+])(\d+(?:[.,]\d+)*)(?![A-Za-z0-9])/g, (all, pre, num) => {
    if (num.replace(/\D/g, '').length >= 7) return all; // phone-like: keep exactly as written
    const converted = toArabicDigits(num).replace(/,/g, AR_GROUP).replace(/\./g, AR_DECIMAL);
    return pre + converted;
  });
}

/** Short alias used by the views for any server-provided Arabic display string. */
export const ar = localizeDigits;

function intString(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value).toString() : null;
  const s = toLatinDigits(String(value ?? '')).trim();
  return /^-?\d+$/.test(s) ? s : null;
}

/** Group an integer: 1250000 → "١٬٢٥٠٬٠٠٠". Accepts number | bigint | numeric string. */
export function formatNumber(value) {
  const s = intString(value);
  if (s === null) return '—';
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).replace(/^0+(?=\d)/, '');
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + toArabicDigits(grouped).replace(/,/g, AR_GROUP);
}

/** Minor-unit exponent per currency (ISO 4217). All supported currencies use 2. */
export const MINOR_DIGITS = { USD: 2, EUR: 2, TRY: 2, SYP: 2 };

export const CURRENCY_AR = { USD: 'دولار', EUR: 'يورو', TRY: 'ليرة تركية', SYP: 'ليرة سورية' };

/** Adverbial unit suffix used after an amount ("٢٠٠ دولار شهريًا"). */
export const PRICE_UNIT_AR = {
  total: '',
  month: 'شهريًا',
  year: 'سنويًا',
  week: 'أسبوعيًا',
  day: 'يوميًا',
  hour: 'بالساعة',
  session: 'للجلسة',
  person: 'للشخص',
};

/** Unit names used as labels in pickers. */
export const PRICE_UNIT_LABEL_AR = {
  total: 'المبلغ كاملًا',
  month: 'شهري',
  year: 'سنوي',
  week: 'أسبوعي',
  day: 'يومي',
  hour: 'بالساعة',
  session: 'للجلسة',
  person: 'للشخص',
};

function splitMinor(minor, currency) {
  const s = intString(minor);
  if (s === null) return null;
  const exp = BigInt(MINOR_DIGITS[currency] ?? 2);
  const v = BigInt(s);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** exp;
  return { neg, whole: abs / base, frac: abs % base, exp: Number(exp) };
}

/**
 * Amount only (no currency): "125050" → "١٬٢٥٠٫٥٠", "20000" → "٢٠٠" (zero fraction dropped).
 * Returns null for anything that is not an integer string.
 */
export function formatAmount(minor, currency = 'USD') {
  const p = splitMinor(minor, currency);
  if (!p) return null;
  let out = formatNumber(p.whole);
  if (p.frac !== 0n) out += AR_DECIMAL + toArabicDigits(p.frac.toString().padStart(p.exp, '0'));
  return (p.neg ? '-' : '') + out;
}

/** "20000","USD","month" → "٢٠٠ دولار شهريًا". Missing currency/unit are simply omitted. */
export function formatMoney(minor, currency, unit) {
  const amount = formatAmount(minor, currency || 'USD');
  if (amount === null) return null;
  return [amount, currency ? (CURRENCY_AR[currency] ?? currency) : '', unit ? (PRICE_UNIT_AR[unit] ?? '') : '']
    .filter(Boolean)
    .join(' ');
}

/** Human Arabic text for a PriceSpec (see src/domain/types.ts). null → null. */
export function formatPriceSpec(price) {
  if (!price) return null;
  const cur = price.currency ? (CURRENCY_AR[price.currency] ?? price.currency) : '';
  const unit = price.unit ? (PRICE_UNIT_AR[price.unit] ?? '') : '';
  const amt = (m) => formatAmount(m, price.currency || 'USD');
  const tail = [cur, unit].filter(Boolean).join(' ');
  const withTail = (s) => (tail ? `${s} ${tail}` : s);
  let text;
  switch (price.op) {
    case 'lte': text = price.hi ? withTail(`حتى ${amt(price.hi)}`) : null; break;
    case 'gte': text = price.lo ? withTail(`لا يقل عن ${amt(price.lo)}`) : null; break;
    case 'between':
      text = price.lo && price.hi ? withTail(`بين ${amt(price.lo)} و${amt(price.hi)}`) : null; break;
    case 'approx': text = (price.lo || price.hi) ? withTail(`حوالي ${amt(price.lo || price.hi)}`) : null; break;
    default: text = (price.lo || price.hi) ? withTail(amt(price.lo || price.hi)) : null;
  }
  if (text && price.negotiable) text += ' (قابل للتفاوض)';
  return text;
}

/**
 * Parse what a person typed into an amount field → minor units string, or null if invalid.
 * Accepts Arabic-Indic/Persian/Latin digits, ٬ or , grouping, ٫ or . decimal, at most 2 decimals.
 * "١٬٢٥٠٫٥" → "125050", "200" → "20000", "1,500" → "150000", "12,5" → "1250".
 */
export function parseAmountToMinor(input, currency = 'USD') {
  const exp = MINOR_DIGITS[currency] ?? 2;
  let s = toLatinDigits(String(input ?? ''))
    .trim()
    .replace(/[\s _'’]/g, '')
    .replace(/٬/g, ',')
    .replace(/٫/g, '.');
  if (!s) return null;
  if (s.includes('.')) s = s.replace(/,/g, '');
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  const re = new RegExp(`^\\d+(\\.\\d{1,${exp}})?$`);
  if (!re.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt((frac + '0'.repeat(exp)).slice(0, exp) || '0');
  return minor.toString();
}

/** Minor units → editable text with Arabic-Indic digits, no grouping: "125050" → "١٢٥٠٫٥". */
export function minorToInput(minor, currency = 'USD') {
  const p = splitMinor(minor, currency);
  if (!p) return '';
  let out = p.whole.toString();
  if (p.frac !== 0n) out += '.' + p.frac.toString().padStart(p.exp, '0').replace(/0+$/, '');
  return toArabicDigits((p.neg ? '-' : '') + out).replace('.', AR_DECIMAL);
}

/** Compare two minor-unit strings with BigInt: -1 | 0 | 1. */
export function compareMinor(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ── Plurals ─────────────────────────────────────────────────────────────────────────────────────
// Arabic has six plural categories (CLDR): zero, one, two, few (3–10), many (11–99), other (100+…).

/** CLDR Arabic plural category for an integer. */
export function arPluralCategory(n) {
  const v = Math.abs(Math.trunc(Number(n)));
  if (v === 0) return 'zero';
  if (v === 1) return 'one';
  if (v === 2) return 'two';
  const r = v % 100;
  if (r >= 3 && r <= 10) return 'few';
  if (r >= 11 && r <= 99) return 'many';
  return 'other';
}

/**
 * Nouns with their counted forms. `one`/`two` are complete phrases (nominative), `twoAcc` is the
 * accusative/genitive dual used after verbs/prepositions ("وجدت مطابقتين", "قبل دقيقتين").
 */
export const NOUNS = {
  offer: { one: 'عرض واحد', two: 'عرضان', twoAcc: 'عرضين', few: 'عروض', many: 'عرضًا', other: 'عرض', zero: 'لا عروض' },
  request: { one: 'طلب واحد', two: 'طلبان', twoAcc: 'طلبين', few: 'طلبات', many: 'طلبًا', other: 'طلب', zero: 'لا طلبات' },
  activity: { one: 'مشارك واحد', two: 'مشاركان', twoAcc: 'مشاركَين', few: 'مشاركين', many: 'مشاركًا', other: 'مشارك', zero: 'لا مشاركين' },
  result: { one: 'نتيجة واحدة', two: 'نتيجتان', twoAcc: 'نتيجتين', few: 'نتائج', many: 'نتيجةً', other: 'نتيجة', zero: 'لا نتائج' },
  match: { one: 'مطابقة واحدة', two: 'مطابقتان', twoAcc: 'مطابقتين', few: 'مطابقات', many: 'مطابقةً', other: 'مطابقة', zero: 'لا مطابقات' },
  notification: { one: 'تنبيه واحد', two: 'تنبيهان', twoAcc: 'تنبيهين', few: 'تنبيهات', many: 'تنبيهًا', other: 'تنبيه', zero: 'لا تنبيهات' },
  second: { one: 'ثانية', two: 'ثانيتان', twoAcc: 'ثانيتين', few: 'ثوانٍ', many: 'ثانية', other: 'ثانية', zero: '٠ ثانية' },
  minute: { one: 'دقيقة', two: 'دقيقتان', twoAcc: 'دقيقتين', few: 'دقائق', many: 'دقيقة', other: 'دقيقة', zero: '٠ دقيقة' },
  hour: { one: 'ساعة', two: 'ساعتان', twoAcc: 'ساعتين', few: 'ساعات', many: 'ساعة', other: 'ساعة', zero: '٠ ساعة' },
  day: { one: 'يوم', two: 'يومان', twoAcc: 'يومين', few: 'أيام', many: 'يومًا', other: 'يوم', zero: '٠ يوم' },
  week: { one: 'أسبوع', two: 'أسبوعان', twoAcc: 'أسبوعين', few: 'أسابيع', many: 'أسبوعًا', other: 'أسبوع', zero: '٠ أسبوع' },
  month: { one: 'شهر', two: 'شهران', twoAcc: 'شهرين', few: 'أشهر', many: 'شهرًا', other: 'شهر', zero: '٠ شهر' },
  year: { one: 'سنة', two: 'سنتان', twoAcc: 'سنتين', few: 'سنوات', many: 'سنة', other: 'سنة', zero: '٠ سنة' },
};

/**
 * Count + noun with correct Arabic agreement.
 *   formatCount(3, NOUNS.offer) → "٣ عروض";  formatCount(11, NOUNS.offer) → "١١ عرضًا"
 *   formatCount(2, NOUNS.match, { acc: true }) → "مطابقتين"
 */
export function formatCount(n, noun, { acc = false } = {}) {
  const cat = arPluralCategory(n);
  const d = formatNumber(n);
  switch (cat) {
    case 'zero': return noun.zero ?? `${d} ${noun.other}`;
    case 'one': return noun.one;
    case 'two': return acc ? (noun.twoAcc ?? noun.two) : noun.two;
    case 'few': return `${d} ${noun.few}`;
    case 'many': return `${d} ${noun.many}`;
    default: return `${d} ${noun.other}`;
  }
}

// ── Time ────────────────────────────────────────────────────────────────────────────────────────

const MONTHS_AR = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const WEEKDAYS_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function toTime(value) {
  if (value instanceof Date) return value.getTime();
  const t = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : null;
}

function unitPhrase(n, noun) {
  // after قبل/بعد the dual is genitive ("قبل دقيقتين") and one is the bare noun ("قبل دقيقة")
  if (n === 1) return noun.other;
  return formatCount(n, noun, { acc: true });
}

/**
 * Relative time in Arabic: "الآن", "قبل دقيقة", "قبل دقيقتين", "قبل ٥ دقائق", "قبل ١١ دقيقة",
 * "أمس", "قبل ٣ أيام", "بعد ٣ أيام", "غدًا". Invalid input → "".
 */
export function formatRelativeTime(value, now = Date.now()) {
  const t = toTime(value);
  const n0 = toTime(now);
  if (t === null || n0 === null) return '';
  const diffSec = Math.round((n0 - t) / 1000);
  const future = diffSec < 0;
  const sec = Math.abs(diffSec);
  const pre = future ? 'بعد' : 'قبل';
  if (sec < 45) return future ? 'بعد لحظات' : 'الآن';
  const min = Math.round(sec / 60);
  if (min < 45) return `${pre} ${unitPhrase(Math.max(1, min), NOUNS.minute)}`;
  const hr = Math.round(sec / 3600);
  if (hr < 22) return `${pre} ${unitPhrase(Math.max(1, hr), NOUNS.hour)}`;
  const day = Math.round(sec / 86400);
  if (day <= 1) return future ? 'غدًا' : 'أمس';
  if (day < 7) return `${pre} ${unitPhrase(day, NOUNS.day)}`;
  if (day < 30) {
    const wk = Math.round(day / 7);
    return wk >= 4 ? `${pre} ${unitPhrase(day, NOUNS.day)}` : `${pre} ${unitPhrase(wk, NOUNS.week)}`;
  }
  const mo = Math.round(day / 30.4);
  if (mo < 12) return `${pre} ${unitPhrase(Math.max(1, mo), NOUNS.month)}`;
  return `${pre} ${unitPhrase(Math.max(1, Math.round(day / 365)), NOUNS.year)}`;
}

/** "الجمعة ١٠ تشرين الأول ٢٠٢٦، ٣:٠٥ م" (local time). Invalid → "". */
export function formatDateTime(value, { time = true, year = true } = {}) {
  const t = toTime(value);
  if (t === null) return '';
  const d = new Date(t);
  let out = `${WEEKDAYS_AR[d.getDay()]} ${toArabicDigits(d.getDate())} ${MONTHS_AR[d.getMonth()]}`;
  if (year) out += ` ${toArabicDigits(d.getFullYear())}`;
  if (time) {
    const hh = d.getHours();
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    out += `، ${toArabicDigits(h12)}:${toArabicDigits(String(d.getMinutes()).padStart(2, '0'))} ${hh < 12 ? 'ص' : 'م'}`;
  }
  return out;
}

/** Date only: "الجمعة ١٠ تشرين الأول". */
export function formatDate(value, { year = false } = {}) {
  return formatDateTime(value, { time: false, year });
}

// ── Lists, counters, scores ─────────────────────────────────────────────────────────────────────

/** Pagination range "٢١–٤٠ من ٢٥٠". total 0 → "لا توجد عناصر". */
export function formatRange(start, end, total) {
  const t = Number(total) || 0;
  if (t <= 0) return 'لا توجد عناصر';
  const a = Number(start) || 1;
  const b = Number(end) || a;
  const span = a === b ? toArabicDigits(a) : `${toArabicDigits(a)}${EN_DASH}${toArabicDigits(b)}`;
  return `${span} من ${formatNumber(t)}`;
}

/** Tab/counter badge text: 0/invalid → "", 1..99 → digits, >99 → "٩٩+". */
export function formatBadge(n) {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v <= 0) return '';
  return v > 99 ? `${toArabicDigits(99)}+` : toArabicDigits(v);
}

/** Matching score (integer 0..10000) → "٨٧٪". */
export function formatScore(score) {
  const v = Math.trunc(Number(score));
  if (!Number.isFinite(v)) return '';
  const pct = Math.max(0, Math.min(100, Math.round(v / 100)));
  return `${toArabicDigits(pct)}${AR_PERCENT}`;
}

/** Turn an E.164-ish phone into a tel: URI (digits and leading + only). */
export function telHref(phone) {
  const p = toLatinDigits(String(phone ?? '')).replace(/[^\d+]/g, '');
  return p ? `tel:${p}` : null;
}
