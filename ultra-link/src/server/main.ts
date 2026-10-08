// Ultra Link HTTP server entry point.
// Graceful shutdown on SIGTERM/SIGINT: health turns 503 (draining) → stop accepting connections → SSE
// streams closed → in-flight requests drained (bounded by UL_SHUTDOWN_TIMEOUT_MS) → LISTEN + pool closed.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv } from '../lib/env.ts';
import { closePools, getPool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { loadRegistry } from '../seed/reference.ts';
import { getJev } from '../ai/index.ts';
import { buildApp } from './app.ts';
import { safeErr } from './ops.ts';

loadEnv();
const pidfile = process.env.UL_PIDFILE;
if (pidfile) {
  writeFileSync(pidfile, String(process.pid));
  process.on('exit', () => { try { if (readFileSync(pidfile, 'utf8').trim() === String(process.pid)) rmSync(pidfile); } catch { /* already gone */ } });
}
const url = process.env.UL_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) { console.error('[ultra-link] DATABASE_URL is not set (run: bash scripts/db.sh start)'); process.exit(1); }
const pool = getPool(url);
await migrate(pool, (s) => console.log('[migrate]', s));
const reg = await loadRegistry(pool);
const jev = getJev();
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const app = await buildApp({ pool, reg, databaseUrl: url, version });
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';
try {
  await app.listen({ port, host });
} catch (e) {
  const code = (e as { code?: string }).code;
  console.error(code === 'EADDRINUSE' ? `[ultra-link] port ${port} on ${host} is already in use (another server is running?)` : `[ultra-link] listen failed: ${safeErr(e).message}`);
  await app.close().catch(() => {});
  await closePools().catch(() => {});
  process.exit(1);
}
console.log(`[ultra-link] listening on http://${host}:${port}  registry=${reg.version}  jev=${jev.setting}${jev.client ? '' : ' (no client)'}`);

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) { console.log(`[ultra-link] ${sig} again → forcing exit`); process.exit(1); }
  stopping = true;
  const timeoutMs = Number(process.env.UL_SHUTDOWN_TIMEOUT_MS ?? 10_000);
  console.log(`[ultra-link] ${sig} → draining (up to ${timeoutMs} ms)`);
  app.ul.draining = true;
  const force = setTimeout(() => { console.error('[ultra-link] drain timed out → exit 1'); process.exit(1); }, timeoutMs);
  force.unref();
  const t0 = Date.now();
  try {
    await app.close(); // 503 for new requests, SSE ended (preClose), waits for in-flight requests, LISTEN closed (onClose)
    await closePools();
    console.log(`[ultra-link] stopped cleanly in ${Date.now() - t0} ms`);
    process.exit(0);
  } catch (e) {
    console.error('[ultra-link] shutdown error', safeErr(e));
    process.exit(1);
  }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => { app.log.error({ err: safeErr(e) }, 'unhandled rejection'); });
process.on('uncaughtException', (e) => { app.log.fatal({ err: safeErr(e) }, 'uncaught exception'); void shutdown('uncaughtException'); });
