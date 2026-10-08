// Shapes shared by the advisor's collectors (SQL, read-only), rules (pure) and store (schema_proposals + drafts).

export type ProposalKind = 'category' | 'attribute' | 'lexicon' | 'index' | 'partition' | 'migration';

export interface Proposal {
  kind: ProposalKind;
  /** Stable identity: the same finding on a later run updates the same schema_proposals row (UNIQUE dedupe_key). */
  dedupeKey: string;
  title: string;
  rationale: string;
  evidence: Record<string, unknown>;
  /** What a human would change (data or DDL), machine-readable. */
  proposal: Record<string, unknown>;
  /** DRAFT migration SQL for DDL proposals; written to migrations/proposed/, never executed. */
  draft?: { slug: string; sql: string };
}

export interface UnknownTermRow { term: string; categoryId: number; categoryCode: string | null; hits: number; firstSeen: string; lastSeen: string }

export interface ExtractionStats {
  windowDays: number;
  turns: number;
  unclear: number;
  byEngine: { engine: string; turns: number; p95LatencyMs: number | null }[];
  /** slot → number of turns where Jev (not the rules) decided it */
  jevSlots: Record<string, number>;
  /** turns whose rules parse produced no category at all */
  noCategory: number;
  /** co-occurring categories in one turn ("a|b" sorted) → turns */
  categoryPairs: Record<string, number>;
  /** category → turns that mentioned it */
  categoryTurns: Record<string, number>;
}

export interface MatchRunVerticalStats {
  verticalId: number; verticalCode: string; runs: number; p95Ms: number | null; maxMs: number | null; truncated: number;
}
export interface MatchRunCategoryStats { categoryCode: string; runs: number; zeroCandidates: number }
export interface MatchRunStats { windowDays: number; byVertical: MatchRunVerticalStats[]; byCategory: MatchRunCategoryStats[] }

export interface DefaultPartitionRows { parent: string; defaultPartition: string; keyColumn: string; key: string; rows: number; label: string | null }

export interface IndexStat {
  index: string; table: string; definition: string; unique: boolean; primary: boolean; backsConstraint: boolean;
  partial: boolean; scans: number; bytes: number;
}

export interface ForeignKeyInfo { constraint: string; table: string; refTable: string; columns: string[]; partitionColumns: string[] }
export interface IndexKeyInfo { index: string; table: string; keyColumns: string[]; predicate: string | null }

export interface StatementStat {
  queryId: string; query: string; calls: number; meanMs: number; totalMs: number; rowsPerCall: number; blocksPerCall: number;
}
export interface TableScanStat { table: string; liveRows: number; seqScans: number; seqRowsRead: number; idxScans: number }

export interface Collected {
  target: string;
  database: string;
  collectedAt: string;
  statsSince: string;
  statsAgeHours: number;
  unknownTerms: UnknownTermRow[];
  extraction: ExtractionStats;
  matchRuns: MatchRunStats;
  defaultPartitions: DefaultPartitionRows[];
  indexes: IndexStat[];
  foreignKeys: ForeignKeyInfo[];
  indexKeys: IndexKeyInfo[];
  statements: StatementStat[] | null; // null = pg_stat_statements not available
  tableScans: TableScanStat[];
  notes: string[];
}

export interface Thresholds {
  minTermHits: number;
  minTurns: number;
  jevSlotShare: number;
  unclearShare: number;
  minPairTurns: number;
  pairShare: number;
  minRuns: number;
  slowRunP95Ms: number;
  truncatedShare: number;
  zeroCandidateShare: number;
  minCategoryRuns: number;
  minStatsDays: number;
  minUnusedIndexBytes: number;
  slowStatementMeanMs: number;
  minStatementCalls: number;
  seqScanMinRows: number;
  seqScanMinScans: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minTermHits: 3,
  minTurns: 20,
  jevSlotShare: 0.2,
  unclearShare: 0.25,
  minPairTurns: 5,
  pairShare: 0.1,
  minRuns: 20,
  slowRunP95Ms: 250,
  truncatedShare: 0.05,
  zeroCandidateShare: 0.5,
  minCategoryRuns: 10,
  minStatsDays: 7,
  minUnusedIndexBytes: 1024 * 1024,
  slowStatementMeanMs: 50,
  minStatementCalls: 20,
  seqScanMinRows: 50_000,
  seqScanMinScans: 50,
};
