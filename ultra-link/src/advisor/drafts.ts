// DRAFT migration text for DDL proposals. Pure string building: nothing here touches a database or a file.
// Drafts land in migrations/proposed/ (see store.ts), which src/db/migrate.ts never reads: a human reviews a draft,
// renumbers it into migrations/, tests it, and only then runs `npm run db:migrate`.
import { createHash } from 'node:crypto';
import type { Proposal } from './types.ts';

const RESERVED = new Set(['all', 'and', 'any', 'array', 'as', 'asc', 'both', 'case', 'check', 'column', 'constraint', 'create', 'default',
  'desc', 'distinct', 'do', 'else', 'end', 'false', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'index', 'into', 'is',
  'key', 'limit', 'not', 'null', 'offset', 'on', 'only', 'or', 'order', 'primary', 'references', 'select', 'table', 'then', 'to',
  'true', 'union', 'unique', 'user', 'using', 'when', 'where', 'with']);

/** Quote an SQL identifier unless it is a plain lower-case, non-reserved name. */
export function quoteIdent(name: string): string {
  if (/^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name) && name.length <= 63) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Lower-case ASCII slug for file and object names (Arabic and other text collapses to '_' and a hash keeps it unique). */
export function slugify(s: string, max = 48): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/g, '');
  return out || 'x';
}

export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/** Deterministic draft file name for a proposal: same finding → same file on every run (no duplicates). */
export function draftFileName(p: Pick<Proposal, 'kind' | 'dedupeKey'> & { draft?: { slug: string } }): string {
  return `${p.kind}_${slugify(p.draft?.slug ?? p.dedupeKey)}_${shortHash(p.dedupeKey)}.sql`;
}

/** A Postgres identifier derived from parts, trimmed to 63 bytes with a hash suffix when needed. */
export function objectName(parts: string[], suffix: string): string {
  const base = parts.map((x) => slugify(x, 63)).join('_');
  const full = `${base}_${suffix}`;
  if (full.length <= 63) return full;
  return `${base.slice(0, 63 - suffix.length - 10)}_${shortHash(base)}_${suffix}`;
}

function commentBlock(text: string, width = 112): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + w.length > width) { out.push(`--   ${line}`); line = w; } else line = line ? `${line} ${w}` : w;
    }
    out.push(`--   ${line}`);
  }
  return out;
}

export interface DraftHeader {
  dedupeKey: string; kind: string; title: string; rationale: string; evidence: Record<string, unknown>;
  risk: string; rollback: string; asOf: string; target: string;
}

export function draftHeader(h: DraftHeader): string {
  const ev = Object.entries(h.evidence)
    .filter(([k]) => k !== 'collectedAt')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('; ');
  return [
    '-- DRAFT migration proposed by the schema advisor (src/advisor/run.ts). NOT APPLIED — no tool executes this file.',
    `-- proposal:  ${h.dedupeKey}   (row in schema_proposals; the decision is recorded there)`,
    `-- kind:      ${h.kind} — ${h.title}`,
    '-- why:',
    ...commentBlock(h.rationale),
    `-- evidence (${h.target}, as of ${h.asOf}):`,
    ...commentBlock(ev),
    '-- risk:',
    ...commentBlock(h.risk),
    '-- rollback:',
    ...commentBlock(h.rollback),
    '-- to adopt: 1) review/edit; 2) copy to migrations/NNNN_<name>.sql with the next free number (0003-0006 are reserved',
    '--   for planned features); 3) run node --test test/integration/db-*.test.ts (fresh DB) and apply it to a restored',
    '--   backup (scripts/restore-test.sh --keep-db, then node src/db/migrate.ts against that copy); 4) npm run db:migrate.',
    '',
  ].join('\n');
}

/**
 * Give vertical `verticalId` its own intents/matches partitions, moving rows that already sit in the DEFAULT
 * partitions together with every dependant (same procedure as migrations/0002 §7, which the integration test
 * exercises). Partition names: <parent>_<code>.
 */
export function partitionMoveSql(a: { verticalId: number; code: string; intentsDefault: string; matchesDefault: string }): string {
  const v = Math.trunc(a.verticalId);
  if (!Number.isSafeInteger(v) || v < 0 || v > 32767) throw new Error(`bad vertical id ${a.verticalId}`);
  const code = slugify(a.code, 40);
  const ip = quoteIdent(`intents_${code}`);
  const mp = quoteIdent(`matches_${code}`);
  const idf = quoteIdent(a.intentsDefault);
  const mdf = quoteIdent(a.matchesDefault);
  const t = (s: string) => `ul_mv${v}_${s}`;
  return `SET LOCAL lock_timeout = '10s';

-- copy vertical ${v} rows and their dependants, delete them from the DEFAULT partitions (FK cascades remove the
-- dependants), create the partitions, re-insert everything with the same ids and public ids
CREATE TEMP TABLE ${t('intents')} ON COMMIT DROP AS SELECT * FROM ${idf} WHERE vertical_id = ${v};
CREATE TEMP TABLE ${t('intent_refs')} ON COMMIT DROP AS SELECT * FROM intent_refs WHERE vertical_id = ${v};
CREATE TEMP TABLE ${t('intent_scopes')} ON COMMIT DROP AS SELECT * FROM intent_scopes WHERE vertical_id = ${v};
CREATE TEMP TABLE ${t('match_runs')} ON COMMIT DROP AS SELECT * FROM match_runs WHERE vertical_id = ${v};
CREATE TEMP TABLE ${t('matches')} ON COMMIT DROP AS SELECT * FROM ${mdf} WHERE vertical_id = ${v};
CREATE TEMP TABLE ${t('match_refs')} ON COMMIT DROP AS SELECT * FROM match_refs WHERE vertical_id = ${v};
CREATE TEMP TABLE ${t('contact_requests')} ON COMMIT DROP AS SELECT * FROM contact_requests WHERE vertical_id = ${v};
DELETE FROM ${mdf} WHERE vertical_id = ${v};
DELETE FROM ${idf} WHERE vertical_id = ${v};
CREATE TABLE ${ip} PARTITION OF intents FOR VALUES IN (${v});
CREATE TABLE ${mp} PARTITION OF matches FOR VALUES IN (${v});
INSERT INTO intents SELECT * FROM ${t('intents')};
INSERT INTO intent_refs SELECT * FROM ${t('intent_refs')};
INSERT INTO intent_scopes SELECT * FROM ${t('intent_scopes')};
INSERT INTO match_runs OVERRIDING SYSTEM VALUE SELECT * FROM ${t('match_runs')};
INSERT INTO matches SELECT * FROM ${t('matches')};
INSERT INTO match_refs SELECT * FROM ${t('match_refs')};
INSERT INTO contact_requests OVERRIDING SYSTEM VALUE SELECT * FROM ${t('contact_requests')};
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ${idf} WHERE vertical_id = ${v}) OR EXISTS (SELECT 1 FROM ${mdf} WHERE vertical_id = ${v})
     OR (SELECT count(*) FROM ${ip}) <> (SELECT count(*) FROM ${t('intents')})
     OR (SELECT count(*) FROM ${mp}) <> (SELECT count(*) FROM ${t('matches')}) THEN
    RAISE EXCEPTION 'vertical ${v} move incomplete';
  END IF;
END $$;

-- same autovacuum settings as the other partitions (migrations/0002 §8)
ALTER TABLE ${ip} SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${mp} SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
`;
}

export function createFkIndexSql(a: { table: string; columns: string[] }): { name: string; sql: string } {
  const name = objectName([a.table, ...a.columns], 'idx');
  return {
    name,
    sql: `SET LOCAL lock_timeout = '10s';
-- plain CREATE INDEX: src/db/migrate.ts runs each migration in a transaction, where CONCURRENTLY is not allowed.
-- For a large, busy table build it CONCURRENTLY by hand first (per partition + ATTACH for a partitioned table).
CREATE INDEX ${quoteIdent(name)} ON ${quoteIdent(a.table)} (${a.columns.map(quoteIdent).join(', ')});
`,
  };
}

export function dropIndexSql(a: { index: string; definition: string }): string {
  return `SET LOCAL lock_timeout = '10s';
DROP INDEX ${quoteIdent(a.index)};
-- rollback (recreates it exactly):
-- ${a.definition};
`;
}
