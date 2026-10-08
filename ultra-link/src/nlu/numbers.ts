// Arabic number & money parsing with exact integer arithmetic (BigInt, scaled by 100 = minor units).
// Works on normalized text (see normalizeAr). Never uses floating point for money.

const SMALL: Record<string, number> = {
  صفر: 0,
  واحد: 1, وحده: 1, احد: 1,
  اثنين: 2, اتنين: 2, تنين: 2, اثنان: 2, ثنين: 2,
  ثلاث: 3, ثلاثه: 3, تلات: 3, تلاته: 3, تلت: 3,
  اربع: 4, اربعه: 4,
  خمس: 5, خمسه: 5,
  ست: 6, سته: 6, ستة: 6,
  سبع: 7, سبعه: 7,
  ثمان: 8, ثماني: 8, ثمانيه: 8, تمن: 8, تمنه: 8, تماني: 8, تمانيه: 8,
  تسع: 9, تسعه: 9,
  عشر: 10, عشره: 10,
  حداعش: 11, احدعش: 11, اتنعش: 12, تناعش: 12, طنعش: 12, تلطعش: 13, اربعطعش: 14, خمسطعش: 15, ستطعش: 16, سبعطعش: 17, تمنطعش: 18, تسعطعش: 19,
  عشرين: 20, ثلاثين: 30, تلاتين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تمانين: 80, تسعين: 90,
  ميه: 100, مئه: 100, مايه: 100, ميتين: 200, مئتين: 200, مئتان: 200, ميتان: 200,
  تلتميه: 300, ثلاثميه: 300, ثلاثمئه: 300, تلاتميه: 300, اربعميه: 400, اربعمئه: 400, خمسميه: 500, خمسمئه: 500,
  ستميه: 600, ستمئه: 600, سبعميه: 700, سبعمئه: 700, تمنميه: 800, ثمانميه: 800, ثمانمئه: 800, تسعميه: 900, تسعمئه: 900,
};
const MULT: Record<string, bigint> = {
  الف: 1000n, الاف: 1000n, الوف: 1000n, لف: 1000n,
  مليون: 1_000_000n, ملايين: 1_000_000n, ملاين: 1_000_000n,
  مليار: 1_000_000_000n,
};
const DUAL_MULT: Record<string, bigint> = { الفين: 2000n, الفان: 2000n, مليونين: 2_000_000n };
const FRACTION: Record<string, [bigint, bigint]> = { ونص: [1n, 2n], ونصف: [1n, 2n], وربع: [1n, 4n], وتلت: [1n, 3n] };

/** Parse a decimal digit string ("1,500", "2.5", "1.500") into value×100 as BigInt, or null. */
export function digitsToCents(tok: string): bigint | null {
  if (!/^\d[\d,.]*$/.test(tok)) return null;
  let t = tok;
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, ''); // thousands separators
  t = t.replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?\d*$/.exec(t);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? '').padEnd(2, '0');
  return whole * 100n + BigInt(frac || '0');
}

export function isNumberWord(tok: string): boolean {
  const t = stripWa(tok);
  return t in SMALL || t in MULT || t in DUAL_MULT || tok in FRACTION || digitsToCents(t) !== null;
}

function stripWa(tok: string): string {
  if (tok.startsWith('ب') && tok.length > 3) {
    const rest = tok.slice(1);
    if (rest in SMALL || rest in MULT || rest in DUAL_MULT) return rest;
  }
  if (tok.startsWith('و') && tok.length > 2 && !(tok in FRACTION)) {
    const rest = tok.slice(1);
    if (rest in SMALL || rest in MULT || rest in DUAL_MULT || digitsToCents(rest) !== null) return rest;
  }
  return tok;
}

export interface NumberPhrase {
  start: number; // token index (inclusive)
  end: number; // token index (exclusive)
  cents: bigint; // value × 100
  text: string;
}

/**
 * Find maximal number phrases in a token list. Handles digits, words, multipliers (الف/مليون),
 * dual forms (الفين), conjunction (و), and fractions (ونص/وربع).
 */
export function findNumbers(tokens: string[]): NumberPhrase[] {
  const out: NumberPhrase[] = [];
  let i = 0;
  while (i < tokens.length) {
    const first = tokens[i]!;
    if (first in FRACTION || !isNumberWord(first) || (stripWa(first) !== first && first.startsWith('و'))) { i++; continue; }
    const start = i;
    let total = 0n; // ×100
    let current = 0n; // ×100
    let lastMagnitude = 100n; // ×100 place value of the last component (for ونص/وربع)
    while (i < tokens.length) {
      const raw = tokens[i]!;
      const any = i > start;
      if (raw in FRACTION) {
        if (!any) break;
        const [num, den] = FRACTION[raw]!;
        current += (lastMagnitude * num) / den;
        i++;
        continue;
      }
      const t = stripWa(raw);
      const joined = raw !== t && raw.startsWith('و'); // prefixed by و → continues the same number
      const d = digitsToCents(t);
      if (d !== null) {
        if (any && !joined) break; // "3 200" are two numbers
        current += d;
        lastMagnitude = magnitudeOf(d);
      } else if (t in SMALL) {
        const v = BigInt(SMALL[t]!) * 100n;
        if (v === 10000n && current > 0n && current < 10000n && !joined) {
          current *= 100n; // "تلت مية" → 300
          lastMagnitude = 10000n;
        } else {
          if (any && !joined && (current !== 0n || total !== 0n)) break;
          current += v;
          lastMagnitude = v >= 10000n ? 10000n : 100n;
        }
      } else if (t in DUAL_MULT) {
        if (current !== 0n) break;
        const m = DUAL_MULT[t]!;
        total += 2n * 100n * (m / 2n);
        lastMagnitude = (m / 2n) * 100n;
      } else if (t in MULT) {
        const m = MULT[t]!;
        total += (current === 0n ? 100n : current) * m;
        current = 0n;
        lastMagnitude = m * 100n;
      } else break;
      i++;
    }
    if (i > start) out.push({ start, end: i, cents: total + current, text: tokens.slice(start, i).join(' ') });
    else i = start + 1;
  }
  return out;
}

function magnitudeOf(cents: bigint): bigint {
  // for "2 ونص" style: half of the unit place → base 100 (=1.00)
  if (cents >= 100_000_000n) return 100_000_000n;
  if (cents >= 100_000n) return 100_000n;
  if (cents >= 10_000n) return 10_000n;
  return 100n;
}

/** Format minor units as a plain decimal string ("20000" → "200", "15050" → "150.50"). */
export function centsToDecimal(cents: bigint | string): string {
  const c = typeof cents === 'string' ? BigInt(cents) : cents;
  const neg = c < 0n;
  const a = neg ? -c : c;
  const whole = a / 100n;
  const frac = a % 100n;
  return (neg ? '-' : '') + whole.toString() + (frac === 0n ? '' : '.' + frac.toString().padStart(2, '0'));
}

/** Thousands-grouped display without floats: 1500000 → "1,500,000". */
export function groupDigits(s: string): string {
  const [w, f] = s.split('.');
  return w!.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
}
