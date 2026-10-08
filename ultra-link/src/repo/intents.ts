// Intent persistence: create/update/status with versioning, scope keys, owner-scoped reads, cards.

import type { Queryable } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import { attributesFor } from '../domain/registry.ts';
import { priceText } from '../domain/format.ts';
import type { AttrConstraint, AttrFact, AttrValue, DealCode, GeoPoint, IntentSpec, PriceSpec, Side, Strength } from '../domain/types.ts';
import type { LivePoint, MatchableIntent } from '../matching/evaluate.ts';
import { boundAr, liveState } from '../geo/semantics.ts';
import { decodeCursor, encodeCursor, type Page } from './paging.ts';

export interface IntentRow {
  id: string; vertical_id: number; public_id: string; user_id: string; realm: 'real' | 'synthetic'; side: Side;
  category_id: number; deal_type_id: number; status: string; version: number; title_ar: string; source_text: string | null;
  point_place_id: number | null; scope_strength: Strength; scope_place_ids: number[];
  price_op: PriceSpec['op'] | null; price_lo: string | null; price_hi: string | null; currency: string | null; price_unit: string | null;
  price_strength: Strength | null; negotiable: boolean; when_from: string | null; when_to: string | null; when_strength: Strength | null; when_label_ar: string | null;
  attrs: Record<string, AttrFact>; constraints: (AttrConstraint & { _place?: never })[]; expires_at: string | null;
  created_at: string; updated_at: string; created_key: string; exclude_place_ids?: number[];
  // proximity (migration 0003; optional so rows built elsewhere — e.g. the web demo — stay valid)
  geo_lat?: number | null; geo_lng?: number | null; geo_accuracy_m?: number | null; geo_source?: GeoPoint['source'] | null; geo_at?: string | Date | null;
  radius_km?: string | number | null; radius_strength?: Strength | null; nearest?: boolean | null;
  /** latest shared live position (live_positions), as JSON */
  live?: { lat: number; lng: number; accuracyM: number | null; at: string } | null;
}

export const INTENT_COLS = `i.id, i.vertical_id, i.public_id, i.user_id, i.realm, i.side, i.category_id, i.deal_type_id, i.status, i.version,
  i.title_ar, i.source_text, i.point_place_id, i.scope_strength, i.scope_place_ids, i.price_op, i.price_lo, i.price_hi, i.currency,
  i.price_unit, i.price_strength, i.negotiable, lower(i.when_range) AS when_from, upper(i.when_range) AS when_to, i.when_strength,
  i.when_label_ar, i.attrs, i.constraints, i.expires_at, i.created_at, i.updated_at, i.created_at::text AS created_key,
  i.geo_lat, i.geo_lng, i.geo_accuracy_m, i.geo_source, i.geo_at, i.radius_km, i.radius_strength, i.nearest,
  (SELECT json_build_object('lat', lp.lat, 'lng', lp.lng, 'accuracyM', lp.accuracy_m, 'at', lp.updated_at)
     FROM live_positions lp WHERE lp.vertical_id = i.vertical_id AND lp.intent_id = i.id) AS live`;

const EXCLUDE_KEY = '__exclude_places';

export function rowToMatchable(reg: Registry, r: IntentRow): MatchableIntent {
  const cons = (r.constraints ?? []) as (AttrConstraint | { key: string; values?: number[] })[];
  const exclude = (cons.find((c) => c.key === EXCLUDE_KEY) as { values?: number[] } | undefined)?.values ?? [];
  return {
    id: String(r.id),
    userId: String(r.user_id),
    realm: r.realm,
    side: r.side,
    categoryCode: reg.categoryById.get(r.category_id)!.code,
    deal: reg.dealById.get(r.deal_type_id)!.code,
    status: r.status,
    version: r.version,
    pointPlaceId: r.point_place_id,
    scopePlaceIds: r.scope_place_ids ?? [],
    scopeStrength: r.scope_strength,
    excludePlaceIds: exclude as number[],
    price: r.price_op ? {
      op: r.price_op, lo: r.price_lo, hi: r.price_hi, currency: (r.currency?.trim() || null) as PriceSpec['currency'],
      unit: r.price_unit as PriceSpec['unit'], strength: r.price_strength ?? 'required', negotiable: r.negotiable,
    } : null,
    when: r.when_from && r.when_to ? { from: new Date(r.when_from).toISOString(), to: new Date(r.when_to).toISOString(), strength: r.when_strength ?? 'required', label: r.when_label_ar ?? undefined } : null,
    attrs: r.attrs ?? {},
    constraints: cons.filter((c) => c.key !== EXCLUDE_KEY) as AttrConstraint[],
    createdAt: new Date(r.created_at).toISOString(),
    geo: rowGeo(r),
    live: rowLive(r),
    radiusKm: r.radius_km != null && r.radius_strength ? { value: Number(r.radius_km), strength: r.radius_strength } : null,
    nearest: r.nearest === true,
  };
}

function rowGeo(r: IntentRow): GeoPoint | null {
  if (r.geo_lat == null || r.geo_lng == null) return null;
  const g: GeoPoint = { lat: Number(r.geo_lat), lng: Number(r.geo_lng), source: r.geo_source ?? 'gps' };
  if (r.geo_accuracy_m != null) g.accuracyM = Number(r.geo_accuracy_m);
  if (r.geo_at) g.at = new Date(r.geo_at).toISOString();
  return g;
}

function rowLive(r: IntentRow): LivePoint | null {
  const l = r.live;
  if (!l || l.lat == null || l.lng == null || !l.at) return null;
  return { lat: Number(l.lat), lng: Number(l.lng), accuracyM: l.accuracyM == null ? null : Number(l.accuracyM), at: new Date(l.at).toISOString() };
}

export function specToColumns(reg: Registry, spec: IntentSpec) {
  const cat = reg.categoryByCode.get(spec.categoryCode)!;
  const point = spec.place.pointPlaceId != null ? reg.placeById.get(spec.place.pointPlaceId)! : null;
  const constraints: unknown[] = [...spec.constraints];
  if (spec.place.excludePlaceIds?.length) constraints.push({ key: EXCLUDE_KEY, op: 'in', values: spec.place.excludePlaceIds, strength: 'required' });
  return {
    vertical_id: cat.verticalId,
    side: spec.side,
    category_id: cat.id,
    deal_type_id: reg.dealByCode.get(spec.deal)!.id,
    point_place_id: point?.id ?? null,
    point_lft: point?.lft ?? null,
    scope_strength: spec.place.scopeStrength,
    scope_place_ids: spec.place.scopePlaceIds.filter((p) => p !== reg.rootPlaceId),
    price_op: spec.price?.op ?? null,
    price_lo: spec.price?.lo ?? null,
    price_hi: spec.price?.hi ?? null,
    currency: spec.price?.currency ?? null,
    price_unit: spec.price?.unit ?? null,
    price_strength: spec.price?.strength ?? null,
    negotiable: spec.price?.negotiable ?? false,
    when_from: spec.when?.from ?? null,
    when_to: spec.when?.to ?? null,
    when_strength: spec.when?.strength ?? null,
    when_label_ar: spec.when?.label ?? null,
    attrs: spec.attrs,
    constraints,
    // proximity: the precise point stays owner-only (never on a card); radius/nearest are conditions
    geo_lat: spec.place.geo?.lat ?? null,
    geo_lng: spec.place.geo ? spec.place.geo.lng : null,
    geo_accuracy_m: spec.place.geo?.accuracyM != null ? Math.round(spec.place.geo.accuracyM) : null,
    geo_source: spec.place.geo?.source ?? null,
    geo_at: spec.place.geo?.at ?? null,
    radius_km: spec.place.radiusKm ? Math.round(spec.place.radiusKm.value * 100) / 100 : null,
    radius_strength: spec.place.radiusKm?.strength ?? null,
    nearest: spec.place.nearest === true,
  };
}

/** Expiry policy (product decision, see docs/PRODUCT.md): requests 30d, offers 60d, activities end + 1d. */
export function expiryFor(spec: IntentSpec, now = new Date()): Date {
  if (spec.when) return new Date(Date.parse(spec.when.to) + 86_400_000);
  const days = spec.side === 'provide' ? 60 : 30;
  return new Date(now.getTime() + days * 86_400_000);
}

export async function createIntent(
  db: Queryable, reg: Registry,
  args: { userId: string; realm: 'real' | 'synthetic'; spec: IntentSpec; titleAr: string; sourceText: string | null; conversationId: string | null; createdAt?: Date },
): Promise<{ verticalId: number; id: string; publicId: string; version: number }> {
  const c = specToColumns(reg, args.spec);
  const expires = expiryFor(args.spec, args.createdAt);
  const { rows } = await db.query(
    `INSERT INTO intents (vertical_id, user_id, realm, side, category_id, deal_type_id, title_ar, source_text, conversation_id,
       point_place_id, point_lft, scope_strength, scope_place_ids, price_op, price_lo, price_hi, currency, price_unit, price_strength,
       negotiable, when_range, when_strength, when_label_ar, attrs, constraints, expires_at, created_at, updated_at,
       geo_lat, geo_lng, geo_accuracy_m, geo_source, geo_at, radius_km, radius_strength, nearest)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       CASE WHEN $21::timestamptz IS NULL THEN NULL ELSE tstzrange($21::timestamptz, $22::timestamptz, '[)') END,
       $23,$24,$25,$26,$27, coalesce($28::timestamptz, now()), coalesce($28::timestamptz, now()),
       $29,$30,$31,$32,$33,$34,$35,$36)
     RETURNING id, public_id, version`,
    [c.vertical_id, args.userId, args.realm, c.side, c.category_id, c.deal_type_id, args.titleAr, args.sourceText, args.conversationId,
      c.point_place_id, c.point_lft, c.scope_strength, c.scope_place_ids, c.price_op, c.price_lo, c.price_hi, c.currency, c.price_unit,
      c.price_strength, c.negotiable, c.when_from, c.when_to, c.when_strength, c.when_label_ar, JSON.stringify(c.attrs),
      JSON.stringify(c.constraints), expires.toISOString(), args.createdAt?.toISOString() ?? null,
      c.geo_lat, c.geo_lng, c.geo_accuracy_m, c.geo_source, c.geo_at, c.radius_km, c.radius_strength, c.nearest],
  );
  const r = rows[0];
  await db.query('INSERT INTO intent_refs (public_id, vertical_id, intent_id, user_id) VALUES ($1,$2,$3,$4)', [r.public_id, c.vertical_id, r.id, args.userId]);
  await refreshScopes(db, reg, c.vertical_id, String(r.id));
  return { verticalId: c.vertical_id, id: String(r.id), publicId: r.public_id, version: r.version };
}

/**
 * Scope keys = the reverse index. One row per scope place of an ACTIVE intent; an empty or merely
 * preferred scope also gets the root place so that any point's ancestor probe reaches it.
 */
export async function refreshScopes(db: Queryable, reg: Registry, verticalId: number, intentId: string): Promise<void> {
  await db.query('DELETE FROM intent_scopes WHERE vertical_id = $1 AND intent_id = $2', [verticalId, intentId]);
  const { rows } = await db.query('SELECT realm, side, deal_type_id, category_id, status, scope_place_ids, scope_strength FROM intents WHERE vertical_id = $1 AND id = $2', [verticalId, intentId]);
  const r = rows[0];
  if (!r || r.status !== 'active') return;
  const places = new Set<number>(r.scope_place_ids);
  if (!places.size || r.scope_strength === 'preferred') places.add(reg.rootPlaceId);
  for (const p of places) {
    await db.query(
      `INSERT INTO intent_scopes (vertical_id, intent_id, realm, side, deal_type_id, category_id, place_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [verticalId, intentId, r.realm, r.side, r.deal_type_id, r.category_id, p],
    );
  }
}

export async function resolveIntentRef(db: Queryable, publicId: string): Promise<{ verticalId: number; id: string; userId: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(publicId)) return null;
  const { rows } = await db.query('SELECT vertical_id, intent_id, user_id FROM intent_refs WHERE public_id = $1', [publicId]);
  return rows[0] ? { verticalId: rows[0].vertical_id, id: String(rows[0].intent_id), userId: String(rows[0].user_id) } : null;
}

export async function loadIntent(db: Queryable, verticalId: number, id: string, lock = ''): Promise<IntentRow | null> {
  const { rows } = await db.query(`SELECT ${INTENT_COLS} FROM intents i WHERE i.vertical_id = $1 AND i.id = $2 ${lock}`, [verticalId, id]);
  return rows[0] ?? null;
}

/** Owner-only update with optimistic concurrency. Bumps version, refreshes scope keys. */
export async function updateIntent(db: Queryable, reg: Registry, verticalId: number, id: string, userId: string, expectedVersion: number, spec: IntentSpec, titleAr: string): Promise<{ ok: true; version: number } | { ok: false; reason: 'not_found' | 'version_conflict' | 'vertical_change' }> {
  const c = specToColumns(reg, spec);
  if (c.vertical_id !== verticalId) return { ok: false, reason: 'vertical_change' };
  const { rows } = await db.query(
    `UPDATE intents SET side=$4, category_id=$5, deal_type_id=$6, title_ar=$7, point_place_id=$8, point_lft=$9, scope_strength=$10,
       scope_place_ids=$11, price_op=$12, price_lo=$13, price_hi=$14, currency=$15, price_unit=$16, price_strength=$17, negotiable=$18,
       when_range = CASE WHEN $19::timestamptz IS NULL THEN NULL ELSE tstzrange($19::timestamptz, $20::timestamptz, '[)') END,
       when_strength=$21, when_label_ar=$22, attrs=$23, constraints=$24, version = version + 1, updated_at = now(),
       geo_lat=$26, geo_lng=$27, geo_accuracy_m=$28, geo_source=$29, geo_at=$30, radius_km=$31, radius_strength=$32, nearest=$33
     WHERE vertical_id = $1 AND id = $2 AND user_id = $3 AND version = $25
     RETURNING version`,
    [verticalId, id, userId, c.side, c.category_id, c.deal_type_id, titleAr, c.point_place_id, c.point_lft, c.scope_strength, c.scope_place_ids,
      c.price_op, c.price_lo, c.price_hi, c.currency, c.price_unit, c.price_strength, c.negotiable, c.when_from, c.when_to, c.when_strength,
      c.when_label_ar, JSON.stringify(c.attrs), JSON.stringify(c.constraints), expectedVersion,
      c.geo_lat, c.geo_lng, c.geo_accuracy_m, c.geo_source, c.geo_at, c.radius_km, c.radius_strength, c.nearest],
  );
  if (!rows[0]) {
    const exists = await db.query('SELECT version FROM intents WHERE vertical_id = $1 AND id = $2 AND user_id = $3', [verticalId, id, userId]);
    return { ok: false, reason: exists.rows[0] ? 'version_conflict' : 'not_found' };
  }
  await refreshScopes(db, reg, verticalId, id);
  return { ok: true, version: rows[0].version };
}

export type StatusAction = 'pause' | 'resume' | 'fulfill' | 'close' | 'expire';
const NEXT: Record<StatusAction, { from: string[]; to: string }> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  fulfill: { from: ['active', 'paused'], to: 'fulfilled' },
  close: { from: ['active', 'paused'], to: 'closed' },
  expire: { from: ['active'], to: 'expired' },
};

export async function setIntentStatus(db: Queryable, reg: Registry, verticalId: number, id: string, userId: string | null, action: StatusAction): Promise<{ ok: true; version: number; status: string } | { ok: false; reason: string }> {
  const t = NEXT[action];
  const { rows } = await db.query(
    `UPDATE intents SET status = $3, version = version + 1, updated_at = now(),
       closed_at = CASE WHEN $3 IN ('fulfilled','closed','expired') THEN now() ELSE NULL END,
       expires_at = CASE WHEN $3 = 'active' AND (expires_at IS NULL OR expires_at < now()) THEN now() + interval '30 days' ELSE expires_at END
     WHERE vertical_id = $1 AND id = $2 AND status = ANY($4) AND ($5::bigint IS NULL OR user_id = $5)
     RETURNING version, status`,
    [verticalId, id, t.to, t.from, userId],
  );
  if (!rows[0]) return { ok: false, reason: 'invalid_transition_or_not_found' };
  await refreshScopes(db, reg, verticalId, id);
  // a paused / closed / fulfilled / expired intent stops sharing its live position (privacy: nothing lingers)
  if (rows[0].status !== 'active') await db.query('DELETE FROM live_positions WHERE vertical_id = $1 AND intent_id = $2', [verticalId, id]);
  return { ok: true, version: rows[0].version, status: rows[0].status };
}

// ───────────── cards & lists ─────────────
export interface IntentCard {
  id: string; side: Side; status: string; version: number; titleAr: string; categoryAr: string; categoryCode: string; dealAr: string; deal: DealCode;
  placeAr: string | null; priceAr: string | null; whenAr: string | null;
  chips: { labelAr: string; valueAr: string; strength?: Strength }[];
  matchCounts: { confirmed: number; possible: number }; createdAt: string; updatedAt: string; expiresAt: string | null; synthetic: boolean;
  spec?: IntentSpec;
  /** live-position sharing state (connection label only — never coordinates); null when the intent is not sharing */
  live?: { sharing: true; fresh: boolean; labelAr: string } | null;
  /** the intent has a precise point (GPS / live): placeAr is then only the coarse "قرب <city>" */
  precise?: boolean;
}

export function intentToSpec(reg: Registry, r: IntentRow): IntentSpec {
  const m = rowToMatchable(reg, r);
  return {
    side: m.side, categoryCode: m.categoryCode, deal: m.deal,
    place: {
      pointPlaceId: m.pointPlaceId, scopePlaceIds: m.scopePlaceIds, scopeStrength: m.scopeStrength, excludePlaceIds: m.excludePlaceIds,
      ...(m.geo ? { geo: m.geo } : {}), ...(m.radiusKm ? { radiusKm: m.radiusKm } : {}), ...(m.nearest ? { nearest: true } : {}),
    },
    price: m.price, when: m.when, attrs: m.attrs, constraints: m.constraints,
  };
}

export function toCard(reg: Registry, r: IntentRow, counts?: { confirmed: number; possible: number }, withSpec = false): IntentCard {
  const m = rowToMatchable(reg, r);
  const cat = reg.categoryById.get(r.category_id)!;
  const deal = reg.dealById.get(r.deal_type_id)!;
  const placeIds = m.side === 'seek' && m.scopePlaceIds.length ? m.scopePlaceIds : m.pointPlaceId != null ? [m.pointPlaceId] : m.scopePlaceIds;
  let placeAr = placeIds.length ? placeIds.map((p) => reg.placeById.get(p)?.nameAr).join(' أو ') + (m.side === 'seek' && m.scopeStrength === 'preferred' ? ' (تفضيل)' : '') : null;
  // PRIVACY: a precise point (GPS / live) is never on a card — only the nearest named place, coarsely
  const precise = !!m.live || (!!m.geo && m.geo.source !== 'place');
  if (precise && !(m.side === 'seek' && m.scopePlaceIds.length)) {
    const near = m.pointPlaceId != null ? reg.placeById.get(m.pointPlaceId)?.nameAr : undefined;
    placeAr = near ? `قرب ${near}` : 'موقع محدد (مخفي)';
  }
  const defs = attributesFor(reg, cat.code);
  const chips: IntentCard['chips'] = [];
  for (const [k, v] of Object.entries(m.attrs)) {
    const d = defs.find((x) => x.key === k);
    if (d) chips.push({ labelAr: d.labelAr, valueAr: Array.isArray(v) ? v.map((x) => d.values?.find((y) => y.code === x)?.labelAr ?? x).join('، ') : d.type === 'enum' ? d.values?.find((x) => x.code === v)?.labelAr ?? String(v) : typeof v === 'boolean' ? (v ? 'نعم' : 'لا') : k === 'floor' && v === 0 ? 'أرضي' : String(v) + (d.unit ? ` ${d.unit}` : '') });
  }
  for (const c of m.constraints) {
    const d = defs.find((x) => x.key === c.key);
    if (!d) continue;
    const val = (v: AttrValue | undefined) => (v === undefined ? '' : d.type === 'enum' ? d.values?.find((x) => x.code === v)?.labelAr ?? String(v) : typeof v === 'boolean' ? (v ? 'نعم' : 'لا') : c.key === 'floor' && v === 0 ? 'أرضي' : String(v));
    const op = c.op === 'gte' ? 'على الأقل ' : c.op === 'lte' ? 'حتى ' : c.op === 'neq' ? 'ليس ' : '';
    chips.push({ labelAr: d.labelAr, valueAr: c.op === 'in' ? (c.values ?? []).map(val).join(' أو ') : `${op}${val(c.value)}`, strength: c.strength });
  }
  if (m.excludePlaceIds.length) chips.push({ labelAr: 'باستثناء', valueAr: m.excludePlaceIds.map((p) => reg.placeById.get(p)?.nameAr).join('، '), strength: 'required' });
  const distanceAr = boundAr(reg, m);
  if (distanceAr) chips.push({ labelAr: 'المسافة', valueAr: distanceAr, strength: m.radiusKm?.strength === 'required' ? 'required' : 'preferred' });
  const ls = liveState(m, new Date());
  return {
    id: r.public_id, side: r.side, status: r.status, version: r.version, titleAr: r.title_ar, categoryAr: cat.nameAr, categoryCode: cat.code,
    dealAr: deal.nameAr, deal: deal.code, placeAr, priceAr: priceText(m.price, m.side), whenAr: m.when?.label ?? null, chips,
    matchCounts: counts ?? { confirmed: 0, possible: 0 },
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null, synthetic: r.realm === 'synthetic',
    live: ls ? { sharing: true, fresh: ls.fresh, labelAr: ls.labelAr } : null,
    precise,
    ...(withSpec ? { spec: intentToSpec(reg, r) } : {}),
  };
}

async function matchCountsFor(db: Queryable, ids: { v: number; id: string }[]): Promise<Map<string, { confirmed: number; possible: number }>> {
  const out = new Map<string, { confirmed: number; possible: number }>();
  if (!ids.length) return out;
  const { rows } = await db.query(
    `SELECT x.id::text AS id, m.state, count(*)::int AS n
       FROM unnest($1::smallint[], $2::bigint[]) AS x(v, id)
       JOIN matches m ON m.vertical_id = x.v AND (m.a_intent_id = x.id OR m.b_intent_id = x.id)
      WHERE m.state IN ('confirmed','possible')
      GROUP BY x.id, m.state`,
    [ids.map((x) => x.v), ids.map((x) => x.id)],
  );
  for (const r of rows) {
    const c = out.get(r.id) ?? { confirmed: 0, possible: 0 };
    c[r.state as 'confirmed' | 'possible'] = r.n;
    out.set(r.id, c);
  }
  return out;
}

/** Keyset pagination (created_at DESC, id DESC) with an exact total for the owner's filter. */
export async function listIntents(db: Queryable, reg: Registry, userId: string, opts: { sides: Side[]; statuses?: string[]; cursor?: string | null; dir?: 'next' | 'prev'; limit: number }): Promise<Page<IntentCard>> {
  const statuses = opts.statuses?.length ? opts.statuses : ['active', 'paused', 'fulfilled', 'closed', 'expired'];
  const total = Number((await db.query('SELECT count(*) FROM intents WHERE user_id = $1 AND side = ANY($2) AND status = ANY($3)', [userId, opts.sides, statuses])).rows[0].count);
  const cur = decodeCursor(opts.cursor);
  const prev = opts.dir === 'prev' && cur;
  const params: unknown[] = [userId, opts.sides, statuses, opts.limit + 1];
  let keyset = '';
  if (cur) {
    params.push(cur.k, cur.id);
    keyset = prev ? 'AND (i.created_at, i.id) > ($5::timestamptz, $6::bigint)' : 'AND (i.created_at, i.id) < ($5::timestamptz, $6::bigint)';
  }
  const { rows } = await db.query(
    `SELECT ${INTENT_COLS} FROM intents i WHERE i.user_id = $1 AND i.side = ANY($2) AND i.status = ANY($3) ${keyset}
      ORDER BY i.created_at ${prev ? 'ASC' : 'DESC'}, i.id ${prev ? 'ASC' : 'DESC'} LIMIT $4`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const pageRows: IntentRow[] = rows.slice(0, opts.limit);
  if (prev) pageRows.reverse();
  // position of the first row = number of rows strictly before it in the ordering + 1
  let rangeStart = 0;
  if (pageRows.length) {
    const first = pageRows[0]!;
    const before = await db.query(
      `SELECT count(*) FROM intents i WHERE i.user_id = $1 AND i.side = ANY($2) AND i.status = ANY($3) AND (i.created_at, i.id) > ($4::timestamptz, $5::bigint)`,
      [userId, opts.sides, statuses, first.created_key, first.id],
    );
    rangeStart = Number(before.rows[0].count) + 1;
  }
  const counts = await matchCountsFor(db, pageRows.map((r) => ({ v: r.vertical_id, id: String(r.id) })));
  const items = pageRows.map((r) => toCard(reg, r, counts.get(String(r.id))));
  const last = pageRows[pageRows.length - 1];
  const first = pageRows[0];
  const atEnd = prev ? false : !hasMore;
  const atStart = rangeStart <= 1;
  return {
    items, total, limit: opts.limit,
    nextCursor: last && !atEnd ? encodeCursor(last.created_key, String(last.id)) : null,
    prevCursor: first && !atStart ? encodeCursor(first.created_key, String(first.id)) : null,
    rangeStart: items.length ? rangeStart : 0,
    rangeEnd: items.length ? rangeStart + items.length - 1 : 0,
  };
}
