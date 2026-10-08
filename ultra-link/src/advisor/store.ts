// Persist proposals: one schema_proposals row per dedupe key (re-runs update evidence of still-open proposals and never
// touch decided ones), and DRAFT files only inside the drafts directory (default migrations/proposed/). The only
// statements issued here are the SELECT and the INSERT … ON CONFLICT below — never DDL.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type pg from 'pg';
import { ROOT } from '../lib/env.ts';
import { draftFileName } from './drafts.ts';
import type { Proposal } from './types.ts';

export const PROPOSED_DIR = join(ROOT, 'migrations', 'proposed');
export const PROPOSED_BY = 'advisor/1 (src/advisor/run.ts)';

export type Outcome = 'new' | 'updated' | 'unchanged' | 'decided';
export interface Stored { proposal: Proposal; outcome: Outcome; status: string; draftPath: string | null; draftWritten: boolean }

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const withoutVolatile = (e: Record<string, unknown>) => { const { collectedAt: _c, ...rest } = e; return rest; };

/** Absolute path of a proposal's draft inside `dir`; throws if the name would escape it. */
export function draftPath(dir: string, p: Proposal): string {
  const name = draftFileName(p);
  if (!/^[a-z0-9_]+\.sql$/.test(name)) throw new Error(`unsafe draft file name ${name}`);
  const full = resolve(dir, name);
  if (dirname(full) !== resolve(dir)) throw new Error('draft path escapes the drafts directory');
  return full;
}

export async function storeProposals(pool: pg.Pool, proposals: Proposal[], opts: { dir?: string; dryRun?: boolean } = {}): Promise<Stored[]> {
  const dir = opts.dir ?? PROPOSED_DIR;
  const keys = proposals.map((p) => p.dedupeKey);
  const existing = new Map<string, { status: string; title: string; rationale: string; evidence: Record<string, unknown>; proposal: unknown; migration_file: string | null; kind: string }>(
    keys.length
      ? (await pool.query('SELECT dedupe_key, kind, status, title, rationale, evidence, proposal, migration_file FROM schema_proposals WHERE dedupe_key = ANY($1)', [keys])).rows.map((r) => [r.dedupe_key, r])
      : [],
  );
  const out: Stored[] = [];
  const client = opts.dryRun ? null : await pool.connect();
  try {
    if (client) await client.query('BEGIN');
    for (const p of proposals) {
      const prev = existing.get(p.dedupeKey);
      if (prev && prev.status !== 'proposed') {
        out.push({ proposal: p, outcome: 'decided', status: prev.status, draftPath: prev.migration_file, draftWritten: false });
        continue;
      }
      const file = p.draft ? draftPath(dir, p) : null;
      const rel = file ? (file.startsWith(ROOT + '/') ? relative(ROOT, file) : file) : null;
      let draftWritten = false;
      if (file && p.draft && !opts.dryRun) {
        const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
        if (cur !== p.draft.sql) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, p.draft.sql);
          draftWritten = true;
        }
      }
      const same = prev && prev.kind === p.kind && prev.title === p.title && prev.rationale === p.rationale && prev.migration_file === rel
        && stable(withoutVolatile(prev.evidence)) === stable(withoutVolatile(p.evidence)) && stable(prev.proposal) === stable(p.proposal);
      const outcome: Outcome = !prev ? 'new' : same ? 'unchanged' : 'updated';
      if (client && outcome !== 'unchanged') {
        await client.query(
          `INSERT INTO schema_proposals (kind, title, rationale, evidence, proposal, migration_file, proposed_by, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (dedupe_key) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title, rationale = EXCLUDED.rationale,
             evidence = EXCLUDED.evidence, proposal = EXCLUDED.proposal, migration_file = EXCLUDED.migration_file
           WHERE schema_proposals.status = 'proposed'`,
          [p.kind, p.title, p.rationale, JSON.stringify(p.evidence), JSON.stringify(p.proposal), rel, PROPOSED_BY, p.dedupeKey],
        );
      }
      out.push({ proposal: p, outcome, status: prev?.status ?? 'proposed', draftPath: rel, draftWritten });
    }
    if (client) await client.query('COMMIT');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client?.release();
  }
  return out;
}
