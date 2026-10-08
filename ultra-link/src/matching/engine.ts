// Matching engine: candidate retrieval (index-only directions), pure evaluation, versioned upserts,
// exclusion statistics, and de-duplicated notifications.
//
// Retrieval directions (see docs/ARCHITECTURE.md "Hierarchical Match Keys"):
//   RANGE  — counterpart POINTS inside my REQUIRED scope: B-tree range scan on point_lft per scope interval.
//   PROBE  — counterpart SCOPES that contain my POINT: equality probes on intent_scopes with my point's
//            ancestors (≈ depth ≤ 5) × category ancestors (≤ 3).
//   BROAD  — no point and no hard scope: recent counterparts in the category (capped, marked truncated).

import type pg from 'pg';
import { withTx, type Queryable } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import type { PairVerdict } from '../domain/types.ts';
import { notify, emitUserEvent } from '../repo/notifications.ts';
import { INTENT_COLS, loadIntent, rowToMatchable, toCard, type IntentCard, type IntentRow } from '../repo/intents.ts';
import { decodeCursor, encodeCursor, type Page } from '../repo/paging.ts';
import { evaluatePair, type MatchableIntent } from './evaluate.ts';
import { attributesFor } from '../domain/registry.ts';

const MISSING_AR: Record<string, string> = {
  price: 'السعر', 'price.currency': 'عملة السعر', 'price.unit': 'وحدة السعر (شهري/سنوي…)', place: 'المكان', when: 'الموعد',
};

export const CANDIDATE_LIMIT = Number(process.env.UL_CANDIDATE_LIMIT ?? 5000);

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

export async function matchIntent(
  pool: pg.Pool, reg: Registry,
  args: { verticalId: number; intentId: string; version?: number; trigger: 'interactive' | 'job' | 'edit' | 'status' | 'seed'; now?: Date },
): Promise<MatchRunSummary> {
  const t0 = Date.now();
  return withTx(pool, async (tx) => {
    // one evaluation per intent at a time; later versions simply run after
    await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [args.verticalId, Number(BigInt(args.intentId) % 2147483647n)]);
    const evalSeq = (await tx.query("SELECT nextval('match_eval_seq') AS s")).rows[0].s as string;
    const row = await loadIntent(tx, args.verticalId, args.intentId, 'FOR SHARE');
    const base: MatchRunSummary = { status: 'done', intentId: args.intentId, version: row?.version ?? 0, totals: { confirmed: 0, possible: 0, excluded: 0, candidates: 0 }, exclusions: [], truncated: false, newMatches: 0, invalidated: 0, durationMs: 0, directions: [] };
    if (!row) return { ...base, status: 'inactive' };
    if (args.version !== undefined && row.version !== args.version) return { ...base, status: 'superseded' };
    const me = rowToMatchable(reg, row);

    // existing matches (any state) must be re-evaluated so stale ones get invalidated
    const existing = await tx.query(
      `SELECT id, public_id, a_intent_id, b_intent_id, state, a_user_id, b_user_id FROM matches
        WHERE vertical_id = $1 AND (a_intent_id = $2 OR b_intent_id = $2)`,
      [args.verticalId, args.intentId],
    );
    const existingByOther = new Map<string, { id: string; state: string }>();
    for (const m of existing.rows) existingByOther.set(String(m.a_intent_id) === args.intentId ? String(m.b_intent_id) : String(m.a_intent_id), { id: String(m.id), state: m.state });

    if (row.status !== 'active') {
      // closed / paused / expired: invalidate everything still active
      const reason = row.status === 'paused' ? 'الطلب موقوف مؤقتًا' : row.status === 'expired' ? 'انتهت صلاحية الطلب' : 'الطلب مغلق';
      const r = await tx.query(
        `UPDATE matches SET state = 'invalidated', invalid_reason_ar = $3, eval_seq = $4, updated_at = now()
          WHERE vertical_id = $1 AND (a_intent_id = $2 OR b_intent_id = $2) AND state <> 'invalidated' AND eval_seq < $4
          RETURNING a_user_id, b_user_id`,
        [args.verticalId, args.intentId, reason, evalSeq],
      );
      for (const u of new Set(r.rows.flatMap((x) => [String(x.a_user_id), String(x.b_user_id)]))) await emitUserEvent(tx, u, 'match_update');
      await recordRun(tx, args, row.version, evalSeq, base.totals, [], false, Date.now() - t0);
      return { ...base, status: 'inactive', invalidated: r.rowCount ?? 0, durationMs: Date.now() - t0 };
    }

    const { ids, truncated, directions, outsideScope } = await retrieveCandidates(tx, reg, row, me);
    for (const other of existingByOther.keys()) ids.add(other);
    ids.delete(args.intentId);
    const candidates = ids.size
      ? (await tx.query(`SELECT ${INTENT_COLS} FROM intents i WHERE i.vertical_id = $1 AND i.id = ANY($2::bigint[])`, [args.verticalId, [...ids]])).rows as IntentRow[]
      : [];

    const totals = { confirmed: 0, possible: 0, excluded: 0, candidates: candidates.length };
    const exclusionAgg = new Map<string, { count: number; textAr: string }>();
    let newMatches = 0;
    let invalidated = 0;
    const touchedUsers = new Set<string>();
    for (const c of candidates) {
      const other = rowToMatchable(reg, c);
      const v: PairVerdict = evaluatePair(reg, me, other, { now: args.now });
      const peer = me.side === 'join';
      const [a, b] = peer ? (BigInt(me.id) < BigInt(other.id) ? [me, other] : [other, me]) : me.side === 'seek' ? [me, other] : [other, me];
      const prev = existingByOther.get(other.id);
      if (v.verdict === 'excluded') {
        totals.excluded++;
        const code = v.exclusion?.code ?? 'excluded';
        const agg = exclusionAgg.get(code) ?? { count: 0, textAr: v.exclusion?.text ?? '' };
        agg.count++;
        exclusionAgg.set(code, agg);
        if (prev && prev.state !== 'invalidated') {
          const r = await tx.query(
            `UPDATE matches SET state = 'invalidated', invalid_reason_ar = $4, a_version = $5, b_version = $6, eval_seq = $7, updated_at = now()
              WHERE vertical_id = $1 AND a_intent_id = $2 AND b_intent_id = $3 AND eval_seq < $7 AND a_version <= $5 AND b_version <= $6`,
            [args.verticalId, a.id, b.id, v.exclusion?.text ?? 'لم تعد مطابقة', a.version, b.version, evalSeq],
          );
          if (r.rowCount) { invalidated++; touchedUsers.add(a.userId); touchedUsers.add(b.userId); }
        }
        continue;
      }
      const state = v.verdict === 'match' ? 'confirmed' : 'possible';
      totals[state]++;
      const up = await tx.query(
        `INSERT INTO matches (vertical_id, kind, a_intent_id, b_intent_id, a_user_id, b_user_id, state, score, reasons, missing, a_version, b_version, eval_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (vertical_id, a_intent_id, b_intent_id) DO UPDATE SET
           state = EXCLUDED.state, score = EXCLUDED.score, reasons = EXCLUDED.reasons, missing = EXCLUDED.missing,
           a_version = EXCLUDED.a_version, b_version = EXCLUDED.b_version, eval_seq = EXCLUDED.eval_seq, invalid_reason_ar = NULL, updated_at = now()
         WHERE matches.eval_seq < EXCLUDED.eval_seq AND matches.a_version <= EXCLUDED.a_version AND matches.b_version <= EXCLUDED.b_version
         RETURNING id, public_id, (first_matched_at = now()) AS inserted`,
        [args.verticalId, peer ? 'peer' : 'exchange', a.id, b.id, a.userId, b.userId, state, v.score, JSON.stringify(v.reasons), JSON.stringify(v.missing), a.version, b.version, evalSeq],
      );
      const m = up.rows[0];
      if (!m) continue; // a newer evaluation already wrote this pair — never overwrite newer results
      if (m.inserted) {
        await tx.query('INSERT INTO match_refs (public_id, vertical_id, match_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [m.public_id, args.verticalId, m.id]);
        newMatches++;
      }
      touchedUsers.add(a.userId); touchedUsers.add(b.userId);
      // notify each side once per pair (dedupe key) — except the person looking at results right now
      if (!prev || prev.state === 'invalidated') {
        for (const [recipient, mine, theirs] of [[a, a, b], [b, b, a]] as const) {
          if (args.trigger === 'interactive' && recipient.userId === me.userId) continue;
          const theirsTitle = candidates.find((x) => String(x.id) === theirs.id)?.title_ar ?? (theirs.id === me.id ? row.title_ar : '');
          const mineTitle = mine.id === me.id ? row.title_ar : candidates.find((x) => String(x.id) === mine.id)?.title_ar ?? '';
          await notify(tx, {
            recipientId: recipient.userId,
            kind: state === 'confirmed' ? 'match_new' : 'match_possible',
            titleAr: state === 'confirmed' ? 'مطابقة جديدة مناسبة' : 'مطابقة محتملة تحتاج تأكيد',
            bodyAr: `«${theirsTitle}» يناسب «${mineTitle}»`,
            payload: { matchId: m.public_id, verticalId: args.verticalId },
            dedupeKey: `match:${args.verticalId}:${a.id}:${b.id}`,
          });
        }
      }
    }
    for (const u of touchedUsers) await emitUserEvent(tx, u, 'match_update');
    if (outsideScope > 0) {
      const names = me.scopePlaceIds.map((p) => reg.placeById.get(p)?.nameAr).join(' أو ');
      const agg = exclusionAgg.get('place_out_of_scope') ?? { count: 0, textAr: '' };
      agg.count += outsideScope;
      exclusionAgg.set('place_out_of_scope', agg);
      totals.excluded += outsideScope;
      void names;
    }
    const exclusions = [...exclusionAgg.entries()].map(([code, x]) => ({ code, count: x.count, textAr: exclusionLabel(code, x.count, x.textAr) })).sort((p, q) => q.count - p.count);
    await recordRun(tx, args, row.version, evalSeq, totals, exclusions, truncated, Date.now() - t0);
    return { status: 'done', intentId: args.intentId, version: row.version, totals, exclusions, truncated, newMatches, invalidated, durationMs: Date.now() - t0, directions };
  });
}

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
  };
  return `${n} ${labels[code] ?? sample}`;
}

/** Candidate ids using index-friendly directions. Never a full scan of the vertical. */
async function retrieveCandidates(tx: Queryable, reg: Registry, row: IntentRow, me: MatchableIntent): Promise<{ ids: Set<string>; truncated: boolean; directions: string[]; outsideScope: number }> {
  let outsideScope = 0;
  const ids = new Set<string>();
  const directions: string[] = [];
  let truncated = false;
  const counterSide = me.side === 'join' ? 'join' : me.side === 'seek' ? 'provide' : 'seek';
  const cat = reg.categoryByCode.get(me.categoryCode)!;
  const catSet = [...new Set([...cat.ancestors, ...cat.descendants])];
  const catAncestors = cat.ancestors;
  const scope = me.scopePlaceIds.filter((p) => p !== reg.rootPlaceId);
  const add = (rows: { id: string }[], limit: number) => { for (const r of rows) ids.add(String(r.id)); if (rows.length >= limit) truncated = true; };

  const hardScope = scope.length > 0 && me.scopeStrength === 'required';
  // RANGE: counterpart points inside my required scope (necessary for any match, so it is the only
  // direction needed for exchange; peers also probe because "either area contains the other")
  if (hardScope) {
    directions.push('range');
    for (const s of scope) {
      const p = reg.placeById.get(s)!;
      const { rows } = await tx.query(
        `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
            AND status = 'active' AND point_lft BETWEEN $6 AND $7 AND user_id <> $8
          ORDER BY created_at DESC LIMIT $9`,
        [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, p.lft, p.rgt, me.userId, CANDIDATE_LIMIT],
      );
      add(rows, CANDIDATE_LIMIT);
    }
    // transparency: how many active counterparts exist OUTSIDE the hard scope (bounded count, not fetched)
    const outside = await tx.query(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4
          AND category_id = ANY($5) AND status = 'active' AND user_id <> $6 AND point_lft IS NOT NULL
          AND NOT (point_lft BETWEEN ANY_LO AND ANY_HI) LIMIT 1000) x`.replace('NOT (point_lft BETWEEN ANY_LO AND ANY_HI)', scope.map((_, k) => `NOT (point_lft BETWEEN $${7 + 2 * k} AND $${8 + 2 * k})`).join(' AND ')),
      [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, me.userId, ...scope.flatMap((s) => [reg.placeById.get(s)!.lft, reg.placeById.get(s)!.rgt])],
    );
    outsideScope = outside.rows[0].n;
    // counterparts with an unknown point can only be "possible" — fetch a bounded sample
    const { rows } = await tx.query(
      `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
          AND status = 'active' AND point_lft IS NULL AND user_id <> $6 ORDER BY created_at DESC LIMIT 200`,
      [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, me.userId],
    );
    add(rows, 1_000_000);
  }
  // PROBE: counterpart scopes containing my point (ancestors × category ancestors)
  if (me.pointPlaceId != null && (!hardScope || me.side === 'join')) {
    directions.push('probe');
    const placeAnc = reg.placeById.get(me.pointPlaceId)!.ancestors;
    const { rows } = await tx.query(
      `SELECT DISTINCT s.intent_id AS id FROM intent_scopes s
        WHERE s.vertical_id = $1 AND s.realm = $2 AND s.side = $3 AND s.deal_type_id = $4 AND s.category_id = ANY($5) AND s.place_id = ANY($6)
        LIMIT $7`,
      [row.vertical_id, me.realm, counterSide, row.deal_type_id, me.side === 'join' ? catSet : catAncestors.concat(cat.descendants), placeAnc, CANDIDATE_LIMIT],
    );
    add(rows, CANDIDATE_LIMIT);
  }
  // BROAD: neither a point nor a hard scope (e.g. "بدي سيارة" anywhere)
  if (!hardScope && me.pointPlaceId == null) {
    directions.push('broad');
    if (scope.length) {
      for (const s of scope) {
        const p = reg.placeById.get(s)!;
        const { rows } = await tx.query(
          `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
              AND status = 'active' AND point_lft BETWEEN $6 AND $7 AND user_id <> $8 ORDER BY created_at DESC LIMIT $9`,
          [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, p.lft, p.rgt, me.userId, CANDIDATE_LIMIT],
        );
        add(rows, CANDIDATE_LIMIT);
      }
    }
    const { rows } = await tx.query(
      `SELECT id FROM intents WHERE vertical_id = $1 AND realm = $2 AND side = $3 AND deal_type_id = $4 AND category_id = ANY($5)
          AND status = 'active' AND user_id <> $6 ORDER BY created_at DESC LIMIT $7`,
      [row.vertical_id, me.realm, counterSide, row.deal_type_id, catSet, me.userId, CANDIDATE_LIMIT],
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
