// Builds web-demo/dist/ultra-link.html: one self-contained page (inline CSS + bundled JS) for publishing.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'dist');
mkdirSync(out, { recursive: true });

const res = await build({
  entryPoints: [join(here, 'main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022', 'chrome109', 'safari16'],
  minify: true,
  write: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const js = res.outputFiles[0]!.text.replace(/<\/script/gi, '<\\/script');
// every stylesheet the real app links (app.css + feature sheets), in the same order
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
const sheets = [...indexHtml.matchAll(/<link rel="stylesheet" href="([^"]+\.css)">/g)].map((m) => m[1]!);
const css = sheets.map((href) => readFileSync(join(root, 'public', href), 'utf8')).join('\n');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const app = /<div id="app"[\s\S]*?<\/div>\s*<\/div>/.exec(html)![0];

const page = `<title>ألترا لينك</title>
<style>
:root { color-scheme: dark; }
html, body { background: #060914; }
${css}
.demo-edition-bar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; justify-content: space-between;
  padding: 8px 16px; background: #1b1530; color: #f3e9ff; font: 13px/1.5 system-ui, "Noto Sans Arabic", "Segoe UI", Tahoma, sans-serif;
  border-bottom: 1px solid #3b2f63; direction: rtl; }
.demo-edition-bar span { min-width: 0; flex: 1 1 260px; }
.demo-edition-reset { background: transparent; color: #f3e9ff; border: 1px solid #6b5aa8; border-radius: 999px; padding: 4px 12px; font: inherit; cursor: pointer; }
.demo-edition-reset:focus-visible { outline: 3px solid #ffd84d; outline-offset: 2px; }
</style>
<div dir="rtl" lang="ar">
${app}
</div>
<script type="module">
${js}
</script>
`;
writeFileSync(join(out, 'ultra-link.html'), page);
console.log(`built web-demo/dist/ultra-link.html (${(page.length / 1024).toFixed(0)} KB; js ${(js.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`);
