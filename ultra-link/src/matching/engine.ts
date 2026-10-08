// Matching engine: candidate retrieval (index-only directions), pure evaluation, versioned batch upserts,
// exclusion statistics, and de-duplicated notifications. Match semantics live in evaluate.ts (docs/MATCHING.md).
//
// Retrieval directions (each one complete for every non-excluded verdict — docs/MATCHING.md §2):
//   RANGE  — counterpart POINTS inside my REQUIRED scope (B-tree range on point_lft per scope interval), plus
//            points that are ANCESTORS of my scope places (a broader point can only be 'possible'), plus
//            counterparts without a point (probed by my point when I have one, else a bounded sample).
//   PROBE  — counterpart SCOPES that contain my POINT (equality probes on intent_scopes with my point's
//            ancestors, ≈ depth ≤ 5) or lie inside it (my point is a region → 'possible').
//   BROAD  — no point and no hard scope: recent counterparts in the category (capped, marked truncated).
//   GEO    — the intent has a distance condition (radius / nearest) and a point: KNN on stored and live points plus
//            place-only counterparts near enough (src/geo/retrieve.ts, docs/GEO.md); replaces the place directions,
//            which are not needed for completeness inside a distance bound.
//
// Concurrency & cost: one evaluation per intent at a time (advisory xact lock); eval_seq is taken before
// anything is read, and every write is guarded by eval_seq AND a_version/b_version, so an older evaluation
// can never overwrite a newer one. Writes are batched (a fixed number of statements per run, sorted by
// pair key); notifications are de-duplicated by UNIQUE(recipient_id, dedupe_key).

import type pg from 'pg';
import { withTx, type Queryable } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import type { MatchReason } from '../domain/types.ts';
import { INTENT_COLS, loadIntent, rowToMatchable, toCard, type IntentCard, type IntentRow } from '../repo/intents.ts';
import { decodeCursor, encodeCursor, type Page } from '../repo/paging.ts';
import { evaluatePair, type MatchableIntent } from './evaluate.ts';
import { attributesFor, isCategoryWithin } from '../domain/registry.ts';
import { geoPlan, retrieveNearby } from '../geo/retrieve.ts';
import { effectivePoint, liveState, RIDE_NOTIFY_K } from '../geo/semantics.ts';
import { haversineKm, roundDistance } from '../geo/distance.ts';

const MISSING_AR: Record<string, string> = {
  price: 'السعر', 'price.currency': 'عملة السعر', 'price.unit': 'وحدة السعر (شهري/سنوي…)', place: 'المكان', when: 'الموعد', category: 'الصنف بالتحديد',
  distance: 'المسافة', live: 'اتصال الموقع المباشر',
};

export const CANDIDATE_LIMIT = Number(process.env.UL_CANDIDATE_LIMIT ?? 5000);
/** Counterparts without a point when I have no point either: a bounded, newest-first sample (truncation is reported). */
export const NULL_POINT_SAMPLE = Number(process.env.UL_NULL_POINT_SAMPLE ?? 200);

export interface MatchRunSummary {
  status: 'done' | 'superseded' | 'inactive';
  intentId: string;
  version: number;
  totals: { confirmed: number; possible: number; excluded: number; candidates: number };
  exclusions: { code: string; count: number; textAr: string }[];
  truncated: boolean;
  newMatches: number;
  invalidated: number;
  durationMs: number;
  directions: string[];
}

export type MatchTrigger = 'interactive' | 'job' | 'edit' | 'status' | 'seed';
export interface MatchArgs { verticalId: number; intentId: string; version?: number; trigger: MatchTrigger; now?: Date }

/**
 * Evaluate one intent (its current version) against its candidates and persist the outcome.
 * A run is idempotent, so a deadlock / serialization failure between concurrent batches is simply retried.
 */
export async function matchIntent(pool: pg.Pool, reg: Registry, args: MatchArgs): Promise<MatchRunSummary> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTx(pool, (tx) => matchIntentTx(tx, reg, args));
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (attempt < 3 && (code === '40P01' || code === '40001')) continue;
      throw e;
    }
  }
}

/** The same run inside the caller's transaction (the caller commits). */
export async function matchIntentTx(tx: Queryable, reg: Registry, args: MatchArgs): Promise<MatchRunSummary> {
  const t0 = Date.now();
  // one evaluation per intent at a time; later versions simply run after
  await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [args.verticalId, lockKey(args.intentId)]);
  // taken BEFORE any read: a run with a higher eval_seq never saw older committed data
  const evalSeq = await nextEvalSeq(tx);
  const row = await loadIntent(tx, args.verticalId, args.intentId, 'FOR SHARE');
  const base: MatchRunSummary = { status: 'done', intentId: args.intentId, version: row?.version ?? 0, totals: { confirmed: 0, possible: 0, excluded: 0, candidates: 0 }, exclusions: [], truncated: false, newMatches: 0, invalidated: 0, durationMs: 0, directions: [] };
  if (!row) return { ...base, status: 'inactive' };
  if (args.version !== undefined && row.version !== args.version) return { ...base, status: 'superseded' };
  const me = rowToMatchable(reg, row);

  // existing pairs (any state) are always re-evaluated so stale ones get invalidated
  const existing = await tx.query(
    `SELECT a_intent_id, b_intent_id, state FROM matches WHERE vertical_id = $1 AND (a_intent_id = $2 OR b_intent_id = $2)`,
    [args.verticalId, args.intentId],
  );
  const prevState = new Map<string, string>(); // counterpart intent id → state
  for (const m of existing.rows) prevState.set(String(m.a_intent_id) === args.intentId ? String(m.b_intent_id) : String(m.a_intent_id), m.state);

  if (row.status !== 'active') {
    // paused / closed / fulfilled / expired: invalidate everything, and fence every row of this intent with
    // the new version + eval_seq so that no older run can resurrect a pair (even an already-invalidated one)
    const reason = row.status === 'paused' ? 'الطلب موقوف مؤقتًا' : row.status === 'expired' ? 'انتهت صلاحية الطلب' : row.status === 'fulfilled' ? 'تمت تلبية الطلب' : 'الطلب مغلق';
    const r = await tx.query(
      `UPDATE matches SET state = 'invalidated',
          invalid_reason_ar = CASE WHEN state = 'invalidated' THEN invalid_reason_ar ELSE $3 END,
          updated_at = CASE WHEN state = 'invalidated' THEN updated_at ELSE now() END,
          eval_seq = $4,
          a_version = CASE WHEN a_intent_id = $2 THEN GREATEST(a_version, $5) ELSE a_version END,
          b_version = CASE WHEN b_intent_id = $2 THEN GREATEST(b_version, $5) ELSE b_version END
        WHERE vertical_id = $1 AND (a_intent_id = $2 OR b_intent_id = $2) AND eval_seq < $4
        RETURNING a_intent_id, b_intent_id, a_user_id, b_user_id`,
      [args.verticalId, args.intentId, reason, evalSeq, row.version],
    );
    let invalidated = 0;
    const touched = new Set<string>();
    for (const x of r.rows) {
      const other = String(x.a_intent_id) === args.intentId ? String(x.b_intent_id) : String(x.a_intent_id);
      if (prevState.get(other) === 'invalidated') continue;
      invalidated++;
      touched.add(String(x.a_user_id)); touched.add(String(x.b_user_id));
    }
    await emitEvents(tx, [], touched);
    await recordRun(tx, args, row.version, evalSeq, base.totals, [], false, Date.now() - t0);
    return { ...base, status: 'inactive', invalidated, durationMs: Date.now() - t0 };
  }

  const now = args.now ?? new Date();
  const { ids, truncated, directions, outsideScope } = await retrieveCandidates(tx, reg, row, me, now);
  for (const other of prevState.keys()) ids.add(other);
  ids.delete(args.intentId);
  const candidates = ids.size
    ? (await tx.query(`SELECT ${INTENT_COLS} FROM intents i WHERE i.vertical_id = $1 AND i.id = ANY($2::bigint[])`, [args.verticalId, [...ids]])).rows as IntentRow[]
    : [];
  const titleOf = new Map<string, string>([[me.id, row.title_ar]]);
  for (const c of candidates) titleOf.set(String(c.id), c.title_ar);

  // ── evaluate everything in memory (pure), then write in a fixed number of batched statements
  const totals = { confirmed: 0, possible: 0, excluded: 0, candidates: candidates.length };
  const exclusionAgg = new Map<string, { count: number; textAr: string }>();
  const peer = me.side === 'join';
  const writes: PairWrite[] = [];
  const invalidations: PairInvalidation[] = [];
  // ride requests: remember distance + connection of each acceptable driver (only the K nearest connected are notified)
  const rideFrom = isRideRequest(reg, me) ? effectivePoint(reg, me, now) : null;
  const ride = rideFrom ? { from: rideFrom, drivers: [] as { id: string; km: number | null; live: boolean }[] } : null;
  for (const c of candidates) {
    const other = rowToMatchable(reg, c);
    const v = evaluatePair(reg, me, other, { now: args.now });
    const [a, b] = pairOrder(me, other);
    if (v.verdict === 'excluded') {
      totals.excluded++;
      const code = v.exclusion?.code ?? 'excluded';
      const agg = exclusionAgg.get(code) ?? { count: 0, textAr: v.exclusion?.text ?? '' };
      agg.count++;
      exclusionAgg.set(code, agg);
      if (prevState.has(other.id)) invalidations.push({ a, b, reasonAr: v.exclusion?.text ?? 'لم تعد مطابقة' });
      continue;
    }
    const state = v.verdict === 'match' ? 'confirmed' : 'possible';
    totals[state]++;
    writes.push({ kind: peer ? 'peer' : 'exchange', a, b, state, score: v.score, reasons: v.reasons, missing: v.missing });
    if (ride) {
      const to = effectivePoint(reg, other, now);
      ride.drivers.push({ id: other.id, km: to ? haversineKm(ride.from, to) : null, live: liveState(other, now)?.fresh === true });
    }
  }
  const byDistance = (x: { km: number | null }, y: { km: number | null }) => (x.km ?? Infinity) - (y.km ?? Infinity);
  const rideNotify = ride ? new Set(ride.drivers.filter((d) => d.live && d.km !== null).sort(byDistance).slice(0, RIDE_NOTIFY_K).map((d) => d.id)) : null;
  const rideSeekerNotes = ride ? new Set([...ride.drivers].sort(byDistance).slice(0, RIDE_NOTIFY_K).map((d) => d.id)) : null;
  const rideKm = new Map(ride?.drivers.map((d) => [d.id, d.km] as const) ?? []);

  const touched = new Set<string>();
  let invalidated = 0;
  for (const x of await invalidatePairs(tx, args.verticalId, evalSeq, invalidations)) {
    const other = x.aId === me.id ? x.bId : x.aId;
    if (prevState.get(other) === 'invalidated') continue; // fenced only
    invalidated++;
    touched.add(x.aUserId); touched.add(x.bUserId);
  }

  const written = await upsertPairs(tx, args.verticalId, evalSeq, writes); // rows a newer evaluation already wrote are skipped
  const byKey = new Map(writes.map((w) => [`${w.a.id}:${w.b.id}`, w] as const));
  const otherOf = (aId: string, bId: string) => (aId === me.id ? bId : aId);
  const newMatches = await registerNewMatches(tx, args.verticalId, written.filter((w) => !prevState.has(otherOf(w.aId, w.bId))));
  const notes: NewNotification[] = [];
  for (const w of written) {
    const pw = byKey.get(`${w.aId}:${w.bId}`)!;
    touched.add(pw.a.userId); touched.add(pw.b.userId);
    const prev = prevState.get(otherOf(w.aId, w.bId));
    if (prev !== undefined && prev !== 'invalidated') continue;
    // notify each side once per pair (dedupe key) — except the person looking at results right now
    for (const [mine, theirs] of [[pw.a, pw.b], [pw.b, pw.a]] as const) {
      if (args.trigger === 'interactive' && mine.userId === me.userId) continue;
      if (rideNotify && rideSeekerNotes) {
        // a new ride request reaches only the K nearest CONNECTED drivers (once: same dedupe key as any pair note);
        // the rider (when not looking at the results) hears about the K nearest drivers only
        if (mine.id !== me.id) {
          if (!rideNotify.has(mine.id)) continue;
          const km = rideKm.get(mine.id);
          notes.push({
            recipientId: mine.userId, kind: 'ride_nearby', titleAr: 'طلب توصيلة قريب منك',
            bodyAr: `«${titleOf.get(theirs.id) ?? ''}»${km != null ? ' — على بعد ' + roundDistance(km).ar : ''}`,
            payload: { matchId: w.publicId, verticalId: args.verticalId, ride: true },
            dedupeKey: `match:${args.verticalId}:${pw.a.id}:${pw.b.id}`,
          });
          continue;
        }
        if (!rideSeekerNotes.has(theirs.id)) continue;
      }
      notes.push({
        recipientId: mine.userId,
        kind: pw.state === 'confirmed' ? 'match_new' : 'match_possible',
        titleAr: pw.state === 'confirmed' ? 'مطابقة جديدة مناسبة' : 'مطابقة محتملة تحتاج تأكيد',
        bodyAr: `«${titleOf.get(theirs.id) ?? ''}» يناسب «${titleOf.get(mine.id) ?? ''}»`,
        payload: { matchId: w.publicId, verticalId: args.verticalId },
        dedupeKey: `match:${args.verticalId}:${pw.a.id}:${pw.b.id}`,
      });
    }
  }
  const notified = await notifyMany(tx, notes);
  await emitEvents(tx, notified, touched);

  if (outsideScope > 0) {
    const agg = exclusionAgg.get('place_out_of_scope') ?? { count: 0, textAr: '' };
    agg.count += outsideScope;
    exclusionAgg.set('place_out_of_scope', agg);
    totals.excluded += outsideScope;
  }
  const exclusions = [...exclusionAgg.entries()].map(([code, x]) => ({ code, count: x.count, textAr: exclusionLabel(code, x.count, x.textAr) })).sort((p, q) => q.count - p.count);
  await recordRun(tx, args, row.version, evalSeq, totals, exclusions, truncated, Date.now() - t0);
  return { status: 'done', intentId: args.intentId, version: row.version, totals, exclusions, truncated, newMatches, invalidated, durationMs: Date.now() - t0, directions };
}

// ───────────── batched, guarded writes (exported for tests) ─────────────
type Side3 = Pick<MatchableIntent, 'id' | 'userId' | 'version'>;
export interface PairWrite { kind: 'exchange' | 'peer'; a: Side3; b: Side3; state: 'confirmed' | 'possible'; score: number; reasons: MatchReason[]; missing: string[] }
export interface PairInvalidation { a: Side3; b: Side3; reasonAr: string }
export interface WrittenPair { id: string; publicId: string; aId: string; bId: string; state: string }

export async function nextEvalSeq(db: Queryable): Promise<string> {
  return String((await db.query("SELECT nextval('match_eval_seq') AS s")).rows[0].s);
}

/** exchange: a = seeker, b = provider; peer: a = lower intent id. */
function pairOrder(me: MatchableIntent, other: MatchableIntent): [MatchableIntent, MatchableIntent] {
  if (me.side === 'join') return BigInt(me.id) < BigInt(other.id) ? [me, other] : [other, me];
  return me.side === 'seek' ? [me, other] : [other, me];
}
const byPairKey = <T extends { a: Side3; b: Side3 }>(xs: T[]) => [...xs].sort((p, q) => cmpBig(p.a.id, q.a.id) || cmpBig(p.b.id, q.b.id));
function cmpBig(x: string, y: string): number { const a = BigInt(x); const b = BigInt(y); return a < b ? -1 : a > b ? 1 : 0; }

/**
 * Insert or update pairs, never overwriting a row written by a NEWER evaluation (higher eval_seq) or from
 * NEWER intent versions. Returns only the rows actually written. Rows are processed in pair-key order.
 */
export async function upsertPairs(db: Queryable, verticalId: number, evalSeq: string, pairs: PairWrite[]): Promise<WrittenPair[]> {
  if (!pairs.length) return [];
  const xs = byPairKey(pairs);
  const { rows } = await db.query(
    `INSERT INTO matches (vertical_id, kind, a_intent_id, b_intent_id, a_user_id, b_user_id, state, score, reasons, missing, a_version, b_version, eval_seq)
     SELECT $1, t.kind, t.a, t.b, t.au, t.bu, t.state, t.score, t.reasons::jsonb, t.missing::jsonb, t.av, t.bv, $2
       FROM unnest($3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::bigint[], $8::text[], $9::int[], $10::text[], $11::text[], $12::int[], $13::int[])
            WITH ORDINALITY AS t(kind, a, b, au, bu, state, score, reasons, missing, av, bv, ord)
      ORDER BY t.ord
     ON CONFLICT (vertical_id, a_intent_id, b_intent_id) DO UPDATE SET
       state = EXCLUDED.state, score = EXCLUDED.score, reasons = EXCLUDED.reasons, missing = EXCLUDED.missing,
       a_version = EXCLUDED.a_version, b_version = EXCLUDED.b_version, eval_seq = EXCLUDED.eval_seq, invalid_reason_ar = NULL,
       updated_at = CASE WHEN matches.state IS DISTINCT FROM EXCLUDED.state OR matches.score IS DISTINCT FROM EXCLUDED.score
                           OR matches.reasons IS DISTINCT FROM EXCLUDED.reasons THEN now() ELSE matches.updated_at END
     WHERE matches.eval_seq < EXCLUDED.eval_seq AND matches.a_version <= EXCLUDED.a_version AND matches.b_version <= EXCLUDED.b_version
     RETURNING id, public_id, a_intent_id, b_intent_id, state`,
    [verticalId, evalSeq, xs.map((x) => x.kind), xs.map((x) => x.a.id), xs.map((x) => x.b.id), xs.map((x) => x.a.userId), xs.map((x) => x.b.userId),
      xs.map((x) => x.state), xs.map((x) => x.score), xs.map((x) => JSON.stringify(x.reasons)), xs.map((x) => JSON.stringify(x.missing)),
      xs.map((x) => x.a.version), xs.map((x) => x.b.version)],
  );
  return rows.map((r) => ({ id: String(r.id), publicId: r.public_id, aId: String(r.a_intent_id), bId: String(r.b_intent_id), state: r.state }));
}

/** Invalidate (and fence) existing pairs with the same guards as upsertPairs. Returns the rows written. */
export async function invalidatePairs(db: Queryable, verticalId: number, evalSeq: string, pairs: PairInvalidation[]): Promise<{ aId: string; bId: string; aUserId: string; bUserId: string }[]> {
  if (!pairs.length) return [];
  const xs = byPairKey(pairs);
  const { rows } = await db.query(
    `UPDATE matches m SET state = 'invalidated', invalid_reason_ar = t.reason, a_version = t.av, b_version = t.bv, eval_seq = $2,
            updated_at = CASE WHEN m.state = 'invalidated' AND m.invalid_reason_ar IS NOT DISTINCT FROM t.reason THEN m.updated_at ELSE now() END
       FROM unnest($3::bigint[], $4::bigint[], $5::int[], $6::int[], $7::text[]) AS t(a, b, av, bv, reason)
      WHERE m.vertical_id = $1 AND m.a_intent_id = t.a AND m.b_intent_id = t.b
        AND m.eval_seq < $2 AND m.a_version <= t.av AND m.b_version <= t.bv
      RETURNING m.a_intent_id, m.b_intent_id, m.a_user_id, m.b_user_id`,
    [verticalId, evalSeq, xs.map((x) => x.a.id), xs.map((x) => x.b.id), xs.map((x) => x.a.version), xs.map((x) => x.b.version), xs.map((x) => x.reasonAr)],
  );
  return rows.map((r) => ({ aId: String(r.a_intent_id), bId: String(r.b_intent_id), aUserId: String(r.a_user_id), bUserId: String(r.b_user_id) }));
}

/** match_refs rows for pairs not seen before; the idempotent insert tells exactly which matches are new. */
async function registerNewMatches(db: Queryable, verticalId: number, rows: WrittenPair[]): Promise<number> {
  if (!rows.length) return 0;
  const r = await db.query(
    `INSERT INTO match_refs (public_id, vertical_id, match_id) SELECT t.p, $1, t.id FROM unnest($2::uuid[], $3::bigint[]) AS t(p, id)
     ON CONFLICT DO NOTHING`,
    [verticalId, rows.map((x) => x.publicId), rows.map((x) => x.id)],
  );
  return r.rowCount ?? 0;
}

// Same contract as repo/notifications.ts notify(), batched: one row per (recipient, dedupe_key), ever.
interface NewNotification { recipientId: string; kind: string; titleAr: string; bodyAr: string; payload: Record<string, unknown>; dedupeKey: string }
async function notifyMany(db: Queryable, ns: NewNotification[]): Promise<string[]> {
  if (!ns.length) return [];
  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_id, kind, title_ar, body_ar, payload, dedupe_key)
     SELECT t.rcp, t.knd, t.ttl, t.bdy, t.pl::jsonb, t.dk FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(rcp, knd, ttl, bdy, pl, dk)
     ON CONFLICT (recipient_id, dedupe_key) DO NOTHING RETURNING recipient_id`,
    [ns.map((n) => n.recipientId), ns.map((n) => n.kind), ns.map((n) => n.titleAr), ns.map((n) => n.bodyAr), ns.map((n) => JSON.stringify(n.payload)), ns.map((n) => n.dedupeKey)],
  );
  return [...new Set(rows.map((r) => String(r.recipient_id)))];
}

/** One pg_notify per user and event type (delivered at commit; the SSE layer pushes fresh counts). */
async function emitEvents(db: Queryable, notified: string[], touched: Set<string>): Promise<void> {
  const payloads = [
    ...notified.map((userId) => JSON.stringify({ userId, type: 'notification' })),
    ...[...touched].map((userId) => JSON.stringify({ userId, type: 'match_update' })),
  ];
  if (payloads.length) await db.query(`SELECT pg_notify('ul_events', p) FROM unnest($1::text[]) AS p`, [payloads]);
}

function lockKey(intentId: string): number { return Number(BigInt(intentId) % 2147483647n); }

async function recordRun(tx: Queryable, args: { verticalId: number; intentId: string; trigger: string }, version: number, evalSeq: string, totals: MatchRunSummary['totals'], exclusions: MatchRunSummary['exclusions'], truncated: boolean, ms: number) {
  await tx.query(
    `INSERT INTO match_runs (vertical_id, intent_id, intent_version, eval_seq, candidates, confirmed, possible, excluded, exclusions, truncated, duration_ms, trigger)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [args.verticalId, args.intentId, version, evalSeq, totals.candidates, totals.confirmed, totals.possible, totals.excluded, JSON.stringify(exclusions), truncated, ms, args.trigger],
  );
}

function exclusionLabel(code: string, n: number, sample: string): string {
  const labels: Record<string, string> = {
    place_out_of_scope: 'خارج المكان الذي اشترطته', place_excluded: 'في مكان استثنيته', price_above_max: 'أعلى من حد السعر',
    price_below_min: 'أقل من الحد الأدنى للسعر', price_not_exact: 'السعر لا يساوي المطلوب بالضبط', attr_violation: 'لا يحقق شرطًا ملزمًا',
    date_no_overlap: 'موعد مختلف', deal_mismatch: 'نوع عملية مختلف', category_mismatch: 'صنف مختلف', side_mismatch: 'نفس الدور',
    same_owner: 'من نفس الحساب', inactive: 'غير نشط', realm_mismatch: 'بيانات تجريبية',
    distance_beyond_radius: 'أبعد من المسافة المحددة',
  };
  void n; // the UI prefixes the count (contract: textAr is the reason label only)
  return labels[code] ?? sample;
}

/** A ride request ("بدي تكسي / توصيلة"): seeking transport.ride (or narrower). */
function isRideRequest(reg: Registry, me: MatchableIntent): boolean {
  const ride = reg.categoryByCode.get('transport.ride');
  const cat = reg.categoryByCode.get(me.categoryCode);
  return me.side === 'seek' && !!ride && !!cat && isCategoryWithin(reg, cat.id, ride.id);
}

/** Candidate ids using index-friendly directions. Never a full scan of the vertical. Exported for tests. */
export async function retrieveCandidates(tx: Queryable, reg: Registry, row: IntentRow, me: MatchableIntent, now: Date = new Date()): Promise<{ ids: Set<string>; truncated: boolean; directions: string[]; outsideScope: number }> {
  // distance-bounded intents (radius / nearest with a known point): the GEO directions (src/geo/retrieve.ts)
  const plan = geoPlan(reg, me, now);
  if (plan) return retrieveNearby(tx, reg, row, me, plan);
  let outsideScope = 0;
  const ids = new Set<string>();
  const directions: string[] = [];
  let truncated = false;
  const counterSide = me.side === 'join' ? 'join' : me.side === 'seek' ? 'provide' : 'seek';
  const cat = reg.categoryByCode.get(me.categoryCode)!;
  const catSet = [...new Set([...cat.ancestors, ...cat.descendants])];
  const scope = me.scopePlaceIds.filter((p) => p !== reg.rootPlaceId);
  const add = (rows: { id: string }[], limit: number) => { for (const r of rows) ids.add(String(r.id)); if (rows.length >= limit) truncated = true; };
  const common = [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, me.userId] as const; // $1..$6
  const point = me.pointPlaceId != null ? reg.placeById.get(me.pointPlaceId)! : null;
  // scope rows that relate to my point: containing it (ancestors) or inside it (my point is a region)
  const probePlaces = point ? [...point.ancestors, ...reg.places.filter((p) => p.lft > point.lft && p.rgt < point.rgt).map((p) => p.id)] : [];

  const hardScope = scope.length > 0 && me.scopeStrength === 'required';
  // RANGE: a counterpart point must lie inside (or, as a broader region, contain) my required scope — necessary
  // for any non-excluded verdict, so for exchange it is the only place direction needed
  if (hardScope) {
    directions.push('range');
    const scopePlaces = scope.map((s) => reg.placeById.get(s)!);
    for (const p of scopePlaces) {
      const { rows } = await tx.query(
        `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
            AND status = 'active' AND user_id <> $6 AND point_lft BETWEEN $7 AND $8
          ORDER BY created_at DESC LIMIT $9`,
        [...common, p.lft, p.rgt, CANDIDATE_LIMIT],
      );
      add(rows, CANDIDATE_LIMIT);
    }
    const ancestorLfts = [...new Set(scopePlaces.flatMap((p) => p.ancestors.slice(1)))].map((id) => reg.placeById.get(id)!.lft);
    {
      const { rows } = await tx.query(
        `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
            AND status = 'active' AND user_id <> $6 AND point_lft = ANY($7::int[]) ORDER BY created_at DESC LIMIT $8`,
        [...common, ancestorLfts, CANDIDATE_LIMIT],
      );
      add(rows, CANDIDATE_LIMIT);
    }
    // transparency: how many active counterparts exist OUTSIDE the hard scope (bounded count, not fetched)
    const ranges = scopePlaces.map((_, k) => `NOT (point_lft BETWEEN $${8 + 2 * k} AND $${9 + 2 * k})`).join(' AND ');
    const outside = await tx.query(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4
          AND category_id = ANY($5) AND status = 'active' AND user_id <> $6 AND point_lft IS NOT NULL
          AND NOT (point_lft = ANY($7::int[])) AND ${ranges} LIMIT 1000) x`,
      [...common, ancestorLfts, ...scopePlaces.flatMap((p) => [p.lft, p.rgt])],
    );
    outsideScope = outside.rows[0].n;
    // counterparts with an unknown point can only be "possible"
    if (point && me.side !== 'join') {
      // complete: those whose scope reaches my point (an empty or preferred scope is keyed on the root place)
      const { rows } = await tx.query(
        `SELECT DISTINCT s.intent_id AS id FROM intent_scopes s JOIN intents i ON i.vertical_id = s.vertical_id AND i.id = s.intent_id
          WHERE s.vertical_id = $1 AND s.realm = $2 AND s.side = $3 AND s.deal_type_id = $4 AND s.category_id = ANY($5)
            AND s.place_id = ANY($7) AND i.point_lft IS NULL AND i.status = 'active' AND i.user_id <> $6 LIMIT $8`,
        [...common, probePlaces, CANDIDATE_LIMIT],
      );
      add(rows, CANDIDATE_LIMIT);
    } else if (!point) {
      const { rows } = await tx.query(
        `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
            AND status = 'active' AND point_lft IS NULL AND user_id <> $6 ORDER BY created_at DESC LIMIT $7`,
        [...common, NULL_POINT_SAMPLE],
      );
      add(rows, NULL_POINT_SAMPLE);
    }
  }
  // PROBE: counterpart scopes related to my point (ancestors × category set, plus places inside a region point)
  if (point && (!hardScope || me.side === 'join')) {
    directions.push('probe');
    const { rows } = await tx.query(
      `SELECT DISTINCT s.intent_id AS id FROM intent_scopes s
        WHERE s.vertical_id = $1 AND s.realm = $2 AND s.side = $3 AND s.deal_type_id = $4 AND s.category_id = ANY($5) AND s.place_id = ANY($6)
        LIMIT $7`,
      [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, probePlaces, CANDIDATE_LIMIT],
    );
    add(rows, CANDIDATE_LIMIT);
  }
  // BROAD: neither a point nor a hard scope (e.g. "بدي سيارة" anywhere)
  if (!hardScope && !point) {
    directions.push('broad');
    for (const s of scope) {
      const p = reg.placeById.get(s)!;
      const { rows } = await tx.query(
        `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
            AND status = 'active' AND user_id <> $6 AND point_lft BETWEEN $7 AND $8 ORDER BY created_at DESC LIMIT $9`,
        [...common, p.lft, p.rgt, CANDIDATE_LIMIT],
      );
      add(rows, CANDIDATE_LIMIT);
    }
    const { rows } = await tx.query(
      `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
          AND status = 'active' AND user_id <> $6 ORDER BY created_at DESC LIMIT $7`,
      [...common, CANDIDATE_LIMIT],
    );
    add(rows, CANDIDATE_LIMIT);
  }
  return { ids, truncated, directions, outsideScope };
}

// ───────────── reading matches ─────────────
export interface MatchCard {
  id: string; state: 'confirmed' | 'possible' | 'invalidated'; score: number; kind: 'exchange' | 'peer';
  mine: IntentCard; other: IntentCard;
  reasons: { code: string; polarity: string; text: string; strength?: string }[]; missing: string[]; missingKeys: string[];
  contact: { status: 'none' | 'pending_out' | 'pending_in' | 'accepted' | 'declined'; requestId?: string; counterpart?: { displayName: string; phone?: string } };
  updatedAt: string; invalidReasonAr?: string;
}

export async function listMatches(
  db: Queryable, reg: Registry, userId: string,
  opts: { intent?: { verticalId: number; id: string } | null; states: string[]; cursor?: string | null; dir?: 'next' | 'prev'; limit: number },
): Promise<Page<MatchCard>> {
  const filter = opts.intent
    ? `m.vertical_id = $2 AND (m.a_intent_id = $3 OR m.b_intent_id = $3) AND (m.a_user_id = $1 OR m.b_user_id = $1)`
    : `(m.a_user_id = $1 OR m.b_user_id = $1)`;
  const baseParams: unknown[] = opts.intent ? [userId, opts.intent.verticalId, opts.intent.id] : [userId];
  const sp = baseParams.length + 1;
  const total = Number((await db.query(`SELECT count(*) FROM matches m WHERE ${filter} AND m.state = ANY($${sp})`, [...baseParams, opts.states])).rows[0].count);
  const cur = decodeCursor(opts.cursor);
  const prev = opts.dir === 'prev' && !!cur;
  const params: unknown[] = [...baseParams, opts.states, opts.limit + 1];
  let keyset = '';
  if (cur) {
    params.push(Number(cur.k), cur.id);
    keyset = prev ? `AND (m.score, m.id) > ($${sp + 2}::int, $${sp + 3}::bigint)` : `AND (m.score, m.id) < ($${sp + 2}::int, $${sp + 3}::bigint)`;
  }
  const { rows } = await db.query(
    `SELECT m.* FROM matches m WHERE ${filter} AND m.state = ANY($${sp}) ${keyset}
      ORDER BY m.score ${prev ? 'ASC' : 'DESC'}, m.id ${prev ? 'ASC' : 'DESC'} LIMIT $${sp + 1}`,
    params,
  );
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit);
  if (prev) page.reverse();
  let rangeStart = 0;
  if (page.length) {
    const f = page[0];
    rangeStart = Number((await db.query(`SELECT count(*) FROM matches m WHERE ${filter} AND m.state = ANY($${sp}) AND (m.score, m.id) > ($${sp + 1}::int, $${sp + 2}::bigint)`, [...baseParams, opts.states, f.score, f.id])).rows[0].count) + 1;
  }
  const items = await hydrateMatches(db, reg, userId, page);
  return {
    items, total, limit: opts.limit,
    nextCursor: page.length && (prev || hasMore) ? encodeCursor(page[page.length - 1].score, String(page[page.length - 1].id)) : null,
    prevCursor: page.length && rangeStart > 1 ? encodeCursor(page[0].score, String(page[0].id)) : null,
    rangeStart: items.length ? rangeStart : 0,
    rangeEnd: items.length ? rangeStart + items.length - 1 : 0,
  };
}

export async function hydrateMatches(db: Queryable, reg: Registry, userId: string, rows: any[]): Promise<MatchCard[]> {
  if (!rows.length) return [];
  const keys = rows.flatMap((m) => [[m.vertical_id, m.a_intent_id], [m.vertical_id, m.b_intent_id]]);
  const intents = await db.query(
    `SELECT ${INTENT_COLS} FROM intents i JOIN unnest($1::smallint[], $2::bigint[]) AS k(v, id) ON i.vertical_id = k.v AND i.id = k.id`,
    [keys.map((k) => k[0]), keys.map((k) => k[1])],
  );
  const byId = new Map<string, IntentRow>(intents.rows.map((r: IntentRow) => [`${r.vertical_id}:${r.id}`, r]));
  const contacts = await db.query(
    `SELECT c.public_id, c.vertical_id, c.match_id, c.requester_id, c.recipient_id, c.status, u.display_name, u.contact_phone
       FROM contact_requests c JOIN users u ON u.id = CASE WHEN c.requester_id = $1 THEN c.recipient_id ELSE c.requester_id END
      WHERE (c.vertical_id, c.match_id) IN (SELECT * FROM unnest($2::smallint[], $3::bigint[])) AND (c.requester_id = $1 OR c.recipient_id = $1)`,
    [userId, rows.map((m) => m.vertical_id), rows.map((m) => m.id)],
  );
  const contactBy = new Map<string, any>(contacts.rows.map((c) => [`${c.vertical_id}:${c.match_id}`, c]));
  return rows.map((m) => {
    const iAmA = String(m.a_user_id) === String(userId);
    const mine = byId.get(`${m.vertical_id}:${iAmA ? m.a_intent_id : m.b_intent_id}`)!;
    const other = byId.get(`${m.vertical_id}:${iAmA ? m.b_intent_id : m.a_intent_id}`)!;
    const c = contactBy.get(`${m.vertical_id}:${m.id}`);
    let contact: MatchCard['contact'] = { status: 'none' };
    if (c) {
      const out = String(c.requester_id) === String(userId);
      contact = { status: c.status === 'pending' ? (out ? 'pending_out' : 'pending_in') : c.status === 'accepted' ? 'accepted' : 'declined', requestId: c.public_id };
      if (c.status === 'accepted') contact.counterpart = { displayName: c.display_name, phone: c.contact_phone ?? undefined };
    }
    const otherCard = toCard(reg, other);
    const defs = attributesFor(reg, otherCard.categoryCode);
    const missingAr = (m.missing as string[]).map((k) => MISSING_AR[k] ?? (k.startsWith('attr.') ? defs.find((d) => d.key === k.slice(5))?.labelAr ?? k.slice(5) : k));
    return {
      id: m.public_id, state: m.state, score: m.score, kind: m.kind, mine: toCard(reg, mine), other: { ...otherCard },
      reasons: m.reasons, missing: missingAr, missingKeys: m.missing, contact, updatedAt: new Date(m.updated_at).toISOString(), invalidReasonAr: m.invalid_reason_ar ?? undefined,
    };
  });
}

export async function latestRun(db: Queryable, verticalId: number, intentId: string, version: number) {
  const { rows } = await db.query(
    `SELECT * FROM match_runs WHERE vertical_id = $1 AND intent_id = $2 AND intent_version = $3 ORDER BY id DESC LIMIT 1`,
    [verticalId, intentId, version],
  );
  return rows[0] ?? null;
}
