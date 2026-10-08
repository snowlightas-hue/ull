import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRegistry } from '../../src/domain/registry.ts';
import { parseUtterance } from '../../src/nlu/parse.ts';
import { findNumbers, centsToDecimal } from '../../src/nlu/numbers.ts';
import { normalizeAr, skeleton } from '../../src/nlu/arabic.ts';
import { TEMPLATES } from '../../src/conversation/questions.ts';

const reg = seedRegistry();
const now = new Date('2026-10-08T10:00:00Z'); // Thursday, 13:00 in Syria
const p = (t: string) => parseUtterance(reg, t, { now });
const placeCode = (id: number) => reg.placeById.get(id)!.code;

test('number words and digits parse exactly (no floats)', () => {
  const cases: [string, string][] = [
    ['ميتين وخمسين', '250'], ['مية وخمسين الف', '150000'], ['الف وخمسمية', '1500'], ['مليون ونص', '1500000'],
    ['خمس آلاف', '5000'], ['ألفين', '2000'], ['١٥٠٠', '1500'], ['2.5 مليون', '2500000'], ['تلت مية', '300'],
    ['خمسة وعشرين', '25'], ['1,500,000', '1500000'], ['199.99', '199.99'],
  ];
  for (const [t, want] of cases) {
    const n = findNumbers(normalizeAr(t).split(' '));
    assert.equal(n.length, 1, t);
    assert.equal(centsToDecimal(n[0]!.cents), want, t);
  }
});

test('the five product examples are understood', () => {
  const a = p('بدي شقة بإعزاز');
  assert.equal(a.side?.value, 'seek'); assert.equal(a.categories[0]?.value, 'real_estate.apartment'); assert.equal(a.deal, null);
  assert.equal(placeCode(a.places[0]!.placeId), 'sy.aleppo.azaz');
  const b = p('عندي سيارة للبيع');
  assert.equal(b.side?.value, 'provide'); assert.equal(b.categories[0]?.value, 'vehicles.car'); assert.equal(b.deal?.value, 'sale');
  const c = p('بدي شخص يصلّح الغسالة');
  assert.equal(c.side?.value, 'seek'); assert.equal(c.categories[0]?.value, 'services.appliance_repair');
  assert.deepEqual(c.constraints.map((x) => [x.key, x.value]), [['appliance', 'washing_machine']]);
  const d = p('بدي أطلع رحلة يوم الجمعة');
  assert.equal(d.side?.value, 'join'); assert.equal(d.categories[0]?.value, 'activities.trip');
  assert.equal(d.when?.from, '2026-10-08T21:00:00.000Z'); // Friday 00:00 Syria time
  const e = p('أنا مدرس وبعطي دروس رياضيات');
  assert.equal(e.side?.value, 'provide'); assert.equal(e.categories[0]?.value, 'education.tutoring'); assert.equal(e.attrs.subject?.value, 'math');
});

test('hard vs soft vs exact price semantics', () => {
  const max = p('بدي شقة حد أقصى 200 دولار بالشهر').prices[0]!;
  assert.deepEqual([max.op, max.lo, max.hi, max.currency, max.unit, max.strength], ['lte', null, '20000', 'USD', 'month', 'required']);
  const exact = p('بدي شقة بسعر 200 دولار بالضبط').prices[0]!;
  assert.deepEqual([exact.op, exact.lo, exact.hi], ['eq', '20000', '20000']);
  const lt = p('بدي غرفة اقل من 100 دولار').prices[0]!;
  assert.equal(lt.hi, '9999'); // "أقل من" is strict
  const between = p('بدي سيارة بين 3000 و 5000 دولار').prices[0]!;
  assert.deepEqual([between.op, between.lo, between.hi], ['between', '300000', '500000']);
  const approx = p('بدي موبايل بحدود ميتين دولار').prices[0]!;
  assert.deepEqual([approx.op, approx.strength], ['approx', 'preferred']);
  const lira = p('عندي محل ١٥٠٠ ليرة بالشهر').prices[0]!;
  assert.equal(lira.currency, null); // bare "ليرة" is ambiguous (TRY vs SYP) → must be asked
  const tl = p('عندي محل للايجار ١٥٠٠ ليرة تركية بالشهر').prices[0]!;
  assert.deepEqual([tl.currency, tl.unit, tl.lo], ['TRY', 'month', '150000']);
});

test('place strictness and negation', () => {
  assert.equal(p('بدي شقة بإعزاز فقط').places[0]!.strength, 'required');
  assert.equal(p('ما بدي غير إعزاز').places[0]!.strength, 'required');
  assert.equal(p('بدي شقة ويفضل بإعزاز').places[0]!.strength, 'preferred');
  const neg = p('بدي شقة مو بعفرين').places[0]!;
  assert.equal(neg.negated, true);
  // "الباب" as a door must not become the city al-Bab
  assert.equal(p('بدي حدا يصلح الباب').places.length, 0);
  assert.equal(placeCode(p('بدي شقة بالباب').places[0]!.placeId), 'sy.aleppo.al_bab');
});

test('preference vs requirement for attributes', () => {
  const a = p('بدي شقة يفضل طابق أول');
  assert.deepEqual(a.constraints.map((c) => [c.key, c.value, c.strength]), [['floor', 1, 'preferred']]);
  const b = p('بدي شقة لازم طابق أول');
  assert.deepEqual(b.constraints.map((c) => [c.key, c.value, c.strength]), [['floor', 1, 'required']]);
  const c = p('عندي شقة للإيجار 3 غرف مفروشة للعائلات فقط');
  assert.equal(c.attrs.rooms?.value, 3); assert.equal(c.attrs.furnished?.value, true);
  assert.deepEqual(c.constraints.map((x) => [x.key, x.op, x.values, x.strength]), [['tenant_type', 'in', ['family'], 'required']]);
  // a seeker saying "لعائلة" describes themselves (a fact), not a condition on the landlord
  assert.equal(p('بدي شقة للإيجار بالباب لعائلة').attrs.tenant_type?.value, 'family');
  // negation and at-least cues
  assert.deepEqual(p('بدي شقة للإيجار مو بالطابق الأرضي').constraints.map((x) => [x.key, x.op, x.value]), [['floor', 'neq', 0]]);
  assert.deepEqual(p('بدي شقة مو أقل من غرفتين').constraints.map((x) => [x.key, x.op, x.value]), [['rooms', 'gte', 2]]);
  assert.equal(p('بدي استأجر بيك آب ليوم واحد').when, null); // "واحد" is not Sunday
});

test('multi-valued facts and alternatives', () => {
  assert.deepEqual(p('أنا مدرس بدرّس رياضيات وفيزياء').attrs.subject?.value, ['math', 'physics']);
  const s = p('بدي مدرس رياضيات او فيزياء').constraints[0]!;
  assert.deepEqual([s.op, s.values], ['in', ['math', 'physics']]);
});

test('spoken question variants keep exactly the displayed words', () => {
  for (const [k, t] of Object.entries(TEMPLATES)) assert.equal(skeleton(t.speech), skeleton(t.text), k);
});
