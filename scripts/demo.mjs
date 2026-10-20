// Headed demo: Playwright's bundled Chromium with the extension, seeded with real pages, editor window open.
// Run: npm run demo        (builds first)   — close the browser (Cmd+Q / the window buttons) to end it.
//
// Safety: a throwaway profile under .tmp/demo-profile (recreated each run); your own Chrome/Brave are never touched.

import { existsSync } from 'node:fs';
import { DIST, launchDemo, seedDemo } from './lib/demo.mjs';

if (!existsSync(`${DIST}/manifest.json`)) { console.error('dist/ is missing — run `npm run build` first'); process.exit(1); }

const { context, call, cleanup } = await launchDemo({
  name: 'demo-profile',
  headless: false,
  args: ['--no-first-run', '--no-default-browser-check'],
});

let closing = false;
const shutdown = async () => { if (closing) return; closing = true; await cleanup(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('seeding two windows, a tab group and some bookmarks (real pages, may take a few seconds)…');
await seedDemo(call, {
  layout: {
    window1: { left: 40, top: 50, width: 1180, height: 780 },
    window2: { left: 120, top: 110, width: 1100, height: 740 },
  },
});
const [editor] = await Promise.all([context.waitForEvent('page', { timeout: 15000 }), call(() => oilOpenEditor())]);
await editor.waitForSelector('.cm-content');

console.log('');
console.log('oil.chrome demo is running.');
console.log('  open the editor again: Alt+Shift+O (Option+Shift+O on macOS) or the toolbar button');
console.log('  try: dd (close a tab) · p (paste it elsewhere) · >> (indent: join a group) · :w (review + apply, y) · g? (help)');
console.log('  close the browser window to end the demo.');

await new Promise((resolve) => context.on('close', resolve));
await cleanup();
