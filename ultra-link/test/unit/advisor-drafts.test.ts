// Draft rendering and the advisor's safety rails: identifiers, stable file names inside the drafts directory,
// DRAFT headers, and the read-only SQL guard used during collection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { draftFileName, draftHeader, movePlan, objectName, partitionMoveSql, quoteIdent, slugify } from '../../src/advisor/drafts.ts';
import { assertReadOnlySql } from '../../src/advisor/collect.ts';
import { PROPOSED_DIR, draftPath } from '../../src/advisor/store.ts';
import { ROOT } from '../../src/lib/env.ts';

test('quoteIdent: plain names stay bare; reserved, mixed-case and odd names are quoted safely', () => {
  assert.equal(quoteIdent('intents_other'), 'intents_other');
  assert.equal(quoteIdent('user'), '"user"');
  assert.equal(quoteIdent('Intents'), '"Intents"');
  assert.equal(quoteIdent('a"; DROP TABLE x; --'), '"a""; DROP TABLE x; --"');
});

test('slugify / objectName: ASCII, bounded, unique via hash; Postgres 63-byte identifier limit respected', () => {
  assert.equal(slugify('index:fk:intent_refs:vertical_id,intent_id'), 'index_fk_intent_refs_vertical_id_intent_id');
  assert.equal(slugify('فزعة'), 'x');
  const long = objectName(['a_very_long_table_name_for_testing', 'first_column_name', 'second_column_name'], 'idx');
  assert.ok(long.length <= 63, long);
  assert.match(long, /_idx$/);
  assert.equal(objectName(['contact_requests', 'requester_id'], 'idx'), 'contact_requests_requester_id_idx');
});

test('draft file names are deterministic per dedupe key, safe, and always inside the drafts directory', () => {
  const p = { kind: 'lexicon' as const, dedupeKey: 'lexicon:unmapped:فزعة' };
  const q = { kind: 'lexicon' as const, dedupeKey: 'lexicon:unmapped:تكسي' };
  assert.equal(draftFileName(p), draftFileName({ ...p }));
  assert.notEqual(draftFileName(p), draftFileName(q), 'Arabic terms that slug to the same text still get distinct files');
  assert.match(draftFileName(p), /^[a-z0-9_]+\.sql$/);
  const full = draftPath(PROPOSED_DIR, { kind: 'index', dedupeKey: '../../etc/passwd', title: '', rationale: '', evidence: {}, proposal: {}, draft: { slug: '../../x', sql: '' } });
  assert.equal(full.startsWith(join(ROOT, 'migrations', 'proposed') + '/'), true, full);
});

test('draft header: marked DRAFT / NOT APPLIED, carries the dedupe key, evidence and adoption steps', () => {
  const h = draftHeader({ dedupeKey: 'index:fk:a:b', kind: 'index', title: 'T', rationale: 'R', evidence: { rows: 5, collectedAt: 'zzz' }, risk: 'K', rollback: 'B', asOf: '2026-10-08', target: 'test database d' });
  assert.match(h, /^-- DRAFT migration .* NOT APPLIED/);
  assert.match(h, /-- proposal: {2}index:fk:a:b/);
  assert.match(h, /rows: 5/);
  assert.doesNotMatch(h, /zzz/, 'volatile collection time is not written into the file');
  assert.match(h, /npm run db:migrate/);
  assert.ok(h.split('\n').every((l) => l === '' || l.startsWith('--')), 'header is comments only');
});

// the FK graph of 0001–0003 plus two hypothetical later tables
const fk = (table: string, columns: string[], refTable: string, refColumns: string[], onDelete = 'c') => ({ constraint: `${table}_fk`, table, refTable, columns, refColumns, onDelete });
const GRAPH = [
  fk('matches', ['vertical_id', 'a_intent_id'], 'intents', ['vertical_id', 'id']),
  fk('intent_refs', ['vertical_id', 'intent_id'], 'intents', ['vertical_id', 'id']),
  fk('intent_scopes', ['vertical_id', 'intent_id'], 'intents', ['vertical_id', 'id']),
  fk('match_runs', ['vertical_id', 'intent_id'], 'intents', ['vertical_id', 'id']),
  fk('live_positions', ['vertical_id', 'intent_id'], 'intents', ['vertical_id', 'id']),
  fk('match_refs', ['vertical_id', 'match_id'], 'matches', ['vertical_id', 'id']),
  fk('contact_requests', ['vertical_id', 'match_id'], 'matches', ['vertical_id', 'id']),
  fk('connections', ['contact_vertical_id', 'contact_match_id', 'requester_id'], 'contact_requests', ['vertical_id', 'match_id', 'requester_id']),
  fk('connections', ['id'], 'connection_owners', ['id'], 'n'),
  fk('connection_messages', ['connection_id'], 'connections', ['id']),
  fk('reviews', ['match_public_id'], 'match_refs', ['public_id'], 'a'),
  fk('intents', ['user_id'], 'users', ['id']),
];

test('movePlan: cascading vertical-keyed dependants travel (parents first); anything else becomes a guard', () => {
  const plan = movePlan(GRAPH);
  assert.deepEqual(plan.dependants.map((d) => `${d.table}:${d.filterColumn ?? `via ${d.via!.refTable}`}`), [
    'contact_requests:vertical_id', 'connections:contact_vertical_id', 'connection_messages:via connections', 'intent_refs:vertical_id', 'intent_scopes:vertical_id',
    'live_positions:vertical_id', 'match_refs:vertical_id', 'match_runs:vertical_id',
  ]);
  assert.deepEqual(plan.guards.map((g) => `${g.table}->${g.refTable}:${g.onDelete}`), ['reviews->match_refs:a']);
});

test('partitionMoveSql: validates the vertical id, moves exactly the planned tables, guards the rest', () => {
  const plan = movePlan(GRAPH);
  assert.throws(() => partitionMoveSql({ verticalId: 1e9, code: 'x', intentsDefault: 'intents_other', matchesDefault: 'matches_other', plan }));
  const sql = partitionMoveSql({ verticalId: 12, code: 'Pets & Animals', intentsDefault: 'intents_other', matchesDefault: 'matches_other', plan });
  assert.match(sql, /CREATE TABLE intents_pets_animals PARTITION OF intents FOR VALUES IN \(12\);/);
  assert.match(sql, /CREATE TEMP TABLE ul_mv12_connections ON COMMIT DROP AS SELECT \* FROM connections WHERE contact_vertical_id = 12;/);
  const inserts = [...sql.matchAll(/^INSERT INTO (\w+) /gm)].map((m) => m[1]);
  assert.deepEqual(inserts, ['intents', 'matches', 'contact_requests', 'connections', 'connection_messages', 'intent_refs', 'intent_scopes', 'live_positions', 'match_refs', 'match_runs']);
  assert.match(sql, /CREATE TEMP TABLE ul_mv12_connection_messages ON COMMIT DROP AS SELECT \* FROM connection_messages WHERE \(connection_id\) IN \(SELECT id FROM ul_mv12_connections\);/);
  assert.ok(sql.indexOf('TEMP TABLE ul_mv12_connections ') < sql.indexOf('TEMP TABLE ul_mv12_connection_messages '), 'parent copied before child');
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM reviews x WHERE \(x\.match_public_id\) IN \(SELECT r\.public_id FROM ul_mv12_match_refs r\)\) THEN/);
  assert.ok(sql.indexOf('FROM reviews x') < sql.indexOf('DELETE FROM matches_other'), 'guards run before anything is deleted');
  const verticals = [...sql.matchAll(/(?:vertical_id|contact_vertical_id) = (\d+)/g)].map((m) => m[1]);
  assert.ok(verticals.length >= 10 && verticals.every((v) => v === '12'));
  assert.doesNotMatch(sql, /^\s*(DROP|TRUNCATE)\b/im, 'no DROP/TRUNCATE statement (only ON COMMIT DROP temp tables)');
});

test('assertReadOnlySql: SELECT/WITH only, single statement, no DDL/DML (keywords inside literals are fine)', () => {
  assert.doesNotThrow(() => assertReadOnlySql('SELECT 1'));
  assert.doesNotThrow(() => assertReadOnlySql("  -- note\n WITH x AS (SELECT 'drop table y' AS s) SELECT * FROM x"));
  assert.doesNotThrow(() => assertReadOnlySql('SELECT updated_at, created_at FROM intents'));
  for (const bad of [
    'CREATE INDEX x ON intents (id)', 'DROP INDEX x', 'ALTER TABLE x ADD COLUMN y int', 'VACUUM intents', 'TRUNCATE jobs',
    'WITH d AS (DELETE FROM jobs RETURNING 1) SELECT * FROM d', 'SELECT 1; DROP TABLE users', 'INSERT INTO t VALUES (1)',
    "SELECT set_config('default_transaction_read_only', 'off', false)", 'DO $$ BEGIN END $$',
  ]) assert.throws(() => assertReadOnlySql(bad), /advisor: refusing/, bad);
});
