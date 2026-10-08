// Load reference data (verticals, deals, categories, places, attributes) into PostgreSQL, and build the
// runtime registry FROM the database (so reviewed additions are picked up without code changes).
import type { Queryable } from '../db/pool.ts';
import { buildRegistry, seedRegistry, type Registry } from '../domain/registry.ts';
import type { AttrSeed, CategorySeed, DealSeed, PlaceSeed, VerticalSeed } from './taxonomy.ts';

export async function syncReference(db: Queryable): Promise<void> {
  const reg = seedRegistry();
  for (const v of reg.verticals) {
    await db.query('INSERT INTO verticals (id, code, name_ar) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name_ar = EXCLUDED.name_ar', [v.id, v.code, v.nameAr]);
  }
  for (const d of reg.deals) {
    await db.query('INSERT INTO deal_types (id, code, name_ar, relation) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name_ar = EXCLUDED.name_ar, relation = EXCLUDED.relation', [d.id, d.code, d.nameAr, d.relation]);
  }
  const cats = [...reg.categories].sort((a, b) => a.depth - b.depth);
  for (const c of cats) {
    const parent = c.parent ? reg.categoryByCode.get(c.parent)!.id : null;
    await db.query(
      `INSERT INTO categories (id, parent_id, code, vertical_id, name_ar, description_ar, depth, relation, allowed_deals, keywords)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, code = EXCLUDED.code, vertical_id = EXCLUDED.vertical_id, name_ar = EXCLUDED.name_ar,
         description_ar = EXCLUDED.description_ar, depth = EXCLUDED.depth, relation = EXCLUDED.relation, allowed_deals = EXCLUDED.allowed_deals, keywords = EXCLUDED.keywords`,
      [c.id, parent, c.code, c.verticalId, c.nameAr, c.descriptionAr, c.depth, c.relation, c.deals.map((d) => reg.dealByCode.get(d)!.id), c.keywords],
    );
  }
  // places: insert parents first; interval codes may shift when the tree grows → update in place
  await db.query('ALTER TABLE places DROP CONSTRAINT IF EXISTS places_lft_key, DROP CONSTRAINT IF EXISTS places_rgt_key');
  const places = [...reg.places].sort((a, b) => a.depth - b.depth);
  for (const p of places) {
    const parent = p.parent ? reg.placeByCode.get(p.parent)!.id : null;
    await db.query(
      `INSERT INTO places (id, parent_id, code, name_ar, kind, depth, lft, rgt, lat, lng, aliases) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, code = EXCLUDED.code, name_ar = EXCLUDED.name_ar, kind = EXCLUDED.kind,
         depth = EXCLUDED.depth, lft = EXCLUDED.lft, rgt = EXCLUDED.rgt, lat = EXCLUDED.lat, lng = EXCLUDED.lng, aliases = EXCLUDED.aliases`,
      [p.id, parent, p.code, p.nameAr, p.kind, p.depth, p.lft, p.rgt, p.lat ?? null, p.lng ?? null, p.aliases ?? []],
    );
  }
  await db.query('ALTER TABLE places ADD CONSTRAINT places_lft_key UNIQUE (lft), ADD CONSTRAINT places_rgt_key UNIQUE (rgt)');
  // keep denormalized point codes consistent if intervals moved
  await db.query('UPDATE intents i SET point_lft = p.lft FROM places p WHERE i.point_place_id = p.id AND i.point_lft IS DISTINCT FROM p.lft');
  for (const a of reg.attributes) {
    const catId = reg.categoryByCode.get(a.category)!.id;
    await db.query(
      `INSERT INTO attribute_defs (category_id, key, label_ar, value_type, unit, min_value, max_value, enum_values)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (category_id, key) DO UPDATE SET label_ar = EXCLUDED.label_ar, value_type = EXCLUDED.value_type, unit = EXCLUDED.unit,
         min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value, enum_values = EXCLUDED.enum_values`,
      [catId, a.key, a.labelAr, a.type, a.unit ?? null, a.min ?? null, a.max ?? null, a.values ? JSON.stringify(a.values) : null],
    );
  }
}

/** Build the registry from the database's ACTIVE rows (same shapes as the seed file). */
export async function loadRegistry(db: Queryable): Promise<Registry> {
  const verticals: VerticalSeed[] = (await db.query('SELECT id, code, name_ar FROM verticals ORDER BY id')).rows.map((r) => ({ id: r.id, code: r.code, nameAr: r.name_ar }));
  const deals: DealSeed[] = (await db.query('SELECT id, code, name_ar, relation FROM deal_types ORDER BY id')).rows.map((r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, relation: r.relation }));
  const dealById = new Map(deals.map((d) => [d.id, d.code]));
  const catRows = (await db.query("SELECT c.*, p.code AS parent_code FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.status = 'active' ORDER BY c.id")).rows;
  const categories: CategorySeed[] = catRows.map((r) => ({ id: r.id, code: r.code, parent: r.parent_code, nameAr: r.name_ar, descriptionAr: r.description_ar, deals: r.allowed_deals.map((d: number) => dealById.get(d)!), keywords: r.keywords }));
  const catById = new Map(catRows.map((r) => [r.id, r.code]));
  const attributes: AttrSeed[] = (await db.query("SELECT * FROM attribute_defs WHERE status = 'active' ORDER BY id")).rows.map((r) => ({
    category: catById.get(r.category_id)!, key: r.key, labelAr: r.label_ar, type: r.value_type, unit: r.unit ?? undefined,
    min: r.min_value === null ? undefined : Number(r.min_value), max: r.max_value === null ? undefined : Number(r.max_value), values: r.enum_values ?? undefined,
  }));
  const placeRows = (await db.query('SELECT p.*, q.code AS parent_code FROM places p LEFT JOIN places q ON q.id = p.parent_id ORDER BY p.lft')).rows;
  const places: PlaceSeed[] = placeRows.map((r) => ({ id: r.id, code: r.code, parent: r.parent_code, nameAr: r.name_ar, kind: r.kind, aliases: r.aliases, lat: r.lat === null ? undefined : Number(r.lat), lng: r.lng === null ? undefined : Number(r.lng) }));
  if (!categories.length || !places.length) throw new Error('reference data missing — run `npm run db:seed`');
  const reg = buildRegistry(verticals, deals, categories, attributes, places);
  // The DB intervals are authoritative for SQL; verify the in-memory build agrees.
  for (const r of placeRows) {
    const p = reg.placeById.get(r.id)!;
    if (p.lft !== r.lft || p.rgt !== r.rgt) throw new Error(`place interval drift for ${r.code}: run npm run db:seed`);
  }
  return reg;
}
