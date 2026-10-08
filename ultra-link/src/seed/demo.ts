// SYNTHETIC demo data — clearly labeled (users.realm = 'synthetic', handles prefixed, every title ends
// with "(تجريبي)"). Synthetic intents only ever match other synthetic intents. Real users never see them.
import type pg from 'pg';
import { withTx } from '../db/pool.ts';
import type { Registry } from '../domain/registry.ts';
import { createIntent } from '../repo/intents.ts';
import { matchIntent } from '../matching/engine.ts';
import { buildDemoDataset } from './demo-data.ts';

export { PERSONAS, buildDemoDataset, counterpartFor } from './demo-data.ts';
export type { DemoItem, DemoUser } from './demo-data.ts';

async function ensureUser(db: pg.PoolClient | pg.Pool, handle: string, name: string, persona: string | null, phone: string | null): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO users (display_name, handle, realm, persona_ar, contact_phone) VALUES ($1,$2,'synthetic',$3,$4)
     ON CONFLICT (handle) DO UPDATE SET display_name = EXCLUDED.display_name, persona_ar = EXCLUDED.persona_ar RETURNING id`,
    [name, handle, persona, phone],
  );
  return String(rows[0].id);
}

export async function seedDemo(pool: pg.Pool, reg: Registry, log: (s: string) => void = console.log): Promise<void> {
  const exists = await pool.query("SELECT count(*)::int AS n FROM intents WHERE realm = 'synthetic'");
  if (exists.rows[0].n > 0) { log(`synthetic data already present (${exists.rows[0].n} intents) — skipping`); return; }
  const now = Date.now();
  const { users, items } = buildDemoDataset(reg, now);
  const ids = new Map<string, string>();
  for (const u of users) ids.set(u.handle, await ensureUser(pool, u.handle, u.name, u.persona, u.phone));
  const created: { v: number; id: string }[] = [];
  for (const it of items) {
    const res = await withTx(pool, (tx) => createIntent(tx, reg, { userId: ids.get(it.owner)!, realm: 'synthetic', spec: it.spec, titleAr: `${it.title} (تجريبي)`, sourceText: null, conversationId: null, createdAt: new Date(now - it.ageHours * 3600_000) }));
    created.push({ v: res.verticalId, id: res.id });
  }
  log(`created ${created.length} synthetic intents; computing matches among synthetic data…`);
  let n = 0;
  for (const c of created) { await matchIntent(pool, reg, { verticalId: c.v, intentId: c.id, trigger: 'seed' }); n++; }
  log(`matched ${n} intents`);
}

