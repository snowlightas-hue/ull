// Shared bits for test/integration/catalog-*.test.ts.
import { dropDb, sleep, type Harness } from './server-helpers.ts';

/**
 * h.close() with a tolerant DROP DATABASE: `WITH (FORCE)` fails with 42501 ("permission denied to terminate process")
 * when a session of another (superuser) role happens to be connected to the throwaway database at that moment —
 * nothing of this test. Retry for up to ~10 s, then leave the uniquely named test DB behind with a warning instead of
 * failing a test that passed (freshDb drops a same-named DB before reuse anyway).
 */
export async function closeTolerant(h: Harness | undefined): Promise<void> {
  if (!h) return;
  try { await h.close(); return; } catch (e) { if ((e as { code?: string }).code !== '42501') throw e; }
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try { await dropDb(h.db.name); return; } catch (e) { if ((e as { code?: string }).code !== '42501') throw e; }
  }
  console.warn(`# warning: could not drop ${h.db.name} (another role is connected); left for the next freshDb`);
}
