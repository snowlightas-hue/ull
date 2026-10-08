// SYNTHETIC demo store (V2.3) — clearly labeled: the owner and the buyer are users.realm = 'synthetic', the store and
// every product inherit that realm, every product title ends with «(تجريبي)», and the store shows «(تجريبي)» wherever its
// name appears. Synthetic data never matches real users (realm check in the matching engine).
//
// What it creates (idempotent — a second run changes nothing):
//   • persona «أبو أحمد (تجريبي)» (handle abu_ahmad_shop) owning the store «أبو أحمد للموبايلات» in إعزاز with 25
//     products, imported through the SAME path as a pasted list (src/catalog/service.ts confirmImport: parser → preview
//     rules → validateSpec → createIntent → matching), with a fixed importId;
//   • persona «مشتري موبايل (تجريبي)» (handle mobile_buyer) with one request «موبايل للشراء في إعزاز حتى 300 دولار», so
//     the demo shows several products of one store for one request («… منتجات من متجر أبو أحمد للموبايلات (تجريبي)»).
// Prices are illustrative synthetic values, not market data.
//
// Integration (integrator): in src/seed/seed.ts, after `await seedDemo(pool, reg)`:
//   import { seedDemoStores } from './stores-demo.ts';
//   if (!process.argv.includes('--no-demo')) await seedDemoStores(pool, reg);
// (--reset-demo already deletes synthetic users; stores, products and links cascade with them.)
import type pg from 'pg';
import type { Registry } from '../domain/registry.ts';
import type { IntentSpec } from '../domain/types.ts';
import { validateSpec } from '../domain/validate.ts';
import { withTx } from '../db/pool.ts';
import { createIntent } from '../repo/intents.ts';
import { matchIntent } from '../matching/engine.ts';
import type { SessionUser } from '../repo/users.ts';
import { confirmImport, createStore } from '../catalog/service.ts';

export const DEMO_STORE = {
  ownerHandle: 'abu_ahmad_shop',
  ownerName: 'أبو أحمد (تجريبي)',
  ownerPersona: 'صاحب محل موبايلات في إعزاز — متجر تجريبي فيه ٢٥ منتجًا. جرّب «عروضي» ← «متجري»: الإضافة الجماعية والصور وتعديل السعر.',
  buyerHandle: 'mobile_buyer',
  buyerName: 'مشتري موبايل (تجريبي)',
  buyerPersona: 'يبحث عن موبايل في إعزاز حتى ٣٠٠ دولار — يرى عدة منتجات من متجر أبو أحمد (تجريبي) في مطابقاته.',
  storeName: 'أبو أحمد للموبايلات',
  storeDescription: 'متجر تجريبي — بيانات اصطناعية لعرض ميزة المتاجر. الأسعار للتوضيح فقط.',
  hours: 'من ٩ الصبح للـ ٩ المسا',
  importId: '7e1d6a52-2f0b-4c8e-9a51-3c0d5b6e9a01',
} as const;

/** 25 product lines exactly as a shop owner would paste them (all parse without problems). */
export const DEMO_STORE_LINES: readonly string[] = [
  'ايفون 13 برو 128 جيجا مستعمل نظيف - 520$',
  'ايفون 12 مستعمل - 300$',
  'ايفون 11 مستعمل ٢٤٠ دولار',
  'ايفون SE جديد بكرتونته 280$',
  'سامسونج A54 جديد ٣٢٠ دولار',
  'سامسونج A14 جديد 150$',
  'سامسونج S21 مستعمل 260 دولار',
  'موبايل شاومي ريدمي نوت 12 جديد 180$',
  'موبايل نوكيا 105 جديد ٢٥ دولار',
  'شاحن سامسونج سريع ١٠ دولار',
  'شاحن ايفون أصلي 15$',
  'كفر ايفون 13 شفاف ٥$',
  'سماعات ايربودز للايفون 25$',
  'لابتوب ديل i5 مستعمل 350$',
  'لابتوب لينوفو جديد ٤٥٠ دولار',
  'ماك بوك اير M1 مستعمل 600$',
  'ايباد 9 جديد ٣٣٠ دولار',
  'تابلت سامسونج A8 مستعمل 140$',
  'شاشة سامسونج 24 انش 110 دولار',
  'شاشة LG 32 انش ١٧٠ دولار',
  'بلايستيشن 4 مستعمل مع يدين 220$',
  'كمبيوتر مكتبي i7 مستعمل 300 دولار',
  'موبايل شاومي مستعمل 90$',
  'تلفون هواوي Y9 مستعمل ٧٠ دولار',
  'شاحن لابتوب ديل 20$',
];

async function ensureSynthetic(pool: pg.Pool, handle: string, name: string, persona: string): Promise<SessionUser> {
  const { rows } = await pool.query(
    `INSERT INTO users (display_name, handle, realm, persona_ar) VALUES ($1, $2, 'synthetic', $3)
     ON CONFLICT (handle) DO UPDATE SET display_name = EXCLUDED.display_name, persona_ar = EXCLUDED.persona_ar
     RETURNING id, public_id, display_name, realm, handle`,
    [name, handle, persona],
  );
  const r = rows[0];
  if (r.realm !== 'synthetic') throw new Error(`demo handle ${handle} belongs to a non-synthetic user — refusing to seed`);
  return { id: String(r.id), publicId: r.public_id, displayName: r.display_name, realm: 'synthetic', handle: r.handle };
}

export interface SeedStoresResult { storeId: string; products: number; createdProducts: number; buyerRequest: string; matches: number }

export async function seedDemoStores(pool: pg.Pool, reg: Registry, log: (s: string) => void = console.log): Promise<SeedStoresResult> {
  const azaz = reg.placeByCode.get('sy.aleppo.azaz');
  if (!azaz) throw new Error('place sy.aleppo.azaz missing — run syncReference first');
  const owner = await ensureSynthetic(pool, DEMO_STORE.ownerHandle, DEMO_STORE.ownerName, DEMO_STORE.ownerPersona);
  const buyer = await ensureSynthetic(pool, DEMO_STORE.buyerHandle, DEMO_STORE.buyerName, DEMO_STORE.buyerPersona);

  // the buyer's request first, so the store's products find it when they are matched
  let want = (await pool.query(
    `SELECT r.public_id, i.vertical_id, i.id FROM intents i JOIN intent_refs r ON r.vertical_id = i.vertical_id AND r.intent_id = i.id
      WHERE i.user_id = $1 AND i.side = 'seek' AND i.status = 'active' ORDER BY i.id LIMIT 1`, [buyer.id])).rows[0];
  if (!want) {
    const spec: IntentSpec = {
      side: 'seek', categoryCode: 'goods.electronics', deal: 'sale',
      place: { pointPlaceId: null, scopePlaceIds: [azaz.id], scopeStrength: 'required' },
      price: { op: 'lte', lo: null, hi: '30000', currency: 'USD', unit: 'total', strength: 'required' },
      when: null, attrs: {}, constraints: [],
    };
    const v = validateSpec(reg, spec);
    if (!v.ok) throw new Error(`demo buyer spec invalid: ${JSON.stringify(v.issues)}`);
    const c = await withTx(pool, (tx) => createIntent(tx, reg, { userId: buyer.id, realm: 'synthetic', spec: v.spec, titleAr: 'موبايل للشراء في إعزاز (تجريبي)', sourceText: null, conversationId: null }));
    want = { public_id: c.publicId, vertical_id: c.verticalId, id: c.id };
  }

  let store = (await pool.query('SELECT public_id FROM stores WHERE owner_id = $1 ORDER BY id LIMIT 1', [owner.id])).rows[0]?.public_id as string | undefined;
  if (!store) {
    store = (await createStore(pool, reg, owner, { nameAr: DEMO_STORE.storeName, descriptionAr: DEMO_STORE.storeDescription, placeId: azaz.id, contactPref: 'chat', hoursAr: DEMO_STORE.hours })).id;
  }
  const have = (await pool.query('SELECT count(*)::int AS n FROM store_items si JOIN stores s ON s.id = si.store_id WHERE s.public_id = $1', [store])).rows[0].n as number;
  let createdProducts = 0;
  if (have === 0) {
    const r = await confirmImport(pool, reg, owner, store, { importId: DEMO_STORE.importId, defaults: {}, items: DEMO_STORE_LINES.map((line) => ({ line })) });
    createdProducts = r.replay ? 0 : r.created;
  }
  const run = await matchIntent(pool, reg, { verticalId: want.vertical_id, intentId: String(want.id), trigger: 'seed' });
  const products = (await pool.query('SELECT count(*)::int AS n FROM store_items si JOIN stores s ON s.id = si.store_id WHERE s.public_id = $1', [store])).rows[0].n as number;
  log(`demo store «${DEMO_STORE.storeName} (تجريبي)»: ${products} synthetic products (${createdProducts} new); demo buyer request has ${run.totals.confirmed} confirmed + ${run.totals.possible} possible matches`);
  return { storeId: store, products, createdProducts, buyerRequest: want.public_id, matches: run.totals.confirmed + run.totals.possible };
}
