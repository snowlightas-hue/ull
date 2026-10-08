// npm run db:seed [-- --test] [-- --no-demo] [-- --reset-demo] [-- --reference-only]
// --reference-only: migrate + sync categories/places/attributes (idempotent), no demo data — run on every app start
// --demo-if-new: like a full seed, but the synthetic demo data is added only when none exists yet (Docker start)
import { loadEnv } from '../lib/env.ts';
import { closePools, getPool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { loadRegistry, syncReference } from './reference.ts';
import { seedDemo } from './demo.ts';
import { seedDemoStores } from './stores-demo.ts';

loadEnv();
const test = process.argv.includes('--test');
const pool = getPool(test ? process.env.TEST_DATABASE_URL! : process.env.DATABASE_URL!);
try {
  await migrate(pool);
  await syncReference(pool);
  const reg = await loadRegistry(pool);
  console.log(`reference data synced: ${reg.version}`);
  if (process.argv.includes('--reference-only')) process.exit(0);
  if (process.argv.includes('--reset-demo')) {
    // deletes ONLY synthetic users (cascade: their intents, matches, notifications, conversations); real users untouched
    const before = await pool.query("SELECT count(*)::int AS n FROM users WHERE realm = 'real'");
    const del = await pool.query("DELETE FROM users WHERE realm = 'synthetic'");
    await pool.query("DELETE FROM jobs WHERE status IN ('done','superseded','failed')"); // pending jobs of deleted intents become 'superseded' on their own
    const after = await pool.query("SELECT count(*)::int AS n FROM users WHERE realm = 'real'");
    console.log(`removed ${del.rowCount} synthetic users (real users before=${before.rows[0].n}, after=${after.rows[0].n})`);
  }
  const hasDemo = (await pool.query("SELECT 1 FROM users WHERE realm = 'synthetic' LIMIT 1")).rowCount! > 0;
  if (process.argv.includes('--demo-if-new') && hasDemo) console.log('demo data already present — kept as is');
  else if (!process.argv.includes('--no-demo')) {
    await seedDemo(pool, reg);
    await seedDemoStores(pool, reg); // one synthetic shop with 25 products (idempotent)
  }
} catch (e) {
  console.error((e as Error).stack);
  process.exitCode = 1;
} finally {
  await closePools();
}
