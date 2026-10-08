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
  if (!process.argv.includes('--no-demo')) await seedDemo(pool, reg);
} catch (e) {
  console.error((e as Error).stack);
  process.exitCode = 1;
} finally {
  await closePools();
}
