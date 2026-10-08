// Resolve a named database target to a connection URL (CLI tools: advisor, retention).
//   app   → DATABASE_URL (the live app database)
//   test  → TEST_DATABASE_URL
//   bench → the benchmark database `ultralink_bench` on the same server (bench/generate.ts)
import { env, loadEnv } from '../lib/env.ts';

export type DbTarget = 'app' | 'test' | 'bench';

export function databaseUrl(target: string): string {
  loadEnv();
  if (target === 'app') return env('DATABASE_URL');
  if (target === 'test') return env('TEST_DATABASE_URL');
  if (target === 'bench') return env('DATABASE_ADMIN_URL').replace(/\/[^/?]+(\?.*)?$/, '/ultralink_bench$1');
  throw new Error(`unknown database target "${target}" (expected app | test | bench)`);
}

/** `--db <target>` from argv (default app); `--url <url>` wins when given. */
export function urlFromArgs(argv: string[] = process.argv): { url: string; target: string } {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  };
  const url = get('url');
  if (url) return { url, target: 'url' };
  const target = get('db') ?? 'app';
  return { url: databaseUrl(target), target };
}
