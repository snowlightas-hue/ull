// Store info on MatchCards (V2.3, docs/CATALOG.md §5) — applied by the integrator to every MatchCard list the API
// returns (GET /api/matches, GET /api/matches/:id, POST /api/intents/:id/match), next to decorateMatchCards:
//
//   await attachStoreInfo(pool, reg, u(req).id, page.items);
//
// For a counterpart offer that is a store product it adds
//   card.store = { id, nameAr, labelAr, synthetic, placeAr, requestMatches, groupLabelAr }
//     requestMatches = live (confirmed + possible) matches between THIS card's request (card.mine) and that store's
//                      products — exact, not limited to the page — so the list can show «٣ منتجات من متجر أبو أحمد (تجريبي)»
//   card.other.photos = [{ id, url, … }]   only while the match is live, the product active and the store active —
//                                          the same rule GET /api/photos/:id enforces, so no URL on a card ever 404s.
// For the viewer's OWN product (a shop owner looking at a seeker) it adds card.mineStore = { id, nameAr, labelAr }.
// Nothing about the owner is revealed beyond the store's public profile (name, city); identity stays consent-based.
import type { Queryable } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import { photosFor, q, storeLabel, type PhotoRef } from './repo.ts';

export interface StoreBadge {
  id: string; nameAr: string; labelAr: string; synthetic: boolean; placeAr: string | null;
  requestMatches: number; groupLabelAr: string;
}

interface CardLike {
  state?: string;
  mine?: { id?: string } | null;
  other?: { id?: string; status?: string; photos?: PhotoRef[] } | null;
  store?: StoreBadge | null;
  mineStore?: { id: string; nameAr: string; labelAr: string } | null;
}

const UUID = /^[0-9a-f-]{36}$/i;

/** «منتج واحد / منتجان / ٣ منتجات / ١١ منتجًا» (Latin digits; the client localises digits). */
export function productsCountAr(n: number): string {
  if (n === 1) return 'منتج واحد';
  if (n === 2) return 'منتجان';
  const mod100 = n % 100;
  return mod100 >= 3 && mod100 <= 10 ? `${n} منتجات` : `${n} منتجًا`;
}

export function groupLabelAr(n: number, storeName: string, synthetic: boolean): string {
  const name = /^(?:متجر|محل|محلات|معرض|مكتبة|صيدلية|سوبر ?ماركت|بقالية|دكان)\s/.test(storeName) ? storeName : `متجر ${storeName}`;
  return `${productsCountAr(n)} من ${storeLabel(name, synthetic)}`;
}

export async function attachStoreInfo<T extends CardLike>(db: Queryable, reg: Registry, viewerId: string, cards: T[]): Promise<T[]> {
  const ids = new Set<string>();
  for (const c of cards) {
    if (c?.other?.id && UUID.test(c.other.id)) ids.add(c.other.id);
    if (c?.mine?.id && UUID.test(c.mine.id)) ids.add(c.mine.id);
  }
  if (!ids.size) return cards;
  const { rows } = await q(db, 'badge_items',
    `SELECT r.public_id, r.vertical_id, r.intent_id, r.user_id, s.id AS store_id, s.public_id AS store_public_id, s.name_ar, s.realm, s.status AS store_status, s.place_id
       FROM intent_refs r
       JOIN store_items si ON si.vertical_id = r.vertical_id AND si.intent_id = r.intent_id
       JOIN stores s ON s.id = si.store_id
      WHERE r.public_id = ANY($1::uuid[])`,
    [[...ids]],
  );
  if (!rows.length) return cards;
  const byIntent = new Map(rows.map((r) => [String(r.public_id), r]));

  // the viewer's requests (card.mine) → internal ids, for the per-request store counts
  const mineIds = [...new Set(cards.map((c) => c?.mine?.id).filter((x): x is string => !!x && UUID.test(x) && !byIntent.has(x)))];
  const mineRefs = mineIds.length
    ? (await q(db, 'badge_mine', 'SELECT public_id, vertical_id, intent_id FROM intent_refs WHERE public_id = ANY($1::uuid[]) AND user_id = $2', [mineIds, viewerId])).rows
    : [];
  const mineBy = new Map(mineRefs.map((r) => [String(r.public_id), r]));
  const storeIds = [...new Set(rows.filter((r) => String(r.user_id) !== String(viewerId)).map((r) => String(r.store_id)))];
  const counts = new Map<string, number>(); // `${mineIntentId}:${storeId}` → n
  if (mineRefs.length && storeIds.length) {
    const { rows: cr } = await q(db, 'badge_counts',
      `SELECT x.id::text AS mine, si.store_id::text AS store, count(*)::int AS n
         FROM unnest($1::smallint[], $2::bigint[]) AS x(v, id)
         JOIN matches m ON m.vertical_id = x.v AND m.a_intent_id = x.id AND m.state IN ('confirmed','possible')
         JOIN store_items si ON si.vertical_id = m.vertical_id AND si.intent_id = m.b_intent_id
        WHERE si.store_id = ANY($3::bigint[])
        GROUP BY x.id, si.store_id`,
      [mineRefs.map((r) => r.vertical_id), mineRefs.map((r) => r.intent_id), storeIds],
    );
    for (const r of cr) counts.set(`${r.mine}:${r.store}`, r.n);
  }

  // photos of counterpart products on live matches (same visibility rule as GET /api/photos/:id)
  const photoKeys = cards
    .map((c) => (c?.other?.id ? byIntent.get(c.other.id) : undefined))
    .filter((r, k) => r && String(r.user_id) !== String(viewerId) && r.store_status === 'active' && isLive(cards[k]!))
    .map((r) => ({ v: r!.vertical_id as number, id: String(r!.intent_id) }));
  const photos = await photosFor(db, photoKeys);

  for (const c of cards) {
    const o = c?.other?.id ? byIntent.get(c.other.id) : undefined;
    if (o && String(o.user_id) !== String(viewerId)) {
      const synthetic = o.realm === 'synthetic';
      const mineRef = c.mine?.id ? mineBy.get(c.mine.id) : undefined;
      const n = mineRef ? counts.get(`${mineRef.intent_id}:${o.store_id}`) ?? 0 : 0;
      c.store = {
        id: o.store_public_id, nameAr: o.name_ar, labelAr: storeLabel(o.name_ar, synthetic), synthetic,
        placeAr: reg.placeById.get(o.place_id)?.nameAr ?? null, requestMatches: n, groupLabelAr: groupLabelAr(Math.max(n, 1), o.name_ar, synthetic),
      };
      if (c.other && o.store_status === 'active' && isLive(c)) c.other.photos = photos.get(`${o.vertical_id}:${o.intent_id}`) ?? [];
    }
    const m = c?.mine?.id ? byIntent.get(c.mine.id) : undefined;
    if (m && String(m.user_id) === String(viewerId)) c.mineStore = { id: m.store_public_id, nameAr: m.name_ar, labelAr: storeLabel(m.name_ar, m.realm === 'synthetic') };
  }
  return cards;
}

function isLive(c: CardLike): boolean {
  return (c.state === 'confirmed' || c.state === 'possible') && (c.other?.status === undefined || c.other.status === 'active');
}
