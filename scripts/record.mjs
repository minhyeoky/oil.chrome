// Headless, scripted recording of the editor → demo/demo.gif, demo/demo.mp4 and step screenshots in demo/frames/.
// Run: npm run record   (builds first; needs ffmpeg; uses the real internet for the seeded pages)
//
// Safety: Playwright's bundled Chromium, headless, throwaway profile under .tmp/record-profile (deleted afterwards).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DIST, ROOT, launchDemo, seedDemo, sleep } from './lib/demo.mjs';

const FFMPEG = existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const DEMO = resolve(ROOT, 'demo');
const FRAMES = resolve(DEMO, 'frames');
const VIDEO_DIR = resolve(ROOT, '.tmp', 'record-video');
const SIZE = { width: 960, height: 720 };

if (process.argv.includes('--reencode')) {
  // retune the GIF/MP4 from the last recording without recording again
  await encode(resolve(ROOT, '.tmp', 'last-record.webm'));
  process.exit(0);
}
if (!existsSync(`${DIST}/manifest.json`)) { console.error('dist/ is missing — run `npm run build` first'); process.exit(1); }
rmSync(VIDEO_DIR, { recursive: true, force: true });
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const { context, call, cleanup } = await launchDemo({
  name: 'record-profile',
  headless: true,
  args: ['--no-first-run'],
  contextOptions: { viewport: SIZE, recordVideo: { dir: VIDEO_DIR, size: SIZE } },
});

let editor;
try {
  console.log('seeding the demo state (real pages)…');
  await seedDemo(call);
  const [page] = await Promise.all([context.waitForEvent('page', { timeout: 20000 }), call(() => oilOpenEditor())]);
  editor = page;
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => window.oil && window.oil.app.snapshot);
  await page.locator('.cm-content').focus();

  // ── the script ──────────────────────────────────────────────────────────
  let frame = 0;
  const shot = async (name) => { frame += 1; await page.screenshot({ path: resolve(FRAMES, `${String(frame).padStart(2, '0')}-${name}.png`) }); };
  const type = (s, delay = 110) => page.keyboard.type(s, { delay });
  const press = (k) => page.keyboard.press(k);
  const down = async (n, key = 'j') => { for (let i = 0; i < n; i++) { await press(key); await sleep(170); } };
  const search = async (pattern) => { await type(`/${pattern}`, 70); await sleep(250); await press('Enter'); };

  await sleep(2200);
  await shot('opened');

  // 1. close Hacker News with dd
  await down(5); // from the active tab to the Hacker News line
  await sleep(500);
  await shot('cursor-on-hacker-news');
  await type('dd');
  await sleep(1300);
  await shot('dd-hacker-news');

  // 2. move the oil.nvim line to Window 2 with dd / p
  await down(4, 'k');
  await sleep(500);
  await type('dd');
  await sleep(900);
  await search('Developers');
  await sleep(700);
  await type('p');
  await sleep(1400);
  await shot('moved-to-window-2');

  // 3. indent a tab into the Research group with >>
  await type('gg');
  await sleep(500);
  await search('Vim');
  await sleep(700);
  await type('>>');
  await sleep(1400);
  await shot('indent-into-group');

  // 4. yank that tab line and paste it under "Read later" (it becomes a bookmark)
  await type('yy');
  await sleep(600);
  await search('Read later');
  await sleep(600);
  await type('p');
  await sleep(500);
  await type('>>');
  await sleep(1400);
  await shot('yanked-under-read-later');

  // 5. cw: rename a bookmark (the hidden anchor keeps its identity)
  await down(3, 'k');
  await sleep(500);
  await type('0');
  await type('cw');
  await type('Source', 130);
  await press('Escape');
  await sleep(1400);
  await shot('renamed-bookmark');

  // 6. :w → confirmation modal
  await type(':w', 140);
  await sleep(400);
  await press('Enter');
  await page.waitForSelector('.oil-modal');
  await sleep(2600);
  await shot('confirm-modal');

  // 7. y → applied, buffer re-rendered from live Chrome state
  await press('y');
  await page.waitForSelector('.oil-modal', { state: 'detached' });
  await page.waitForFunction(() => !window.oil.app.busy);
  await sleep(2600);
  await shot('applied');
} finally {
  const videoPath = editor && editor.video() ? await editor.video().path().catch(() => null) : null;
  await cleanup(); // closing the context finalises the video
  if (videoPath && existsSync(videoPath)) {
    copyFileSync(videoPath, resolve(ROOT, '.tmp', 'last-record.webm')); // kept so `--reencode` can retune the GIF
    await encode(videoPath);
  }
  else console.error('no video was produced');
  rmSync(VIDEO_DIR, { recursive: true, force: true });
}

// ── encoding ──────────────────────────────────────────────────────────────
function ffmpeg(args) { execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' }); }

async function encode(webm) {
  const mp4 = resolve(DEMO, 'demo.mp4');
  const gif = resolve(DEMO, 'demo.gif');
  ffmpeg(['-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', mp4]);
  // text-heavy UI: width and palette size decide the size far more than dithering; stop at the first tier that fits
  const tiers = [[12, 860, 64, 'none'], [12, 800, 64, 'none'], [10, 800, 64, 'none'], [10, 720, 64, 'none']];
  for (const [fps, width, colors, dither] of tiers) {
    const vf = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=${dither}:diff_mode=rectangle`;
    ffmpeg(['-i', webm, '-vf', vf, '-loop', '0', gif]);
    const mb = statSync(gif).size / 1048576;
    console.log(`gif ${fps} fps, ${width}px, ${colors} colors, dither ${dither} → ${mb.toFixed(2)} MB`);
    if (mb <= 6) break;
  }
  console.log('wrote', gif, mp4, 'and', readdirSync(FRAMES).length, 'frames');
}
