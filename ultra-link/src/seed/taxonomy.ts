// Seed taxonomy: verticals, deal types, categories, attributes, places and their Arabic vocabulary.
// This file is the single source of truth for the initial registry. It is loaded into PostgreSQL by
// `npm run db:seed`, and used directly by unit tests (no DB needed). New entries proposed by agents go
// through schema_proposals and a reviewed migration/seed change — never straight into production rows.

import type { DealCode, RelationKind } from '../domain/types.ts';

export interface VerticalSeed { id: number; code: string; nameAr: string }
export interface DealSeed { id: number; code: DealCode; nameAr: string; relation: RelationKind }
export interface CategorySeed {
  id: number;
  code: string;
  parent: string | null;
  nameAr: string;
  descriptionAr: string; // used as Jev Choice criteria text
  deals: DealCode[];
  keywords: string[]; // Arabic words/phrases (any spelling; normalized at load)
}
export type AttrType = 'int' | 'bool' | 'enum' | 'text';
export interface AttrSeed {
  category: string; // applies to this category and its descendants
  key: string;
  labelAr: string;
  type: AttrType;
  unit?: string;
  min?: number;
  max?: number;
  values?: { code: string; labelAr: string; words: string[] }[];
}
export interface PlaceSeed {
  id: number;
  code: string;
  parent: string | null;
  nameAr: string;
  kind: 'world' | 'country' | 'region' | 'city' | 'virtual';
  aliases?: string[];
  lat?: number; // approximate city centre, used only for distance ranking
  lng?: number;
}

export const VERTICALS: VerticalSeed[] = [
  { id: 1, code: 'real_estate', nameAr: 'عقارات' },
  { id: 2, code: 'vehicles', nameAr: 'مركبات' },
  { id: 3, code: 'services', nameAr: 'خدمات' },
  { id: 4, code: 'education', nameAr: 'تعليم' },
  { id: 5, code: 'activities', nameAr: 'أنشطة' },
  { id: 6, code: 'goods', nameAr: 'سلع' },
  { id: 7, code: 'help', nameAr: 'مساعدة' },
];

export const DEALS: DealSeed[] = [
  { id: 1, code: 'sale', nameAr: 'بيع وشراء', relation: 'exchange' },
  { id: 2, code: 'rent', nameAr: 'إيجار', relation: 'exchange' },
  { id: 3, code: 'service', nameAr: 'خدمة', relation: 'exchange' },
  { id: 4, code: 'lesson', nameAr: 'دروس', relation: 'exchange' },
  { id: 5, code: 'activity', nameAr: 'نشاط مشترك', relation: 'peer' },
  { id: 6, code: 'help', nameAr: 'مساعدة', relation: 'exchange' },
];

export const CATEGORIES: CategorySeed[] = [
  // ── Real estate ──
  { id: 100, code: 'real_estate', parent: null, nameAr: 'عقارات', descriptionAr: 'عقار من أي نوع', deals: ['sale', 'rent'], keywords: ['عقار', 'عقارات'] },
  { id: 101, code: 'real_estate.apartment', parent: 'real_estate', nameAr: 'شقة', descriptionAr: 'شقة سكنية أو بيت للسكن', deals: ['sale', 'rent'], keywords: ['شقة', 'شقه', 'شقق', 'بيت', 'بيوت', 'منزل', 'دار', 'سكن', 'ستوديو', 'استوديو'] },
  { id: 102, code: 'real_estate.villa', parent: 'real_estate', nameAr: 'فيلا أو بيت مستقل', descriptionAr: 'فيلا أو بيت عربي مستقل مع حوش', deals: ['sale', 'rent'], keywords: ['فيلا', 'فيلات', 'بيت عربي', 'بيت مستقل', 'بيت مع حديقة'] },
  { id: 103, code: 'real_estate.room', parent: 'real_estate', nameAr: 'غرفة للإيجار', descriptionAr: 'غرفة واحدة للسكن ضمن بيت مشترك', deals: ['rent'], keywords: ['غرفة للايجار', 'غرفة مفروشة', 'غرفة بسكن'] },
  { id: 104, code: 'real_estate.shop', parent: 'real_estate', nameAr: 'محل تجاري', descriptionAr: 'محل أو دكان تجاري', deals: ['sale', 'rent'], keywords: ['محل', 'محلات', 'دكان', 'دكانة', 'محل تجاري'] },
  { id: 105, code: 'real_estate.land', parent: 'real_estate', nameAr: 'أرض', descriptionAr: 'أرض أو قطعة أرض زراعية أو للبناء', deals: ['sale', 'rent'], keywords: ['ارض', 'أرض', 'قطعة ارض', 'اراضي', 'أراضي', 'ارض زراعية'] },
  // ── Vehicles ──
  { id: 200, code: 'vehicles', parent: null, nameAr: 'مركبات', descriptionAr: 'أي مركبة', deals: ['sale', 'rent'], keywords: ['مركبة', 'مركبات', 'آلية'] },
  { id: 201, code: 'vehicles.car', parent: 'vehicles', nameAr: 'سيارة', descriptionAr: 'سيارة ركاب', deals: ['sale', 'rent'], keywords: ['سيارة', 'سياره', 'سيارات', 'عربية', 'سيارتي', 'سيارتك', 'سيارة سياحية'] },
  { id: 202, code: 'vehicles.motorcycle', parent: 'vehicles', nameAr: 'دراجة نارية', descriptionAr: 'دراجة نارية أو موتور', deals: ['sale', 'rent'], keywords: ['موتور', 'موتورات', 'موتوسيكل', 'دراجة نارية', 'دراجه ناريه', 'متور'] },
  { id: 203, code: 'vehicles.truck', parent: 'vehicles', nameAr: 'شاحنة أو بيك آب', descriptionAr: 'شاحنة أو بيك آب أو فان لنقل البضائع', deals: ['sale', 'rent'], keywords: ['شاحنة', 'شاحنه', 'بيك اب', 'بيكاب', 'فان', 'سوزوكي نقل', 'قاطرة', 'كميون'] },
  // ── Services ──
  { id: 300, code: 'services', parent: null, nameAr: 'خدمات', descriptionAr: 'خدمة يقدّمها شخص', deals: ['service'], keywords: ['خدمة', 'خدمات'] },
  { id: 301, code: 'services.appliance_repair', parent: 'services', nameAr: 'تصليح أجهزة منزلية', descriptionAr: 'تصليح غسالة أو براد أو مكيف أو فرن أو أجهزة كهربائية منزلية', deals: ['service'], keywords: ['تصليح غسالة', 'تصليح غسالات', 'يصلح الغسالة', 'يصلح غسالة', 'يصلح البراد', 'يصلح المكيف', 'فني غسالات', 'فني تبريد', 'صيانة غسالات', 'صيانة مكيفات', 'تصليح مكيف', 'تصليح براد', 'تصليح ثلاجة', 'تصليح فرن'] },
  { id: 302, code: 'services.plumbing', parent: 'services', nameAr: 'سباكة', descriptionAr: 'سبّاك لتمديدات المياه والصرف والتسريب', deals: ['service'], keywords: ['سباك', 'سباكة', 'سبّاك', 'تمديدات صحية', 'تسريب مي', 'تسريب مياه', 'بواري', 'مواسرجي', 'مواسرجية'] },
  { id: 303, code: 'services.electrical', parent: 'services', nameAr: 'كهرباء', descriptionAr: 'كهربائي لتمديدات الكهرباء والأعطال', deals: ['service'], keywords: ['كهربجي', 'كهربائي', 'تمديدات كهرباء', 'عطل كهرباء', 'تركيب طاقة شمسية', 'طاقة شمسية'] },
  { id: 304, code: 'services.cleaning', parent: 'services', nameAr: 'تنظيف', descriptionAr: 'تنظيف بيوت أو مكاتب أو سجاد', deals: ['service'], keywords: ['تنظيف', 'تنضيف', 'عاملة تنظيف', 'تنظيف بيت', 'تنظيف سجاد', 'غسيل سجاد'] },
  { id: 305, code: 'services.moving', parent: 'services', nameAr: 'نقل أثاث', descriptionAr: 'نقل أثاث أو عفش من مكان لآخر', deals: ['service'], keywords: ['نقل اثاث', 'نقل عفش', 'عزال', 'تعزيل', 'نقليات', 'شحن اغراض'] },
  { id: 306, code: 'services.construction', parent: 'services', nameAr: 'بناء وترميم', descriptionAr: 'بناء أو ترميم أو دهان أو تبليط', deals: ['service'], keywords: ['دهان', 'دهّان', 'دهان بيت', 'ترميم', 'بلاط', 'بلّيط', 'معلم بناء', 'عمار', 'تبليط', 'نجار', 'نجارة', 'حداد', 'يصلح الباب', 'تصليح باب', 'تصليح ابواب', 'يصلح الشباك', 'تصليح شبابيك', 'المنيوم', 'تركيب ابواب'] },
  { id: 307, code: 'services.car_repair', parent: 'services', nameAr: 'تصليح سيارات', descriptionAr: 'ميكانيكي أو كهربائي سيارات', deals: ['service'], keywords: ['ميكانيكي', 'ميكانيك', 'تصليح سيارة', 'تصليح سيارات', 'كهربجي سيارات', 'يصلح السيارة', 'يصلح سيارتي'] },
  { id: 308, code: 'services.it_repair', parent: 'services', nameAr: 'صيانة موبايل وكمبيوتر', descriptionAr: 'تصليح موبايلات أو كمبيوترات أو شبكات إنترنت', deals: ['service'], keywords: ['تصليح موبايل', 'تصليح جوال', 'صيانة موبايلات', 'تصليح لابتوب', 'تصليح كمبيوتر', 'يصلح الموبايل', 'يصلح اللابتوب', 'شبكة انترنت', 'تركيب انترنت'] },
  // ── Education ──
  { id: 400, code: 'education', parent: null, nameAr: 'تعليم', descriptionAr: 'تعليم أو تدريب', deals: ['lesson'], keywords: ['تعليم', 'تدريب'] },
  { id: 401, code: 'education.tutoring', parent: 'education', nameAr: 'دروس خصوصية', descriptionAr: 'دروس خصوصية في مادة دراسية أو لغة', deals: ['lesson'], keywords: ['دروس', 'درس', 'دروس خصوصية', 'مدرس', 'مدرّس', 'مدرسة خصوصية', 'استاذ', 'أستاذ', 'معلم', 'معلمة', 'مدرّسة', 'تدريس', 'بدرّس', 'بدرس', 'تقوية'] },
  { id: 402, code: 'education.skills', parent: 'education', nameAr: 'تعلّم مهارة', descriptionAr: 'تعلّم مهارة عملية مثل البرمجة أو الخياطة أو القيادة', deals: ['lesson'], keywords: ['دورة', 'كورس', 'تعلم خياطة', 'تعليم قيادة', 'تعليم سواقة', 'تعلم برمجة', 'دورة برمجة'] },
  // ── Activities (peer) ──
  { id: 500, code: 'activities', parent: null, nameAr: 'أنشطة', descriptionAr: 'نشاط مشترك مع آخرين', deals: ['activity'], keywords: ['نشاط', 'انشطة'] },
  { id: 501, code: 'activities.trip', parent: 'activities', nameAr: 'رحلة', descriptionAr: 'رحلة أو سيران أو طلعة مع ناس', deals: ['activity'], keywords: ['رحلة', 'رحله', 'رحلات', 'سيران', 'طلعة', 'طلعه', 'مشوار', 'نزهة', 'شمة هوا', 'شمّة هوا', 'كزدورة', 'رفقة بالطريق', 'رفقه بالطريق', 'رفقة سفر', 'مسافر'] },
  { id: 502, code: 'activities.sports', parent: 'activities', nameAr: 'رياضة جماعية', descriptionAr: 'لعب رياضة جماعية مثل كرة القدم أو المشي', deals: ['activity'], keywords: ['كرة قدم', 'كورة', 'فوتبول', 'طابة', 'رياضة', 'ركض', 'يركض', 'نركض', 'جري', 'الجري', 'مشي', 'يمشي معي', 'نمشي', 'امشي', 'جيم', 'نادي رياضي', 'سلة', 'كرة طائرة', 'تنس', 'بلياردو', 'سباحة'] },
  { id: 503, code: 'activities.study_group', parent: 'activities', nameAr: 'دراسة جماعية', descriptionAr: 'مجموعة للدراسة أو التحضير لامتحان معًا', deals: ['activity'], keywords: ['ندرس سوا', 'دراسة جماعية', 'مجموعة دراسة', 'نحضر للامتحان', 'نحضر سوا', 'نتذاكر', 'نذاكر سوا'] },
  { id: 504, code: 'activities.social', parent: 'activities', nameAr: 'لقاء واهتمامات مشتركة', descriptionAr: 'لقاء ناس لهم نفس الاهتمام مثل القراءة أو الشطرنج', deals: ['activity'], keywords: ['شطرنج', 'نادي قراءة', 'نقرأ', 'نلعب', 'سهرة', 'قعدة', 'لعب ورق', 'طاولة زهر'] },
  // ── Goods ──
  { id: 600, code: 'goods', parent: null, nameAr: 'سلع', descriptionAr: 'غرض أو سلعة', deals: ['sale'], keywords: ['غرض', 'اغراض', 'سلعة'] },
  { id: 601, code: 'goods.electronics', parent: 'goods', nameAr: 'إلكترونيات', descriptionAr: 'موبايل أو لابتوب أو كمبيوتر أو شاشة', deals: ['sale'], keywords: ['موبايل', 'جوال', 'تلفون', 'تلفون ذكي', 'ايفون', 'سامسونج', 'لابتوب', 'لاب توب', 'كمبيوتر', 'تابلت', 'ايباد', 'شاشة', 'بلايستيشن'] },
  { id: 602, code: 'goods.furniture', parent: 'goods', nameAr: 'أثاث', descriptionAr: 'أثاث منزلي مثل كنب أو غرفة نوم أو طاولة', deals: ['sale'], keywords: ['اثاث', 'أثاث', 'كنباية', 'كنب', 'غرفة نوم', 'سفرة', 'طاولة', 'خزانة', 'تخت', 'فرشة', 'موبيليا'] },
  { id: 603, code: 'goods.appliances', parent: 'goods', nameAr: 'أجهزة منزلية', descriptionAr: 'غسالة أو براد أو مكيف أو فرن للبيع', deals: ['sale'], keywords: ['غسالة للبيع', 'براد للبيع', 'ثلاجة للبيع', 'مكيف للبيع', 'فرن للبيع', 'بوتوغاز', 'سخان', 'غسالة', 'براد', 'ثلاجة', 'مكيف', 'فرن'] },
  { id: 604, code: 'goods.clothing', parent: 'goods', nameAr: 'ملابس', descriptionAr: 'ملابس أو أحذية', deals: ['sale'], keywords: ['ملابس', 'تياب', 'تيابات', 'جاكيت', 'فستان', 'صباط', 'احذية', 'بوط'] },
  // ── Help / volunteering ──
  { id: 700, code: 'help', parent: null, nameAr: 'مساعدة', descriptionAr: 'مساعدة أو تطوع', deals: ['help'], keywords: [] },
  { id: 701, code: 'help.general', parent: 'help', nameAr: 'مساعدة عامة وتطوع', descriptionAr: 'شخص يحتاج مساعدة أو متطوع يعرض المساعدة', deals: ['help'], keywords: ['مساعدة', 'مساعده', 'ساعدوني', 'حدا يساعدني', 'تطوع', 'متطوع', 'بساعد', 'فزعة'] },
];

export const ATTRIBUTES: AttrSeed[] = [
  // real estate
  { category: 'real_estate', key: 'rooms', labelAr: 'عدد الغرف', type: 'int', min: 0, max: 20 },
  { category: 'real_estate', key: 'floor', labelAr: 'الطابق', type: 'int', min: -2, max: 60 },
  { category: 'real_estate', key: 'furnished', labelAr: 'مفروشة', type: 'bool' },
  { category: 'real_estate', key: 'area_m2', labelAr: 'المساحة', type: 'int', unit: 'م²', min: 5, max: 100000 },
  { category: 'real_estate', key: 'solar', labelAr: 'طاقة شمسية', type: 'bool' },
  {
    category: 'real_estate', key: 'tenant_type', labelAr: 'نوع السكن', type: 'enum',
    values: [
      { code: 'family', labelAr: 'عائلة', words: ['عائلة', 'عيلة', 'عائلات', 'عيل', 'للعائلات', 'للعيل', 'متزوج', 'عائلي'] },
      { code: 'single', labelAr: 'شاب أعزب', words: ['عازب', 'أعزب', 'عزابية', 'شباب', 'للشباب', 'عزاب'] },
      { code: 'student', labelAr: 'طلاب', words: ['طلاب', 'طالب', 'طالبات', 'للطلاب'] },
    ],
  },
  { category: 'real_estate', key: 'rental_months', labelAr: 'مدة الإيجار بالأشهر', type: 'int', min: 1, max: 120 },
  // vehicles
  {
    category: 'vehicles', key: 'make', labelAr: 'الماركة', type: 'enum',
    values: [
      { code: 'kia', labelAr: 'كيا', words: ['كيا'] },
      { code: 'hyundai', labelAr: 'هيونداي', words: ['هيونداي', 'هونداي', 'هيوندا'] },
      { code: 'toyota', labelAr: 'تويوتا', words: ['تويوتا', 'تيوتا'] },
      { code: 'mercedes', labelAr: 'مرسيدس', words: ['مرسيدس', 'مرسيدس بنز'] },
      { code: 'bmw', labelAr: 'بي إم دبليو', words: ['بي ام', 'بي ام دبليو', 'بيم'] },
      { code: 'opel', labelAr: 'أوبل', words: ['اوبل', 'أوبل'] },
      { code: 'volkswagen', labelAr: 'فولكس فاغن', words: ['فولكس', 'فولكس فاغن', 'جولف', 'باسات'] },
      { code: 'chevrolet', labelAr: 'شيفروليه', words: ['شيفروليه', 'شفروليه', 'شفر'] },
      { code: 'nissan', labelAr: 'نيسان', words: ['نيسان'] },
      { code: 'honda', labelAr: 'هوندا', words: ['هوندا'] },
      { code: 'ford', labelAr: 'فورد', words: ['فورد'] },
      { code: 'peugeot', labelAr: 'بيجو', words: ['بيجو'] },
      { code: 'renault', labelAr: 'رينو', words: ['رينو'] },
      { code: 'skoda', labelAr: 'سكودا', words: ['سكودا'] },
      { code: 'suzuki', labelAr: 'سوزوكي', words: ['سوزوكي'] },
      { code: 'mitsubishi', labelAr: 'ميتسوبيشي', words: ['ميتسوبيشي', 'متسوبيشي'] },
      { code: 'mazda', labelAr: 'مازدا', words: ['مازدا'] },
      { code: 'fiat', labelAr: 'فيات', words: ['فيات'] },
      { code: 'yamaha', labelAr: 'ياماها', words: ['ياماها', 'يماها'] },
      { code: 'honda_moto', labelAr: 'هوندا (موتور)', words: [] },
    ],
  },
  { category: 'vehicles', key: 'model', labelAr: 'الموديل', type: 'text' },
  {
    category: 'vehicles', key: 'condition', labelAr: 'الحالة', type: 'enum',
    values: [
      { code: 'new', labelAr: 'جديدة', words: ['جديده', 'جديد', 'زيرو', 'وكاله'] },
      { code: 'used', labelAr: 'مستعملة', words: ['مستعمله', 'مستعمل', 'مستخدمه'] },
    ],
  },
  { category: 'vehicles', key: 'year', labelAr: 'سنة الصنع', type: 'int', min: 1950, max: 2030 },
  { category: 'vehicles', key: 'mileage_km', labelAr: 'المسافة المقطوعة', type: 'int', unit: 'كم', min: 0, max: 2000000 },
  {
    category: 'vehicles', key: 'transmission', labelAr: 'ناقل الحركة', type: 'enum',
    values: [
      { code: 'automatic', labelAr: 'أوتوماتيك', words: ['اوتوماتيك', 'أوتوماتيك', 'اوتوماتيكي', 'اتوماتيك'] },
      { code: 'manual', labelAr: 'عادي (يدوي)', words: ['عادي', 'يدوي', 'غيار عادي', 'مانيوال'] },
    ],
  },
  {
    category: 'vehicles', key: 'fuel', labelAr: 'الوقود', type: 'enum',
    values: [
      { code: 'petrol', labelAr: 'بنزين', words: ['بنزين'] },
      { code: 'diesel', labelAr: 'مازوت', words: ['مازوت', 'ديزل'] },
      { code: 'hybrid', labelAr: 'هايبرد', words: ['هايبرد', 'هايبرد'] },
      { code: 'electric', labelAr: 'كهرباء', words: ['كهربائية', 'كهربا'] },
    ],
  },
  // services
  {
    category: 'services.appliance_repair', key: 'appliance', labelAr: 'الجهاز', type: 'enum',
    values: [
      { code: 'washing_machine', labelAr: 'غسالة', words: ['غسالة', 'الغسالة', 'غسالات', 'غسالتي'] },
      { code: 'fridge', labelAr: 'براد', words: ['براد', 'البراد', 'ثلاجة', 'الثلاجة', 'برادات'] },
      { code: 'ac', labelAr: 'مكيف', words: ['مكيف', 'المكيف', 'مكيفات', 'كونديشن'] },
      { code: 'oven', labelAr: 'فرن', words: ['فرن', 'الفرن', 'غاز', 'بوتوغاز'] },
      { code: 'tv', labelAr: 'تلفزيون', words: ['تلفزيون', 'التلفزيون', 'شاشة'] },
      { code: 'water_heater', labelAr: 'سخان', words: ['سخان', 'السخان', 'حمام شمسي'] },
    ],
  },
  { category: 'services', key: 'home_visit', labelAr: 'زيارة منزلية', type: 'bool' },
  // education
  {
    category: 'education', key: 'subject', labelAr: 'المادة', type: 'enum',
    values: [
      { code: 'math', labelAr: 'رياضيات', words: ['رياضيات', 'الرياضيات', 'رياضة رياضيات', 'حساب', 'جبر', 'هندسة رياضيات'] },
      { code: 'physics', labelAr: 'فيزياء', words: ['فيزياء', 'الفيزياء', 'فيزيا'] },
      { code: 'chemistry', labelAr: 'كيمياء', words: ['كيمياء', 'الكيمياء', 'كيميا'] },
      { code: 'biology', labelAr: 'علوم', words: ['علوم', 'العلوم', 'احياء', 'الاحياء'] },
      { code: 'arabic', labelAr: 'عربي', words: ['عربي', 'العربي', 'لغة عربية', 'اللغة العربية'] },
      { code: 'english', labelAr: 'إنكليزي', words: ['انكليزي', 'الانكليزي', 'انجليزي', 'الانجليزي', 'انقليزي', 'لغة انكليزية', 'english'] },
      { code: 'turkish', labelAr: 'تركي', words: ['تركي', 'التركي', 'لغة تركية', 'اللغة التركية'] },
      { code: 'french', labelAr: 'فرنسي', words: ['فرنسي', 'الفرنسي', 'فرنساوي'] },
      { code: 'programming', labelAr: 'برمجة', words: ['برمجة', 'البرمجة', 'كمبيوتر', 'معلوماتية'] },
      { code: 'quran', labelAr: 'قرآن', words: ['قران', 'القران', 'تجويد', 'تحفيظ'] },
    ],
  },
  {
    category: 'education', key: 'level', labelAr: 'المرحلة', type: 'enum',
    values: [
      { code: 'primary', labelAr: 'ابتدائي', words: ['ابتدائي', 'الابتدائي', 'ابتدائية'] },
      { code: 'middle', labelAr: 'إعدادي', words: ['اعدادي', 'الاعدادي', 'تاسع', 'التاسع', 'اعدادية'] },
      { code: 'secondary', labelAr: 'ثانوي', words: ['ثانوي', 'الثانوي', 'بكالوريا', 'البكالوريا', 'بكلوريا', 'ثانوية'] },
      { code: 'university', labelAr: 'جامعي', words: ['جامعة', 'جامعي', 'الجامعة'] },
    ],
  },
  {
    category: 'education', key: 'mode', labelAr: 'طريقة الدرس', type: 'enum',
    values: [
      { code: 'in_person', labelAr: 'حضوري', words: ['حضوري', 'بالبيت', 'منزلي'] },
      { code: 'online', labelAr: 'أونلاين', words: ['اونلاين', 'أونلاين', 'اون لاين', 'عن بعد', 'زوم', 'online'] },
    ],
  },
  // activities
  { category: 'activities', key: 'group_size', labelAr: 'عدد الأشخاص', type: 'int', min: 1, max: 200 },
  // goods
  {
    category: 'goods', key: 'condition', labelAr: 'الحالة', type: 'enum',
    values: [
      { code: 'new', labelAr: 'جديد', words: ['جديد', 'جديدة', 'نظامي جديد', 'بكرتونته', 'بكرتونتها'] },
      { code: 'used', labelAr: 'مستعمل', words: ['مستعمل', 'مستعملة', 'مستخدم', 'نظيف'] },
    ],
  },
];

// Approximate coordinates (city centres) — used only to rank by distance, never as a hard filter.
export const PLACES: PlaceSeed[] = [
  { id: 1, code: 'world', parent: null, nameAr: 'أي مكان', kind: 'world', aliases: ['اي مكان', 'أي مكان', 'وين ما كان', 'مو مشكلة المكان'] },
  { id: 10, code: 'sy', parent: 'world', nameAr: 'سوريا', kind: 'country', aliases: ['سوريا', 'سورية'] },
  { id: 11, code: 'sy.aleppo', parent: 'sy', nameAr: 'محافظة حلب', kind: 'region', aliases: ['محافظة حلب', 'ريف حلب', 'ريف حلب الشمالي', 'الريف الشمالي', 'شمال حلب'] },
  { id: 1101, code: 'sy.aleppo.aleppo', parent: 'sy.aleppo', nameAr: 'حلب', kind: 'city', aliases: ['حلب', 'مدينة حلب'], lat: 36.2021, lng: 37.1343 },
  { id: 1102, code: 'sy.aleppo.azaz', parent: 'sy.aleppo', nameAr: 'إعزاز', kind: 'city', aliases: ['إعزاز', 'اعزاز', 'عزاز', 'إعزاز'], lat: 36.5866, lng: 37.0463 },
  { id: 1103, code: 'sy.aleppo.afrin', parent: 'sy.aleppo', nameAr: 'عفرين', kind: 'city', aliases: ['عفرين'], lat: 36.5119, lng: 36.8695 },
  { id: 1104, code: 'sy.aleppo.al_bab', parent: 'sy.aleppo', nameAr: 'الباب', kind: 'city', aliases: ['الباب', 'مدينة الباب'], lat: 36.3708, lng: 37.5157 },
  { id: 1105, code: 'sy.aleppo.jarabulus', parent: 'sy.aleppo', nameAr: 'جرابلس', kind: 'city', aliases: ['جرابلس'], lat: 36.8175, lng: 38.0114 },
  { id: 1106, code: 'sy.aleppo.manbij', parent: 'sy.aleppo', nameAr: 'منبج', kind: 'city', aliases: ['منبج'], lat: 36.5281, lng: 37.9549 },
  { id: 1107, code: 'sy.aleppo.marea', parent: 'sy.aleppo', nameAr: 'مارع', kind: 'city', aliases: ['مارع'], lat: 36.5744, lng: 37.2047 },
  { id: 1108, code: 'sy.aleppo.tal_rifaat', parent: 'sy.aleppo', nameAr: 'تل رفعت', kind: 'city', aliases: ['تل رفعت'], lat: 36.4697, lng: 37.0969 },
  { id: 1109, code: 'sy.aleppo.atarib', parent: 'sy.aleppo', nameAr: 'الأتارب', kind: 'city', aliases: ['الاتارب', 'الأتارب', 'اتارب'], lat: 36.1378, lng: 36.8303 },
  { id: 1110, code: 'sy.aleppo.daret_azza', parent: 'sy.aleppo', nameAr: 'دارة عزة', kind: 'city', aliases: ['دارة عزة', 'داره عزه', 'دارة عزه'], lat: 36.2833, lng: 36.85 },
  { id: 1111, code: 'sy.aleppo.jindires', parent: 'sy.aleppo', nameAr: 'جنديرس', kind: 'city', aliases: ['جنديرس', 'جندريس'], lat: 36.3953, lng: 36.6886 },
  { id: 1112, code: 'sy.aleppo.al_rai', parent: 'sy.aleppo', nameAr: 'الراعي', kind: 'city', aliases: ['الراعي', 'الراعى'], lat: 36.8417, lng: 37.4878 },
  { id: 1113, code: 'sy.aleppo.sawran', parent: 'sy.aleppo', nameAr: 'صوران', kind: 'city', aliases: ['صوران'], lat: 36.5236, lng: 37.2203 },
  { id: 1114, code: 'sy.aleppo.akhtarin', parent: 'sy.aleppo', nameAr: 'أخترين', kind: 'city', aliases: ['اخترين', 'أخترين'], lat: 36.5306, lng: 37.3561 },
  { id: 1115, code: 'sy.aleppo.qabasin', parent: 'sy.aleppo', nameAr: 'قباسين', kind: 'city', aliases: ['قباسين'], lat: 36.3653, lng: 37.6772 },
  { id: 12, code: 'sy.idlib', parent: 'sy', nameAr: 'محافظة إدلب', kind: 'region', aliases: ['محافظة ادلب', 'ريف ادلب', 'ريف إدلب'] },
  { id: 1201, code: 'sy.idlib.idlib', parent: 'sy.idlib', nameAr: 'إدلب', kind: 'city', aliases: ['إدلب', 'ادلب', 'مدينة ادلب'], lat: 35.9306, lng: 36.6339 },
  { id: 1202, code: 'sy.idlib.sarmada', parent: 'sy.idlib', nameAr: 'سرمدا', kind: 'city', aliases: ['سرمدا'], lat: 36.1797, lng: 36.7225 },
  { id: 1203, code: 'sy.idlib.dana', parent: 'sy.idlib', nameAr: 'الدانا', kind: 'city', aliases: ['الدانا', 'دانا'], lat: 36.2139, lng: 36.7739 },
  { id: 1204, code: 'sy.idlib.maarat_misrin', parent: 'sy.idlib', nameAr: 'معرة مصرين', kind: 'city', aliases: ['معرة مصرين', 'معرتمصرين', 'معره مصرين'], lat: 36.0119, lng: 36.6772 },
  { id: 1205, code: 'sy.idlib.ariha', parent: 'sy.idlib', nameAr: 'أريحا', kind: 'city', aliases: ['اريحا', 'أريحا'], lat: 35.8128, lng: 36.6097 },
  { id: 1206, code: 'sy.idlib.jisr_shughur', parent: 'sy.idlib', nameAr: 'جسر الشغور', kind: 'city', aliases: ['جسر الشغور', 'الجسر'], lat: 35.8122, lng: 36.3172 },
  { id: 1207, code: 'sy.idlib.harem', parent: 'sy.idlib', nameAr: 'حارم', kind: 'city', aliases: ['حارم'], lat: 36.2075, lng: 36.5197 },
  { id: 1208, code: 'sy.idlib.salqin', parent: 'sy.idlib', nameAr: 'سلقين', kind: 'city', aliases: ['سلقين'], lat: 36.1386, lng: 36.4492 },
  { id: 1209, code: 'sy.idlib.kafr_takharim', parent: 'sy.idlib', nameAr: 'كفر تخاريم', kind: 'city', aliases: ['كفر تخاريم', 'كفرتخاريم'], lat: 36.1236, lng: 36.5161 },
  { id: 1210, code: 'sy.idlib.atmeh', parent: 'sy.idlib', nameAr: 'أطمة', kind: 'city', aliases: ['اطمة', 'أطمة', 'اطمه'], lat: 36.3, lng: 36.67 },
  { id: 1211, code: 'sy.idlib.binnish', parent: 'sy.idlib', nameAr: 'بنش', kind: 'city', aliases: ['بنش'], lat: 35.9508, lng: 36.7139 },
  { id: 1212, code: 'sy.idlib.saraqib', parent: 'sy.idlib', nameAr: 'سراقب', kind: 'city', aliases: ['سراقب'], lat: 35.8647, lng: 36.8006 },
  { id: 1213, code: 'sy.idlib.maarat_numan', parent: 'sy.idlib', nameAr: 'معرة النعمان', kind: 'city', aliases: ['معرة النعمان', 'المعرة'], lat: 35.6431, lng: 36.6739 },
  { id: 13, code: 'sy.damascus', parent: 'sy', nameAr: 'دمشق', kind: 'region', aliases: ['دمشق', 'الشام', 'بالشام', 'الشام المدينة'] },
  { id: 1301, code: 'sy.damascus.damascus', parent: 'sy.damascus', nameAr: 'مدينة دمشق', kind: 'city', aliases: ['مدينة دمشق'], lat: 33.5138, lng: 36.2765 },
  { id: 14, code: 'sy.rif_dimashq', parent: 'sy', nameAr: 'ريف دمشق', kind: 'region', aliases: ['ريف دمشق', 'ريف الشام'] },
  { id: 15, code: 'sy.homs', parent: 'sy', nameAr: 'حمص', kind: 'region', aliases: ['حمص'] , lat: 34.7324, lng: 36.7137 },
  { id: 16, code: 'sy.hama', parent: 'sy', nameAr: 'حماة', kind: 'region', aliases: ['حماة', 'حماه'], lat: 35.1318, lng: 36.7578 },
  { id: 17, code: 'sy.latakia', parent: 'sy', nameAr: 'اللاذقية', kind: 'region', aliases: ['اللاذقية', 'اللادقية', 'لاذقية'], lat: 35.5317, lng: 35.7901 },
  { id: 18, code: 'sy.tartus', parent: 'sy', nameAr: 'طرطوس', kind: 'region', aliases: ['طرطوس'], lat: 34.8959, lng: 35.8867 },
  { id: 19, code: 'sy.deir_ezzor', parent: 'sy', nameAr: 'دير الزور', kind: 'region', aliases: ['دير الزور', 'الدير'], lat: 35.3359, lng: 40.1408 },
  { id: 20, code: 'sy.raqqa', parent: 'sy', nameAr: 'الرقة', kind: 'region', aliases: ['الرقة', 'الرقه', 'رقة'], lat: 35.9594, lng: 39.0089 },
  { id: 21, code: 'sy.hasakah', parent: 'sy', nameAr: 'الحسكة', kind: 'region', aliases: ['الحسكة', 'الحسكه'], lat: 36.5024, lng: 40.7477 },
  { id: 2102, code: 'sy.hasakah.qamishli', parent: 'sy.hasakah', nameAr: 'القامشلي', kind: 'city', aliases: ['القامشلي', 'قامشلي'], lat: 37.0522, lng: 41.2258 },
  { id: 22, code: 'sy.daraa', parent: 'sy', nameAr: 'درعا', kind: 'region', aliases: ['درعا'], lat: 32.6189, lng: 36.1021 },
  { id: 23, code: 'sy.suwayda', parent: 'sy', nameAr: 'السويداء', kind: 'region', aliases: ['السويداء', 'السويدا'], lat: 32.7089, lng: 36.5695 },
  { id: 30, code: 'tr', parent: 'world', nameAr: 'تركيا', kind: 'country', aliases: ['تركيا'] },
  { id: 31, code: 'tr.gaziantep', parent: 'tr', nameAr: 'غازي عنتاب', kind: 'city', aliases: ['غازي عنتاب', 'عنتاب', 'غازي عينتاب'], lat: 37.0662, lng: 37.3833 },
  { id: 32, code: 'tr.kilis', parent: 'tr', nameAr: 'كلس', kind: 'city', aliases: ['كلس', 'كيليس'], lat: 36.7184, lng: 37.1212 },
  { id: 33, code: 'tr.hatay', parent: 'tr', nameAr: 'هاتاي', kind: 'region', aliases: ['هاتاي', 'انطاكيا', 'أنطاكيا'], lat: 36.2025, lng: 36.1606 },
  { id: 3302, code: 'tr.hatay.reyhanli', parent: 'tr.hatay', nameAr: 'الريحانية', kind: 'city', aliases: ['الريحانية', 'ريحانية', 'الريحانيه'], lat: 36.2679, lng: 36.5674 },
  { id: 34, code: 'tr.istanbul', parent: 'tr', nameAr: 'إسطنبول', kind: 'city', aliases: ['اسطنبول', 'إسطنبول', 'استنبول'], lat: 41.0082, lng: 28.9784 },
  { id: 35, code: 'tr.urfa', parent: 'tr', nameAr: 'أورفا', kind: 'city', aliases: ['اورفا', 'أورفا', 'شانلي اورفا'], lat: 37.1591, lng: 38.7969 },
  { id: 36, code: 'tr.mersin', parent: 'tr', nameAr: 'مرسين', kind: 'city', aliases: ['مرسين'], lat: 36.8121, lng: 34.6415 },
  { id: 90, code: 'online', parent: 'world', nameAr: 'أونلاين', kind: 'virtual', aliases: ['اونلاين', 'أونلاين', 'اون لاين', 'عن بعد', 'اونلاين عن بعد'] },
];
