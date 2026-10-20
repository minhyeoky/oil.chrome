// esbuild → dist/ (the unpacked extension). Run: npm run build
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: { background: resolve(root, 'src/background.js'), editor: resolve(root, 'src/editor/main.js') },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  logLevel: 'warning',
});

cpSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
cpSync(resolve(root, 'src/editor.html'), resolve(dist, 'editor.html'));
cpSync(resolve(root, 'src/editor.css'), resolve(dist, 'editor.css'));
if (existsSync(resolve(root, 'icons'))) cpSync(resolve(root, 'icons'), resolve(dist, 'icons'), { recursive: true });
console.log(`built ${dist}`);
