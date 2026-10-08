// Ultra Link — text helpers for speaking a clarifying question aloud.
// Pure functions: no DOM, no window, safe to import in Node tests.
//
// Rule: the app must never SAY different words from what it SHOWS. A Question carries
// `text` (displayed) and `speech` (spoken variant: diacritics / punctuation / pauses only).
// We only use `speech` when its letter skeleton equals the skeleton of `text`.

// Same character classes as src/nlu/arabic.ts (stripDiacritics / skeleton). Keep in sync:
// test/unit/conversation-speech.test.ts asserts equivalence against the server implementation.
const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

/** Remove Arabic diacritics (harakat, Quranic marks, superscript alef) and tatweel. */
export function stripDiacritics(s) {
  return String(s ?? '').replace(DIACRITICS, '').replace(TATWEEL, '');
}

/** Letters+digits only skeleton — identical to skeleton() in src/nlu/arabic.ts. */
export function skeleton(input) {
  return stripDiacritics(input).replace(/[^\p{L}\p{N}]+/gu, '');
}

/** True when two strings contain exactly the same letters/digits in the same order. */
export function sameLetters(a, b) {
  return skeleton(a) === skeleton(b);
}

// Harakat that may sit on the alternative words (e.g. «وَلّا», «أَوْ»).
const H = '[\\u064B-\\u065F\\u0670]*';
// «ولا» / «ولّا» (Levantine "or") and «أو» / «او».
const OR_WORD = `(?:و${H}ل${H}ا${H}|[أا]${H}و${H})`;
// A word character (not whitespace, not punctuation that already makes a pause) before the gap.
const NO_PAUSE_BEFORE = '[^\\s\\u060C,\\u061B;:.!?\\u061F\\u2026\\-\\u2013\\u2014(\\u00AB"\']';
const PAUSE_RE = new RegExp(`(${NO_PAUSE_BEFORE})(\\s+)(${OR_WORD})(?=[\\s\\u060C,\\u061B;:.!?\\u061F\\u2026]|$)`, 'gu');

/**
 * Insert an Arabic comma before the alternative words «ولا» / «أو» so TTS engines pause there
 * ("بدك للبيع ولا للإيجار؟" → "بدك للبيع، ولا للإيجار؟"). Never changes letters: the skeleton of
 * the result always equals the skeleton of the input.
 */
export function addPauses(text) {
  const s = String(text ?? '');
  const out = s.replace(PAUSE_RE, '$1،$2$3');
  return skeleton(out) === skeleton(s) ? out : s;
}

function tidy(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Decide what to speak for a question and why.
 * @param {{text?: string, speech?: string} | string | null | undefined} question
 * @returns {{text: string, source: 'speech'|'text'|'none', reason: string}}
 */
export function pickSpeech(question) {
  if (question == null) return { text: '', source: 'none', reason: 'no_question' };
  if (typeof question === 'string') return { text: tidy(question), source: 'text', reason: 'plain_string' };
  const text = typeof question.text === 'string' ? tidy(question.text) : '';
  const speech = typeof question.speech === 'string' ? tidy(question.speech) : '';
  if (!text) return { text: '', source: 'none', reason: 'empty_text' };
  if (!speech) return { text, source: 'text', reason: 'no_speech_variant' };
  if (skeleton(speech) !== skeleton(text)) return { text, source: 'text', reason: 'speech_changes_words' };
  return { text: speech, source: 'speech', reason: 'same_letters' };
}

/**
 * Text to hand to speechSynthesis for a Question: `speech` when it has the same letters as `text`
 * (only diacritics/punctuation/pauses differ), else `text`; then pauses are added before «ولا»/«أو».
 * @param {{text?: string, speech?: string} | string | null | undefined} question
 * @param {{pauses?: boolean}} [opts]
 */
export function speakableText(question, opts = {}) {
  const { text } = pickSpeech(question);
  if (!text) return '';
  return opts.pauses === false ? text : addPauses(text);
}
