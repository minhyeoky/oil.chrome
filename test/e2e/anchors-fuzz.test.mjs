// Random vim key sequences typed into the real editor. Whatever the keys do to the text, the anchor invariants hold:
//   · an anchor at a line start is always one that existed before, byte for byte (no edited or invented ids);
//   · the cursor never rests inside [line start, anchor end) of an anchored line;
//   · plan() keeps working on the buffer, and the page raises no errors.
// ANCHOR_FUZZ_N (default 350) operations; ANCHOR_FUZZ_SEED replays a seed.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { rng } from '../unit/properties.helpers.js';
import { launch, sleep } from './helpers.mjs';
import { STANDARD } from './lib.mjs';

let h;
before(async () => { h = await launch({ name: 'anchorfuzz' }); });
after(async () => { await h.close(); });

// [keys, text typed after entering insert mode (null = stays in normal mode)]
const OPS = [
  ['dd'], ['yy'], ['p'], ['P'], ['x'], ['X'], ['dw'], ['db'], ['D'], ['J'], ['u'], ['.'], ['0'], ['^'], ['$'], ['w'], ['b'], ['e'],
  ['j'], ['j'], ['k'], ['k'], ['gg'], ['G'], ['>>'], ['<<'], ['dj'], ['dk'], ['d$'], ['d0'], ['dG'], ['dgg'], ['yj'], ['3dd'],
  ['2p'], ['Vjd'], ['Vjy'], ['Vj>'], ['Vj<'], ['vlld'], ['ddp'], ['yyP'], ['~'], ['gUU'], ['guu'], ['rX'], ['r '], ['xp'], ['ddkP'],
  ['cc', 'abc'], ['S', 'new line'], ['C', 'tail'], ['cw', 'word'], ['o', 'below'], ['O', 'above'], ['i', 'ins'], ['a', 'app'],
  ['A', 'end'], ['I', 'start'], ['s', 'sub'], ['ciw', 'iw'], ['o', 'http://x.test/'], ['O', 'Group [red]/'], ['o', 'dir/'],
  ['cc'], ['S'], ['C'], ['I', '\n'], ['cc', '\n'],
  ['Vjgu'], ['VjgU'], ['Vjg~'], ['VjrX'], ['VGgU'], ['Vj~'], ['vjjgU'], ['gJ'], ['V}d'], ['V}y'], ['{'], ['}'],
  [':%s/t/T/g'], [':%s/1/22/g'], [':%s/^/> /'], [':%s/ /_/g'], [':g/Window/d'], [':2,3d'], [':%norm Atail'], [':%norm I-'],
  [':%norm x'], [':2,4m0'], [':t.'], [':%d'], [':%j'], [':2,3j'], [':%s/\\/\\//X/g'], [':%s/b/BB/g'], [':%s/w\\d/Z/g'],
];

const violations = (text, selHead) => {
  const out = [];
  const lines = text.split('\n');
  const seen = new Set();
  let off = 0;
  for (const [i, l] of lines.entries()) {
    const m = /^([ \t]*)(\/[wgtb]\d+)(?: |$)/.exec(l);
    const rest = m ? l.slice(m[0].length) : l;
    if (m) seen.add(m[2]);
    // text pasted mid-line that looks like an anchor is harmless (anchors are only read at the line start);
    // an anchor that was edited in place would show up as a malformed token at the line start
    if (!m && /^[ \t]*\/[A-Za-z]\d+(\s|$)/.test(l)) out.push(`line ${i + 1}: corrupted anchor at the line start: ${JSON.stringify(l)}`);
    if (m && selHead >= off && selHead < off + m[0].length && selHead !== off + m[0].length) out.push(`cursor inside the anchor on line ${i + 1}`);
    off += l.length + 1;
  }
  return { out, seen };
};

const N = Number(process.env.ANCHOR_FUZZ_N || 350);
test(`anchor invariants survive ${N} random vim operations`, async () => {
  await h.seed(STANDARD);
  const [page] = await Promise.all([h.context.waitForEvent('page'), h.call(() => oilOpenEditor())]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => window.oil && window.oil.app.snapshot);
  await page.locator('.cm-content').focus();
  const read = () => page.evaluate(() => ({ text: window.oil.text(), head: window.oil.view.state.selection.main.head, plan: (() => { try { return window.oil.plan().actions.length; } catch (e) { return `ERR ${e.message}`; } })() }));
  const original = new Set(((await read()).text.match(/\/[wgtb]\d+(?= )/g)) || []);
  const seed = Number(process.env.ANCHOR_FUZZ_SEED || 20261020);
  const r = rng(seed);
  const trail = [];
  for (let i = 0; i < N; i++) {
    const [keys, typed] = OPS[Math.floor(r() * OPS.length)];
    if (i % 40 === 39) { // a fresh buffer now and then: the destructive ops would otherwise empty it for good
      await page.keyboard.type(':e!'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !window.oil.app.busy && !window.oil.isDirty());
      trail.push('⟨:e!⟩');
    }
    trail.push(keys + (typed ? `⟨${typed}⟩` : ''));
    await page.keyboard.type(keys);
    if (keys.startsWith(':')) await page.keyboard.press('Enter');
    if (typed) { await page.keyboard.type(typed); await page.keyboard.press('Escape'); }
    await page.keyboard.press('Escape');
    if (r() < 0.05) await page.keyboard.press('Control+r');
    const s = await read();
    const v = violations(s.text, s.head);
    for (const a of v.seen) if (!original.has(a)) v.out.push(`unknown anchor appeared: ${a}`);
    if (typeof s.plan !== 'number') v.out.push(`plan() failed: ${s.plan}`);
    if (v.out.length) assert.fail(`after op #${i}: ${v.out.join('; ')}\nlast ops: ${trail.slice(-8).join('  ')}\n${s.text}`);
  }
  assert.deepEqual(errors, []);
  await sleep(100);
});
