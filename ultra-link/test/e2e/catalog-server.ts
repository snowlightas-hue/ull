// Server entry for test/e2e/catalog.spec.ts: the real app (buildApp) plus the catalog route plugin, with photos in a
// temporary UL_MEDIA_DIR. Needed until the integrator adds the plugin to src/server/routes/index.ts (if it is already
// there, it is replaced by this instance so the media directory stays the test's). Never used for the live demo.
import { loadEnv } from '../../src/lib/env.ts';
import { closePools, getPool } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { loadRegistry } from '../../src/seed/reference.ts';
import { buildApp } from '../../src/server/app.ts';
import { FEATURE_ROUTES } from '../../src/server/routes/index.ts';
import { catalogRoutes } from '../../src/server/routes/catalog.ts';

loadEnv();
const url = process.env.UL_DATABASE_URL;
const port = Number(process.env.PORT);
if (!url || !port || /\/ultralink$/.test(url)) { console.error('catalog-server: needs UL_DATABASE_URL (an isolated test DB) and PORT'); process.exit(2); }
const pool = getPool(url);
await migrate(pool, () => {});
const reg = await loadRegistry(pool);
const app = await buildApp({
  pool, reg, databaseUrl: url, version: 'e2e-catalog', featureRoutes: false,
  routes: [...FEATURE_ROUTES.filter((p) => p.name !== 'catalog'), catalogRoutes({ mediaDir: process.env.UL_MEDIA_DIR })],
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`catalog e2e server on http://127.0.0.1:${port}`);
const stop = async () => { await app.close().catch(() => {}); await closePools().catch(() => {}); process.exit(0); };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
