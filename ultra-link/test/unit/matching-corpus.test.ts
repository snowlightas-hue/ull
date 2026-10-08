// Runs every hand-labeled pair in test/corpus/matching-scenarios.json (Role 1) through evaluatePair, in
// both orders. Labels are ground truth: a disagreement is either an evaluator bug (fixed in evaluate.ts)
// or a questionable label, listed in QUESTIONED below with the reasoning. The corpus is never edited here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/lib/env.ts';
import { seedRegistry } from '../../src/domain/registry.ts';
import { evaluatePair, specToMatchable } from '../../src/matching/evaluate.ts';
import type { IntentSpec, PairVerdict } from '../../src/domain/types.ts';

interface Scenario {
  id: string; a: IntentSpec; b: IntentSpec; why: string; tags: string[];
  expected: { verdict: 'match' | 'possible' | 'excluded'; mustIncludeReasonCodes: string[]; exclusionCode: string | null };
}

const reg = seedRegistry();
const scenarios: Scenario[] = JSON.parse(readFileSync(join(ROOT, 'test/corpus/matching-scenarios.json'), 'utf8'));
const NOW = new Date('2026-10-08T12:00:00Z');

/**
 * Labels we believe are wrong (reported to Role 1). Each entry states what the evaluator returns instead;
 * the test asserts exactly that, so a corrected label or a changed evaluator is noticed here.
 */
const QUESTIONED: Record<string, { verdict: PairVerdict['verdict']; exclusionCode: string | null; codes: string[]; reason: string }> = {
  m027: {
    verdict: 'excluded', exclusionCode: 'place_excluded', codes: ['place_excluded'],
    reason: 'An explicitly negated place ("مو بعفرين") is its own hard condition. The evaluator reports place_excluded, which the ' +
      'corpus vocabulary lacks; place_out_of_scope would be wrong here (Afrin IS inside the stated scope, and the "widen the place" ' +
      'suggestion tied to place_out_of_scope must never propose an excluded place). Verdict agrees; only the code differs.',
  },
};

function run(s: Scenario, swap: boolean): PairVerdict {
  const a = specToMatchable(s.a, { id: '101', userId: 'u1', createdAt: '2026-10-01T00:00:00Z' });
  const b = specToMatchable(s.b, { id: '202', userId: 'u2', createdAt: '2026-10-02T00:00:00Z' });
  return swap ? evaluatePair(reg, b, a, { now: NOW }) : evaluatePair(reg, a, b, { now: NOW });
}

function problems(s: Scenario, v: PairVerdict): string[] {
  const q = QUESTIONED[s.id];
  const want = q ? { verdict: q.verdict, exclusionCode: q.exclusionCode, codes: q.codes } : { verdict: s.expected.verdict, exclusionCode: s.expected.exclusionCode, codes: s.expected.mustIncludeReasonCodes };
  const codes = new Set(v.reasons.map((r) => r.code));
  const out: string[] = [];
  if (v.verdict !== want.verdict) out.push(`verdict ${v.verdict} (want ${want.verdict})`);
  for (const c of want.codes) if (!codes.has(c)) out.push(`missing reason ${c}`);
  if (want.verdict === 'excluded' && v.exclusion?.code !== want.exclusionCode) out.push(`exclusion ${v.exclusion?.code} (want ${want.exclusionCode})`);
  return out;
}

test(`matching corpus: ${scenarios.length} scenarios agree with the evaluator in both orders`, () => {
  assert.ok(scenarios.length >= 150, `corpus has ${scenarios.length} scenarios`);
  const errs: string[] = [];
  for (const s of scenarios) {
    for (const swap of [false, true]) {
      const p = problems(s, run(s, swap));
      if (p.length) errs.push(`${s.id}${swap ? ' (b,a)' : ''}: ${p.join('; ')} — ${s.why}`);
    }
  }
  assert.deepEqual(errs, []);
});

test('matching corpus: verdict, score, reasons and exclusion do not depend on argument order', () => {
  for (const s of scenarios) {
    const ab = run(s, false);
    const ba = run(s, true);
    assert.equal(ab.verdict, ba.verdict, s.id);
    assert.equal(ab.score, ba.score, s.id);
    assert.deepEqual(ab.missing, ba.missing, s.id);
    assert.deepEqual(ab.exclusion, ba.exclusion, s.id);
    assert.deepEqual(ab.reasons, ba.reasons, s.id);
  }
});

test('matching corpus: invariants of every verdict (score bands, exclusion code, clear reason for possible)', () => {
  for (const s of scenarios) {
    const v = run(s, false);
    if (v.verdict === 'excluded') {
      assert.equal(v.score, 0, s.id);
      assert.ok(v.exclusion?.code, `${s.id}: excluded without an exclusion code`);
      assert.ok(v.reasons.some((r) => r.code === v.exclusion!.code), s.id);
    } else if (v.verdict === 'possible') {
      assert.ok(v.score >= 0 && v.score <= 4999, `${s.id}: possible score ${v.score}`);
      assert.ok(v.missing.length > 0, `${s.id}: possible needs a missing fact`);
      assert.ok(v.reasons.some((r) => r.polarity === 'unknown'), `${s.id}: possible needs an 'unknown' reason`);
    } else {
      assert.ok(v.score >= 5000 && v.score <= 10000, `${s.id}: confirmed score ${v.score}`);
      assert.deepEqual(v.missing, [], s.id);
    }
  }
});

test('matching corpus: the questioned labels still exist and still disagree only as documented', (t) => {
  for (const [id, q] of Object.entries(QUESTIONED)) {
    const s = scenarios.find((x) => x.id === id);
    assert.ok(s, `${id} is gone from the corpus — drop it from QUESTIONED`);
    const v = run(s, false);
    const labelOk = v.verdict === s.expected.verdict && (s.expected.verdict !== 'excluded' || v.exclusion?.code === s.expected.exclusionCode);
    assert.ok(!labelOk, `${id} now agrees with its label — drop it from QUESTIONED`);
    t.diagnostic(`questioned ${id}: label ${s.expected.verdict}/${s.expected.exclusionCode}, evaluator ${v.verdict}/${v.exclusion?.code ?? null} — ${q.reason}`);
  }
});
