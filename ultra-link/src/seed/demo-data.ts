// Synthetic demo dataset as PURE data (no database, no Node APIs): used by the PostgreSQL seeder
// (src/seed/demo.ts) and by the in-browser demo edition (web-demo/). Clearly labeled synthetic data.
import type { Registry } from '../domain/registry.ts';
import type { IntentSpec, PriceSpec } from '../domain/types.ts';
import { destination } from '../geo/distance.ts';

export const PERSONAS = [
  { handle: 'samer', name: 'سامر (تجريبي)', persona: 'يبحث عن شقة — جرّب: «بدي شقة للإيجار بإعزاز فقط حد أقصى 200 دولار بالشهر، يفضّل طابق أول»' },
  { handle: 'huda', name: 'هدى (تجريبية)', persona: 'تبحث عن سيارة — جرّب: «بدي سيارة بحلب» لتصفح أكثر من 100 نتيجة' },
  { handle: 'rami', name: 'رامي (تجريبي)', persona: 'يحتاج خدمات — جرّب: «بدي شخص يصلّح الغسالة» ثم أجب «بإعزاز»' },
  { handle: 'nour', name: 'نور (تجريبية)', persona: 'تحب الرحلات — جرّب: «بدي أطلع رحلة يوم الجمعة»' },
  { handle: 'omar', name: 'عمر (تجريبي)', persona: 'مدرّس — جرّب: «أنا مدرس وبعطي دروس فيزياء بإعزاز»' },
  { handle: 'layla', name: 'ليلى (تجريبية)', persona: 'تؤجّر شققًا في إعزاز وعفرين (لديها عروض جاهزة)' },
];

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const usd = (n: number) => String(Math.round(n * 100));
const ask = (amount: number, currency: PriceSpec['currency'], unit: PriceSpec['unit']): PriceSpec => ({ op: 'eq', lo: usd(amount), hi: usd(amount), currency, unit, strength: 'required' });
const offer = (reg: Registry, categoryCode: string, deal: IntentSpec['deal'], place: string, price: PriceSpec | null, attrs: IntentSpec['attrs'] = {}, extra: Partial<IntentSpec> = {}): IntentSpec => ({
  side: 'provide', categoryCode, deal,
  place: { pointPlaceId: reg.placeByCode.get(place)!.id, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] },
  price, when: null, attrs, constraints: [], ...extra,
});


export interface DemoUser { handle: string; name: string; persona: string | null; phone: string | null }
export interface DemoItem {
  owner: string; spec: IntentSpec; title: string; ageHours: number;
  /** synthetic live position (drivers "online now"): the seeder writes it to live_positions with a fresh expiry */
  live?: { lat: number; lng: number; accuracyM: number };
}

/**
 * The synthetic dataset as plain data (deterministic for a given `now`). Used by the PostgreSQL seeder
 * below and by the in-browser demo edition, so both show the same offers.
 */
export function buildDemoDataset(reg: Registry, now = Date.now()): { users: DemoUser[]; items: DemoItem[] } {
  const r = rng(20261008);
  const items: DemoItem[] = [];
  const add = (owner: string, spec: IntentSpec, title: string, ageHours = 1) => { items.push({ owner, spec, title, ageHours }); };

  const users: DemoUser[] = PERSONAS.map((p) => ({ handle: p.handle, name: p.name, persona: p.persona, phone: p.handle === 'layla' ? '+90 5XX XXX 0001 (رقم وهمي)' : null }));
  const layla = 'layla';
  const owners: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const handle = `syn_owner_${String(i).padStart(3, '0')}`;
    users.push({ handle, name: `مستخدم تجريبي ${i}`, persona: null, phone: `+90 5XX XXX ${String(1000 + i)} (رقم وهمي)` });
    owners.push(handle);
  }
  const owner = () => owners[Math.floor(r() * owners.length)]!;

  // ── real estate (scenarios: instant match, hard exclusion, possible matches, edit invalidation)
  const apt = 'real_estate.apartment';
  add(layla, offer(reg, apt, 'rent', 'sy.aleppo.azaz', ask(180, 'USD', 'month'), { rooms: 3, floor: 1, furnished: true }), 'شقة 3 غرف طابق أول مفروشة في إعزاز', 5);
  add(owner(), offer(reg, apt, 'rent', 'sy.aleppo.azaz', ask(150, 'USD', 'month'), { rooms: 2, floor: 3, furnished: false }), 'شقة غرفتين طابق ثالث في إعزاز', 30);
  add(owner(), offer(reg, apt, 'rent', 'sy.aleppo.azaz', ask(250, 'USD', 'month'), { rooms: 4, floor: 2 }), 'شقة 4 غرف في إعزاز', 12);
  add(layla, offer(reg, apt, 'rent', 'sy.aleppo.afrin', ask(120, 'USD', 'month'), { rooms: 2, floor: 1 }), 'شقة رخيصة في عفرين', 8);
  add(owner(), offer(reg, apt, 'rent', 'sy.aleppo.azaz', ask(5000, 'TRY', 'month'), { rooms: 2 }), 'شقة بالليرة التركية في إعزاز', 20);
  add(owner(), offer(reg, apt, 'rent', 'sy.aleppo.azaz', ask(2000, 'USD', 'year'), { rooms: 3 }), 'شقة بإيجار سنوي في إعزاز', 40);
  add(owner(), offer(reg, apt, 'rent', 'sy.aleppo.azaz', null, { rooms: 2, floor: 0 }), 'شقة أرضية بدون سعر معلن في إعزاز', 50);
  add(layla, { ...offer(reg, apt, 'rent', 'sy.aleppo.azaz', ask(170, 'USD', 'month'), { rooms: 3, floor: 1 }), constraints: [{ key: 'tenant_type', op: 'eq', value: 'family', strength: 'required' }] }, 'شقة للعائلات فقط في إعزاز', 3);
  add(owner(), offer(reg, apt, 'rent', 'sy.aleppo.marea', ask(100, 'USD', 'month'), { rooms: 2 }), 'شقة في مارع', 60);
  add(owner(), offer(reg, apt, 'sale', 'sy.aleppo.azaz', ask(25000, 'USD', 'total'), { rooms: 3 }), 'شقة للبيع في إعزاز', 70);
  add(owner(), offer(reg, 'real_estate.shop', 'rent', 'sy.idlib.dana', ask(1500, 'TRY', 'month'), {}), 'محل للإيجار في الدانا', 26);

  // ── vehicles: 250 cars in Aleppo city (pagination beyond 100) + some elsewhere
  const makes = ['kia', 'hyundai', 'toyota', 'opel', 'volkswagen', 'nissan', 'mercedes', 'chevrolet', 'peugeot', 'skoda'];
  const models: Record<string, string[]> = { kia: ['ريو', 'سيراتو', 'بيكانتو'], hyundai: ['أكسنت', 'النترا', 'توسان'], toyota: ['كورولا', 'ياريس'], opel: ['أسترا', 'كورسا'], volkswagen: ['جولف', 'باسات'], nissan: ['صني', 'تيدا'], mercedes: ['C200', 'E200'], chevrolet: ['أفيو', 'كروز'], peugeot: ['206', '301'], skoda: ['أوكتافيا', 'فابيا'] };
  for (let i = 0; i < 250; i++) {
    const make = makes[i % makes.length]!;
    const model = models[make]![Math.floor(r() * models[make]!.length)]!;
    const year = 2004 + Math.floor(r() * 18);
    const price = 2000 + Math.round(r() * 130) * 100;
    add(owner(), offer(reg, 'vehicles.car', 'sale', 'sy.aleppo.aleppo', ask(price, 'USD', 'total'), { make, model, year, mileage_km: 50_000 + Math.round(r() * 250) * 1000, transmission: r() < 0.4 ? 'automatic' : 'manual' }), `سيارة ${model} ${year} في حلب`, 1 + i * 2);
  }
  for (let i = 0; i < 8; i++) {
    add(owner(), offer(reg, 'vehicles.car', 'sale', i % 2 ? 'sy.aleppo.azaz' : 'sy.idlib.sarmada', ask(3000 + i * 700, 'USD', 'total'), { make: makes[i]!, year: 2008 + i }), `سيارة ${i % 2 ? 'في إعزاز' : 'في سرمدا'}`, 10 + i);
  }
  add(owner(), offer(reg, 'vehicles.motorcycle', 'sale', 'sy.aleppo.azaz', ask(600, 'USD', 'total'), { year: 2019 }), 'موتور في إعزاز', 15);

  // ── services: provider scope = service area
  const svc = (code: string, place: string, scope: string, title: string, attrs: IntentSpec['attrs'] = {}) => add(owner(), {
    side: 'provide', categoryCode: code, deal: 'service',
    place: { pointPlaceId: reg.placeByCode.get(place)!.id, scopePlaceIds: [reg.placeByCode.get(scope)!.id], scopeStrength: 'required', excludePlaceIds: [] },
    price: null, when: null, attrs, constraints: [],
  }, title, 24);
  svc('services.appliance_repair', 'sy.aleppo.azaz', 'sy.aleppo.azaz', 'فني غسالات وبرادات في إعزاز', { home_visit: true, appliance: ['washing_machine', 'fridge'] });
  svc('services.appliance_repair', 'sy.aleppo.afrin', 'sy.aleppo.afrin', 'فني تصليح أجهزة في عفرين', { appliance: ['washing_machine', 'ac', 'oven'] });
  svc('services.electrical', 'sy.aleppo.marea', 'sy.aleppo', 'كهربائي يخدم كل ريف حلب');
  svc('services.plumbing', 'sy.aleppo.afrin', 'sy.aleppo.afrin', 'سبّاك في عفرين');

  // ── education
  const lesson = (place: string, scope: string[], subject: string, price: number, title: string, mode: string) => add(owner(), {
    side: 'provide', categoryCode: 'education.tutoring', deal: 'lesson',
    place: { pointPlaceId: reg.placeByCode.get(place)!.id, scopePlaceIds: scope.map((s) => reg.placeByCode.get(s)!.id), scopeStrength: 'required', excludePlaceIds: [] },
    price: ask(price, 'USD', 'session'), when: null, attrs: { subject, mode }, constraints: [],
  }, title, 30);
  lesson('sy.aleppo.azaz', ['sy.aleppo.azaz'], 'math', 10, 'مدرّس رياضيات في إعزاز', 'in_person');
  lesson('online', [], 'english', 8, 'مدرّسة إنكليزي أونلاين', 'online');
  // seekers that a tester's offer can match instantly (reverse direction)
  add(owner(), { side: 'seek', categoryCode: 'education.tutoring', deal: 'lesson', place: { pointPlaceId: reg.placeByCode.get('sy.aleppo.azaz')!.id, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [] }, price: null, when: null, attrs: {}, constraints: [{ key: 'subject', op: 'eq', value: 'physics', strength: 'required' }] }, 'طالب بكالوريا يبحث عن مدرّس فيزياء في إعزاز', 6);
  add(owner(), { side: 'seek', categoryCode: 'vehicles.car', deal: 'sale', place: { pointPlaceId: null, scopePlaceIds: [reg.placeByCode.get('sy.aleppo')!.id], scopeStrength: 'required', excludePlaceIds: [] }, price: { op: 'lte', lo: null, hi: usd(6000), currency: 'USD', unit: 'total', strength: 'required' }, when: null, attrs: {}, constraints: [{ key: 'make', op: 'eq', value: 'kia', strength: 'required' }] }, 'يبحث عن سيارة كيا في ريف حلب حتى 6000$', 9);

  // ── activities (peer): Friday trip from Azaz, Saturday trip, football tomorrow
  const day = (offsetDays: number) => {
    const local = new Date(now + 3 * 3600_000);
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offsetDays) - 3 * 3600_000;
    return { from: new Date(start).toISOString(), to: new Date(start + 86_400_000).toISOString() };
  };
  const dow = new Date(now + 3 * 3600_000).getUTCDay();
  const toFri = (5 - dow + 7) % 7;
  const trip = (place: string, offset: number, label: string, title: string, size: number) => add(owner(), {
    side: 'join', categoryCode: 'activities.trip', deal: 'activity',
    place: { pointPlaceId: reg.placeByCode.get(place)!.id, scopePlaceIds: [reg.placeByCode.get(place)!.id], scopeStrength: 'required', excludePlaceIds: [] },
    price: null, when: { ...day(offset), strength: 'required', label }, attrs: { group_size: size }, constraints: [],
  }, title, 4);
  trip('sy.aleppo.azaz', toFri, 'يوم الجمعة', 'مجموعة طالعة رحلة يوم الجمعة من إعزاز', 4);
  trip('sy.aleppo.azaz', toFri + 1, 'يوم السبت', 'رحلة يوم السبت من إعزاز', 3);
  trip('sy.aleppo.afrin', toFri, 'يوم الجمعة', 'رحلة يوم الجمعة من عفرين', 5);

  // ── transport (V2.1 location): 12 drivers with a static GPS point around إعزاز / عفرين / حلب (4 of them "online"
  // with a live position), and 2 riders asking for the nearest car. Fixed offsets — no rng draws, so the data above
  // stays identical. Coordinates are synthetic and never shown to other users (only rounded distances).
  const centre = (code: string) => { const p = reg.placeByCode.get(code)!; return { lat: p.lat!, lng: p.lng! }; };
  const driver = (n: number, city: string, km: number, bearing: number, title: string, o: { scope?: boolean; live?: [number, number]; fare?: PriceSpec } = {}) => {
    const at = destination(centre(city), km, bearing);
    const owner = owners[(n * 7) % owners.length]!;
    items.push({
      owner, title, ageHours: 2 + n,
      spec: {
        side: 'provide', categoryCode: 'transport.ride', deal: 'service',
        place: { pointPlaceId: reg.placeByCode.get(city)!.id, scopePlaceIds: o.scope ? [reg.placeByCode.get(city)!.id] : [], scopeStrength: 'required', excludePlaceIds: [],
          geo: { lat: round6(at.lat), lng: round6(at.lng), accuracyM: 12 + n, source: 'gps' } },
        price: o.fare ?? null, when: null, attrs: {}, constraints: [],
      },
      ...(o.live ? { live: (() => { const l = destination(at, o.live[0], o.live[1]); return { lat: round6(l.lat), lng: round6(l.lng), accuracyM: 10 }; })() } : {}),
    });
  };
  const fare = (try_: number): PriceSpec => ask(try_, 'TRY', 'total');
  driver(1, 'sy.aleppo.azaz', 0.6, 40, 'تكسي أبو خالد — وسط إعزاز', { live: [0.2, 90], fare: fare(60) });
  driver(2, 'sy.aleppo.azaz', 1.8, 200, 'سيارة مع سائق — إعزاز', { live: [0.4, 10] });
  driver(3, 'sy.aleppo.azaz', 3.5, 300, 'تكسي على طريق السلامة', { scope: true, fare: fare(80) });
  driver(4, 'sy.aleppo.azaz', 6.5, 120, 'سرفيس إعزاز — مارع');
  driver(5, 'sy.aleppo.azaz', 9.5, 160, 'تكسي قرب مارع', { scope: true });
  driver(6, 'sy.aleppo.afrin', 0.9, 80, 'تكسي عفرين — الدوار', { live: [0.3, 200], fare: fare(70) });
  driver(7, 'sy.aleppo.afrin', 2.4, 250, 'سيارة مع سائق في عفرين', { scope: true });
  driver(8, 'sy.aleppo.afrin', 5.2, 20, 'توصيلات عفرين وجنديرس');
  driver(9, 'sy.aleppo.aleppo', 1.1, 0, 'تكسي حلب — الجميلية', { live: [0.5, 300], fare: fare(100) });
  driver(10, 'sy.aleppo.aleppo', 2.7, 135, 'تكسي حلب الجديدة', { scope: true });
  driver(11, 'sy.aleppo.aleppo', 4.4, 230, 'سيارة مع سائق — حلب');
  driver(12, 'sy.aleppo.aleppo', 7.8, 60, 'تكسي على أوتوستراد حلب');
  const riderAt = (n: number, city: string, km: number, bearing: number, title: string, radius: number | null) => {
    const at = destination(centre(city), km, bearing);
    items.push({
      owner: owners[n - 1]!, title, ageHours: 1, // indices 0, 1: never a driver's owner ((n·7) mod 30)
      spec: {
        side: 'seek', categoryCode: 'transport.ride', deal: 'service',
        place: { pointPlaceId: reg.placeByCode.get(city)!.id, scopePlaceIds: [], scopeStrength: 'required', excludePlaceIds: [],
          geo: { lat: round6(at.lat), lng: round6(at.lng), accuracyM: 20, source: 'gps' },
          ...(radius ? { radiusKm: { value: radius, strength: 'required' as const } } : { nearest: true }) },
        price: null, when: null, attrs: {}, constraints: [],
      },
    });
  };
  riderAt(1, 'sy.aleppo.azaz', 0.8, 260, 'بدي تكسي قريب مني بإعزاز', null);
  riderAt(2, 'sy.aleppo.aleppo', 1.5, 90, 'بدي سيارة توصلني ضمن 3 كم في حلب', 3);

  return { users, items };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Build a synthetic counterpart that satisfies a user's saved request (demo of "match arrives later"). */
export function counterpartFor(reg: Registry, spec: IntentSpec): IntentSpec | null {
  if (spec.side === 'join') {
    return { ...spec, attrs: { group_size: 3 }, constraints: [] };
  }
  if (spec.side !== 'seek') return null;
  const cat = reg.categoryByCode.get(spec.categoryCode)!;
  const leaf = cat.descendants.length > 1 ? reg.categoryById.get(cat.descendants.find((d) => d !== cat.id)!)!.code : cat.code;
  const point = spec.place.scopePlaceIds[0] ?? spec.place.pointPlaceId ?? reg.placeByCode.get('sy.aleppo.azaz')!.id;
  const attrs: IntentSpec['attrs'] = {};
  for (const c of spec.constraints) {
    if (c.op === 'eq' && c.value !== undefined) attrs[c.key] = c.value;
    else if (c.op === 'gte' && typeof c.value === 'number') attrs[c.key] = c.value;
    else if (c.op === 'lte' && typeof c.value === 'number') attrs[c.key] = c.value;
    else if (c.op === 'in' && c.values?.length) attrs[c.key] = c.values[0]!;
  }
  let price: PriceSpec | null = null;
  if (spec.price) {
    const p = spec.price;
    const amount = p.op === 'lte' ? BigInt(p.hi!) * 9n / 10n : p.op === 'gte' ? BigInt(p.lo!) : BigInt(p.lo ?? p.hi!);
    price = { op: 'eq', lo: amount.toString(), hi: amount.toString(), currency: p.currency ?? 'USD', unit: p.unit ?? (spec.deal === 'sale' ? 'total' : 'month'), strength: 'required' };
  }
  const isService = cat.verticalCode === 'services' || cat.verticalCode === 'education' || cat.verticalCode === 'help';
  return {
    side: 'provide', categoryCode: leaf, deal: spec.deal,
    place: { pointPlaceId: point, scopePlaceIds: isService ? [point] : [], scopeStrength: 'required', excludePlaceIds: [] },
    price, when: spec.when, attrs, constraints: [],
  };
}
