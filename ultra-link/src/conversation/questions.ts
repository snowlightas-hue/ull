// Clarification question templates. `speech` = same words as `text` with diacritics/pauses to help
// Arabic TTS (tested: skeleton(speech) === skeleton(text), so meaning can't drift).

import type { Registry } from '../domain/registry.ts';
import type { DealCode, Question, Side, SlotName } from '../domain/types.ts';

interface Tpl { text: string; speech: string }
const q = (text: string, speech: string): Tpl => ({ text, speech });

export const TEMPLATES = {
  side: q('عم تدوّر على شي، ولا عندك شي تقدّمه؟', 'عَم تْدَوِّر على شي، وَلّا عِندَك شي تْقَدّْمُه؟'),
  category: q('شو الشي اللي بدك ياه؟ مثلاً شقة، سيارة، تصليح، دروس، رحلة.', 'شو الشي اللي بِدَّك ياه؟ مَثَلاً: شَقّة، سَيّارة، تَصليح، دُروس، رِحلة.'),
  deal_seek: q('بدك تشتري ولا تستأجر؟', 'بِدَّك تِشتِري، وَلّا تِستَأجِر؟'),
  deal_provide: q('للبيع ولا للإيجار؟', 'لَلبَيع، وَلّا لَلإيجار؟'),
  place_seek: q('بأي منطقة بدك ياه؟', 'بِأَيّ مَنطِقة بِدَّك ياه؟'),
  place_provide: q('وين موجود؟', 'وين مَوجود؟'),
  place_service_seek: q('وين بدك الخدمة؟', 'وين بِدَّك الخِدمة؟'),
  place_service_provide: q('بأي منطقة بتشتغل؟', 'بِأَيّ مَنطِقة بْتِشتِغِل؟'),
  place_lesson: q('وين الدروس؟ أو أونلاين؟', 'وين الدُّروس؟ أو أونلاين؟'),
  place_activity: q('من أي مدينة؟', 'مِن أَيّ مَدينة؟'),
  when_activity: q('أي يوم؟', 'أَيّ يوم؟'),
  price_provide: q('قديش السعر؟', 'قَدّيش السِّعر؟'),
  currency: q('بأي عملة؟ دولار، ولا ليرة تركية، ولا ليرة سورية؟', 'بِأَيّ عُملة؟ دولار، وَلّا ليرة تُركية، وَلّا ليرة سورية؟'),
  unit_rent: q('السعر بالشهر ولا بالسنة؟', 'السِّعر بالشَّهر، وَلّا بالسَّنة؟'),
  unit_lesson: q('السعر للحصة ولا بالشهر؟', 'السِّعر لَلحِصّة، وَلّا بالشَّهر؟'),
  unit_service: q('السعر للشغلة كلها ولا بالساعة؟', 'السِّعر لَلشَّغلة كُلّها، وَلّا بالسّاعة؟'),
  subject_provide: q('أي مادة بتدرّس؟', 'أَيّ مادّة بْتْدَرِّس؟'),
  geo: q('وين أنت هلق؟ اضغط «استخدم موقعي الحالي» أو قول اسم المكان.', 'وين أَنت هَلَّق؟ اضغط «استخدم موقعي الحالي» أو قول اسم المكان.'),
  subject_seek: q('بأي مادة؟', 'بِأَيّ مادّة؟'),
} satisfies Record<string, Tpl>;

export type TemplateKey = keyof typeof TEMPLATES;

const CHIP = {
  side: [
    { value: 'seek', label: 'عم دوّر على شي' },
    { value: 'provide', label: 'عندي شي أقدّمه' },
    { value: 'join', label: 'بدي ناس يشاركوني' },
  ],
  category: [
    { value: 'real_estate.apartment', label: 'شقة' },
    { value: 'vehicles.car', label: 'سيارة' },
    { value: 'services', label: 'خدمة أو تصليح' },
    { value: 'education.tutoring', label: 'دروس' },
    { value: 'activities.trip', label: 'رحلة أو نشاط' },
    { value: 'goods', label: 'غرض للبيع' },
  ],
  currency: [
    { value: 'USD', label: 'دولار' },
    { value: 'TRY', label: 'ليرة تركية' },
    { value: 'SYP', label: 'ليرة سورية' },
  ],
  unit_rent: [
    { value: 'month', label: 'بالشهر' },
    { value: 'year', label: 'بالسنة' },
  ],
  unit_lesson: [
    { value: 'session', label: 'للحصة' },
    { value: 'month', label: 'بالشهر' },
    { value: 'hour', label: 'بالساعة' },
  ],
  unit_service: [
    { value: 'total', label: 'للشغلة كلها' },
    { value: 'hour', label: 'بالساعة' },
  ],
  when: [
    { value: 'اليوم', label: 'اليوم' },
    { value: 'بكرا', label: 'بكرا' },
    { value: 'يوم الجمعة', label: 'الجمعة' },
    { value: 'يوم السبت', label: 'السبت' },
  ],
  place_any: [{ value: 'أي مكان', label: 'أي مكان' }],
  online: [{ value: 'أونلاين', label: 'أونلاين' }],
  subject: [
    { value: 'رياضيات', label: 'رياضيات' },
    { value: 'فيزياء', label: 'فيزياء' },
    { value: 'إنكليزي', label: 'إنكليزي' },
    { value: 'عربي', label: 'عربي' },
    { value: 'كيمياء', label: 'كيمياء' },
  ],
};

export function dealOptions(reg: Registry, categoryCode: string, side: Side | null): { value: string; label: string }[] {
  const cat = reg.categoryByCode.get(categoryCode);
  const labels: Partial<Record<DealCode, [string, string]>> = { sale: ['شراء', 'للبيع'], rent: ['إيجار', 'للإيجار'] };
  const opts: { value: string; label: string }[] = (cat?.deals ?? []).map((d) => ({ value: d as string, label: labels[d]?.[side === 'provide' ? 1 : 0] ?? reg.dealByCode.get(d)!.nameAr }));
  // "عندي سيارة" can also mean offering rides (a car with a driver)
  if (categoryCode === 'vehicles.car') opts.push({ value: 'ride', label: side === 'provide' ? 'توصيلات (سيارة مع سائق)' : 'توصيلة (سيارة مع سائق)' });
  return opts;
}

export function makeQuestion(field: SlotName | 'conflict', key: TemplateKey, attempt: number, options?: { value: string; label: string }[]): Question {
  const t = TEMPLATES[key];
  return { id: `${field}:${attempt}`, field, text: t.text, speech: t.speech, options, attempt };
}

export function conflictQuestion(field: SlotName, existingAr: string, incomingAr: string, existingVal: string, incomingVal: string, attempt: number): Question {
  // Built from fixed words + the user's own values; speech = text (no diacritics added to user values).
  const text = `قلت قبل «${existingAr}»، وهلق «${incomingAr}». أيّهما الصحيح؟`;
  return {
    id: `conflict:${field}:${attempt}`,
    field: 'conflict',
    text,
    speech: text.replace(/[«»]/g, ''),
    options: [
      { value: `keep:${existingVal}`, label: existingAr },
      { value: `take:${incomingVal}`, label: incomingAr },
    ],
    conflict: { field, existing: existingVal, incoming: incomingVal },
    attempt,
  };
}

export { CHIP };
