// Minimal .env loader (no dependency). Values already in process.env win.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let loaded = false;
export function loadEnv(file = join(ROOT, '.env')): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, k, raw] = m;
    if (process.env[k!] === undefined) process.env[k!] = raw!.replace(/^['"]|['"]$/g, '');
  }
}

export function env(name: string, fallback?: string): string {
  loadEnv();
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}
