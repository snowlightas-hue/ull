// Schema advisor — reads usage evidence and PROPOSES; it never executes DDL.
//
//   npm run advisor -- [--db app|test|bench | --url URL] [--dry-run] [--out DIR] [--window-days 30] [--min-stats-days 7] [--json]
//
// Evidence (read inside one READ ONLY transaction, see collect.ts):
//   unknown_terms          → lexicon proposals (keywords to add / terms to map)
//   extraction_runs        → lexicon/category proposals (slots Jev keeps deciding, unclear rate, overlapping categories)
//   match_runs             → partition/index/category proposals (candidate cap hit, slow matching, categories without supply)
//   DEFAULT partitions     → partition proposals + DRAFT migration (same move procedure as migrations/0002 §7)
//   pg_constraint/pg_index → missing foreign-key indexes + DRAFT migration
//   pg_stat_user_indexes   → unused indexes + DRAFT migration (only after ≥ --min-stats-days of statistics)
//   pg_stat_statements     → slow statements (evidence for a human; no draft)
//   pg_stat_user_tables    → tables read by repeated full scans (evidence; no draft)
// Output: rows in schema_proposals (deduplicated by dedupe_key; decided proposals are never modified) and DRAFT files in
// migrations/proposed/ (src/db/migrate.ts never reads that directory). --dry-run writes nothing at all.
import { relative } from 'node:path';
import pg from 'pg';
import { ROOT } from '../lib/env.ts';
import { urlFromArgs } from '../db/target.ts';
import { collect } from './collect.ts';
import { buildProposals } from './rules.ts';
import { PROPOSED_DIR, storeProposals, type Stored } from './store.ts';
import { DEFAULT_THRESHOLDS, type Collected, type Thresholds } from './types.ts';

export interface AdvisorOptions {
  url: string; target: string; dir?: string; dryRun?: boolean; windowDays?: number; thresholds?: Partial<Thresholds>;
}
export interface AdvisorResult { collected: Collected; stored: Stored[]; notes: string[]; ms: number }

export async function runAdvisor(o: AdvisorOptions): Promise<AdvisorResult> {
  const t0 = Date.now();
  const pool = new pg.Pool({ connectionString: o.url, max: 2, application_name: 'ultralink-advisor' });
  try {
    const client = await pool.connect();
    let collected: Collected;
    try {
      collected = await collect(client, { target: o.target, windowDays: o.windowDays ?? 30 });
    } finally {
      client.release();
    }
    const { proposals, notes } = buildProposals(collected, { ...DEFAULT_THRESHOLDS, ...o.thresholds });
    const stored = await storeProposals(pool, proposals, { dir: o.dir ?? PROPOSED_DIR, dryRun: o.dryRun });
    return { collected, stored, notes, ms: Date.now() - t0 };
  } finally {
    await pool.end();
  }
}

export function formatReport(r: AdvisorResult, o: { dryRun?: boolean; dir?: string } = {}): string {
  const c = r.collected;
  const by = (k: string) => r.stored.filter((s) => s.outcome === k).length;
  const lines = [
    `advisor — target ${c.target} (database ${c.database}), ${o.dryRun ? 'DRY RUN (nothing written), ' : ''}${r.ms} ms`,
    `evidence: unknown_terms ${c.unknownTerms.length} · extraction_runs ${c.extraction.turns} turns/${c.extraction.windowDays} d · ` +
      `match_runs ${c.matchRuns.byVertical.reduce((a, v) => a + v.runs, 0)} runs/${c.matchRuns.windowDays} d · ` +
      `pg_stat_statements ${c.statements ? `${c.statements.length} statements` : 'n/a'} · indexes ${c.indexes.length} · FKs ${c.foreignKeys.length} · ` +
      `DEFAULT-partition groups ${c.defaultPartitions.filter((d) => d.rows > 0).length} · statistics age ${c.statsAgeHours.toFixed(1)} h`,
    `proposals: ${r.stored.length} (${by('new')} new, ${by('updated')} updated, ${by('unchanged')} unchanged, ${by('decided')} already decided — left as is)`,
  ];
  for (const s of r.stored) {
    lines.push(`  [${s.outcome.padEnd(9)}] ${s.proposal.kind.padEnd(9)} ${s.proposal.title}`);
    lines.push(`              key ${s.proposal.dedupeKey}${s.draftPath ? ` · draft ${s.draftPath}${s.draftWritten ? ' (written)' : ''}` : ''}`);
  }
  if (!r.stored.length) lines.push('  (no finding crossed its threshold)');
  for (const n of r.notes) lines.push(`note: ${n}`);
  lines.push(`drafts directory: ${relative(ROOT, o.dir ?? PROPOSED_DIR) || '.'} (never applied; review → migrations/NNNN_*.sql → npm run db:migrate)`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const { url, target } = urlFromArgs();
  const dryRun = process.argv.includes('--dry-run');
  const dir = arg('out');
  const windowDays = arg('window-days') ? Number(arg('window-days')) : undefined;
  const minStatsDays = arg('min-stats-days');
  runAdvisor({ url, target, dir, dryRun, windowDays, thresholds: minStatsDays !== undefined ? { minStatsDays: Number(minStatsDays) } : {} })
    .then((r) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify({ notes: r.notes, proposals: r.stored.map((s) => ({ outcome: s.outcome, kind: s.proposal.kind, key: s.proposal.dedupeKey, title: s.proposal.title, draft: s.draftPath })) }, null, 2));
      else console.log(formatReport(r, { dryRun, dir }));
    })
    .catch((e) => { console.error(`advisor failed: ${(e as Error).message}`); process.exit(1); });
}
