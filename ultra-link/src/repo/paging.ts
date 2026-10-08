// Opaque keyset cursors. Pages report exact totals and the 1-based range they cover.

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  nextCursor: string | null;
  prevCursor: string | null;
  rangeStart: number;
  rangeEnd: number;
}

export function encodeCursor(k: string | number, id: string): string {
  return Buffer.from(JSON.stringify({ k, id })).toString('base64url');
}

export function decodeCursor(c: string | null | undefined): { k: string; id: string } | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if ((typeof v.k === 'string' || typeof v.k === 'number') && typeof v.id === 'string' && /^\d{1,19}$/.test(v.id)) return { k: String(v.k), id: v.id };
  } catch { /* invalid cursor */ }
  return null;
}

export function clampLimit(raw: unknown, def = 20, max = 100): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}
