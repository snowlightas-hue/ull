// Forward-only SQL migration runner with checksums.
// - migrations/NNNN_name.sql are applied in order inside a transaction each, recorded in schema_migrations.
// - A changed checksum of an applied file is an error (applied migrations are immutable; add a new one).
// - migrations/proposed/* (written by advisor agents) are NEVER applied automatically: a human reviews,
//   renames into migrations/ and runs `npm run db:migrate`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { ROOT, loadEnv } from '../lib/env.ts';
import { closePools, getPool } from './pool.ts';

const DIR = join(ROOT, 'migrations');

export interface MigrateOptions {
  /** Apply migrations only up to and including this version (e.g. '0001'); used by bench/generate.ts for baselines. */
  upTo?: string;
}

export async function migrate(pool: pg.Pool, log: (s: string) => void = console.log, opts: MigrateOptions = {}): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(), duration_ms integer NOT NULL)`);
  const files = readdirSync(DIR).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied = new Map<string, string>(
    (await pool.query('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
  );
  const done: string[] = [];
  for (const f of files) {
    const version = f.slice(0, 4);
    if (opts.upTo !== undefined && version > opts.upTo) break;
    const sql = readFileSync(join(DIR, f), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prev = applied.get(version);
    if (prev) {
      if (prev !== checksum) throw new Error(`migration ${f} was modified after being applied (checksum mismatch)`);
      continue;
    }
    const client = await pool.connect();
    const t0 = Date.now();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(4242001)'); // one migrator at a time
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4)', [
        version, f, checksum, Date.now() - t0,
      ]);
      await client.query('COMMIT');
      log(`applied ${f} (${Date.now() - t0} ms)`);
      done.push(f);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  if (!done.length) log('schema up to date');
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadEnv();
  const url = process.argv.includes('--test') ? process.env.TEST_DATABASE_URL! : process.env.DATABASE_URL!;
  migrate(getPool(url))
    .then(() => closePools())
    .catch(async (e) => { console.error(e.message); await closePools(); process.exit(1); });
}
