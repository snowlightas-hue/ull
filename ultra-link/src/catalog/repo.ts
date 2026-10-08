// Stores, products and photos — SQL (V2.3, docs/CATALOG.md). Products are ordinary `provide` intents linked through
// store_items; every write to an intent goes through src/repo/intents.ts (createIntent / updateIntent /
// setIntentStatus), so versions, scope keys and the matcher's guarantees are exactly those of any other offer.
// Every function that takes an owner id is owner-scoped: a store or product of someone else is "not found".
import type { Queryable } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import type { Currency, PriceUnit } from '../domain/types.ts';
import { INTENT_COLS, toCard, type IntentCard, type IntentRow } from '../repo/intents.ts';
import { decodeCursor, encodeCursor, type Page } from '../repo/paging.ts';
import { minorToAmount } from './import.ts';

export const CATALOG_LIMITS = {
  storesPerUser: 5,
  productsPerStore: 1000,
  linesPerImport: 200,
  photosPerProduct: 6,
  photoBytes: 5 * 1024 * 1024,
} as const;

/** Product statuses shown in «متجري» (a deleted product is closed AND unlinked, so it never shows). */
export const ITEM_STATUSES = ['active', 'paused', 'expired', 'fulfilled'] as const;

export interface StoreRow {
  id: string; public_id: string; owner_id: string; realm: 'real' | 'synthetic'; name_ar: string; description_ar: string | null;
  place_id: number; contact_pref: 'chat' | 'chat_then_phone'; hours_ar: string | null; status: 'active' | 'paused';
  version: number; next_position: number; created_at: string; updated_at: string;
}

export interface StoreView {
  id: string; nameAr: string; labelAr: string; descriptionAr: string | null; placeId: number; placeAr: string | null;
  contactPref: 'chat' | 'chat_then_phone'; hoursAr: string | null; status: 'active' | 'paused'; version: number; synthetic: boolean;
  counts: { total: number; active: number; paused: number; expired: number; fulfilled: number };
  limits: { products: number; photosPerProduct: number; photoBytes: number; linesPerImport: number };
  createdAt: string; updatedAt: string;
}

export interface PhotoRef { id: string; url: string; slot: number; width: number; height: number; mime: string; bytes: number }

export interface ProductCard extends IntentCard {
  storeId: string;
  nameAr: string;
  position: number;
  pausedByStore: boolean;
  price: { minor: string; amount: string; currency: Currency | null; unit: PriceUnit | null; negotiable: boolean } | null;
  condition: string | null;
  photos: PhotoRef[];
}

const STORE_COLS = 's.id, s.public_id, s.owner_id, s.realm, s.name_ar, s.description_ar, s.place_id, s.contact_pref, s.hours_ar, s.status, s.version, s.next_position, s.created_at, s.updated_at';

export const storeLabel = (name: string, synthetic: boolean) => (synthetic ? `${name} (تجريبي)` : name);
export const photoUrl = (publicId: string) => `/api/photos/${publicId}`;

// ───────────── stores ─────────────
export async function ownStore(db: Queryable, ownerId: string, publicId: string, lock: '' | 'FOR UPDATE' = ''): Promise<StoreRow | null> {
  const { rows } = await db.query(`SELECT ${STORE_COLS} FROM stores s WHERE s.public_id = $1 AND s.owner_id = $2 ${lock}`, [publicId, ownerId]);
  return rows[0] ? { ...rows[0], id: String(rows[0].id), owner_id: String(rows[0].owner_id) } : null;
}

export async function storeCounts(db: Queryable, storeIds: string[]): Promise<Map<string, StoreView['counts']>> {
  const out = new Map<string, StoreView['counts']>();
  for (const id of storeIds) out.set(id, { total: 0, active: 0, paused: 0, expired: 0, fulfilled: 0 });
  if (!storeIds.length) return out;
  const { rows } = await db.query(
    `SELECT si.store_id, i.status, count(*)::int AS n FROM store_items si
       JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id
      WHERE si.store_id = ANY($1::bigint[]) AND i.status = ANY($2) GROUP BY si.store_id, i.status`,
    [storeIds, ITEM_STATUSES],
  );
  for (const r of rows) {
    const c = out.get(String(r.store_id))!;
    c[r.status as keyof Omit<StoreView['counts'], 'total'>] = r.n;
    c.total += r.n;
  }
  return out;
}

export function toStoreView(reg: Registry, s: StoreRow, counts: StoreView['counts']): StoreView {
  const synthetic = s.realm === 'synthetic';
  return {
    id: s.public_id, nameAr: s.name_ar, labelAr: storeLabel(s.name_ar, synthetic), descriptionAr: s.description_ar, placeId: s.place_id,
    placeAr: reg.placeById.get(s.place_id)?.nameAr ?? null, contactPref: s.contact_pref, hoursAr: s.hours_ar, status: s.status, version: s.version,
    synthetic, counts,
    limits: { products: CATALOG_LIMITS.productsPerStore, photosPerProduct: CATALOG_LIMITS.photosPerProduct, photoBytes: CATALOG_LIMITS.photoBytes, linesPerImport: CATALOG_LIMITS.linesPerImport },
    createdAt: new Date(s.created_at).toISOString(), updatedAt: new Date(s.updated_at).toISOString(),
  };
}

export async function storeViewOf(db: Queryable, reg: Registry, s: StoreRow): Promise<StoreView> {
  return toStoreView(reg, s, (await storeCounts(db, [s.id])).get(s.id)!);
}

export async function listOwnStores(db: Queryable, reg: Registry, ownerId: string): Promise<StoreView[]> {
  const { rows } = await db.query(`SELECT ${STORE_COLS} FROM stores s WHERE s.owner_id = $1 ORDER BY s.created_at, s.id`, [ownerId]);
  const stores: StoreRow[] = rows.map((r) => ({ ...r, id: String(r.id), owner_id: String(r.owner_id) }));
  const counts = await storeCounts(db, stores.map((s) => s.id));
  return stores.map((s) => toStoreView(reg, s, counts.get(s.id)!));
}

export interface StoreInput { nameAr: string; descriptionAr?: string | null; placeId: number; contactPref?: 'chat' | 'chat_then_phone'; hoursAr?: string | null }

/** Insert a store (≤ storesPerUser per owner, serialised per owner by an advisory lock). Realm comes from the owner. */
export async function insertStore(tx: Queryable, ownerId: string, input: StoreInput): Promise<StoreRow | 'limit'> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('ul_catalog_stores'), hashtext($1))", [ownerId]);
  const n = (await tx.query('SELECT count(*)::int AS n FROM stores WHERE owner_id = $1', [ownerId])).rows[0].n as number;
  if (n >= CATALOG_LIMITS.storesPerUser) return 'limit';
  const { rows } = await tx.query(
    `INSERT INTO stores (owner_id, realm, name_ar, description_ar, place_id, contact_pref, hours_ar)
     VALUES ($1, 'real', $2, $3, $4, $5, $6) RETURNING id`, // realm is overwritten by the trigger with the owner's realm
    [ownerId, input.nameAr, input.descriptionAr ?? null, input.placeId, input.contactPref ?? 'chat', input.hoursAr ?? null],
  );
  const { rows: r2 } = await tx.query(`SELECT ${STORE_COLS} FROM stores s WHERE s.id = $1`, [rows[0].id]);
  return { ...r2[0], id: String(r2[0].id), owner_id: String(r2[0].owner_id) };
}

export async function updateStoreRow(tx: Queryable, s: StoreRow, ch: Partial<StoreInput> & { status?: 'active' | 'paused' }): Promise<StoreRow> {
  const { rows } = await tx.query(
    `UPDATE stores SET name_ar = $2, description_ar = $3, place_id = $4, contact_pref = $5, hours_ar = $6, status = $7,
            version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING ${STORE_COLS.replace(/s\./g, '')}`,
    [s.id, ch.nameAr ?? s.name_ar, ch.descriptionAr !== undefined ? ch.descriptionAr : s.description_ar, ch.placeId ?? s.place_id,
      ch.contactPref ?? s.contact_pref, ch.hoursAr !== undefined ? ch.hoursAr : s.hours_ar, ch.status ?? s.status],
  );
  return { ...rows[0], id: String(rows[0].id), owner_id: String(rows[0].owner_id) };
}

// ───────────── items ─────────────
export interface ItemLink { vertical_id: number; intent_id: string; store_id: string; position: number; name_ar: string; paused_by_store: boolean }
type ItemRow = IntentRow & { position: number; item_name: string; paused_by_store: boolean; store_public_id: string };

const ITEM_JOIN = `FROM store_items si JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id JOIN stores s ON s.id = si.store_id`;
const ITEM_COLS = `${INTENT_COLS}, si.position, si.name_ar AS item_name, si.paused_by_store, s.public_id AS store_public_id`;

/** A product of one of the owner's stores, by the store's and the product's (intent's) public ids. */
export async function ownItem(db: Queryable, ownerId: string, storePublicId: string, itemPublicId: string, lock: '' | 'FOR UPDATE OF si' = ''): Promise<{ link: ItemLink; row: ItemRow } | null> {
  const { rows } = await db.query(
    `SELECT ${ITEM_COLS}, si.store_id ${ITEM_JOIN}
      JOIN intent_refs r ON r.vertical_id = si.vertical_id AND r.intent_id = si.intent_id
     WHERE r.public_id = $1 AND s.public_id = $2 AND s.owner_id = $3 ${lock}`,
    [itemPublicId, storePublicId, ownerId],
  );
  const r = rows[0];
  if (!r) return null;
  return { link: { vertical_id: r.vertical_id, intent_id: String(r.id), store_id: String(r.store_id), position: r.position, name_ar: r.item_name, paused_by_store: r.paused_by_store }, row: r };
}

export async function photosFor(db: Queryable, keys: { v: number; id: string }[]): Promise<Map<string, PhotoRef[]>> {
  const out = new Map<string, PhotoRef[]>();
  if (!keys.length) return out;
  const { rows } = await db.query(
    `SELECT p.public_id, p.vertical_id, p.intent_id, p.slot, b.width, b.height, b.mime, b.bytes
       FROM store_item_photos p JOIN media_blobs b ON b.sha256 = p.sha256
      WHERE (p.vertical_id, p.intent_id) IN (SELECT * FROM unnest($1::smallint[], $2::bigint[]))
      ORDER BY p.slot`,
    [keys.map((k) => k.v), keys.map((k) => k.id)],
  );
  for (const r of rows) {
    const k = `${r.vertical_id}:${r.intent_id}`;
    const list = out.get(k) ?? [];
    list.push({ id: r.public_id, url: photoUrl(r.public_id), slot: r.slot, width: r.width, height: r.height, mime: r.mime, bytes: r.bytes });
    out.set(k, list);
  }
  return out;
}

async function matchCounts(db: Queryable, keys: { v: number; id: string }[]): Promise<Map<string, { confirmed: number; possible: number }>> {
  const out = new Map<string, { confirmed: number; possible: number }>();
  if (!keys.length) return out;
  const { rows } = await db.query(
    `SELECT x.v, x.id::text AS id, m.state, count(*)::int AS n
       FROM unnest($1::smallint[], $2::bigint[]) AS x(v, id)
       JOIN matches m ON m.vertical_id = x.v AND (m.a_intent_id = x.id OR m.b_intent_id = x.id)
      WHERE m.state IN ('confirmed','possible') GROUP BY x.v, x.id, m.state`,
    [keys.map((k) => k.v), keys.map((k) => k.id)],
  );
  for (const r of rows) {
    const k = `${r.v}:${r.id}`;
    const c = out.get(k) ?? { confirmed: 0, possible: 0 };
    c[r.state as 'confirmed' | 'possible'] = r.n;
    out.set(k, c);
  }
  return out;
}

export function toProductCard(reg: Registry, r: ItemRow, photos: PhotoRef[], counts?: { confirmed: number; possible: number }): ProductCard {
  const card = toCard(reg, r, counts);
  const minor = r.price_lo ?? r.price_hi;
  const condition = typeof r.attrs?.condition === 'string' ? r.attrs.condition : null;
  return {
    ...card,
    storeId: r.store_public_id,
    nameAr: r.item_name,
    position: r.position,
    pausedByStore: r.paused_by_store,
    price: minor !== null ? { minor: String(minor), amount: minorToAmount(String(minor)), currency: (r.currency?.trim() || null) as Currency | null, unit: r.price_unit as PriceUnit | null, negotiable: r.negotiable } : null,
    condition,
    photos,
  };
}

export async function productCards(db: Queryable, reg: Registry, rows: ItemRow[]): Promise<ProductCard[]> {
  const keys = rows.map((r) => ({ v: r.vertical_id, id: String(r.id) }));
  const [photos, counts] = await Promise.all([photosFor(db, keys), matchCounts(db, keys)]);
  return rows.map((r) => toProductCard(reg, r, photos.get(`${r.vertical_id}:${r.id}`) ?? [], counts.get(`${r.vertical_id}:${r.id}`)));
}

export async function itemCard(db: Queryable, reg: Registry, ownerId: string, storePublicId: string, itemPublicId: string): Promise<ProductCard | null> {
  const it = await ownItem(db, ownerId, storePublicId, itemPublicId);
  return it ? (await productCards(db, reg, [it.row]))[0]! : null;
}

/** Keyset page of a store's products in catalog order (position), with the exact total for the status filter. */
export async function listItems(db: Queryable, reg: Registry, storeId: string, opts: { statuses: string[]; cursor?: string | null; dir?: 'next' | 'prev'; limit: number }): Promise<Page<ProductCard>> {
  const base = `${ITEM_JOIN} WHERE si.store_id = $1 AND i.status = ANY($2)`;
  const total = Number((await db.query(`SELECT count(*) ${base}`, [storeId, opts.statuses])).rows[0].count);
  const cur = decodeCursor(opts.cursor);
  const prev = opts.dir === 'prev' && !!cur;
  const params: unknown[] = [storeId, opts.statuses, opts.limit + 1];
  let keyset = '';
  if (cur) { params.push(Number(cur.k)); keyset = prev ? 'AND si.position < $4' : 'AND si.position > $4'; }
  const { rows } = await db.query(`SELECT ${ITEM_COLS} ${base} ${keyset} ORDER BY si.position ${prev ? 'DESC' : 'ASC'} LIMIT $3`, params);
  const hasMore = rows.length > opts.limit;
  const page: ItemRow[] = rows.slice(0, opts.limit);
  if (prev) page.reverse();
  let rangeStart = 0;
  if (page.length) rangeStart = Number((await db.query(`SELECT count(*) ${base} AND si.position < $3`, [storeId, opts.statuses, page[0]!.position])).rows[0].count) + 1;
  const items = await productCards(db, reg, page);
  const first = page[0];
  const last = page[page.length - 1];
  return {
    items, total, limit: opts.limit,
    nextCursor: last && (prev || hasMore) ? encodeCursor(last.position, String(last.id)) : null,
    prevCursor: first && rangeStart > 1 ? encodeCursor(first.position, String(first.id)) : null,
    rangeStart: items.length ? rangeStart : 0,
    rangeEnd: items.length ? rangeStart + items.length - 1 : 0,
  };
}

/** Normalised names of the store's products (duplicate detection on import). */
export async function existingNames(db: Queryable, storeId: string): Promise<Map<string, { id: string; nameAr: string }>> {
  const { rows } = await db.query(
    `SELECT si.name_norm, si.name_ar, r.public_id FROM store_items si
       JOIN intent_refs r ON r.vertical_id = si.vertical_id AND r.intent_id = si.intent_id
       JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id
      WHERE si.store_id = $1 AND i.status <> 'closed'`,
    [storeId],
  );
  return new Map(rows.map((r) => [r.name_norm as string, { id: r.public_id as string, nameAr: r.name_ar as string }]));
}

/** Products that count against the per-store cap (everything still linked and not closed). */
export async function liveItemCount(db: Queryable, storeId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM store_items si JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id
      WHERE si.store_id = $1 AND i.status <> 'closed'`, [storeId]);
  return rows[0].n;
}

/** Every linked product of a store with its current status/version (bulk store operations). */
export async function storeItemStates(db: Queryable, storeId: string): Promise<{ v: number; id: string; status: string; version: number; pausedByStore: boolean }[]> {
  const { rows } = await db.query(
    `SELECT si.vertical_id, si.intent_id, i.status, i.version, si.paused_by_store FROM store_items si
       JOIN intents i ON i.vertical_id = si.vertical_id AND i.id = si.intent_id
      WHERE si.store_id = $1 ORDER BY si.position FOR UPDATE OF si`,
    [storeId],
  );
  return rows.map((r) => ({ v: r.vertical_id, id: String(r.intent_id), status: r.status, version: r.version, pausedByStore: r.paused_by_store }));
}

/** Link freshly created intents to the store (one statement for the whole batch). */
export async function insertLinks(tx: Queryable, storeId: string, links: { v: number; id: string; position: number; nameAr: string; nameNorm: string; pausedByStore: boolean }[], importId: string | null): Promise<void> {
  if (!links.length) return;
  await tx.query(
    `INSERT INTO store_items (vertical_id, intent_id, store_id, position, name_ar, name_norm, paused_by_store, import_id)
     SELECT t.v, t.id, $1, t.pos, t.name, t.norm, t.pbs, $8 FROM unnest($2::smallint[], $3::bigint[], $4::int[], $5::text[], $6::text[], $7::bool[]) AS t(v, id, pos, name, norm, pbs)`,
    [storeId, links.map((l) => l.v), links.map((l) => l.id), links.map((l) => l.position), links.map((l) => l.nameAr), links.map((l) => l.nameNorm), links.map((l) => l.pausedByStore), importId],
  );
}

// ───────────── photos ─────────────
export interface PhotoAccess { sha256: Buffer; mime: string; bytes: number }

/**
 * Visibility rule (docs/CATALOG.md §4.4): the product's owner always; anyone else only while the product is active,
 * its store is active, and the viewer holds a live (confirmed or possible) match with that product. Anything else —
 * including "no such photo" — is null (→ 404), so a photo id reveals nothing.
 */
export async function photoForViewer(db: Queryable, viewerId: string, photoPublicId: string): Promise<PhotoAccess | null> {
  const { rows } = await db.query(
    `SELECT p.sha256, b.mime, b.bytes, i.user_id, i.status, s.status AS store_status, p.vertical_id, p.intent_id
       FROM store_item_photos p
       JOIN media_blobs b ON b.sha256 = p.sha256
       JOIN store_items si ON si.vertical_id = p.vertical_id AND si.intent_id = p.intent_id
       JOIN stores s ON s.id = si.store_id
       JOIN intents i ON i.vertical_id = p.vertical_id AND i.id = p.intent_id
      WHERE p.public_id = $1`,
    [photoPublicId],
  );
  const r = rows[0];
  if (!r) return null;
  const access = { sha256: r.sha256 as Buffer, mime: r.mime as string, bytes: r.bytes as number };
  if (String(r.user_id) === String(viewerId)) return access;
  if (r.status !== 'active' || r.store_status !== 'active') return null;
  const m = await db.query(
    `SELECT 1 FROM matches m WHERE m.vertical_id = $1 AND m.state IN ('confirmed','possible')
        AND ((m.b_intent_id = $2 AND m.a_user_id = $3) OR (m.a_intent_id = $2 AND m.b_user_id = $3)) LIMIT 1`,
    [r.vertical_id, r.intent_id, viewerId],
  );
  return m.rows[0] ? access : null;
}

/** Upsert the blob row (touches last_used_at so a concurrent garbage collection keeps it). */
export async function upsertBlob(db: Queryable, b: { sha256: Buffer; mime: string; bytes: number; width: number; height: number }): Promise<{ existed: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO media_blobs (sha256, mime, bytes, width, height) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (sha256) DO UPDATE SET last_used_at = now() RETURNING (xmax <> 0) AS existed`,
    [b.sha256, b.mime, b.bytes, b.width, b.height],
  );
  return { existed: rows[0].existed === true };
}

/** Attach a blob to a product: the same image twice is the same photo; at most photosPerProduct. Caller holds the item lock. */
export async function attachPhoto(tx: Queryable, link: ItemLink, sha256: Buffer): Promise<{ photo: { public_id: string; slot: number }; duplicate: boolean } | 'full'> {
  const { rows } = await tx.query('SELECT public_id, slot, sha256 FROM store_item_photos WHERE vertical_id = $1 AND intent_id = $2 ORDER BY slot', [link.vertical_id, link.intent_id]);
  const same = rows.find((r) => Buffer.compare(r.sha256, sha256) === 0);
  if (same) return { photo: { public_id: same.public_id, slot: same.slot }, duplicate: true };
  if (rows.length >= CATALOG_LIMITS.photosPerProduct) return 'full';
  const used = new Set(rows.map((r) => r.slot as number));
  let slot = 1;
  while (used.has(slot)) slot++;
  const ins = await tx.query(
    'INSERT INTO store_item_photos (vertical_id, intent_id, slot, sha256) VALUES ($1,$2,$3,$4) RETURNING public_id, slot',
    [link.vertical_id, link.intent_id, slot, sha256],
  );
  return { photo: ins.rows[0], duplicate: false };
}

export async function deletePhoto(db: Queryable, link: ItemLink, photoPublicId: string): Promise<boolean> {
  const r = await db.query('DELETE FROM store_item_photos WHERE public_id = $1 AND vertical_id = $2 AND intent_id = $3', [photoPublicId, link.vertical_id, link.intent_id]);
  return (r.rowCount ?? 0) > 0;
}

/** Blobs no photo references any more and that nobody touched for `olderThanMs` (removed from the table; caller unlinks files). */
export async function collectUnreferencedBlobs(db: Queryable, olderThanMs: number, limit = 500): Promise<string[]> {
  const { rows } = await db.query(
    `DELETE FROM media_blobs b WHERE b.sha256 IN (
       SELECT x.sha256 FROM media_blobs x
        WHERE x.last_used_at < now() - make_interval(secs => $1::double precision / 1000)
          AND NOT EXISTS (SELECT 1 FROM store_item_photos p WHERE p.sha256 = x.sha256)
        LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING encode(b.sha256, 'hex') AS hex`,
    [olderThanMs, limit],
  );
  return rows.map((r) => r.hex as string);
}
