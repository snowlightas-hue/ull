// The real entry point (src/server/main.ts) as a child process on an isolated database:
// pidfile ownership, graceful SIGTERM drain (SSE streams told to reconnect, exit 0, pidfile removed),
// and a clear message instead of a crash when the port is taken.
import './server-env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, type TestDb } from '../helpers/testdb.ts';
import { dropDb, freePort, sleep } from './server-helpers.ts';
import { ROOT } from '../../src/lib/env.ts';

let db: TestDb;
let dir: string;

before(async () => {
  db = await freshDb('srv_lifecycle');
  dir = mkdtempSync(join(tmpdir(), 'ul-lifecycle-'));
});
after(async () => {
  await db?.close();
  if (db) await dropDb(db.name);
  rmSync(dir, { recursive: true, force: true });
});

interface Proc { child: ChildProcess; out: () => string; exited: Promise<number | null> }

function startServer(port: number, pidfile: string): Proc {
  const child = spawn(process.execPath, ['src/server/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, UL_DATABASE_URL: db.url, PORT: String(port), HOST: '127.0.0.1', UL_PIDFILE: pidfile, JEV_MODE: 'off', UL_LOG_LEVEL: 'warn', UL_SHUTDOWN_TIMEOUT_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (c) => { out += c; });
  child.stderr!.on('data', (c) => { out += c; });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out: () => out, exited };
}

async function until(cond: () => boolean, ms: number, what: string, p?: Proc): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}${p ? `\n--- output ---\n${p.out()}` : ''}`);
    await sleep(20);
  }
}

test('main.ts: pidfile, graceful SIGTERM drain with an open SSE stream, exit 0', async () => {
  const port = await freePort();
  const pidfile = join(dir, 'server.pid');
  const p = startServer(port, pidfile);
  try {
    await until(() => p.out().includes('listening on'), 15_000, 'listening', p);
    assert.equal(readFileSync(pidfile, 'utf8').trim(), String(p.child.pid), 'the process writes its own pid');
    const base = `http://127.0.0.1:${port}`;
    const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'دورة حياة' }) });
    assert.equal(reg.status, 200);
    const cookie = /ul_session=[^;]+/.exec(reg.headers.get('set-cookie') ?? '')![0];
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.db, true);
    assert.equal(health.events.connected, true, 'LISTEN up in the real server');
    // an open SSE stream must not keep the process alive
    let sse = ''; let sseEnded = false;
    await new Promise<void>((resolve, reject) => {
      const req = request(`${base}/api/events`, { headers: { cookie } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.setEncoding('utf8');
        res.on('data', (c) => { sse += c; });
        res.on('close', () => { sseEnded = true; });
        resolve();
      });
      req.on('error', (e) => { if (!sseEnded) reject(e); });
      req.end();
    });
    await until(() => sse.includes('event: counts'), 3000, 'stream ready', p);
    const t0 = Date.now();
    p.child.kill('SIGTERM');
    const code = await p.exited;
    const took = Date.now() - t0;
    assert.equal(code, 0, p.out());
    assert.ok(took < 4000, `drained in ${took} ms`);
    await until(() => sseEnded, 2000, 'stream closed');
    assert.ok(sse.includes('event: shutdown'), 'the browser is told to reconnect');
    assert.match(p.out(), /SIGTERM → draining/);
    assert.match(p.out(), /stopped cleanly/);
    assert.equal(existsSync(pidfile), false, 'pidfile removed on exit');
    await assert.rejects(fetch(`${base}/api/health`), 'no longer listening');
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'ul-events-listener'");
    assert.equal(rows[0].n, 0, 'LISTEN connection closed');
  } finally {
    if (p.child.exitCode === null) p.child.kill('SIGKILL');
  }
});

test('main.ts: a taken port is a one-line error naming the port, exit 1, pidfile cleaned up', async () => {
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
  const port = (blocker.address() as { port: number }).port;
  const pidfile = join(dir, 'busy.pid');
  const p = startServer(port, pidfile);
  try {
    const code = await Promise.race([p.exited, sleep(15_000).then(() => 'timeout' as const)]);
    assert.equal(code, 1, p.out());
    assert.match(p.out(), new RegExp(`port ${port} on 127\\.0\\.0\\.1 is already in use`));
    assert.doesNotMatch(p.out(), /at .*\.ts:\d+/, 'no stack trace for an expected condition');
    assert.equal(existsSync(pidfile), false);
  } finally {
    if (p.child.exitCode === null) p.child.kill('SIGKILL');
    blocker.close();
  }
});
