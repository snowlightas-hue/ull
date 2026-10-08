// In-memory token-bucket rate limiter (single process). Each key holds `capacity` tokens that refill
// continuously over `windowMs`; a request takes one token or is refused with the wait until the next one.
// Memory is bounded: full (idle) buckets are dropped first, then the least recently used.

export interface BucketRule { capacity: number; windowMs: number }
export type TakeResult = { ok: true; remaining: number } | { ok: false; retryAfterMs: number };

export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number; rule: BucketRule }>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: { now?: () => number; maxKeys?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 50_000;
  }

  take(key: string, rule: BucketRule, cost = 1): TakeResult {
    const t = this.now();
    const rate = rule.capacity / rule.windowMs; // tokens per ms
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(rule.capacity, b.tokens + (t - b.at) * rate);
      b.at = t;
      this.buckets.delete(key); // re-insert: Map order doubles as LRU order
    } else {
      b = { tokens: rule.capacity, at: t, rule };
      if (this.buckets.size >= this.maxKeys) this.prune(t);
    }
    this.buckets.set(key, b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens) };
    }
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil((cost - b.tokens) / rate)) };
  }

  get size(): number { return this.buckets.size; }

  /** Drop buckets that have refilled completely (they carry no state), then the oldest if still too many. */
  prune(t = this.now()): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (t - b.at) * (b.rule.capacity / b.rule.windowMs) >= b.rule.capacity) this.buckets.delete(k);
    }
    const excess = this.buckets.size - Math.floor(this.maxKeys * 0.9);
    if (excess > 0) {
      let n = 0;
      for (const k of this.buckets.keys()) { if (n++ >= excess) break; this.buckets.delete(k); }
    }
  }

  clear(): void { this.buckets.clear(); }
}

export interface RateLimitConfig {
  /** POST /api/conversations/:id/turns — per session */
  turns: BucketRule | null;
  /** /api/auth/* — per client IP */
  auth: BucketRule | null;
  /** POST /api/demo/simulate — per session */
  simulate: BucketRule | null;
}

const perMinute = (envName: string, def: number): BucketRule | null => {
  const raw = process.env[envName];
  const n = raw === undefined || raw === '' ? def : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null; // 0 disables the limit
  return { capacity: Math.floor(n), windowMs: 60_000 };
};

/** Defaults: turns 30/min/session, auth 20/min/IP, simulate 10/min/session. Env overrides (0 = off). */
export function rateLimitConfig(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    turns: overrides.turns !== undefined ? overrides.turns : perMinute('UL_RL_TURNS_PER_MIN', 30),
    auth: overrides.auth !== undefined ? overrides.auth : perMinute('UL_RL_AUTH_PER_MIN', 20),
    simulate: overrides.simulate !== undefined ? overrides.simulate : perMinute('UL_RL_SIMULATE_PER_MIN', 10),
  };
}
