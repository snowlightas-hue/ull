// Jev health gate: conversations only call Jev after a background probe succeeded, so no user turn ever
// waits on an unreachable provider. Probes are non-blocking and rate-limited (5 min when healthy, 2 min when not).
import type { JevClient } from '../ai/index.ts';

const state: { ok: boolean | null; at: number; inflight: boolean } = { ok: null, at: 0, inflight: false };
const TTL_OK = 5 * 60_000;
const TTL_BAD = 2 * 60_000;

export function jevUsable(client: JevClient, now = Date.now()): boolean {
  const ttl = state.ok ? TTL_OK : TTL_BAD;
  if (!state.inflight && now - state.at > ttl) {
    state.inflight = true;
    client.listModels({ timeoutMs: 3000 })
      .then(() => { state.ok = true; })
      .catch(() => { state.ok = false; })
      .finally(() => { state.at = Date.now(); state.inflight = false; });
  }
  return state.ok === true;
}

/** A turn-time failure closes the gate until the next successful probe. */
export function reportJevFailure(): void { state.ok = false; state.at = Date.now(); }

export function _resetJevGate(): void { state.ok = null; state.at = 0; state.inflight = false; }
