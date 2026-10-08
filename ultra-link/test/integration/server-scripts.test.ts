// scripts/app.sh as an operator uses it, on a private run/log directory, a random port and an isolated
// database (never the demo's var/run or :8080): start/status/logs/restart/stop, stale pidfiles (a foreign
// process is never signalled), and a port already in use reported with the owning process.
import './server-env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, type TestDb } from '../helpers/testdb.ts';
import { dropDb, freePort } from './server-helpers.ts';
import { ROOT } from '../../src/lib/env.ts';

let db: TestDb;
let dir: string;
let port: number;
let env: NodeJS.ProcessEnv;
const run = (...args: string[]) => {
  const r = spawnSync('bash', [join(ROOT, 'scripts/app.sh'), ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const pidOf = (name: string) => { try { return Number(readFileSync(join(dir, 'run', `${name}.pid`), 'utf8').trim()); } catch { return null; } };
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

before(async () => {
  db = await freshDb('srv_scripts');
  dir = mkdtempSync(join(tmpdir(), 'ul-scripts-'));
  port = await freePort();
  env = { ...process.env, PORT: String(port), UL_RUN_DIR: join(dir, 'run'), UL_LOG_DIR: join(dir, 'log'), UL_DATABASE_URL: db.url, JEV_MODE: 'off', UL_STOP_WAIT_S: '10' };
});
after(async () => {
  for (const n of ['worker', 'server']) { const p = pidOf(n); if (alive(p)) process.kill(p!, 'SIGKILL'); }
  await db?.close();
  if (db) await dropDb(db.name);
  rmSync(dir, { recursive: true, force: true });
});

test('start → status → logs → start again (idempotent) → restart → stop', async () => {
  const s = run('start');
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /server started \(pid \d+/);
  assert.match(s.out, /worker started \(pid \d+/);
  assert.match(s.out, new RegExp(`ready → http://127\\.0\\.0\\.1:${port}`));
  const server = pidOf('server'); const worker = pidOf('worker');
  assert.ok(alive(server) && alive(worker));
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.db, true);
  const st = run('status');
  assert.equal(st.code, 0);
  assert.match(st.out, new RegExp(`server: running \\(pid ${server}\\)`));
  assert.match(st.out, new RegExp(`worker: running \\(pid ${worker}\\)`));
  assert.match(st.out, /"db":true/);
  const again = run('start');
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, new RegExp(`server already running \\(pid ${server}\\)`));
  assert.equal(pidOf('server'), server);
  const logs = run('logs', 'server', '-n', '5');
  assert.equal(logs.code, 0);
  assert.match(logs.out, /listening on/);
  assert.equal(run('logs', 'nonsense').code, 1);
  const rs = run('restart');
  assert.equal(rs.code, 0, rs.out);
  assert.match(rs.out, /server stopped/);
  const server2 = pidOf('server');
  assert.ok(server2 && server2 !== server && alive(server2));
  assert.equal(alive(server), false);
  const stop = run('stop');
  assert.equal(stop.code, 0, stop.out);
  assert.match(stop.out, /worker stopped/);
  assert.match(stop.out, /server stopped/);
  assert.equal(alive(server2), false);
  assert.equal(alive(pidOf('worker')), false);
  assert.equal(existsSync(join(dir, 'run', 'server.pid')), false);
  assert.match(readFileSync(join(dir, 'log', 'server.log'), 'utf8'), /stopped cleanly/, 'graceful drain, not SIGKILL');
  assert.match(run('stop').out, /server not running/);
});

test('stale pidfiles are removed and the foreign process is never signalled', async () => {
  const foreign: ChildProcess = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    writeFileSync(join(dir, 'run', 'server.pid'), String(foreign.pid));
    writeFileSync(join(dir, 'run', 'worker.pid'), '999999');
    const st = run('status');
    assert.match(st.out, /removed stale server pidfile \(pid \d+ is not a server started by app\.sh; left untouched\)/);
    assert.match(st.out, /removed stale worker pidfile/);
    assert.match(st.out, /server: stopped/);
    assert.equal(existsSync(join(dir, 'run', 'server.pid')), false);
    writeFileSync(join(dir, 'run', 'server.pid'), `${foreign.pid}\n`);
    const stop = run('stop');
    assert.equal(stop.code, 0);
    assert.match(stop.out, /server not running/);
    assert.equal(alive(foreign.pid!), true, 'the unrelated process survived stop');
    writeFileSync(join(dir, 'run', 'server.pid'), 'garbage');
    assert.match(run('status').out, /removed stale server pidfile \(pid \? /);
  } finally { foreign.kill('SIGKILL'); }
});

test('port already in use: start refuses and names the process holding it', async () => {
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', () => r()));
  try {
    const s = run('start');
    assert.equal(s.code, 1, s.out);
    assert.match(s.out, new RegExp(`port ${port} is already in use by pid ${process.pid}: \\S*node`));
    assert.equal(pidOf('server'), null);
    assert.equal(pidOf('worker'), null, 'nothing half-started');
    const st = run('status');
    assert.match(st.out, new RegExp(`port ${port} is in use by pid ${process.pid}`));
  } finally { blocker.close(); }
});
