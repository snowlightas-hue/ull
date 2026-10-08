// Advisor rules: pure functions from collected statistics to proposals. No I/O here (unit-tested in
// test/unit/advisor-rules.test.ts). Every proposal carries its evidence and a stable dedupe key; DDL proposals carry
// a DRAFT (drafts.ts) that a human must review — nothing is ever applied automatically.
import { createFkIndexSql, draftHeader, dropIndexSql, partitionMoveSql } from './drafts.ts';
import {
  DEFAULT_THRESHOLDS, type Collected, type DefaultPartitionRows, type ExtractionStats, type ForeignKeyInfo, type IndexKeyInfo,
  type IndexStat, type MatchRunStats, type Proposal, type StatementStat, type TableScanStat, type Thresholds, type UnknownTermRow,
} from './types.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const day = (iso: string) => iso.slice(0, 10);

function withDraft(p: Proposal, c: Pick<Collected, 'target' | 'database' | 'collectedAt'>, sql: string, risk: string, rollback: string): Proposal {
  const header = draftHeader({
    dedupeKey: p.dedupeKey, kind: p.kind, title: p.title, rationale: p.rationale, evidence: p.evidence, risk, rollback,
    asOf: day(c.collectedAt), target: `${c.target} database ${c.database}`,
  });
  return { ...p, draft: { slug: p.draft?.slug ?? p.dedupeKey, sql: `${header}${sql}` } };
}

// ───────────── vocabulary (unknown_terms) ─────────────
export function lexiconProposals(terms: UnknownTermRow[], t: Thresholds = DEFAULT_THRESHOLDS): Proposal[] {
  const out: Proposal[] = [];
  for (const u of terms) {
    if (u.hits < t.minTermHits) continue;
    const evidence = { hits: u.hits, firstSeen: u.firstSeen, lastSeen: u.lastSeen, categoryId: u.categoryId };
    if (u.categoryCode) {
      out.push({
        kind: 'lexicon', dedupeKey: `lexicon:${u.categoryCode}:${u.term}`,
        title: `Add «${u.term}» to the keywords of ${u.categoryCode}`,
        rationale: `Users said «${u.term}» ${u.hits} times in conversations that ended in ${u.categoryCode}, and the rules parser did not know it. ` +
          'Keywords are reference data (src/seed/taxonomy.ts → categories.keywords), not schema: no migration needed.',
        evidence,
        proposal: { action: 'add_keyword', categoryCode: u.categoryCode, term: u.term, where: 'src/seed/taxonomy.ts CATEGORIES[].keywords, then npm run db:seed' },
      });
    } else {
      out.push({
        kind: 'lexicon', dedupeKey: `lexicon:unmapped:${u.term}`,
        title: `Unmapped term «${u.term}» (${u.hits} hits, no category decided)`,
        rationale: `«${u.term}» appeared ${u.hits} times in turns where no category was decided. A reviewer should map it to a category ` +
          'keyword, a place alias or an attribute value — or mark it as noise (reject).',
        evidence,
        proposal: { action: 'map_or_ignore', term: u.term },
      });
    }
  }
  return out;
}

// ───────────── understanding quality (extraction_runs) ─────────────
export function extractionProposals(x: ExtractionStats, t: Thresholds = DEFAULT_THRESHOLDS): Proposal[] {
  if (x.turns < t.minTurns) return [];
  const out: Proposal[] = [];
  const base = { windowDays: x.windowDays, turns: x.turns };
  for (const [slot, n] of Object.entries(x.jevSlots).sort()) {
    const share = n / x.turns;
    if (share < t.jevSlotShare) continue;
    out.push({
      kind: 'lexicon', dedupeKey: `lexicon:jev-slot:${slot}`,
      title: `Rules rarely decide «${slot}»: Jev decided it in ${pct(share)} of turns`,
      rationale: `In the last ${x.windowDays} days Jev (not the deterministic parser) decided «${slot}» in ${n} of ${x.turns} turns. ` +
        'Each such turn costs a model call and latency; the rules vocabulary for this slot likely misses common phrasings.',
      evidence: { ...base, jevDecided: n, share: Math.round(share * 1000) / 1000 },
      proposal: { action: 'extend_rules', slot, where: 'src/nlu/* vocabulary; measure with scripts/corpus-report.ts' },
    });
  }
  if (x.unclear / x.turns >= t.unclearShare) {
    out.push({
      kind: 'lexicon', dedupeKey: 'lexicon:unclear-rate',
      title: `${pct(x.unclear / x.turns)} of turns were not understood`,
      rationale: `${x.unclear} of ${x.turns} turns in the last ${x.windowDays} days ended as "unclear". Review unknown_terms and the corpus report.`,
      evidence: { ...base, unclear: x.unclear },
      proposal: { action: 'review_unclear_turns' },
    });
  }
  if (x.noCategory / x.turns >= t.unclearShare) {
    out.push({
      kind: 'category', dedupeKey: 'category:no-category-rate',
      title: `${pct(x.noCategory / x.turns)} of turns matched no category`,
      rationale: `${x.noCategory} of ${x.turns} turns had no category candidate at all — a coverage gap in the taxonomy or its keywords.`,
      evidence: { ...base, noCategory: x.noCategory },
      proposal: { action: 'review_taxonomy_coverage', hint: 'unknown_terms with category_id = 0' },
    });
  }
  for (const [pair, n] of Object.entries(x.categoryPairs).sort()) {
    const [a, b] = pair.split('|') as [string, string];
    const denom = Math.min(x.categoryTurns[a] ?? n, x.categoryTurns[b] ?? n);
    if (n < t.minPairTurns || n / Math.max(1, denom) < t.pairShare) continue;
    out.push({
      kind: 'category', dedupeKey: `category:overlap:${a}|${b}`,
      title: `Keywords of ${a} and ${b} overlap (${n} turns matched both)`,
      rationale: `${n} turns produced both ${a} and ${b} as candidates (${pct(n / Math.max(1, denom))} of the turns mentioning the rarer one), ` +
        'so the user is asked to choose or the wrong one is picked. Disambiguate keywords or merge the categories.',
      evidence: { ...base, both: n, turnsA: x.categoryTurns[a] ?? null, turnsB: x.categoryTurns[b] ?? null },
      proposal: { action: 'disambiguate_categories', categories: [a, b] },
    });
  }
  return out;
}

// ───────────── matching (match_runs) ─────────────
export function matchRunProposals(m: MatchRunStats, t: Thresholds = DEFAULT_THRESHOLDS): Proposal[] {
  const out: Proposal[] = [];
  for (const v of m.byVertical) {
    if (v.runs < t.minRuns) continue;
    const share = v.truncated / v.runs;
    if (share >= t.truncatedShare) {
      out.push({
        kind: 'partition', dedupeKey: `partition:dense:${v.verticalCode}`,
        title: `Candidate cap hit in ${pct(share)} of match runs for ${v.verticalCode}`,
        rationale: `${v.truncated} of ${v.runs} runs in the last ${m.windowDays} days returned more candidates than UL_CANDIDATE_LIMIT ` +
          '(results marked truncated). The vertical is dense for its scopes: options are sub-partitioning its intents by region, ' +
          'a narrower default scope, or a higher cap — a design decision, so no draft is generated.',
        evidence: { windowDays: m.windowDays, runs: v.runs, truncated: v.truncated, p95Ms: v.p95Ms },
        proposal: { action: 'review_density', verticalId: v.verticalId, options: ['sub-partition by region', 'narrower default scope', 'raise UL_CANDIDATE_LIMIT'] },
      });
    }
    if (v.p95Ms !== null && v.p95Ms >= t.slowRunP95Ms) {
      out.push({
        kind: 'index', dedupeKey: `index:slow-matching:${v.verticalCode}`,
        title: `Matching p95 ${Math.round(v.p95Ms)} ms in ${v.verticalCode}`,
        rationale: `match_runs.duration_ms p95 is ${Math.round(v.p95Ms)} ms over ${v.runs} runs (max ${v.maxMs} ms). Check the slow-statement ` +
          'proposals and EXPLAIN (ANALYZE, BUFFERS) of the retrieval statements (npm run bench:run writes them).',
        evidence: { windowDays: m.windowDays, runs: v.runs, p95Ms: v.p95Ms, maxMs: v.maxMs },
        proposal: { action: 'investigate', verticalId: v.verticalId },
      });
    }
  }
  for (const c of m.byCategory) {
    if (c.runs < t.minCategoryRuns || c.zeroCandidates / c.runs < t.zeroCandidateShare) continue;
    out.push({
      kind: 'category', dedupeKey: `category:no-supply:${c.categoryCode}`,
      title: `${pct(c.zeroCandidates / c.runs)} of match runs in ${c.categoryCode} found no candidate`,
      rationale: `${c.zeroCandidates} of ${c.runs} runs for active intents in ${c.categoryCode} had zero candidates. Either supply is missing, or ` +
        'counterparts are filed under a sibling category (taxonomy too fine or keywords misleading).',
      evidence: { windowDays: m.windowDays, runs: c.runs, zeroCandidates: c.zeroCandidates },
      proposal: { action: 'review_category', categoryCode: c.categoryCode },
    });
  }
  return out;
}

// ───────────── partitions (rows routed to DEFAULT partitions) ─────────────
export function partitionProposals(rows: DefaultPartitionRows[], c: Pick<Collected, 'target' | 'database' | 'collectedAt'>): Proposal[] {
  const out: Proposal[] = [];
  const intents = rows.filter((r) => r.parent === 'intents' && r.keyColumn === 'vertical_id' && r.rows > 0);
  for (const r of intents) {
    const m = rows.find((x) => x.parent === 'matches' && x.keyColumn === 'vertical_id' && x.key === r.key);
    const matchesDefault = m?.defaultPartition ?? rows.find((x) => x.parent === 'matches')?.defaultPartition ?? 'matches_other';
    const code = r.label ?? `vertical_${r.key}`;
    const p: Proposal = {
      kind: 'partition', dedupeKey: `partition:vertical:${r.key}`,
      title: `Give vertical ${r.key} (${code}) its own intents/matches partitions`,
      rationale: `${r.rows} intents (and ${m?.rows ?? 0} matches) of vertical ${r.key} live in the DEFAULT partitions ${r.defaultPartition}/${matchesDefault}. ` +
        'Matching filters by vertical, so these rows share indexes with every other unpartitioned vertical, and a later CREATE ... PARTITION OF ' +
        'fails while they are there. The draft moves them with their dependants (same procedure as migrations/0002 §7).',
      evidence: { intentsInDefault: r.rows, matchesInDefault: m?.rows ?? 0, defaultPartitions: [r.defaultPartition, matchesDefault] },
      proposal: { action: 'create_partitions', verticalId: Number(r.key), code, partitions: [`intents_${code}`, `matches_${code}`] },
      draft: { slug: `partition_vertical_${r.key}_${code}`, sql: '' },
    };
    out.push(withDraft(p, c,
      partitionMoveSql({ verticalId: Number(r.key), code, intentsDefault: r.defaultPartition, matchesDefault }),
      'Takes ACCESS EXCLUSIVE locks on intents/matches and their DEFAULT partitions for the duration of the copy; the time grows with the ' +
      'rows moved (fine for thousands, plan a maintenance window for millions). Ids, public ids and match/contact history are preserved.',
      'DETACH PARTITION + re-insert into the DEFAULT partition with the same procedure in reverse (keep the copy tables).'));
  }
  for (const r of rows.filter((x) => x.rows > 0 && !(x.keyColumn === 'vertical_id' && (x.parent === 'intents' || x.parent === 'matches')))) {
    out.push({
      kind: 'partition', dedupeKey: `partition:${r.parent}:${r.key}`,
      title: `${r.rows} rows of ${r.parent} with ${r.keyColumn} = ${r.key} sit in the DEFAULT partition`,
      rationale: 'A dedicated partition keeps pruning effective; this table has no generator for a draft yet.',
      evidence: { rows: r.rows, defaultPartition: r.defaultPartition },
      proposal: { action: 'create_partition', table: r.parent, key: r.key },
    });
  }
  return out;
}

// ───────────── indexes ─────────────
export function unusedIndexProposals(idx: IndexStat[], statsAgeHours: number, c: Pick<Collected, 'target' | 'database' | 'collectedAt' | 'statsSince'>, t: Thresholds = DEFAULT_THRESHOLDS): { proposals: Proposal[]; note: string | null } {
  if (statsAgeHours < t.minStatsDays * 24) {
    return { proposals: [], note: `unused-index rule skipped: index statistics cover only ${statsAgeHours.toFixed(1)} h (since ${c.statsSince}); needs ≥ ${t.minStatsDays} d of real traffic` };
  }
  const out: Proposal[] = [];
  for (const i of idx) {
    if (i.scans > 0 || i.unique || i.primary || i.backsConstraint || i.bytes < t.minUnusedIndexBytes) continue;
    const p: Proposal = {
      kind: 'index', dedupeKey: `index:unused:${i.index}`,
      title: `Index ${i.index} on ${i.table} was never used (${(i.bytes / 1048576).toFixed(1)} MB)`,
      rationale: `pg_stat_user_indexes shows 0 scans (summed over partitions) since ${c.statsSince}. An unused index costs write amplification, ` +
        'vacuum work and cache. Confirm no rare job (monthly report, admin tool) needs it before dropping.',
      evidence: { scans: i.scans, bytes: i.bytes, statsSince: c.statsSince, statsAgeHours: Math.round(statsAgeHours), definition: i.definition },
      proposal: { action: 'drop_index', index: i.index, table: i.table },
      draft: { slug: `drop_${i.index}`, sql: '' },
    };
    out.push(withDraft(p, c, dropIndexSql({ index: i.index, definition: i.definition }),
      'Queries that relied on it (not seen in the statistics window) fall back to other plans.',
      'Re-run the CREATE INDEX statement recorded at the end of this file.'));
  }
  return { proposals: out, note: null };
}

/** Is foreign key `fk` served by an index whose leading keys are its (non-partition-key) columns, in any order? */
export function fkCovered(fk: ForeignKeyInfo, indexes: IndexKeyInfo[]): boolean {
  const need = fk.columns.filter((col) => !fk.partitionColumns.includes(col));
  if (!need.length) return true;
  return indexes.some((ix) => {
    if (ix.table !== fk.table) return false;
    if (ix.predicate && !need.some((col) => ix.predicate === `(${col} IS NOT NULL)`)) return false;
    const lead = ix.keyColumns.slice(0, need.length);
    return lead.length === need.length && need.every((col) => lead.includes(col));
  });
}

/**
 * FKs whose referencing side has no usable index. Only where the referenced rows are actually deleted: ON DELETE
 * CASCADE / SET NULL / SET DEFAULT (deletes are designed to propagate) or any recorded delete on the referenced table.
 * NO ACTION FKs to reference data that is never deleted (places, categories, deal types) are reported in a note only.
 */
export function missingFkIndexProposals(fks: ForeignKeyInfo[], indexes: IndexKeyInfo[], c: Pick<Collected, 'target' | 'database' | 'collectedAt'>, notes: string[] = []): Proposal[] {
  const out: Proposal[] = [];
  const skipped: string[] = [];
  for (const fk of fks) {
    if (fkCovered(fk, indexes)) continue;
    if ((fk.onDelete === 'a' || fk.onDelete === 'r') && fk.refDeletes === 0) { skipped.push(`${fk.table}(${fk.columns.join(',')})→${fk.refTable}`); continue; }
    const cols = fk.columns.filter((col) => !fk.partitionColumns.includes(col));
    const { name, sql } = createFkIndexSql({ table: fk.table, columns: cols });
    const p: Proposal = {
      kind: 'index', dedupeKey: `index:fk:${fk.table}:${fk.columns.join(',')}`,
      title: `Index ${fk.table} (${cols.join(', ')}) for foreign key ${fk.constraint}`,
      rationale: `No index on ${fk.table} starts with (${cols.join(', ')}). Every DELETE/UPDATE of a referenced ${fk.refTable} row (ON DELETE ` +
        `CASCADE/SET NULL, or the NO ACTION check) scans ${fk.table} sequentially — per row deleted.`,
      evidence: { constraint: fk.constraint, columns: fk.columns, partitionColumns: fk.partitionColumns, refTable: fk.refTable },
      proposal: { action: 'create_index', table: fk.table, columns: cols, name },
      draft: { slug: `fk_${fk.table}_${cols.join('_')}`, sql: '' },
    };
    out.push(withDraft(p, c, sql, 'Extra index maintenance on writes to the table (small); brief SHARE lock while it builds.', `DROP INDEX ${name};`));
  }
  if (skipped.length) notes.push(`${skipped.length} unindexed NO ACTION foreign key(s) to never-deleted rows not proposed: ${skipped.join(', ')}`);
  return out;
}

const UTILITY = /^\s*(begin|commit|rollback|savepoint|release|set|show|reset|explain|vacuum|analyze|create|alter|drop|do|listen|unlisten|notify|discard|deallocate|copy|lock|truncate|grant|revoke|comment|select\s+pg_(advisory|notify|export_snapshot|sleep)|select\s+nextval|select\s+setval)\b/i;
const CATALOG = /\b(pg_catalog|pg_stat\w*|pg_class|pg_index\w*|pg_constraint|pg_attribute|pg_partition\w*|pg_inherits|pg_namespace|pg_settings|pg_roles|pg_database|pg_extension|pg_get_\w+|information_schema)\b/i;

export function statementProposals(stmts: StatementStat[] | null, t: Thresholds = DEFAULT_THRESHOLDS): Proposal[] {
  if (!stmts) return [];
  const out: Proposal[] = [];
  for (const s of stmts) {
    if (s.calls < t.minStatementCalls || s.meanMs < t.slowStatementMeanMs) continue;
    if (UTILITY.test(s.query) || CATALOG.test(s.query)) continue;
    const q = s.query.replace(/\s+/g, ' ').trim();
    out.push({
      kind: 'index', dedupeKey: `index:statement:${s.queryId}`,
      title: `Slow statement: mean ${s.meanMs.toFixed(1)} ms × ${s.calls} calls — ${q.slice(0, 70)}${q.length > 70 ? '…' : ''}`,
      rationale: `pg_stat_statements: mean ${s.meanMs.toFixed(1)} ms, ${Math.round(s.totalMs)} ms total, ${s.rowsPerCall.toFixed(1)} rows and ` +
        `${Math.round(s.blocksPerCall)} buffers per call. Run EXPLAIN (ANALYZE, BUFFERS) with representative parameters before deciding on an index.`,
      evidence: { queryId: s.queryId, query: q.slice(0, 600), calls: s.calls, meanMs: Math.round(s.meanMs * 100) / 100, totalMs: Math.round(s.totalMs), rowsPerCall: Math.round(s.rowsPerCall * 10) / 10, blocksPerCall: Math.round(s.blocksPerCall) },
      proposal: { action: 'investigate', queryId: s.queryId },
    });
  }
  return out;
}

export function seqScanProposals(tables: TableScanStat[], t: Thresholds = DEFAULT_THRESHOLDS): Proposal[] {
  const out: Proposal[] = [];
  for (const s of tables) {
    if (s.liveRows < t.seqScanMinRows || s.seqScans < t.seqScanMinScans) continue;
    const perScan = s.seqRowsRead / Math.max(1, s.seqScans);
    if (perScan < 0.5 * s.liveRows) continue;
    out.push({
      kind: 'index', dedupeKey: `index:seqscan:${s.table}`,
      title: `${s.table} is read by full scans (${s.seqScans} scans of ~${Math.round(perScan)} rows)`,
      rationale: `pg_stat_user_tables: ${s.seqScans} sequential scans reading ${s.seqRowsRead} rows in total, ${s.liveRows} live rows, ${s.idxScans} index scans. ` +
        'Find the statements (slow-statement proposals, pg_stat_statements) before adding an index.',
      evidence: { ...s },
      proposal: { action: 'investigate', table: s.table },
    });
  }
  return out;
}

/** All rules over one collection; duplicates (same dedupe key) keep the first. */
export function buildProposals(c: Collected, t: Thresholds = DEFAULT_THRESHOLDS): { proposals: Proposal[]; notes: string[] } {
  const notes = [...c.notes];
  const unused = unusedIndexProposals(c.indexes, c.statsAgeHours, c, t);
  if (unused.note) notes.push(unused.note);
  const all = [
    ...partitionProposals(c.defaultPartitions, c),
    ...missingFkIndexProposals(c.foreignKeys, c.indexKeys, c, notes),
    ...unused.proposals,
    ...statementProposals(c.statements, t),
    ...seqScanProposals(c.tableScans, t),
    ...matchRunProposals(c.matchRuns, t),
    ...extractionProposals(c.extraction, t),
    ...lexiconProposals(c.unknownTerms, t),
  ];
  const seen = new Set<string>();
  const proposals = all.filter((p) => (seen.has(p.dedupeKey) ? false : (seen.add(p.dedupeKey), true)));
  for (const p of proposals) p.evidence = { ...p.evidence, collectedAt: c.collectedAt };
  return { proposals, notes };
}
