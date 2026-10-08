// Jev resolver tests: question planning (only what is needed), answer mapping, cache, and an end-to-end
// run against the local SIMULATION mock.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createJevClient, JevError } from '../../src/ai/jev-client.ts';
import type { CallOptions, JevQuestions, JevState, SystemOneResult } from '../../src/ai/jev-client.ts';
import { APP_CONTEXT, cacheKey, JevCache, MAX_CATEGORY_OPTIONS, OTHER_CATEGORY, planJevQuestions, resolveWithJev, shouldCallJev } from '../../src/ai/resolver.ts';
import type { JevResolverClient } from '../../src/ai/resolver.ts';
import { buildRegistry, seedRegistry } from '../../src/domain/registry.ts';
import type { RuleParse } from '../../src/nlu/types.ts';
import { normalizeAr } from '../../src/nlu/arabic.ts';
import { CATEGORIES } from '../../src/seed/taxonomy.ts';
import type { CategorySeed } from '../../src/seed/taxonomy.ts';
import { startJevMock } from '../mocks/jev-mock-server.ts';
import type { JevMock } from '../mocks/jev-mock-server.ts';

const reg = seedRegistry();
const AZAZ = 1102;
const AFRIN = 1103;

function mkParse(text: string, p: Partial<RuleParse> = {}): RuleParse {
  return {
    normalized: normalizeAr(text),
    side: null,
    categories: [],
    deal: null,
    places: [],
    prices: [],
    when: null,
    attrs: {},
    constraints: [],
    attrMentions: [],
    unknownTerms: [],
    isNegativeAnswer: false,
    isUnsure: false,
    ...p,
  };
}
const exp = <T>(value: T, evidence = 'x') => ({ value, confidence: 1, evidence, explicit: true });
const guess = <T>(value: T, evidence = 'x') => ({ value, confidence: 0.5, evidence, explicit: false });

/** Everything explicit: nothing to ask. */
function fullyExplicit(): RuleParse {
  return mkParse('بدي شقة للإيجار فقط بإعزاز بـ 100 دولار بالشهر', {
    side: exp('seek', 'بدي'),
    categories: [exp('real_estate.apartment', 'شقة')],
    deal: exp('rent', 'للإيجار'),
    places: [{ placeId: AZAZ, evidence: 'بإعزاز', strength: 'required', negated: false }],
    prices: [{ lo: null, hi: '10000', currency: 'USD', unit: 'month', op: 'lte', opExplicit: true, strength: null, evidence: '100 دولار' }],
  });
}

// ───────────────────────────── stub client ─────────────────────────────

type Handler = (state: JevState, q: JevQuestions) => Record<string, unknown>;
function stubClient(handler: Handler, engine: 'jev' | 'jev-sim' = 'jev') {
  const calls: { state: JevState; questions: JevQuestions }[] = [];
  const c: JevResolverClient & { calls: typeof calls } = {
    model: 'jev-latest',
    engine,
    calls,
    async systemOne<Q extends JevQuestions>(state: JevState, questions: Q, _o?: CallOptions): Promise<SystemOneResult<Q>> {
      calls.push({ state, questions });
      const answers = handler(state, questions);
      return { model: 'jev-2026-09-15', answers: answers as SystemOneResult<Q>['answers'], usage: { inputTokens: 321, outputTokens: 7 }, requestId: 'req-1', latencyMs: 42, attempts: 1 };
    },
  };
  return c;
}
const choice = (c: string, confidence: number) => ({ type: 'choice', choice: c, confidence, probabilities: { [c]: confidence } });
const noul = (p: number) => ({ type: 'noul', noul: p });

// ───────────────────────────── planning ─────────────────────────────

describe('shouldCallJev (cost control)', () => {
  it('false when everything is explicit', () => {
    assert.equal(shouldCallJev(fullyExplicit()), false);
    assert.equal(shouldCallJev(fullyExplicit(), { registry: reg }), false);
  });
  it('false for negative / unsure answers and empty text', () => {
    assert.equal(shouldCallJev(mkParse('لا', { isNegativeAnswer: true })), false);
    assert.equal(shouldCallJev(mkParse('ما بعرف', { isUnsure: true })), false);
    assert.equal(shouldCallJev(mkParse('   ')), false);
  });
  it('true when something is ambiguous', () => {
    assert.equal(shouldCallJev({ ...fullyExplicit(), side: null }), true);
    assert.equal(shouldCallJev({ ...fullyExplicit(), deal: guess('rent') }), true);
    assert.equal(shouldCallJev(mkParse('بدي حدا يزبطلي الشوفاج')), true);
  });
  it('respects `only` (fields the conversation still needs)', () => {
    const p = { ...fullyExplicit(), side: null };
    assert.equal(shouldCallJev(p, { only: ['category', 'deal'] }), false);
    assert.equal(shouldCallJev(p, { only: ['side'], registry: reg }), true);
  });
  it('with a registry, agrees with the planner (single-option fields are not asked)', () => {
    // peer category explicit => side can only be join => nothing to ask
    const p = mkParse('رحلة على عفرين فقط', {
      categories: [exp('activities.trip', 'رحلة')],
      deal: exp('activity', 'رحلة'),
      places: [{ placeId: AFRIN, evidence: 'عفرين', strength: 'required', negated: false }],
    });
    assert.equal(shouldCallJev(p, { registry: reg }), false);
  });
});

describe('planJevQuestions asks only what is needed', () => {
  it('nothing when everything is explicit', () => {
    const plan = planJevQuestions(reg, fullyExplicit());
    assert.deepEqual(plan.fields, []);
    assert.deepEqual(plan.questions, {});
  });

  it('only side when only side is missing; join excluded for an exchange category', () => {
    const plan = planJevQuestions(reg, { ...fullyExplicit(), side: null });
    assert.deepEqual(Object.keys(plan.questions), ['side']);
    const q = plan.questions.side!;
    assert.equal(q.type, 'choice');
    assert.deepEqual(Object.keys((q as { criteria: object }).criteria), ['seek', 'provide']);
  });

  it('non-explicit side is asked, explicit side is not', () => {
    assert.deepEqual(planJevQuestions(reg, { ...fullyExplicit(), side: guess('provide') }).fields, ['side']);
    assert.deepEqual(planJevQuestions(reg, fullyExplicit()).fields, []);
  });

  it('category: active leaf categories with descriptionAr as criteria, plus "other", <= 255 labels', () => {
    const plan = planJevQuestions(reg, { ...fullyExplicit(), categories: [] });
    assert.deepEqual(plan.fields, ['category']);
    const crit = (plan.questions.category as { criteria: Record<string, string> }).criteria;
    const leaves = reg.categories.filter((c) => c.descendants.length === 1);
    // explicit side 'seek' excludes peer (activities) leaves
    const expected = leaves.filter((c) => c.relation === 'exchange' && c.deals.includes('rent')).map((c) => c.code);
    assert.deepEqual(Object.keys(crit), [...expected, OTHER_CATEGORY]);
    assert.ok(Object.keys(crit).length <= 255);
    const apt = reg.categoryByCode.get('real_estate.apartment')!;
    assert.equal(crit['real_estate.apartment'], `${apt.nameAr}: ${apt.descriptionAr}`);
    assert.ok(!('real_estate' in crit), 'parent categories are not offered');
  });

  it('category labels follow an explicit join side (peer leaves only)', () => {
    const plan = planJevQuestions(reg, mkParse('مين بدو يجي معنا', { side: exp('join', 'مين بدو') }));
    const labels = plan.categoryLabels.filter((l) => l !== OTHER_CATEGORY);
    assert.ok(labels.length > 0);
    assert.ok(labels.every((l) => l.startsWith('activities.')));
  });

  it('narrows to rule candidates + siblings when the taxonomy is large', () => {
    const extra: CategorySeed[] = Array.from({ length: MAX_CATEGORY_OPTIONS + 10 }, (_, i) => ({
      id: 9000 + i, code: `goods.extra_${i}`, parent: 'goods', nameAr: `صنف ${i}`, descriptionAr: `صنف تجريبي ${i}`, deals: ['sale'], keywords: [],
    }));
    const big = buildRegistry(undefined, undefined, [...CATEGORIES, ...extra]);
    const plan = planJevQuestions(big, mkParse('بدي غرفة', { categories: [guess('real_estate.room', 'غرفة')] }));
    const labels = plan.categoryLabels;
    assert.ok(labels.includes('real_estate.room'));
    assert.ok(labels.includes('real_estate.apartment'), 'siblings included');
    assert.ok(!labels.some((l) => l.startsWith('goods.extra_')), 'unrelated categories dropped');
    assert.equal(labels.at(-1), OTHER_CATEGORY);
  });

  it('deal options are limited to the likely category', () => {
    const plan = planJevQuestions(reg, { ...fullyExplicit(), deal: null });
    assert.deepEqual(plan.fields, ['deal']);
    assert.deepEqual(plan.dealLabels, ['sale', 'rent']);
    // likely but not explicit category also restricts the options
    const p2 = planJevQuestions(reg, { ...fullyExplicit(), deal: null, categories: [guess('vehicles.car', 'سيارة')] });
    assert.deepEqual(p2.dealLabels, ['sale', 'rent']);
  });

  it('deal is not asked when the category allows a single deal', () => {
    const p = { ...fullyExplicit(), deal: null, categories: [exp('services.plumbing', 'سباك')], prices: [] };
    assert.deepEqual(planJevQuestions(reg, p).fields, []);
  });

  it('price operator only when prices[0] has no explicit operator (and is not a range)', () => {
    const base = fullyExplicit();
    const p0 = base.prices[0]!;
    assert.deepEqual(planJevQuestions(reg, { ...base, prices: [{ ...p0, op: null, opExplicit: false, lo: '10000', hi: '10000' }] }).fields, ['priceOp']);
    assert.deepEqual(planJevQuestions(reg, { ...base, prices: [{ ...p0, op: 'eq', opExplicit: false, lo: '10000', hi: '10000' }] }).fields, ['priceOp']);
    assert.deepEqual(planJevQuestions(reg, { ...base, prices: [{ ...p0, op: null, opExplicit: false, lo: '5000', hi: '10000' }] }).fields, []);
    assert.deepEqual(planJevQuestions(reg, base).fields, []);
    const q = planJevQuestions(reg, { ...base, prices: [{ ...p0, opExplicit: false }] }).questions.price_op as { criteria: object };
    assert.deepEqual(Object.keys(q.criteria), ['eq', 'lte', 'gte', 'approx']);
  });

  it('one noul per place mention without a strictness cue (not negated, de-duplicated)', () => {
    const plan = planJevQuestions(reg, {
      ...fullyExplicit(),
      places: [
        { placeId: AZAZ, evidence: 'بإعزاز', strength: null, negated: false },
        { placeId: AZAZ, evidence: 'اعزاز', strength: null, negated: false },
        { placeId: AFRIN, evidence: 'عفرين', strength: null, negated: true },
        { placeId: 1101, evidence: 'حلب', strength: 'preferred', negated: false },
      ],
    });
    assert.deepEqual(plan.fields, ['placeStrength']);
    assert.deepEqual(Object.keys(plan.questions), [`place_${AZAZ}`]);
    assert.equal(plan.questions[`place_${AZAZ}`]!.type, 'noul');
  });

  it('`only` restricts the question set', () => {
    const plan = planJevQuestions(reg, mkParse('بدي شي'), { only: ['category'] });
    assert.deepEqual(plan.fields, ['category']);
  });
});

// ───────────────────────────── mapping ─────────────────────────────

describe('resolveWithJev mapping', () => {
  it('maps choices (confidence field) and nouls (|p-0.5|*2, p>=0.5 => required)', async () => {
    const text = 'شقة بإعزاز أو عفرين بـ 100 دولار';
    const parse = mkParse(text, {
      categories: [guess('real_estate.apartment', 'شقة')],
      places: [
        { placeId: AZAZ, evidence: 'بإعزاز', strength: null, negated: false },
        { placeId: AFRIN, evidence: 'عفرين', strength: null, negated: false },
      ],
      prices: [{ lo: '10000', hi: '10000', currency: 'USD', unit: null, op: null, opExplicit: false, strength: null, evidence: '100 دولار' }],
    });
    const c = stubClient((_s, q) => {
      assert.deepEqual(Object.keys(q).sort(), ['category', 'deal', 'place_1102', 'place_1103', 'price_op', 'side']);
      return {
        side: choice('seek', 0.83),
        category: choice('real_estate.apartment', 0.91),
        deal: choice('rent', 0.66),
        price_op: choice('lte', 0.7),
        place_1102: noul(0.9),
        place_1103: noul(0.2),
      };
    });
    const r = await resolveWithJev(c, reg, text, parse, { cache: null });
    assert.deepEqual(r.side, { value: 'seek', confidence: 0.83, evidence: text, explicit: false });
    assert.deepEqual(r.category, { value: 'real_estate.apartment', confidence: 0.91, evidence: 'شقة', explicit: false });
    assert.deepEqual(r.deal, { value: 'rent', confidence: 0.66, evidence: text, explicit: false });
    assert.deepEqual(r.priceOp, { value: 'lte', confidence: 0.7, evidence: '100 دولار', explicit: false });
    assert.deepEqual(r.placeStrength, {
      [AZAZ]: { value: 'required', confidence: 0.8, evidence: 'بإعزاز', explicit: false },
      [AFRIN]: { value: 'preferred', confidence: 0.6, evidence: 'عفرين', explicit: false },
    });
    assert.equal(r.engine, 'jev');
    assert.equal(r.model, 'jev-2026-09-15');
    assert.equal(r.latencyMs, 42);
    assert.deepEqual(r.usage, { inputTokens: 321, outputTokens: 7 });
    // state shape
    assert.deepEqual(c.calls[0]!.state, { utterance: text, language: 'ar', context: APP_CONTEXT });
  });

  it('p = 0.5 maps to required with confidence 0', async () => {
    const parse = { ...fullyExplicit(), places: [{ placeId: AZAZ, evidence: 'إعزاز', strength: null, negated: false }] };
    const r = await resolveWithJev(stubClient(() => ({ place_1102: noul(0.5) })), reg, 'x', parse, { cache: null });
    assert.deepEqual(r.placeStrength?.[AZAZ], { value: 'required', confidence: 0, evidence: 'إعزاز', explicit: false });
  });

  it('"other" category is not returned; a deal the resolved category forbids is dropped', async () => {
    const parse = mkParse('بدي شي', {});
    const r1 = await resolveWithJev(stubClient(() => ({ side: choice('seek', 0.9), category: choice(OTHER_CATEGORY, 0.8), deal: choice('sale', 0.6) })), reg, 'بدي شي', parse, { cache: null });
    assert.equal(r1.category, undefined);
    assert.equal(r1.deal?.value, 'sale');
    const r2 = await resolveWithJev(stubClient(() => ({ side: choice('seek', 0.9), category: choice('services.plumbing', 0.8), deal: choice('rent', 0.6) })), reg, 'بدي شي ٢', parse, { cache: null });
    assert.equal(r2.category?.value, 'services.plumbing');
    assert.equal(r2.deal, undefined, 'plumbing does not allow rent');
  });

  it('no network call when nothing needs resolving', async () => {
    const c = stubClient(() => assert.fail('must not be called'));
    const r = await resolveWithJev(c, reg, 'x', fullyExplicit(), { cache: null });
    assert.equal(c.calls.length, 0);
    assert.deepEqual(r, { engine: 'jev', model: 'jev-latest', latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('propagates JevError (caller falls back to rules) and does not cache failures', async () => {
    let n = 0;
    const c = stubClient(() => {
      n++;
      throw new JevError('server', 'Jev HTTP 500', { status: 500 });
    });
    const cache = new JevCache();
    const parse = { ...fullyExplicit(), side: null };
    await assert.rejects(resolveWithJev(c, reg, 'بدي شقة', parse, { cache }), (e: unknown) => e instanceof JevError && e.kind === 'server');
    await assert.rejects(resolveWithJev(c, reg, 'بدي شقة', parse, { cache }));
    assert.equal(n, 2);
    assert.equal(cache.size, 0);
  });
});

// ───────────────────────────── cache ─────────────────────────────

describe('cache (LRU + TTL, sha256 key)', () => {
  const parse = { ...fullyExplicit(), side: null };
  const answer = () => ({ side: choice('seek', 0.9) });

  it('a cache hit avoids the second call and costs nothing', async () => {
    const c = stubClient(answer);
    const cache = new JevCache();
    const a = await resolveWithJev(c, reg, 'بدي شقة للإيجار', parse, { cache });
    const b = await resolveWithJev(c, reg, 'بدّي  شقة للإيجار', parse, { cache }); // diacritics/spaces normalize away
    assert.equal(c.calls.length, 1);
    assert.deepEqual(b.side, a.side);
    assert.equal(b.latencyMs, 0);
    assert.deepEqual(b.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(cache.hits, 1);
    await resolveWithJev(c, reg, 'عندي شقة للإيجار', parse, { cache });
    assert.equal(c.calls.length, 2, 'different text => new call');
  });

  it('key = sha256(model + normalized text + question set)', () => {
    const q = planJevQuestions(reg, parse).questions;
    const k = cacheKey('jev-latest', 'بدي شقة', q);
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.equal(k, cacheKey('jev-latest', 'بدّي شقة', q));
    assert.notEqual(k, cacheKey('jev-other', 'بدي شقة', q));
    assert.notEqual(k, cacheKey('jev-latest', 'بدي شقة', planJevQuestions(reg, { ...parse, deal: null }).questions));
  });

  it('entries expire after the TTL', async () => {
    let t = 0;
    const cache = new JevCache({ ttlMs: 1000, now: () => t });
    const c = stubClient(answer);
    await resolveWithJev(c, reg, 'بدي شقة', parse, { cache });
    t = 999;
    await resolveWithJev(c, reg, 'بدي شقة', parse, { cache });
    assert.equal(c.calls.length, 1);
    t = 2001;
    await resolveWithJev(c, reg, 'بدي شقة', parse, { cache });
    assert.equal(c.calls.length, 2);
  });

  it('evicts the least recently used entry', async () => {
    const cache = new JevCache({ maxEntries: 2 });
    const c = stubClient(answer);
    await resolveWithJev(c, reg, 'نص ١', parse, { cache });
    await resolveWithJev(c, reg, 'نص ٢', parse, { cache });
    await resolveWithJev(c, reg, 'نص ١', parse, { cache }); // refresh 1
    await resolveWithJev(c, reg, 'نص ٣', parse, { cache }); // evicts 2
    assert.equal(c.calls.length, 3);
    await resolveWithJev(c, reg, 'نص ١', parse, { cache });
    assert.equal(c.calls.length, 3, '1 still cached');
    await resolveWithJev(c, reg, 'نص ٢', parse, { cache });
    assert.equal(c.calls.length, 4, '2 was evicted');
  });

  it('identical concurrent requests share one call', async () => {
    const cache = new JevCache();
    const c = stubClient(answer);
    const [a, b] = await Promise.all([resolveWithJev(c, reg, 'بدي بيت', parse, { cache }), resolveWithJev(c, reg, 'بدي بيت', parse, { cache })]);
    assert.equal(c.calls.length, 1);
    assert.deepEqual(a.side, b.side);
  });

  it('cached results cannot be mutated by callers', async () => {
    const cache = new JevCache();
    const c = stubClient(answer);
    const a = await resolveWithJev(c, reg, 'بدي غرفة', parse, { cache });
    a.side!.value = 'provide';
    const b = await resolveWithJev(c, reg, 'بدي غرفة', parse, { cache });
    assert.equal(b.side!.value, 'seek');
  });
});

// ───────────────────────────── against the SIMULATION mock ─────────────────────────────

describe('resolveWithJev against the local mock (simulation)', () => {
  let mock: JevMock;
  before(async () => {
    mock = await startJevMock({ token: 'sim-token-123' });
  });
  after(async () => {
    await mock.close();
  });
  beforeEach(() => mock.reset());

  it('one batched request with only the needed questions; engine jev-sim', async () => {
    const client = createJevClient({ apiKey: 'sim-token-123', baseUrl: mock.url });
    const text = 'بدي شقة للإيجار بإعزاز';
    const parse = mkParse(text, {
      side: exp('seek', 'بدي'),
      deal: exp('rent', 'للإيجار'),
      places: [{ placeId: AZAZ, evidence: 'بإعزاز', strength: null, negated: false }],
    });
    const r = await resolveWithJev(client, reg, text, parse, { cache: null });
    assert.equal(mock.requests.length, 1);
    const body = mock.requests[0]!.body as { state: { utterance: string; language: string }; questions: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.questions).sort(), ['category', 'place_1102']);
    assert.equal(body.state.utterance, text);
    assert.equal(body.state.language, 'ar');
    assert.equal(r.engine, 'jev-sim');
    assert.equal(r.model, 'jev-sim');
    assert.equal(r.category?.value, 'real_estate.apartment');
    assert.equal(r.category?.explicit, false);
    assert.equal(r.placeStrength?.[AZAZ]?.value, 'preferred');
    assert.equal(r.side, undefined, 'explicit side is never overridden');
  });

  it('a wrong label from the server surfaces as bad_response (rules fallback)', async () => {
    const client = createJevClient({ apiKey: 'sim-token-123', baseUrl: mock.url });
    mock.setFaults([{ kind: 'wrong_label', question: 'category' }]);
    await assert.rejects(resolveWithJev(client, reg, 'بدي سيارة', mkParse('بدي سيارة', { side: exp('seek') }), { cache: null }), (e: unknown) => e instanceof JevError && e.kind === 'bad_response');
  });
});
