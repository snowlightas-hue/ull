// Shared harness for test/integration/server-*.test.ts: isolated database + buildApp() + a cookie-keeping
// inject client. Owner: Role 7 (server & ops).
import './server-env.ts';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { freshDb, type TestDb } from '../helpers/testdb.ts';
import { buildApp, type AppDeps } from '../../src/server/app.ts';
import { createIntent } from '../../src/repo/intents.ts';
import { validateSpec } from '../../src/domain/validate.ts';
import type { IntentSpec } from '../../src/domain/types.ts';

export interface Harness { db: TestDb; app: FastifyInstance; close: () => Promise<void> }

export async function harness(tag: string, opts: Partial<AppDeps> = {}): Promise<Harness> {
  const db = await freshDb(`srv_${tag}`);
  const app = await buildApp({ pool: db.pool, reg: db.reg, databaseUrl: db.url, version: 'test', listen: false, logLevel: 'warn', ...opts });
  await app.ready();
  return {
    db, app,
    close: async () => {
      await app.close();
      await db.close();
      await dropDb(db.name);
    },
  };
}

export async function dropDb(name: string): Promise<void> {
  const a = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL! });
  await a.connect();
  try { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.end(); }
}

export interface Res<T = any> { status: number; body: T; headers: LightMyRequestResponse['headers']; raw: string; ms: number }

/** A browser-like client: keeps the session cookie, sends JSON for mutations. */
export class Client {
  cookie = '';
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly ip: string | undefined;
  constructor(h: Harness, ip?: string) { this.app = h.app; this.pool = h.db.pool; this.ip = ip; }

  async call<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const mutation = method !== 'GET';
    const t0 = performance.now();
    const res = await this.app.inject({
      method, url,
      ...(mutation ? { payload: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}) } : {}),
      headers: { ...(mutation ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      ...(this.ip ? { remoteAddress: this.ip } : {}),
    });
    const ms = performance.now() - t0;
    const sc = res.headers['set-cookie'];
    if (sc) {
      const m = /ul_session=([^;]*)/.exec(String(sc));
      if (m) this.cookie = m[1] ? `ul_session=${m[1]}` : '';
    }
    let body: any = null;
    try { body = res.json(); } catch { /* not json */ }
    return { status: res.statusCode, body, headers: res.headers, raw: res.body, ms };
  }
  get<T = any>(url: string, headers?: Record<string, string>) { return this.call<T>('GET', url, undefined, headers); }
  post<T = any>(url: string, payload?: unknown, headers?: Record<string, string>) { return this.call<T>('POST', url, payload, headers); }
  patch<T = any>(url: string, payload?: unknown, headers?: Record<string, string>) { return this.call<T>('PATCH', url, payload, headers); }

  async register(displayName: string): Promise<{ publicId: string; id: string }> {
    const r = await this.post('/api/auth/register', { displayName });
    if (r.status !== 200) throw new Error(`register failed ${r.status} ${r.raw}`);
    const { rows } = await this.pool.query('SELECT id FROM users WHERE public_id = $1', [r.body.user.publicId]);
    return { publicId: r.body.user.publicId, id: String(rows[0].id) };
  }

  async newConversation(): Promise<string> {
    const r = await this.post('/api/conversations');
    if (r.status !== 200) throw new Error(`conversation failed ${r.status} ${r.raw}`);
    return r.body.conversation.id;
  }

  say(convId: string, text: string, clientTurnId: string = randomUUID(), modality: 'text' | 'voice' = 'text') {
    return this.post(`/api/conversations/${convId}/turns`, { text, modality, clientTurnId });
  }

  /** Run a whole dialogue; returns the last TurnResult (expects 200 for every turn). */
  async dialogue(...texts: string[]): Promise<any> {
    const conv = await this.newConversation();
    let last: Res | null = null;
    for (const t of texts) {
      last = await this.say(conv, t);
      if (last.status !== 200) throw new Error(`turn "${t.length} chars" failed ${last.status} ${last.raw}`);
    }
    return last!.body;
  }
}

/** Synthetic persona user that can use demo-login (handle + persona_ar). */
export async function mkPersona(pool: pg.Pool, handle: string, name = `${handle} (تجريبي)`): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO users (display_name, handle, realm, persona_ar) VALUES ($1,$2,'synthetic','شخصية اختبار') RETURNING id`, [name, handle]);
  return String(rows[0].id);
}

export function electricianSpec(h: Harness, side: 'seek' | 'provide' = 'seek'): IntentSpec {
  const bab = h.db.reg.placeByCode.get('sy.aleppo.al_bab')!.id;
  return {
    side, categoryCode: 'services.electrical', deal: 'service',
    place: side === 'seek' ? { pointPlaceId: null, scopePlaceIds: [bab], scopeStrength: 'required' } : { pointPlaceId: bab, scopePlaceIds: [], scopeStrength: 'required' },
    price: null, when: null, attrs: {}, constraints: [],
  };
}

/** Insert intents directly (fast seeding for pagination tests). */
export async function seedIntents(h: Harness, userId: string, realm: 'real' | 'synthetic', n: number, opts: { spec?: IntentSpec; createdAt?: (i: number) => Date } = {}): Promise<string[]> {
  const spec = opts.spec ?? electricianSpec(h);
  const v = validateSpec(h.db.reg, spec);
  if (!v.ok) throw new Error('bad seed spec ' + JSON.stringify(v.issues));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await createIntent(h.db.pool, h.db.reg, { userId, realm, spec: v.spec, titleAr: `طلب اختبار ${i + 1}`, sourceText: null, conversationId: null, createdAt: opts.createdAt?.(i) });
    out.push(c.publicId);
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
