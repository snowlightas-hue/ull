// Jev wiring for the server: reads env, builds the client (or not), keeps the status singleton honest.
//
// Env:
//   TYPESAFE_API_KEY   secret key (never logged)
//   TYPESAFE_BASE_URL  default https://api.typesafe.ai
//   TYPESAFE_MODEL     default jev-latest (TYPESAFE_DEFAULT_MODEL, the SDK's name, is accepted too)
//   JEV_MODE           auto (default) | live | simulate | off
//     auto     -> loopback base URL => simulate; key present => live; else rules only
//     live     -> real API with the key (no key => rules only, status says so)
//     simulate -> local mock only (base URL must be loopback); the real key is NEVER sent to it
//     off      -> rules only
//   JEV_LOG=1          sanitized one-line call logs on stderr
// Node's fetch only honours HTTPS_PROXY when started with NODE_USE_ENV_PROXY=1 (or --use-env-proxy).

import { createHash } from 'node:crypto';
import { createJevClient, DEFAULT_BASE_URL, DEFAULT_MODEL, isLoopbackUrl, isWellFormedKey, JevError } from './jev-client.ts';
import type { JevClient, JevClientOptions } from './jev-client.ts';
import { jevStatus } from './status.ts';
import type { JevSetting, JevStatusTracker } from './status.ts';

export { createJevClient, isJevError, JevError } from './jev-client.ts';
export type { JevClient, JevErrorKind, JevQuestions, SystemOneResult } from './jev-client.ts';
export { getJevStatus, jevStatus } from './status.ts';
export type { JevStatus } from './status.ts';
export { defaultJevCache, JevCache, planJevQuestions, resolveWithJev, shouldCallJev } from './resolver.ts';
export type { JevField } from './resolver.ts';

/** Bearer token sent to the local mock in simulate mode (the real key never leaves for a non-official host). */
export const SIM_TOKEN = 'jev-sim-local-token';

export interface JevRuntime {
  client: JevClient | null;
  status: JevStatusTracker;
  setting: JevSetting;
  engine: 'jev' | 'jev-sim' | null;
}

type Env = Record<string, string | undefined>;

let cached: { sig: string; rt: JevRuntime } | null = null;
let proxyWarned = false;

function envSignature(env: Env): string {
  const key = (env.TYPESAFE_API_KEY ?? '').trim();
  return createHash('sha256')
    .update([key, env.TYPESAFE_BASE_URL ?? '', env.TYPESAFE_MODEL ?? '', env.TYPESAFE_DEFAULT_MODEL ?? '', env.JEV_MODE ?? '', env.JEV_LOG ?? ''].join('\u0000'))
    .digest('hex');
}

/**
 * Build (once per env signature) the Jev client + configure the status singleton.
 * `overrides` lets tests inject fetch/timeouts; the status tracker can be swapped too.
 */
export function getJev(env: Env = process.env, overrides: Partial<Omit<JevClientOptions, 'apiKey' | 'baseUrl' | 'model'>> & { status?: JevStatusTracker } = {}): JevRuntime {
  const sig = envSignature(env);
  if (cached && cached.sig === sig && !overrides.fetchImpl && !overrides.status) return cached.rt;
  const status = overrides.status ?? jevStatus;

  const rawKey = (env.TYPESAFE_API_KEY ?? '').trim();
  const keyConfigured = isWellFormedKey(rawKey);
  const baseUrl = (env.TYPESAFE_BASE_URL ?? '').trim() || DEFAULT_BASE_URL;
  const model = (env.TYPESAFE_MODEL ?? env.TYPESAFE_DEFAULT_MODEL ?? '').trim() || DEFAULT_MODEL;
  const modeRaw = (env.JEV_MODE ?? 'auto').trim().toLowerCase();
  const loopback = isLoopbackUrl(baseUrl);

  let setting: JevSetting;
  if (modeRaw === 'off' || modeRaw === 'rules') setting = 'off';
  else if (modeRaw === 'simulate' || modeRaw === 'sim') setting = 'simulate';
  else if (modeRaw === 'live') setting = 'live';
  else setting = loopback ? 'simulate' : keyConfigured ? 'live' : 'off';

  const log = env.JEV_LOG === '1' ? (line: string) => console.warn(line) : undefined;
  const { status: _s, ...clientOverrides } = overrides;
  let client: JevClient | null = null;
  let reason: string | null = null;

  if (setting === 'simulate') {
    if (!loopback) {
      reason = 'simulate mode requires TYPESAFE_BASE_URL to point to the local mock (http://127.0.0.1:<port>)';
    } else {
      client = createJevClient({ ...clientOverrides, apiKey: SIM_TOKEN, baseUrl, model, engine: 'jev-sim', onOutcome: status.onOutcome, log });
    }
  } else if (setting === 'live') {
    if (!keyConfigured) {
      reason = rawKey ? 'no_key: TYPESAFE_API_KEY is malformed' : 'no_key: TYPESAFE_API_KEY is not set';
    } else if (loopback) {
      reason = 'live mode refuses a loopback base URL (use JEV_MODE=simulate for the mock)';
    } else {
      try {
        client = createJevClient({ ...clientOverrides, apiKey: rawKey, baseUrl, model, engine: 'jev', onOutcome: status.onOutcome, log });
      } catch (e) {
        reason = e instanceof JevError ? `${e.kind}: ${e.message}` : 'client could not be created';
      }
      const proxy = env.HTTPS_PROXY || env.https_proxy;
      if (client && proxy && env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy') && !proxyWarned) {
        proxyWarned = true;
        console.warn('[jev] HTTPS_PROXY is set but NODE_USE_ENV_PROXY=1 is not: Node fetch will try a direct connection.');
      }
    }
  }

  status.configure({
    setting,
    keyConfigured,
    clientReady: client !== null,
    baseUrl: client ? client.baseUrl : null,
    model,
    reason,
  });
  const rt: JevRuntime = { client, status, setting, engine: client ? client.engine : null };
  if (!overrides.fetchImpl && !overrides.status) cached = { sig, rt };
  return rt;
}

/** Tests only: forget the memoized runtime. */
export function resetJevRuntime(): void {
  cached = null;
  proxyWarned = false;
}
