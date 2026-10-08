// Advisor rules are pure: statistics in → proposals out. Thresholds, dedupe keys, draft presence and the
// "never propose on too little evidence" behaviour are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProposals, extractionProposals, fkCovered, lexiconProposals, matchRunProposals, missingFkIndexProposals, partitionProposals,
  seqScanProposals, statementProposals, unusedIndexProposals,
} from '../../src/advisor/rules.ts';
import { DEFAULT_THRESHOLDS, type Collected, type ExtractionStats, type IndexStat } from '../../src/advisor/types.ts';

const META = { target: 'test', database: 'ultralink_t_x', collectedAt: '2026-10-08T12:00:00.000Z', statsSince: '2026-09-01T00:00:00.000Z' };
const T = DEFAULT_THRESHOLDS;

const emptyExtraction = (over: Partial<ExtractionStats> = {}): ExtractionStats => ({
  windowDays: 30, turns: 0, unclear: 0, byEngine: [], jevSlots: {}, noCategory: 0, categoryPairs: {}, categoryTurns: {}, ...over,
});
const collected = (over: Partial<Collected> = {}): Collected => ({
  ...META, statsAgeHours: 900, unknownTerms: [], extraction: emptyExtraction(), matchRuns: { windowDays: 30, byVertical: [], byCategory: [] },
  defaultPartitions: [], indexes: [], foreignKeys: [], indexKeys: [], statements: [], tableScans: [], notes: [], ...over,
});

test('lexicon: only terms with enough hits; mapped terms name their category, unmapped ones ask for a decision', () => {
  const ps = lexiconProposals([
    { term: 'كمبيوتر', categoryId: 610, categoryCode: 'goods.electronics', hits: 7, firstSeen: 'a', lastSeen: 'b' },
    { term: 'فزعة', categoryId: 0, categoryCode: null, hits: 3, firstSeen: 'a', lastSeen: 'b' },
    { term: 'نادر', categoryId: 0, categoryCode: null, hits: 2, firstSeen: 'a', lastSeen: 'b' },
  ]);
  assert.deepEqual(ps.map((p) => p.dedupeKey), ['lexicon:goods.electronics:كمبيوتر', 'lexicon:unmapped:فزعة']);
  assert.equal(ps[0]!.proposal.action, 'add_keyword');
  assert.equal(ps[1]!.proposal.action, 'map_or_ignore');
  assert.ok(ps.every((p) => p.kind === 'lexicon' && !p.draft), 'vocabulary is data: no DDL draft');
});

test('extraction: nothing below the minimum number of turns; Jev-decided slots, unclear rate and overlapping categories above it', () => {
  assert.deepEqual(extractionProposals(emptyExtraction({ turns: T.minTurns - 1, unclear: T.minTurns - 1, jevSlots: { deal: 19 } })), []);
  const ps = extractionProposals(emptyExtraction({
    turns: 100, unclear: 30, noCategory: 5, jevSlots: { deal: 25, side: 3 },
    categoryTurns: { 'goods.appliances': 20, 'services.appliance_repair': 40, 'vehicles.car': 50 },
    categoryPairs: { 'goods.appliances|services.appliance_repair': 8, 'goods.appliances|vehicles.car': 2 },
  }));
  assert.deepEqual(ps.map((p) => p.dedupeKey), ['lexicon:jev-slot:deal', 'lexicon:unclear-rate', 'category:overlap:goods.appliances|services.appliance_repair']);
  assert.equal(ps[0]!.evidence.share, 0.25);
});

test('match runs: candidate cap → partition review, slow p95 → index investigation, empty categories → category review', () => {
  const ps = matchRunProposals({
    windowDays: 30,
    byVertical: [
      { verticalId: 2, verticalCode: 'vehicles', runs: 100, p95Ms: 900, maxMs: 2000, truncated: 40 },
      { verticalId: 3, verticalCode: 'services', runs: 100, p95Ms: 20, maxMs: 40, truncated: 1 },
      { verticalId: 4, verticalCode: 'education', runs: 5, p95Ms: 5000, maxMs: 9000, truncated: 5 }, // too few runs
    ],
    byCategory: [{ categoryCode: 'services.moving', runs: 12, zeroCandidates: 10 }, { categoryCode: 'vehicles.car', runs: 50, zeroCandidates: 2 }],
  });
  assert.deepEqual(ps.map((p) => `${p.kind}:${p.dedupeKey}`), [
    'partition:partition:dense:vehicles', 'index:index:slow-matching:vehicles', 'category:category:no-supply:services.moving',
  ]);
  assert.ok(ps.every((p) => !p.draft), 'design decisions get no generated DDL');
});

test('partition: rows of a vertical in the DEFAULT partition → one proposal with a move draft; empty groups → none', () => {
  const ps = partitionProposals([
    { parent: 'intents', defaultPartition: 'intents_other', keyColumn: 'vertical_id', key: '8', rows: 120, label: 'transport' },
    { parent: 'matches', defaultPartition: 'matches_other', keyColumn: 'vertical_id', key: '8', rows: 30, label: 'transport' },
    { parent: 'intents', defaultPartition: 'intents_other', keyColumn: 'vertical_id', key: '9', rows: 0, label: 'x' },
  ], META, [
    { constraint: 'a', table: 'intent_refs', refTable: 'intents', columns: ['vertical_id', 'intent_id'], refColumns: ['vertical_id', 'id'], partitionColumns: [], onDelete: 'c', refDeletes: 0 },
    { constraint: 'b', table: 'contact_requests', refTable: 'matches', columns: ['vertical_id', 'match_id'], refColumns: ['vertical_id', 'id'], partitionColumns: [], onDelete: 'c', refDeletes: 0 },
  ]);
  assert.equal(ps.length, 1);
  const p = ps[0]!;
  assert.equal(p.dedupeKey, 'partition:vertical:8');
  assert.deepEqual(p.evidence, { intentsInDefault: 120, matchesInDefault: 30, defaultPartitions: ['intents_other', 'matches_other'], movedWith: ['contact_requests', 'intent_refs'], guards: [] });
  const sql = p.draft!.sql;
  assert.match(sql, /^-- DRAFT migration proposed by the schema advisor/);
  assert.match(sql, /CREATE TABLE intents_transport PARTITION OF intents FOR VALUES IN \(8\);/);
  assert.match(sql, /CREATE TABLE matches_transport PARTITION OF matches FOR VALUES IN \(8\);/);
  assert.match(sql, /DELETE FROM intents_other WHERE vertical_id = 8;/);
  assert.match(sql, /INSERT INTO contact_requests OVERRIDING SYSTEM VALUE SELECT \* FROM ul_mv8_contact_requests;/);
});

test('unused indexes: never on young statistics; never unique/primary/constraint/used/small indexes', () => {
  const idx = (over: Partial<IndexStat>): IndexStat => ({ index: 'i', table: 't', definition: 'CREATE INDEX i ON public.t USING btree (x)', unique: false, primary: false, backsConstraint: false, partial: false, scans: 0, bytes: 50 * 1048576, ...over });
  const list = [idx({ index: 'unused_big' }), idx({ index: 'used', scans: 3 }), idx({ index: 'uniq', unique: true }), idx({ index: 'pk', primary: true }),
    idx({ index: 'con', backsConstraint: true }), idx({ index: 'tiny', bytes: 8192 })];
  const young = unusedIndexProposals(list, 30, META);
  assert.deepEqual(young.proposals, []);
  assert.match(young.note!, /statistics cover only 30\.0 h/);
  const old = unusedIndexProposals(list, T.minStatsDays * 24 + 1, META);
  assert.deepEqual(old.proposals.map((p) => p.dedupeKey), ['index:unused:unused_big']);
  assert.match(old.proposals[0]!.draft!.sql, /DROP INDEX unused_big;\n-- rollback \(recreates it exactly\):\n-- CREATE INDEX i ON public\.t USING btree \(x\);/);
});

test('fkCovered: leading columns in any order; partition-key columns are implied; partial indexes only with IS NOT NULL', () => {
  const fk = (table: string, columns: string[], partitionColumns: string[] = [], onDelete = 'c', refDeletes = 0) => ({ constraint: 'c', table, refTable: 'r', columns, partitionColumns, onDelete, refDeletes });
  const ix = (table: string, keyColumns: string[], predicate: string | null = null) => ({ index: `${table}_${keyColumns.join('_')}`, table, keyColumns, predicate });
  assert.equal(fkCovered(fk('intent_refs', ['vertical_id', 'intent_id']), [ix('intent_refs', ['intent_id', 'vertical_id'])]), true);
  assert.equal(fkCovered(fk('intent_refs', ['vertical_id', 'intent_id']), [ix('intent_refs', ['public_id']), ix('intent_refs', ['vertical_id', 'user_id', 'intent_id'])]), false);
  assert.equal(fkCovered(fk('matches', ['vertical_id', 'a_intent_id'], ['vertical_id']), [ix('matches', ['a_intent_id', 'state'])]), true);
  assert.equal(fkCovered(fk('intents', ['conversation_id']), [ix('intents', ['conversation_id'], '(conversation_id IS NOT NULL)')]), true);
  assert.equal(fkCovered(fk('intents', ['conversation_id']), [ix('intents', ['conversation_id'], "(status = 'active'::text)")]), false);
  assert.equal(fkCovered(fk('t', ['vertical_id'], ['vertical_id']), []), true);
  const notes: string[] = [];
  const ps = missingFkIndexProposals([
    fk('contact_requests', ['requester_id']),
    fk('intents', ['point_place_id'], ['vertical_id'], 'a', 0),   // NO ACTION to places, never deleted → note only
    fk('intents', ['category_id'], ['vertical_id'], 'a', 4),       // NO ACTION but the referenced table does see deletes → proposed
  ], [ix('contact_requests', ['recipient_id', 'status'])], META, notes);
  assert.deepEqual(ps.map((p) => p.dedupeKey), ['index:fk:contact_requests:requester_id', 'index:fk:intents:category_id']);
  assert.match(notes[0]!, /1 unindexed NO ACTION foreign key\(s\) .*intents\(point_place_id\)→r/);
  assert.match(ps[0]!.draft!.sql, /CREATE INDEX contact_requests_requester_id_idx ON contact_requests \(requester_id\);/);
});

test('statements: slow, frequent application statements only (utility and catalog queries are ignored)', () => {
  const s = (queryId: string, query: string, calls: number, meanMs: number) => ({ queryId, query, calls, meanMs, totalMs: calls * meanMs, rowsPerCall: 1, blocksPerCall: 10 });
  const ps = statementProposals([
    s('1', 'SELECT id FROM intents WHERE vertical_id = $1 ORDER BY created_at DESC LIMIT $2', 500, 120),
    s('2', 'SELECT id FROM intents WHERE id = $1', 500, 0.2),
    s('3', 'SELECT * FROM pg_stat_statements', 500, 200),
    s('4', 'VACUUM ANALYZE intents', 100, 5000),
    s('5', 'SELECT count(*) FROM notifications', 3, 900),
  ]);
  assert.deepEqual(ps.map((p) => p.dedupeKey), ['index:statement:1']);
  assert.equal(statementProposals(null).length, 0);
});

test('seq scans: big tables read in full repeatedly; small or index-served tables are ignored', () => {
  const ps = seqScanProposals([
    { table: 'match_refs', liveRows: 300_000, seqScans: 400, seqRowsRead: 400 * 290_000, idxScans: 10 },
    { table: 'places', liveRows: 200, seqScans: 9000, seqRowsRead: 9000 * 200, idxScans: 0 },
    { table: 'intents (intents_vehicles)', liveRows: 250_000, seqScans: 60, seqRowsRead: 60 * 1000, idxScans: 10_000 },
  ]);
  assert.deepEqual(ps.map((p) => p.dedupeKey), ['index:seqscan:match_refs']);
});

test('buildProposals: one list, deduplicated by key, evidence stamped with the collection time, notes kept', () => {
  const c = collected({
    statsAgeHours: 2,
    notes: ['pg_stat_statements not installed'],
    unknownTerms: [{ term: 'x', categoryId: 0, categoryCode: null, hits: 9, firstSeen: 'a', lastSeen: 'b' }, { term: 'x', categoryId: 0, categoryCode: null, hits: 9, firstSeen: 'a', lastSeen: 'b' }],
    foreignKeys: [{ constraint: 'c', table: 'a', refTable: 'b', columns: ['b_id'], partitionColumns: [], onDelete: 'c', refDeletes: 0 }],
  });
  const { proposals, notes } = buildProposals(c);
  assert.deepEqual(proposals.map((p) => p.dedupeKey), ['index:fk:a:b_id', 'lexicon:unmapped:x']);
  assert.ok(proposals.every((p) => p.evidence.collectedAt === META.collectedAt));
  assert.equal(notes.length, 2);
  assert.match(notes[1]!, /unused-index rule skipped/);
});
