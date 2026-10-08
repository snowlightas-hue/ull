// Bulk import parsing (src/catalog/import.ts) — pure, no database: realistic Levantine shop lines through the real
// parser (applyTurn/buildSpec) with the store as provider and its place as the product's point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedRegistry } from '../../src/domain/registry.ts';
import { amountToMinor, cleanLine, markDuplicates, minorToAmount, parseItem, previewLine, productName, splitImportText, type ParsedItem } from '../../src/catalog/import.ts';

const reg = seedRegistry();
const AZAZ = reg.placeByCode.get('sy.aleppo.azaz')!.id;
const ctx = { placeId: AZAZ, defaults: {} };

const SHOP_LIST = `ايفون 12 مستعمل - 300$
شاحن سامسونج ١٠ دولار
- سامسونج A52 جديد ٣٠٠$
• لابتوب ديل 300 دولار
براد سامسونج ١٠ آلاف ليرة تركي
غسالة بـ٥٠ الف
كنباية 3 مقاعد 150 دولار
جاكيت جلد 25$
كيلو بندورة ٥ ليرات
شاشة 32 انش
مكيف جديد 400 دولار قابل للتفاوض
2) ايباد 2 مستعمل نظيف ٢٠٠ دولار
تلفون نوكيا 20 يورو
صباط رياضي 1500 ليرة تركية
فرن غاز 2 مليون ليرة سورية
$250 لابتوب لينوفو
موبايل شاومي ٣٠٠٠ ليرة
ايفون 12 مستعمل ٣١٠$
سيارة كيا ريو 2015 للايجار 30 دولار باليوم

خزانة خشب 120$`;

function parseList(text: string, existing = new Map<string, { id: string; nameAr: string }>()) {
  const items = splitImportText(text).map((l) => parseItem(reg, { line: l.text }, ctx, l.lineNo));
  markDuplicates(items, existing);
  return new Map(items.map((i) => [i.lineNo, i] as const));
}
const codes = (it: ParsedItem) => it.problems.map((p) => p.code);

test('a pasted Levantine shop list: names, categories, prices (BigInt minor units), currencies, attributes and problems', () => {
  const byLine = parseList(SHOP_LIST, new Map([['خزانه خشب', { id: '00000000-0000-4000-8000-000000000001', nameAr: 'خزانة خشب' }]]));
  assert.equal(byLine.size, 20, 'blank line skipped, 20 products');
  const ok = (n: number, name: string, cat: string, minor: string, cur: string, attrs: Record<string, unknown> = {}) => {
    const it = byLine.get(n)!;
    assert.deepEqual(codes(it), [], `line ${n} «${it.text}» problems`);
    assert.equal(it.nameAr, name, `line ${n} name`);
    assert.equal(it.categoryCode, cat, `line ${n} category`);
    assert.equal(it.amountMinor, minor, `line ${n} amount`);
    assert.equal(it.currency, cur, `line ${n} currency`);
    assert.deepEqual(it.attrs, attrs, `line ${n} attrs`);
    assert.equal(it.spec?.side, 'provide');
    assert.equal(it.spec?.place.pointPlaceId, AZAZ, 'the product sits at the store');
    assert.equal(it.spec?.price?.op, 'eq');
  };
  ok(1, 'ايفون 12 مستعمل', 'goods.electronics', '30000', 'USD', { condition: 'used' });     // «- 300$» (a dash is not a range here)
  ok(2, 'شاحن سامسونج', 'goods.electronics', '1000', 'USD');                                  // «١٠ دولار»
  ok(3, 'سامسونج A52 جديد', 'goods.electronics', '30000', 'USD', { condition: 'new' });     // «٣٠٠$», bullet removed
  ok(4, 'لابتوب ديل', 'goods.electronics', '30000', 'USD');                                   // «300 دولار»
  ok(5, 'براد سامسونج', 'goods.appliances', '1000000', 'TRY');                                // «١٠ آلاف ليرة تركي» = 10,000.00 TRY
  ok(7, 'كنباية 3 مقاعد', 'goods.furniture', '15000', 'USD');
  ok(8, 'جاكيت جلد', 'goods.clothing', '2500', 'USD');
  ok(11, 'مكيف جديد', 'goods.appliances', '40000', 'USD', { condition: 'new' });
  assert.equal(byLine.get(11)!.negotiable, true, '«قابل للتفاوض»');
  ok(12, 'ايباد 2 مستعمل نظيف', 'goods.electronics', '20000', 'USD', { condition: 'used' });
  ok(13, 'تلفون نوكيا', 'goods.electronics', '2000', 'EUR');
  ok(14, 'صباط رياضي', 'goods.clothing', '150000', 'TRY');
  ok(15, 'فرن غاز', 'goods.appliances', '200000000', 'SYP');                                  // «2 مليون ليرة سورية»
  ok(16, 'لابتوب لينوفو', 'goods.electronics', '25000', 'USD');                               // «$250» before the name
  ok(19, 'سيارة كيا ريو 2015 للايجار', 'vehicles.car', '3000', 'USD', { year: 2015, make: 'kia', model: 'ريو' });
  assert.equal(byLine.get(19)!.deal, 'rent');
  assert.equal(byLine.get(19)!.unit, 'day');

  // «بـ٥٠ الف»: the amount is understood (50,000.00) but the currency is missing → blocking problem
  const washer = byLine.get(6)!;
  assert.equal(washer.amountMinor, '5000000');
  assert.deepEqual(codes(washer), ['missing_currency']);
  assert.equal(washer.spec, null);
  // «٣٠٠٠ ليرة» alone: Turkish or Syrian? → asked, never guessed
  assert.deepEqual(codes(byLine.get(17)!), ['ambiguous_lira']);
  // unknown item («بندورة» is not in the catalogue taxonomy) + ambiguous lira
  assert.deepEqual(codes(byLine.get(9)!), ['unknown_category', 'ambiguous_lira']);
  // missing price
  assert.deepEqual(codes(byLine.get(10)!), ['missing_price']);
  assert.equal(byLine.get(10)!.nameAr, 'شاشة 32 انش', 'without a price nothing is stripped from the name');
  // duplicate inside the batch (same name, other price) and duplicate of an existing product
  assert.deepEqual(codes(byLine.get(18)!), ['duplicate_in_batch']);
  assert.equal(byLine.get(18)!.duplicateOf?.lineNo, 1);
  assert.deepEqual(codes(byLine.get(21)!), ['duplicate_existing']);
  assert.equal(byLine.get(21)!.duplicateOf?.id, '00000000-0000-4000-8000-000000000001');
  // warnings are not blocking
  assert.ok(byLine.get(5)!.warnings.some((w) => w.code === 'category_uncertain'), 'براد سامسونج: appliance or electronics?');
});

test('the owner fixes lines with typed fields; the server re-validates (currency, category, amount, deal, unit, condition)', () => {
  const fixCurrency = parseItem(reg, { line: 'غسالة بـ٥٠ الف', currency: 'TRY' }, ctx, 1);
  assert.deepEqual(codes(fixCurrency), []);
  assert.equal(fixCurrency.spec?.price?.lo, '5000000');
  assert.equal(fixCurrency.spec?.price?.currency, 'TRY');
  const fixCategory = parseItem(reg, { line: 'سماعات بلوتوث 15 دولار', categoryCode: 'goods.electronics', nameAr: 'سماعات بلوتوث JBL' }, ctx, 2);
  assert.deepEqual(codes(fixCategory), []);
  assert.equal(fixCategory.nameAr, 'سماعات بلوتوث JBL');
  assert.equal(fixCategory.spec?.categoryCode, 'goods.electronics');
  const fixAmount = parseItem(reg, { line: 'شاشة 32 انش', amount: '١٢٥٫٥', currency: 'USD' }, ctx, 3);
  assert.equal(fixAmount.spec?.price?.lo, '12550');
  assert.deepEqual(codes(parseItem(reg, { line: 'شاشة 32 انش', amount: '12,5', currency: 'USD' }, ctx, 4)), ['bad_amount']);
  const car = parseItem(reg, { line: 'سيارة هونداي 2012 5000 دولار' }, ctx, 5);
  assert.deepEqual(codes(car), ['missing_deal'], 'a car can be sold or rented: never guessed');
  assert.equal(parseItem(reg, { line: 'سيارة هونداي 2012 5000 دولار', deal: 'sale' }, ctx, 6).spec?.deal, 'sale');
  assert.deepEqual(codes(parseItem(reg, { line: 'سيارة هونداي 2012 50 دولار', deal: 'rent' }, ctx, 7)), ['missing_unit']);
  assert.equal(parseItem(reg, { line: 'سيارة هونداي 2012 50 دولار', deal: 'rent', unit: 'day' }, ctx, 8).spec?.price?.unit, 'day');
  assert.deepEqual(parseItem(reg, { line: 'ايفون 11 200$', condition: 'used' }, ctx, 9).spec?.attrs, { condition: 'used' });
  assert.deepEqual(codes(parseItem(reg, { line: 'تصليح موبايلات 10 دولار' }, ctx, 10)), ['not_a_product']);
});

test('import defaults (chosen by the owner) fill a missing currency or deal, with a visible warning', () => {
  const dctx = { placeId: AZAZ, defaults: { currency: 'TRY' as const, deal: 'sale' as const } };
  const w = parseItem(reg, { line: 'غسالة بـ٥٠ الف' }, dctx, 1);
  assert.deepEqual(codes(w), []);
  assert.equal(w.spec?.price?.currency, 'TRY');
  assert.ok(w.warnings.some((x) => x.code === 'currency_defaulted'));
  const car = parseItem(reg, { line: 'سيارة هونداي 2012 5000 دولار' }, dctx, 2);
  assert.equal(car.spec?.deal, 'sale');
  assert.ok(car.warnings.some((x) => x.code === 'deal_defaulted'));
  assert.ok(parseItem(reg, { line: 'غسالة بعفرين 100 دولار' }, ctx, 3).warnings.some((x) => x.code === 'place_ignored'), 'another city in the line is ignored, visibly');
  assert.ok(parseItem(reg, { line: 'بدي ايفون 12 بـ 200 دولار' }, ctx, 4).warnings.some((x) => x.code === 'looks_like_request'));
});

test('preview lines carry a ready-to-confirm item (the client sends it back, possibly edited)', () => {
  const it = parseItem(reg, { line: 'ايفون 12 مستعمل - 300$' }, ctx, 1);
  const v = previewLine(reg, it);
  assert.equal(v.ok, true);
  assert.equal(v.priceAr, '300$');
  assert.deepEqual(v.chips, [{ labelAr: 'الحالة', valueAr: 'مستعمل' }]);
  assert.deepEqual(v.item, { line: 'ايفون 12 مستعمل - 300$', nameAr: 'ايفون 12 مستعمل', categoryCode: 'goods.electronics', deal: 'sale', amount: '300', currency: 'USD', condition: 'used' });
  const again = parseItem(reg, v.item, ctx, 1);
  assert.deepEqual(again.spec, it.spec, 'confirming the preview item yields the same spec');
});

test('helpers: amounts (BigInt, Arabic digits), names, line cleanup, limits', () => {
  assert.deepEqual(['300', '12.5', '٣٠٠', '1,500', '١٬٥٠٠٫٥', '0', '9999999999999.99'].map(amountToMinor), ['30000', '1250', '30000', '150000', '150050', '0', '999999999999999']);
  for (const bad of ['12,5', '1.234', 'abc', '', '-5', '1e3']) assert.equal(amountToMinor(bad), null, bad);
  assert.equal(minorToAmount('30000'), '300');
  assert.equal(minorToAmount('1250'), '12.50');
  assert.equal(minorToAmount('900719925474099312'), '9007199254740993.12', 'beyond 2^53: exact');
  assert.equal(productName('مكيف جديد 400 دولار قابل للتفاوض', true), 'مكيف جديد');
  assert.equal(productName('ايفون 13 بسعر ٤٥٠$ نظيف', true), 'ايفون 13 نظيف');
  assert.equal(productName('ايفون 12', false), 'ايفون 12');
  assert.equal(cleanLine('  ١) ‏ايفون   12  '), 'ايفون 12');
  assert.equal(cleanLine('3. براد'), 'براد');
  assert.equal(splitImportText('\n\n---\nايفون\n').length, 1);
  const long = parseItem(reg, { line: 'ايفون '.repeat(50) + '300$' }, ctx, 1);
  assert.deepEqual(codes(long), ['line_too_long']);
});
