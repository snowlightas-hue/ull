// Arabic display formatting (server-side). Money stays BigInt/strings end to end.
import type { Currency, PriceSpec, PriceUnit } from './types.ts';

const CUR: Record<Currency, string> = { USD: '$', TRY: 'ل.ت', SYP: 'ل.س', EUR: '€' };
const CUR_WORD: Record<Currency, string> = { USD: 'دولار', TRY: 'ليرة تركية', SYP: 'ليرة سورية', EUR: 'يورو' };
const UNIT_AR: Record<PriceUnit, string> = {
  total: '', month: 'بالشهر', year: 'بالسنة', week: 'بالأسبوع', day: 'باليوم', hour: 'بالساعة', session: 'للحصة', person: 'للشخص',
};

export function amountText(minor: string | bigint): string {
  const c = typeof minor === 'bigint' ? minor : BigInt(minor);
  const whole = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = c % 100n;
  return frac === 0n ? whole : `${whole}.${frac.toString().padStart(2, '0')}`;
}

export function moneyText(minor: string | bigint, currency: Currency | null, unit?: PriceUnit | null): string {
  const a = amountText(minor);
  const cur = currency ? (currency === 'USD' ? `${a}$` : `${a} ${CUR[currency]}`) : a;
  const u = unit ? UNIT_AR[unit] : '';
  return u ? `${cur} ${u}` : cur;
}

export function currencyWord(c: Currency): string { return CUR_WORD[c]; }
export function unitWord(u: PriceUnit): string { return UNIT_AR[u] || 'إجمالي'; }

export function priceText(p: PriceSpec | null, side: 'seek' | 'provide' | 'join'): string | null {
  if (!p) return null;
  if (p.op === 'eq' && p.lo === '0' && p.hi === '0') return 'مجانًا';
  const m = (v: string | null) => (v === null ? '' : moneyText(v, p.currency, null));
  const unit = p.unit && p.unit !== 'total' ? ` ${UNIT_AR[p.unit]}` : '';
  const neg = p.negotiable ? ' (قابل للتفاوض)' : '';
  if (side === 'provide') return `${m(p.lo ?? p.hi)}${unit}${neg}`;
  const soft = p.strength === 'preferred' ? ' (مرن)' : '';
  switch (p.op) {
    case 'eq': return `${m(p.lo)} بالضبط${unit}`;
    case 'lte': return `حتى ${m(p.hi)}${unit}${soft}`;
    case 'gte': return `من ${m(p.lo)} وما فوق${unit}${soft}`;
    case 'between': return `بين ${m(p.lo)} و${m(p.hi)}${unit}`;
    case 'approx': return `حوالي ${m(p.lo ?? p.hi)}${unit}`;
  }
}
