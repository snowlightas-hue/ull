// Connectivity probe for Jev: `node src/ai/probe.ts`
//
// Loads .env (parsed by hand; values are never printed), calls GET /v1/models and one tiny System One
// noul question against the configured base URL, and prints a sanitized, honest report.
// It changes nothing (no files, no DB). Exit code: 0 = both calls succeeded, 2 = failure, 3 = not configured.
//
// When HTTPS_PROXY is set, Node's fetch only uses it with NODE_USE_ENV_PROXY=1, so the probe re-runs
// itself once with that variable (it never bypasses or disables the proxy or TLS verification).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJevClient, DEFAULT_BASE_URL, DEFAULT_MODEL, isLoopbackUrl, isOfficialBaseUrl, isWellFormedKey, JevError } from './jev-client.ts';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

/** Minimal .env parser: KEY=VALUE, optional quotes, # comments. Does not override existing env. */
export function loadDotEnv(path: string, env: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

function respawnWithProxyIfNeeded(): void {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!proxy || process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') || process.env.JEV_PROBE_CHILD === '1') return;
  console.log('note: HTTPS_PROXY is set; re-running with NODE_USE_ENV_PROXY=1 so Node fetch uses it.');
  const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', JEV_PROBE_CHILD: '1' },
  });
  process.exit(r.status ?? 2);
}

function describe(e: unknown): string {
  if (e instanceof JevError) {
    return [
      `FAILED kind=${e.kind}`,
      `http_status=${e.status ?? 'none (no HTTP response from the API)'}`,
      `request_id=${e.requestId ?? '-'}`,
      `attempts=${e.attempts}`,
      `message="${e.message}"`,
    ].join(' | ');
  }
  return 'FAILED unexpected error';
}

async function main(): Promise<number> {
  respawnWithProxyIfNeeded();
  const envFile = resolve(projectRoot, '.env');
  const loaded = loadDotEnv(envFile);
  const key = (process.env.TYPESAFE_API_KEY ?? '').trim();
  const baseUrl = (process.env.TYPESAFE_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  const model = (process.env.TYPESAFE_MODEL ?? process.env.TYPESAFE_DEFAULT_MODEL ?? '').trim() || DEFAULT_MODEL;
  const target = isOfficialBaseUrl(baseUrl) ? 'official TypeSafe API' : isLoopbackUrl(baseUrl) ? 'LOCAL MOCK (simulation, not a verification)' : 'custom URL (not the official API)';

  console.log('Jev connectivity probe');
  console.log(`  time:        ${new Date().toISOString()}`);
  console.log(`  .env:        ${existsSync(envFile) ? `found (${loaded.length} vars loaded, values not shown)` : 'not found'}`);
  console.log(`  base URL:    ${new URL(baseUrl).origin} (${target})`);
  console.log(`  model:       ${model}`);
  console.log(`  API key:     ${key ? (isWellFormedKey(key) ? 'configured (redacted)' : 'present but malformed') : 'NOT configured'}`);
  console.log(`  proxy:       ${process.env.HTTPS_PROXY || process.env.https_proxy ? `HTTPS_PROXY set; NODE_USE_ENV_PROXY=${process.env.NODE_USE_ENV_PROXY ?? 'unset'}` : 'none'}`);
  if (!isWellFormedKey(key)) {
    console.log('RESULT: NOT CONFIGURED — set TYPESAFE_API_KEY in .env. The app runs on the local rule parser.');
    return 3;
  }

  const client = createJevClient({ apiKey: key, baseUrl, model, maxRetries: 0, timeoutMs: 8000, budgetMs: 9000 });
  let ok = true;

  console.log('\n[1] GET /v1/models');
  try {
    const r = await client.listModels();
    console.log(`  OK http_status=200 latency_ms=${r.latencyMs} request_id=${r.requestId ?? '-'}`);
    for (const m of r.models.slice(0, 10)) console.log(`  model: ${m.name} (released ${m.releaseDate})`);
  } catch (e) {
    ok = false;
    console.log(`  ${describe(e)}`);
  }

  console.log('\n[2] POST /v1/systemone (one noul question, no user data)');
  const t0 = Date.now();
  try {
    const r = await client.systemOne('Ultra Link connectivity probe. This text is a test message.', {
      probe: { type: 'noul', instructions: 'Is this text a test message?' },
    });
    console.log(`  OK http_status=200 latency_ms=${r.latencyMs} model=${r.model} request_id=${r.requestId ?? '-'}`);
    console.log(`  answer: noul(p_yes)=${r.answers.probe.noul} usage: input_tokens=${r.usage.inputTokens ?? '?'} output_tokens=${r.usage.outputTokens ?? '?'}`);
  } catch (e) {
    ok = false;
    console.log(`  ${describe(e)} | elapsed_ms=${Date.now() - t0}`);
  }

  console.log('');
  if (ok && isOfficialBaseUrl(baseUrl)) console.log('RESULT: VERIFIED — the real Jev API answered both calls.');
  else if (ok) console.log(`RESULT: OK against ${target} — this is NOT a verification of the real Jev API.`);
  else console.log('RESULT: NOT VERIFIED — Jev is unreachable from here; Ultra Link falls back to the local rule parser.');
  return ok ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => {
      console.log('RESULT: probe crashed (details suppressed to avoid leaking configuration).');
      process.exit(2);
    },
  );
}
