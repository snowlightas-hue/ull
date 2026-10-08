// Feature routes: stores, catalog bulk import and product photos (V2.3; docs/CATALOG.md, contracts in docs/CONTRACTS.md
// «Stores & catalog»). A defineRoutes plugin, so CSRF / auth / rate limits / logging policy / error format are inherited.
// Owner-only: another user's store, product or photo answers 404 (401 when logged out). Photos are the one exception
// to "owner-only reads": GET /api/photos/:id follows the visibility rule in src/catalog/repo.ts#photoForViewer.
//
//   GET    /api/stores                                   → {items: Store[], limits}
//   POST   /api/stores                                   {nameAr, descriptionAr?, placeId, contactPref?, hoursAr?} → {store}
//   GET    /api/stores/:id                               → {store}
//   PATCH  /api/stores/:id                               {expectedVersion, …fields} → {store, matching}
//   POST   /api/stores/:id/status                        {action:'pause'|'resume'} → {store, changed, matching}
//   GET    /api/stores/:id/items?status=&cursor=&dir=&limit= → Page<Product>
//   GET    /api/stores/:id/items/:itemId                 → {item}
//   PATCH  /api/stores/:id/items/:itemId                 {expectedVersion, nameAr?, amount?, currency?, unit?, negotiable?, condition?} → {item, matching}
//   POST   /api/stores/:id/items/:itemId/status          {action:'pause'|'resume'|'delete'} → {item|null, matching}
//   POST   /api/stores/:id/import/preview                {text, defaultCurrency?, defaultDeal?} → {lines, summary, limits, defaults}
//   POST   /api/stores/:id/import/confirm                {importId, defaultCurrency?, defaultDeal?, items} → {created, items, replay, products, matching}
//   POST   /api/stores/:id/items/:itemId/photos          raw image body (image/jpeg|png|webp or application/octet-stream) → {photo, …}
//   DELETE /api/stores/:id/items/:itemId/photos/:photoId → {ok}   (POST …/:photoId/delete does the same)
//   GET    /api/photos/:photoId                          → the image (Content-Type from the sniffed type, nosniff)
//
// Uploads: the per-route bodyLimit is the photo limit (5 MB → 413); the TYPE is decided by magic bytes in the handler
// (415 for anything that is not JPEG/PNG/WebP, whatever the Content-Type said). Bodies are never logged.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { defineRoutes, type UlRoutePlugin } from '../context.ts';
import { decodeCursor } from '../../repo/paging.ts';
import { MediaStore, defaultMediaDir } from '../../catalog/media-store.ts';
import { CATALOG_LIMITS, ITEM_STATUSES, listItems, ownStore, photoForViewer, itemCard } from '../../catalog/repo.ts';
import {
  CatalogError, confirmImport, createStore, editItem, getStore, myStores, previewImport, removePhoto, setItemStatus, setStoreStatus, updateStore, uploadPhoto,
} from '../../catalog/service.ts';

const CURRENCY = z.enum(['USD', 'TRY', 'SYP', 'EUR']);
const UNIT = z.enum(['total', 'month', 'year', 'week', 'day', 'hour', 'session', 'person']);
const DEAL = z.enum(['sale', 'rent']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optText = (max: number) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable().optional());

const StoreFields = {
  nameAr: z.string().trim().min(2).max(80),
  descriptionAr: optText(500),
  placeId: z.number().int().positive().max(2_000_000_000),
  contactPref: z.enum(['chat', 'chat_then_phone']).optional(),
  hoursAr: optText(120),
};
const CreateStore = z.object(StoreFields);
const PatchStore = z.object({ expectedVersion: z.number().int().positive().max(2_147_483_647), ...StoreFields, nameAr: StoreFields.nameAr.optional(), placeId: StoreFields.placeId.optional() });

const Defaults = { defaultCurrency: CURRENCY.nullable().optional(), defaultDeal: DEAL.nullable().optional() };
const Preview = z.object({ text: z.string().max(60_000), ...Defaults });
const Item = z.object({
  line: z.string().max(400),
  nameAr: z.string().max(120).optional(),
  categoryCode: z.string().max(80).optional(),
  deal: DEAL.optional(),
  amount: z.string().max(24).optional(),
  currency: CURRENCY.optional(),
  unit: UNIT.optional(),
  condition: z.enum(['new', 'used']).nullable().optional(),
  negotiable: z.boolean().optional(),
});
const Confirm = z.object({ importId: z.string().regex(UUID_RE), items: z.array(Item).min(1).max(CATALOG_LIMITS.linesPerImport), ...Defaults });
const EditItem = z.object({
  expectedVersion: z.number().int().positive().max(2_147_483_647),
  nameAr: z.string().trim().min(1).max(80).optional(),
  amount: z.string().max(24).optional(),
  currency: CURRENCY.optional(),
  unit: UNIT.optional(),
  negotiable: z.boolean().optional(),
  condition: z.enum(['new', 'used']).nullable().optional(),
});

const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);
const ItemsQuery = z.object({
  status: z.preprocess(emptyToUndef, z.string().max(60).optional().transform((s, c) => {
    if (s === undefined || s === 'all') return [...ITEM_STATUSES];
    const parts = [...new Set(s.split(','))];
    if (!parts.every((p) => (ITEM_STATUSES as readonly string[]).includes(p))) { c.addIssue({ code: 'custom', message: 'bad_status' }); return z.NEVER; }
    return parts;
  })),
  cursor: z.preprocess(emptyToUndef, z.string().max(300).optional().refine((v) => v === undefined || (/^[A-Za-z0-9_-]+$/.test(v) && /^\d{1,9}$/.test(decodeCursor(v)?.k ?? '')), { message: 'bad_cursor' })),
  dir: z.preprocess(emptyToUndef, z.enum(['next', 'prev']).optional()),
  limit: z.preprocess(emptyToUndef, z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional()),
});

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'];
const JSON_LIMIT = 256 * 1024; // 200 lines × 200 characters of Arabic text fit comfortably

type P<T extends string> = FastifyRequest<{ Params: Record<T, string> }>;

/** The catalog routes; `mediaDir` defaults to UL_MEDIA_DIR or var/media (tests pass a temporary directory). */
export function catalogRoutes(opts: { mediaDir?: string } = {}): UlRoutePlugin {
  return defineRoutes('catalog', async (app, ctx) => {
    const media = new MediaStore(opts.mediaDir ?? defaultMediaDir());

    // raw image bodies for the upload route (scoped to this plugin; JSON stays the default everywhere else)
    app.addContentTypeParser(PHOTO_TYPES, { parseAs: 'buffer', bodyLimit: CATALOG_LIMITS.photoBytes }, (_req, body, done) => done(null, body));
    // CatalogError → {error, messageAr, …}; an oversized photo gets its own message; everything else → the app's handler
    app.setErrorHandler((err: any, req, reply) => {
      if (err instanceof CatalogError) return reply.code(err.status).send({ error: err.code, messageAr: err.message, ...(err.extra ?? {}) });
      if (err?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        const photo = /\/photos$/.test(req.routeOptions.url ?? '');
        return reply.code(413).send({ error: 'too_large', messageAr: photo ? 'الصورة أكبر من ٥ ميغابايت' : 'القائمة كبيرة جدًا — قسّمها على دفعات' });
      }
      throw err;
    });

    const me = (req: FastifyRequest) => ctx.user(req);
    const sid = (req: P<'id'>) => ctx.uuidParam(req.params.id);

    app.get('/api/stores', async (req) => ({ items: await myStores(ctx.pool, ctx.reg, me(req)), limits: { stores: CATALOG_LIMITS.storesPerUser, ...limitsView() } }));

    app.post('/api/stores', { config: { rateLimit: { name: 'catalog_store_write', perMinute: 20 } } }, async (req) => {
      const b = ctx.body(CreateStore, req);
      return { store: await createStore(ctx.pool, ctx.reg, me(req), { nameAr: b.nameAr, descriptionAr: b.descriptionAr ?? null, placeId: b.placeId, contactPref: b.contactPref, hoursAr: b.hoursAr ?? null }) };
    });

    app.get<{ Params: { id: string } }>('/api/stores/:id', async (req) => ({ store: await getStore(ctx.pool, ctx.reg, me(req), sid(req)) }));

    app.patch<{ Params: { id: string } }>('/api/stores/:id', { config: { rateLimit: { name: 'catalog_store_write', perMinute: 20 } } }, async (req) => {
      const b = ctx.body(PatchStore, req);
      const { expectedVersion, ...ch } = b;
      return updateStore(ctx.pool, ctx.reg, me(req), sid(req), expectedVersion, ch);
    });

    app.post<{ Params: { id: string } }>('/api/stores/:id/status', { config: { rateLimit: { name: 'catalog_store_write', perMinute: 20 } } }, async (req) => {
      const { action } = ctx.body(z.object({ action: z.enum(['pause', 'resume']) }), req);
      return setStoreStatus(ctx.pool, ctx.reg, me(req), sid(req), action);
    });

    app.get<{ Params: { id: string } }>('/api/stores/:id/items', async (req) => {
      const q = ctx.parseQuery(ItemsQuery, req.query);
      const s = await ownStore(ctx.pool, me(req).id, sid(req));
      if (!s) throw new CatalogError(404, 'not_found', 'غير موجود');
      return listItems(ctx.pool, ctx.reg, s.id, { statuses: q.status ?? [...ITEM_STATUSES], cursor: q.cursor, dir: q.dir === 'prev' ? 'prev' : 'next', limit: q.limit ?? 20 });
    });

    app.get<{ Params: { id: string; itemId: string } }>('/api/stores/:id/items/:itemId', async (req) => {
      const item = await itemCard(ctx.pool, ctx.reg, me(req).id, sid(req), ctx.uuidParam(req.params.itemId));
      if (!item) throw new CatalogError(404, 'not_found', 'غير موجود');
      return { item };
    });

    app.patch<{ Params: { id: string; itemId: string } }>('/api/stores/:id/items/:itemId', { config: { rateLimit: { name: 'catalog_item_write', perMinute: 120 } } }, async (req) => {
      const b = ctx.body(EditItem, req);
      return editItem(ctx.pool, ctx.reg, me(req), sid(req), ctx.uuidParam(req.params.itemId), b);
    });

    app.post<{ Params: { id: string; itemId: string } }>('/api/stores/:id/items/:itemId/status', { config: { rateLimit: { name: 'catalog_item_write', perMinute: 120 } } }, async (req) => {
      const { action } = ctx.body(z.object({ action: z.enum(['pause', 'resume', 'delete']) }), req);
      return setItemStatus(ctx.pool, ctx.reg, me(req), sid(req), ctx.uuidParam(req.params.itemId), action);
    });

    app.post<{ Params: { id: string } }>('/api/stores/:id/import/preview', { bodyLimit: JSON_LIMIT, config: { rateLimit: { name: 'catalog_import_preview', perMinute: 30 } } }, async (req) => {
      const b = ctx.body(Preview, req);
      return previewImport(ctx.pool, ctx.reg, me(req), sid(req), b.text, { currency: b.defaultCurrency ?? null, deal: b.defaultDeal ?? null });
    });

    app.post<{ Params: { id: string } }>('/api/stores/:id/import/confirm', { bodyLimit: JSON_LIMIT, config: { rateLimit: { name: 'catalog_import_confirm', perMinute: 10 } } }, async (req) => {
      const b = ctx.body(Confirm, req);
      return confirmImport(ctx.pool, ctx.reg, me(req), sid(req), { importId: b.importId.toLowerCase(), defaults: { currency: b.defaultCurrency ?? null, deal: b.defaultDeal ?? null }, items: b.items });
    });

    app.post<{ Params: { id: string; itemId: string } }>('/api/stores/:id/items/:itemId/photos', {
      bodyLimit: CATALOG_LIMITS.photoBytes,
      config: { contentTypes: PHOTO_TYPES, rateLimit: { name: 'catalog_photo_upload', perMinute: 30 } },
    }, async (req, reply) => {
      const r = await uploadPhoto(ctx.pool, media, me(req), sid(req), ctx.uuidParam(req.params.itemId), req.body as Buffer);
      return reply.code(r.alreadyAttached ? 200 : 201).send(r);
    });

    const del = async (req: P<'id' | 'itemId' | 'photoId'>) => {
      await removePhoto(ctx.pool, me(req), sid(req), ctx.uuidParam(req.params.itemId), ctx.uuidParam(req.params.photoId));
      return { ok: true };
    };
    app.delete<{ Params: { id: string; itemId: string; photoId: string } }>('/api/stores/:id/items/:itemId/photos/:photoId', async (req) => del(req));
    app.post<{ Params: { id: string; itemId: string; photoId: string } }>('/api/stores/:id/items/:itemId/photos/:photoId/delete', async (req) => del(req));

    app.get<{ Params: { photoId: string } }>('/api/photos/:photoId', { config: { rateLimit: { name: 'catalog_photo_view', perMinute: 600 } } }, async (req, reply: FastifyReply) => {
      const access = await photoForViewer(ctx.pool, me(req).id, ctx.uuidParam(req.params.photoId));
      const file = access ? await media.open(access.sha256.toString('hex')) : null;
      if (!access || !file) throw new CatalogError(404, 'not_found', 'غير موجود');
      return reply
        .header('Content-Type', access.mime)
        .header('Content-Length', String(file.size))
        .header('Content-Disposition', 'inline')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .send(file.stream);
    });
  });
}

function limitsView() {
  return { productsPerStore: CATALOG_LIMITS.productsPerStore, linesPerImport: CATALOG_LIMITS.linesPerImport, photosPerProduct: CATALOG_LIMITS.photosPerProduct, photoBytes: CATALOG_LIMITS.photoBytes };
}

export default catalogRoutes();
