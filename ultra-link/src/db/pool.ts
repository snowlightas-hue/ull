// PostgreSQL pool + transaction helper. BIGINT (int8) values are returned as strings (pg default) —
// money and ids are never converted to JS floats.
import pg from 'pg';
import { env } from '../lib/env.ts';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

const pools = new Map<string, pg.Pool>();

export function getPool(url = process.env.UL_DATABASE_URL ?? env('DATABASE_URL')): pg.Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: Number(process.env.UL_DB_POOL_MAX ?? 10), idleTimeoutMillis: 30_000 });
    pool.on('error', (e) => console.error('[db] idle client error', e.message));
    pools.set(url, pool);
  }
  return pool;
}

export async function withTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
