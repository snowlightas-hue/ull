import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRegistry } from '../../src/domain/registry.ts';
import { applyTurn, emptyDraft, recordAsked, type ConversationDraft } from '../../src/conversation/engine.ts';
import { validateSpec } from '../../src/domain/validate.ts';
import type { Question } from '../../src/domain/types.ts';
import type { JevResolution } from '../../src/nlu/types.ts';

const reg = seedRegistry();
const now = new Date('2026-10-08T10:00:00Z');

/** Drive a dialogue; returns every question asked and the final outcome. */
function run(turns: (string | ((q: Question) => string))[], jev?: JevResolution) {
  let draft: ConversationDraft = emptyDraft();
  let q: Question | null = null;
  const asked: string[] = [];
  let last: ReturnType<typeof applyTurn> | null = null;
  for (const t of turns) {
    const text = typeof t === 'function' ? t(q!) : t;
    last = applyTurn(reg, draft, { text, answering: q, now, jev });
    draft = last.draft;
    if (last.next.kind === 'ask') { q = last.next.question; recordAsked(draft, q); asked.push(String(q.field)); } else q = null;
  }
  return { asked, last: last!, draft };
}

test('one essential question, answer merges into the same request', () => {
  const r = run(['بدي شقة بإعزاز', 'إيجار']);
  assert.deepEqual(r.asked, ['deal']);
  assert.equal(r.last.next.kind, 'ready');
  if (r.last.next.kind === 'ready') {
    assert.equal(r.last.next.spec.deal, 'rent');
    assert.deepEqual(r.last.next.spec.place.scopePlaceIds, [reg.placeByCode.get('sy.aleppo.azaz')!.id]);
    assert.ok(validateSpec(reg, r.last.next.spec).ok);
  }
});

test('extra info inside an answer is kept and never re-asked', () => {
  const r = run(['بدي شقة بإعزاز', 'إيجار وبحدود 150 دولار بالشهر']);
  assert.deepEqual(r.asked, ['deal']);
  assert.equal(r.last.next.kind, 'ready');
  if (r.last.next.kind === 'ready') assert.deepEqual([r.last.next.spec.price?.op, r.last.next.spec.price?.unit], ['approx', 'month']);
});

test('an answered field is never asked again, even after unrelated answers', () => {
  const r = run(['عندي شقة للإيجار بعفرين ب 150', 'دولار', 'بالشهر']);
  assert.deepEqual(r.asked, ['price.currency', 'price.unit']);
  assert.equal(new Set(r.asked).size, r.asked.length);
  assert.equal(r.last.next.kind, 'ready');
});

test('conflict asks only about the conflicting field; a correction cue overrides without asking', () => {
  const c = run(['بدي شقة للإيجار بإعزاز حد أقصى 200 دولار', 'عفرين']);
  assert.deepEqual(c.asked, ['price.unit', 'conflict']);
  assert.equal(c.last.next.kind === 'ask' && c.last.next.question.conflict?.field, 'place');
  const k = run(['بدي شقة للإيجار بإعزاز حد أقصى 200 دولار', 'عفرين', (q) => q.options![1]!.label, 'بالشهر']);
  assert.equal(k.last.next.kind, 'ready');
  if (k.last.next.kind === 'ready') assert.deepEqual(k.last.next.spec.place.scopePlaceIds, [reg.placeByCode.get('sy.aleppo.afrin')!.id]);
  const corr = run(['بدي شقة للإيجار بإعزاز', 'لا قصدي عفرين']);
  assert.deepEqual(corr.asked, []);
  if (corr.last.next.kind === 'ready') assert.deepEqual(corr.last.next.spec.place.scopePlaceIds, [reg.placeByCode.get('sy.aleppo.afrin')!.id]);
});

test('"I don\'t know" resolves a place question instead of looping; greetings are welcomed', () => {
  const r = run(['مرحبا', 'بدي سيارة', 'شراء', 'ما بعرف']);
  assert.deepEqual(r.asked, ['deal', 'place']); // a greeting gets a warm prompt, not a formal question
  assert.equal(r.last.next.kind, 'ready');
  const g = applyTurn(reg, emptyDraft(), { text: 'مرحبا', answering: null, now });
  assert.equal(g.next.kind, 'unclear');
});

test('peer activity requires a day and a place; chip labels work as answers', () => {
  const r = run(['بدي أطلع رحلة', 'من إعزاز', (q) => q.options![0]!.label]);
  assert.deepEqual(r.asked, ['place', 'when']);
  assert.equal(r.last.next.kind, 'ready');
  if (r.last.next.kind === 'ready') assert.equal(r.last.next.spec.side, 'join');
});

test('Jev can fill only non-explicit fields, above its threshold', () => {
  const jev: JevResolution = { engine: 'jev-sim', model: 'jev-latest', latencyMs: 5, deal: { value: 'rent', confidence: 0.9, evidence: 'x', explicit: false }, side: { value: 'provide', confidence: 0.99, evidence: 'x', explicit: false } };
  const r = run(['بدي شقة بإعزاز'], jev);
  // side was explicit ("بدي") → rules win; deal was missing → Jev's confident answer is used
  assert.equal(r.last.next.kind, 'ready');
  if (r.last.next.kind === 'ready') { assert.equal(r.last.next.spec.side, 'seek'); assert.equal(r.last.next.spec.deal, 'rent'); }
  assert.deepEqual(r.last.appliedJev, ['deal']);
  const low = run(['بدي شقة بإعزاز'], { ...jev, deal: { value: 'rent', confidence: 0.6, evidence: 'x', explicit: false } });
  assert.equal(low.last.next.kind, 'ask'); // below threshold → ask the user instead of guessing
});

test('a bare amount answers the price question; currency and unit inside an answer are kept', () => {
  const r = run(['عندي غرفة للإيجار بإعزاز', '٥٠', 'دولار بالشهر']);
  assert.deepEqual(r.asked, ['price', 'price.currency']);
  assert.equal(r.last.next.kind, 'ready');
  if (r.last.next.kind === 'ready') assert.deepEqual([r.last.next.spec.price?.lo, r.last.next.spec.price?.currency, r.last.next.spec.price?.unit], ['5000', 'USD', 'month']);
});

test('an answer that mentions a house does not reopen the category ("يجي عالبيت")', () => {
  const r = run(['بدي حدا يصلحلي البراد', 'أنا بعفرين، وبدي ياه يجي عالبيت']);
  assert.deepEqual(r.asked, ['place']);
  assert.equal(r.last.next.kind, 'ready');
});
