// Server-sent events hub: one LISTEN connection (channel ul_events) fans out per-user events to open
// streams. The LISTEN client reconnects with exponential backoff if the database connection drops, and
// re-syncs every open stream (fresh counts) after a reconnect because events may have been missed.
// Streams send a heartbeat comment, are capped per user, and are closed on shutdown.
import type { ServerResponse } from 'node:http';
import pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { counts } from '../repo/users.ts';

export interface EventHubOptions {
  pool: pg.Pool;
  databaseUrl: string;
  log: FastifyBaseLogger;
  /** open a LISTEN connection (false in tests that do not need live events) */
  listen: boolean;
  maxPerUser: number;
  heartbeatMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
}

interface Stream { res: ServerResponse; userId: string; hb: NodeJS.Timeout; openedAt: number }

export class EventHub {
  private readonly o: EventHubOptions;
  private readonly streams = new Map<string, Set<Stream>>();
  private client: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closing = false;
  readonly stats = { connected: false, reconnects: 0, connectFailures: 0, lastError: null as string | null, delivered: 0, rejected: 0, opened: 0 };

  constructor(o: EventHubOptions) { this.o = o; }

  /** First connection attempt; failures are logged and retried in the background (the API keeps serving). */
  async start(): Promise<void> {
    if (!this.o.listen) return;
    try { await this.connect(); } catch (e) { this.fail(e); this.schedule(); }
  }

  private async connect(): Promise<void> {
    const c = new pg.Client({ connectionString: this.o.databaseUrl, application_name: 'ul-events-listener', keepAlive: true });
    c.on('error', (e) => this.dropped(c, e));
    c.on('end', () => this.dropped(c, null));
    c.on('notification', (n) => { void this.onNotification(n.payload); });
    try {
      await c.connect();
      await c.query('LISTEN ul_events');
    } catch (e) {
      c.removeAllListeners('end');
      c.on('error', () => {});
      await c.end().catch(() => {});
      throw e;
    }
    if (this.closing) { await c.end().catch(() => {}); return; }
    const wasReconnect = this.stats.connectFailures > 0 || this.stats.reconnects > 0 || this.attempt > 0;
    this.client = c;
    this.attempt = 0;
    this.stats.connected = true;
    if (wasReconnect) {
      this.stats.reconnects++;
      this.o.log.info({ reconnects: this.stats.reconnects }, 'events listener reconnected');
      await this.resyncAll();
    }
  }

  private fail(e: unknown): void {
    this.stats.connectFailures++;
    this.stats.lastError = String((e as Error)?.message ?? e).slice(0, 160);
    this.o.log.warn({ err: { code: (e as { code?: string })?.code, message: this.stats.lastError } }, 'events listener connect failed');
  }

  private dropped(c: pg.Client, e: Error | null): void {
    if (c !== this.client) return;
    this.client = null;
    this.stats.connected = false;
    if (e) this.stats.lastError = String(e.message).slice(0, 160);
    c.removeAllListeners('end');
    c.on('error', () => {});
    c.end().catch(() => {});
    if (this.closing) return;
    this.o.log.warn({ err: { code: (e as { code?: string } | null)?.code, message: this.stats.lastError } }, 'events listener lost its connection — reconnecting');
    this.schedule();
  }

  private schedule(): void {
    if (this.closing || this.timer) return;
    const base = Math.min(this.o.reconnectMaxMs, this.o.reconnectMinMs * 2 ** this.attempt);
    const delay = Math.round(base / 2 + Math.random() * (base / 2)); // jitter in [base/2, base]
    this.attempt++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect().catch((e) => { this.fail(e); this.schedule(); });
    }, delay);
    this.timer.unref();
  }

  private async onNotification(payload: string | undefined): Promise<void> {
    let ev: { userId?: string | number; type?: string };
    try { ev = JSON.parse(payload ?? '{}'); } catch { return; }
    const userId = ev.userId === undefined ? '' : String(ev.userId);
    const set = this.streams.get(userId);
    if (!set?.size) return;
    const type = typeof ev.type === 'string' && /^[a-z_]{1,32}$/.test(ev.type) ? ev.type : 'counts';
    try {
      const c = await counts(this.o.pool, userId);
      for (const s of set) {
        this.write(s, `event: ${type}\ndata: ${JSON.stringify(c)}\n\n`);
        if (type !== 'counts') this.write(s, `event: counts\ndata: ${JSON.stringify(c)}\n\n`);
        this.stats.delivered++;
      }
    } catch (e) {
      this.o.log.warn({ err: { code: (e as { code?: string }).code } }, 'events fan-out failed');
    }
  }

  private async resyncAll(): Promise<void> {
    for (const [userId, set] of this.streams) {
      try {
        const c = await counts(this.o.pool, userId);
        for (const s of set) this.write(s, `event: counts\ndata: ${JSON.stringify(c)}\n\n`);
      } catch { /* next notification will catch up */ }
    }
  }

  private write(s: Stream, chunk: string): void {
    if (s.res.destroyed || s.res.writableEnded) { this.remove(s); return; }
    try { s.res.write(chunk); } catch { this.remove(s); }
  }

  private remove(s: Stream): void {
    clearInterval(s.hb);
    const set = this.streams.get(s.userId);
    if (!set) return;
    set.delete(s);
    if (!set.size) this.streams.delete(s.userId);
  }

  /** Open count for a user after dropping streams whose sockets are already gone. */
  openFor(userId: string): number {
    const set = this.streams.get(userId);
    if (!set) return 0;
    for (const s of set) if (s.res.destroyed || s.res.writableEnded) this.remove(s);
    return this.streams.get(userId)?.size ?? 0;
  }

  /** Can this user open one more stream? (counts a rejection when not) */
  admit(userId: string): boolean {
    if (this.closing) return false;
    if (this.openFor(userId) < this.o.maxPerUser) return true;
    this.stats.rejected++;
    return false;
  }

  /** Attach an already-hijacked response (headers not yet written). */
  async attach(res: ServerResponse, userId: string, onClose: (cb: () => void) => void): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    const s: Stream = { res, userId, openedAt: Date.now(), hb: setInterval(() => this.write(s, ': ping\n\n'), this.o.heartbeatMs) };
    s.hb.unref();
    const set = this.streams.get(userId) ?? new Set<Stream>();
    set.add(s);
    this.streams.set(userId, set);
    this.stats.opened++;
    onClose(() => this.remove(s));
    try {
      this.write(s, `event: counts\ndata: ${JSON.stringify(await counts(this.o.pool, userId))}\n\n`);
    } catch { /* counts will follow with the next event */ }
  }

  get open(): { users: number; connections: number } {
    let connections = 0;
    for (const set of this.streams.values()) connections += set.size;
    return { users: this.streams.size, connections };
  }

  /** Tests/ops: the backend pid of the LISTEN connection (null when disconnected). */
  get listenerPid(): number | null {
    return (this.client as unknown as { processID?: number } | null)?.processID ?? null;
  }

  /** Shutdown step 1 (preClose): end every stream so the HTTP server can close. */
  endStreams(): void {
    this.closing = true;
    for (const set of this.streams.values()) {
      for (const s of set) {
        clearInterval(s.hb);
        try { s.res.write('event: shutdown\ndata: {}\n\n'); s.res.end(); } catch { /* socket gone */ }
      }
    }
    this.streams.clear();
  }

  /** Shutdown step 2 (onClose): stop reconnecting and close the LISTEN connection. */
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.client;
    this.client = null;
    this.stats.connected = false;
    if (c) { c.removeAllListeners('end'); c.on('error', () => {}); await c.end().catch(() => {}); }
  }
}
