// Realistic fake Arabic data for ui-preview.html (dev only — never imported by the app).
import { formatMoney } from './format.js';

const NOW = Date.now();
export const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
export const ahead = (minutes) => new Date(NOW + minutes * 60000).toISOString();

const PLACES = ['إعزاز', 'عفرين', 'الباب', 'جرابلس', 'مارع', 'حلب', 'الأتارب', 'دارة عزة', 'جنديرس', 'الراعي', 'صوران', 'أخترين'];

const LONG_TITLE = 'أبحث عن شقة مفروشة بالكامل بثلاث غرف نوم وصالون واسع ومطبخ مجهّز وطاقة شمسية، في الطابق الأول أو الثاني، قريبة من المدارس والسوق في مدينة إعزاز أو ما حولها، والأفضل أن تكون مع حديقة صغيرة للأطفال';

const SEEK_TEMPLATES = [
  {
    cat: 'شقة', deal: 'إيجار', title: (p) => `شقة للإيجار في ${p}`, price: () => `حتى ${formatMoney('20000', 'USD', 'month')}`,
    chips: [{ labelAr: 'عدد الغرف', valueAr: '3', strength: 'required' }, { labelAr: 'مفروشة', valueAr: 'نعم', strength: 'preferred' }],
  },
  {
    cat: 'سيارة', deal: 'بيع وشراء', title: () => 'سيارة هيونداي i10 موديل 2016 أو أحدث', price: () => 'حتى 6,500 دولار',
    chips: [{ labelAr: 'ناقل الحركة', valueAr: 'أوتوماتيك', strength: 'required' }, { labelAr: 'الوقود', valueAr: 'بنزين', strength: 'preferred' }],
  },
  {
    cat: 'دروس خصوصية', deal: 'دروس', title: () => 'مدرّس رياضيات للبكالوريا', price: () => formatMoney('500', 'USD', 'hour'),
    chips: [{ labelAr: 'المادة', valueAr: 'رياضيات', strength: 'required' }, { labelAr: 'طريقة الدرس', valueAr: 'حضوري', strength: 'preferred' }],
  },
  {
    cat: 'تصليح أجهزة منزلية', deal: 'خدمة', title: (p) => `فني يصلّح غسالة أوتوماتيك في ${p}`, price: () => null,
    chips: [{ labelAr: 'الجهاز', valueAr: 'غسالة', strength: 'required' }, { labelAr: 'زيارة منزلية', valueAr: 'نعم', strength: 'required' }],
  },
  {
    cat: 'نقل أثاث', deal: 'خدمة', title: (p) => `سيارة لنقل عفش من ${p} إلى إعزاز`, price: () => 'حوالي 40 دولار', when: 'يوم السبت صباحًا',
    chips: [],
  },
  {
    cat: 'أثاث', deal: 'بيع وشراء', title: () => 'غرفة نوم مستعملة بحالة جيدة', price: () => `حتى ${formatMoney('25000', 'USD')}`,
    chips: [{ labelAr: 'الحالة', valueAr: 'مستعمل', strength: 'preferred' }],
  },
];

const STATUSES = (i) => (i % 17 === 16 ? 'expired' : i % 13 === 12 ? 'closed' : i % 11 === 10 ? 'fulfilled' : i % 7 === 6 ? 'paused' : 'active');

export function makeRequests(n = 250) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const long = i === 20;
    const t = SEEK_TEMPLATES[long ? 0 : i % SEEK_TEMPLATES.length];
    const place = PLACES[(i * 5) % PLACES.length];
    const missing = i % 5 === 3;
    out.push({
      id: `req-${i + 1}`,
      side: 'seek',
      status: STATUSES(i),
      version: 1 + (i % 3),
      titleAr: long ? LONG_TITLE : t.title(place),
      categoryAr: t.cat,
      dealAr: t.deal,
      placeAr: missing ? null : place,
      priceAr: missing ? null : t.price(),
      whenAr: missing ? null : (t.when ?? (i % 4 === 0 ? 'خلال هذا الشهر' : null)),
      chips: long
        ? [{ labelAr: 'عدد الغرف', valueAr: '3', strength: 'required' }, { labelAr: 'مفروشة', valueAr: 'نعم', strength: 'required' }, { labelAr: 'طاقة شمسية', valueAr: 'نعم', strength: 'preferred' }, { labelAr: 'الطابق', valueAr: 'الأول أو الثاني', strength: 'preferred' }, { labelAr: 'حديقة', valueAr: 'يُفضّل', strength: 'preferred' }]
        : t.chips,
      matchCounts: { confirmed: i % 4 === 0 ? 2 : 0, possible: i % 3 === 0 ? 3 : 0 },
      createdAt: ago(5 + i * 97),
      updatedAt: i % 6 === 0 ? ago(2 + i * 40) : ago(5 + i * 97),
      expiresAt: ahead(60 * 24 * (30 - (i % 29))),
      synthetic: true,
    });
  }
  return out;
}

export function makeOffers() {
  const base = [
    ['شقة للإيجار في إعزاز، ٣ غرف مع طاقة شمسية', 'شقة', 'إيجار', 'إعزاز', formatMoney('15000', 'USD', 'month'), null, [{ labelAr: 'عدد الغرف', valueAr: '3' }, { labelAr: 'طاقة شمسية', valueAr: 'نعم' }]],
    ['سيارة كيا ريو 2015 للبيع، أوتوماتيك', 'سيارة', 'بيع وشراء', 'عفرين', formatMoney('550000', 'USD'), null, [{ labelAr: 'الماركة', valueAr: 'كيا' }, { labelAr: 'سنة الصنع', valueAr: '2015' }]],
    ['دروس لغة إنكليزية أونلاين لكل المراحل', 'دروس خصوصية', 'دروس', null, formatMoney('700', 'USD', 'session'), 'مساءً بعد الساعة 6', [{ labelAr: 'المادة', valueAr: 'إنكليزي' }, { labelAr: 'طريقة الدرس', valueAr: 'أونلاين' }]],
    ['تصليح مكيفات وبرادات مع زيارة منزلية', 'تصليح أجهزة منزلية', 'خدمة', 'الباب', null, null, [{ labelAr: 'زيارة منزلية', valueAr: 'نعم' }]],
    ['محل تجاري للإيجار على الشارع الرئيسي', 'محل تجاري', 'إيجار', 'مارع', formatMoney('1250000', 'TRY', 'month'), null, []],
    ['غسالة أوتوماتيك مستعملة نظيفة', 'أجهزة منزلية', 'بيع وشراء', 'إعزاز', formatMoney('9000', 'USD'), null, [{ labelAr: 'الحالة', valueAr: 'مستعمل' }]],
  ];
  return base.map(([titleAr, categoryAr, dealAr, placeAr, priceAr, whenAr, chips], i) => ({
    id: `off-${i + 1}`, side: 'provide', status: i === 4 ? 'paused' : 'active', version: 1, titleAr, categoryAr, dealAr, placeAr, priceAr, whenAr, chips,
    matchCounts: { confirmed: i === 0 ? 1 : 0, possible: i === 0 ? 2 : i === 1 ? 1 : 0 },
    createdAt: ago(30 + i * 600), updatedAt: ago(30 + i * 600), expiresAt: ahead(60 * 24 * 20), synthetic: true,
  }));
}

const MY_REQUEST = {
  id: 'req-main', side: 'seek', status: 'active', version: 2, titleAr: 'شقة للإيجار في إعزاز، ٣ غرف', categoryAr: 'شقة', dealAr: 'إيجار',
  placeAr: 'إعزاز', priceAr: `حتى ${formatMoney('20000', 'USD', 'month')}`, whenAr: null,
  chips: [{ labelAr: 'المكان', valueAr: 'إعزاز فقط', strength: 'required' }, { labelAr: 'السعر', valueAr: 'حتى 200 دولار', strength: 'required' }, { labelAr: 'مفروشة', valueAr: 'نعم', strength: 'preferred' }],
  matchCounts: { confirmed: 2, possible: 3 }, createdAt: ago(1), updatedAt: ago(1), expiresAt: ahead(60 * 24 * 30), synthetic: true,
};

const OTHERS = [
  ['شقة ٣ غرف قرب دوار الكف الأخضر', 'إعزاز', formatMoney('15000', 'USD', 'month'), [{ labelAr: 'عدد الغرف', valueAr: '3' }, { labelAr: 'مفروشة', valueAr: 'نعم' }, { labelAr: 'طاقة شمسية', valueAr: 'نعم' }]],
  ['شقة أرضية مع حديقة صغيرة', 'إعزاز', formatMoney('18000', 'USD', 'month'), [{ labelAr: 'عدد الغرف', valueAr: '3' }, { labelAr: 'الطابق', valueAr: 'أرضي' }]],
  ['شقة واسعة في حي المدارس، الطابق الثاني', 'إعزاز', formatMoney('20000', 'USD', 'month'), [{ labelAr: 'عدد الغرف', valueAr: '4' }]],
  ['شقة للإيجار السنوي، بناء جديد', 'إعزاز', formatMoney('200000', 'USD', 'year'), [{ labelAr: 'عدد الغرف', valueAr: '3' }]],
  ['شقة مفروشة بالكامل مع إنترنت', 'إعزاز', formatMoney('19500', 'USD', 'month'), [{ labelAr: 'مفروشة', valueAr: 'نعم' }]],
];

const REASONS = {
  confirmed: [
    { code: 'place_in_scope', polarity: 'plus', text: 'في إعزاز كما طلبت', strength: 'required' },
    { code: 'price_within_max', polarity: 'plus', text: 'السعر 150 دولار شهريًا ضمن سقفك 200 دولار', strength: 'required' },
    { code: 'rooms_eq', polarity: 'plus', text: '3 غرف كما تريد', strength: 'required' },
    { code: 'furnished_ok', polarity: 'plus', text: 'مفروشة', strength: 'preferred' },
    { code: 'solar_missing', polarity: 'minus', text: 'لا توجد طاقة شمسية (تفضيل وليس شرطًا)', strength: 'preferred' },
    { code: 'fresh', polarity: 'info', text: 'أُضيف العرض قبل يومين' },
  ],
  possible: [
    { code: 'place_in_scope', polarity: 'plus', text: 'في إعزاز كما طلبت', strength: 'required' },
    { code: 'price_within_max', polarity: 'plus', text: 'السعر 180 دولار شهريًا ضمن سقفك', strength: 'required' },
    { code: 'rooms_unknown', polarity: 'unknown', text: 'لم يذكر صاحب العرض عدد الغرف بعد', strength: 'required' },
    { code: 'furnished_unknown', polarity: 'unknown', text: 'غير معروف إن كانت مفروشة', strength: 'preferred' },
  ],
  invalidated: [
    { code: 'price_changed', polarity: 'minus', text: 'رُفع السعر إلى 260 دولار شهريًا، أعلى من سقفك', strength: 'required' },
    { code: 'place_in_scope', polarity: 'plus', text: 'في إعزاز', strength: 'required' },
  ],
};

const CONTACTS = [
  { status: 'none' },
  { status: 'pending_out', requestId: 'cr-2' },
  { status: 'pending_in', requestId: 'cr-3' },
  { status: 'accepted', requestId: 'cr-4', counterpart: { displayName: 'أبو أحمد الحلبي', phone: '+963 944 123 456' } },
  { status: 'declined', requestId: 'cr-5' },
];

export function makeMatch(i, { mine = MY_REQUEST } = {}) {
  const state = ['confirmed', 'possible', 'confirmed', 'invalidated', 'possible', 'confirmed'][i % 6];
  const o = OTHERS[i % OTHERS.length];
  const contact = state === 'invalidated' ? { status: 'none' } : CONTACTS[i % CONTACTS.length];
  return {
    id: `m-${i + 1}`,
    state,
    score: state === 'confirmed' ? 9120 - i * 37 : state === 'possible' ? 6840 - i * 21 : 3100,
    kind: 'exchange',
    mine,
    other: {
      id: `o-${i + 1}`, side: 'provide', status: 'active', version: 1, titleAr: o[0], categoryAr: 'شقة', dealAr: 'إيجار',
      placeAr: o[1], priceAr: o[2], whenAr: i % 4 === 1 ? 'متاحة من بداية الشهر القادم' : null, chips: o[3],
      matchCounts: { confirmed: 0, possible: 0 }, createdAt: ago(60 * 24 * 2), updatedAt: ago(60 * 5), expiresAt: null, synthetic: true,
    },
    reasons: REASONS[state],
    missing: state === 'possible' ? ['عدد الغرف', 'هل الشقة مفروشة؟'] : [],
    contact,
    updatedAt: ago(3 + i * 45),
    invalidReasonAr: state === 'invalidated' ? 'لم تعد مطابقة لأن صاحب العرض رفع السعر فوق سقفك.' : undefined,
  };
}

export function makeMatches(n = 37) {
  return Array.from({ length: n }, (_, i) => makeMatch(i));
}

export function makeNotifications(n = 63) {
  const kinds = [
    ['match_new', 'مطابقة جديدة لطلبك', 'شقة ٣ غرف قرب دوار الكف الأخضر تطابق طلب «شقة للإيجار في إعزاز».'],
    ['contact_request', 'طلب تواصل جديد', 'صاحب طلب «مدرّس رياضيات للبكالوريا» يريد التواصل معك.'],
    ['contact_accepted', 'تم قبول طلب التواصل', 'يمكنك الآن الاتصال بأبو أحمد الحلبي.'],
    ['match_invalidated', 'مطابقة لم تعد مناسبة', 'رُفع سعر «شقة أرضية مع حديقة صغيرة» إلى 260 دولار شهريًا.'],
    ['intent_expiring', 'طلبك ينتهي قريبًا', 'ينتهي طلب «سيارة هيونداي i10» بعد 3 أيام. هل ما زلت تبحث؟'],
  ];
  return Array.from({ length: n }, (_, i) => {
    const k = kinds[i % kinds.length];
    return {
      id: `n-${i + 1}`, kind: k[0], titleAr: k[1], bodyAr: k[2], createdAt: ago(2 + i * 53),
      readAt: i < 5 ? null : ago(1 + i * 50),
      // same shape as src/repo/notifications.ts: targets live in `payload`
      payload: k[0].startsWith('match') || k[0].startsWith('contact') ? { matchId: `m-${i + 1}` } : { intentId: 'req-2' },
    };
  });
}

/** Page<T> over an in-memory array, with offset cursors. rangeStart/rangeEnd are 1-based. */
export function pageOf(all, cursor, limit = 20) {
  const start = cursor ? Number(cursor) : 0;
  const items = all.slice(start, start + limit);
  return {
    items,
    total: all.length,
    limit,
    nextCursor: start + limit < all.length ? String(start + limit) : null,
    prevCursor: start > 0 ? String(Math.max(0, start - limit)) : null,
    rangeStart: items.length ? start + 1 : 0,
    rangeEnd: start + items.length,
  };
}

export const SPOKEN = 'بدي شقة بإعزاز بحدود 200 دولار بالشهر، تلات غرف ويفضّل تكون مفروشة';

export const SUMMARY = {
  titleAr: 'شقة للإيجار في إعزاز',
  chips: [
    { labelAr: 'النوع', valueAr: 'شقة', slot: 'category' },
    { labelAr: 'الصفقة', valueAr: 'إيجار', slot: 'deal' },
    { labelAr: 'المكان', valueAr: 'إعزاز', slot: 'place' },
    { labelAr: 'الغرف', valueAr: '3', slot: 'attr.rooms' },
  ],
};

export const QUESTION = {
  id: 'price-1', field: 'price', attempt: 1,
  text: 'كم ميزانيتك الشهرية للإيجار تقريبًا؟',
  speech: 'كَم ميزانيتُك الشهرية للإيجار تقريبًا؟',
  options: [
    { value: '10000', label: 'حتى 100 دولار' },
    { value: '20000', label: 'حتى 200 دولار' },
    { value: '30000', label: 'حتى 300 دولار' },
    { value: 'any', label: 'لا يهم' },
  ],
};

export const CONFLICT_QUESTION = {
  id: 'conflict-place-1', field: 'conflict', attempt: 1,
  text: 'ذكرت مكانين مختلفين. أين تريد الشقة؟',
  speech: 'ذكرتَ مكانين مختلفين. أين تريد الشقة؟',
  conflict: { field: 'place', existing: 'إعزاز', incoming: 'عفرين' },
  options: [{ value: 'existing', label: 'إعزاز' }, { value: 'incoming', label: 'عفرين' }, { value: 'both', label: 'الاثنتان' }],
};

export function makeRun() {
  const items = [0, 1, 2, 4, 5].map((i) => makeMatch(i));
  return {
    intentId: MY_REQUEST.id, version: 2, status: 'done',
    totals: { confirmed: 2, possible: 3, excluded: 3, candidates: 8 },
    exclusions: [
      { code: 'place_out_of_scope', count: 2, textAr: 'خارج إعزاز' },
      { code: 'price_above_max', count: 1, textAr: 'أعلى من سقف السعر' },
    ],
    page: { items, total: 5, limit: 20, nextCursor: null, prevCursor: null, rangeStart: 1, rangeEnd: 5 },
    suggestionsAr: ['وسّع المكان إلى محافظة حلب', 'اقبل شققًا غير مفروشة'],
    truncated: false,
  };
}

export const SAVED_INTENT = { ...MY_REQUEST, id: 'req-new', titleAr: 'رحلة إلى سد ميدانكي يوم الجمعة', side: 'join', categoryAr: 'رحلة', dealAr: 'نشاط مشترك', placeAr: 'عفرين', priceAr: null, whenAr: 'يوم الجمعة القادم', chips: [{ labelAr: 'عدد الأشخاص', valueAr: '4–6', strength: 'preferred' }], matchCounts: { confirmed: 0, possible: 0 }, createdAt: ago(0.2), updatedAt: ago(0.2) };

export const SAVED_RUN = {
  totals: { confirmed: 0, possible: 0, excluded: 3, candidates: 3 },
  exclusions: [{ code: 'when_mismatch', count: 2, textAr: 'في يوم آخر غير الجمعة' }, { code: 'place_out_of_scope', count: 1, textAr: 'خارج عفرين' }],
};

export const EDIT_SPEC = {
  side: 'seek', categoryCode: 'real_estate.apartment', deal: 'rent',
  place: { pointPlaceId: null, scopePlaceIds: [1102], scopeStrength: 'required' },
  price: { op: 'lte', lo: null, hi: '20000', currency: 'USD', unit: 'month', strength: 'required' },
  when: null, attrs: {}, constraints: [],
};

export const EDIT_CHOICES = {
  categories: [
    { code: 'real_estate.apartment', labelAr: 'شقة', deals: ['rent', 'sale'] },
    { code: 'real_estate.villa', labelAr: 'فيلا أو بيت مستقل', deals: ['rent', 'sale'] },
    { code: 'real_estate.room', labelAr: 'غرفة للإيجار', deals: ['rent'] },
    { code: 'real_estate.shop', labelAr: 'محل تجاري', deals: ['rent', 'sale'] },
  ],
  places: [
    { id: 1102, labelAr: 'إعزاز' }, { id: 1103, labelAr: 'عفرين' }, { id: 1104, labelAr: 'الباب' },
    { id: 1107, labelAr: 'مارع' }, { id: 1101, labelAr: 'حلب' }, { id: 11, labelAr: 'محافظة حلب (كلها)' },
  ],
};

export { MY_REQUEST };
