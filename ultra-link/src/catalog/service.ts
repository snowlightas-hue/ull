// Stores & catalog — use cases (V2.3, docs/CATALOG.md). HTTP-free: routes map CatalogError to {error, messageAr}.
//
// Matching contract (unchanged engine): every product write bumps the intent's version through src/repo/intents.ts and,
// in the SAME transaction, enqueues a `match_intent` job for that version (dedupe key `match:<v>:<id>:<version>`, as the
// core routes do). After commit the new versions are evaluated inline (bounded, see INLINE_MATCH_MAX); whatever is not
// evaluated inline is done by the worker from those jobs. So a crash between commit and the inline run loses nothing.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withTx, type Queryable } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import type { Currency, IntentSpec, PriceUnit } from '../domain/types.ts';
import { validateSpec } from '../domain/validate.ts';
import { createIntent, intentToSpec, loadIntent, setIntentStatus, updateIntent } from '../repo/intents.ts';
import { enqueue } from '../repo/jobs.ts';
import { matchIntent, type MatchTrigger } from '../matching/engine.ts';
import type { SessionUser } from '../repo/users.ts';
import { cleanImage, MediaError, sniffImage } from './media.ts';
import { sha256Hex, type MediaStore } from './media-store.ts';
import { amountToMinor, IMPORT_LIMITS, markDuplicates, normName, parseItem, previewLine, splitImportText, type ImportDefaults, type ItemInput, type ParsedItem, type PreviewLine } from './import.ts';
import {
  attachPhoto, CATALOG_LIMITS, collectUnreferencedBlobs, deletePhoto, existingNames, insertLinks, insertStore, itemCard, listOwnStores, liveItemCount,
  ownItem, ownStore, photoUrl, productCards, storeItemStates, storeViewOf, updateStoreRow, upsertBlob, type ProductCard, type StoreInput, type StoreRow, type StoreView,
} from './repo.ts';

/** Max product versions evaluated inline after one request (the rest is done by the worker from the enqueued jobs). */
export const INLINE_MATCH_MAX = Number(process.env.UL_CATALOG_INLINE_MATCH ?? 250);
const MATCH_CONCURRENCY = Math.max(1, Number(process.env.UL_CATALOG_MATCH_CONCURRENCY ?? 4));

export class CatalogError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, code: string, messageAr: string, extra?: Record<string, unknown>) {
    super(messageAr);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const notFound = () => new CatalogError(404, 'not_found', 'غير موجود');

export const productTitle = (nameAr: string, realm: 'real' | 'synthetic') => (realm === 'synthetic' ? `${nameAr} (تجريبي)` : nameAr);

// ───────────── matching after commit ─────────────
export interface Changed { v: number; id: string; version: number }
export interface RematchSummary { evaluated: number; queued: number; newMatches: number; invalidated: number; confirmed: number; possible: number }

async function enqueueMatch(tx: Queryable, c: Changed, trigger: MatchTrigger): Promise<void> {
  await enqueue(tx, 'match_intent', { verticalId: c.v, intentId: c.id, version: c.version, trigger }, { dedupeKey: `match:${c.v}:${c.id}:${c.version}`, priority: 50 });
}

export async function rematch(pool: pg.Pool, reg: Registry, changed: Changed[], trigger: MatchTrigger): Promise<RematchSummary> {
  const sum: RematchSummary = { evaluated: 0, queued: Math.max(0, changed.length - INLINE_MATCH_MAX), newMatches: 0, invalidated: 0, confirmed: 0, possible: 0 };
  const todo = changed.slice(0, INLINE_MATCH_MAX);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++]!;
      const r = await matchIntent(pool, reg, { verticalId: c.v, intentId: c.id, version: c.version, trigger });
      sum.evaluated++;
      sum.newMatches += r.newMatches;
      sum.invalidated += r.invalidated;
      sum.confirmed += r.totals.confirmed;
      sum.possible += r.totals.possible;
    }
  };
  await Promise.all(Array.from({ length: Math.min(MATCH_CONCURRENCY, todo.length) }, worker));
  return sum;
}

// ───────────── stores ─────────────
function checkPlace(reg: Registry, placeId: number): void {
  const p = reg.placeById.get(placeId);
  if (!p || placeId === reg.rootPlaceId) throw new CatalogError(422, 'bad_place', 'اختر مدينة أو منطقة المتجر');
}

export async function createStore(pool: pg.Pool, reg: Registry, user: SessionUser, input: StoreInput): Promise<StoreView> {
  checkPlace(reg, input.placeId);
  const row = await withTx(pool, (tx) => insertStore(tx, user.id, input));
  if (row === 'limit') throw new CatalogError(409, 'store_limit', `لا يمكن إنشاء أكثر من ${CATALOG_LIMITS.storesPerUser} متاجر لحساب واحد`);
  return storeViewOf(pool, reg, row);
}

export async function myStores(pool: pg.Pool, reg: Registry, user: SessionUser): Promise<StoreView[]> {
  return listOwnStores(pool, reg, user.id);
}

export async function getStore(pool: pg.Pool, reg: Registry, user: SessionUser, storeId: string): Promise<StoreView> {
  const s = await ownStore(pool, user.id, storeId);
  if (!s) throw notFound();
  return storeViewOf(pool, reg, s);
}

/** Edit the profile; a new place moves every product (new intent version → re-match). */
export async function updateStore(pool: pg.Pool, reg: Registry, user: SessionUser, storeId: string, expectedVersion: number, ch: Partial<StoreInput>): Promise<{ store: StoreView; matching: RematchSummary | null }> {
  if (ch.placeId !== undefined) checkPlace(reg, ch.placeId);
  const { store, changed } = await withTx(pool, async (tx) => {
    const s = await ownStore(tx, user.id, storeId, 'FOR UPDATE');
    if (!s) throw notFound();
    if (s.version !== expectedVersion) throw new CatalogError(409, 'version_conflict', 'تغيّر المتجر من مكان آخر. حدّث الصفحة.');
    const changed: Changed[] = [];
    if (ch.placeId !== undefined && ch.placeId !== s.place_id) {
      for (const it of await storeItemStates(tx, s.id)) {
        if (it.status === 'closed') continue;
        const row = await loadIntent(tx, it.v, it.id, 'FOR UPDATE');
        if (!row) continue;
        const spec = intentToSpec(reg, row);
        spec.place = { ...spec.place, pointPlaceId: ch.placeId };
        const v = validateSpec(reg, spec);
        if (!v.ok) continue;
        const r = await updateIntent(tx, reg, it.v, it.id, user.id, row.version, v.spec, row.title_ar);
        if (r.ok) { const c = { v: it.v, id: it.id, version: r.version }; changed.push(c); await enqueueMatch(tx, c, 'edit'); }
      }
    }
    return { store: await updateStoreRow(tx, s, ch), changed };
  });
  const matching = changed.length ? await rematch(pool, reg, changed, 'edit') : null;
  return { store: await storeViewOf(pool, reg, store), matching };
}

/**
 * Pause: every ACTIVE product is paused through setIntentStatus (its matches are invalidated by the re-match) and marked
 * paused_by_store. Resume: exactly the products the store paused are resumed; a product its owner paused stays paused.
 */
export async function setStoreStatus(pool: pg.Pool, reg: Registry, user: SessionUser, storeId: string, action: 'pause' | 'resume'): Promise<{ store: StoreView; changed: number; matching: RematchSummary }> {
  const { store, changed } = await withTx(pool, async (tx) => {
    const s = await ownStore(tx, user.id, storeId, 'FOR UPDATE');
    if (!s) throw notFound();
    const want = action === 'pause' ? 'paused' : 'active';
    if (s.status === want) throw new CatalogError(409, 'invalid_transition', action === 'pause' ? 'المتجر موقوف أصلًا' : 'المتجر نشط أصلًا');
    const changed: Changed[] = [];
    const flagged: Changed[] = [];
    for (const it of await storeItemStates(tx, s.id)) {
      if (action === 'pause' ? it.status !== 'active' : !(it.pausedByStore && it.status === 'paused')) continue;
      const r = await setIntentStatus(tx, reg, it.v, it.id, user.id, action);
      if (!r.ok) continue;
      const c = { v: it.v, id: it.id, version: r.version };
      changed.push(c);
      if (action === 'pause') flagged.push(c);
      await enqueueMatch(tx, c, 'status');
    }
    if (action === 'pause') {
      if (flagged.length) await tx.query(`UPDATE store_items SET paused_by_store = true WHERE (vertical_id, intent_id) IN (SELECT * FROM unnest($1::smallint[], $2::bigint[]))`, [flagged.map((c) => c.v), flagged.map((c) => c.id)]);
    } else await tx.query('UPDATE store_items SET paused_by_store = false WHERE store_id = $1 AND paused_by_store', [s.id]);
    return { store: await updateStoreRow(tx, s, { status: want }), changed };
  });
  const matching = await rematch(pool, reg, changed, 'status');
  return { store: await storeViewOf(pool, reg, store), changed: changed.length, matching };
}

// ───────────── bulk import ─────────────
export interface PreviewResult {
  lines: PreviewLine[];
  summary: { total: number; ok: number; withProblems: number; duplicates: number };
  limits: { maxLines: number; maxProducts: number; remaining: number };
  defaults: ImportDefaults;
}

export async function previewImport(pool: pg.Pool, reg: Registry, user: SessionUser, storeId: string, text: string, defaults: ImportDefaults): Promise<PreviewResult> {
  const s = await ownStore(pool, user.id, storeId);
  if (!s) throw notFound();
  const lines = splitImportText(text);
  if (!lines.length) throw new CatalogError(422, 'empty_import', 'الصق سطرًا واحدًا على الأقل: اسم المنتج وسعره');
  if (lines.length > CATALOG_LIMITS.linesPerImport) throw new CatalogError(422, 'too_many_lines', `الحد ${CATALOG_LIMITS.linesPerImport} سطر في المرة الواحدة (لصقت ${lines.length})`);
  const parsed = lines.map((l) => parseItem(reg, { line: l.text }, { placeId: s.place_id, defaults }, l.lineNo));
  markDuplicates(parsed, await existingNames(pool, s.id));
  const live = await liveItemCount(pool, s.id);
  const view = parsed.map((p) => previewLine(reg, p));
  return {
    lines: view,
    summary: { total: view.length, ok: view.filter((l) => l.ok).length, withProblems: view.filter((l) => !l.ok).length, duplicates: view.filter((l) => l.duplicateOf).length },
    limits: { maxLines: CATALOG_LIMITS.linesPerImport, maxProducts: CATALOG_LIMITS.productsPerStore, remaining: Math.max(0, CATALOG_LIMITS.productsPerStore - live) },
    defaults,
  };
}

export interface ConfirmResult {
  importId: string;
  created: number;
  items: string[];
  replay: boolean;
  storeStatus: 'active' | 'paused';
  products: ProductCard[];
  matching: RematchSummary | null;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

async function replayed(pool: Queryable, reg: Registry, user: SessionUser, storeId: string, importId: string, hash: Buffer): Promise<ConfirmResult | null> {
  const { rows } = await pool.query(
    `SELECT ci.request_hash, ci.result FROM catalog_imports ci JOIN stores s ON s.id = ci.store_id
      WHERE s.public_id = $1 AND s.owner_id = $2 AND ci.import_id = $3`, [storeId, user.id, importId]);
  if (!rows[0]) return null;
  if (Buffer.compare(rows[0].request_hash, hash) !== 0) throw new CatalogError(409, 'import_id_reused', 'رقم هذه الإضافة استُخدم لقائمة مختلفة. أعد المعاينة ثم التأكيد.');
  const r = rows[0].result as { created: number; items: string[]; storeStatus: 'active' | 'paused' };
  const products: ProductCard[] = [];
  for (const id of r.items.slice(0, 50)) { const c = await itemCard(pool, reg, user.id, storeId, id); if (c) products.push(c); }
  return { importId, created: r.created, items: r.items, replay: true, storeStatus: r.storeStatus, products, matching: null };
}

/**
 * Save a previewed list in ONE transaction. Idempotent by importId: a retried confirm (same importId, same request)
 * returns the first result and creates nothing; the same importId with a different list is 409.
 * Every line is parsed and validated again here; any line with a problem refuses the whole import (422 + per-line
 * problems) — nothing is half-saved.
 */
export async function confirmImport(pool: pg.Pool, reg: Registry, user: SessionUser, storeId: string, body: { importId: string; defaults: ImportDefaults; items: ItemInput[] }): Promise<ConfirmResult> {
  const hash = createHash('sha256').update(stable({ d: body.defaults, i: body.items })).digest();
  const prior = await replayed(pool, reg, user, storeId, body.importId, hash);
  if (prior) return prior;
  const s0 = await ownStore(pool, user.id, storeId);
  if (!s0) throw notFound();
  if (!body.items.length) throw new CatalogError(422, 'empty_import', 'لا توجد منتجات محددة للحفظ');
  if (body.items.length > CATALOG_LIMITS.linesPerImport) throw new CatalogError(422, 'too_many_lines', `الحد ${CATALOG_LIMITS.linesPerImport} منتج في المرة الواحدة`);
  const parse = (names: Map<string, { id: string; nameAr: string }>): ParsedItem[] => {
    const parsed = body.items.map((it, k) => parseItem(reg, it, { placeId: s0.place_id, defaults: body.defaults }, k + 1));
    markDuplicates(parsed, names);
    return parsed;
  };
  const refuse = (parsed: ParsedItem[]) => {
    const bad = parsed.filter((p) => p.problems.length || !p.spec);
    if (bad.length) throw new CatalogError(422, 'import_invalid', `في ${bad.length} سطر مشكلة تحتاج تصحيحًا قبل الحفظ`, { lines: bad.map((p) => previewLine(reg, p)) });
  };
  refuse(parse(await existingNames(pool, s0.id)));

  const out = await withTx(pool, async (tx) => {
    const s = await ownStore(tx, user.id, storeId, 'FOR UPDATE');
    if (!s) throw notFound();
    if (s.place_id !== s0.place_id) throw new CatalogError(409, 'store_changed', 'تغيّر مكان المتجر أثناء الحفظ. أعد المعاينة.');
    const ins = await tx.query(
      `INSERT INTO catalog_imports (store_id, import_id, request_hash, line_count, created) VALUES ($1,$2,$3,$4,0)
       ON CONFLICT (store_id, import_id) DO NOTHING RETURNING import_id`, [s.id, body.importId, hash, body.items.length]);
    if (!ins.rows[0]) return null; // a concurrent confirm with this importId committed first → replay below
    const parsed = parse(await existingNames(tx, s.id)); // again under the store lock: a concurrent import may have added names
    refuse(parsed);
    const live = await liveItemCount(tx, s.id);
    if (live + parsed.length > CATALOG_LIMITS.productsPerStore) {
      throw new CatalogError(422, 'product_limit', `الحد ${CATALOG_LIMITS.productsPerStore} منتج للمتجر (فيه الآن ${live}، والقائمة ${parsed.length})`);
    }
    const paused = s.status === 'paused';
    const created: (Changed & { publicId: string; position: number; nameAr: string; nameNorm: string })[] = [];
    let pos = s.next_position;
    for (const p of parsed) {
      const c = await createIntent(tx, reg, { userId: user.id, realm: s.realm, spec: p.spec as IntentSpec, titleAr: productTitle(p.nameAr, s.realm), sourceText: p.text, conversationId: null });
      let version = c.version;
      if (paused) { const r = await setIntentStatus(tx, reg, c.verticalId, c.id, user.id, 'pause'); if (r.ok) version = r.version; }
      created.push({ v: c.verticalId, id: c.id, version, publicId: c.publicId, position: pos++, nameAr: p.nameAr, nameNorm: p.nameNorm });
    }
    await insertLinks(tx, s.id, created.map((c) => ({ v: c.v, id: c.id, position: c.position, nameAr: c.nameAr, nameNorm: c.nameNorm, pausedByStore: paused })), body.importId);
    await tx.query('UPDATE stores SET next_position = $2, updated_at = now() WHERE id = $1', [s.id, pos]);
    for (const c of created) await enqueueMatch(tx, c, 'interactive');
    const result = { created: created.length, items: created.map((c) => c.publicId), storeStatus: s.status };
    await tx.query('UPDATE catalog_imports SET created = $3, result = $4 WHERE store_id = $1 AND import_id = $2', [s.id, body.importId, created.length, JSON.stringify(result)]);
    return { result, created };
  });
  if (!out) {
    const again = await replayed(pool, reg, user, storeId, body.importId, hash);
    if (again) return again;
    throw new CatalogError(409, 'busy', 'في حفظ آخر قيد التنفيذ، حاول مرة ثانية');
  }
  // 'interactive': the owner is looking at this result now, so only the seekers are notified (not 200 owner toasts)
  const matching = out.result.storeStatus === 'active' ? await rematch(pool, reg, out.created, 'interactive') : null;
  const products: ProductCard[] = [];
  for (const id of out.result.items.slice(0, 50)) { const c = await itemCard(pool, reg, user.id, storeId, id); if (c) products.push(c); }
  return { importId: body.importId, ...out.result, replay: false, products, matching };
}

// ───────────── one product ─────────────
export interface ItemEdit { expectedVersion: number; nameAr?: string; amount?: string; currency?: Currency; unit?: PriceUnit; negotiable?: boolean; condition?: 'new' | 'used' | null }

/** Edit name / price / condition: a new intent version (updateIntent) → re-match → stale matches invalidated. */
export async function editItem(pool: pg.Pool, reg: Registry, user: SessionUser, storeId: string, itemId: string, e: ItemEdit): Promise<{ item: ProductCard; matching: RematchSummary }> {
  const changed = await withTx(pool, async (tx) => {
    const it = await ownItem(tx, user.id, storeId, itemId, 'FOR UPDATE OF si');
    if (!it) throw notFound();
    if (it.row.status === 'closed') throw notFound();
    const spec = intentToSpec(reg, it.row);
    if (e.amount !== undefined || e.currency !== undefined || e.unit !== undefined || e.negotiable !== undefined) {
      const cur = spec.price;
      const minor = e.amount !== undefined ? amountToMinor(e.amount) : cur?.lo ?? cur?.hi ?? null;
      if (minor === null) throw new CatalogError(422, 'bad_amount', 'السعر المكتوب غير صالح (أرقام فقط، وحتى منزلتين بعد الفاصلة)');
      const unit = spec.deal === 'sale' ? 'total' : e.unit ?? cur?.unit ?? null;
      if (spec.deal === 'rent' && (!unit || unit === 'total')) throw new CatalogError(422, 'missing_unit', 'الإيجار بالشهر أم باليوم أم بالسنة؟');
      spec.price = { op: 'eq', lo: minor, hi: minor, currency: e.currency ?? cur?.currency ?? null, unit, strength: 'required', negotiable: e.negotiable ?? cur?.negotiable ?? false };
      if (!spec.price.currency) throw new CatalogError(422, 'missing_currency', 'اختر العملة');
    }
    if (e.condition !== undefined) {
      if (e.condition === null) delete spec.attrs.condition;
      else spec.attrs.condition = e.condition;
    }
    const v = validateSpec(reg, spec);
    if (!v.ok) throw new CatalogError(422, 'invalid_spec', `تعديل غير صالح: ${v.issues.map((i) => i.code).join('، ')}`);
    let name = it.link.name_ar;
    if (e.nameAr !== undefined) {
      name = e.nameAr.replace(/\s+/g, ' ').trim();
      const norm = normName(name);
      if (!name || !norm) throw new CatalogError(422, 'bad_name', 'اكتب اسم المنتج');
      const dup = (await existingNames(tx, it.link.store_id)).get(norm);
      if (dup && dup.id !== itemId) throw new CatalogError(409, 'duplicate', `منتج بنفس الاسم موجود: «${dup.nameAr}»`);
      await tx.query('UPDATE store_items SET name_ar = $3, name_norm = $4 WHERE vertical_id = $1 AND intent_id = $2', [it.link.vertical_id, it.link.intent_id, name, norm]);
    }
    const r = await updateIntent(tx, reg, it.link.vertical_id, it.link.intent_id, user.id, e.expectedVersion, v.spec, productTitle(name, it.row.realm));
    if (!r.ok) throw r.reason === 'version_conflict' ? new CatalogError(409, 'version_conflict', 'تغيّر المنتج من مكان آخر. حدّث الصفحة.') : notFound();
    const c = { v: it.link.vertical_id, id: it.link.intent_id, version: r.version };
    await enqueueMatch(tx, c, 'edit');
    return c;
  });
  const matching = await rematch(pool, reg, [changed], 'edit');
  return { item: (await itemCard(pool, reg, user.id, storeId, itemId))!, matching };
}

/** pause / resume / delete one product. Delete = close the intent (matches invalidated) and unlink it (photos go too). */
export async function setItemStatus(pool: pg.Pool, reg: Registry, user: SessionUser, storeId: string, itemId: string, action: 'pause' | 'resume' | 'delete'): Promise<{ item: ProductCard | null; matching: RematchSummary }> {
  const changed = await withTx(pool, async (tx) => {
    const s = await ownStore(tx, user.id, storeId);
    const it = await ownItem(tx, user.id, storeId, itemId, 'FOR UPDATE OF si');
    if (!s || !it) throw notFound();
    if (action === 'resume' && s.status === 'paused') throw new CatalogError(409, 'store_paused', 'المتجر موقوف. استأنف المتجر أولًا.');
    const { vertical_id: v, intent_id: id } = it.link;
    if (action === 'delete') {
      const r = it.row.status === 'active' || it.row.status === 'paused' ? await setIntentStatus(tx, reg, v, id, user.id, 'close') : null;
      await tx.query('DELETE FROM store_items WHERE vertical_id = $1 AND intent_id = $2', [v, id]);
      if (r?.ok) { const c = { v, id, version: r.version }; await enqueueMatch(tx, c, 'status'); return c; }
      return null;
    }
    const r = await setIntentStatus(tx, reg, v, id, user.id, action);
    if (!r.ok) throw new CatalogError(409, 'invalid_transition', 'لا يمكن تنفيذ هذا الإجراء على حالة المنتج الحالية');
    await tx.query('UPDATE store_items SET paused_by_store = false WHERE vertical_id = $1 AND intent_id = $2', [v, id]);
    const c = { v, id, version: r.version };
    await enqueueMatch(tx, c, 'status');
    return c;
  });
  const matching = changed ? await rematch(pool, reg, [changed], 'status') : { evaluated: 0, queued: 0, newMatches: 0, invalidated: 0, confirmed: 0, possible: 0 };
  return { item: action === 'delete' ? null : await itemCard(pool, reg, user.id, storeId, itemId), matching };
}

// ───────────── photos ─────────────
export interface UploadResult { photo: { id: string; url: string; slot: number; width: number; height: number; mime: string; bytes: number }; deduplicated: boolean; alreadyAttached: boolean; metadataRemoved: string[] }

export async function uploadPhoto(pool: pg.Pool, media: MediaStore, user: SessionUser, storeId: string, itemId: string, body: Buffer): Promise<UploadResult> {
  const pre = await ownItem(pool, user.id, storeId, itemId);
  if (!pre || pre.row.status === 'closed') throw notFound();
  if (!Buffer.isBuffer(body) || !body.length) throw new CatalogError(400, 'empty_upload', 'لم يصل أي ملف');
  if (body.length > CATALOG_LIMITS.photoBytes) throw new CatalogError(413, 'too_large', 'الصورة أكبر من ٥ ميغابايت');
  if (!sniffImage(body)) throw new CatalogError(415, 'unsupported_type', 'الملف ليس صورة JPEG أو PNG أو WebP');
  let clean;
  try { clean = cleanImage(body); } catch (e) {
    if (e instanceof MediaError && e.code === 'too_many_pixels') throw new CatalogError(422, 'too_many_pixels', 'أبعاد الصورة كبيرة جدًا (الحد ٥٠ ميغابكسل)');
    if (e instanceof MediaError) throw new CatalogError(422, 'bad_image', 'الصورة تالفة أو غير مكتملة');
    throw e;
  }
  const hex = sha256Hex(clean.bytes);
  const sha = Buffer.from(hex, 'hex');
  // cheap early refusal before touching the disk (re-checked under the lock below)
  const n = await pool.query('SELECT count(*)::int AS n, bool_or(sha256 = $3) AS same FROM store_item_photos WHERE vertical_id = $1 AND intent_id = $2', [pre.link.vertical_id, pre.link.intent_id, sha]);
  if (n.rows[0].n >= CATALOG_LIMITS.photosPerProduct && !n.rows[0].same) throw new CatalogError(409, 'photo_limit', `الحد ${CATALOG_LIMITS.photosPerProduct} صور للمنتج`);
  // blob row first (so garbage collection can always find it), then the file, then the photo row
  const { existed } = await upsertBlob(pool, { sha256: sha, mime: clean.mime, bytes: clean.bytes.length, width: clean.width, height: clean.height });
  await media.ensure(hex, clean.bytes);
  const r = await withTx(pool, async (tx) => {
    const it = await ownItem(tx, user.id, storeId, itemId, 'FOR UPDATE OF si');
    if (!it || it.row.status === 'closed') throw notFound();
    return attachPhoto(tx, it.link, sha);
  });
  if (r === 'full') throw new CatalogError(409, 'photo_limit', `الحد ${CATALOG_LIMITS.photosPerProduct} صور للمنتج`);
  return {
    photo: { id: r.photo.public_id, url: photoUrl(r.photo.public_id), slot: r.photo.slot, width: clean.width, height: clean.height, mime: clean.mime, bytes: clean.bytes.length },
    deduplicated: existed, alreadyAttached: r.duplicate, metadataRemoved: clean.removed,
  };
}

export async function removePhoto(pool: pg.Pool, user: SessionUser, storeId: string, itemId: string, photoId: string): Promise<void> {
  const it = await ownItem(pool, user.id, storeId, itemId);
  if (!it || !(await deletePhoto(pool, it.link, photoId))) throw notFound();
}

/** Delete blobs that no photo references and nobody used for `olderThanMs` (default 1 h), then their files. */
export async function gcMedia(pool: pg.Pool, media: MediaStore, olderThanMs = 3_600_000): Promise<number> {
  const hexes = await collectUnreferencedBlobs(pool, olderThanMs);
  for (const h of hexes) await media.remove(h);
  return hexes.length;
}

export type { StoreInput, StoreView, ProductCard, PreviewLine, ItemInput, ImportDefaults };
export { IMPORT_LIMITS };
