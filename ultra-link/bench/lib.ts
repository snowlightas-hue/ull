// Shared helpers for the benchmark scripts (bench/generate.ts, bench/run.ts).
// Never touches the app database `ultralink`: every URL here is derived for a dedicated bench DB.
import pg from 'pg';
import { loadEnv } from '../src/lib/env.ts';

export const BENCH_DB = 'ultralink_bench';

export function argValue(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

export function argInt(name: string, fallback: number): number {
  const v = argValue(name);
  if (v === undefined) return fallback;
  const n = Number(v.replace(/_/g, ''));
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}

export function dbUrl(name: string): string {
  loadEnv();
  const admin = process.env.DATABASE_ADMIN_URL;
  if (!admin) throw new Error('DATABASE_ADMIN_URL missing (.env)');
  if (name === 'ultralink') throw new Error('refusing to use the app database for benchmarks');
  return admin.replace(/\/[^/]+$/, `/${name}`);
}

export async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  loadEnv();
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function weighted<T>(r: () => number, items: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let x = r() * total;
  for (const [v, w] of items) {
    x -= w;
    if (x < 0) return v;
  }
  return items[items.length - 1]![0];
}

export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const between = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

/** Nearest-rank percentile of an unsorted sample (ms). */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[k]!;
}

export function summarize(xs: number[]): { n: number; p50: number; p95: number; p99: number; max: number; mean: number } {
  const r = (v: number) => Math.round(v * 100) / 100;
  return {
    n: xs.length,
    p50: r(percentile(xs, 50)),
    p95: r(percentile(xs, 95)),
    p99: r(percentile(xs, 99)),
    max: r(Math.max(...xs)),
    mean: r(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)),
  };
}

/**
 * Multi-row INSERT through unnest(): one array parameter per column, so a 10k-row batch is a single
 * statement with ~30 parameters. `cast` lets a column arrive as text and be cast per row (needed for
 * int[] / jsonb / tstzrange values because unnest() flattens nested arrays).
 */
export interface Col { name: string; type: string; cast?: string }
export async function insertRows(db: pg.Pool | pg.PoolClient | pg.Client, table: string, cols: Col[], rows: unknown[][], opts: { overriding?: boolean } = {}): Promise<void> {
  if (!rows.length) return;
  const arrays = cols.map((_, j) => rows.map((row) => row[j] ?? null));
  const aliases = cols.map((_, j) => `c${j}`);
  const sql = `INSERT INTO ${table} (${cols.map((c) => c.name).join(', ')}) ${opts.overriding ? 'OVERRIDING SYSTEM VALUE ' : ''}
    SELECT ${cols.map((c, j) => (c.cast ? `${aliases[j]}::${c.cast}` : aliases[j])).join(', ')}
      FROM unnest(${cols.map((c, j) => `$${j + 1}::${c.type}[]`).join(', ')}) AS t(${aliases.join(', ')})`;
  await db.query(sql, arrays);
}

export function fmtMs(n: number): string {
  return Number.isFinite(n) ? n.toFixed(n < 10 ? 2 : 1) : '-';
}

export function fmtBytes(n: number): string {
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
