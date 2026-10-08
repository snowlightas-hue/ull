// Advisor collectors: every statistic is read inside ONE `READ ONLY` transaction that is rolled back at the end, so the
// server itself rejects any write or DDL during collection; each statement additionally passes assertReadOnlySql().
import type pg from 'pg';
import { quoteIdent } from './drafts.ts';
import type {
  Collected, DefaultPartitionRows, ExtractionStats, ForeignKeyInfo, IndexKeyInfo, IndexStat, MatchRunStats, StatementStat,
  TableScanStat, UnknownTermRow,
} from './types.ts';

const FORBIDDEN = /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|comment|reindex|vacuum|cluster|copy|call|do|lock|refresh|security|set_config|pg_terminate_backend|pg_cancel_backend)\b/i;

/** Only single SELECT/WITH statements without data-modifying or DDL keywords may run during collection. */
export function assertReadOnlySql(sql: string): void {
  const s = sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''").trim();
  if (!/^(select|with)\b/i.test(s)) throw new Error(`advisor: refusing non-SELECT statement: ${s.slice(0, 60)}`);
  if (/;\s*\S/.test(s)) throw new Error('advisor: refusing multi-statement SQL');
  const m = FORBIDDEN.exec(s);
  if (m) throw new Error(`advisor: refusing statement containing "${m[1]}"`);
}

type Q = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (v: unknown): string => new Date(v as string).toISOString();

export async function collect(client: pg.PoolClient, opts: { target: string; windowDays: number }): Promise<Collected> {
  const notes: string[] = [];
  const q: Q = async (sql, params = []) => {
    assertReadOnlySql(sql);
    return (await client.query(sql, params)).rows;
  };
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const w = opts.windowDays;
    const [meta] = await q(`SELECT current_database() AS db, now() AS now,
        greatest(coalesce(d.stats_reset, '-infinity'), pg_postmaster_start_time(),
                 coalesce((SELECT min(applied_at) FROM schema_migrations), '-infinity')) AS since
        FROM pg_stat_database d WHERE d.datname = current_database()`);
    const statsAgeHours = (Date.parse(meta.now) - Date.parse(meta.since)) / 3_600_000;

    const unknownTerms: UnknownTermRow[] = (await q(
      `SELECT u.term_norm AS term, u.category_id, c.code AS category_code, u.hits, u.first_seen, u.last_seen
         FROM unknown_terms u LEFT JOIN categories c ON c.id = u.category_id
        ORDER BY u.hits DESC, u.term_norm LIMIT 500`,
    )).map((r) => ({ term: r.term, categoryId: r.category_id, categoryCode: r.category_code, hits: num(r.hits), firstSeen: iso(r.first_seen), lastSeen: iso(r.last_seen) }));

    const extraction = await collectExtraction(q, w);
    const matchRuns = await collectMatchRuns(q, w);
    const defaultPartitions = await collectDefaultPartitions(q);

    const indexes: IndexStat[] = (await q(`
      WITH idx AS (
        SELECT x.indexrelid, ic.relname AS index, t.relname AS tbl, x.indisunique, x.indisprimary, x.indpred IS NOT NULL AS partial,
               EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid) AS backs_constraint,
               pg_get_indexdef(x.indexrelid) AS def
          FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
         WHERE t.relnamespace = 'public'::regnamespace AND NOT ic.relispartition)
      SELECT idx.*,
             (SELECT coalesce(sum(s.idx_scan), 0) FROM pg_partition_tree(idx.indexrelid) p JOIN pg_stat_user_indexes s ON s.indexrelid = p.relid) AS scans,
             (SELECT coalesce(sum(pg_relation_size(p.relid)), 0) FROM pg_partition_tree(idx.indexrelid) p) AS bytes
        FROM idx ORDER BY tbl, index`)).map((r) => ({
      index: r.index, table: r.tbl, definition: r.def, unique: r.indisunique, primary: r.indisprimary, backsConstraint: r.backs_constraint,
      partial: r.partial, scans: num(r.scans), bytes: num(r.bytes),
    }));

    const foreignKeys: ForeignKeyInfo[] = (await q(`
      SELECT k.conname, c.relname AS tbl, rc.relname AS ref_table, k.confdeltype::text AS on_delete,
             (SELECT coalesce(sum(s.n_tup_del), 0) FROM pg_partition_tree(k.confrelid) p JOIN pg_stat_user_tables s ON s.relid = p.relid) AS ref_deletes,
             (SELECT array_agg(a.attname::text ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum) AS cols,
             coalesce((SELECT array_agg(a.attname::text) FROM pg_partitioned_table pt CROSS JOIN LATERAL unnest(pt.partattrs::int2[]) pa(attnum)
                JOIN pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = pa.attnum WHERE pt.partrelid = k.conrelid), '{}') AS part_cols
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class rc ON rc.oid = k.confrelid
       WHERE k.contype = 'f' AND k.conparentid = 0 AND c.relnamespace = 'public'::regnamespace AND NOT c.relispartition
       ORDER BY c.relname, k.conname`)).map((r) => ({
      constraint: r.conname, table: r.tbl, refTable: r.ref_table, columns: r.cols, partitionColumns: r.part_cols, onDelete: r.on_delete, refDeletes: num(r.ref_deletes),
    }));

    const indexKeys: IndexKeyInfo[] = (await q(`
      SELECT ic.relname AS index, t.relname AS tbl, pg_get_expr(x.indpred, x.indrelid) AS predicate,
             coalesce((SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum WHERE k.ord <= x.indnkeyatts), '{}') AS keys
        FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
       WHERE t.relnamespace = 'public'::regnamespace AND NOT t.relispartition`)).map((r) => ({ index: r.index, table: r.tbl, keyColumns: r.keys, predicate: r.predicate }));

    let statements: StatementStat[] | null = null;
    const ext = await q(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`);
    if (!ext.length) notes.push('pg_stat_statements extension not installed in this database — statement rule skipped');
    else {
      await client.query('SAVEPOINT advisor_pgss');
      try {
        statements = (await q(`
          SELECT s.queryid::text AS queryid, s.query, s.calls, s.mean_exec_time, s.total_exec_time, s.rows, s.shared_blks_hit + s.shared_blks_read AS blocks
            FROM pg_stat_statements s
           WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND s.toplevel
           ORDER BY s.total_exec_time DESC LIMIT 300`)).map((r) => ({
          queryId: r.queryid, query: r.query ?? '', calls: num(r.calls), meanMs: num(r.mean_exec_time), totalMs: num(r.total_exec_time),
          rowsPerCall: num(r.rows) / Math.max(1, num(r.calls)), blocksPerCall: num(r.blocks) / Math.max(1, num(r.calls)),
        }));
        await client.query('RELEASE SAVEPOINT advisor_pgss');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT advisor_pgss');
        notes.push(`pg_stat_statements not readable (${(e as Error).message}) — statement rule skipped`);
      }
    }

    const tableScans: TableScanStat[] = (await q(`
      SELECT coalesce(pp.relname, c.relname) AS tbl, c.relname AS leaf, s.n_live_tup, s.seq_scan, s.seq_tup_read, coalesce(s.idx_scan, 0) AS idx_scan
        FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
        LEFT JOIN pg_inherits inh ON inh.inhrelid = c.oid LEFT JOIN pg_class pp ON pp.oid = inh.inhparent
       WHERE s.schemaname = 'public' ORDER BY 1, 2`)).map((r) => ({
      table: r.tbl === r.leaf ? r.tbl : `${r.tbl} (${r.leaf})`, liveRows: num(r.n_live_tup), seqScans: num(r.seq_scan), seqRowsRead: num(r.seq_tup_read), idxScans: num(r.idx_scan),
    }));

    return {
      target: opts.target, database: meta.db, collectedAt: iso(meta.now), statsSince: iso(meta.since), statsAgeHours,
      unknownTerms, extraction, matchRuns, defaultPartitions, indexes, foreignKeys, indexKeys, statements, tableScans, notes,
    };
  } finally {
    await client.query('ROLLBACK'); // nothing to keep: collection never writes
  }
}

async function collectExtraction(q: Q, w: number): Promise<ExtractionStats> {
  const win = `e.created_at > now() - make_interval(days => $1)`;
  const cats = `CASE WHEN jsonb_typeof(e.output->'categories') = 'array' THEN e.output->'categories' ELSE '[]'::jsonb END`;
  const [tot] = await q(`SELECT count(*)::int AS turns, count(*) FILTER (WHERE NOT e.validated)::int AS unclear,
      count(*) FILTER (WHERE jsonb_array_length(${cats}) = 0)::int AS no_category FROM extraction_runs e WHERE ${win}`, [w]);
  const byEngine = (await q(`SELECT e.engine, count(*)::int AS turns, percentile_cont(0.95) WITHIN GROUP (ORDER BY e.latency_ms) AS p95
      FROM extraction_runs e WHERE ${win} GROUP BY 1 ORDER BY 1`, [w])).map((r) => ({ engine: r.engine, turns: r.turns, p95LatencyMs: r.p95 === null ? null : Number(r.p95) }));
  const jevSlots: Record<string, number> = {};
  for (const r of await q(`SELECT s.slot, count(*)::int AS n FROM extraction_runs e
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.output->'appliedJev') = 'array' THEN e.output->'appliedJev' ELSE '[]'::jsonb END) AS s(slot)
      WHERE ${win} GROUP BY 1`, [w])) jevSlots[r.slot] = r.n;
  const categoryTurns: Record<string, number> = {};
  const categoryPairs: Record<string, number> = {};
  const per = `SELECT e.id, d.c FROM extraction_runs e CROSS JOIN LATERAL (SELECT DISTINCT x FROM jsonb_array_elements_text(${cats}) x) d(c) WHERE ${win}`;
  for (const r of await q(`SELECT c, count(*)::int AS n FROM (${per}) t GROUP BY 1`, [w])) categoryTurns[r.c] = r.n;
  for (const r of await q(`WITH t AS (${per}) SELECT a.c AS a, b.c AS b, count(*)::int AS n FROM t a JOIN t b ON a.id = b.id AND a.c < b.c
      GROUP BY 1, 2 HAVING count(*) >= 2 ORDER BY 3 DESC LIMIT 200`, [w])) categoryPairs[`${r.a}|${r.b}`] = r.n;
  return { windowDays: w, turns: tot.turns, unclear: tot.unclear, noCategory: tot.no_category, byEngine, jevSlots, categoryTurns, categoryPairs };
}

async function collectMatchRuns(q: Q, w: number): Promise<MatchRunStats> {
  const byVertical = (await q(`SELECT r.vertical_id, coalesce(v.code, 'vertical_' || r.vertical_id) AS code, count(*)::int AS runs,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms) AS p95, max(r.duration_ms) AS max_ms, count(*) FILTER (WHERE r.truncated)::int AS truncated
      FROM match_runs r LEFT JOIN verticals v ON v.id = r.vertical_id
     WHERE r.created_at > now() - make_interval(days => $1) GROUP BY 1, 2 ORDER BY 1`, [w])).map((r) => ({
    verticalId: r.vertical_id, verticalCode: r.code, runs: r.runs, p95Ms: r.p95 === null ? null : Number(r.p95), maxMs: r.max_ms === null ? null : Number(r.max_ms), truncated: r.truncated,
  }));
  // zero-candidate runs per category, only for intents that are active now (runs of paused/closed intents record zeros)
  const byCategory = (await q(`SELECT c.code, count(*)::int AS runs, count(*) FILTER (WHERE r.candidates = 0)::int AS zero
      FROM match_runs r JOIN intents i ON i.vertical_id = r.vertical_id AND i.id = r.intent_id JOIN categories c ON c.id = i.category_id
     WHERE r.created_at > now() - make_interval(days => $1) AND i.status = 'active' AND r.trigger <> 'status'
     GROUP BY 1 ORDER BY 1`, [w])).map((r) => ({ categoryCode: r.code, runs: r.runs, zeroCandidates: r.zero }));
  return { windowDays: w, byVertical, byCategory };
}

async function collectDefaultPartitions(q: Q): Promise<DefaultPartitionRows[]> {
  const parts = await q(`SELECT p.relname AS parent, d.relname AS default_partition, a.attname AS key_column
      FROM pg_partitioned_table pt JOIN pg_class p ON p.oid = pt.partrelid JOIN pg_class d ON d.oid = pt.partdefid
      JOIN pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = pt.partattrs[0]
     WHERE pt.partdefid <> 0 AND pt.partstrat = 'l' AND pt.partnatts = 1 AND p.relnamespace = 'public'::regnamespace ORDER BY 1`);
  const out: DefaultPartitionRows[] = [];
  for (const p of parts) {
    const label = p.key_column === 'vertical_id' ? `LEFT JOIN verticals v ON v.id = t.${quoteIdent(p.key_column)}` : '';
    const rows = await q(`SELECT t.${quoteIdent(p.key_column)}::text AS key, ${label ? 'min(v.code)' : 'NULL::text'} AS label, count(*)::bigint AS n
        FROM ${quoteIdent(p.default_partition)} t ${label} GROUP BY 1 ORDER BY 1`);
    for (const r of rows) out.push({ parent: p.parent, defaultPartition: p.default_partition, keyColumn: p.key_column, key: r.key, rows: num(r.n), label: r.label });
  }
  return out;
}
