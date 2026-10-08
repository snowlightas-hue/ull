// npm run db:seed [-- --test] [-- --no-demo]
import { loadEnv } from '../lib/env.ts';
import { closePools, getPool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { loadRegistry, syncReference } from './reference.ts';
import { seedDemo } from './demo.ts';

loadEnv();
const test = process.argv.includes('--test');
const pool = getPool(test ? process.env.TEST_DATABASE_URL! : process.env.DATABASE_URL!);
try {
  await migrate(pool);
  await syncReference(pool);
  const reg = await loadRegistry(pool);
  console.log(`reference data synced: ${reg.version}`);
  if (process.argv.includes('--reset-demo')) {
    // deletes ONLY synthetic users (cascade: their intents, matches, notifications, conversations); real users untouched
    const before = await pool.query("SELECT count(*)::int AS n FROM users WHERE realm = 'real'");
    const del = await pool.query("DELETE FROM users WHERE realm = 'synthetic'");
    await pool.query("DELETE FROM jobs WHERE status IN ('done','superseded','failed')"); // pending jobs of deleted intents become 'superseded' on their own
    const after = await pool.query("SELECT count(*)::int AS n FROM users WHERE realm = 'real'");
    console.log(`removed ${del.rowCount} synthetic users (real users before=${before.rows[0].n}, after=${after.rows[0].n})`);
  }
  if (!process.argv.includes('--no-demo')) await seedDemo(pool, reg);
} catch (e) {
  console.error((e as Error).stack);
  process.exitCode = 1;
} finally {
  await closePools();
}
