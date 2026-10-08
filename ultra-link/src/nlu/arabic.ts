// Arabic text normalization used for matching words (never for display).

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/** Convert Arabic-Indic / Persian digits and separators to ASCII. */
export function asciiDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    if (a >= 0) out += String(a);
    else if (p >= 0) out += String(p);
    else if (ch === '٫') out += '.';
    else if (ch === '٬') out += ',';
    else out += ch;
  }
  return out;
}

export function stripDiacritics(s: string): string {
  return s.replace(DIACRITICS, '').replace(TATWEEL, '');
}

/**
 * Canonical form for lexical matching: no diacritics, unified alef/ya/ta-marbuta/hamza seats,
 * ASCII digits, lowercase Latin, single spaces, punctuation turned into spaces.
 */
export function normalizeAr(input: string): string {
  let s = asciiDigits(stripDiacritics(input.normalize('NFKC')));
  s = s
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ـ/g, '')
    .toLowerCase();
  // thousands separators between digits ("1,500,000") are dropped before punctuation handling
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  // numeric ranges "100-200" keep their meaning as words
  s = s.replace(/(\d)\s*[-–]\s*(\d)/g, '$1 الي $2');
  // keep $ and digits/decimal points; turn other punctuation into spaces
  s = s.replace(/[؟?!،,;؛:"'()\[\]{}«»…\-–—_/\\|*+=<>~`^]/g, ' ');
  s = s.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');
  s = s.replace(/\.(?!\d)/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Letters-only skeleton (used to check that a spoken variant keeps the same words as the text). */
export function skeleton(input: string): string {
  return stripDiacritics(input).replace(/[^\p{L}\p{N}]+/gu, '');
}

// Attached clitics that commonly precede nouns in Levantine/MSA: و، ف، ب، ل، ك، ال، بال، لل، وبال، وال ...
const PREFIXES = ['وبال', 'وال', 'بال', 'فال', 'كال', 'عال', 'لل', 'ال', 'وب', 'ول', 'وف', 'عل', 'و', 'ف', 'ب', 'ل', 'ك'];

/**
 * Possible stems of a normalized token, in priority order: the token itself, its suffix-stripped forms,
 * then clitic-stripped forms (and their suffix-stripped forms). Synthetic "ال"+stem forms are added last
 * and are never suffix-stripped again (avoids compounding into unrelated words).
 */
export function tokenVariants(token: string): string[] {
  const out: string[] = [];
  const add = (v: string) => { if (v.length >= 2 && !out.includes(v)) out.push(v); };
  const suffixForms = (base: string) => {
    for (const suf of SUFFIXES) {
      const min = suf.startsWith('ت') ? 2 : 3;
      if (base.endsWith(suf) && base.length - suf.length >= min) {
        const stem = base.slice(0, -suf.length);
        add(stem);
        if (suf.startsWith('ت')) add(stem + 'ه'); // سيارتي/شقتين -> سياره/شقه
      }
    }
  };
  add(token);
  suffixForms(token);
  const stripped: string[] = [];
  for (const p of PREFIXES) {
    if (token.startsWith(p) && token.length - p.length >= 2) {
      const rest = token.slice(p.length);
      add(rest);
      suffixForms(rest);
      stripped.push(rest);
    }
  }
  for (const rest of stripped) if (!rest.startsWith('ال') && rest.length >= 3) add('ال' + rest);
  return out;
}

const SUFFIXES = ['تين', 'تي', 'تنا', 'تك', 'ها', 'نا', 'كم', 'ين', 'ات', 'ي', 'ك'];

export function tokenize(normalized: string): string[] {
  return normalized.split(' ').filter(Boolean);
}
