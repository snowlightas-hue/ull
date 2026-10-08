// Ultra Link HTTP server entry point.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv } from '../lib/env.ts';
import { closePools, getPool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { loadRegistry } from '../seed/reference.ts';
import { getJev } from '../ai/index.ts';
import { buildApp } from './app.ts';

loadEnv();
if (process.env.UL_PIDFILE) { const { writeFileSync, rmSync } = await import('node:fs'); writeFileSync(process.env.UL_PIDFILE, String(process.pid)); process.on('exit', () => { try { rmSync(process.env.UL_PIDFILE!); } catch {} }); }
const url = process.env.UL_DATABASE_URL ?? process.env.DATABASE_URL!;
const pool = getPool(url);
await migrate(pool, (s) => console.log('[migrate]', s));
const reg = await loadRegistry(pool);
const jev = getJev();
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const app = await buildApp({ pool, reg, databaseUrl: url, version });
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });
console.log(`[ultra-link] listening on http://${host}:${port}  registry=${reg.version}  jev=${jev.setting}${jev.client ? '' : ' (no client)'}`);

const shutdown = async (sig: string) => {
  console.log(`[ultra-link] ${sig} → shutting down`);
  await app.close();
  await closePools();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
