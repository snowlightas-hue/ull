// Fresh, isolated PostgreSQL database per test file (cloned from ultralink_template).
// Never touches the app database `ultralink`.
import pg from 'pg';
import { loadEnv } from '../../src/lib/env.ts';
import { migrate } from '../../src/db/migrate.ts';
import { loadRegistry, syncReference } from '../../src/seed/reference.ts';
import type { Registry } from '../../src/domain/registry.ts';

export interface TestDb { pool: pg.Pool; url: string; reg: Registry; name: string; close: () => Promise<void> }

export async function freshDb(tag: string): Promise<TestDb> {
  loadEnv();
  const admin = process.env.DATABASE_ADMIN_URL!;
  const name = `ultralink_t_${tag.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`.slice(0, 60);
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await a.query(`CREATE DATABASE ${name} TEMPLATE ultralink_template`);
  await a.end();
  const url = admin.replace(/\/[^/]+$/, `/${name}`);
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  await migrate(pool, () => {});
  await syncReference(pool);
  const reg = await loadRegistry(pool);
  return { pool, url, reg, name, close: async () => { await pool.end(); } };
}

/** Create a user quickly (synthetic or real realm). */
export async function mkUser(pool: pg.Pool, name: string, realm: 'real' | 'synthetic' = 'synthetic'): Promise<string> {
  const { rows } = await pool.query('INSERT INTO users (display_name, realm) VALUES ($1,$2) RETURNING id', [name, realm]);
  return String(rows[0].id);
}
