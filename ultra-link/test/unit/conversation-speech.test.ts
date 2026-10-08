// Unit tests for public/js/conversation/speech-text.js (browser module, imported directly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skeleton as serverSkeleton, stripDiacritics as serverStrip } from '../../src/nlu/arabic.ts';
import { addPauses, pickSpeech, sameLetters, skeleton, speakableText, stripDiacritics } from '../../public/js/conversation/speech-text.js';

const SAMPLES = [
  'بدي شقة بإعزاز',
  'بِدَّك الشّقة للبيع ولا للإيجار؟',
  'كَمْ غُرْفَة بِدَّك؟',
  'سعرها ٢٠٠ دولار بالشهر',
  'ســـيارة كيا 2015، أوتوماتيك',
  'هل تريد أن يكون المكان في إعزاز فقط أَوْ في محافظة حلب كلها؟',
  'ٱلْقُرْآن ۖ ۗ ۚ مثال للعلامات',
  'Apartment 3 rooms / شقة ٣ غرف!!',
  '…«مرحبا»… — نعم؛ لا: ربما',
  'بدك الشقة مفروشة ولّا لأ؟',
  '',
  '   ',
];

test('skeleton() is identical to src/nlu/arabic.ts skeleton()', () => {
  for (const s of SAMPLES) {
    assert.equal(skeleton(s), serverSkeleton(s), `skeleton mismatch for ${JSON.stringify(s)}`);
    assert.equal(stripDiacritics(s), serverStrip(s), `stripDiacritics mismatch for ${JSON.stringify(s)}`);
  }
  // exhaustive over the Arabic blocks + punctuation/digits used in the app
  const ranges: Array<[number, number]> = [
    [0x0600, 0x06ff],
    [0x0750, 0x077f],
    [0x0020, 0x007e],
    [0x2000, 0x206f],
    [0x00a0, 0x00ff],
  ];
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp++) {
      const s = `ب${String.fromCodePoint(cp)}ت`;
      assert.equal(skeleton(s), serverSkeleton(s), `U+${cp.toString(16)}`);
    }
  }
});

test('speakableText prefers the diacritized speech variant when letters are identical', () => {
  const q = { text: 'بدك الشقة للبيع ولا للإيجار؟', speech: 'بِدَّك الشّقة للبيع ولا للإيجار؟' };
  const out = speakableText(q);
  assert.ok(out.includes('بِدَّك'), 'diacritized speech is used');
  assert.equal(skeleton(out), skeleton(q.text), 'spoken text keeps exactly the displayed letters');
  assert.equal(pickSpeech(q).source, 'speech');
});

test('speakableText rejects a speech variant that changes words and falls back to text', () => {
  const q = { text: 'بدك الشقة للبيع ولا للإيجار؟', speech: 'هل تريد الشقة للبيع أم للإيجار؟' };
  const choice = pickSpeech(q);
  assert.equal(choice.source, 'text');
  assert.equal(choice.reason, 'speech_changes_words');
  const out = speakableText(q);
  assert.equal(skeleton(out), skeleton(q.text));
  assert.ok(!out.includes('هل'), 'none of the changed words are spoken');
  // a single changed letter is also rejected
  assert.equal(pickSpeech({ text: 'كم غرفة؟', speech: 'كم غرف؟' }).source, 'text');
  // an added word is rejected
  assert.equal(pickSpeech({ text: 'كم غرفة؟', speech: 'كم غرفة بدك؟' }).source, 'text');
});

test('speakableText handles missing/empty fields', () => {
  assert.equal(speakableText(null), '');
  assert.equal(speakableText(undefined), '');
  assert.equal(speakableText({ text: '', speech: 'شيء' }), '', 'never speaks words that are not displayed');
  assert.equal(speakableText({ text: 'كم غرفة؟' }), 'كم غرفة؟');
  assert.equal(speakableText({ text: 'كم غرفة؟', speech: '   ' }), 'كم غرفة؟');
  assert.equal(speakableText('  نص   عادي  '), 'نص عادي');
});

test('addPauses inserts a comma before ولا / أو without changing letters', () => {
  assert.equal(addPauses('بدك للبيع ولا للإيجار؟'), 'بدك للبيع، ولا للإيجار؟');
  assert.equal(addPauses('بإعزاز فقط أو بكل المحافظة؟'), 'بإعزاز فقط، أو بكل المحافظة؟');
  assert.equal(addPauses('مفروشة ولّا لأ؟'), 'مفروشة، ولّا لأ؟');
  assert.equal(addPauses('بالدولار أَوْ بالليرة؟'), 'بالدولار، أَوْ بالليرة؟');
  // already has a pause → unchanged
  assert.equal(addPauses('للبيع، ولا للإيجار؟'), 'للبيع، ولا للإيجار؟');
  // at the start → unchanged
  assert.equal(addPauses('ولا شي'), 'ولا شي');
  // words that merely start with the same letters are not touched
  assert.equal(addPauses('في ولاية حلب'), 'في ولاية حلب');
  assert.equal(addPauses('سيارة أوتوماتيك'), 'سيارة أوتوماتيك');
  for (const s of SAMPLES) assert.equal(skeleton(addPauses(s)), skeleton(s), `pauses changed letters in ${JSON.stringify(s)}`);
});

test('speakableText output always has the same skeleton as the displayed text', () => {
  const qs = [
    { text: 'بدك الشقة للبيع ولا للإيجار؟', speech: 'بِدَّك الشّقة... للبيع، ولا للإيجار؟' },
    { text: 'كم السعر بالشهر؟', speech: 'كَم السِّعر بالشَّهر؟' },
    { text: 'وين المكان؟', speech: 'وين المكان بالضبط؟' },
    { text: 'شو نوع السيارة أو موديلها؟', speech: 'شو نوع السيارة أو موديلها؟' },
  ];
  for (const q of qs) {
    assert.ok(sameLetters(speakableText(q), q.text), JSON.stringify(q));
    assert.ok(sameLetters(speakableText(q, { pauses: false }), q.text));
  }
});
